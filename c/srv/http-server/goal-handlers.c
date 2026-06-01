#include "internal.h"
#include "http-server.h"
#include "http-util.h"
#include "goal/goal.h"
#include "goal/schedule-system.h"
#include "user-management.h"
#include "journey.h"
#include "journal.h"
#include "search/deep-search-session.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static Goal *resolve_goal_from_body(const HttpRequest *req, User *user, Journey **owning);

static int validate_goal_id_32(const char *goal_id)
{
	size_t len = goal_id ? strlen(goal_id) : 0;
	if (len != GOAL_ID_LEN) {
		change_assert(len == GOAL_ID_LEN,
			"goal-id must be exactly %d chars, got %zu", GOAL_ID_LEN, len);
		return 0;
	}
	return 1;
}

static void goal_id_to_cstr(const Goal *g, char out[GOAL_ID_LEN + 1])
{
	if (!g) { out[0] = '\0'; return; }
	memcpy(out, g->id, GOAL_ID_LEN);
	out[GOAL_ID_LEN] = '\0';
}

static Goal *find_goal_by_id_string(const char *goal_id, const char *journey_id)
{
	if (!goal_id) return NULL;

	size_t len = 0;
	Goal **goals = GetGoalsSorted(&len, journey_id);
	Goal  *found = NULL;

	for (size_t i = 0; i < len; i++) {
		Goal *g = goals[i];
		if (!g) continue;
		char cur[GOAL_ID_LEN + 1];
		goal_id_to_cstr(g, cur);
		if (strcmp(cur, goal_id) == 0) { found = g; break; }
	}

	free(goals);
	return found;
}

/* Search all user journeys for a goal by id. Sets *out_journey to the owning journey.
 * Shared journeys are fetched from central first so state is current. */
static Goal *find_goal_any_journey(const char *goal_id, User *user, Journey **out_journey)
{
	if (out_journey) *out_journey = NULL;
	if (!goal_id || !goal_id[0] || !user) return NULL;

	for (size_t ji = 0; ji < user->journey_count; ji++) {
		const char *jid = user->journeys[ji];
		Journey *j = FindJourneyByID(jid);
		if (!j) continue;
		if (j->is_shared) FetchSharedJourney(jid);
		Goal *g = find_goal_by_id_string(goal_id, jid);
		if (g) {
			if (out_journey) *out_journey = j;
			return g;
		}
	}
	return NULL;
}

static Goal *find_goal_from_request_body(const HttpRequest *req, char out_goal_id[GOAL_ID_LEN + 1], const char *journey_id)
{
	int   goal_index = 0;
	char  goal_id[256];
	Goal *goal = NULL;

	if (out_goal_id) out_goal_id[0] = '\0';
	if (!req || !req->body) return NULL;

	goal_id[0] = '\0';

	if (json_get_int_field(req->body, "goalIndex",  &goal_index) ||
	    json_get_int_field(req->body, "localIndex", &goal_index) ||
	    json_get_int_field(req->body, "goal-index", &goal_index)) {
		if (goal_index <= 0) return NULL;
		goal = FindGoalFromIndex(journey_id, (size_t)goal_index);
	} else if (json_get_string_field(req->body, "goal-id", goal_id, sizeof(goal_id)) ||
	           json_get_string_field(req->body, "goalId",  goal_id, sizeof(goal_id)) ||
	           json_get_string_field(req->body, "id",      goal_id, sizeof(goal_id))) {
		if (!validate_goal_id_32(goal_id)) return NULL;
		goal = find_goal_by_id_string(goal_id, journey_id);
	}

	if (!goal) return NULL;
	if (out_goal_id) goal_id_to_cstr(goal, out_goal_id);
	return goal;
}

static Goal *find_goal_from_request_body_by_id(const HttpRequest *req, char out_goal_id[GOAL_ID_LEN + 1], const char *journey_id)
{
	char  goal_id[256];
	Goal *goal = NULL;

	if (out_goal_id) out_goal_id[0] = '\0';
	if (!req || !req->body) return NULL;

	goal_id[0] = '\0';

	if (!(json_get_string_field(req->body, "goal-id", goal_id, sizeof(goal_id)) ||
	      json_get_string_field(req->body, "goalId",  goal_id, sizeof(goal_id)) ||
	      json_get_string_field(req->body, "id",      goal_id, sizeof(goal_id))))
		return NULL;

	if (!validate_goal_id_32(goal_id)) return NULL;

	goal = find_goal_by_id_string(goal_id, journey_id);
	if (!goal) return NULL;

	if (out_goal_id) goal_id_to_cstr(goal, out_goal_id);
	return goal;
}

static void append_goal_json(String *out, Goal *g)
{
	char  goal_id[GOAL_ID_LEN + 1];
	char *esc_id       = NULL;
	char *esc_title    = NULL;
	char *esc_extra    = NULL;
	char *esc_tips     = NULL;
	char *esc_attach   = NULL;
	Goal *root         = NULL;
	size_t eff_priority = 0;

	change_assert(out, "append_goal_json got NULL output.\n");
	change_assert(g,   "append_goal_json got NULL goal.\n");

	goal_id_to_cstr(g, goal_id);

	esc_id    = json_escape_dup(goal_id);
	esc_title = json_escape_dup(c_str(&g->title));
	esc_extra = json_escape_dup(c_str(&g->extra_info));
	esc_tips  = json_escape_dup(g->tips.p ? c_str(&g->tips) : "");
	esc_attach = json_escape_dup(g->attach_id);
	root      = CalcGoalRoot(g);
	eff_priority = root ? root->priority : g->priority;

	CatTemplateString(out,
		"{"
			"\"id\":\"%s\","
			"\"localIndex\":%zu,"
			"\"title\":\"%s\","
			"\"title_len\":%zu,"
			"\"extra_info\":\"%s\","
			"\"extra_info_len\":%zu,"
			"\"start_date\":%lld,"
			"\"end_date\":%lld,"
			"\"required_time\":%lld,"
			"\"min_pause_to_next\":%lld,"
			"\"pause_to_next\":%lld,"
			"\"subgoals_len\":%zu,"
			"\"subgoals\":[",
		esc_id, g->localIndex,
		esc_title, g->title.len,
		esc_extra, g->extra_info.len,
		(long long)g->start_date, (long long)g->end_date,
		(long long)g->required_time, (long long)g->minPauseToNext,
		(long long)g->pauseToNext, g->subgoals_len);

	for (size_t i = 0; i < g->subgoals_len; i++) {
		if (i > 0) CatString(out, FSTRING_SIZE_PARAMS(","));
		CatTemplateString(out, "%zu", g->subgoals[i]);
	}

	CatTemplateString(out,
		"],"
			"\"parent\":%zu,"
			"\"prev\":%zu,"
			"\"next\":%zu,"
			"\"depth\":%zu,"
			"\"retry_depth\":%zu,"
			"\"priority\":%zu,"
			"\"goal_type\":%u,"
			"\"tips\":\"%s\","
			"\"attach_id\":\"%s\""
		"}",
		g->parent, g->prev, g->next,
		g->depth, g->retry_depth, eff_priority,
		(unsigned)g->goal_type, esc_tips ? esc_tips : "",
		esc_attach ? esc_attach : "");

	free(esc_tips);
	free(esc_attach);
	free(esc_extra);
	free(esc_title);
	free(esc_id);
}

static char *serialize_goals_container_json(const char *journey_id)
{
	size_t len   = 0;
	size_t active = 0;
	Goal **goals = GetGoalsSorted(&len, journey_id);
	String out;

	for (size_t i = 0; i < len; i++)
		if (goals[i]) active++;

	InitString(&out, 8192 + active * 1024);
	CatTemplateString(&out, "{\"ok\":true,\"count\":%zu,\"container_len\":%zu,\"goals\":[", active, len);

	_Bool first = 1;
	for (size_t i = 0; i < len; i++) {
		if (!goals[i]) continue;
		if (!first) CatString(&out, FSTRING_SIZE_PARAMS(","));
		append_goal_json(&out, goals[i]);
		first = 0;
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));
	free(goals);
	return out.p;
}

static char *serialize_goal_children_json(Goal *g, User *user)
{
	if (!g) {
		char *err = malloc(128);
		cassert(err, "Failed to allocate error json.\n");
		snprintf(err, 128, "{\"ok\":false,\"error\":\"goal_not_found\"}");
		return err;
	}

	_Bool decomposed_now = 0;
	/* Typed leaves (e.g. journal) are terminal steps — never auto-decompose them. */
	if (g->subgoals_len == 0 && g->goal_type == GOAL_TYPE_TIMER && g->required_time >= 60 * 15)
		decomposed_now = DecomposeGoal(g, user);

	char  goal_id[GOAL_ID_LEN + 1];
	goal_id_to_cstr(g, goal_id);
	char *esc_goal_id = json_escape_dup(goal_id);

	String out;
	InitString(&out, 4096 + g->subgoals_len * 1024);

	CatTemplateString(&out,
		"{\"ok\":true,\"goalIndex\":%zu,\"goalId\":\"%s\",\"decomposedNow\":%s,\"goal\":",
		g->localIndex, esc_goal_id, decomposed_now ? "true" : "false");

	append_goal_json(&out, g);
	CatString(&out, FSTRING_SIZE_PARAMS(",\"children\":["));

	_Bool first = 1;
	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		if (!child) continue;
		if (!first) CatString(&out, FSTRING_SIZE_PARAMS(","));
		append_goal_json(&out, child);
		first = 0;
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));
	free(esc_goal_id);
	return out.p;
}

void handle_get_goal_list(int fd, User *user)
{
	char *json = serialize_goals_container_json(user->journeys[0]);

	if (!json) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"goals_container_failed\"}");
		return;
	}

	http_send_json(fd, 200, "OK", json);
	free(json);
}

void handle_post_goal_export(int fd, User *user)
{
	if (!user) {
		http_send_json(fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"no_active_user\"}");
		return;
	}

	SaveUser(user);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_get_goal_load(int fd, User *user)
{
	if (!user) {
		http_send_json(fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"no_active_user\"}");
		return;
	}

	for (size_t i = 0; i < user->journey_count; i++) {
		Journey *j = FindJourneyByID(user->journeys[i]);
		if (!j) continue;
		char path[USER_DIRECTORY_SIZE];
		GetUserJourneyPath(user, j->id, path);
		if (access(path, R_OK) == 0)
			LoadJourneyFromFile(j, path);
	}

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_post_goal_decompose(int fd, const HttpRequest *req, User *user)
{
	int   goal_index = 0;
	char  goal_id[256];
	Goal *goal = NULL;

	goal_id[0] = '\0';

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (json_get_int_field(req->body, "goalIndex",  &goal_index) ||
	    json_get_int_field(req->body, "localIndex", &goal_index) ||
	    json_get_int_field(req->body, "goal-index", &goal_index)) {
		if (goal_index <= 0) {
			http_send_json(fd, 400, "Bad Request",
				"{\"ok\":false,\"error\":\"invalid_goal_index\"}");
			return;
		}
		goal = FindGoalFromIndex(user->journeys[0], (size_t)goal_index);
	} else if (json_get_string_field(req->body, "goal-id", goal_id, sizeof(goal_id)) ||
	           json_get_string_field(req->body, "goalId",  goal_id, sizeof(goal_id)) ||
	           json_get_string_field(req->body, "id",      goal_id, sizeof(goal_id))) {
		goal = find_goal_by_id_string(goal_id, user->journeys[0]);
	} else {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_goal_identifier\"}");
		return;
	}

	if (!goal) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found\"}");
		return;
	}

	if (goal->end_date) {
		http_send_json(fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"goal_already_completed\"}");
		return;
	}

	if (goal->goal_type != GOAL_TYPE_TIMER) {
		http_send_json(fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"goal_not_decomposable\"}");
		return;
	}

	char *json = serialize_goal_children_json(goal, user);
	if (!json) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"goal_decompose_failed\"}");
		return;
	}

	http_send_json(fd, 200, "OK", json);
	free(json);
}

static void handle_post_goal_status_action(
	int fd,
	const HttpRequest *req,
	const char *event_type,
	time_t (*action_fn)(Goal *, User *),
	const char *date_field_name,
	User *user)
{
	char  goal_id[GOAL_ID_LEN + 1];
	char  event_body[256];
	char  response_body[256];
	char *esc_goal_id = NULL;
	int   response_len;
	int   event_len;
	time_t action_time = 0;
	Goal *goal = NULL;

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	/* Try personal journey first; fall back to all user journeys for shared leaves. */
	Journey *owning_journey = NULL;
	char raw_id[256] = {0};
	if (!json_get_string_field(req->body, "goal-id", raw_id, sizeof(raw_id)))
		if (!json_get_string_field(req->body, "goalId",  raw_id, sizeof(raw_id)))
			json_get_string_field(req->body, "id",      raw_id, sizeof(raw_id));
	goal = find_goal_from_request_body(req, goal_id, user->journeys[0]);
	if (!goal && raw_id[0])
		goal = find_goal_any_journey(raw_id, user, &owning_journey);
	if (goal && goal_id[0] == '\0')
		goal_id_to_cstr(goal, goal_id);
	if (!goal) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found\"}");
		return;
	}

	if (strcmp(event_type, "goal_ended") == 0) {
		if (!goal->start_date) {
			http_send_json(fd, 409, "Conflict",
				"{\"ok\":false,\"error\":\"goal_not_started\"}");
			return;
		}
		if (goal->end_date) {
			http_send_json(fd, 409, "Conflict",
				"{\"ok\":false,\"error\":\"goal_already_completed\"}");
			return;
		}
		/*
		 * Journal leaves cannot be completed without the journal entry they
		 * produced. The client sends back the entry id (attach_id) it edited;
		 * we require it and record it before stamping end_date. Non-journal
		 * goals ignore journal_ref entirely.
		 */
		if (goal->goal_type == GOAL_TYPE_JOURNAL) {
			char journal_ref[49] = {0};
			json_get_string_field(req->body, "journal_ref", journal_ref, sizeof(journal_ref));
			if (!journal_ref[0]) {
				http_send_json(fd, 400, "Bad Request",
					"{\"ok\":false,\"error\":\"journal_ref_required\"}");
				return;
			}
			strncpy(goal->attach_id, journal_ref, sizeof(goal->attach_id) - 1);
			goal->attach_id[sizeof(goal->attach_id) - 1] = '\0';
		}
	}

	Goal  *root           = CalcGoalRoot(goal);
	time_t root_end_before = root ? root->end_date : 0;

	action_time = action_fn(goal, user);
	if (owning_journey && owning_journey->is_shared)
		PushJourneyToCentral(owning_journey);
	SaveUser(user);

	event_len = snprintf(event_body, sizeof(event_body),
		"{\"goal-id\":\"%s\",\"goal_index\":%zu,\"%s\":%lld,\"start_date\":%lld,\"end_date\":%lld}",
		goal_id, goal->localIndex, date_field_name,
		(long long)action_time, (long long)goal->start_date, (long long)goal->end_date);

	if (event_len > 0 && (size_t)event_len < sizeof(event_body))
		goal_emit_event(goal_id, event_type, event_body, (size_t)event_len);

	if (strcmp(event_type, "goal_ended") == 0 && root && root_end_before == 0 && root->end_date != 0) {
		char  tree_body[256];
		char *esc_root_id    = json_escape_dup(root->id);
		char *esc_root_title = json_escape_dup(root->title.p ? root->title.p : "");
		int   tree_len = snprintf(tree_body, sizeof(tree_body),
			"{\"root_goal_id\":\"%s\",\"title\":\"%s\",\"end_date\":%lld}",
			esc_root_id, esc_root_title, (long long)root->end_date);
		free(esc_root_id);
		free(esc_root_title);
		if (tree_len > 0 && (size_t)tree_len < sizeof(tree_body))
			goal_emit_event(root->id, "goal_tree_completed", tree_body, (size_t)tree_len);
	}

	esc_goal_id = json_escape_dup(goal_id);
	response_len = snprintf(response_body, sizeof(response_body),
		"{\"ok\":true,\"goal-id\":\"%s\",\"goal_index\":%zu,\"at\":%lld,\"start_date\":%lld,\"end_date\":%lld}",
		esc_goal_id, goal->localIndex,
		(long long)action_time, (long long)goal->start_date, (long long)goal->end_date);
	free(esc_goal_id);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}");
		return;
	}

	http_send_json(fd, 200, "OK", response_body);
}

void handle_get_goal_events(int fd, const char *full_path)
{
	static const char *header =
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: text/event-stream\r\n"
		"Cache-Control: no-cache\r\n"
		"Connection: keep-alive\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"\r\n";

	char path_only[256];
	const char *query = NULL;
	char goal_id[256];

	split_path_and_query(full_path, path_only, sizeof(path_only), &query);
	goal_id[0] = '\0';

	if (!query_get_param(query, "goal-id", goal_id, sizeof(goal_id)))
		query_get_param(query, "id", goal_id, sizeof(goal_id));

	if (goal_id[0] != '\0' && !validate_goal_id_32(goal_id)) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"invalid_goal_id_length\"}");
		return;
	}

	if (http_send_all(fd, header, strlen(header)) != 0) { close(fd); return; }
	if (!add_sse_client(fd, goal_id[0] ? goal_id : NULL)) { close(fd); return; }

	if (goal_id[0])
		goal_emit_event(goal_id, "sse_connected", "connected", strlen("connected"));
}

void handle_post_goal_create(int fd, const HttpRequest *req, User *user)
{
	char  title[256];
	char  extra_info[2048];
	char  journey_id[64];
	char  event_body[256];
	char  response_body[256];
	char *esc_goal_id = NULL;
	int   event_len;
	int   response_len;
	String title_s;
	String extra_info_s;
	Goal  *goal = NULL;

	title[0] = extra_info[0] = journey_id[0] = '\0';

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (!json_get_string_field(req->body, "title", title, sizeof(title))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_title\"}");
		return;
	}

	if (!json_get_string_field(req->body, "extraInfo",  extra_info, sizeof(extra_info)) &&
	    !json_get_string_field(req->body, "extrainfo", extra_info, sizeof(extra_info))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_extra_info\"}");
		return;
	}

	json_get_string_field(req->body, "journeyId", journey_id, sizeof(journey_id));

	/* No journeyId in the request (e.g. the onboarding flow) → fall back to the
	 * user's default journey. Passing NULL crashes downstream in CreateGoal,
	 * which requires a real journey to attach the goal to. */
	const char *effective_journey_id =
		journey_id[0] ? journey_id :
		(user->journey_count > 0 ? user->journeys[0] : NULL);

	if (!effective_journey_id) {
		http_send_json(fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"no_journey\"}");
		return;
	}

	printf("goal/create title=%s extraInfo=%s journeyId=%s\n", title, extra_info, effective_journey_id);

	InitString(&title_s,      strlen(title)      + 1);
	InitString(&extra_info_s, strlen(extra_info) + 1);
	CatString(&title_s,      title,      strlen(title));
	CatString(&extra_info_s, extra_info, strlen(extra_info));

	goal = CreateUserGoal(&title_s, &extra_info_s, effective_journey_id, start_ds_session, user);

	FreeString(&extra_info_s);
	FreeString(&title_s);

	if (goal) SaveUser(user);

	if (!goal) {
		goal_emit_event(NULL, "goal_create_failed", "goal create failed", strlen("goal create failed"));
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"goal_create_failed\"}");
		return;
	}

	event_len = snprintf(event_body, sizeof(event_body), "{\"goal-id\":\"%s\"}", goal->id);
	if (event_len > 0 && (size_t)event_len < sizeof(event_body))
		goal_emit_event(goal->id, "goal_created", event_body, (size_t)event_len);

	esc_goal_id  = json_escape_dup(goal->id);
	response_len = snprintf(response_body, sizeof(response_body),
		"{\"ok\":true,\"goal-id\":\"%s\"}", esc_goal_id);
	free(esc_goal_id);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}");
		return;
	}

	http_send_json(fd, 200, "OK", response_body);
}

void handle_post_goal_start(int fd, const HttpRequest *req, User *user)
{
	char  leaf_id[GOAL_ID_LEN + 1];
	char  event_body[256];
	char  response_body[256];
	char *esc_leaf_id;
	int   event_len, response_len;

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char  raw_goal_id[256] = {0};
	Journey *owning_journey = NULL;

	if (!(json_get_string_field(req->body, "goal-id", raw_goal_id, sizeof(raw_goal_id)) ||
	      json_get_string_field(req->body, "goalId",  raw_goal_id, sizeof(raw_goal_id)) ||
	      json_get_string_field(req->body, "id",      raw_goal_id, sizeof(raw_goal_id)))) {
		/* Fall back to index-based lookup in personal journey */
		int goal_index = 0;
		if (json_get_int_field(req->body, "goalIndex",  &goal_index) ||
		    json_get_int_field(req->body, "localIndex", &goal_index) ||
		    json_get_int_field(req->body, "goal-index", &goal_index)) {
			if (goal_index <= 0) {
				http_send_json(fd, 400, "Bad Request",
					"{\"ok\":false,\"error\":\"invalid_goal_index\"}");
				return;
			}
			Goal *g = FindGoalFromIndex(user->journeys[0], (size_t)goal_index);
			if (g) goal_id_to_cstr(g, raw_goal_id);
		}
	}

	if (!raw_goal_id[0]) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_goal_identifier\"}");
		return;
	}

	Goal *orig = find_goal_any_journey(raw_goal_id, user, &owning_journey);
	if (!orig) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found\"}");
		return;
	}

	Goal *leaf = StartGoalDeepFromGoal(orig, user);
	if (!leaf) {
		http_send_json(fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"goal_not_startable\"}");
		return;
	}

	/*
	 * Journal leaves produce a draft journal entry at start time. The id is
	 * stored on the leaf and returned so the client can edit that exact entry;
	 * the title carries a "(draft)" suffix until the step is submitted via
	 * /goal/end. If creation fails we leave attach_id empty and let the client
	 * fall back gracefully.
	 */
	char attach_id_field[80] = "";
	if (leaf->goal_type == GOAL_TYPE_JOURNAL && !leaf->attach_id[0]) {
		char draft_title[JOURNAL_TITLE_SIZE];
		snprintf(draft_title, sizeof(draft_title), "%s (draft)", c_str(&leaf->title));
		JournalMeta jm;
		if (JournalCreate(user, draft_title, "", -1, 0, &jm) == 0) {
			strncpy(leaf->attach_id, jm.id, sizeof(leaf->attach_id) - 1);
			leaf->attach_id[sizeof(leaf->attach_id) - 1] = '\0';
		}
	}
	if (leaf->attach_id[0]) {
		char *esc_attach = json_escape_dup(leaf->attach_id);
		snprintf(attach_id_field, sizeof(attach_id_field),
			",\"attach_id\":\"%s\"", esc_attach ? esc_attach : "");
		free(esc_attach);
	}

	if (owning_journey && owning_journey->is_shared)
		PushJourneyToCentral(owning_journey);

	goal_id_to_cstr(leaf, leaf_id);

	event_len = snprintf(event_body, sizeof(event_body),
		"{\"goal-id\":\"%s\",\"goal_index\":%zu,\"start_date\":%lld,\"end_date\":%lld}",
		leaf_id, leaf->localIndex, (long long)leaf->start_date, (long long)leaf->end_date);
	if (event_len > 0 && (size_t)event_len < sizeof(event_body))
		goal_emit_event(leaf_id, "goal_started", event_body, (size_t)event_len);

	esc_leaf_id  = json_escape_dup(leaf_id);
	response_len = snprintf(response_body, sizeof(response_body),
		"{\"ok\":true,\"goal-id\":\"%s\",\"goal_index\":%zu,\"at\":%lld,\"start_date\":%lld,\"end_date\":%lld%s}",
		esc_leaf_id, leaf->localIndex,
		(long long)leaf->start_date, (long long)leaf->start_date, (long long)leaf->end_date,
		attach_id_field);
	free(esc_leaf_id);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}");
		return;
	}

	SaveUser(user);
	http_send_json(fd, 200, "OK", response_body);
}

void handle_post_goal_end(int fd, const HttpRequest *req, User *user)
{
	handle_post_goal_status_action(fd, req, "goal_ended", EndGoalFromGoal, "end_date", user);
}

/*
 * POST /goal/cancel — abandon an in-progress session without completing it.
 * Resets start_date/end_date and clears any session-bound artifact (the
 * journal draft id). The journal entry itself is intentionally NOT deleted —
 * it stays as a "(draft)" entry the user can revisit. Used when the user
 * leaves a journal focus session before submitting.
 */
void handle_post_goal_cancel(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Journey *owning = NULL;
	Goal *g = resolve_goal_from_body(req, user, &owning);
	if (!g) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"goal_not_found\"}");
		return;
	}

	g->start_date  = 0;
	g->end_date    = 0;
	g->attach_id[0] = '\0';

	if (owning && owning->is_shared) PushJourneyToCentral(owning);
	SaveUser(user);

	char gid[GOAL_ID_LEN + 1];
	goal_id_to_cstr(g, gid);

	char body[256];
	int n = snprintf(body, sizeof(body),
		"{\"ok\":true,\"goal-id\":\"%s\",\"goal_index\":%zu}", gid, g->localIndex);
	goal_emit_event(gid, "goal_cancelled", body, (n > 0 && (size_t)n < sizeof(body)) ? (size_t)n : 0);
	http_send_json(fd, 200, "OK", body);
}

/*
 * POST /journey/dismiss — exit (and delete) a journey. For shared journeys one
 * participant leaving dismisses the journey for everyone (central drops it).
 * Accepts {"journey-id":"..."} or, for convenience, {"goal-id":"..."} (any goal
 * in the journey) and resolves the owning journey from it.
 */
void handle_post_journey_dismiss(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char journey_id[JOURNEY_ID_SIZE + 1] = {0};
	if (!json_get_string_field(req->body, "journey-id", journey_id, sizeof(journey_id)) &&
	    !json_get_string_field(req->body, "journeyId",  journey_id, sizeof(journey_id))) {
		char raw_goal_id[256] = {0};
		if (json_get_string_field(req->body, "goal-id", raw_goal_id, sizeof(raw_goal_id)) ||
		    json_get_string_field(req->body, "goalId",  raw_goal_id, sizeof(raw_goal_id))) {
			Journey *owning = NULL;
			Goal *g = find_goal_any_journey(raw_goal_id, user, &owning);
			if (g && owning) {
				strncpy(journey_id, owning->id, sizeof(journey_id) - 1);
				journey_id[sizeof(journey_id) - 1] = '\0';
			}
		}
	}

	if (!journey_id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_journey_identifier\"}");
		return;
	}

	Journey *j = FindJourneyByID(journey_id);
	if (!j) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}

	_Bool shared = j->is_shared;

	if (shared) DeleteSharedJourneyOnCentral(journey_id);
	RemoveJourneyFromTable(journey_id);  /* frees j; don't use it afterwards */

	/* Drop the id from the user's journey list and delete the on-disk copy. */
	for (size_t i = 0; i < user->journey_count; i++) {
		if (strcmp(user->journeys[i], journey_id) != 0) continue;
		for (size_t k = i; k + 1 < user->journey_count; k++)
			memcpy(user->journeys[k], user->journeys[k + 1], JOURNEY_ID_SIZE);
		user->journey_count--;
		break;
	}

	char path[512];
	GetUserJourneyPath(user, journey_id, path);
	unlink(path);

	SaveUser(user);

	goal_emit_event(journey_id, "journey_dismissed", "{}", 2);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_post_goal_drop(int fd, const HttpRequest *req, User *user)
{
	char  goal_id[GOAL_ID_LEN + 1] = {0};
	char  event_body[512];

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Goal *goal = find_goal_from_request_body_by_id(req, goal_id, user->journeys[0]);
	if (!goal) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found\"}");
		return;
	}

	Goal *root = CalcGoalRoot(goal);
	char *esc_title = json_escape_dup(root->title.p ? root->title.p : "");
	DropGoalTree(root, user);
	SaveUser(user);

	int event_len = snprintf(event_body, sizeof(event_body),
		"{\"goal_id\":\"%s\",\"title\":\"%s\"}", root->id, esc_title);
	free(esc_title);

	if (event_len > 0 && (size_t)event_len < sizeof(event_body))
		goal_emit_event(root->id, "goal_dropped", event_body, (size_t)event_len);

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_post_goal_repair(int fd, const HttpRequest *req, User *user)
{
	char  goal_id[GOAL_ID_LEN + 1];
	char  repair_reason[2048];
	char  event_body[1024];
	String reason_s;
	String out;
	Goal  *target   = NULL;
	Goal  *repaired = NULL;

	goal_id[0] = repair_reason[0] = '\0';

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	target = find_goal_from_request_body_by_id(req, goal_id, user->journeys[0]);
	if (!target) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found_or_invalid_id\"}");
		return;
	}

	if (!json_get_string_field(req->body, "reason",       repair_reason, sizeof(repair_reason)) &&
	    !json_get_string_field(req->body, "repairReason", repair_reason, sizeof(repair_reason)) &&
	    !json_get_string_field(req->body, "request",      repair_reason, sizeof(repair_reason))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_repair_reason\"}");
		return;
	}

	if (repair_reason[0] == '\0') {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"empty_repair_reason\"}");
		return;
	}

	printf("goal/repair goalId=%s reason=%s\n", goal_id, repair_reason);

	InitString(&reason_s, strlen(repair_reason) + 1);
	CatString(&reason_s, repair_reason, strlen(repair_reason));

	repaired = RepairGoalBranch(target, &reason_s, start_ds_session, user);

	FreeString(&reason_s);

	if (repaired) SaveUser(user);

	if (!repaired) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"goal_repair_failed\"}");
		return;
	}

	int event_len = snprintf(event_body, sizeof(event_body),
		"{\"goal-id\":\"%s\",\"goal_index\":%zu}", repaired->id, repaired->localIndex);
	if (event_len > 0 && (size_t)event_len < sizeof(event_body))
		goal_emit_event(repaired->id, "goal_repaired", event_body, (size_t)event_len);

	InitString(&out, 2048);
	CatFixed(&out, "{\"ok\":true,\"goal\":");
	append_goal_json(&out, repaired);
	CatFixed(&out, "}");

	http_send_json(fd, 200, "OK", out.p);
	FreeString(&out);
}

void handle_post_goal_shared_action(int fd, const HttpRequest *req, User *user)
{
	char journey_id[64] = {0};
	char goal_id[256]   = {0};
	char action[16]     = {0};

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (!json_get_string_field(req->body, "journey_id", journey_id, sizeof(journey_id)) || !journey_id[0] ||
	    !json_get_string_field(req->body, "action",     action,     sizeof(action))     || !action[0]     ||
	    !json_get_string_field(req->body, "goal_id",    goal_id,    sizeof(goal_id))    || !goal_id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}

	Journey *j = FetchSharedJourney(journey_id);
	if (!j) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"journey_fetch_failed\"}");
		return;
	}

	Goal *goal = find_goal_by_id_string(goal_id, journey_id);
	if (!goal) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"goal_not_found\"}");
		return;
	}

	char out_id[GOAL_ID_LEN + 1];
	char attach_field[96] = "";
	time_t at = 0;

	if (strcmp(action, "start") == 0) {
		Goal *leaf = StartGoalDeepFromGoal(goal, user);
		if (!leaf) {
			http_send_json(fd, 409, "Conflict", "{\"ok\":false,\"error\":\"goal_not_startable\"}");
			return;
		}
		/* Journal leaves need a draft entry created at start (same as the solo
		   /goal/start path) so the shared journal editor has something to write. */
		if (leaf->goal_type == GOAL_TYPE_JOURNAL && !leaf->attach_id[0]) {
			char draft_title[JOURNAL_TITLE_SIZE];
			snprintf(draft_title, sizeof(draft_title), "%s (draft)", c_str(&leaf->title));
			JournalMeta jm;
			if (JournalCreate(user, draft_title, "", -1, 0, &jm) == 0) {
				strncpy(leaf->attach_id, jm.id, sizeof(leaf->attach_id) - 1);
				leaf->attach_id[sizeof(leaf->attach_id) - 1] = '\0';
			}
		}
		if (leaf->attach_id[0]) {
			char *esc_attach = json_escape_dup(leaf->attach_id);
			snprintf(attach_field, sizeof(attach_field), ",\"attach_id\":\"%s\"", esc_attach ? esc_attach : "");
			free(esc_attach);
		}
		goal_id_to_cstr(leaf, out_id);
		at = leaf->start_date;
	} else if (strcmp(action, "end") == 0) {
		if (!goal->start_date || goal->end_date) {
			http_send_json(fd, 409, "Conflict", "{\"ok\":false,\"error\":\"goal_not_endable\"}");
			return;
		}
		goal_id_to_cstr(goal, out_id);
		at = EndGoalFromGoal(goal, user);
	} else if (strcmp(action, "reassign") == 0) {
		if (goal->start_date) {
			http_send_json(fd, 409, "Conflict", "{\"ok\":false,\"error\":\"cannot_reassign_started_goal\"}");
			return;
		}
		char target_user_id[64] = {0};
		if (!json_get_string_field(req->body, "target_user_id", target_user_id, sizeof(target_user_id)) || !target_user_id[0]) {
			http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_target_user_id\"}");
			return;
		}
		size_t target_idx = FindUserIndexInJourney(j, target_user_id);
		if (target_idx >= j->user_count) {
			http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"target_not_a_participant\"}");
			return;
		}
		goal->assigned_to = (uint8_t)target_idx;
		goal_id_to_cstr(goal, out_id);
	} else {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"unknown_action\"}");
		return;
	}

	PushJourneyToCentral(j);
	SaveUser(user);

	char response[224];
	snprintf(response, sizeof(response), "{\"ok\":true,\"goal-id\":\"%s\",\"at\":%lld%s}", out_id, (long long)at, attach_field);
	http_send_json(fd, 200, "OK", response);
}

void handle_post_goal_create_shared_root(int fd, const HttpRequest *req, User *user)
{
	char journey_id[64]   = {0};
	char proposal_id[64]  = {0};
	char title[256]       = {0};
	char extra_info[2048] = {0};

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (!json_get_string_field(req->body, "journey_id",  journey_id,  sizeof(journey_id))  || !journey_id[0] ||
	    !json_get_string_field(req->body, "proposal_id", proposal_id, sizeof(proposal_id)) || !proposal_id[0] ||
	    !json_get_string_field(req->body, "title",       title,       sizeof(title))       || !title[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}
	json_get_string_field(req->body, "extra_info", extra_info, sizeof(extra_info));

	Journey *j = FetchSharedJourney(journey_id);
	if (!j) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"journey_fetch_failed\"}");
		return;
	}

	String title_s, extra_info_s;
	InitString(&title_s,      strlen(title)      + 1);
	InitString(&extra_info_s, strlen(extra_info) + 1);
	CatString(&title_s,      title,      strlen(title));
	CatString(&extra_info_s, extra_info, strlen(extra_info));

	Goal *goal = CreateUserGoal(&title_s, &extra_info_s, journey_id, start_ds_session, user);

	FreeString(&extra_info_s);
	FreeString(&title_s);

	if (!goal) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"goal_create_failed\"}");
		return;
	}

	/* Decompose immediately so participants see their leaf assignments right away.
	 * Failure is non-fatal — the root goal still exists and can be decomposed later. */
	if (!DecomposeGoal(goal, user))
		fprintf(stderr, "[create-shared-root] decomposition failed — root goal exists but has no leaves.\n");

	/* Assign any leaf the AI left unassigned round-robin across participants. */
	if (j->user_count >= 2) {
		size_t slot = 0;
		for (size_t i = 0; i < j->goals_count; i++) {
			Goal *g = j->goals[i];
			if (!g || g->subgoals_len > 0) continue;
			if (g->assigned_to == JOURNEY_USER_UNASSIGNED)
				g->assigned_to = (uint8_t)(slot % j->user_count);
			slot++;
		}
	}

	PushJourneyToCentral(j);
	SaveUser(user);

	char goal_id_str[GOAL_ID_LEN + 1];
	goal_id_to_cstr(goal, goal_id_str);

	/* Notify central that the proposal is finalized */
	char finalize_body[256];
	snprintf(finalize_body, sizeof(finalize_body),
		"{\"proposal_id\":\"%s\",\"goal_id\":\"%s\"}", proposal_id, goal_id_str);
	size_t fb_len = strlen(finalize_body);

	int cfd = central_connect();
	if (cfd >= 0) {
		char hdr[512];
		int hlen = snprintf(hdr, sizeof(hdr),
			"POST /journey/%s/finalize-root HTTP/1.1\r\nHost: 127.0.0.1\r\n"
			"Content-Type: application/json\r\nContent-Length: %zu\r\n"
			"Connection: close\r\n\r\n",
			journey_id, fb_len);
		http_send_all(cfd, hdr, (size_t)hlen);
		http_send_all(cfd, finalize_body, fb_len);
		close(cfd);
	} else {
		fprintf(stderr, "[create-shared-root] central finalize call failed — proposal not marked.\n");
	}

	char response[128];
	snprintf(response, sizeof(response), "{\"ok\":true,\"goal-id\":\"%s\"}", goal_id_str);
	http_send_json(fd, 200, "OK", response);
}

void handle_get_session_goals(int fd, User *user)
{
	size_t  len     = 0;
	Goal  **session = GetSessionGoals(&len, user);
	String  out;

	InitString(&out, 512 + len * 512);
	CatTemplateString(&out, "{\"ok\":true,\"count\":%zu,\"goals\":[", len);

	for (size_t i = 0; i < len; i++) {
		if (i > 0) CatString(&out, FSTRING_SIZE_PARAMS(","));
		append_goal_json(&out, session[i]);
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));

	if (session) free(session);

	http_send_json(fd, 200, "OK", c_str(&out));
	free(out.p);
}

/* Force a full recompute (health-check + schedule rebuild) then return results. */
void handle_post_schedule_refresh(int fd, User *user)
{
	user->goal_health_needs_refresh = 1;
	user->schedule_needs_refresh    = 1;
	handle_get_schedule(fd, user);
}

void handle_get_schedule(int fd, User *user)
{
	/* Pull the latest copy of every shared journey from central first, so the
	   schedule includes shared-journey steps assigned to this user with their
	   current progress (otherwise we'd schedule from a stale local copy). */
	for (size_t ji = 0; ji < user->journey_count; ji++) {
		Journey *j = FindJourneyByID(user->journeys[ji]);
		if (j && j->is_shared) FetchSharedJourney(user->journeys[ji]);
	}

	/* The client opening the schedule always gets a freshly computed one. */
	user->schedule_needs_refresh = 1;

	size_t len = 0;
	const struct ScheduleEntry *entries = GetSchedule(&len, user);
	String out;

	InitString(&out, 1024 + len * 256);
	CatTemplateString(&out, "{\"ok\":true,\"count\":%zu,\"entries\":[", len);

	for (size_t i = 0; i < len; i++) {
		Goal *g      = FindGoalFromIndex(entries[i].journey_id, entries[i].goalIndex);
		char *esc_title = json_escape_dup(g ? c_str(&g->title) : "");

		if (i > 0) CatString(&out, FSTRING_SIZE_PARAMS(","));

		CatTemplateString(&out, "{\"time\":%lld,\"duration\":%lld,\"goal_index\":%zu,\"title\":\"%s\"}",
			(long long)entries[i].time, (long long)entries[i].duration, entries[i].goalIndex, esc_title);

		free(esc_title);
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));

	http_send_json(fd, 200, "OK", c_str(&out));
	free(out.p);
}

/* Resolve a goal from the request body (id, then index fallback in journey 0). */
static Goal *resolve_goal_from_body(const HttpRequest *req, User *user, Journey **owning)
{
	char raw[256] = {0};
	if (!(json_get_string_field(req->body, "goal-id", raw, sizeof(raw)) ||
	      json_get_string_field(req->body, "goalId",  raw, sizeof(raw)) ||
	      json_get_string_field(req->body, "id",      raw, sizeof(raw)))) {
		int idx = 0;
		if (json_get_int_field(req->body, "goalIndex",  &idx) ||
		    json_get_int_field(req->body, "localIndex", &idx) ||
		    json_get_int_field(req->body, "goal-index", &idx)) {
			if (idx > 0) {
				Goal *g = FindGoalFromIndex(user->journeys[0], (size_t)idx);
				if (g) goal_id_to_cstr(g, raw);
			}
		}
	}
	if (!raw[0]) return NULL;
	return find_goal_any_journey(raw, user, owning);
}

/* POST /goal/extend — overtime: add 5..10 min to a leaf the user is working on. */
void handle_post_goal_extend(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) { http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}"); return; }

	Journey *owning = NULL;
	Goal *g = resolve_goal_from_body(req, user, &owning);
	if (!g) { http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"goal_not_found\"}"); return; }
	if (g->subgoals_len != 0) { http_send_json(fd, 409, "Conflict", "{\"ok\":false,\"error\":\"not_a_leaf\"}"); return; }
	if (g->goal_type != GOAL_TYPE_TIMER) { http_send_json(fd, 409, "Conflict", "{\"ok\":false,\"error\":\"goal_not_extendable\"}"); return; }

	ExtendGoalLeaf(g);

	if (owning && owning->is_shared) PushJourneyToCentral(owning);
	SaveUser(user);

	char gid[GOAL_ID_LEN + 1];
	goal_id_to_cstr(g, gid);

	char body[256];
	int n = snprintf(body, sizeof(body),
		"{\"ok\":true,\"goal-id\":\"%s\",\"goal_index\":%zu,\"required_time\":%lld}",
		gid, g->localIndex, (long long)CalcGoalRequiredTime(g));
	goal_emit_event(gid, "goal_extended", body, (n > 0 && (size_t)n < sizeof(body)) ? (size_t)n : 0);
	http_send_json(fd, 200, "OK", body);
}

/* POST /goal/reshape — recontextualize a stuck leaf and reset its start. */
void handle_post_goal_reshape(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) { http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}"); return; }

	Journey *owning = NULL;
	Goal *g = resolve_goal_from_body(req, user, &owning);
	if (!g) { http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"goal_not_found\"}"); return; }
	if (g->subgoals_len != 0) { http_send_json(fd, 409, "Conflict", "{\"ok\":false,\"error\":\"not_a_leaf\"}"); return; }

	ReshapeGoalLeaf(g);

	if (owning && owning->is_shared) PushJourneyToCentral(owning);
	SaveUser(user);

	char gid[GOAL_ID_LEN + 1];
	goal_id_to_cstr(g, gid);

	char *esc_title = json_escape_dup(g->title.p ? g->title.p : "");
	char body[512];
	int n = snprintf(body, sizeof(body),
		"{\"ok\":true,\"goal-id\":\"%s\",\"goal_index\":%zu,\"title\":\"%s\",\"required_time\":%lld}",
		gid, g->localIndex, esc_title ? esc_title : "", (long long)CalcGoalRequiredTime(g));
	free(esc_title);
	goal_emit_event(gid, "goal_reshaped", body, (n > 0 && (size_t)n < sizeof(body)) ? (size_t)n : 0);
	http_send_json(fd, 200, "OK", body);
}
