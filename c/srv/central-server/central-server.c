#define _GNU_SOURCE
#include "central-server.h"
#include "central-internal.h"
#include "http-server.h"
#include "http-util.h"
#include "user-management.h"
#include "connections.h"
#include "reviews.h"
#include "util.h"
#include "config.h"
#include "globals.h"
#include "ne/goal/goal.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <pthread.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CENTRAL_BACKLOG    4
#define CENTRAL_MAX_BODY   (16 * 1024)

static _Bool           central_started = 0;
static int             central_fd = -1;
static pthread_t       central_thread;
static pthread_mutex_t central_lock = PTHREAD_MUTEX_INITIALIZER;

static int read_request(int fd, CentralRequest *req)
{
	char buf[CENTRAL_MAX_BODY + 1];
	size_t total = 0;
	ssize_t r;

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

	if (total == 0) return -1;
	buf[total] = '\0';

	char *header_end = strstr(buf, "\r\n\r\n");
	if (!header_end) return -1;
	size_t header_len = (size_t)(header_end - buf) + 4;

	const char *nl = strstr(buf, "\r\n");
	char first_line[256];
	if (!nl || (size_t)(nl - buf) >= sizeof(first_line)) return -1;
	memcpy(first_line, buf, (size_t)(nl - buf));
	first_line[nl - buf] = '\0';

	if (sscanf(first_line, "%7s %127s", req->method, req->path) != 2)
		return -1;

	size_t content_length = 0;
	const char *cl = strcasestr(buf, "Content-Length:");
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
			total   += (size_t)r;
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

static void handle_cors_preflight(int fd)
{
	http_send_json(fd, 204, "No Content", NULL);
}

static void dispatch(int fd, CentralRequest *req)
{
	char clean_path[128];
	const char *query = NULL;
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

	if (strcmp(req->method, "OPTIONS") == 0) { handle_cors_preflight(fd); return; }

	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/users") == 0)          { handle_list_users(fd); return; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/users/avatar") == 0)   { handle_get_user_avatar(fd, query); return; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/users/create") == 0)   { handle_create_user(fd, req); return; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/users/select") == 0)   { handle_select_user(fd, req); return; }

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/journey/create") == 0) { handle_create_shared_journey(fd, req); return; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/journey/list") == 0)   { handle_list_shared_journeys(fd, query); return; }
	if (strncmp(clean_path, "/journey/", 9) == 0) {
		const char *rest  = clean_path + 9;
		const char *slash = strchr(rest, '/');
		if (slash) {
			char journey_id[64] = {0};
			size_t id_len = (size_t)(slash - rest);
			if (id_len >= sizeof(journey_id)) id_len = sizeof(journey_id) - 1;
			memcpy(journey_id, rest, id_len);
			const char *sub = slash + 1;
			if (strcmp(req->method, "GET")  == 0 && strcmp(sub, "proposals")     == 0) { handle_list_root_proposals(fd, journey_id, query); return; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "propose-root")  == 0) { handle_propose_root_goal(fd, journey_id, req); return; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "approve-root")  == 0) { handle_approve_root_goal(fd, journey_id, req); return; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "decline-root")  == 0) { handle_decline_root_goal(fd, journey_id, req); return; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "finalize-root") == 0) { handle_finalize_root_goal(fd, journey_id, req); return; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "dismiss")       == 0) { handle_delete_shared_journey(fd, journey_id); return; }
		} else {
			const char *journey_id = rest;
			if (strcmp(req->method, "GET")  == 0) { handle_get_shared_journey(fd, journey_id); return; }
			if (strcmp(req->method, "POST") == 0) { handle_update_shared_journey(fd, journey_id, req); return; }
		}
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/discoverable") == 0) { handle_conn_discoverable(fd, req); return; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/private") == 0)      { handle_conn_private(fd, req); return; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/description") == 0)  { handle_conn_update_description(fd, req); return; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/connections") == 0)              { handle_conn_list(fd, query); return; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/approve") == 0)      { handle_conn_approve(fd, req); return; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/decline") == 0)      { handle_conn_decline(fd, req); return; }

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/messages/send") == 0)  { handle_msg_send(fd, req); return; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/messages") == 0)       { handle_msg_list(fd, query); return; }

	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/submissions/pending") == 0) { handle_get_submissions_pending(fd, query); return; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/submissions/file")    == 0) { handle_get_submission_file(fd, query); return; }
	if (strncmp(clean_path, "/submissions/", 13) == 0) {
		const char *rest = clean_path + 13;
		const char *slash = strchr(rest, '/');
		if (slash) {
			char sub_id[SUBMISSION_ID_SIZE] = {0};
			size_t id_len = (size_t)(slash - rest);
			if (id_len >= sizeof(sub_id)) id_len = sizeof(sub_id) - 1;
			memcpy(sub_id, rest, id_len);
			const char *sub = slash + 1;
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "review") == 0) { handle_post_submission_review(fd, sub_id, req); return; }
			if (strcmp(req->method, "GET")  == 0 && strcmp(sub, "status") == 0) { handle_get_submission_status(fd, sub_id); return; }
		}
	}

	http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"route_not_found\"}");
}

static void *central_thread_main(void *arg)
{
	(void)arg;

	while (1) {
		pthread_mutex_lock(&central_lock);
		if (!central_started || central_fd < 0) {
			pthread_mutex_unlock(&central_lock);
			break;
		}
		pthread_mutex_unlock(&central_lock);

		struct sockaddr_in addr;
		socklen_t alen = sizeof(addr);
		int client_fd = accept(central_fd, (struct sockaddr *)&addr, &alen);
		if (client_fd < 0) {
			if (errno == EINTR) continue;
			pthread_mutex_lock(&central_lock);
			if (!central_started) { pthread_mutex_unlock(&central_lock); break; }
			pthread_mutex_unlock(&central_lock);
			continue;
		}

		CentralRequest req;
		if (read_request(client_fd, &req) == 0)
			dispatch(client_fd, &req);
		else
			http_send_json(client_fd, 400, "Bad Request",
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
	addr.sin_family      = AF_INET;
	addr.sin_port        = htons((unsigned short)port);
	addr.sin_addr.s_addr = inet_addr("127.0.0.1");

	if (bind(central_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		close(central_fd); central_fd = -1;
		pthread_mutex_unlock(&central_lock);
		change_assert(0, "central: bind failed\n");
	}

	if (listen(central_fd, CENTRAL_BACKLOG) < 0) {
		close(central_fd); central_fd = -1;
		pthread_mutex_unlock(&central_lock);
		change_assert(0, "central: listen failed\n");
	}

	InitGlobalPointerMap();
	SetGlobalPointerF("ds_emit", &ds_emit_event);
	SetGlobalPointerF("goal_emit", &goal_emit_event);
	InitGoalSystem();
	InitUserSystem();
	InitConnectionSystem();
	init_shared_journeys();
	InitReviewSystem();

	central_started = 1;
	pthread_create(&central_thread, NULL, central_thread_main, NULL);
	pthread_mutex_unlock(&central_lock);

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
