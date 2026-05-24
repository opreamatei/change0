
// mostly AI GENERATED CODE

#include "http-server.h"
#include "http-util.h"
#include "graph-export.h"
#include "input/input-processor.h"
#include "util.h"
#include "profile/user-profile.h"
#include "connections.h"

#include "search/deep-search-session.h"
#include "goal/goal.h"
#include "goal/schedule-system.h"
#include "middleware/middleware.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <pthread.h>
#include <ctype.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define SERVER_BACKLOG  10
#define MAX_SSE_CLIENTS 64
#define MAX_STREAM_ID_LEN   63
#define GOAL_ID_LEN         32

static _Bool started = 0;
static int server_fd = -1;
static int server_port = 0;
static pthread_t server_thread;
static pthread_mutex_t server_lock = PTHREAD_MUTEX_INITIALIZER;

int client_server_port(void)
{
	int p;
	pthread_mutex_lock(&server_lock);
	p = server_port;
	pthread_mutex_unlock(&server_lock);
	return p;
}

/* ========================= EXTERNAL GRAPH API ========================= */

extern void LoadGraphFromFile(char *path, NodeContainer *nc);

/* ========================= SSE CLIENTS ========================= */

typedef struct {
	int fd;
	_Bool alive;
	pthread_mutex_t write_lock;

	/*
	 * Generic stream filter.
	 *
	 * Deep-search clients use research ids here.
	 * Goal clients use goal-id here.
	 */
	char stream_id[MAX_STREAM_ID_LEN + 1];
} ClientConnection;

static ClientConnection sse_clients[MAX_SSE_CLIENTS];
static pthread_mutex_t sse_clients_lock = PTHREAD_MUTEX_INITIALIZER;

/* ========================= INTERNAL HELPERS ========================= */

static char *get_graph_data(User *user) {
	return SeriliazeGraph(&user->nodes);
}

int server_is_running(void) {
	int running;

	pthread_mutex_lock(&server_lock);
	running = started ? 1 : 0;
	pthread_mutex_unlock(&server_lock);

	return running;
}

/* ========================= VALIDATION ========================= */

static int validate_goal_id_32(const char* goal_id) {
	size_t len = goal_id ? strlen(goal_id) : 0;

	if (len != GOAL_ID_LEN) {
		change_assert(
			len == GOAL_ID_LEN,
			"goal-id must be exactly %d chars, got %zu",
			GOAL_ID_LEN,
			len
		);
		return 0;
	}

	return 1;
}

/* ========================= GOAL JSON SERIALIZATION ========================= */

static void goal_id_to_cstr(const Goal* g, char out[GOAL_ID_LEN + 1]) {
	if (!g) {
		out[0] = '\0';
		return;
	}

	memcpy(out, g->id, GOAL_ID_LEN);
	out[GOAL_ID_LEN] = '\0';
}

static Goal* find_goal_by_id_string(const char* goal_id, const char *journey_id) {
	if (!goal_id)
		return NULL;

	size_t goals_len = 0;
	Goal** goals = GetGoalsSorted(&goals_len, journey_id);

	Goal *found = NULL;
	for (size_t i = 0; i < goals_len; i++) {
		Goal* g = goals[i];
		char cur_id[GOAL_ID_LEN + 1];

		if (!g)
			continue;

		goal_id_to_cstr(g, cur_id);

		if (strcmp(cur_id, goal_id) == 0) {
			found = g;
			break;
		}
	}

	free(goals);
	return found;
}

static Goal* find_goal_from_request_body(const HttpRequest* req, char out_goal_id[GOAL_ID_LEN + 1], const char *journey_id) {
	int goal_index_int = 0;
	char goal_id[256];
	Goal* goal = NULL;

	if (out_goal_id) {
		out_goal_id[0] = '\0';
	}

	if (!req || !req->body) {
		return NULL;
	}

	goal_id[0] = '\0';

	if (json_get_int_field(req->body, "goalIndex", &goal_index_int) ||
	    json_get_int_field(req->body, "localIndex", &goal_index_int) ||
	    json_get_int_field(req->body, "goal-index", &goal_index_int)) {
		if (goal_index_int <= 0) {
			return NULL;
		}

		goal = FindGoalFromIndex(journey_id, (size_t)goal_index_int);
	} else if (
		json_get_string_field(req->body, "goal-id", goal_id, sizeof(goal_id)) ||
		json_get_string_field(req->body, "goalId", goal_id, sizeof(goal_id)) ||
		json_get_string_field(req->body, "id", goal_id, sizeof(goal_id))
	) {
		if (!validate_goal_id_32(goal_id)) {
			return NULL;
		}

		goal = find_goal_by_id_string(goal_id, journey_id);
	}

	if (!goal) {
		return NULL;
	}

	if (out_goal_id) {
		goal_id_to_cstr(goal, out_goal_id);
	}

	return goal;
}

static Goal* find_goal_from_request_body_by_id(const HttpRequest* req, char out_goal_id[GOAL_ID_LEN + 1], const char *journey_id) {
	char goal_id[256];
	Goal* goal = NULL;

	if (out_goal_id) {
		out_goal_id[0] = '\0';
	}

	if (!req || !req->body) {
		return NULL;
	}

	goal_id[0] = '\0';

	if (!(json_get_string_field(req->body, "goal-id", goal_id, sizeof(goal_id)) ||
	      json_get_string_field(req->body, "goalId", goal_id, sizeof(goal_id)) ||
	      json_get_string_field(req->body, "id", goal_id, sizeof(goal_id)))) {
		return NULL;
	}

	if (!validate_goal_id_32(goal_id)) {
		return NULL;
	}

	goal = find_goal_by_id_string(goal_id, journey_id);
	if (!goal) {
		return NULL;
	}

	if (out_goal_id) {
		goal_id_to_cstr(goal, out_goal_id);
	}

	return goal;
}

static void append_goal_json(String* out, Goal* g) {
	char goal_id[GOAL_ID_LEN + 1];

	char* esc_id = NULL;
	char* esc_title = NULL;
	char* esc_extra_info = NULL;
	Goal *root = NULL;
	size_t effective_priority = 0;

	change_assert(out, "append_goal_json got NULL output.\n");
	change_assert(g, "append_goal_json got NULL goal.\n");

	goal_id_to_cstr(g, goal_id);

	esc_id = json_escape_dup(goal_id);
	esc_title = json_escape_dup(c_str(&g->title));
	esc_extra_info = json_escape_dup(c_str(&g->extra_info));
	root = CalcGoalRoot(g);
	effective_priority = root ? root->priority : g->priority;

	CatTemplateString(
		out,
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
		esc_id,
		g->localIndex,
		esc_title,
		g->title.len,
		esc_extra_info,
		g->extra_info.len,
		(long long)g->start_date,
		(long long)g->end_date,
		(long long)g->required_time,
		(long long)g->minPauseToNext,
		(long long)g->pauseToNext,
		g->subgoals_len
	);

	for (size_t i = 0; i < g->subgoals_len; i++) {
		if (i > 0) {
			CatString(out, FSTRING_SIZE_PARAMS(","));
		}

		CatTemplateString(out, "%zu", g->subgoals[i]);
	}

	CatTemplateString(
		out,
		"],"
			"\"parent\":%zu,"
			"\"prev\":%zu,"
			"\"next\":%zu,"
			"\"depth\":%zu,"
			"\"retry_depth\":%zu,"
			"\"priority\":%zu"
		"}",
		g->parent,
		g->prev,
		g->next,
		g->depth,
		g->retry_depth,
		effective_priority
	);

	free(esc_extra_info);
	free(esc_title);
	free(esc_id);
}

static char* serialize_goals_container_json(const char *journey_id) {
	size_t goals_len = 0;
	size_t active_count = 0;

	Goal** goals = GetGoalsSorted(&goals_len, journey_id);

	String out;

	for (size_t i = 0; i < goals_len; i++) {
		if (goals[i])
			active_count++;
	}

	InitString(&out, 8192 + active_count * 1024);

	CatTemplateString(
		&out,
		"{\"ok\":true,\"count\":%zu,\"container_len\":%zu,\"goals\":[",
		active_count,
		goals_len
	);

	_Bool first = 1;

	for (size_t i = 0; i < goals_len; i++) {
		Goal* g = goals[i];

		if (!g)
			continue;

		if (!first) {
			CatString(&out, FSTRING_SIZE_PARAMS(","));
		}

		append_goal_json(&out, g);
		first = 0;
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));

	free(goals);
	return out.p;
}

static char* serialize_goal_children_json(Goal* g, User *user) {
	String out;
	char goal_id[GOAL_ID_LEN + 1];
	char* esc_goal_id = NULL;
	_Bool decomposed_now = 0;

	if (!g) {
		char* error = malloc(128);
		cassert(error, "Failed to allocate error json.\n");
		snprintf(error, 128, "{\"ok\":false,\"error\":\"goal_not_found\"}");
		return error;
	}

	if (g->subgoals_len == 0 && g->required_time >= 60 * 15) {
		decomposed_now = DecomposeGoal(g, user);
	}

	goal_id_to_cstr(g, goal_id);
	esc_goal_id = json_escape_dup(goal_id);

	InitString(&out, 4096 + g->subgoals_len * 1024);

	CatTemplateString(
		&out,
		"{"
			"\"ok\":true,"
			"\"goalIndex\":%zu,"
			"\"goalId\":\"%s\","
			"\"decomposedNow\":%s,"
			"\"goal\":",
		g->localIndex,
		esc_goal_id,
		decomposed_now ? "true" : "false"
	);

	append_goal_json(&out, g);

	CatString(&out, FSTRING_SIZE_PARAMS(",\"children\":["));

	_Bool first_child = 1;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal* child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);

		if (!child)
			continue;

		if (!first_child) {
			CatString(&out, FSTRING_SIZE_PARAMS(","));
		}

		append_goal_json(&out, child);
		first_child = 0;
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));

	free(esc_goal_id);

	return out.p;
}

/* ========================= SSE REGISTRY ========================= */

static void init_sse_clients(void) {
	int i;

	pthread_mutex_lock(&sse_clients_lock);
	for (i = 0; i < MAX_SSE_CLIENTS; i++) {
		sse_clients[i].fd = -1;
		sse_clients[i].alive = 0;
		sse_clients[i].stream_id[0] = '\0';
	}
	pthread_mutex_unlock(&sse_clients_lock);
}

static void remove_sse_client_locked(int idx) {
	if (idx < 0 || idx >= MAX_SSE_CLIENTS) return;

	if (sse_clients[idx].alive) {
		shutdown(sse_clients[idx].fd, SHUT_RDWR);
		close(sse_clients[idx].fd);
		sse_clients[idx].fd = -1;
		sse_clients[idx].alive = 0;
		sse_clients[idx].stream_id[0] = '\0';
		pthread_mutex_destroy(&sse_clients[idx].write_lock);
	}
}

static int add_sse_client(int fd, const char* stream_id) {
	int i;

	pthread_mutex_lock(&sse_clients_lock);

	for (i = 0; i < MAX_SSE_CLIENTS; i++) {
		if (!sse_clients[i].alive) {
			sse_clients[i].fd = fd;
			sse_clients[i].alive = 1;
			sse_clients[i].stream_id[0] = '\0';
			if (stream_id) {
				strncpy(sse_clients[i].stream_id, stream_id, MAX_STREAM_ID_LEN);
				sse_clients[i].stream_id[MAX_STREAM_ID_LEN] = '\0';
			}
			pthread_mutex_init(&sse_clients[i].write_lock, NULL);
			pthread_mutex_unlock(&sse_clients_lock);
			return 1;
		}
	}

	pthread_mutex_unlock(&sse_clients_lock);
	return 0;
}

static void prune_dead_sse_clients(void) {
	int i;

	pthread_mutex_lock(&sse_clients_lock);
	for (i = 0; i < MAX_SSE_CLIENTS; i++) {
		if (sse_clients[i].alive) {
			char ping[] = ": ping\n\n";
			pthread_mutex_lock(&sse_clients[i].write_lock);
			if (http_send_all(sse_clients[i].fd, ping, strlen(ping)) != 0) {
				pthread_mutex_unlock(&sse_clients[i].write_lock);
				remove_sse_client_locked(i);
				continue;
			}
			pthread_mutex_unlock(&sse_clients[i].write_lock);
		}
	}
	pthread_mutex_unlock(&sse_clients_lock);
}

/* ========================= SSE EMIT ========================= */

/*
 * General SSE emitter.
 *
 * stream_id is used in two ways:
 *   1. It is serialized into the outgoing JSON as the `id` field.
 *   2. It is used as the optional client filter. Clients connected with
 *      /research/events?id=<stream_id> or /goal/events?goal-id=<stream_id>
 *      only receive matching stream ids.
 *
 * Domain emitters such as ds_emit_event() and goal_emit_event() should stay
 * thin wrappers around this function so all SSE formatting, escaping,
 * filtering, locking, and dead-client cleanup remains centralized.
 */
void server_emit_event(const char* stream_id, const char* type, const char* buffer, size_t buffer_len) {
	char* esc_id = NULL;
	char* esc_type = NULL;
	char* esc_data = NULL;
	size_t payload_cap;
	char* payload;
	int payload_len;
	int i;

	if (!server_is_running()) return;

	if (!stream_id) stream_id = "";
	if (!type) type = "";
	if (!buffer) {
		buffer = "";
		buffer_len = 0;
	}

	esc_id = json_escape_dup_n(stream_id, strlen(stream_id));
	esc_type = json_escape_dup_n(type, strlen(type));
	esc_data = json_escape_dup_n(buffer, buffer_len);

	payload_cap =
		strlen(esc_id) +
		strlen(esc_type) +
		strlen(esc_data) +
		128;

	payload = malloc(payload_cap);
	cassert(payload != NULL, "Failed to allocate SSE payload\n");

	payload_len = snprintf(
		payload,
		payload_cap,
		"{\"id\":\"%s\",\"type\":\"%s\",\"data\":\"%s\"}",
		esc_id,
		esc_type,
		esc_data
	);

	if (payload_len > 0) {
		pthread_mutex_lock(&sse_clients_lock);

		for (i = 0; i < MAX_SSE_CLIENTS; i++) {
			if (sse_clients[i].alive) {
				int send_failed = 0;

				if (sse_clients[i].stream_id[0] != '\0' && strcmp(sse_clients[i].stream_id, stream_id) != 0) {
					continue;
				}

				pthread_mutex_lock(&sse_clients[i].write_lock);

				if (http_send_all(sse_clients[i].fd, "data: ", 6) != 0) send_failed = 1;
				if (!send_failed && http_send_all(sse_clients[i].fd, payload, (size_t)payload_len) != 0) send_failed = 1;
				if (!send_failed && http_send_all(sse_clients[i].fd, "\n\n", 2) != 0) send_failed = 1;

				pthread_mutex_unlock(&sse_clients[i].write_lock);

				if (send_failed) {
					remove_sse_client_locked(i);
				}
			}
		}

		pthread_mutex_unlock(&sse_clients_lock);
	}

	free(payload);
	free(esc_data);
	free(esc_type);
	free(esc_id);
}

void ds_emit_event(const char* id, const char* type, const char* buffer, size_t buffer_len) {
	server_emit_event(id, type, buffer, buffer_len);
}

void goal_emit_event(const char* id, const char* type, const char* buffer, size_t buffer_len) {
	server_emit_event(id, type, buffer, buffer_len);
}

static _Bool middleware_emit_event(const char* id, const char* type, const char* buffer, size_t buffer_len) {
	server_emit_event(id, type, buffer, buffer_len);
	return 1;
}

/* ========================= ROUTE HANDLERS ========================= */

static void handle_get_graph(int client_fd, User *user) {
	char* graph_json = get_graph_data(user);

	if (!graph_json) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"serialize_graph_failed\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", graph_json);

	free(graph_json);
}

static void handle_post_graph_export(int client_fd, User *user) {
	char path[USER_DIRECTORY_SIZE];
	char body[USER_DIRECTORY_SIZE + 32];

	if (!user) {
		http_send_json(client_fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"no_active_user\"}");
		return;
	}

	GetUserGraphExportPath(user, path);

	if (!ExportGraphTo(path, &user->nodes)) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"graph_export_failed\"}"
		);
		return;
	}

	snprintf(body, sizeof(body), "{\"ok\":true,\"path\":\"%s\"}", path);
	http_send_json(client_fd, 200, "OK", body);
}

static void handle_get_graph_load(int client_fd, User *user) {
	char path[USER_DIRECTORY_SIZE];
	char body[USER_DIRECTORY_SIZE + 32];

	if (!user) {
		http_send_json(client_fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"no_active_user\"}");
		return;
	}

	GetUserGraphExportPath(user, path);

	if (access(path, R_OK) != 0) {
		if (errno == ENOENT) {
			http_send_json(
				client_fd,
				404,
				"Not Found",
				"{\"ok\":false,\"error\":\"graph_copy_not_found\"}"
			);
			return;
		}

		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"graph_copy_not_readable\"}"
		);
		return;
	}

	LoadGraphFromFile(path, &user->nodes);

	snprintf(body, sizeof(body), "{\"ok\":true,\"path\":\"%s\"}", path);
	http_send_json(client_fd, 200, "OK", body);
}

static void handle_get_goal_list(int client_fd, User *user) {
	char* goals_json = serialize_goals_container_json(user->journeys[0]);

	if (!goals_json) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"goals_container_failed\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", goals_json);

	free(goals_json);
}

static void handle_post_goal_export(int client_fd, User *user) {
	if (!user) {
		http_send_json(client_fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"no_active_user\"}");
		return;
	}

	SaveUser(user);
	http_send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void handle_get_goal_load(int client_fd, User *user) {
	if (!user) {
		http_send_json(client_fd, 409, "Conflict",
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

	http_send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void handle_post_goal_decompose(int client_fd, const HttpRequest* req, User *user) {
	int goal_index_int = 0;
	char goal_id[256];
	Goal* goal = NULL;
	char* result_json = NULL;

	goal_id[0] = '\0';

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (json_get_int_field(req->body, "goalIndex", &goal_index_int) ||
	    json_get_int_field(req->body, "localIndex", &goal_index_int) ||
	    json_get_int_field(req->body, "goal-index", &goal_index_int)) {

		if (goal_index_int <= 0) {
			http_send_json(
				client_fd,
				400,
				"Bad Request",
				"{\"ok\":false,\"error\":\"invalid_goal_index\"}"
			);
			return;
		}

		goal = FindGoalFromIndex(user->journeys[0], (size_t)goal_index_int);
	} else if (
		json_get_string_field(req->body, "goal-id", goal_id, sizeof(goal_id)) ||
		json_get_string_field(req->body, "goalId", goal_id, sizeof(goal_id)) ||
		json_get_string_field(req->body, "id", goal_id, sizeof(goal_id))
	) {
		goal = find_goal_by_id_string(goal_id, user->journeys[0]);
	} else {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_goal_identifier\"}"
		);
		return;
	}

	if (!goal) {
		http_send_json(
			client_fd,
			404,
			"Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found\"}"
		);
		return;
	}

	if (goal->end_date) {
		http_send_json(
			client_fd,
			409,
			"Conflict",
			"{\"ok\":false,\"error\":\"goal_already_completed\"}"
		);
		return;
	}

	result_json = serialize_goal_children_json(goal, user);

	if (!result_json) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"goal_decompose_failed\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", result_json);

	free(result_json);
}

static void handle_post_goal_status_action(
	int client_fd,
	const HttpRequest* req,
	const char* event_type,
	time_t (*action_fn)(Goal*, User*),
	const char* date_field_name,
	User *user
) {
	char goal_id[GOAL_ID_LEN + 1];
	char event_body[256];
	char response_body[256];
	char* esc_goal_id = NULL;
	int response_len;
	int event_len;
	time_t action_time = 0;
	Goal* goal = NULL;

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	goal = find_goal_from_request_body(req, goal_id, user->journeys[0]);
	if (!goal) {
		http_send_json(
			client_fd,
			404,
			"Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found\"}"
		);
		return;
	}

	if (strcmp(event_type, "goal_ended") == 0) {
		if (!goal->start_date) {
			http_send_json(
				client_fd,
				409,
				"Conflict",
				"{\"ok\":false,\"error\":\"goal_not_started\"}"
			);
			return;
		}

		if (goal->end_date) {
			http_send_json(
				client_fd,
				409,
				"Conflict",
				"{\"ok\":false,\"error\":\"goal_already_completed\"}"
			);
			return;
		}
	}

	Goal *root = CalcGoalRoot(goal);
	time_t root_end_before = root ? root->end_date : 0;

	action_time = action_fn(goal, user);
	SaveUser(user);
	event_len = snprintf(
		event_body,
		sizeof(event_body),
		"{\"goal-id\":\"%s\",\"goal_index\":%zu,\"%s\":%lld,\"start_date\":%lld,\"end_date\":%lld}",
		goal_id,
		goal->localIndex,
		date_field_name,
		(long long)action_time,
		(long long)goal->start_date,
		(long long)goal->end_date
	);

	if (event_len > 0 && (size_t)event_len < sizeof(event_body)) {
		goal_emit_event(goal_id, event_type, event_body, (size_t)event_len);
	}

	if (strcmp(event_type, "goal_ended") == 0 && root && root_end_before == 0 && root->end_date != 0) {
		char tree_body[256];
		char *esc_root_id = json_escape_dup(root->id);
		char *esc_root_title = json_escape_dup(root->title.p ? root->title.p : "");
		int tree_len = snprintf(tree_body, sizeof(tree_body),
			"{\"root_goal_id\":\"%s\",\"title\":\"%s\",\"end_date\":%lld}",
			esc_root_id, esc_root_title, (long long)root->end_date);
		free(esc_root_id);
		free(esc_root_title);
		if (tree_len > 0 && (size_t)tree_len < sizeof(tree_body))
			goal_emit_event(root->id, "goal_tree_completed", tree_body, (size_t)tree_len);
	}

	esc_goal_id = json_escape_dup(goal_id);
	response_len = snprintf(
		response_body,
		sizeof(response_body),
		"{\"ok\":true,\"goal-id\":\"%s\",\"goal_index\":%zu,\"at\":%lld,\"start_date\":%lld,\"end_date\":%lld}",
		esc_goal_id,
		goal->localIndex,
		(long long)action_time,
		(long long)goal->start_date,
		(long long)goal->end_date
	);
	free(esc_goal_id);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", response_body);
}

static void handle_get_goal_events(int client_fd, const char* full_path) {
	char path_only[256];
	const char* query = NULL;
	char goal_id[256];
	static const char* header =
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: text/event-stream\r\n"
		"Cache-Control: no-cache\r\n"
		"Connection: keep-alive\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"\r\n";

	split_path_and_query(full_path, path_only, sizeof(path_only), &query);
	goal_id[0] = '\0';


	if (!query_get_param(query, "goal-id", goal_id, sizeof(goal_id))) {
		query_get_param(query, "id", goal_id, sizeof(goal_id));
	}

	if (goal_id[0] != '\0' && !validate_goal_id_32(goal_id)) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"invalid_goal_id_length\"}"
		);
		return;
	}

	if (http_send_all(client_fd, header, strlen(header)) != 0) {
		close(client_fd);
		return;
	}

	if (!add_sse_client(client_fd, goal_id[0] ? goal_id : NULL)) {
		close(client_fd);
		return;
	}

	if (goal_id[0]) {
		goal_emit_event(goal_id, "sse_connected", "connected", strlen("connected"));
	}
}

static void handle_get_dev_time(int client_fd) {
	char response_body[256];
	int response_len = snprintf(
		response_body,
		sizeof(response_body),
		"{\"ok\":true,\"now\":%lld,\"offset_seconds\":%lld}",
		(long long)change_time_now(),
		(long long)change_time_get_offset_seconds()
	);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", response_body);
}

static void handle_post_dev_time_advance(int client_fd, const HttpRequest* req) {
	int delta_seconds = 0;
	char response_body[256];
	int response_len;

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_int_field(req->body, "seconds", &delta_seconds)) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_seconds\"}"
		);
		return;
	}

	response_len = snprintf(
		response_body,
		sizeof(response_body),
		"{\"ok\":true,\"now\":%lld,\"offset_seconds\":%lld}",
		(long long)change_time_advance_seconds((time_t)delta_seconds),
		(long long)change_time_get_offset_seconds()
	);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", response_body);
}

static void handle_post_dev_time_reset(int client_fd) {
	char response_body[256];
	int response_len;

	change_time_reset();

	response_len = snprintf(
		response_body,
		sizeof(response_body),
		"{\"ok\":true,\"now\":%lld,\"offset_seconds\":%lld}",
		(long long)change_time_now(),
		(long long)change_time_get_offset_seconds()
	);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", response_body);
}

static void handle_post_goal_create(int client_fd, const HttpRequest* req, User *user) {
	char title[256];
	char extra_info[2048];
	char journey_id[64];
	char event_body[256];
	char response_body[256];
	char* esc_goal_id = NULL;
	int event_len;
	int response_len;
	String title_s;
	String extra_info_s;
	Goal* goal = NULL;

	title[0] = '\0';
	extra_info[0] = '\0';
	journey_id[0] = '\0';

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "title", title, sizeof(title))) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_title\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "extraInfo", extra_info, sizeof(extra_info)) &&
	    !json_get_string_field(req->body, "extrainfo", extra_info, sizeof(extra_info))) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_extra_info\"}"
		);
		return;
	}

	json_get_string_field(req->body, "journeyId", journey_id, sizeof(journey_id));

	printf("goal/create title=%s extraInfo=%s journeyId=%s\n",
	       title,
	       extra_info,
	       journey_id);

	InitString(&title_s, strlen(title) + 1);
	InitString(&extra_info_s, strlen(extra_info) + 1);

	CatString(&title_s, title, strlen(title));
	CatString(&extra_info_s, extra_info, strlen(extra_info));

	goal = CreateUserGoal(&title_s, &extra_info_s, journey_id[0] ? journey_id : NULL, start_ds_session, user);

	FreeString(&extra_info_s);
	FreeString(&title_s);

	if (goal)
		SaveUser(user);

	if (!goal) {
		goal_emit_event(
			NULL,
			"goal_create_failed",
			"goal create failed",
			strlen("goal create failed")
		);

		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"goal_create_failed\"}"
		);
		return;
	}

	event_len = snprintf(
		event_body,
		sizeof(event_body),
		"{\"goal-id\":\"%s\"}",
		goal->id
	);

	if (event_len > 0 && (size_t)event_len < sizeof(event_body)) {
		goal_emit_event(
			goal->id,
			"goal_created",
			event_body,
			(size_t)event_len
		);
	}

	esc_goal_id = json_escape_dup(goal->id);
	response_len = snprintf(
		response_body,
		sizeof(response_body),
		"{\"ok\":true,\"goal-id\":\"%s\"}",
		esc_goal_id
	);
	free(esc_goal_id);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", response_body);
}

static void handle_get_profile(int client_fd, User *user)
{
	String derived;
	String response;
	char *esc_name;
	char *esc_derived;
	char *esc_desc;

	InitString(&derived, 2048);
	InitString(&response, 4096);

	SerializeUserProfileDerivedSummary(user, &derived);

	esc_name    = json_escape_dup(user->name.p ? user->name.p : "");
	esc_derived = json_escape_dup(derived.p ? derived.p : "");
	esc_desc    = json_escape_dup(user->description.p ? user->description.p : "");

	CatTemplateString(&response,
		"{\"ok\":true,\"name\":\"%s\",\"user_id\":\"%s\",\"derived\":\"%s\","
		"\"discoverable\":%s,\"description\":\"%s\"}",
		esc_name, user->id, esc_derived,
		user->discoverable ? "true" : "false",
		esc_desc);

	free(esc_name);
	free(esc_derived);
	free(esc_desc);

	http_send_json(client_fd, 200, "OK", response.p);

	FreeString(&response);
	FreeString(&derived);
}

/* ALLOWED_UPDATE_KEYS: profile-derived keys that may be set directly by the
 * user (not AI-only) from the settings UI. */
static _Bool is_user_editable_key(const char *key)
{
	static const char *editable[] = {
		"age", "work_day_start", "daily_work_hours", NULL
	};
	for (int i = 0; editable[i]; i++)
		if (strcmp(key, editable[i]) == 0) return 1;
	return 0;
}

static void handle_post_profile_update(int client_fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char key[64] = {0};
	char value[1024] = {0};

	if (!json_get_string_field(req->body, "key", key, sizeof(key)) || !key[0]) {
		http_send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_key\"}");
		return;
	}

	/* special key: name — update user struct directly */
	if (strcmp(key, "name") == 0) {
		json_get_string_field(req->body, "value", value, sizeof(value));
		if (!value[0]) {
			http_send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"empty_name\"}");
			return;
		}
		EmptyString(&user->name);
		CatString(&user->name, value, strlen(value));
		SaveUser(user);
		http_send_json(client_fd, 200, "OK", "{\"ok\":true}");
		return;
	}

	/* special key: discoverable — toggle connection matching */
	if (strcmp(key, "discoverable") == 0) {
		json_get_string_field(req->body, "value", value, sizeof(value));
		if (strcmp(value, "true") == 0 || strcmp(value, "1") == 0) {
			/* use existing description if not provided */
			char desc[1024] = {0};
			json_get_string_field(req->body, "description", desc, sizeof(desc));
			SetUserDiscoverable(user, desc[0] ? desc : (user->description.p ? user->description.p : ""));
		} else {
			SetUserPrivate(user);
		}
		http_send_json(client_fd, 200, "OK", "{\"ok\":true}");
		return;
	}

	/* special key: description — update match description */
	if (strcmp(key, "description") == 0) {
		json_get_string_field(req->body, "value", value, sizeof(value));
		UpdateUserDescription(user, value);
		http_send_json(client_fd, 200, "OK", "{\"ok\":true}");
		return;
	}

	/* schedule / identity derived fields */
	if (!is_user_editable_key(key)) {
		http_send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"key_not_editable\"}");
		return;
	}

	json_get_string_field(req->body, "value", value, sizeof(value));
	UserProfileSetDerivedField(user, key, value);
	http_send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void handle_post_goal_drop(int client_fd, const HttpRequest *req, User *user)
{
	char goal_id[GOAL_ID_LEN + 1] = {0};
	char event_body[512];

	if (!req->body) {
		http_send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Goal *goal = find_goal_from_request_body_by_id(req, goal_id, user->journeys[0]);
	if (!goal) {
		http_send_json(client_fd, 404, "Not Found", "{\"ok\":false,\"error\":\"goal_not_found\"}");
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

	http_send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void handle_post_goal_repair(int client_fd, const HttpRequest* req, User *user) {
	char goal_id[GOAL_ID_LEN + 1];
	char repair_reason[2048];
	char event_body[1024];
	String reason_s;
	String out;
	Goal* target = NULL;
	Goal* repaired = NULL;

	goal_id[0] = '\0';
	repair_reason[0] = '\0';

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	target = find_goal_from_request_body_by_id(req, goal_id, user->journeys[0]);
	if (!target) {
		http_send_json(
			client_fd,
			404,
			"Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found_or_invalid_id\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "reason", repair_reason, sizeof(repair_reason)) &&
	    !json_get_string_field(req->body, "repairReason", repair_reason, sizeof(repair_reason)) &&
	    !json_get_string_field(req->body, "request", repair_reason, sizeof(repair_reason))) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_repair_reason\"}"
		);
		return;
	}

	if (repair_reason[0] == '\0') {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"empty_repair_reason\"}"
		);
		return;
	}

	printf("goal/repair goalId=%s reason=%s\n", goal_id, repair_reason);

	InitString(&reason_s, strlen(repair_reason) + 1);
	CatString(&reason_s, repair_reason, strlen(repair_reason));

	repaired = RepairGoalBranch(target, &reason_s, start_ds_session, user);

	FreeString(&reason_s);

	if (repaired)
		SaveUser(user);

	if (!repaired) {
		http_send_json(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"goal_repair_failed\"}"
		);
		return;
	}

	int event_len = snprintf(
		event_body,
		sizeof(event_body),
		"{\"goal-id\":\"%s\",\"goal_index\":%zu}",
		repaired->id,
		repaired->localIndex
	);

	if (event_len > 0 && (size_t)event_len < sizeof(event_body)) {
		goal_emit_event(
			repaired->id,
			"goal_repaired",
			event_body,
			(size_t)event_len
		);
	}

	InitString(&out, 2048);
	CatFixed(&out, "{\"ok\":true,\"goal\":");
	append_goal_json(&out, repaired);
	CatFixed(&out, "}");

	http_send_json(client_fd, 200, "OK", out.p);

	FreeString(&out);
}

static void handle_post_research_start(int client_fd, const HttpRequest* req, User *user) {
	char research_id[MAX_STREAM_ID_LEN + 1];
	char task_name[256];
	int min_rounds = 0;
	String out;
	Task task = {0};

	research_id[0] = '\0';
	task_name[0] = '\0';

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "id", research_id, sizeof(research_id))) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_id\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "taskName", task_name, sizeof(task_name))) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_task_name\"}"
		);
		return;
	}

	if (!json_get_int_field(req->body, "minRounds", &min_rounds)) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_min_rounds\"}"
		);
		return;
	}

	if (min_rounds < 1) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"invalid_min_rounds\"}"
		);
		return;
	}

	printf("research/start id=%s taskName=%s minRounds=%d\n",
	       research_id,
	       task_name,
	       min_rounds);

	memset(&task, 0, sizeof(task));

	InitString(&task.name, strlen(task_name) + 1);
	CatString(&task.name, task_name, strlen(task_name));
	task.minDepth = min_rounds;

	InitString(&out, 1024);

	ds_emit_event(research_id, "research_started", "deep search started", strlen("deep search started"));

	start_ds_session(&task, research_id, &out, user);

	http_send_json(client_fd, 200, "OK", c_str(&out));

	FreeString(&out);
	FreeString(&task.name);
}

static void handle_post_message(int client_fd, const HttpRequest* req, User *user) {
	char input[1024];
	size_t input_size;
	String inputS;

	input[0] = '\0';

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "input", input, sizeof(input))) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_input\"}"
		);
		return;
	}

	printf("message input=%s\n", input);

	input_size = strlen(input);

	InitString(&inputS, input_size + 1);
	CatString(&inputS, input, input_size);

	DecomposeInputIntoGraph(&inputS, user);

	FreeString(&inputS);

	SaveUser(user);

	http_send_json(
		client_fd,
		200,
		"OK",
		"{\"ok\":true}"
	);
}

static void scope_session(const User *user, const char *sid, char *out, size_t out_size)
{
	snprintf(out, out_size, "%s:%s", user->id, (sid && sid[0]) ? sid : "default");
}

static void handle_get_chat_sessions(int client_fd, User *user)
{
	char *json = ListChatSessionsJSON(user->id);
	String out;
	InitString(&out, 256);
	CatTemplateString(&out, "{\"ok\":true,\"sessions\":%s}", json ? json : "[]");
	free(json);
	http_send_json(client_fd, 200, "OK", out.p);
	FreeString(&out);
}

static void handle_post_middleware_message(int client_fd, const HttpRequest* req, User *user) {
	char session_id[MAX_STREAM_ID_LEN + 1];
	char input[4096];
	MiddlewareResult result;
	String out;
	char *esc_message = NULL;
	char *esc_type = NULL;
	char *esc_permission_id = NULL;

	session_id[0] = '\0';
	input[0] = '\0';

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	{
		char raw_sid[MAX_STREAM_ID_LEN + 1];
		raw_sid[0] = '\0';
		if (!json_get_string_field(req->body, "sessionId", raw_sid, sizeof(raw_sid)) &&
		    !json_get_string_field(req->body, "session_id", raw_sid, sizeof(raw_sid)) &&
		    !json_get_string_field(req->body, "id", raw_sid, sizeof(raw_sid))) {
		}
		scope_session(user, raw_sid, session_id, sizeof(session_id));
	}

	if (!json_get_string_field(req->body, "input", input, sizeof(input)) &&
	    !json_get_string_field(req->body, "message", input, sizeof(input))) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_input\"}"
		);
		return;
	}

	if (input[0] == '\0') {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"empty_input\"}"
		);
		return;
	}

	printf("middleware/message sessionId=%s input=%s\n", session_id, input);

	result = RunClientMiddleware(session_id, input, start_ds_session, middleware_emit_event, user);

	SaveUser(user);

	esc_message = json_escape_dup(result.assistant_message.p);
	esc_type = json_escape_dup(result.response_type.p);
	esc_permission_id = json_escape_dup(result.permission_id.p);

	InitString(&out, strlen(esc_message) + strlen(esc_type) + strlen(esc_permission_id) + 256);
	CatTemplateString(
		&out,
		"{\"ok\":true,\"sessionId\":\"%s\",\"type\":\"%s\",\"message\":\"%s\",\"permission_id\":\"%s\"}",
		session_id,
		esc_type,
		esc_message,
		esc_permission_id
	);

	http_send_json(client_fd, 200, "OK", out.p);

	free(esc_permission_id);
	free(esc_type);
	free(esc_message);
	FreeString(&out);
	FreeMiddlewareResult(&result);
}

static void handle_post_middleware_permission(int client_fd, const HttpRequest* req, User *user) {
	char permission_id[128];
	int approved_int = 0;
	_Bool ok;

	permission_id[0] = '\0';

	if (!req->body) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "permissionId", permission_id, sizeof(permission_id)) &&
	    !json_get_string_field(req->body, "permission_id", permission_id, sizeof(permission_id)) &&
	    !json_get_string_field(req->body, "id", permission_id, sizeof(permission_id))) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_permission_id\"}"
		);
		return;
	}

	if (!json_get_bool_or_int_field(req->body, "approved", &approved_int)) {
		http_send_json(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_approved\"}"
		);
		return;
	}

	ok = ResolveMiddlewarePermission(permission_id, approved_int != 0, middleware_emit_event, user);
	if (!ok) {
		http_send_json(
			client_fd,
			404,
			"Not Found",
			"{\"ok\":false,\"error\":\"permission_not_found\"}"
		);
		return;
	}

	http_send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void handle_get_research_events(int client_fd, const char* full_path) {
	char path_only[256];
	const char* query = NULL;
	char research_id[MAX_STREAM_ID_LEN + 1];
	static const char* header =
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: text/event-stream\r\n"
		"Cache-Control: no-cache\r\n"
		"Connection: keep-alive\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"\r\n";

	split_path_and_query(full_path, path_only, sizeof(path_only), &query);
	research_id[0] = '\0';

	query_get_param(query, "id", research_id, sizeof(research_id));

	if (http_send_all(client_fd, header, strlen(header)) != 0) {
		close(client_fd);
		return;
	}

	if (!add_sse_client(client_fd, research_id[0] ? research_id : NULL)) {
		close(client_fd);
		return;
	}

	if (research_id[0]) {
		ds_emit_event(research_id, "sse_connected", "connected", strlen("connected"));
	}
}

static void handle_get_middleware_events(int client_fd, const char* full_path, User *user) {
	char path_only[256];
	const char* query = NULL;
	char session_id[MAX_STREAM_ID_LEN + 1];
	static const char* header =
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: text/event-stream\r\n"
		"Cache-Control: no-cache\r\n"
		"Connection: keep-alive\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"\r\n";

	char raw_sid[MAX_STREAM_ID_LEN + 1];
	split_path_and_query(full_path, path_only, sizeof(path_only), &query);
	raw_sid[0] = '\0';

	if (!query_get_param(query, "sessionId", raw_sid, sizeof(raw_sid)) &&
	    !query_get_param(query, "session_id", raw_sid, sizeof(raw_sid))) {
		query_get_param(query, "id", raw_sid, sizeof(raw_sid));
	}

	scope_session(user, raw_sid, session_id, sizeof(session_id));

	if (http_send_all(client_fd, header, strlen(header)) != 0) {
		close(client_fd);
		return;
	}

	if (!add_sse_client(client_fd, session_id)) {
		close(client_fd);
		return;
	}

	middleware_emit_event(session_id, "sse_connected", "connected", strlen("connected"));
}

static void handle_get_session_goals(int client_fd, User *user) {
	size_t len = 0;
	Goal **session = GetSessionGoals(&len, user);
	String out;

	InitString(&out, 512 + len * 512);
	CatTemplateString(&out, "{\"ok\":true,\"count\":%zu,\"goals\":[", len);

	for (size_t i = 0; i < len; i++) {
		if (i > 0) CatString(&out, FSTRING_SIZE_PARAMS(","));
		append_goal_json(&out, session[i]);
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));

	if (session) free(session);

	http_send_json(client_fd, 200, "OK", c_str(&out));
	free(out.p);
}

static void handle_get_schedule(int client_fd, User *user) {
	size_t len = 0;
	const struct ScheduleEntry* entries = GetSchedule(&len, user);
	String out;

	InitString(&out, 1024 + len * 256);
	CatTemplateString(&out, "{\"ok\":true,\"count\":%zu,\"entries\":[", len);

	for (size_t i = 0; i < len; i++) {
		Goal* g = FindGoalFromIndex(entries[i].journey_id, entries[i].goalIndex);
		char* esc_title = json_escape_dup(g ? c_str(&g->title) : "");

		if (i > 0) CatString(&out, FSTRING_SIZE_PARAMS(","));

		CatTemplateString(
			&out,
			"{\"time\":%lld,\"goal_index\":%zu,\"title\":\"%s\"}",
			(long long)entries[i].time,
			entries[i].goalIndex,
			esc_title
		);

		free(esc_title);
	}

	CatString(&out, FSTRING_SIZE_PARAMS("]}"));

	http_send_json(client_fd, 200, "OK", c_str(&out));
	free(out.p);
}

static void handle_get_middleware_session(int client_fd, const char* full_path, User *user) {
	char path_only[256];
	const char *query = NULL;
	char raw_sid[MAX_STREAM_ID_LEN + 1];
	char session_id[MAX_STREAM_ID_LEN + 1];
	char *result_json = NULL;

	split_path_and_query(full_path, path_only, sizeof(path_only), &query);
	raw_sid[0] = '\0';

	if (!query_get_param(query, "sessionId", raw_sid, sizeof(raw_sid)) &&
	    !query_get_param(query, "session_id", raw_sid, sizeof(raw_sid))) {
		query_get_param(query, "id", raw_sid, sizeof(raw_sid));
	}

	scope_session(user, raw_sid, session_id, sizeof(session_id));

	result_json = ExportMiddlewareSessionJSON(session_id);
	if (!result_json) {
		http_send_json(client_fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"session_export_failed\"}");
		return;
	}

	http_send_json(client_fd, 200, "OK", result_json);
	free(result_json);
}

static void handle_not_found(int client_fd) {
	http_send_json(
		client_fd,
		404,
		"Not Found",
		"{\"ok\":false,\"error\":\"route_not_found\"}"
	);
}

static void handle_bad_request(int client_fd) {
	http_send_json(
		client_fd,
		400,
		"Bad Request",
		"{\"ok\":false,\"error\":\"bad_request\"}"
	);
}

/* returns 1 if caller should keep socket open */
static int handle_request(int client_fd, const HttpRequest* req, User *user) {
	char path_only[256];
	const char* query_unused = NULL;

	split_path_and_query(req->path, path_only, sizeof(path_only), &query_unused);

	if (strcmp(req->method, "OPTIONS") == 0) {
		handle_options(client_fd);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/graph") == 0) {
		handle_get_graph(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/graph/export") == 0) {
		handle_post_graph_export(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/graph/load") == 0) {
		handle_get_graph_load(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/research/start") == 0) {
		handle_post_research_start(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/research/events") == 0) {
		handle_get_research_events(client_fd, req->path);
		return 1;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/middleware/message") == 0) {
		handle_post_middleware_message(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/middleware/permission") == 0) {
		handle_post_middleware_permission(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/middleware/events") == 0) {
		handle_get_middleware_events(client_fd, req->path, user);
		return 1;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/middleware/session") == 0) {
		handle_get_middleware_session(client_fd, req->path, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/chat/sessions") == 0) {
		handle_get_chat_sessions(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/create") == 0) {
		handle_post_goal_create(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/repair") == 0) {
		handle_post_goal_repair(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/drop") == 0) {
		handle_post_goal_drop(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/profile") == 0) {
		handle_get_profile(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/profile/update") == 0) {
		handle_post_profile_update(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/goal/events") == 0) {
		handle_get_goal_events(client_fd, req->path);
		return 1;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/goal/list") == 0) {
		handle_get_goal_list(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/goal/session") == 0) {
		handle_get_session_goals(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/export") == 0) {
		handle_post_goal_export(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/goal/load") == 0) {
		handle_get_goal_load(client_fd, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/dev/time") == 0) {
		handle_get_dev_time(client_fd);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/dev/time/advance") == 0) {
		handle_post_dev_time_advance(client_fd, req);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/dev/time/reset") == 0) {
		handle_post_dev_time_reset(client_fd);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/start") == 0) {
		char orig_goal_id[GOAL_ID_LEN + 1];
		char leaf_id[GOAL_ID_LEN + 1];
		char event_body[256];
		char response_body[256];
		char* esc_leaf_id;
		int event_len, response_len;

		if (!req->body) {
			http_send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
			return 0;
		}

		Goal* orig = find_goal_from_request_body(req, orig_goal_id, user->journeys[0]);
		if (!orig) {
			http_send_json(client_fd, 404, "Not Found", "{\"ok\":false,\"error\":\"goal_not_found\"}");
			return 0;
		}

		Goal* leaf = StartGoalDeepFromGoal(orig, user);
		if (!leaf) {
			http_send_json(client_fd, 409, "Conflict", "{\"ok\":false,\"error\":\"goal_not_startable\"}");
			return 0;
		}

		goal_id_to_cstr(leaf, leaf_id);

		event_len = snprintf(event_body, sizeof(event_body),
			"{\"goal-id\":\"%s\",\"goal_index\":%zu,\"start_date\":%lld,\"end_date\":%lld}",
			leaf_id, leaf->localIndex, (long long)leaf->start_date, (long long)leaf->end_date);
		if (event_len > 0 && (size_t)event_len < sizeof(event_body))
			goal_emit_event(leaf_id, "goal_started", event_body, (size_t)event_len);

		esc_leaf_id = json_escape_dup(leaf_id);
		response_len = snprintf(response_body, sizeof(response_body),
			"{\"ok\":true,\"goal-id\":\"%s\",\"goal_index\":%zu,\"at\":%lld,\"start_date\":%lld,\"end_date\":%lld}",
			esc_leaf_id, leaf->localIndex, (long long)leaf->start_date, (long long)leaf->start_date, (long long)leaf->end_date);
		free(esc_leaf_id);

		if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
			http_send_json(client_fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"response_too_large\"}");
			return 0;
		}

		SaveUser(user);
		http_send_json(client_fd, 200, "OK", response_body);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/end") == 0) {
		handle_post_goal_status_action(client_fd, req, "goal_ended", EndGoalFromGoal, "end_date", user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/decompose") == 0) {
		handle_post_goal_decompose(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/message") == 0) {
		handle_post_message(client_fd, req, user);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/schedule") == 0) {
		handle_get_schedule(client_fd, user);
		return 0;
	}

	handle_not_found(client_fd);
	return 0;
}

static void handle_client(int client_fd, User *user) {
	HttpRequest req;
	int keep_open = 0;

	if (read_http_request(client_fd, &req) != 0) {
		handle_bad_request(client_fd);
		close(client_fd);
		return;
	}

	keep_open = handle_request(client_fd, &req, user);
	free_http_request(&req);

	if (!keep_open) {
		close(client_fd);
	}
}

/* ========================= SERVER THREAD ========================= */

static void* server_thread_main(void* arg) {
	User *user = (User *)arg;

	while (1) {
		struct sockaddr_in client_addr;
		socklen_t client_len = sizeof(client_addr);
		int client_fd;

		pthread_mutex_lock(&server_lock);
		if (!started || server_fd < 0) {
			pthread_mutex_unlock(&server_lock);
			break;
		}
		pthread_mutex_unlock(&server_lock);

		client_fd = accept(server_fd, (struct sockaddr*)&client_addr, &client_len);

		if (client_fd < 0) {
			pthread_mutex_lock(&server_lock);
			if (!started) {
				pthread_mutex_unlock(&server_lock);
				break;
			}
			pthread_mutex_unlock(&server_lock);

			if (errno == EINTR) continue;

			perror("accept");
			continue;
		}

		handle_client(client_fd, user);
		prune_dead_sse_clients();
	}

	return NULL;
}

/* ========================= PUBLIC API ========================= */

void start_server(int port, User *user) {
	struct sockaddr_in addr;
	socklen_t addr_len = sizeof(addr);
	int opt = 1;
	int rc;
	int bound_port = 0;

	/*
	 * Critical for SSE:
	 * browsers routinely close/reconnect EventSource sockets.
	 * Without this, send() to a closed socket can terminate the process.
	 */
	signal(SIGPIPE, SIG_IGN);

	pthread_mutex_lock(&server_lock);

	if (started) {
		pthread_mutex_unlock(&server_lock);
		stop_server();
		pthread_mutex_lock(&server_lock);
	}

	init_sse_clients();

	server_fd = socket(AF_INET, SOCK_STREAM, 0);
	if (server_fd < 0) {
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Server can't generate socket.\n");
		return;
	}

	if (setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
		perror("setsockopt");
		close(server_fd);
		server_fd = -1;
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Can't set sockopt\n");
		return;
	}

	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((unsigned short)port);
	addr.sin_addr.s_addr = inet_addr("127.0.0.1");

	if (bind(server_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
		if (port != 0) {
			/* Fixed port busy — fall back to ephemeral. */
			addr.sin_port = 0;
			if (bind(server_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
				perror("bind");
				close(server_fd);
				server_fd = -1;
				pthread_mutex_unlock(&server_lock);
				cassert(0, "Failed binding the server socket\n");
				return;
			}
		} else {
			perror("bind");
			close(server_fd);
			server_fd = -1;
			pthread_mutex_unlock(&server_lock);
			cassert(0, "Failed binding the server socket\n");
			return;
		}
	}

	/* Resolve actual bound port (covers both fixed and ephemeral cases). */
	if (getsockname(server_fd, (struct sockaddr*)&addr, &addr_len) == 0)
		bound_port = ntohs(addr.sin_port);
	else
		bound_port = port;

	server_port = bound_port;

	if (listen(server_fd, SERVER_BACKLOG) < 0) {
		perror("listen");
		close(server_fd);
		server_fd = -1;
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Failed listening at the server socket\n");
		return;
	}

	started = 1;

	rc = pthread_create(&server_thread, NULL, server_thread_main, user);
	if (rc != 0) {
		started = 0;
		close(server_fd);
		server_fd = -1;
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Failed creating server thread\n");
		return;
	}

	pthread_mutex_unlock(&server_lock);

	printf("Client server (user=%s) listening on http://127.0.0.1:%d\n",
		user && user->name.p ? user->name.p : "?", bound_port);
}

void stop_server(void) {
	int local_fd = -1;
	_Bool need_join = 0;
	int i;

	pthread_mutex_lock(&server_lock);

	if (!started) {
		pthread_mutex_unlock(&server_lock);
		return;
	}

	started = 0;
	local_fd = server_fd;
	server_fd = -1;
	server_port = 0;
	need_join = 1;

	pthread_mutex_unlock(&server_lock);

	if (local_fd >= 0) {
		shutdown(local_fd, SHUT_RDWR);
		close(local_fd);
	}

	if (need_join) {
		pthread_join(server_thread, NULL);
	}

	pthread_mutex_lock(&sse_clients_lock);
	for (i = 0; i < MAX_SSE_CLIENTS; i++) {
		if (sse_clients[i].alive) {
			remove_sse_client_locked(i);
		}
	}
	pthread_mutex_unlock(&sse_clients_lock);
}
