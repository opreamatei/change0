#include "internal.h"
#include "http-server.h"
#include "http-util.h"
#include "goal/goal.h"
#include "goal/schedule-system.h"
#include "user-management.h"
#include "journey.h"
#include "search/deep-search-session.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

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
	Goal *root         = NULL;
	size_t eff_priority = 0;

	change_assert(out, "append_goal_json got NULL output.\n");
	change_assert(g,   "append_goal_json got NULL goal.\n");

	goal_id_to_cstr(g, goal_id);

	esc_id    = json_escape_dup(goal_id);
	esc_title = json_escape_dup(c_str(&g->title));
	esc_extra = json_escape_dup(c_str(&g->extra_info));
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
			"\"priority\":%zu"
		"}",
		g->parent, g->prev, g->next,
		g->depth, g->retry_depth, eff_priority);

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
	if (g->subgoals_len == 0 && g->required_time >= 60 * 15)
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

	goal = find_goal_from_request_body(req, goal_id, user->journeys[0]);
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
	}

	Goal  *root           = CalcGoalRoot(goal);
	time_t root_end_before = root ? root->end_date : 0;

	action_time = action_fn(goal, user);
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

	printf("goal/create title=%s extraInfo=%s journeyId=%s\n", title, extra_info, journey_id);

	InitString(&title_s,      strlen(title)      + 1);
	InitString(&extra_info_s, strlen(extra_info) + 1);
	CatString(&title_s,      title,      strlen(title));
	CatString(&extra_info_s, extra_info, strlen(extra_info));

	goal = CreateUserGoal(&title_s, &extra_info_s, journey_id[0] ? journey_id : NULL, start_ds_session, user);

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
	char  orig_goal_id[GOAL_ID_LEN + 1];
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

	Goal *orig = find_goal_from_request_body(req, orig_goal_id, user->journeys[0]);
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

	goal_id_to_cstr(leaf, leaf_id);

	event_len = snprintf(event_body, sizeof(event_body),
		"{\"goal-id\":\"%s\",\"goal_index\":%zu,\"start_date\":%lld,\"end_date\":%lld}",
		leaf_id, leaf->localIndex, (long long)leaf->start_date, (long long)leaf->end_date);
	if (event_len > 0 && (size_t)event_len < sizeof(event_body))
		goal_emit_event(leaf_id, "goal_started", event_body, (size_t)event_len);

	esc_leaf_id  = json_escape_dup(leaf_id);
	response_len = snprintf(response_body, sizeof(response_body),
		"{\"ok\":true,\"goal-id\":\"%s\",\"goal_index\":%zu,\"at\":%lld,\"start_date\":%lld,\"end_date\":%lld}",
		esc_leaf_id, leaf->localIndex,
		(long long)leaf->start_date, (long long)leaf->start_date, (long long)leaf->end_date);
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

void handle_get_schedule(int fd, User *user)
{
	size_t len = 0;
	const struct ScheduleEntry *entries = GetSchedule(&len, user);
	String out;

	InitString(&out, 1024 + len * 256);
	CatTemplateString(&out, "{\"ok\":true,\"count\":%zu,\"entries\":[", len);

	for (size_t i = 0; i < len; i++) {
		Goal *g      = FindGoalFromIndex(entries[i].journey_id, entries[i].goalIndex);
		char *esc_title = json_escape_dup(g ? c_str(&g->title) : "");

		if (i > 0) CatString(&out, FSTRING_SIZE_PARAMS(","));

		CatTemplateString(&out, "{\"time\":%lld,\"goal_index\":%zu,\"title\":\"%s\"}",
			(long long)entries[i].time, entries[i].goalIndex, esc_title);

		free(esc_title);
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));

	http_send_json(fd, 200, "OK", c_str(&out));
	free(out.p);
}
