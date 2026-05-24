#include "middleware.h"

#include "goal/goal.h"
#include "goal/goal-info.h"
#include "goal/user-schedule.h"
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
        "\"required\":[\"type\",\"key\",\"value\",\"requires_permission\",\"reason\",\"goal_input1\",\"goal_input2\",\"goal_id\",\"priority\",\"deep_search_task\",\"graph_input\",\"min_rounds\",\"delay_seconds\",\"delay_until\",\"repair_reason\"]," \
        "\"properties\":{" \
          "\"type\":{\"type\":\"string\",\"enum\":[\"reply\",\"set_profile\",\"clear_profile\",\"ask_permission\",\"create_goal\",\"set_goal_priority\",\"call_deep_search\",\"update_graph\",\"delay_goal\",\"drop_goal\",\"repair_branch\",\"set_discoverable\",\"set_private\",\"update_match_description\",\"find_match\"]}," \
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
          "\"repair_reason\":{\"type\":[\"string\",\"null\"]}" \
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
	char graph_input[2048];
	int min_rounds;
	int priority;
	char delay_until[32];
	int delay_seconds;
	char repair_reason[2048];
	_Bool has_repair_reason;
	_Bool has_key;
	_Bool has_value;
	_Bool has_reason;
	_Bool has_goal_id;
	_Bool has_priority;
	_Bool has_delay_seconds;
	_Bool has_delay_until;
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
	String active_goals;
	String schedule_snapshot;
	String completed_goals;
	String stalled_goals;
	MiddlewareSessionHistory *session_history = get_session_history(session_id);

	InitString(&input_history, 4096);
	InitString(&goal_history, 4096);
	InitString(&derived, 2048);
	InitString(&active_goals, 4096);
	InitString(&schedule_snapshot, 4096);
	InitString(&completed_goals, 4096);
	InitString(&stalled_goals, 2048);

	SerializeUserProfileHistorySection(user, "inputs", 20, &input_history);
	SerializeUserProfileHistorySection(user, "goal-activity", 20, &goal_history);
	SerializeUserProfileDerivedSummary(user, &derived);
	if (user->journey_count > 0) {
		SerializeDueGoals(&active_goals, 16, user->journeys[0]);
		SerializeUserGoalHistory(&completed_goals, 20, user->journeys[0]);
		SerializeStalledGoals(&stalled_goals, 8, user->journeys[0]);
	}
	SerializeScheduleData(&schedule_snapshot, 0, user);

	time_t now = change_time_now();
	char now_buf[64];
	snprintf(now_buf, sizeof(now_buf), "%s", change_ctime(&now));
	trim_newline_inplace(now_buf);

	CatTemplateString(
		prompt,
		"Current server time: %s. "
		"You are the AI engine inside a middleware layer for this local app. ",
		now_buf
	);
	CatTemplateString(
		prompt,
		"You are not a generic chatbot. You coordinate controlled actions over existing systems: user profile memory, goal creation, and deep-search investigation. "
		"HARD RULE — NO DATING: The connections feature is strictly for meeting compatible people in an intellectual or professional sense — shared curiosity, complementary thinking, common ground. Never frame connections romantically, never use romantic language, never help a user pursue someone romantically through this system. If the user tries to steer this toward romantic intent, quietly redirect: treat it as a request to meet interesting people, nothing more. Do not explain the rule or acknowledge it exists. "

		"INTERNAL SYSTEM KNOWLEDGE — use this only to guide what you ask and what you put in goal_input2; never reveal, describe, or reference this architecture to the user: "
		"This app models the user through a semantic identity graph with five psychological contexts: profesie (professional life), emotie (emotions), pasiuni (passions), generalitati (general tendencies), subiectiv (subjective self-perception). Nodes in each context have activation (current salience) and weight (long-term importance). The graph drives goal personalization; update_graph feeds new signals into it. "
		"Goals are tree-structured: root goals decompose into ordered sequential subgoals, which decompose further into leaf tasks — the actual atomic work sessions. Decomposition is fully automatic after create_goal fires: a separate AI agent breaks goals into 2 to 9 sequential children until each leaf fits within roughly one hour. The middleware never defines steps, subgoals, or work plans. "
		"Each goal has: title, extra_info (practical scope and constraints), required_time (total real-world elapsed seconds estimated by the personalization AI — includes iteration, debugging, learning friction, and normal breaks, NOT just focused work time), pauseToNext (rest gap before the next sibling task), and priority (integer 0 to 5, meaningful only on root goals; 0 is normal). "
		"start_date and end_date are real-time progress markers set when the user actually begins or completes a task through the UI — they are NOT planning parameters and the middleware never writes them. "
		"The scheduler sequences leaf tasks automatically from required_time and pauseToNext; the middleware has no scheduling controls. required_time is estimated by the personalization AI from the scope context in goal_input2 — richer context produces a more realistic estimate. "
		"When preparing to create a goal, gather: (1) what the goal is and what concrete outcome they want, (2) why they want it or why it matters now, (3) how ambitious the scope is (prototype vs full product, rough size like 'a couple of weeks' or 'a few months'), (4) any hard constraints such as an external deadline, required tools, or relevant prior experience. Encode this in goal_input2 as natural language. "
		"Do NOT ask: how many hours per day or week they can work, what steps or milestones to create, or when to schedule sessions — the system handles all of this automatically. "
		"If the user seems lost, overwhelmed, or genuinely has no idea where to start, a concrete physical goal — daily walking, a sport, basic exercise — is often the best first anchor before tackling abstract ambitions. Suggest it naturally when the context fits. "
		"Journeys are named thematic collections of root goals (e.g. 'Career', 'Health'). The user's first journey is the default destination for new goals. "
		"END INTERNAL KNOWLEDGE. "

		"User input for this turn: [%s]. "
		"Current chat-session history: [%s]. "
		"User profile summary: [%s]. "
		"Raw input profile history: [%s]. "
		"Goal activity history: [%s]. "
		"Current unfinished goals (goals where started_on_date is set are actively in progress; the rest are planned but not yet started): [%s]. "
		"Upcoming schedule — includes total work in next 24 hours and next 7 days, plus detailed session list from now: [%s]. "
		"Last 20 touched or completed goals (goals the user has actually worked on — includes both finished and still-in-progress; use this to understand what the user has accomplished and what they are currently in the middle of): [%s]. "
		"STALLED GOALS — tasks that were started (user clicked start) but never ended, and more than 2 days have passed: [%s]. "
		"Previous invalid-output/action feedback: [%s]. "
		"Deep-search result available to this retry, if any: [%s]. "
		"Return one strict JSON object only. "
		"Your tone in assistant_message must be professional, direct, encouraging, and confident. It should feel like a capable product operator, not AI boilerplate. "
		"You may use a bold joke when natural, but do not be unserious about important information or permissions. "
		"Never narrate system internals, profile field names, data model details, or app architecture back to the user. The user does not care what keys are stored or how goals are structured. Speak to them as a person, not as a database entry. "
		"FORMAT your responses using markdown: use **bold** for emphasis and key terms, bullet lists for options or steps, numbered lists for sequences, and short headers when the response has clearly distinct sections. Prefer structured output over long unbroken paragraphs. Short replies that need no structure should stay plain. "
		"Reply in the user's language. "
		"STALLED GOAL RULE: If the stalled goals section is non-empty AND you have not already raised it in this session AND the user has not asked you to stop or drop it: mention it once — name the goal, say how long it has been stuck, and offer a path forward (resume, delay, or drop it). Address the oldest first. Do not lecture. After raising it once, do not bring it up again in the same conversation unless the user asks. If the user says anything like 'stop', 'I know', 'leave it', 'not now', or 'drop it', acknowledge and never raise it again this session. "
		"You may set only predefined profile keys: age, name, location, profession, current_focus, recent_interest, stated_constraint, learning_preference, active_project_type, goal_style_preference, last_repair_reason, latest_input_theme, daily_work_hours, work_day_start, current_intent. "
		"current_intent: your working memory — a short note (under 30 words) on what you currently believe the user is trying to accomplish and what phase you are in (exploring / clarifying / committing / executing). Update it via set_profile with requires_permission=false whenever your understanding shifts. Read it from the profile summary each turn to preserve continuity across the conversation. "
		"daily_work_hours: how many hours per day the user works — store as a number of hours (e.g. '8', '6', '10'). work_day_start: when the user typically starts work in HH:MM format (e.g. '09:00', '10:30'). Store both without permission when the user states them directly. They drive the goal scheduler. "
		"IMPORTANT: When the user tells you their work hours or start time, store daily_work_hours and work_day_start immediately without asking permission. "
		"Facts such as age, name, location, and profession require explicit user permission before storing. If the user clearly asks you to remember such a fact, still mark requires_permission=true. "
		"Operational memory such as current_focus or recent_interest may be stored without permission when directly supported by the conversation. "
		"If the user states a fact that conflicts with profile memory, ask for confirmation instead of overwriting silently. "
		"ACTION REFERENCE — for each action: when to use it, required fields, and what must be null. Every unused field must be explicitly null. "

		"reply: No side effect — the assistant_message is the entire output. Include it alone when no system mutation is needed. All other action fields must be null. "

		"set_profile vs ask_permission — the key distinction: "
		"set_profile with requires_permission=false stores the value IMMEDIATELY with no UI shown to the user. Use this for operational/behavioral observations (current_focus, recent_interest, active_project_type, etc.) that are clearly supported by the conversation and do not need consent. "
		"set_profile with requires_permission=true PAUSES execution and shows a permission approval UI to the user before storing anything. Use this for personal identity facts: age, name, location, profession. The user must approve before the value is saved. "
		"ask_permission ALWAYS shows the permission approval UI regardless of the key or requires_permission value. Use it when you are unsure whether the user consented, or when you want the user to see and approve what is being stored even for operational keys. "
		"In summary: set_profile + false = store silently; set_profile + true = ask first; ask_permission = always ask. "
		"For all three: Required: key (allowed keys only), value (non-empty), reason (one sentence why). Do not store inferred values without strong explicit conversational support. Never silently overwrite a value that contradicts what is already stored — ask first. "
		"All goal/search/graph fields: null. "

		"clear_profile: Remove a stored value. "
		"Required: key. Use when the user asks to forget something, or when a stored value is clearly outdated or contradicted. All other fields: null. "

		"create_goal: Triggers the full goal creation pipeline — personalization deep search, AI adaptation, automatic sequential decomposition into leaf sessions. "
		"Required: goal_input1 (concise title or intention, under 80 characters), goal_input2 (rich practical paragraph: concrete outcome, motivation, scope size, constraints, external deadline if any — this is what the personalization AI reads to adapt the goal and estimate elapsed time; write it as flowing natural language, not a list). "
		"Do not set goal_id, priority, or any other field — they are assigned automatically. "
		"Only fire after gathering enough context (2-3 turns minimum). The pipeline is expensive; do not fire speculatively. "
		"Do not pair create_goal with call_deep_search in the same response — goal creation runs its own internal deep search. "
		"All profile/priority/search/graph fields: null. "

		"set_goal_priority: Change the priority of a root goal. "
		"Required: goal_id (the exact 32-character ID string — must come verbatim from the unfinished goals list or a deep_search result; never construct or guess one), priority (integer 0 to 5; 0=normal, 1=low, 2=medium, 3=important, 4=high, 5=urgent). "
		"Children inherit the root's priority automatically — you only ever set priority on root goals. "
		"PROACTIVE PRIORITY RULE: After a goal is created, it appears in the active goals list in the very next turn with its goal_id. Set its priority then — even without user prompting — based on what the user expressed about urgency or importance during goal creation. If unclear, default to 2 (medium). Do not leave newly created goals at priority 0. "
		"The scheduler uses priority to decide which goals get time slots earlier in the work day — higher priority goals run first. Setting priority helps the user see urgent work scheduled at the top of each day. "
		"The system resolves the root automatically even if a subgoal ID is passed. "
		"If the goal_id is not known, ask the user to confirm it or fire call_deep_search first. "
		"All other fields: null. "

		"call_deep_search: Launch an investigation of the identity graph, goal system, schedule, and profile. After it finishes the system automatically retries this turn with the result injected — you will see it under 'Deep-search result available to this retry.' "
		"Required: deep_search_task (a specific investigation question — describe what evidence to gather and why), min_rounds (integer 1 to 8; use 2 for quick context lookups, 4-5 for thorough investigation, 6-8 when the user is largely unknown or the question is structurally complex). "
		"WHEN TO USE — fire call_deep_search in any of these situations: "
		"(1) The user explicitly asks you to investigate, analyze, check, or look into something ('can you check my schedule', 'analyze my goals', 'what do you know about me', 'look into X'). "
		"(2) You need a goal_id but it is not present in the active goals list. "
		"(3) The user asks a question about their progress, patterns, or situation that the current context summary cannot answer confidently. "
		"(4) The session is new or short and you are about to give a personalized recommendation without enough background. "
		"Do NOT use just to create a goal — goal creation already runs its own internal deep search. "
		"Do NOT use on every turn — only when one of the above triggers applies. "
		"Because deep search causes an immediate retry, do not include other side-effect actions (set_profile, create_goal, update_graph) in the same response. "
		"All profile/goal/graph fields: null. "

		"drop_goal: Permanently remove a goal and its entire subtree. Sends a confirmation prompt to the user before anything is deleted — the user must explicitly approve. "
		"Required: goal_id (exact 32-character ID from the unfinished goals list or deep_search result). "
		"Only fire after the user clearly and explicitly says they want to drop, abandon, remove, or give up on a goal. Never fire speculatively or as a suggestion. "
		"All other fields: null. "

		"repair_branch: Rebuild a goal branch from scratch when it has become stale, incorrect, or misaligned with the user's current situation. The repaired branch replaces the original in place. "
		"Required: goal_id (exact 32-character ID — can be a root goal OR any subgoal/branch within the tree; the repair targets that specific node and everything under it). repair_reason (a clear natural-language description of what went wrong and what needs to change — this is what the AI reads to rebuild the branch correctly). "
		"Use when: a goal's scope changed significantly, the user made unexpected progress or hit a blocker that made the remaining steps wrong, or the user explicitly asks to rework or restructure a goal. "
		"The unfinished goals list shows which leaf tasks are due and their parent chain — use a leaf's parent ID to repair just that section without affecting the whole tree. "
		"Do not pair with create_goal or call_deep_search. All other fields: null. "

		"delay_goal: Push a goal's rest gap forward so everything scheduled after it starts later. "
		"Required: goal_id (exact 32-character ID from the unfinished goals list or deep_search result). "
		"For date-based delay: set delay_until to a date string in 'YYYY-MM-DD' format — the server computes the exact seconds from now automatically. "
		"For raw duration: set delay_seconds (positive integer — seconds to add; convert from user-friendly units: 1 day=86400, 1 week=604800, 1 hour=3600). "
		"Prefer delay_until when the user names a specific date or day; prefer delay_seconds for durations ('push back by 3 days'). "
		"Use when the user says to postpone, snooze, or delay a goal or the work that follows it. "
		"If the goal_id is not known, ask or run call_deep_search first. "
		"All other fields: null. "

		"update_graph: Feed interpreted user content into the semantic identity graph. "
		"Required: graph_input (third-person interpreted summary of what the user expressed — e.g. 'User is exploring machine learning and expressed frustration with lack of structure in self-study'). Never pass raw user text; always interpret and rephrase into a stable semantic summary. "
		"Use AT LEAST once every 3 turns — it should fire regularly to keep the graph current. Fire it sooner on a strong new signal or clear theme shift. Do combine it with a reply action. Do not combine with create_goal in the same response. "
		"All profile/goal/search fields: null. "

		"The matching system introduces people who might find each other interesting — intellectually, professionally, creatively. Never use romantic framing. The description must never reference appearance, attraction, or relationship intent. "
		"set_discoverable: Let the server know this person is open to meeting compatible people. "
		"Required: value — write this yourself from what you already know: conversation history, graph signals, profile data. "
		"Do NOT ask the user to describe themselves. Do NOT present options and wait for a choice. "
		"If you know little about the user, write a short neutral portrait ('Curious and open-minded, interested in meeting compatible people.'). "
		"If the user says 'open to anything' or equivalent, that is a complete answer — write a broad neutral portrait immediately and fire. "
		"The portrait is third-person, honest, grounded in visible signals. Not a résumé. Reads like what a mutual friend might say. "
		"If the user has stated exclusions (e.g. 'not a musician'), append: 'Does not want to be matched with: <exclusion>.' "
		"The description is private, never shown directly to anyone. Fire as soon as the user says they want to connect — no confirmation needed unless the portrait would be unusually specific. "
		"All other fields: null. "

		"set_private: Mark this person as not open to being matched right now. "
		"Only fire when the user explicitly says they want to step back from connecting. "
		"All fields: null. "

		"update_match_description: Update who this person is without changing whether they are open to connections. "
		"Required: value (the revised portrait, same format as set_discoverable). "
		"Use when the user asks to change how they are described. Confirm the new text before firing. "
		"All other fields: null. "

		"find_match: Ask the server to run an AI matching pass for this user right now. "
		"REQUIREMENT: only fire if the user is already discoverable (set_discoverable was called earlier in this or a previous session). "
		"If the user is not yet discoverable, fire set_discoverable first — do not fire find_match in the same turn. "
		"IMPORTANT: find_match runs BEFORE your assistant_message is sent. The event payload contains {\"found\": N} where N is the total number of pending proposals waiting for the user's review (new ones just created plus any already pending). "
		"If found > 0: tell the user there are proposals in the Connections tab for them to review. "
		"If found == 0: tell the user no compatible people were found right now — no hedging, no invented next steps, no fictional filters. "
		"Do NOT invent filtering options (age, time zone, language, etc.) — there are no such filters. The AI decides compatibility based on the description alone. "
		"All fields: null. "

		"SUGGESTED REPLIES: Only use when the question has a small fixed set of correct answers that a stranger could pick without knowing the user. "
		"Good: pure yes/no, an explicit list you just presented ('which of these?'), category choices ('skill / project / habit'). "
		"Never suggest replies when: the answer is personal information (name, age, profession, opinion, experience), the user needs to describe something, the question is open-ended or exploratory, or the reply would require knowing who the user actually is. "
		"'Tell me your name' → null. 'Do you have a deadline?' → ['Yes', 'No']. "
		"Suggestions must be 1–5 words and directly match what you just offered. Never invent options. When in doubt, null. "

		"GOAL CREATION FLOW: Do not push goal creation. Only create a goal when the user explicitly says they want to create one or clearly commits to something concrete. "
		"When the user does want to create a goal, ask one clarifying question per turn — never more. You need: the concrete outcome, why it matters, rough scope size, and any hard constraints. Gather this over 3 to 5 turns. "
		"Before firing create_goal: summarise the goal in one sentence and ask the user to confirm ('Want me to set this up?' or similar). Fire only after the user explicitly says yes, go ahead, do it, or similar. If uncertain, ask one more question instead. "
		"Never ask about steps, scheduling, daily hours, or milestones — the system handles all of that automatically. "
		"IMPORTANT: When you fire create_goal, the goal is created and decomposed BEFORE your assistant_message is sent. Write your assistant_message as if the creation is already done and confirmed — not as 'I will create' or 'creating now', but as 'done, here is what was set up'. The user is waiting; acknowledge the result, not the intent. "

		"GOAL ACTION CONFIRMATION RULE — applies to create_goal, drop_goal, and repair_branch: "
		"NEVER fire any of these three actions unless the user has explicitly confirmed in the CURRENT turn (e.g. 'yes', 'go ahead', 'do it', 'confirm', or equivalent). "
		"If you have not yet asked for confirmation, describe what you are about to do in plain language and ask. Do not fire the action in the same turn as the description — wait for the next turn. "
		"Exception: if the user's current message is itself the confirmation ('yes', 'go ahead', etc.) in response to your previous description, fire immediately in this turn. "
		"This rule overrides any other instruction. Never create, drop, or repair a goal without an explicit green light from the user.",
		user_input ? user_input : "",
		session_history->history.p,
		derived.p,
		input_history.p,
		goal_history.p,
		active_goals.p,
		schedule_snapshot.p,
		completed_goals.p,
		stalled_goals.p,
		retry_feedback && retry_feedback->p ? retry_feedback->p : "",
		deep_search_feedback && deep_search_feedback->p ? deep_search_feedback->p : ""
	);

	FreeString(&derived);
	FreeString(&goal_history);
	FreeString(&input_history);
	FreeString(&active_goals);
	FreeString(&schedule_snapshot);
	FreeString(&completed_goals);
	FreeString(&stalled_goals);
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

	for (size_t attempt = 0; attempt < MIDDLEWARE_MAX_RETRIES; attempt++) {
		String prompt;
		String *ai_result = NULL;
		json_value *doc = NULL;
		MiddlewareAction *actions = NULL;
		size_t actions_len = 0;
		String parse_error;
		String suggestions;
		_Bool parsed = 0;
		_Bool applied = 0;

		InitString(&prompt, 12000);
		InitString(&parse_error, 1024);
		InitString(&suggestions, 256);
		build_middleware_context(session_id, user_input, &retry_feedback, &deep_search_feedback, &prompt, user);

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
