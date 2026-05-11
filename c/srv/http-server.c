
// mostly AI GENERATED CODE

#include "http-server.h"
#include "graph-export.h"
#include "input/input-processor.h"
#include "util.h"

#include "search/deep-search-session.h"
#include "goal/goal.h"

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

#define SERVER_BACKLOG      10
#define READ_CHUNK_SIZE     4096
#define INITIAL_BUFFER_CAP  8192
#define MAX_REQUEST_SIZE    (16 * 1024 * 1024)
#define MAX_HEADER_SIZE     (256 * 1024)

#define MAX_SSE_CLIENTS     64
#define MAX_STREAM_ID_LEN   63
#define GOAL_ID_LEN         32

#define GRAPH_COPY_PATH     DEFAULT_GRAPH_EXPORT
#define GOALS_COPY_PATH     DEFAULT_GOALS_DIRECTORY

static _Bool started = 0;
static int server_fd = -1;
static pthread_t server_thread;
static pthread_mutex_t server_lock = PTHREAD_MUTEX_INITIALIZER;

/* ========================= EXTERNAL GRAPH API ========================= */

extern _Bool ExportGraphTo(char* path);
extern void LoadGraphFromFile(char* path);
extern void ExportGoalsTo(char* path);
extern void LoadGoalsFromFile(char* path);

/* ========================= HTTP REQUEST ========================= */

typedef struct {
	char method[16];
	char path[256];
	char* body;
	size_t body_len;
} HttpRequest;

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

static char* get_graph_data(void) {
	return SeriliazeGraph();
}

int server_is_running(void) {
	int running;

	pthread_mutex_lock(&server_lock);
	running = started ? 1 : 0;
	pthread_mutex_unlock(&server_lock);

	return running;
}

static int ascii_ncasecmp_n(const char* a, const char* b, size_t n) {
	size_t i;

	for (i = 0; i < n; i++) {
		unsigned char ca = (unsigned char)a[i];
		unsigned char cb = (unsigned char)b[i];

		ca = (unsigned char)tolower(ca);
		cb = (unsigned char)tolower(cb);

		if (ca != cb) return (int)ca - (int)cb;
		if (ca == '\0') return 0;
	}

	return 0;
}

static int send_all(int fd, const void* data, size_t len) {
	const char* p = (const char*)data;
	size_t sent_total = 0;

	while (sent_total < len) {
#ifdef MSG_NOSIGNAL
		ssize_t sent_now = send(fd, p + sent_total, len - sent_total, MSG_NOSIGNAL);
#else
		ssize_t sent_now = send(fd, p + sent_total, len - sent_total, 0);
#endif

		if (sent_now < 0) {
			if (errno == EINTR) continue;
			if (errno == EPIPE || errno == ECONNRESET) return -1;
			return -1;
		}

		if (sent_now == 0) {
			return -1;
		}

		sent_total += (size_t)sent_now;
	}

	return 0;
}

static void send_response(
	int client_fd,
	int status_code,
	const char* status_text,
	const char* content_type,
	const char* body,
	size_t body_len
) {
	char header[1024];
	int header_len;

	header_len = snprintf(
		header,
		sizeof(header),
		"HTTP/1.1 %d %s\r\n"
		"Content-Type: %s\r\n"
		"Content-Length: %zu\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
		"Access-Control-Allow-Headers: Content-Type\r\n"
		"Connection: close\r\n"
		"\r\n",
		status_code,
		status_text,
		content_type,
		body_len
	);

	if (header_len < 0 || (size_t)header_len >= sizeof(header)) return;

	send_all(client_fd, header, (size_t)header_len);

	if (body && body_len > 0) {
		send_all(client_fd, body, body_len);
	}
}

static void send_json_response(
	int client_fd,
	int status_code,
	const char* status_text,
	const char* json_body
) {
	send_response(
		client_fd,
		status_code,
		status_text,
		"application/json",
		json_body,
		strlen(json_body)
	);
}

static void handle_options(int client_fd) {
	static const char* response =
		"HTTP/1.1 204 No Content\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
		"Access-Control-Allow-Headers: Content-Type\r\n"
		"Content-Length: 0\r\n"
		"Connection: close\r\n"
		"\r\n";

	send_all(client_fd, response, strlen(response));
}

static const char* find_header_value(const char* headers, const char* name) {
	size_t name_len = strlen(name);
	const char* p = headers;

	while (*p) {
		const char* line_end = strstr(p, "\r\n");
		if (!line_end) return NULL;

		if ((size_t)(line_end - p) > name_len &&
		    ascii_ncasecmp_n(p, name, name_len) == 0 &&
		    p[name_len] == ':') {

			const char* value = p + name_len + 1;
			while (*value == ' ' || *value == '\t') value++;
			return value;
		}

		p = line_end + 2;
		if (*p == '\r' && *(p + 1) == '\n') break;
	}

	return NULL;
}

static int parse_content_length(const char* headers, size_t* out_len) {
	const char* value = find_header_value(headers, "Content-Length");
	char* endptr = NULL;
	unsigned long long n;

	if (!value) {
		*out_len = 0;
		return 0;
	}

	n = strtoull(value, &endptr, 10);
	if (endptr == value) return -1;

	*out_len = (size_t)n;
	return 0;
}

static int read_into_string(int fd, String* s, size_t max_total) {
	char chunk[READ_CHUNK_SIZE];

	for (;;) {
		ssize_t n = recv(fd, chunk, sizeof(chunk), 0);

		if (n < 0) {
			if (errno == EINTR) continue;
			return -1;
		}

		if (n == 0) {
			return 0;
		}

		if (s->len + (size_t)n > max_total) {
			return -1;
		}

		CatString(s, chunk, (size_t)n);
		return 1;
	}
}

static int read_http_request(int client_fd, HttpRequest* req) {
	String raw;
	size_t header_end_offset = 0;
	size_t content_length = 0;
	char* header_end = NULL;
	char* line_end = NULL;

	memset(req, 0, sizeof(*req));
	InitString(&raw, INITIAL_BUFFER_CAP);

	while (!header_end) {
		int rc;

		if (raw.len > MAX_HEADER_SIZE) {
			FreeString(&raw);
			return -1;
		}

		rc = read_into_string(client_fd, &raw, MAX_REQUEST_SIZE);
		if (rc <= 0) {
			FreeString(&raw);
			return -1;
		}

		header_end = strstr(c_str(&raw), "\r\n\r\n");
	}

	header_end_offset = (size_t)(header_end - c_str(&raw)) + 4;

	line_end = strstr(c_str(&raw), "\r\n");
	if (!line_end) {
		FreeString(&raw);
		return -1;
	}

	*line_end = '\0';

	if (sscanf(c_str(&raw), "%15s %255s", req->method, req->path) != 2) {
		FreeString(&raw);
		return -1;
	}

	*line_end = '\r';

	if (parse_content_length(c_str(&raw), &content_length) != 0) {
		FreeString(&raw);
		return -1;
	}

	if (content_length > MAX_REQUEST_SIZE) {
		FreeString(&raw);
		return -1;
	}

	while (raw.len < header_end_offset + content_length) {
		int rc = read_into_string(client_fd, &raw, MAX_REQUEST_SIZE);
		if (rc <= 0) {
			FreeString(&raw);
			return -1;
		}
	}

	req->body_len = content_length;
	req->body = malloc(content_length + 1);
	cassert(req->body != NULL, "Failed to allocate request body\n");

	if (content_length > 0) {
		memcpy(req->body, c_str(&raw) + header_end_offset, content_length);
	}

	req->body[content_length] = '\0';

	FreeString(&raw);
	return 0;
}

static void free_http_request(HttpRequest* req) {
	if (req->body) {
		free(req->body);
		req->body = NULL;
	}
	req->body_len = 0;
}

/* ========================= PATH / QUERY HELPERS ========================= */

static void split_path_and_query(const char* full_path, char* path_only, size_t path_cap, const char** query_out) {
	const char* q = strchr(full_path, '?');
	size_t path_len;

	if (!q) {
		snprintf(path_only, path_cap, "%s", full_path);
		*query_out = NULL;
		return;
	}

	path_len = (size_t)(q - full_path);
	if (path_len >= path_cap) path_len = path_cap - 1;

	memcpy(path_only, full_path, path_len);
	path_only[path_len] = '\0';
	*query_out = q + 1;
}

static int query_get_param(const char* query, const char* key, char* out, size_t out_cap) {
	size_t key_len;
	const char* p;

	if (!query || !key || !out || out_cap == 0) return 0;

	key_len = strlen(key);
	p = query;

	while (*p) {
		const char* amp = strchr(p, '&');
		const char* end = amp ? amp : p + strlen(p);
		const char* eq = memchr(p, '=', (size_t)(end - p));

		if (eq) {
			size_t cur_key_len = (size_t)(eq - p);
			size_t val_len = (size_t)(end - eq - 1);

			if (cur_key_len == key_len && memcmp(p, key, key_len) == 0) {
				if (val_len >= out_cap) val_len = out_cap - 1;
				memcpy(out, eq + 1, val_len);
				out[val_len] = '\0';
				return 1;
			}
		}

		if (!amp) break;
		p = amp + 1;
	}

	return 0;
}

/* ========================= JSON ESCAPE FOR SSE ========================= */

/*
 * Kept because SSE emits buffers with explicit lengths.
 * For normal goal JSON serialization below, use global json_escape_dup(...).
 */
static char* json_escape_dup_n(const char* src, size_t len) {
	size_t i;
	size_t cap = len * 6 + 1;
	char* out = malloc(cap);
	size_t w = 0;

	cassert(out != NULL, "Failed to allocate escaped json buffer\n");

	for (i = 0; i < len; i++) {
		unsigned char c = (unsigned char)src[i];

		switch (c) {
			case '\"':
				out[w++] = '\\';
				out[w++] = '\"';
				break;
			case '\\':
				out[w++] = '\\';
				out[w++] = '\\';
				break;
			case '\n':
				out[w++] = '\\';
				out[w++] = 'n';
				break;
			case '\r':
				out[w++] = '\\';
				out[w++] = 'r';
				break;
			case '\t':
				out[w++] = '\\';
				out[w++] = 't';
				break;
			default:
				if (c < 0x20) {
					w += (size_t)sprintf(out + w, "\\u%04x", (unsigned)c);
				} else {
					out[w++] = (char)c;
				}
				break;
		}
	}

	out[w] = '\0';
	return out;
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

/* ========================= JSON PARSE HELPERS ========================= */

static const char* json_skip_ws(const char* p) {
	while (*p && isspace((unsigned char)*p)) p++;
	return p;
}

static int json_get_string_field(const char* json, const char* key, char* out, size_t out_cap) {
	char pattern[128];
	const char* p;
	const char* start;
	size_t w = 0;

	if (!json || !key || !out || out_cap == 0) return 0;

	snprintf(pattern, sizeof(pattern), "\"%s\"", key);
	p = strstr(json, pattern);
	if (!p) return 0;

	p += strlen(pattern);
	p = json_skip_ws(p);
	if (*p != ':') return 0;

	p++;
	p = json_skip_ws(p);
	if (*p != '\"') return 0;

	p++;
	start = p;

	while (*p) {
		if (*p == '\\') {
			p++;
			if (*p) p++;
			continue;
		}
		if (*p == '\"') break;
		p++;
	}

	if (*p != '\"') return 0;

	while (start < p && w + 1 < out_cap) {
		if (*start == '\\') {
			start++;
			if (!*start) break;

			switch (*start) {
				case '\"':  out[w++] = '\"'; break;
				case '\\': out[w++] = '\\'; break;
				case '/':  out[w++] = '/'; break;
				case 'b':  out[w++] = '\b'; break;
				case 'f':  out[w++] = '\f'; break;
				case 'n':  out[w++] = '\n'; break;
				case 'r':  out[w++] = '\r'; break;
				case 't':  out[w++] = '\t'; break;
				default:   out[w++] = *start; break;
			}
			start++;
		} else {
			out[w++] = *start++;
		}
	}

	out[w] = '\0';
	return 1;
}

static int json_get_int_field(const char* json, const char* key, int* out_value) {
	char pattern[128];
	const char* p;
	char* endptr = NULL;
	long value;

	if (!json || !key || !out_value) return 0;

	snprintf(pattern, sizeof(pattern), "\"%s\"", key);
	p = strstr(json, pattern);
	if (!p) return 0;

	p += strlen(pattern);
	p = json_skip_ws(p);
	if (*p != ':') return 0;

	p++;
	p = json_skip_ws(p);

	errno = 0;
	value = strtol(p, &endptr, 10);
	if (endptr == p || errno != 0) return 0;

	*out_value = (int)value;
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

static Goal* find_goal_by_id_string(const char* goal_id) {
	size_t goals_len = 0;
	Goal** goals = GetGoalsContainer(&goals_len);

	if (!goal_id || !goals)
		return NULL;

	for (size_t i = 0; i < goals_len; i++) {
		Goal* g = goals[i];
		char cur_id[GOAL_ID_LEN + 1];

		if (!g)
			continue;

		goal_id_to_cstr(g, cur_id);

		if (strcmp(cur_id, goal_id) == 0)
			return g;
	}

	return NULL;
}

static Goal* find_goal_from_request_body(const HttpRequest* req, char out_goal_id[GOAL_ID_LEN + 1]) {
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
	    json_get_int_field(req->body, "globalIndex", &goal_index_int) ||
	    json_get_int_field(req->body, "goal-index", &goal_index_int)) {
		if (goal_index_int <= 0) {
			return NULL;
		}

		goal = ExternalFindGoal((size_t)goal_index_int);
	} else if (
		json_get_string_field(req->body, "goal-id", goal_id, sizeof(goal_id)) ||
		json_get_string_field(req->body, "goalId", goal_id, sizeof(goal_id)) ||
		json_get_string_field(req->body, "id", goal_id, sizeof(goal_id))
	) {
		if (!validate_goal_id_32(goal_id)) {
			return NULL;
		}

		goal = find_goal_by_id_string(goal_id);
	}

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

	change_assert(out, "append_goal_json got NULL output.\n");
	change_assert(g, "append_goal_json got NULL goal.\n");

	goal_id_to_cstr(g, goal_id);

	esc_id = json_escape_dup(goal_id);
	esc_title = json_escape_dup(c_str(&g->title));
	esc_extra_info = json_escape_dup(c_str(&g->extra_info));

	CatTemplateString(
		out,
		"{"
			"\"id\":\"%s\","
			"\"globalIndex\":%zu,"
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
		g->globalIndex,
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
		g->priority
	);

	free(esc_extra_info);
	free(esc_title);
	free(esc_id);
}

static char* serialize_goals_container_json(void) {
	size_t goals_len = 0;
	size_t active_count = 0;
	
	Goal** goals = GetGoalsContainer(&goals_len);

	String out;

	if (!goals && goals_len > 0) {
		char* error = malloc(128);
		cassert(error, "Failed to allocate error json.\n");
		snprintf(error, 128, "{\"ok\":false,\"error\":\"goals_container_null\"}");
		return error;
	}

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

	return out.p;
}

static char* serialize_goal_children_json(Goal* g) {
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
		decomposed_now = DecomposeGoal(g);
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
		g->globalIndex,
		esc_goal_id,
		decomposed_now ? "true" : "false"
	);

	append_goal_json(&out, g);

	CatString(&out, FSTRING_SIZE_PARAMS(",\"children\":["));

	_Bool first_child = 1;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal* child = ExternalFindGoal(g->subgoals[i]);

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
			if (send_all(sse_clients[i].fd, ping, strlen(ping)) != 0) {
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

				if (send_all(sse_clients[i].fd, "data: ", 6) != 0) send_failed = 1;
				if (!send_failed && send_all(sse_clients[i].fd, payload, (size_t)payload_len) != 0) send_failed = 1;
				if (!send_failed && send_all(sse_clients[i].fd, "\n\n", 2) != 0) send_failed = 1;

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

/* ========================= ROUTE HANDLERS ========================= */

static void handle_get_graph(int client_fd) {
	char* graph_json = get_graph_data();

	if (!graph_json) {
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"serialize_graph_failed\"}"
		);
		return;
	}

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		graph_json,
		strlen(graph_json)
	);

	free(graph_json);
}

static void handle_post_graph_export(int client_fd) {
	if (!ExportGraphTo((char*)GRAPH_COPY_PATH)) {
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"graph_export_failed\"}"
		);
		return;
	}

	send_json_response(
		client_fd,
		200,
		"OK",
		"{\"ok\":true,\"path\":\"" GRAPH_COPY_PATH "\"}"
	);
}

static void handle_get_graph_load(int client_fd) {
	if (access(GRAPH_COPY_PATH, R_OK) != 0) {
		if (errno == ENOENT) {
			send_json_response(
				client_fd,
				404,
				"Not Found",
				"{\"ok\":false,\"error\":\"graph_copy_not_found\"}"
			);
			return;
		}

		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"graph_copy_not_readable\"}"
		);
		return;
	}

	LoadGraphFromFile((char*)GRAPH_COPY_PATH);

	send_json_response(
		client_fd,
		200,
		"OK",
		"{\"ok\":true,\"path\":\"" GRAPH_COPY_PATH "\"}"
	);
}

static void handle_get_goal_list(int client_fd) {
	char* goals_json = serialize_goals_container_json();

	if (!goals_json) {
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"goals_container_failed\"}"
		);
		return;
	}

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		goals_json,
		strlen(goals_json)
	);

	free(goals_json);
}

static void handle_post_goal_export(int client_fd) {
	ExportGoalsTo((char*)GOALS_COPY_PATH);

	send_json_response(
		client_fd,
		200,
		"OK",
		"{\"ok\":true,\"path\":\"" GOALS_COPY_PATH "\"}"
	);
}

static void handle_get_goal_load(int client_fd) {
	if (access(GOALS_COPY_PATH, R_OK) != 0) {
		if (errno == ENOENT) {
			send_json_response(
				client_fd,
				404,
				"Not Found",
				"{\"ok\":false,\"error\":\"goals_copy_not_found\"}"
			);
			return;
		}

		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"goals_copy_not_readable\"}"
		);
		return;
	}

	LoadGoalsFromFile((char*)GOALS_COPY_PATH);

	send_json_response(
		client_fd,
		200,
		"OK",
		"{\"ok\":true,\"path\":\"" GOALS_COPY_PATH "\"}"
	);
}

static void handle_post_goal_decompose(int client_fd, const HttpRequest* req) {
	int goal_index_int = 0;
	char goal_id[256];
	Goal* goal = NULL;
	char* result_json = NULL;

	goal_id[0] = '\0';

	if (!req->body) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (json_get_int_field(req->body, "goalIndex", &goal_index_int) ||
	    json_get_int_field(req->body, "globalIndex", &goal_index_int) ||
	    json_get_int_field(req->body, "goal-index", &goal_index_int)) {

		if (goal_index_int <= 0) {
			send_json_response(
				client_fd,
				400,
				"Bad Request",
				"{\"ok\":false,\"error\":\"invalid_goal_index\"}"
			);
			return;
		}

		goal = ExternalFindGoal((size_t)goal_index_int);
	} else if (
		json_get_string_field(req->body, "goal-id", goal_id, sizeof(goal_id)) ||
		json_get_string_field(req->body, "goalId", goal_id, sizeof(goal_id)) ||
		json_get_string_field(req->body, "id", goal_id, sizeof(goal_id))
	) {
		goal = find_goal_by_id_string(goal_id);
	} else {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_goal_identifier\"}"
		);
		return;
	}

	if (!goal) {
		send_json_response(
			client_fd,
			404,
			"Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found\"}"
		);
		return;
	}

	result_json = serialize_goal_children_json(goal);

	if (!result_json) {
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"goal_decompose_failed\"}"
		);
		return;
	}

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		result_json,
		strlen(result_json)
	);

	free(result_json);
}

static void handle_post_goal_status_action(
	int client_fd,
	const HttpRequest* req,
	const char* event_type,
	time_t (*action_fn)(goalIDType),
	const char* date_field_name
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
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	goal = find_goal_from_request_body(req, goal_id);
	if (!goal) {
		send_json_response(
			client_fd,
			404,
			"Not Found",
			"{\"ok\":false,\"error\":\"goal_not_found\"}"
		);
		return;
	}

	action_time = action_fn(goal_id);
	event_len = snprintf(
		event_body,
		sizeof(event_body),
		"{\"goal-id\":\"%s\",\"%s\":%lld,\"start_date\":%lld,\"end_date\":%lld}",
		goal_id,
		date_field_name,
		(long long)action_time,
		(long long)goal->start_date,
		(long long)goal->end_date
	);

	if (event_len > 0 && (size_t)event_len < sizeof(event_body)) {
		goal_emit_event(goal_id, event_type, event_body, (size_t)event_len);
	}

	esc_goal_id = json_escape_dup(goal_id);
	response_len = snprintf(
		response_body,
		sizeof(response_body),
		"{\"ok\":true,\"goal-id\":\"%s\",\"at\":%lld,\"start_date\":%lld,\"end_date\":%lld}",
		esc_goal_id,
		(long long)action_time,
		(long long)goal->start_date,
		(long long)goal->end_date
	);
	free(esc_goal_id);

	if (response_len < 0 || (size_t)response_len >= sizeof(response_body)) {
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		response_body,
		(size_t)response_len
	);
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
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"invalid_goal_id_length\"}"
		);
		return;
	}

	if (send_all(client_fd, header, strlen(header)) != 0) {
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
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		response_body,
		(size_t)response_len
	);
}

static void handle_post_dev_time_advance(int client_fd, const HttpRequest* req) {
	int delta_seconds = 0;
	char response_body[256];
	int response_len;

	if (!req->body) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_int_field(req->body, "seconds", &delta_seconds)) {
		send_json_response(
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
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		response_body,
		(size_t)response_len
	);
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
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		response_body,
		(size_t)response_len
	);
}

static void handle_post_goal_create(int client_fd, const HttpRequest* req) {
	char title[256];
	char extra_info[2048];
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

	if (!req->body) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "title", title, sizeof(title))) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_title\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "extraInfo", extra_info, sizeof(extra_info)) &&
	    !json_get_string_field(req->body, "extrainfo", extra_info, sizeof(extra_info))) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_extra_info\"}"
		);
		return;
	}

	printf("goal/create title=%s extraInfo=%s\n",
	       title,
	       extra_info);

	InitString(&title_s, strlen(title) + 1);
	InitString(&extra_info_s, strlen(extra_info) + 1);

	CatString(&title_s, title, strlen(title));
	CatString(&extra_info_s, extra_info, strlen(extra_info));

	goal = CreateUserGoal(&title_s, &extra_info_s, start_ds_session);

	FreeString(&extra_info_s);
	FreeString(&title_s);

	if (!goal) {
		goal_emit_event(
			NULL,
			"goal_create_failed",
			"goal create failed",
			strlen("goal create failed")
		);

		send_json_response(
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
		send_json_response(
			client_fd,
			500,
			"Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}"
		);
		return;
	}

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		response_body,
		(size_t)response_len
	);
}

static void handle_post_research_start(int client_fd, const HttpRequest* req) {
	char research_id[MAX_STREAM_ID_LEN + 1];
	char task_name[256];
	int min_rounds = 0;
	String out;
	Task task = {0};

	research_id[0] = '\0';
	task_name[0] = '\0';

	if (!req->body) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "id", research_id, sizeof(research_id))) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_id\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "taskName", task_name, sizeof(task_name))) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_task_name\"}"
		);
		return;
	}

	if (!json_get_int_field(req->body, "minRounds", &min_rounds)) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_min_rounds\"}"
		);
		return;
	}

	if (min_rounds < 1) {
		send_json_response(
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

	start_ds_session(&task, research_id, &out);

	send_response(
		client_fd,
		200,
		"OK",
		"application/json",
		c_str(&out),
		out.len
	);

	FreeString(&out);
	FreeString(&task.name);
}

static void handle_post_message(int client_fd, const HttpRequest* req) {
	char input[1024];
	size_t input_size;
	String inputS;

	input[0] = '\0';

	if (!req->body) {
		send_json_response(
			client_fd,
			400,
			"Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}"
		);
		return;
	}

	if (!json_get_string_field(req->body, "input", input, sizeof(input))) {
		send_json_response(
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

	DecomposeInputIntoGraph(&inputS);

	FreeString(&inputS);

	send_json_response(
		client_fd,
		200,
		"OK",
		"{\"ok\":true}"
	);
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

	if (send_all(client_fd, header, strlen(header)) != 0) {
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

static void handle_not_found(int client_fd) {
	send_json_response(
		client_fd,
		404,
		"Not Found",
		"{\"ok\":false,\"error\":\"route_not_found\"}"
	);
}

static void handle_bad_request(int client_fd) {
	send_json_response(
		client_fd,
		400,
		"Bad Request",
		"{\"ok\":false,\"error\":\"bad_request\"}"
	);
}

/* returns 1 if caller should keep socket open */
static int handle_request(int client_fd, const HttpRequest* req) {
	char path_only[256];
	const char* query_unused = NULL;

	split_path_and_query(req->path, path_only, sizeof(path_only), &query_unused);

	if (strcmp(req->method, "OPTIONS") == 0) {
		handle_options(client_fd);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/graph") == 0) {
		handle_get_graph(client_fd);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/graph/export") == 0) {
		handle_post_graph_export(client_fd);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/graph/load") == 0) {
		handle_get_graph_load(client_fd);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/research/start") == 0) {
		handle_post_research_start(client_fd, req);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/research/events") == 0) {
		handle_get_research_events(client_fd, req->path);
		return 1;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/create") == 0) {
		handle_post_goal_create(client_fd, req);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/goal/events") == 0) {
		handle_get_goal_events(client_fd, req->path);
		return 1;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/goal/list") == 0) {
		handle_get_goal_list(client_fd);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/export") == 0) {
		handle_post_goal_export(client_fd);
		return 0;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(path_only, "/goal/load") == 0) {
		handle_get_goal_load(client_fd);
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
		handle_post_goal_status_action(client_fd, req, "goal_started", StartGoal, "start_date");
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/end") == 0) {
		handle_post_goal_status_action(client_fd, req, "goal_ended", EndGoal, "end_date");
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/goal/decompose") == 0) {
		handle_post_goal_decompose(client_fd, req);
		return 0;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(path_only, "/message") == 0) {
		handle_post_message(client_fd, req);
		return 0;
	}

	handle_not_found(client_fd);
	return 0;
}

static void handle_client(int client_fd) {
	HttpRequest req;
	int keep_open = 0;

	if (read_http_request(client_fd, &req) != 0) {
		handle_bad_request(client_fd);
		close(client_fd);
		return;
	}

	keep_open = handle_request(client_fd, &req);
	free_http_request(&req);

	if (!keep_open) {
		close(client_fd);
	}
}

/* ========================= SERVER THREAD ========================= */

static void* server_thread_main(void* arg) {
	(void)arg;

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

		handle_client(client_fd);
		prune_dead_sse_clients();
	}

	return NULL;
}

/* ========================= PUBLIC API ========================= */

void start_server(int port) {
	struct sockaddr_in addr;
	int opt = 1;
	int rc;

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
		perror("bind");
		close(server_fd);
		server_fd = -1;
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Failed binding the server socket\n");
		return;
	}

	if (listen(server_fd, SERVER_BACKLOG) < 0) {
		perror("listen");
		close(server_fd);
		server_fd = -1;
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Failed listening at the server socket\n");
		return;
	}

	started = 1;

	rc = pthread_create(&server_thread, NULL, server_thread_main, NULL);
	if (rc != 0) {
		started = 0;
		close(server_fd);
		server_fd = -1;
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Failed creating server thread\n");
		return;
	}

	pthread_mutex_unlock(&server_lock);

	printf("Server listening on http://127.0.0.1:%d\n", port);
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
