#include "internal.h"
#include "http-server.h"
#include "http-util.h"
#include "util.h"

#include <sys/socket.h>
#include <unistd.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static ClientConnection sse_clients[MAX_SSE_CLIENTS];
static pthread_mutex_t  sse_clients_lock = PTHREAD_MUTEX_INITIALIZER;

void init_sse_clients(void)
{
	pthread_mutex_lock(&sse_clients_lock);
	for (int i = 0; i < MAX_SSE_CLIENTS; i++) {
		sse_clients[i].fd           = -1;
		sse_clients[i].alive        = 0;
		sse_clients[i].stream_id[0] = '\0';
	}
	pthread_mutex_unlock(&sse_clients_lock);
}

/* must be called with sse_clients_lock held */
static void remove_sse_client_locked(int idx)
{
	if (idx < 0 || idx >= MAX_SSE_CLIENTS) return;
	if (!sse_clients[idx].alive) return;

	shutdown(sse_clients[idx].fd, SHUT_RDWR);
	close(sse_clients[idx].fd);
	sse_clients[idx].fd           = -1;
	sse_clients[idx].alive        = 0;
	sse_clients[idx].stream_id[0] = '\0';
	pthread_mutex_destroy(&sse_clients[idx].write_lock);
}

int add_sse_client(int fd, const char *stream_id)
{
	pthread_mutex_lock(&sse_clients_lock);

	for (int i = 0; i < MAX_SSE_CLIENTS; i++) {
		if (!sse_clients[i].alive) {
			sse_clients[i].fd           = fd;
			sse_clients[i].alive        = 1;
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

void prune_dead_sse_clients(void)
{
	pthread_mutex_lock(&sse_clients_lock);
	for (int i = 0; i < MAX_SSE_CLIENTS; i++) {
		if (!sse_clients[i].alive) continue;
		char ping[] = ": ping\n\n";
		pthread_mutex_lock(&sse_clients[i].write_lock);
		if (http_send_all(sse_clients[i].fd, ping, strlen(ping)) != 0) {
			pthread_mutex_unlock(&sse_clients[i].write_lock);
			remove_sse_client_locked(i);
			continue;
		}
		pthread_mutex_unlock(&sse_clients[i].write_lock);
	}
	pthread_mutex_unlock(&sse_clients_lock);
}

void cleanup_sse_clients(void)
{
	pthread_mutex_lock(&sse_clients_lock);
	for (int i = 0; i < MAX_SSE_CLIENTS; i++) {
		if (sse_clients[i].alive)
			remove_sse_client_locked(i);
	}
	pthread_mutex_unlock(&sse_clients_lock);
}

/*
 * General SSE emitter. stream_id is both the JSON `id` field and the optional
 * client filter — clients subscribed with a matching stream_id only receive
 * events for that id. Domain emitters (ds_emit_event, goal_emit_event) are
 * thin wrappers so all formatting, escaping, filtering, and cleanup stay here.
 */
void server_emit_event(const char *stream_id, const char *type, const char *buffer, size_t buffer_len)
{
	if (!server_is_running()) return;

	if (!stream_id)  stream_id  = "";
	if (!type)       type       = "";
	if (!buffer)     { buffer = ""; buffer_len = 0; }

	char *esc_id   = json_escape_dup_n(stream_id, strlen(stream_id));
	char *esc_type = json_escape_dup_n(type, strlen(type));
	char *esc_data = json_escape_dup_n(buffer, buffer_len);

	size_t payload_cap = strlen(esc_id) + strlen(esc_type) + strlen(esc_data) + 128;
	char  *payload     = malloc(payload_cap);
	cassert(payload != NULL, "Failed to allocate SSE payload\n");

	int payload_len = snprintf(payload, payload_cap,
		"{\"id\":\"%s\",\"type\":\"%s\",\"data\":\"%s\"}",
		esc_id, esc_type, esc_data);

	if (payload_len > 0) {
		pthread_mutex_lock(&sse_clients_lock);
		for (int i = 0; i < MAX_SSE_CLIENTS; i++) {
			if (!sse_clients[i].alive) continue;
			if (sse_clients[i].stream_id[0] != '\0' &&
			    strcmp(sse_clients[i].stream_id, stream_id) != 0)
				continue;

			int failed = 0;
			pthread_mutex_lock(&sse_clients[i].write_lock);
			if (http_send_all(sse_clients[i].fd, "data: ", 6) != 0)                     failed = 1;
			if (!failed && http_send_all(sse_clients[i].fd, payload, (size_t)payload_len) != 0) failed = 1;
			if (!failed && http_send_all(sse_clients[i].fd, "\n\n", 2) != 0)             failed = 1;
			pthread_mutex_unlock(&sse_clients[i].write_lock);

			if (failed)
				remove_sse_client_locked(i);
		}
		pthread_mutex_unlock(&sse_clients_lock);
	}

	free(payload);
	free(esc_data);
	free(esc_type);
	free(esc_id);
}

void ds_emit_event(const char *id, const char *type, const char *buffer, size_t buffer_len)
{
	server_emit_event(id, type, buffer, buffer_len);
}

void goal_emit_event(const char *id, const char *type, const char *buffer, size_t buffer_len)
{
	server_emit_event(id, type, buffer, buffer_len);
}
