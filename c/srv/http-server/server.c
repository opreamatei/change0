#define _GNU_SOURCE
#include "internal.h"
#include "http-server.h"
#include "util.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <pthread.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

_Bool           started     = 0;
int             server_fd   = -1;
int             server_port = 0;
User           *client_user = NULL;
pthread_t       server_thread;
pthread_mutex_t server_lock = PTHREAD_MUTEX_INITIALIZER;

int client_server_port(void)
{
	int p;
	pthread_mutex_lock(&server_lock);
	p = server_port;
	pthread_mutex_unlock(&server_lock);
	return p;
}

int server_is_running(void)
{
	int running;
	pthread_mutex_lock(&server_lock);
	running = started ? 1 : 0;
	pthread_mutex_unlock(&server_lock);
	return running;
}

User *active_client_user(void)
{
	User *user;
	pthread_mutex_lock(&server_lock);
	user = started ? client_user : NULL;
	pthread_mutex_unlock(&server_lock);
	return user;
}

static void *server_thread_main(void *arg)
{
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

		client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &client_len);

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

void start_server(int port, User *user)
{
	struct sockaddr_in addr;
	socklen_t addr_len = sizeof(addr);
	int opt = 1;
	int rc;
	int bound_port = 0;

	/*
	 * Critical for SSE: browsers routinely close/reconnect EventSource
	 * sockets. Without this, send() to a closed socket terminates the process.
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
	addr.sin_family      = AF_INET;
	addr.sin_port        = htons((unsigned short)port);
	addr.sin_addr.s_addr = inet_addr("127.0.0.1");

	if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		if (port != 0) {
			addr.sin_port = 0;
			if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
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

	if (getsockname(server_fd, (struct sockaddr *)&addr, &addr_len) == 0)
		bound_port = ntohs(addr.sin_port);
	else
		bound_port = port;

	server_port = bound_port;
	client_user = user;

	if (listen(server_fd, SERVER_BACKLOG) < 0) {
		perror("listen");
		close(server_fd);
		server_fd = -1;
		server_port = 0;
		client_user = NULL;
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Failed listening at the server socket\n");
		return;
	}

	started = 1;

	rc = pthread_create(&server_thread, NULL, server_thread_main, user);
	if (rc != 0) {
		started = 0;
		client_user = NULL;
		close(server_fd);
		server_fd = -1;
		server_port = 0;
		pthread_mutex_unlock(&server_lock);
		cassert(0, "Failed creating server thread\n");
		return;
	}

	pthread_mutex_unlock(&server_lock);

	printf("Client server (user=%s) listening on http://127.0.0.1:%d\n",
		user && user->name.p ? user->name.p : "?", bound_port);
}

void stop_server(void)
{
	int local_fd = -1;
	_Bool need_join = 0;

	pthread_mutex_lock(&server_lock);

	if (!started) {
		pthread_mutex_unlock(&server_lock);
		return;
	}

	started     = 0;
	local_fd    = server_fd;
	server_fd   = -1;
	server_port = 0;
	client_user = NULL;
	need_join   = 1;

	pthread_mutex_unlock(&server_lock);

	if (local_fd >= 0) {
		shutdown(local_fd, SHUT_RDWR);
		close(local_fd);
	}

	if (need_join)
		pthread_join(server_thread, NULL);

	cleanup_sse_clients();
}
