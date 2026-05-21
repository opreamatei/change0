#include "middleware.h"

#include "goal/goal.h"
#include "input/input-processor.h"
#include "json.h"
#include "openai.h"
#include "profile/user-profile.h"
#include "search/deep-search-session.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MIDDLEWARE_MAX_RETRIES 10
#define MIDDLEWARE_MAX_PENDING_PERMISSIONS 64
#define MIDDLEWARE_CHAT_HISTORY_CAP 64

#define OPENAI_MIDDLEWARE_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"assistant_message\",\"actions\"]," \
  "\"properties\":{" \
    "\"assistant_message\":{\"type\":\"string\"}," \
    "\"actions\":{" \
      "\"type\":\"array\"," \
      "\"items\":{" \
        "\"type\":\"object\"," \
        "\"additionalProperties\":false," \
        "\"required\":[\"type\",\"key\",\"value\",\"requires_permission\",\"reason\",\"goal_input1\",\"goal_input2\",\"goal_id\",\"priority\",\"deep_search_task\",\"min_rounds\"]," \
        "\"properties\":{" \
          "\"type\":{\"type\":\"string\",\"enum\":[\"reply\",\"set_profile\",\"clear_profile\",\"ask_permission\",\"create_goal\",\"set_goal_priority\",\"call_deep_search\"]}," \
          "\"key\":{\"type\":[\"string\",\"null\"]}," \
          "\"value\":{\"type\":[\"string\",\"null\"]}," \
          "\"requires_permission\":{\"type\":[\"boolean\",\"null\"]}," \
          "\"reason\":{\"type\":[\"string\",\"null\"]}," \
          "\"goal_input1\":{\"type\":[\"string\",\"null\"]}," \
          "\"goal_input2\":{\"type\":[\"string\",\"null\"]}," \
          "\"goal_id\":{\"type\":[\"string\",\"null\"]}," \
          "\"priority\":{\"type\":[\"integer\",\"null\"],\"minimum\":0,\"maximum\":5}," \
          "\"deep_search_task\":{\"type\":[\"string\",\"null\"]}," \
          "\"min_rounds\":{\"type\":[\"integer\",\"null\"],\"minimum\":1,\"maximum\":8}" \
        "}" \
      "}" \
    "}" \
  "}" \
"}"

typedef struct {
	char id[64];
	char session_id[64];
	char key[64];
	char value[512];
	char reason[512];
	_Bool active;
} PendingProfilePermission;

typedef struct {
	char session_id[64];
	String history;
	String events_json;
	size_t events_count;
	_Bool used;
} MiddlewareSessionHistory;

typedef struct {
	char type[32];
	char key[64];
	char value[1024];
	char reason[512];
	char goal_input1[512];
	char goal_input2[2048];
	char goal_id[64];
	char deep_search_task[2048];
	int min_rounds;
	int priority;
	_Bool has_key;
	_Bool has_value;
	_Bool has_reason;
	_Bool has_goal_id;
	_Bool has_priority;
	_Bool requires_permission;
	_Bool has_requires_permission;
} MiddlewareAction;

static PendingProfilePermission pending_permissions[MIDDLEWARE_MAX_PENDING_PERMISSIONS];
static MiddlewareSessionHistory chat_histories[MIDDLEWARE_CHAT_HISTORY_CAP];

static void copy_json_string_field(json_value *value, char *dst, size_t dst_cap, _Bool *seen)
{
	size_t len;

	if (seen)
		*seen = 0;

	if (!dst || dst_cap == 0) return;
	dst[0] = '\0';

	if (!value || value->type == json_null)
		return;

	if (value->type != json_string)
		return;

	len = MIN(value->u.string.length, dst_cap - 1);
	memcpy(dst, value->u.string.ptr, len);
	dst[len] = '\0';

	if (seen)
		*seen = 1;
}

static MiddlewareSessionHistory *get_session_history(const char *session_id)
{
	size_t free_i = SIZE_MAX;

	if (!session_id || !*session_id)
		session_id = "default";

	for (size_t i = 0; i < MIDDLEWARE_CHAT_HISTORY_CAP; i++) {
		if (chat_histories[i].used && strcmp(chat_histories[i].session_id, session_id) == 0)
			return &chat_histories[i];
		if (!chat_histories[i].used && free_i == SIZE_MAX)
			free_i = i;
	}

	if (free_i == SIZE_MAX)
		free_i = 0;

	if (chat_histories[free_i].used) {
		FreeString(&chat_histories[free_i].history);
		FreeString(&chat_histories[free_i].events_json);
	}

	memset(&chat_histories[free_i], 0, sizeof(chat_histories[free_i]));
	strncpy(chat_histories[free_i].session_id, session_id, sizeof(chat_histories[free_i].session_id) - 1);
	InitString(&chat_histories[free_i].history, 4096);
	InitString(&chat_histories[free_i].events_json, 4096);
	chat_histories[free_i].events_count = 0;
	chat_histories[free_i].used = 1;

	return &chat_histories[free_i];
}

static void append_session_message(const char *session_id, const char *role, const char *message)
{
	MiddlewareSessionHistory *history = get_session_history(session_id);
	time_t now = change_time_now();
	char time_buffer[128];

	snprintf(time_buffer, sizeof(time_buffer), "%s", change_ctime(&now));
	trim_newline_inplace(time_buffer);

	CatTemplateString(
		&history->history,
		"[%s] %s: %s\n",
		time_buffer,
		role ? role : "unknown",
		message ? message : ""
	);
}

static _Bool is_allowed_profile_key(const char *key)
{
	if (!key) return 0;

	return
		strcmp(key, "age") == 0 ||
		strcmp(key, "name") == 0 ||
		strcmp(key, "location") == 0 ||
		strcmp(key, "profession") == 0 ||
		strcmp(key, "current_focus") == 0 ||
		strcmp(key, "recent_interest") == 0 ||
		strcmp(key, "stated_constraint") == 0 ||
		strcmp(key, "learning_preference") == 0 ||
		strcmp(key, "active_project_type") == 0 ||
		strcmp(key, "goal_style_preference") == 0 ||
		strcmp(key, "last_repair_reason") == 0 ||
		strcmp(key, "latest_input_theme") == 0;
}

static _Bool profile_key_requires_permission(const char *key)
{
	if (!key) return 1;

	return
		strcmp(key, "age") == 0 ||
		strcmp(key, "name") == 0 ||
		strcmp(key, "location") == 0 ||
		strcmp(key, "profession") == 0;
}

static void record_session_event(const char *session_id, const char *type, const char *content)
{
	MiddlewareSessionHistory *history;
	time_t now;
	char *esc_type;
	char *esc_content;

	if (!session_id || !*session_id)
		session_id = "default";

	history = get_session_history(session_id);
	now = change_time_now();
	esc_type = json_escape_dup(type ? type : "");
	esc_content = json_escape_dup(content ? content : "");

	if (history->events_count > 0)
		CatFixed(&history->events_json, ",");

	CatTemplateString(
		&history->events_json,
		"{\"type\":\"%s\",\"content\":\"%s\",\"timestamp\":%lld}",
		esc_type,
		esc_content,
		(long long)now
	);
	history->events_count++;

	free(esc_type);
	free(esc_content);
}

static void emit_text(middleware_emit_like_func emit, const char *session_id, const char *type, const char *text)
{
	if (emit)
		emit(session_id ? session_id : "default", type ? type : "middleware_event", text ? text : "", text ? strlen(text) : 0);

	record_session_event(session_id, type, text);
}

static void make_permission_id(char out[64])
{
	static size_t counter = 0;
	time_t now = change_time_now();
	snprintf(out, 64, "perm_%lld_%zu", (long long)now, counter++);
}

static PendingProfilePermission *store_pending_permission(
	const char *session_id,
	const char *key,
	const char *value,
	const char *reason
) {
	size_t slot = SIZE_MAX;

	for (size_t i = 0; i < MIDDLEWARE_MAX_PENDING_PERMISSIONS; i++) {
		if (!pending_permissions[i].active) {
			slot = i;
			break;
		}
	}

	if (slot == SIZE_MAX)
		slot = 0;

	memset(&pending_permissions[slot], 0, sizeof(pending_permissions[slot]));
	make_permission_id(pending_permissions[slot].id);
	strncpy(pending_permissions[slot].session_id, session_id ? session_id : "default", sizeof(pending_permissions[slot].session_id) - 1);
	strncpy(pending_permissions[slot].key, key ? key : "", sizeof(pending_permissions[slot].key) - 1);
	strncpy(pending_permissions[slot].value, value ? value : "", sizeof(pending_permissions[slot].value) - 1);
	strncpy(pending_permissions[slot].reason, reason ? reason : "", sizeof(pending_permissions[slot].reason) - 1);
	pending_permissions[slot].active = 1;

	return &pending_permissions[slot];
}

void InitMiddlewareResult(MiddlewareResult *result)
{
	InitString(&result->assistant_message, 1024);
	InitString(&result->response_type, 64);
	InitString(&result->permission_id, 128);
}

void FreeMiddlewareResult(MiddlewareResult *result)
{
	FreeString(&result->assistant_message);
	FreeString(&result->response_type);
	FreeString(&result->permission_id);
}

static void build_middleware_context(
	const char *session_id,
	const char *user_input,
	String *retry_feedback,
	String *deep_search_feedback,
	String *prompt,
	User *user
) {
	String input_history;
	String goal_history;
	String derived;
	MiddlewareSessionHistory *session_history = get_session_history(session_id);

	InitString(&input_history, 4096);
	InitString(&goal_history, 4096);
	InitString(&derived, 2048);

	SerializeUserProfileHistorySection(user, "inputs", 20, &input_history);
	SerializeUserProfileHistorySection(user, "goal-activity", 20, &goal_history);
	SerializeUserProfileDerivedSummary(user, &derived);

	CatTemplateString(
		prompt,
		"You are the AI engine inside a middleware layer for this local app. "
		"You are not a generic chatbot. You coordinate controlled actions over existing systems: user profile memory, goal creation, and deep-search investigation. "
		"User input for this turn: [%s]. "
		"Current chat-session history: [%s]. "
		"User profile summary: [%s]. "
		"Raw input profile history: [%s]. "
		"Goal activity history: [%s]. "
		"Previous invalid-output/action feedback: [%s]. "
		"Deep-search result available to this retry, if any: [%s]. "
		"Return one strict JSON object only. "
		"Your tone in assistant_message must be professional, direct, encouraging, and confident. It should feel like a capable product operator, not AI boilerplate. "
		"You may use a bold joke when natural, but do not be unserious about important information or permissions. "
		"Reply in the user's language. "
		"You may set only predefined profile keys: age, name, location, profession, current_focus, recent_interest, stated_constraint, learning_preference, active_project_type, goal_style_preference, last_repair_reason, latest_input_theme. "
		"Facts such as age, name, location, and profession require explicit user permission before storing. If the user clearly asks you to remember such a fact, still mark requires_permission=true. "
		"Operational memory such as current_focus or recent_interest may be stored without permission when directly supported by the conversation. "
		"If the user states a fact that conflicts with profile memory, ask for confirmation instead of overwriting silently. "
		"Deep-search is an investigator over the app's identity graph, goal system, schedule, and profile commands. It is useful when local context is ambiguous or structural evidence is needed. "
		"Do not call deep-search just to create a goal, because CreateUserGoal already performs deep-search personalization internally. "
		"For create_goal, produce goal_input1 as the concise title/intention and goal_input2 as practical extra context. "
		"For set_goal_priority, use the exact goal_id when the user references an existing goal by id, and set priority from 0 to 5. Only root goal priority matters in this app; if the user gives a child goal id, the system will apply the change to that goal's root. "
		"If the user asks to change priority but you do not know the exact goal id, ask for the id or call deep-search only when structural lookup is genuinely needed. "
		"Use actions sparingly; if a normal reply is enough, return no side-effect action except reply.",
		user_input ? user_input : "",
		session_history->history.p,
		derived.p,
		input_history.p,
		goal_history.p,
		retry_feedback && retry_feedback->p ? retry_feedback->p : "",
		deep_search_feedback && deep_search_feedback->p ? deep_search_feedback->p : ""
	);

	FreeString(&derived);
	FreeString(&goal_history);
	FreeString(&input_history);
}

static String *call_middleware_ai(String *prompt)
{
	ai_gpt_request req = {0};
	req.prompt = *prompt;
	req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
	req.schema_name = "middleware_response";
	InitString(&req.schema, sizeof(OPENAI_MIDDLEWARE_SCHEMA_JSON) + 1);
	CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_MIDDLEWARE_SCHEMA_JSON));

	String *result = ai_openai_call_gpt_request(&req);
	FreeString(&req.schema);
	return result;
}

static _Bool parse_action(json_value *item, MiddlewareAction *action, String *error)
{
	memset(action, 0, sizeof(*action));
	action->min_rounds = 2;

	if (!item || item->type != json_object) {
		CatFixed(error, "Action item is not an object.");
		return 0;
	}

	for (size_t i = 0; i < item->u.object.length; i++) {
		json_object_entry entry = item->u.object.values[i];

		if (strcmp(entry.name, "type") == 0) {
			copy_json_string_field(entry.value, action->type, sizeof(action->type), NULL);
		} else if (strcmp(entry.name, "key") == 0) {
			copy_json_string_field(entry.value, action->key, sizeof(action->key), &action->has_key);
		} else if (strcmp(entry.name, "value") == 0) {
			copy_json_string_field(entry.value, action->value, sizeof(action->value), &action->has_value);
		} else if (strcmp(entry.name, "reason") == 0) {
			copy_json_string_field(entry.value, action->reason, sizeof(action->reason), &action->has_reason);
		} else if (strcmp(entry.name, "goal_input1") == 0) {
			copy_json_string_field(entry.value, action->goal_input1, sizeof(action->goal_input1), NULL);
		} else if (strcmp(entry.name, "goal_input2") == 0) {
			copy_json_string_field(entry.value, action->goal_input2, sizeof(action->goal_input2), NULL);
		} else if (strcmp(entry.name, "goal_id") == 0) {
			copy_json_string_field(entry.value, action->goal_id, sizeof(action->goal_id), &action->has_goal_id);
		} else if (strcmp(entry.name, "priority") == 0 && entry.value->type == json_integer) {
			action->priority = (int)CLAMP(0, 5, entry.value->u.integer);
			action->has_priority = 1;
		} else if (strcmp(entry.name, "deep_search_task") == 0) {
			copy_json_string_field(entry.value, action->deep_search_task, sizeof(action->deep_search_task), NULL);
		} else if (strcmp(entry.name, "requires_permission") == 0 && entry.value->type == json_boolean) {
			action->requires_permission = entry.value->u.boolean;
			action->has_requires_permission = 1;
		} else if (strcmp(entry.name, "min_rounds") == 0 && entry.value->type == json_integer) {
			action->min_rounds = (int)CLAMP(1, 8, entry.value->u.integer);
		}
	}

	if (action->type[0] == '\0') {
		CatFixed(error, "Action has no type.");
		return 0;
	}

	return 1;
}

static _Bool parse_middleware_response(json_value *doc, String *assistant_message, MiddlewareAction **actions, size_t *actions_len, String *error)
{
	json_value *message_json = NULL;
	json_value *actions_json = NULL;

	*actions = NULL;
	*actions_len = 0;
	EmptyString(assistant_message);

	if (!doc || doc->type != json_object) {
		CatFixed(error, "Middleware AI response is not a JSON object.");
		return 0;
	}

	message_json = json_object_get(doc, "assistant_message");
	actions_json = json_object_get(doc, "actions");

	if (!message_json || message_json->type != json_string) {
		CatFixed(error, "assistant_message must be a string.");
		return 0;
	}

	if (!actions_json || actions_json->type != json_array) {
		CatFixed(error, "actions must be an array.");
		return 0;
	}

	CatString(assistant_message, message_json->u.string.ptr, message_json->u.string.length);

	*actions_len = actions_json->u.array.length;
	if (*actions_len == 0)
		return 1;

	*actions = calloc(*actions_len, sizeof(MiddlewareAction));
	change_assert(*actions, "Could not allocate middleware actions.\n");

	for (size_t i = 0; i < *actions_len; i++) {
		if (!parse_action(actions_json->u.array.values[i], &(*actions)[i], error)) {
			free(*actions);
			*actions = NULL;
			*actions_len = 0;
			return 0;
		}
	}

	return 1;
}

static _Bool validate_action(MiddlewareAction *action, String *error)
{
	if (strcmp(action->type, "reply") == 0)
		return 1;

	if (strcmp(action->type, "set_profile") == 0 || strcmp(action->type, "ask_permission") == 0) {
		if (!action->has_key || !is_allowed_profile_key(action->key)) {
			CatTemplateString(error, "Invalid profile key [%s]. Use one of the predefined keys.", action->key);
			return 0;
		}
		if (!action->has_value || action->value[0] == '\0') {
			CatFixed(error, "set_profile/ask_permission requires a non-empty value.");
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "clear_profile") == 0) {
		if (!action->has_key || !is_allowed_profile_key(action->key)) {
			CatTemplateString(error, "Invalid profile key [%s] for clear_profile.", action->key);
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "create_goal") == 0) {
		if (action->goal_input1[0] == '\0' || action->goal_input2[0] == '\0') {
			CatFixed(error, "create_goal requires goal_input1 and goal_input2.");
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "set_goal_priority") == 0) {
		if (!action->has_goal_id || strlen(action->goal_id) != GOAL_ID_SIZE) {
			CatFixed(error, "set_goal_priority requires an exact 32-character goal_id.");
			return 0;
		}
		if (!action->has_priority) {
			CatFixed(error, "set_goal_priority requires priority as an integer from 0 to 5.");
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "call_deep_search") == 0) {
		if (action->deep_search_task[0] == '\0') {
			CatFixed(error, "call_deep_search requires deep_search_task.");
			return 0;
		}
		return 1;
	}

	CatTemplateString(error, "Unknown action type [%s].", action->type);
	return 0;
}

static void emit_permission_request(
	const char *session_id,
	PendingProfilePermission *pending,
	middleware_emit_like_func emit,
	User *user
) {
	String payload;
	char *esc_id = json_escape_dup(pending->id);
	char *esc_key = json_escape_dup(pending->key);
	char *esc_value = json_escape_dup(pending->value);
	char *esc_reason = json_escape_dup(pending->reason);

	InitString(&payload, 1024);
	CatTemplateString(
		&payload,
		"{\"permission_id\":\"%s\",\"key\":\"%s\",\"value\":\"%s\",\"reason\":\"%s\"}",
		esc_id,
		esc_key,
		esc_value,
		esc_reason
	);

	emit_text(emit, session_id, "permission_required", payload.p);
	UserProfileRecordInput(user, "middleware_permission_request", payload.p);

	free(esc_reason);
	free(esc_value);
	free(esc_key);
	free(esc_id);
	FreeString(&payload);
}

static _Bool apply_actions(
	const char *session_id,
	MiddlewareAction *actions,
	size_t actions_len,
	start_ds_session_like_func *start_ds_session,
	middleware_emit_like_func emit,
	String *deep_search_feedback,
	MiddlewareResult *result,
	String *error,
	User *user
) {
	for (size_t i = 0; i < actions_len; i++) {
		MiddlewareAction *action = &actions[i];

		if (!validate_action(action, error))
			return 0;

		if (strcmp(action->type, "reply") == 0) {
			continue;
		}

		if (strcmp(action->type, "call_deep_search") == 0) {
			Task task = {0};
			String ds_out;

			InitString(&task.name, strlen(action->deep_search_task) + 1);
			CatString(&task.name, action->deep_search_task, strlen(action->deep_search_task));
			task.minDepth = action->min_rounds > 0 ? action->min_rounds : 2;

			InitString(&ds_out, 2048);
			emit_text(emit, session_id, "deep_search_started", action->deep_search_task);
			start_ds_session(&task, "middleware-deep-search", &ds_out, user);

			EmptyString(deep_search_feedback);
			CatTemplateString(deep_search_feedback, "Deep-search result: [%s]", ds_out.p);
			emit_text(emit, session_id, "deep_search_done", ds_out.p);

			FreeString(&ds_out);
			FreeString(&task.name);
			return 0;
		}

		if (strcmp(action->type, "set_profile") == 0 || strcmp(action->type, "ask_permission") == 0) {
			_Bool requires_permission = action->requires_permission || profile_key_requires_permission(action->key);

			if (requires_permission || strcmp(action->type, "ask_permission") == 0) {
				PendingProfilePermission *pending = store_pending_permission(session_id, action->key, action->value, action->reason);
				emit_permission_request(session_id, pending, emit, user);
				EmptyString(&result->response_type);
				CatFixed(&result->response_type, "permission_required");
				EmptyString(&result->permission_id);
				CatString(&result->permission_id, pending->id, strlen(pending->id));
			} else {
				String detail;
				InitString(&detail, 1024);
				UserProfileSetDerivedField(user, action->key, action->value);
				CatTemplateString(&detail, "%s=%s reason=%s", action->key, action->value, action->reason);
				UserProfileRecordInput(user, "middleware_profile_set", detail.p);
				emit_text(emit, session_id, "profile_updated", detail.p);
				FreeString(&detail);
			}
			continue;
		}

		if (strcmp(action->type, "clear_profile") == 0) {
			UserProfileClearDerivedField(user, action->key);
			UserProfileRecordInput(user, "middleware_profile_clear", action->key);
			emit_text(emit, session_id, "profile_updated", action->key);
			continue;
		}

		if (strcmp(action->type, "create_goal") == 0) {
			String input1, input2;
			Goal *created = NULL;

			InitString(&input1, strlen(action->goal_input1) + 1);
			InitString(&input2, strlen(action->goal_input2) + 1);
			CatString(&input1, action->goal_input1, strlen(action->goal_input1));
			CatString(&input2, action->goal_input2, strlen(action->goal_input2));

			emit_text(emit, session_id, "goal_create_started", action->goal_input1);
			created = CreateUserGoal(&input1, &input2, NULL, start_ds_session, user);
			if (created) {
				String payload;
				char *esc_title = json_escape_dup(created->title.p ? created->title.p : "");
				InitString(&payload, 512);
				CatTemplateString(&payload, "{\"goal_id\":\"%s\",\"title\":\"%s\",\"priority\":%zu}", created->id, esc_title, created->priority);
				emit_text(emit, session_id, "goal_created", payload.p);
				free(esc_title);
				FreeString(&payload);
			}

			FreeString(&input2);
			FreeString(&input1);
			continue;
		}

		if (strcmp(action->type, "set_goal_priority") == 0) {
			goalIDType goal_id;
			Goal *goal = NULL;
			Goal *root = NULL;
			String payload;

			memset(goal_id, 0, sizeof(goal_id));
			memcpy(goal_id, action->goal_id, GOAL_ID_SIZE);
			goal = FindGoalByID(goal_id);
			if (!goal) {
				CatTemplateString(error, "set_goal_priority could not find goal_id [%s].", action->goal_id);
				return 0;
			}

			root = CalcGoalRoot(goal);
			change_assert(root, "Could not resolve root goal for priority change.\n");
			root->priority = (size_t)CLAMP(0, 5, action->priority);

			InitString(&payload, 512);
			char *esc_root_title = json_escape_dup(root->title.p ? root->title.p : "");
			CatTemplateString(
				&payload,
				"{\"requested_goal_id\":\"%s\",\"root_goal_id\":\"%s\",\"priority\":%zu,\"root_title\":\"%s\"}",
				action->goal_id,
				root->id,
				root->priority,
				esc_root_title
			);
			UserProfileRecordGoalEvent(user, "goal_priority_changed", root, payload.p);
			emit_text(emit, session_id, "goal_priority_changed", payload.p);
			free(esc_root_title);
			FreeString(&payload);
			continue;
		}
	}

	return 1;
}

MiddlewareResult RunClientMiddleware(
	const char *session_id,
	const char *user_input,
	start_ds_session_like_func *start_ds_session,
	middleware_emit_like_func emit,
	User *user
) {
	MiddlewareResult result;
	String retry_feedback;
	String deep_search_feedback;

	if (!session_id || !*session_id)
		session_id = "default";

	InitMiddlewareResult(&result);
	CatFixed(&result.response_type, "text");
	InitString(&retry_feedback, 1024);
	InitString(&deep_search_feedback, 2048);

	change_assert(user_input && *user_input, "Middleware requires non-empty user input.\n");
	change_assert(start_ds_session, "Middleware requires deep-search function pointer.\n");

	append_session_message(session_id, "user", user_input);
	UserProfileRecordInput(user, "middleware_chat_user", user_input);

	String graph_input;
	InitString(&graph_input, strlen(user_input) + 1);
	CatString(&graph_input, (char *)user_input, strlen(user_input));
	DecomposeInputIntoGraph(&graph_input, user);
	FreeString(&graph_input);

	emit_text(emit, session_id, "message_received", user_input);

	for (size_t attempt = 0; attempt < MIDDLEWARE_MAX_RETRIES; attempt++) {
		String prompt;
		String *ai_result = NULL;
		json_value *doc = NULL;
		MiddlewareAction *actions = NULL;
		size_t actions_len = 0;
		String parse_error;
		_Bool parsed = 0;
		_Bool applied = 0;

		InitString(&prompt, 12000);
		InitString(&parse_error, 1024);
		build_middleware_context(session_id, user_input, &retry_feedback, &deep_search_feedback, &prompt, user);

		ai_result = call_middleware_ai(&prompt);
		doc = json_parse(ai_result->p, ai_result->len);
		if (doc)
			parsed = parse_middleware_response(doc, &result.assistant_message, &actions, &actions_len, &parse_error);
		else
			CatFixed(&parse_error, "AI response was not valid JSON.");

		if (parsed) {
			applied = apply_actions(session_id, actions, actions_len, start_ds_session, emit, &deep_search_feedback, &result, &parse_error, user);
		}

		if (actions)
			free(actions);
		if (doc)
			json_value_free(doc);
		FreeString(ai_result);
		free(ai_result);
		FreeString(&prompt);

		if (parsed && applied) {
			append_session_message(session_id, "assistant", result.assistant_message.p);
			UserProfileRecordInput(user, "middleware_chat_assistant", result.assistant_message.p);
			emit_text(emit, session_id, "assistant_message", result.assistant_message.p);
			FreeString(&parse_error);
			break;
		}

		EmptyString(&retry_feedback);
		CatTemplateString(&retry_feedback, "Attempt %zu failed or needed tool continuation: %s", attempt + 1, parse_error.p);
		emit_text(emit, session_id, "middleware_retry", retry_feedback.p);
		FreeString(&parse_error);

		change_assert(attempt + 1 < MIDDLEWARE_MAX_RETRIES, "Middleware AI failed after %d attempts: %s\n", MIDDLEWARE_MAX_RETRIES, retry_feedback.p);
	}

	FreeString(&deep_search_feedback);
	FreeString(&retry_feedback);
	return result;
}

char* ExportMiddlewareSessionJSON(const char *session_id)
{
	MiddlewareSessionHistory *history;
	String out;
	char *esc_session_id;

	if (!session_id || !*session_id)
		session_id = "default";

	history = get_session_history(session_id);
	esc_session_id = json_escape_dup(session_id);

	InitString(&out, history->events_json.len + 256);
	CatTemplateString(
		&out,
		"{\"ok\":true,\"session_id\":\"%s\",\"events\":[%s]}",
		esc_session_id,
		history->events_json.p ? history->events_json.p : ""
	);

	free(esc_session_id);
	return out.p;
}

_Bool ResolveMiddlewarePermission(
	const char *permission_id,
	_Bool approved,
	middleware_emit_like_func emit,
	User *user
) {
	for (size_t i = 0; i < MIDDLEWARE_MAX_PENDING_PERMISSIONS; i++) {
		if (pending_permissions[i].active && strcmp(pending_permissions[i].id, permission_id) == 0) {
			String event;
			InitString(&event, 1024);

			if (approved) {
				UserProfileSetDerivedField(user, pending_permissions[i].key, pending_permissions[i].value);
				CatTemplateString(
					&event,
					"{\"permission_id\":\"%s\",\"approved\":true,\"key\":\"%s\",\"value\":\"%s\"}",
					pending_permissions[i].id,
					pending_permissions[i].key,
					pending_permissions[i].value
				);
			} else {
				CatTemplateString(
					&event,
					"{\"permission_id\":\"%s\",\"approved\":false,\"key\":\"%s\"}",
					pending_permissions[i].id,
					pending_permissions[i].key
				);
			}

			UserProfileRecordInput(user, "middleware_permission_result", event.p);
			emit_text(emit, pending_permissions[i].session_id, "permission_resolved", event.p);
			pending_permissions[i].active = 0;
			FreeString(&event);
			return 1;
		}
	}

	return 0;
}
