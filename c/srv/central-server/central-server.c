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
#include <stdint.h>
#include <string.h>

#define CENTRAL_BACKLOG    128
/* Header read timeout (seconds) so idle/pre-warmed cloudflared connections that
 * never send a request cannot tie up a connection thread forever. */
#define CENTRAL_READ_TIMEOUT 30

static _Bool           central_started = 0;
static int             central_fd = -1;
static pthread_t       central_thread;
static pthread_mutex_t central_lock = PTHREAD_MUTEX_INITIALIZER;

/*
 * Each connection is read on its own thread (so slow/idle clients can't block
 * the accept loop), but the domain systems are not thread-safe, so handler
 * execution is serialized. We use TWO locks, mirroring the original design
 * where the central server and the per-user client server were independent
 * single-threaded servers running in parallel:
 *
 *   - central_handler_lock guards central-native routes (users, journeys,
 *     connections, messages, submissions).
 *   - client_handler_lock  guards routes forwarded to the active user's client
 *     handler (goals, profile, schedule, journal, ...).
 *
 * They MUST be separate: a forwarded client handler re-enters the central
 * server over a socket (central_connect) to hit a central-native journey
 * route. With a single lock that nested request would deadlock against the
 * lock its own caller already holds (symptom: every route hangs / "infinite
 * loading" and connection threads pile up). Two locks let the client->central
 * re-entrancy cross a lock boundary safely.
 */
static pthread_mutex_t central_handler_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t client_handler_lock  = PTHREAD_MUTEX_INITIALIZER;

static void handle_cors_preflight(int fd)
{
	http_send_json(fd, 204, "No Content", NULL);
}

static int dispatch_to_active_client(int fd, CentralRequest *req)
{
	User *user = active_client_user();
	if (!user) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"route_not_found\"}");
		return 0;
	}

	/* CentralRequest is a typedef of HttpRequest, so we can forward directly. */
	return handle_client_request(fd, req, user);
}

/*
 * Match and run a central-native route. Returns the keep-open flag (0/1) when
 * handled, or -1 when the path is not a central route (caller forwards it to
 * the active client). Must be called under central_handler_lock.
 */
static int dispatch_central_native(int fd, CentralRequest *req,
		const char *clean_path, const char *query)
{
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/users") == 0)          { handle_list_users(fd); return 0; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/users/avatar") == 0)   { handle_get_user_avatar(fd, query); return 0; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/users/profile") == 0)  { handle_get_user_profile(fd, query); return 0; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/users/authentic-goals") == 0) { handle_get_user_authentic_goals(fd, query); return 0; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/users/create") == 0)   { handle_create_user(fd, req); return 0; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/users/select") == 0)   { handle_select_user(fd, req); return 0; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/users/delete") == 0)   { handle_delete_user(fd, req); return 0; }

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/journey/dismiss") == 0) return -1; /* client route */

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/journey/create") == 0) { handle_create_shared_journey(fd, req); return 0; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/journey/list") == 0)   { handle_list_shared_journeys(fd, query); return 0; }
	if (strncmp(clean_path, "/journey/", 9) == 0) {
		const char *rest  = clean_path + 9;
		const char *slash = strchr(rest, '/');
		if (slash) {
			char journey_id[64] = {0};
			size_t id_len = (size_t)(slash - rest);
			if (id_len >= sizeof(journey_id)) id_len = sizeof(journey_id) - 1;
			memcpy(journey_id, rest, id_len);
			const char *sub = slash + 1;
			if (strcmp(req->method, "GET")  == 0 && strcmp(sub, "proposals")     == 0) { handle_list_root_proposals(fd, journey_id, query); return 0; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "propose-root")  == 0) { handle_propose_root_goal(fd, journey_id, req); return 0; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "approve-root")  == 0) { handle_approve_root_goal(fd, journey_id, req); return 0; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "decline-root")  == 0) { handle_decline_root_goal(fd, journey_id, req); return 0; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "finalize-root") == 0) { handle_finalize_root_goal(fd, journey_id, req); return 0; }
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "dismiss")       == 0) { handle_delete_shared_journey(fd, journey_id); return 0; }
		} else {
			const char *journey_id = rest;
			if (strcmp(req->method, "GET")  == 0) { handle_get_shared_journey(fd, journey_id); return 0; }
			if (strcmp(req->method, "POST") == 0) { handle_update_shared_journey(fd, journey_id, req); return 0; }
		}
	}

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/discoverable") == 0) { handle_conn_discoverable(fd, req); return 0; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/private") == 0)      { handle_conn_private(fd, req); return 0; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/description") == 0)  { handle_conn_update_description(fd, req); return 0; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/connections") == 0)              { handle_conn_list(fd, query); return 0; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/approve") == 0)      { handle_conn_approve(fd, req); return 0; }
	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/connections/decline") == 0)      { handle_conn_decline(fd, req); return 0; }

	if (strcmp(req->method, "POST") == 0 && strcmp(clean_path, "/messages/send") == 0)  { handle_msg_send(fd, req); return 0; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/messages") == 0)       { handle_msg_list(fd, query); return 0; }

	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/submissions/pending") == 0) { handle_get_submissions_pending(fd, query); return 0; }
	if (strcmp(req->method, "GET")  == 0 && strcmp(clean_path, "/submissions/file")    == 0) { handle_get_submission_file(fd, query); return 0; }
	if (strncmp(clean_path, "/submissions/", 13) == 0) {
		const char *rest = clean_path + 13;
		const char *slash = strchr(rest, '/');
		if (slash) {
			char sub_id[SUBMISSION_ID_SIZE] = {0};
			size_t id_len = (size_t)(slash - rest);
			if (id_len >= sizeof(sub_id)) id_len = sizeof(sub_id) - 1;
			memcpy(sub_id, rest, id_len);
			const char *sub = slash + 1;
			if (strcmp(req->method, "POST") == 0 && strcmp(sub, "review") == 0) { handle_post_submission_review(fd, sub_id, req); return 0; }
			if (strcmp(req->method, "GET")  == 0 && strcmp(sub, "status") == 0) { handle_get_submission_status(fd, sub_id); return 0; }
		}
	}

	return -1; /* not a central route — forward to the active client */
}

static int dispatch(int fd, CentralRequest *req)
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

	if (strcmp(req->method, "OPTIONS") == 0) { handle_cors_preflight(fd); return 0; }

	/* Central-native routes run serialized under central_handler_lock. */
	pthread_mutex_lock(&central_handler_lock);
	int r = dispatch_central_native(fd, req, clean_path, query);
	pthread_mutex_unlock(&central_handler_lock);
	if (r >= 0)
		return r;

	/*
	 * Forwarded client routes run serialized under a SEPARATE lock. The handler
	 * may call back into this central server over a socket (client -> central
	 * journey routes); that nested request takes central_handler_lock, never
	 * this one, so there is no self-deadlock.
	 */
	pthread_mutex_lock(&client_handler_lock);
	r = dispatch_to_active_client(fd, req);
	pthread_mutex_unlock(&client_handler_lock);
	return r;
}

static void *central_conn_main(void *arg)
{
	int client_fd = (int)(intptr_t)arg;

	/* Bound the time we'll wait for a request so idle pre-warmed connections
	 * (cloudflared keeps a pool of them) don't leak threads forever. */
	struct timeval tv = { CENTRAL_READ_TIMEOUT, 0 };
	setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

	CentralRequest req;
	int keep_open = 0;
	if (read_http_request(client_fd, &req) == 0) {
		keep_open = dispatch(client_fd, &req);
	} else {
		http_send_json(client_fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"bad_request\"}");
	}

	free_http_request(&req);
	if (!keep_open)
		close(client_fd);

	return NULL;
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

		/* One detached thread per connection: reading the request must never
		 * block the accept loop, or a single slow/idle client takes the whole
		 * server down (backlog fills -> cloudflared "dial i/o timeout"). */
		pthread_t conn_thread;
		if (pthread_create(&conn_thread, NULL, central_conn_main,
				(void *)(intptr_t)client_fd) != 0) {
			close(client_fd);
			continue;
		}
		pthread_detach(conn_thread);
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
