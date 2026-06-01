#include "middleware.h"
#include "reminders.h"

#include "goal/goal.h"
#include "goal/goal-info.h"
#include "goal/schedule-system.h"
#include "input/input-processor.h"
#include "json.h"
#include "openai.h"
#include "profile/user-profile.h"
#include "search/deep-search-session.h"
#include "connections.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>

#define MIDDLEWARE_MAX_RETRIES 10
#define MIDDLEWARE_MAX_PENDING_PERMISSIONS 64
#define MIDDLEWARE_CHAT_HISTORY_CAP 64

#define OPENAI_MIDDLEWARE_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"assistant_message\",\"actions\",\"suggested_replies\"]," \
  "\"properties\":{" \
    "\"assistant_message\":{\"type\":\"string\"}," \
    "\"suggested_replies\":{\"type\":[\"array\",\"null\"],\"items\":{\"type\":\"string\"},\"maxItems\":5}," \
    "\"actions\":{" \
      "\"type\":\"array\"," \
      "\"items\":{" \
        "\"type\":\"object\"," \
        "\"additionalProperties\":false," \
        "\"required\":[\"type\",\"key\",\"value\",\"requires_permission\",\"reason\",\"goal_input1\",\"goal_input2\",\"goal_id\",\"priority\",\"deep_search_task\",\"graph_input\",\"min_rounds\",\"delay_seconds\",\"delay_until\",\"repair_reason\",\"reminder_title\",\"reminder_hour\",\"reminder_minute\",\"reminder_days\",\"reminder_end_time\"]," \
        "\"properties\":{" \
          "\"type\":{\"type\":\"string\",\"enum\":[\"reply\",\"set_profile\",\"clear_profile\",\"ask_permission\",\"create_goal\",\"set_goal_priority\",\"call_deep_search\",\"update_graph\",\"delay_goal\",\"drop_goal\",\"repair_branch\",\"set_discoverable\",\"set_private\",\"update_match_description\",\"find_match\",\"set_reminder\"]}," \
          "\"key\":{\"type\":[\"string\",\"null\"]}," \
          "\"value\":{\"type\":[\"string\",\"null\"]}," \
          "\"requires_permission\":{\"type\":[\"boolean\",\"null\"]}," \
          "\"reason\":{\"type\":[\"string\",\"null\"]}," \
          "\"goal_input1\":{\"type\":[\"string\",\"null\"]}," \
          "\"goal_input2\":{\"type\":[\"string\",\"null\"]}," \
          "\"goal_id\":{\"type\":[\"string\",\"null\"]}," \
          "\"priority\":{\"type\":[\"integer\",\"null\"],\"minimum\":0,\"maximum\":5}," \
          "\"deep_search_task\":{\"type\":[\"string\",\"null\"]}," \
          "\"graph_input\":{\"type\":[\"string\",\"null\"]}," \
          "\"min_rounds\":{\"type\":[\"integer\",\"null\"],\"minimum\":1,\"maximum\":8}," \
          "\"delay_seconds\":{\"type\":[\"integer\",\"null\"],\"minimum\":0}," \
          "\"delay_until\":{\"type\":[\"string\",\"null\"]}," \
          "\"repair_reason\":{\"type\":[\"string\",\"null\"]}," \
          "\"reminder_title\":{\"type\":[\"string\",\"null\"]}," \
          "\"reminder_hour\":{\"type\":[\"integer\",\"null\"],\"minimum\":0,\"maximum\":23}," \
          "\"reminder_minute\":{\"type\":[\"integer\",\"null\"],\"minimum\":0,\"maximum\":59}," \
          "\"reminder_days\":{\"type\":[\"integer\",\"null\"],\"minimum\":0,\"maximum\":127}," \
          "\"reminder_end_time\":{\"type\":[\"integer\",\"null\"],\"minimum\":0}" \
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
	char   id[64];
	char   session_id[64];
	char   title[REMINDER_TITLE_SIZE];
	int    hour;
	int    minute;
	int    days;
	long long end_time;
	_Bool  active;
} PendingReminderPermission;

typedef struct {
	char session_id[64];
	String history;
	String events_json;
	size_t events_count;
	_Bool stalled_goal_reminder_shown;
	_Bool stalled_goal_reminder_dismissed;
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
	char graph_input[2048];
	int min_rounds;
	int priority;
	char delay_until[32];
	int delay_seconds;
	char repair_reason[2048];
	char reminder_title[REMINDER_TITLE_SIZE];
	int  reminder_hour;
	int  reminder_minute;
	int  reminder_days;
	long long reminder_end_time;
	_Bool has_repair_reason;
	_Bool has_key;
	_Bool has_value;
	_Bool has_reason;
	_Bool has_goal_id;
	_Bool has_priority;
	_Bool has_delay_seconds;
	_Bool has_delay_until;
	_Bool has_reminder;
	_Bool requires_permission;
	_Bool has_requires_permission;
} MiddlewareAction;

static PendingProfilePermission  pending_permissions[MIDDLEWARE_MAX_PENDING_PERMISSIONS];
static PendingReminderPermission pending_reminders[MIDDLEWARE_MAX_PENDING_PERMISSIONS];
static MiddlewareSessionHistory  chat_histories[MIDDLEWARE_CHAT_HISTORY_CAP];

static void copy_json_string_field(json_value *v, char *dst, size_t cap, _Bool *seen)
{
	if (seen) *seen = 0;
	if (!v || v->type != json_string || cap == 0) return;
	size_t len = MIN(v->u.string.length, cap - 1);
	memcpy(dst, v->u.string.ptr, len);
	dst[len] = '\0';
	if (seen) *seen = 1;
}

static char ascii_tolower_char(char c)
{
	if (c >= 'A' && c <= 'Z')
		return (char)(c + ('a' - 'A'));
	return c;
}

static _Bool contains_case_insensitive(const char *haystack, const char *needle)
{
	if (!haystack || !needle || !*needle)
		return 0;

	size_t needle_len = strlen(needle);
	if (needle_len == 0)
		return 0;

	for (size_t i = 0; haystack[i]; i++) {
		size_t j = 0;
		while (haystack[i + j] && needle[j] &&
		       ascii_tolower_char(haystack[i + j]) == ascii_tolower_char(needle[j])) {
			j++;
		}
		if (j == needle_len)
			return 1;
	}

	return 0;
}

static _Bool user_input_mentions_goal_context(const char *user_input)
{
	static const char *keywords[] = {
		"goal", "goals", "task", "tasks", "project", "resume", "continue",
		"delay", "postpone", "snooze", "drop", "abandon", "finish",
		"complete", "schedule", "stuck"
	};

	if (!user_input || !*user_input)
		return 0;

	for (size_t i = 0; i < sizeof(keywords) / sizeof(keywords[0]); i++) {
		if (contains_case_insensitive(user_input, keywords[i]))
			return 1;
	}

	return 0;
}

static _Bool user_input_dismisses_stalled_goal_reminder(const char *user_input)
{
	static const char *phrases[] = {
		"stop", "i know", "leave it", "not now", "drop it"
	};

	if (!user_input || !*user_input)
		return 0;

	for (size_t i = 0; i < sizeof(phrases) / sizeof(phrases[0]); i++) {
		if (contains_case_insensitive(user_input, phrases[i]))
			return 1;
	}

	return 0;
}

static _Bool recent_history_mentions_goal_title(const String *history, const char *goal_title)
{
	if (!history || !history->p || !goal_title || !*goal_title)
		return 0;

	size_t history_len = history->len;
	size_t window = history_len > 1200 ? 1200 : history_len;
	const char *slice = history->p + (history_len - window);

	return contains_case_insensitive(slice, goal_title);
}

static Goal *find_oldest_stalled_goal(const char *journey_id)
{
	size_t total = 0;
	Goal **goals = GetGoalsSorted(&total, journey_id);
	Goal *oldest = NULL;

	for (size_t i = 0; i < total; i++) {
		Goal *g = goals[i];
		if (!g) continue;
		if (g->start_date == 0 || g->end_date != 0) continue;
		if (change_time_now() - g->start_date < 2 * 24 * 3600) continue;
		if (!oldest || g->start_date < oldest->start_date)
			oldest = g;
	}

	free(goals);
	return oldest;
}

static void fill_stalled_goal_reminder_candidate(
	String *buffer,
	MiddlewareSessionHistory *session_history,
	const char *user_input,
	User *user
) {
	if (!buffer || !session_history || !user)
		return;
	if (user->journey_count == 0 || !user->journeys[0][0])
		return;
	if (session_history->stalled_goal_reminder_shown || session_history->stalled_goal_reminder_dismissed)
		return;
	if (user_input_mentions_goal_context(user_input))
		return;

	Goal *goal = find_oldest_stalled_goal(user->journeys[0]);
	if (!goal || !goal->title.p || !goal->title.p[0])
		return;
	if (recent_history_mentions_goal_title(&session_history->history, goal->title.p))
		return;

	time_t now = change_time_now();
	time_t elapsed = now - goal->start_date;
	long long days = (long long)(elapsed / 86400);
	long long hours = (long long)((elapsed % 86400) / 3600);
	char relation[64];
	if (days <= 1)
		snprintf(relation, sizeof(relation), "stalled-1-day-%lld-hours", hours);
	else
		snprintf(relation, sizeof(relation), "stalled-%lld-days", days);

	size_t len = 0;
	char *info = SerializeGoal(goal, &len, relation, 1);
	if (!info) return;
	CatString(buffer, info, len);
	free(info);
}

/*
 * Chat history persistence. The in-memory chat_histories[] table is volatile
 * (lost on restart, LRU-evicted when full). To give the chat section a durable
 * history we mirror each session's events_json to a file under
 * data/chat-sessions/<sanitized-session-id>.json and reload it when a session
 * is first touched. Session ids look like "<userId>:default"; ':' and path
 * separators are sanitized for the filename.
 */
static void chat_session_path(const char *session_id, char *out, size_t cap)
{
	char safe[160];
	size_t j = 0;
	for (size_t i = 0; session_id[i] && j < sizeof(safe) - 1; i++) {
		char c = session_id[i];
		safe[j++] = (c == '/' || c == '\\' || c == ':') ? '_' : c;
	}
	safe[j] = '\0';
	snprintf(out, cap, DATA_ROOT_DIRECTORY "chat-sessions/%s.json", safe);
}

static void persist_session(const MiddlewareSessionHistory *h)
{
	mkdir(DATA_ROOT_DIRECTORY "chat-sessions", 0755);
	char path[256];
	chat_session_path(h->session_id, path, sizeof(path));
	FILE *fp = fopen(path, "wb");
	if (!fp) return;
	if (h->events_json.p && h->events_json.len)
		fwrite(h->events_json.p, 1, h->events_json.len, fp);
	fclose(fp);
}

static void load_session_from_disk(MiddlewareSessionHistory *h)
{
	char path[256];
	chat_session_path(h->session_id, path, sizeof(path));
	FILE *fp = fopen(path, "rb");
	if (!fp) return;
	fseek(fp, 0, SEEK_END);
	long sz = ftell(fp);
	fseek(fp, 0, SEEK_SET);
	if (sz <= 0) { fclose(fp); return; }
	char *buf = malloc((size_t)sz + 1);
	if (!buf) { fclose(fp); return; }
	size_t rd = fread(buf, 1, (size_t)sz, fp);
	buf[rd] = '\0';
	fclose(fp);

	EmptyString(&h->events_json);
	CatString(&h->events_json, buf, rd);

	/* Each persisted event carries exactly one "timestamp" key — count them. */
	size_t cnt = 0;
	const char *p = buf;
	while ((p = strstr(p, "\"timestamp\":")) != NULL) { cnt++; p += 12; }
	h->events_count = cnt;
	h->stalled_goal_reminder_shown =
		strstr(buf, "\"type\":\"stalled_goal_reminder_shown\"") != NULL;
	h->stalled_goal_reminder_dismissed =
		strstr(buf, "\"type\":\"stalled_goal_reminder_dismissed\"") != NULL;

	free(buf);
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

	/* Restore any durable history persisted from a previous run. */
	load_session_from_disk(&chat_histories[free_i]);

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
		strcmp(key, "latest_input_theme") == 0 ||
		strcmp(key, "daily_work_hours") == 0 ||
		strcmp(key, "work_day_start") == 0 ||
		strcmp(key, "current_intent") == 0;
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

	/* Mirror to disk so the chat history survives restarts. */
	persist_session(history);
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
	User *user,
	_Bool *has_stalled_goal_reminder_candidate
) {
	String input_history;
	String goal_history;
	String derived;
	String active_goals;
	String schedule_snapshot;
	String completed_goals;
	String stalled_goal_candidate;
	MiddlewareSessionHistory *session_history = get_session_history(session_id);

	InitString(&input_history, 4096);
	InitString(&goal_history, 4096);
	InitString(&derived, 2048);
	InitString(&active_goals, 4096);
	InitString(&schedule_snapshot, 4096);
	InitString(&completed_goals, 4096);
	InitString(&stalled_goal_candidate, 1024);

	SerializeUserProfileHistorySection(user, "inputs", 20, &input_history);
	SerializeUserProfileHistorySection(user, "goal-activity", 20, &goal_history);
	SerializeUserProfileDerivedSummary(user, &derived);
	if (user->journey_count > 0) {
		SerializeDueGoals(&active_goals, 16, user->journeys[0]);
		SerializeUserGoalHistory(&completed_goals, 20, user->journeys[0]);
	}
	fill_stalled_goal_reminder_candidate(&stalled_goal_candidate, session_history, user_input, user);
	if (has_stalled_goal_reminder_candidate)
		*has_stalled_goal_reminder_candidate = stalled_goal_candidate.len > 0;
	SerializeScheduleData(&schedule_snapshot, 0, user);

	time_t now = change_time_now();
	char now_buf[64];
	snprintf(now_buf, sizeof(now_buf), "%s", change_ctime(&now));
	trim_newline_inplace(now_buf);

	CatTemplateString(
		prompt,
		"Current server time: %s. "
		MIDDLEWARE_SYSTEM_PROMPT,
		now_buf,
		user_input ? user_input : "",
		session_history->history.p,
		derived.p,
		input_history.p,
		goal_history.p,
		active_goals.p,
		schedule_snapshot.p,
		completed_goals.p,
		stalled_goal_candidate.p,
		retry_feedback && retry_feedback->p ? retry_feedback->p : "",
		deep_search_feedback && deep_search_feedback->p ? deep_search_feedback->p : ""
	);

	FreeString(&derived);
	FreeString(&goal_history);
	FreeString(&input_history);
	FreeString(&active_goals);
	FreeString(&schedule_snapshot);
	FreeString(&completed_goals);
	FreeString(&stalled_goal_candidate);
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

/* Schema + prompt for the standalone match-portrait generation (no chat session).
   Mirrors the set_discoverable guidance from MIDDLEWARE_SYSTEM_PROMPT but asks the
   model for a single portrait string instead of a full action list. */
#define OPENAI_MATCH_DESCRIPTION_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"description\"]," \
  "\"properties\":{\"description\":{\"type\":\"string\"}}" \
"}"

/* Placeholders (%s) in order: derived summary, raw input history, goal activity
   history, active goals, completed goals. */
#define MATCH_PORTRAIT_PROMPT \
"You are the matching engine inside CHANGE, a personal growth app. " \
"Your task: write a single private portrait of this user that the server uses to match them with compatible people — intellectually, professionally, creatively. " \
"HARD RULE — NO DATING / NO ROMANCE: matching is strictly for friendship and for meeting compatible people in an intellectual, professional, or creative sense — shared curiosity, complementary thinking, common ground. Never use romantic framing. The portrait must never reference appearance, attraction, dating, or relationship intent. " \
"Write the portrait yourself from the stored context below: profile summary, identity-graph/profile signals, and goal activity. There is no live conversation — do not ask the user anything; work only from what is given. " \
"If you know little about the user, write a short neutral portrait ('Curious and open-minded, interested in meeting compatible people.'). " \
"The portrait is third-person, honest, grounded in visible signals. Not a résumé. Reads like what a mutual friend might say. " \
"If the context shows a clear exclusion the user stated (e.g. 'not a musician'), append: 'Does not want to be matched with: <exclusion>.' " \
"The portrait is private, never shown directly to anyone. " \
"User profile summary: [%s]. " \
"Raw input profile history: [%s]. " \
"Goal activity history: [%s]. " \
"Current unfinished goals: [%s]. " \
"Last touched or completed goals: [%s]. " \
"Return one strict JSON object only: {\"description\": \"...\"} containing only the portrait text."

String *GenerateMatchDescription(User *user)
{
	if (!user) return NULL;

	String input_history, goal_history, derived, active_goals, completed_goals;
	InitString(&input_history, 4096);
	InitString(&goal_history, 4096);
	InitString(&derived, 2048);
	InitString(&active_goals, 4096);
	InitString(&completed_goals, 4096);

	SerializeUserProfileHistorySection(user, "inputs", 20, &input_history);
	SerializeUserProfileHistorySection(user, "goal-activity", 20, &goal_history);
	SerializeUserProfileDerivedSummary(user, &derived);
	if (user->journey_count > 0) {
		SerializeDueGoals(&active_goals, 16, user->journeys[0]);
		SerializeUserGoalHistory(&completed_goals, 20, user->journeys[0]);
	}

	String prompt;
	InitString(&prompt, 12000);
	CatTemplateString(&prompt, MATCH_PORTRAIT_PROMPT,
		derived.p, input_history.p, goal_history.p, active_goals.p, completed_goals.p);

	FreeString(&derived);
	FreeString(&input_history);
	FreeString(&goal_history);
	FreeString(&active_goals);
	FreeString(&completed_goals);

	ai_gpt_request req = {0};
	req.prompt = prompt;
	req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
	req.schema_name = "match_description";
	InitString(&req.schema, sizeof(OPENAI_MATCH_DESCRIPTION_SCHEMA_JSON) + 1);
	CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_MATCH_DESCRIPTION_SCHEMA_JSON));

	String *ai_result = ai_openai_call_gpt_request(&req);
	FreeString(&req.schema);
	FreeString(&prompt);

	if (!ai_result) return NULL;

	String *out = NULL;
	json_value *doc = json_parse(ai_result->p, ai_result->len);
	if (doc && doc->type == json_object) {
		for (size_t i = 0; i < doc->u.object.length; i++) {
			json_object_entry e = doc->u.object.values[i];
			if (strcmp(e.name, "description") == 0 && e.value &&
			    e.value->type == json_string && e.value->u.string.length > 0) {
				out = malloc(sizeof(String));
				InitString(out, e.value->u.string.length + 1);
				CatString(out, e.value->u.string.ptr, e.value->u.string.length);
				break;
			}
		}
	}
	if (doc) json_value_free(doc);
	FreeString(ai_result);
	free(ai_result);
	return out;
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
		} else if (strcmp(entry.name, "graph_input") == 0) {
			copy_json_string_field(entry.value, action->graph_input, sizeof(action->graph_input), NULL);
		} else if (strcmp(entry.name, "requires_permission") == 0 && entry.value->type == json_boolean) {
			action->requires_permission = entry.value->u.boolean;
			action->has_requires_permission = 1;
		} else if (strcmp(entry.name, "min_rounds") == 0 && entry.value->type == json_integer) {
			action->min_rounds = (int)CLAMP(1, 8, entry.value->u.integer);
		} else if (strcmp(entry.name, "delay_seconds") == 0 && entry.value->type == json_integer) {
			action->delay_seconds = (int)entry.value->u.integer;
			action->has_delay_seconds = 1;
		} else if (strcmp(entry.name, "delay_until") == 0) {
			copy_json_string_field(entry.value, action->delay_until, sizeof(action->delay_until), &action->has_delay_until);
		} else if (strcmp(entry.name, "repair_reason") == 0) {
			copy_json_string_field(entry.value, action->repair_reason, sizeof(action->repair_reason), &action->has_repair_reason);
		} else if (strcmp(entry.name, "reminder_title") == 0) {
			copy_json_string_field(entry.value, action->reminder_title, sizeof(action->reminder_title), &action->has_reminder);
		} else if (strcmp(entry.name, "reminder_hour") == 0 && entry.value->type == json_integer) {
			action->reminder_hour = (int)entry.value->u.integer;
		} else if (strcmp(entry.name, "reminder_minute") == 0 && entry.value->type == json_integer) {
			action->reminder_minute = (int)entry.value->u.integer;
		} else if (strcmp(entry.name, "reminder_days") == 0 && entry.value->type == json_integer) {
			action->reminder_days = (int)entry.value->u.integer;
		} else if (strcmp(entry.name, "reminder_end_time") == 0 && entry.value->type == json_integer) {
			action->reminder_end_time = entry.value->u.integer;
		}
	}

	if (action->type[0] == '\0') {
		CatFixed(error, "Action has no type.");
		return 0;
	}

	return 1;
}

static _Bool parse_middleware_response(json_value *doc, String *assistant_message, MiddlewareAction **actions, size_t *actions_len, String *suggestions, String *error)
{
	json_value *message_json = NULL;
	json_value *actions_json = NULL;
	json_value *suggestions_json = NULL;

	*actions = NULL;
	*actions_len = 0;
	EmptyString(assistant_message);
	EmptyString(suggestions);

	if (!doc || doc->type != json_object) {
		CatFixed(error, "Middleware AI response is not a JSON object.");
		return 0;
	}

	message_json = json_object_get(doc, "assistant_message");
	actions_json = json_object_get(doc, "actions");
	suggestions_json = json_object_get(doc, "suggested_replies");

	if (suggestions_json && suggestions_json->type == json_array && suggestions_json->u.array.length > 0) {
		CatFixed(suggestions, "[");
		for (size_t i = 0; i < suggestions_json->u.array.length; i++) {
			json_value *sv = suggestions_json->u.array.values[i];
			if (!sv || sv->type != json_string) continue;
			char *esc = json_escape_dup(sv->u.string.ptr);
			if (suggestions->len > 1) CatFixed(suggestions, ",");
			CatTemplateString(suggestions, "\"%s\"", esc);
			free(esc);
		}
		CatFixed(suggestions, "]");
	}

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

	if (strcmp(action->type, "update_graph") == 0) {
		if (action->graph_input[0] == '\0') {
			CatFixed(error, "update_graph requires graph_input.");
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "delay_goal") == 0) {
		if (!action->has_goal_id || strlen(action->goal_id) != GOAL_ID_SIZE) {
			CatFixed(error, "delay_goal requires an exact 32-character goal_id.");
			return 0;
		}
		if (!action->has_delay_until && (!action->has_delay_seconds || action->delay_seconds <= 0)) {
			CatFixed(error, "delay_goal requires delay_until (YYYY-MM-DD) or delay_seconds (positive integer).");
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "drop_goal") == 0) {
		if (!action->has_goal_id || strlen(action->goal_id) != GOAL_ID_SIZE) {
			CatFixed(error, "drop_goal requires an exact 32-character goal_id.");
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "repair_branch") == 0) {
		if (!action->has_goal_id || strlen(action->goal_id) != GOAL_ID_SIZE) {
			CatFixed(error, "repair_branch requires an exact 32-character goal_id.");
			return 0;
		}
		if (!action->has_repair_reason || action->repair_reason[0] == '\0') {
			CatFixed(error, "repair_branch requires a non-empty repair_reason.");
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "set_discoverable") == 0 || strcmp(action->type, "update_match_description") == 0) {
		if (!action->has_value || action->value[0] == '\0') {
			CatTemplateString(error, "%s requires a non-empty value (match description).", action->type);
			return 0;
		}
		return 1;
	}

	if (strcmp(action->type, "set_private") == 0)
		return 1;

	if (strcmp(action->type, "find_match") == 0)
		return 1;

	if (strcmp(action->type, "set_reminder") == 0) {
		if (!action->has_reminder || action->reminder_title[0] == '\0') {
			CatFixed(error, "set_reminder requires reminder_title.");
			return 0;
		}
		return 1;
	}

	CatTemplateString(error, "Unknown action type [%s].", action->type);
	return 0;
}

static PendingReminderPermission *store_pending_reminder(
	const char *session_id,
	const MiddlewareAction *action
) {
	size_t slot = SIZE_MAX;
	for (size_t i = 0; i < MIDDLEWARE_MAX_PENDING_PERMISSIONS; i++) {
		if (!pending_reminders[i].active) { slot = i; break; }
	}
	if (slot == SIZE_MAX) slot = 0;

	memset(&pending_reminders[slot], 0, sizeof(pending_reminders[slot]));
	make_permission_id(pending_reminders[slot].id);
	strncpy(pending_reminders[slot].session_id, session_id ? session_id : "default",
	        sizeof(pending_reminders[slot].session_id) - 1);
	strncpy(pending_reminders[slot].title, action->reminder_title,
	        sizeof(pending_reminders[slot].title) - 1);
	pending_reminders[slot].hour     = action->reminder_hour;
	pending_reminders[slot].minute   = action->reminder_minute;
	pending_reminders[slot].days     = action->reminder_days;
	pending_reminders[slot].end_time = action->reminder_end_time;
	pending_reminders[slot].active   = 1;
	return &pending_reminders[slot];
}

static void emit_reminder_permission(
	const char *session_id,
	PendingReminderPermission *p,
	middleware_emit_like_func emit
) {
	char *esc_id    = json_escape_dup(p->id);
	char *esc_title = json_escape_dup(p->title);
	String payload;
	InitString(&payload, 256);
	CatTemplateString(&payload,
		"{\"permission_id\":\"%s\",\"title\":\"%s\","
		"\"hour\":%d,\"minute\":%d,\"days\":%d,\"end_time\":%lld}",
		esc_id, esc_title,
		p->hour, p->minute, p->days, p->end_time);
	emit_text(emit, session_id, "reminder_permission_required", payload.p);
	free(esc_id);
	free(esc_title);
	FreeString(&payload);
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

			{
				char summary[601] = {0};
				size_t slen = MIN(600, ds_out.len);
				memcpy(summary, ds_out.p, slen);
				UserProfileSetDerivedField(user, "last_ds_task", action->deep_search_task);
				UserProfileSetDerivedField(user, "last_ds_summary", summary);
			}

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

			change_assert(user->journey_count > 0 && user->journeys[0][0], "create_goal: user has no journey\n");
			emit_text(emit, session_id, "goal_create_started", action->goal_input1);
			created = CreateUserGoal(&input1, &input2, user->journeys[0], start_ds_session, user);
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

		if (strcmp(action->type, "update_graph") == 0) {
			String ginput;
			InitString(&ginput, strlen(action->graph_input) + 1);
			CatString(&ginput, action->graph_input, strlen(action->graph_input));
			emit_text(emit, session_id, "graph_update_started", action->graph_input);
			DecomposeInputIntoGraph(&ginput, user);
			emit_text(emit, session_id, "graph_updated", "");
			FreeString(&ginput);
			continue;
		}

		if (strcmp(action->type, "delay_goal") == 0) {
			goalIDType goal_id;
			memset(goal_id, 0, sizeof(goal_id));
			memcpy(goal_id, action->goal_id, GOAL_ID_SIZE);

			Goal *goal = FindGoalByID(goal_id, user->journeys[0]);
			if (!goal) {
				CatTemplateString(error, "delay_goal could not find goal_id [%s].", action->goal_id);
				return 0;
			}

			time_t seconds_to_add = (time_t)action->delay_seconds;
			if (action->has_delay_until && action->delay_until[0]) {
				int year = 0, mon = 0, day = 0;
				if (sscanf(action->delay_until, "%d-%d-%d", &year, &mon, &day) == 3) {
					struct tm tm_target = {0};
					tm_target.tm_year = year - 1900;
					tm_target.tm_mon = mon - 1;
					tm_target.tm_mday = day;
					tm_target.tm_isdst = -1;
					time_t target = mktime(&tm_target);
					time_t now = change_time_now();
					if (target > now)
						seconds_to_add = target - now;
				}
			}

			if (seconds_to_add > 0) {
				goal->pauseToNext += seconds_to_add;
				user->schedule_needs_refresh = 1;
				user->goal_health_needs_refresh = 1;
			}

			String payload;
			InitString(&payload, 256);
			char *esc_title = json_escape_dup(goal->title.p ? goal->title.p : "");
			CatTemplateString(&payload,
				"{\"goal_id\":\"%s\",\"title\":\"%s\",\"added_seconds\":%lld,\"new_pause_to_next\":%lld}",
				action->goal_id, esc_title, (long long)seconds_to_add, (long long)goal->pauseToNext);
			UserProfileRecordGoalEvent(user, "goal_delayed", goal, payload.p);
			emit_text(emit, session_id, "goal_delayed", payload.p);
			free(esc_title);
			FreeString(&payload);
			continue;
		}

		if (strcmp(action->type, "drop_goal") == 0) {
			goalIDType goal_id;
			memset(goal_id, 0, sizeof(goal_id));
			memcpy(goal_id, action->goal_id, GOAL_ID_SIZE);

			Goal *goal = FindGoalByID(goal_id, user->journeys[0]);
			if (!goal) {
				CatTemplateString(error, "drop_goal could not find goal_id [%s].", action->goal_id);
				return 0;
			}

			Goal *root = CalcGoalRoot(goal);
			String payload;
			InitString(&payload, 512);
			char *esc_title = json_escape_dup(root->title.p ? root->title.p : "");
			CatTemplateString(&payload,
				"{\"goal_id\":\"%s\",\"title\":\"%s\"}",
				root->id, esc_title);
			emit_text(emit, session_id, "goal_drop_requested", payload.p);
			free(esc_title);
			FreeString(&payload);
			continue;
		}

		if (strcmp(action->type, "set_goal_priority") == 0) {
			goalIDType goal_id;
			Goal *goal = NULL;
			Goal *root = NULL;
			String payload;

			memset(goal_id, 0, sizeof(goal_id));
			memcpy(goal_id, action->goal_id, GOAL_ID_SIZE);
			goal = FindGoalByID(goal_id, user->journeys[0]);
			if (!goal) {
				CatTemplateString(error, "set_goal_priority could not find goal_id [%s].", action->goal_id);
				return 0;
			}

			root = CalcGoalRoot(goal);
			change_assert(root, "Could not resolve root goal for priority change.\n");
			root->priority = (size_t)CLAMP(0, 5, action->priority);

			user->schedule_needs_refresh = 1;
			user->goal_health_needs_refresh = 1;

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

		if (strcmp(action->type, "repair_branch") == 0) {
			goalIDType goal_id;
			memset(goal_id, 0, sizeof(goal_id));
			memcpy(goal_id, action->goal_id, GOAL_ID_SIZE);

			Goal *target = FindGoalByID(goal_id, user->journeys[0]);
			if (!target) {
				CatTemplateString(error, "repair_branch could not find goal_id [%s].", action->goal_id);
				return 0;
			}

			String reason_s;
			InitString(&reason_s, strlen(action->repair_reason) + 1);
			CatString(&reason_s, action->repair_reason, strlen(action->repair_reason));

			Goal *repaired = RepairGoalBranch(target, &reason_s, start_ds_session, user);
			FreeString(&reason_s);

			if (!repaired) {
				CatFixed(error, "repair_branch failed — goal could not be rebuilt.");
				return 0;
			}

			String payload;
			InitString(&payload, 256);
			char *esc_title = json_escape_dup(repaired->title.p ? repaired->title.p : "");
			CatTemplateString(&payload,
				"{\"repaired_goal_id\":\"%s\",\"title\":\"%s\",\"local_index\":%zu}",
				repaired->id, esc_title, repaired->localIndex);
			emit_text(emit, session_id, "goal_repaired", payload.p);
			free(esc_title);
			FreeString(&payload);

			SaveUser(user);
			continue;
		}

		if (strcmp(action->type, "set_discoverable") == 0) {
			SetUserDiscoverable(user, action->value);
			emit_text(emit, session_id, "user_discoverable", "{}");
			continue;
		}

		if (strcmp(action->type, "set_private") == 0) {
			SetUserPrivate(user);
			emit_text(emit, session_id, "user_private", "{}");
			continue;
		}

		if (strcmp(action->type, "update_match_description") == 0) {
			UpdateUserDescription(user, action->value);
			emit_text(emit, session_id, "match_description_updated", "{}");
			continue;
		}

		if (strcmp(action->type, "find_match") == 0) {
			size_t found = FindMatchForUser(user);
			char payload[64];
			snprintf(payload, sizeof(payload), "{\"found\":%zu}", found);
			emit_text(emit, session_id, "match_search_done", payload);
			continue;
		}

		if (strcmp(action->type, "set_reminder") == 0) {
			PendingReminderPermission *p = store_pending_reminder(session_id, action);
			emit_reminder_permission(session_id, p, emit);
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

	emit_text(emit, session_id, "message_received", user_input);
	{
		MiddlewareSessionHistory *session_history = get_session_history(session_id);
		if (session_history->stalled_goal_reminder_shown &&
		    user_input_dismisses_stalled_goal_reminder(user_input) &&
		    !session_history->stalled_goal_reminder_dismissed) {
			session_history->stalled_goal_reminder_dismissed = 1;
			record_session_event(session_id, "stalled_goal_reminder_dismissed", user_input);
		}
	}

	for (size_t attempt = 0; attempt < MIDDLEWARE_MAX_RETRIES; attempt++) {
		String prompt;
		String *ai_result = NULL;
		json_value *doc = NULL;
		MiddlewareAction *actions = NULL;
		size_t actions_len = 0;
		String parse_error;
		String suggestions;
		_Bool has_stalled_goal_reminder_candidate = 0;
		_Bool parsed = 0;
		_Bool applied = 0;

		InitString(&prompt, 12000);
		InitString(&parse_error, 1024);
		InitString(&suggestions, 256);
		build_middleware_context(
			session_id,
			user_input,
			&retry_feedback,
			&deep_search_feedback,
			&prompt,
			user,
			&has_stalled_goal_reminder_candidate
		);

		ai_result = call_middleware_ai(&prompt);
		doc = json_parse(ai_result->p, ai_result->len);
		if (doc)
			parsed = parse_middleware_response(doc, &result.assistant_message, &actions, &actions_len, &suggestions, &parse_error);
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
			if (has_stalled_goal_reminder_candidate) {
				MiddlewareSessionHistory *session_history = get_session_history(session_id);
				if (!session_history->stalled_goal_reminder_shown) {
					session_history->stalled_goal_reminder_shown = 1;
					record_session_event(session_id, "stalled_goal_reminder_shown", "");
				}
			}
			append_session_message(session_id, "assistant", result.assistant_message.p);
			UserProfileRecordInput(user, "middleware_chat_assistant", result.assistant_message.p);
			emit_text(emit, session_id, "assistant_message", result.assistant_message.p);
			if (suggestions.len > 2)
				emit_text(emit, session_id, "suggested_replies", suggestions.p);
			FreeString(&suggestions);
			FreeString(&parse_error);
			break;
		}

		FreeString(&suggestions);

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

/* Returns JSON array of all sessions whose session_id starts with `user_prefix:`.
   Each element: { "name": <name>, "history": [{"role":..,"text":..}, ...] }
   Caller must free the returned string. */
char* ListChatSessionsJSON(const char *user_prefix)
{
	String out;
	InitString(&out, 1024);
	CatFixed(&out, "[");
	int first = 1;

	for (size_t i = 0; i < MIDDLEWARE_CHAT_HISTORY_CAP; i++) {
		MiddlewareSessionHistory *h = &chat_histories[i];
		if (!h->used) continue;

		/* filter to this user */
		size_t plen = user_prefix ? strlen(user_prefix) : 0;
		if (plen == 0 || strncmp(h->session_id, user_prefix, plen) != 0 ||
		    h->session_id[plen] != ':') continue;

		const char *name = h->session_id + plen + 1;  /* after "userId:" */

		/* parse plain-text history into [{role,text},...] */
		String msgs;
		InitString(&msgs, 256);
		CatFixed(&msgs, "[");
		int first_msg = 1;
		const char *line = h->history.p ? h->history.p : "";
		while (*line) {
			const char *end = strchr(line, '\n');
			size_t line_len = end ? (size_t)(end - line) : strlen(line);

			/* format: "[timestamp] role: text" */
			const char *close = memchr(line, ']', line_len);
			if (close && *(close + 1) == ' ') {
				const char *after = close + 2;
				const char *colon = memchr(after, ':', (size_t)(line + line_len - after));
				if (colon) {
					size_t role_len = (size_t)(colon - after);
					char role[32] = {0};
					if (role_len < sizeof(role))
						memcpy(role, after, role_len);
					const char *text = colon + 2; /* skip ": " */
					size_t text_len = (size_t)(line + line_len - text);
					char text_copy[1024] = {0};
					if (text_len >= sizeof(text_copy)) text_len = sizeof(text_copy) - 1;
					memcpy(text_copy, text, text_len);
					char *esc_role = json_escape_dup(role);
					char *esc_text = json_escape_dup(text_copy);
					if (!first_msg) CatFixed(&msgs, ",");
					CatTemplateString(&msgs, "{\"role\":\"%s\",\"text\":\"%s\"}",
					                  esc_role, esc_text ? esc_text : "");
					free(esc_role);
					free(esc_text);
					first_msg = 0;
				}
			}
			if (!end) break;
			line = end + 1;
		}
		CatFixed(&msgs, "]");

		char *esc_name = json_escape_dup(name);
		if (!first) CatFixed(&out, ",");
		CatTemplateString(&out, "{\"name\":\"%s\",\"messages\":%s}",
		                  esc_name, msgs.p);
		free(esc_name);
		FreeString(&msgs);
		first = 0;
	}

	CatFixed(&out, "]");
	return out.p;
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
	/* check reminder permissions first */
	for (size_t i = 0; i < MIDDLEWARE_MAX_PENDING_PERMISSIONS; i++) {
		if (!pending_reminders[i].active) continue;
		if (strcmp(pending_reminders[i].id, permission_id) != 0) continue;

		String event;
		InitString(&event, 256);

		if (approved) {
			Reminder r;
			memset(&r, 0, sizeof(r));
			strncpy(r.title, pending_reminders[i].title, sizeof(r.title) - 1);
			r.hour     = pending_reminders[i].hour;
			r.minute   = pending_reminders[i].minute;
			r.days     = (uint8_t)pending_reminders[i].days;
			r.end_time = (time_t)pending_reminders[i].end_time;
			r.enabled  = 1;
			RemindersSave(user, &r);

			char *esc_title = json_escape_dup(r.title);
			CatTemplateString(&event,
				"{\"permission_id\":\"%s\",\"approved\":true,"
				"\"title\":\"%s\",\"hour\":%d,\"minute\":%d}",
				pending_reminders[i].id, esc_title ? esc_title : "",
				r.hour, r.minute);
			free(esc_title);
		} else {
			CatTemplateString(&event,
				"{\"permission_id\":\"%s\",\"approved\":false}",
				pending_reminders[i].id);
		}

		emit_text(emit, pending_reminders[i].session_id, "permission_resolved", event.p);
		pending_reminders[i].active = 0;
		FreeString(&event);
		return 1;
	}

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
