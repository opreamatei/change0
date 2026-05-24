#define _GNU_SOURCE
#include "central-server.h"
#include "http-server.h"
#include "user-management.h"
#include "connections.h"
#include "journey.h"
#include "util.h"
#include "json.h"
#include "config.h"
#include "globals.h"
#include "ne/goal/goal.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <dirent.h>
#include <unistd.h>
#include <pthread.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CENTRAL_BACKLOG     4
#define CENTRAL_READ_CHUNK  4096
#define CENTRAL_MAX_BODY    (16 * 1024)

static _Bool central_started = 0;
static int central_fd = -1;
static pthread_t central_thread;
static pthread_mutex_t central_lock = PTHREAD_MUTEX_INITIALIZER;

typedef struct {
	char method[8];
	char path[128];
	char *body;
	size_t body_len;
} CentralRequest;

static int send_all(int fd, const void *data, size_t len)
{
	const char *p = data;
	size_t sent_total = 0;

	while (sent_total < len) {
#ifdef MSG_NOSIGNAL
		ssize_t n = send(fd, p + sent_total, len - sent_total, MSG_NOSIGNAL);
#else
		ssize_t n = send(fd, p + sent_total, len - sent_total, 0);
#endif
		if (n <= 0) {
			if (n < 0 && errno == EINTR) continue;
			return -1;
		}
		sent_total += (size_t)n;
	}
	return 0;
}

static void send_json(int fd, int status, const char *reason, const char *body)
{
	char header[256];
	size_t body_len = body ? strlen(body) : 0;
	int n;

	n = snprintf(header, sizeof(header),
		"HTTP/1.1 %d %s\r\n"
		"Content-Type: application/json\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
		"Access-Control-Allow-Headers: Content-Type\r\n"
		"Content-Length: %zu\r\n"
		"Connection: close\r\n"
		"\r\n",
		status, reason, body_len);

	if (n > 0)
		send_all(fd, header, (size_t)n);
	if (body && body_len)
		send_all(fd, body, body_len);
}

static int read_request(int fd, CentralRequest *req)
{
	char buf[CENTRAL_MAX_BODY + 1];
	size_t total = 0;
	ssize_t r;
	char *header_end;
	size_t header_len;
	char first_line[256];
	const char *nl;
	const char *cl;
	size_t content_length = 0;

	memset(req, 0, sizeof(*req));

	while (total < sizeof(buf) - 1) {
		r = recv(fd, buf + total, sizeof(buf) - 1 - total, 0);
		if (r <= 0) {
			if (r < 0 && errno == EINTR) continue;
			break;
		}
		total += (size_t)r;
		buf[total] = '\0';

		if (strstr(buf, "\r\n\r\n"))
			break;
	}

	if (total == 0)
		return -1;
	buf[total] = '\0';

	header_end = strstr(buf, "\r\n\r\n");
	if (!header_end)
		return -1;
	header_len = (size_t)(header_end - buf) + 4;

	nl = strstr(buf, "\r\n");
	if (!nl || (size_t)(nl - buf) >= sizeof(first_line))
		return -1;
	memcpy(first_line, buf, (size_t)(nl - buf));
	first_line[nl - buf] = '\0';

	if (sscanf(first_line, "%7s %127s", req->method, req->path) != 2)
		return -1;

	cl = strcasestr(buf, "Content-Length:");
	if (cl) {
		cl += strlen("Content-Length:");
		while (*cl == ' ' || *cl == '\t') cl++;
		content_length = (size_t)strtoul(cl, NULL, 10);
	}

	if (content_length > 0 && content_length < sizeof(buf) - header_len) {
		size_t already = total - header_len;
		while (already < content_length) {
			r = recv(fd, buf + total, content_length - already, 0);
			if (r <= 0) break;
			total += (size_t)r;
			already += (size_t)r;
		}
		req->body_len = content_length;
		req->body = malloc(content_length + 1);
		if (req->body) {
			memcpy(req->body, buf + header_len, content_length);
			req->body[content_length] = '\0';
		}
	}

	return 0;
}

static void free_request(CentralRequest *req)
{
	if (req->body) free(req->body);
	req->body = NULL;
	req->body_len = 0;
}

#define SHARED_JOURNEYS_DIR PROJECT_ROOT "shared-journeys/"

static Journey SharedJourneyTable[MAX_JOURNEYS];
static size_t  SharedJourneyCount = 0;

static void ensure_directory(const char *path) {
	if (mkdir(path, 0755) != 0 && errno != EEXIST)
		change_assert(0, "Could not create shared-journeys directory.\n");
}

static void load_directory_journeys(const char *dir, Journey *table, size_t *count, size_t max) {
	DIR *d = opendir(dir);
	if (!d) return;

	struct dirent *e;
	while ((e = readdir(d)) != NULL && *count < max) {
		size_t nlen = strlen(e->d_name);
		if (nlen < 6 || strcmp(e->d_name + nlen - 5, ".json") != 0)
			continue;

		char path[512];
		snprintf(path, sizeof(path), "%s%s", dir, e->d_name);

		Journey *j = &table[(*count)++];
		memset(j, 0, sizeof(*j));
		InitString(&j->title, 64);
		InitString(&j->extra_info, 256);
		LoadJourneyFromFile(j, path);
	}

	closedir(d);
}

static char *extract_string_field(const char *body, size_t body_len, const char *key);

static void free_shared_journeys(void) {
	for (size_t i = 0; i < SharedJourneyCount; i++) {
		Journey *j = &SharedJourneyTable[i];
		FreeString(&j->title);
		FreeString(&j->extra_info);
		for (size_t k = 0; k < j->goals_count; k++) {
			Goal *g = j->goals[k];
			if (!g) continue;
			if (g->title.p) FreeString(&g->title);
			if (g->extra_info.p) FreeString(&g->extra_info);
			free(g->subgoals);
			free(g);
		}
	}
	SharedJourneyCount = 0;
}

static Journey *find_shared_journey(const char *id) {
	for (size_t i = 0; i < SharedJourneyCount; i++)
		if (strcmp(SharedJourneyTable[i].id, id) == 0)
			return &SharedJourneyTable[i];
	return NULL;
}

static void persist_shared_journey(const Journey *j) {
	char path[512];
	snprintf(path, sizeof(path), SHARED_JOURNEYS_DIR "%s.json", j->id);
	ExportJourneyTo(j, path);
}

static void handle_get_journey(int client_fd, const char *journey_id) {
	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		send_json(client_fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}

	String out; InitString(&out, 1);
	SerializeJourney(j, &out);
	send_json(client_fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

static void handle_create_journey(int client_fd, CentralRequest *req) {
	if (SharedJourneyCount >= MAX_JOURNEYS) {
		send_json(client_fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"journey_table_full\"}");
		return;
	}

	char *name = extract_string_field(req->body, req->body_len, "name");
	if (!name || !*name) {
		free(name);
		send_json(client_fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_name\"}");
		return;
	}

	Journey *j = &SharedJourneyTable[SharedJourneyCount++];
	memset(j, 0, sizeof(*j));
	InitString(&j->title, strlen(name) + 1);
	CatString(&j->title, name, strlen(name));
	InitString(&j->extra_info, 256);
	CatFixed(&j->extra_info, DEFAULT_JOURNEY_EXTRA_INFO);
	random_id(j->id, JOURNEY_ID_SIZE);
	free(name);

	persist_shared_journey(j);

	String out; InitString(&out, 128);
	char *esc_title = json_escape_dup(j->title.p);
	CatTemplateString(&out, "{\"ok\":true,\"id\":\"%s\",\"title\":\"%s\"}", j->id, esc_title);
	send_json(client_fd, 200, "OK", c_str(&out));
	FreeString(&out);
	free(esc_title);
}

static void handle_update_journey(int client_fd, const char *journey_id, CentralRequest *req) {
	if (!req->body || req->body_len == 0) {
		send_json(client_fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		send_json(client_fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}

	LoadJourneyFromBuffer(j, req->body, req->body_len);
	persist_shared_journey(j);

	send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void write_user_array(String *out)
{
	CatFixed(out, "{\"ok\":true,\"users\":[");
	for (size_t i = 0; i < USER_COUNT; i++) {
		User *u = &USER_TABLE[i];
		char *esc_name = json_escape_dup(u->name.p ? u->name.p : "");
		CatTemplateString(out,
			"%s{\"id\":\"%s\",\"name\":\"%s\"}",
			i == 0 ? "" : ",",
			u->id, esc_name);
		free(esc_name);
	}
	CatFixed(out, "]}");
}

static void handle_list_users(int client_fd)
{
	String out;
	InitString(&out, 256);
	write_user_array(&out);
	send_json(client_fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

static char *extract_string_field(const char *body, size_t body_len, const char *key)
{
	json_value *root;
	json_value *val;
	char *result = NULL;

	if (!body || body_len == 0)
		return NULL;

	root = json_parse(body, body_len);
	if (!root || root->type != json_object) {
		if (root) json_value_free(root);
		return NULL;
	}

	val = json_object_get(root, key);
	if (val && val->type == json_string) {
		result = malloc(val->u.string.length + 1);
		if (result) {
			memcpy(result, val->u.string.ptr, val->u.string.length);
			result[val->u.string.length] = '\0';
		}
	}

	json_value_free(root);
	return result;
}

static void handle_create_user(int client_fd, CentralRequest *req)
{
	char *name;
	String name_str;
	User *u;

	name = extract_string_field(req->body, req->body_len, "name");
	if (!name || !*name) {
		free(name);
		send_json(client_fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_name\"}");
		return;
	}

	InitString(&name_str, strlen(name) + 1);
	CatString(&name_str, name, strlen(name));

	u = NewUser(&name_str);

	FreeString(&name_str);
	free(name);

	{
		String out;
		char *esc_name = json_escape_dup(u->name.p ? u->name.p : "");
		InitString(&out, 256);
		CatTemplateString(&out,
			"{\"ok\":true,\"id\":\"%s\",\"name\":\"%s\"}",
			u->id, esc_name);
		send_json(client_fd, 200, "OK", c_str(&out));
		FreeString(&out);
		free(esc_name);
	}
}

static void handle_select_user(int client_fd, CentralRequest *req)
{
	char *id;
	User *u;

	id = extract_string_field(req->body, req->body_len, "id");
	if (!id || !*id) {
		free(id);
		send_json(client_fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

	u = FindUserByID(id);
	free(id);

	if (!u) {
		send_json(client_fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"user_not_found\"}");
		return;
	}

	/* Restart client server bound to the freshly selected user. */
	stop_server();
	start_server(u->port, u);

	{
		String out;
		char *esc_name = json_escape_dup(u->name.p ? u->name.p : "");
		InitString(&out, 256);
		CatTemplateString(&out,
			"{\"ok\":true,\"id\":\"%s\",\"name\":\"%s\",\"port\":%d}",
			u->id, esc_name, client_server_port());
		send_json(client_fd, 200, "OK", c_str(&out));
		FreeString(&out);
		free(esc_name);
	}
}

/* -------- connection handlers -------- */

static void handle_conn_discoverable(int client_fd, CentralRequest *req)
{
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	char *desc    = extract_string_field(req->body, req->body_len, "description");
	if (!user_id || !*user_id) {
		free(user_id); free(desc);
		send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}
	User *u = FindUserByID(user_id);
	free(user_id);
	if (!u) {
		free(desc);
		send_json(client_fd, 404, "Not Found", "{\"ok\":false,\"error\":\"user_not_found\"}");
		return;
	}
	SetUserDiscoverable(u, desc ? desc : "");
	free(desc);
	send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void handle_conn_private(int client_fd, CentralRequest *req)
{
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	if (!user_id || !*user_id) {
		free(user_id);
		send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}
	User *u = FindUserByID(user_id);
	free(user_id);
	if (!u) {
		send_json(client_fd, 404, "Not Found", "{\"ok\":false,\"error\":\"user_not_found\"}");
		return;
	}
	SetUserPrivate(u);
	send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void handle_conn_update_description(int client_fd, CentralRequest *req)
{
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	char *desc    = extract_string_field(req->body, req->body_len, "description");
	if (!user_id || !*user_id) {
		free(user_id); free(desc);
		send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}
	User *u = FindUserByID(user_id);
	free(user_id);
	if (!u) {
		free(desc);
		send_json(client_fd, 404, "Not Found", "{\"ok\":false,\"error\":\"user_not_found\"}");
		return;
	}
	UpdateUserDescription(u, desc ? desc : "");
	free(desc);
	send_json(client_fd, 200, "OK", "{\"ok\":true}");
}

static void handle_conn_list(int client_fd, const char *query)
{
	/* query is everything after '?' in the path, e.g. "user_id=abc123" */
	char user_id[USER_ID_SIZE] = {0};
	if (query) {
		const char *p = strstr(query, "user_id=");
		if (p) {
			p += 8;
			size_t i = 0;
			while (*p && *p != '&' && i < USER_ID_SIZE - 1)
				user_id[i++] = *p++;
			user_id[i] = '\0';
		}
	}
	if (!user_id[0]) {
		send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}

	UserConn *conns[MAX_CONNECTIONS];
	size_t n = ListConnsForUser(user_id, conns, MAX_CONNECTIONS);

	String out; InitString(&out, 512);
	CatFixed(&out, "{\"ok\":true,\"connections\":[");
	for (size_t i = 0; i < n; i++) {
		UserConn *c = conns[i];
		User *other = OtherUserInConn(c, user_id);
		char *other_name = other ? json_escape_dup(other->name.p ? other->name.p : "") : NULL;
		char *reason_esc = json_escape_dup(c->reason);
		/* tell client which slot they are so they know which flag is theirs */
		int am_a = strcmp(c->a, user_id) == 0;
		CatTemplateString(&out,
			"%s{\"id\":\"%s\",\"state\":%d,"
			"\"my_approved\":%s,\"their_approved\":%s,"
			"\"other_name\":\"%s\",\"reason\":\"%s\","
			"\"proposed_at\":%lld}",
			i == 0 ? "" : ",",
			c->id, (int)c->state,
			(am_a ? c->a_approved : c->b_approved) ? "true" : "false",
			(am_a ? c->b_approved : c->a_approved) ? "true" : "false",
			other_name ? other_name : "unknown",
			reason_esc,
			(long long)c->proposed_at);
		free(reason_esc);
		free(other_name);
	}
	CatFixed(&out, "]}");
	send_json(client_fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

static void handle_conn_approve(int client_fd, CentralRequest *req)
{
	char *conn_id = extract_string_field(req->body, req->body_len, "connection_id");
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	if (!conn_id || !user_id) {
		free(conn_id); free(user_id);
		send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}
	_Bool ok = ApproveConn(conn_id, user_id);
	free(conn_id); free(user_id);
	send_json(client_fd, 200, "OK", ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"approve_failed\"}");
}

static void handle_conn_decline(int client_fd, CentralRequest *req)
{
	char *conn_id = extract_string_field(req->body, req->body_len, "connection_id");
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	if (!conn_id || !user_id) {
		free(conn_id); free(user_id);
		send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}
	_Bool ok = DeclineConn(conn_id, user_id);
	free(conn_id); free(user_id);
	send_json(client_fd, 200, "OK", ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"decline_failed\"}");
}

static void handle_msg_send(int client_fd, CentralRequest *req)
{
	char *conn_id   = extract_string_field(req->body, req->body_len, "connection_id");
	char *sender_id = extract_string_field(req->body, req->body_len, "sender_id");
	char *text      = extract_string_field(req->body, req->body_len, "text");
	if (!conn_id || !sender_id || !text) {
		free(conn_id); free(sender_id); free(text);
		send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}
	_Bool ok = SendUserConnMessage(conn_id, sender_id, text);
	free(conn_id); free(sender_id); free(text);
	send_json(client_fd, 200, "OK", ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"send_failed\"}");
}

static void handle_msg_list(int client_fd, const char *query)
{
	char conn_id[CONNECTION_ID_SIZE] = {0};
	if (query) {
		const char *p = strstr(query, "connection_id=");
		if (p) {
			p += 14;
			size_t i = 0;
			while (*p && *p != '&' && i < CONNECTION_ID_SIZE - 1)
				conn_id[i++] = *p++;
			conn_id[i] = '\0';
		}
	}
	if (!conn_id[0]) {
		send_json(client_fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_connection_id\"}");
		return;
	}

	UserConnMessage *msgs[MAX_MESSAGES];
	size_t n = ListConnMessages(conn_id, msgs, MAX_MESSAGES);

	String out; InitString(&out, 512);
	CatFixed(&out, "{\"ok\":true,\"messages\":[");
	for (size_t i = 0; i < n; i++) {
		UserConnMessage *m = msgs[i];
		char *text_esc = json_escape_dup(m->text);
		CatTemplateString(&out,
			"%s{\"sender\":\"%s\",\"at\":%lld,\"text\":\"%s\"}",
			i == 0 ? "" : ",",
			m->sender, (long long)m->at, text_esc);
		free(text_esc);
	}
	CatFixed(&out, "]}");
	send_json(client_fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

static void handle_options(int client_fd)
{
	send_json(client_fd, 204, "No Content", NULL);
}

static void dispatch(int client_fd, CentralRequest *req)
{
	/* split path from query string for GET handlers */
	char clean_path[128];
	const char *query = NULL;
	{
		char *q = strchr(req->path, '?');
		if (q) {
			size_t plen = (size_t)(q - req->path);
			if (plen >= sizeof(clean_path)) plen = sizeof(clean_path) - 1;
			memcpy(clean_path, req->path, plen);
			clean_path[plen] = '\0';
			query = q + 1;
		} else {
			strncpy(clean_path, req->path, sizeof(clean_path) - 1);
			clean_path[sizeof(clean_path) - 1] = '\0';
		}
	}

	if (strcmp(req->method, "OPTIONS") == 0) {
		handle_options(client_fd);
		return;
	}

	if (strcmp(req->method, "GET") == 0 && strcmp(clean_path, "/users") == 0) {
		handle_list_users(client_fd);
		return;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/users/create") == 0) {
		handle_create_user(client_fd, req);
		return;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/users/select") == 0) {
		handle_select_user(client_fd, req);
		return;
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/journey/create") == 0) {
		handle_create_journey(client_fd, req);
		return;
	}

	if (strncmp(clean_path, "/journey/", 9) == 0) {
		const char *journey_id = clean_path + 9;
		if (strcmp(req->method, "GET") == 0) {
			handle_get_journey(client_fd, journey_id);
			return;
		}
		if (strcmp(req->method, "POST") == 0) {
			handle_update_journey(client_fd, journey_id, req);
			return;
		}
	}

	/* connection discovery */
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/discoverable") == 0) {
		handle_conn_discoverable(client_fd, req);
		return;
	}
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/private") == 0) {
		handle_conn_private(client_fd, req);
		return;
	}
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/description") == 0) {
		handle_conn_update_description(client_fd, req);
		return;
	}
	if (strcmp(req->method, "GET") == 0 && strcmp(clean_path, "/connections") == 0) {
		handle_conn_list(client_fd, query);
		return;
	}
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/approve") == 0) {
		handle_conn_approve(client_fd, req);
		return;
	}
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/decline") == 0) {
		handle_conn_decline(client_fd, req);
		return;
	}

	/* connection messages */
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/messages/send") == 0) {
		handle_msg_send(client_fd, req);
		return;
	}
	if (strcmp(req->method, "GET") == 0 && strcmp(clean_path, "/messages") == 0) {
		handle_msg_list(client_fd, query);
		return;
	}

	send_json(client_fd, 404, "Not Found",
		"{\"ok\":false,\"error\":\"route_not_found\"}");
}

static void *central_thread_main(void *arg)
{
	(void)arg;

	while (1) {
		struct sockaddr_in addr;
		socklen_t alen = sizeof(addr);
		int client_fd;
		CentralRequest req;

		pthread_mutex_lock(&central_lock);
		if (!central_started || central_fd < 0) {
			pthread_mutex_unlock(&central_lock);
			break;
		}
		pthread_mutex_unlock(&central_lock);

		client_fd = accept(central_fd, (struct sockaddr*)&addr, &alen);
		if (client_fd < 0) {
			if (errno == EINTR) continue;
			pthread_mutex_lock(&central_lock);
			if (!central_started) {
				pthread_mutex_unlock(&central_lock);
				break;
			}
			pthread_mutex_unlock(&central_lock);
			continue;
		}

		if (read_request(client_fd, &req) == 0)
			dispatch(client_fd, &req);
		else
			send_json(client_fd, 400, "Bad Request",
				"{\"ok\":false,\"error\":\"bad_request\"}");

		free_request(&req);
		close(client_fd);
	}

	return NULL;
}

void start_central_server(int port)
{
	struct sockaddr_in addr;
	int opt = 1;

	signal(SIGPIPE, SIG_IGN);

	pthread_mutex_lock(&central_lock);

	if (central_started) {
		pthread_mutex_unlock(&central_lock);
		stop_central_server();
		pthread_mutex_lock(&central_lock);
	}

	central_fd = socket(AF_INET, SOCK_STREAM, 0);
	change_assert(central_fd >= 0, "central: cannot create socket\n");

	setsockopt(central_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
	setsockopt(central_fd, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));

	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((unsigned short)port);
	addr.sin_addr.s_addr = inet_addr("127.0.0.1");

	if (bind(central_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
		close(central_fd);
		central_fd = -1;
		pthread_mutex_unlock(&central_lock);
		change_assert(0, "central: bind failed\n");
	}

	if (listen(central_fd, CENTRAL_BACKLOG) < 0) {
		close(central_fd);
		central_fd = -1;
		pthread_mutex_unlock(&central_lock);
		change_assert(0, "central: listen failed\n");
	}

	InitGlobalPointerMap();
	SetGlobalPointerF("ds_emit", &ds_emit_event);
	SetGlobalPointerF("goal_emit", &goal_emit_event);
	InitGoalSystem();
	InitUserSystem();
	InitConnectionSystem();

	/* load persisted shared journeys */
	memset(SharedJourneyTable, 0, sizeof(SharedJourneyTable));
	SharedJourneyCount = 0;
	ensure_directory(SHARED_JOURNEYS_DIR);
	load_directory_journeys(SHARED_JOURNEYS_DIR, SharedJourneyTable, &SharedJourneyCount, MAX_JOURNEYS);

	central_started = 1;
	pthread_create(&central_thread, NULL, central_thread_main, NULL);
	pthread_mutex_unlock(&central_lock);

	/* Auto-start user server for the first loaded user. */
	if (USER_COUNT > 0)
		start_server(USER_TABLE[0].port, &USER_TABLE[0]);

	printf("Central server listening on http://127.0.0.1:%d\n", port);
}

void stop_central_server(void)
{
	int local_fd = -1;

	pthread_mutex_lock(&central_lock);
	if (!central_started) {
		pthread_mutex_unlock(&central_lock);
		return;
	}

	central_started = 0;
	local_fd = central_fd;
	central_fd = -1;
	pthread_mutex_unlock(&central_lock);

	if (local_fd >= 0) {
		shutdown(local_fd, SHUT_RDWR);
		close(local_fd);
	}

	pthread_join(central_thread, NULL);
	FreeConnectionSystem();
	free_shared_journeys();
}

int central_server_is_running(void)
{
	int r;
	pthread_mutex_lock(&central_lock);
	r = central_started ? 1 : 0;
	pthread_mutex_unlock(&central_lock);
	return r;
}
