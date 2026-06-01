#ifndef HTTP_SERVER_INTERNAL_H
#define HTTP_SERVER_INTERNAL_H

#include <pthread.h>
#include <stddef.h>
#include "http-util.h"
#include "user-management.h"

#define SERVER_BACKLOG    10
#define MAX_SSE_CLIENTS   64
#define MAX_STREAM_ID_LEN 63
#define GOAL_ID_LEN       32

/* ── SSE client pool (sse.c) ── */
typedef struct {
	int fd;
	_Bool alive;
	pthread_mutex_t write_lock;
	char stream_id[MAX_STREAM_ID_LEN + 1];
} ClientConnection;

void server_emit_event(const char *stream_id, const char *type, const char *buffer, size_t buffer_len);
void init_sse_clients(void);
void cleanup_sse_clients(void);
void prune_dead_sse_clients(void);
int  add_sse_client(int fd, const char *stream_id);

/* ── dispatch + request handling (routes.c) ── */
void handle_client(int fd, User *user);

/* ── graph handlers (graph-handlers.c) ── */
void handle_get_graph(int fd, User *user);
void handle_post_graph_export(int fd, User *user);
void handle_get_graph_load(int fd, User *user);
void handle_post_message(int fd, const HttpRequest *req, User *user);

/* ── goal handlers (goal-handlers.c) ── */
void handle_get_goal_list(int fd, User *user);
void handle_post_goal_export(int fd, User *user);
void handle_get_goal_load(int fd, User *user);
void handle_post_goal_decompose(int fd, const HttpRequest *req, User *user);
void handle_post_goal_create(int fd, const HttpRequest *req, User *user);
void handle_post_goal_start(int fd, const HttpRequest *req, User *user);
void handle_post_goal_end(int fd, const HttpRequest *req, User *user);
void handle_post_goal_cancel(int fd, const HttpRequest *req, User *user);
void handle_post_journey_dismiss(int fd, const HttpRequest *req, User *user);
void handle_post_goal_drop(int fd, const HttpRequest *req, User *user);
void handle_post_goal_repair(int fd, const HttpRequest *req, User *user);
void handle_post_goal_extend(int fd, const HttpRequest *req, User *user);
void handle_post_goal_reshape(int fd, const HttpRequest *req, User *user);
void handle_get_goal_events(int fd, const char *full_path);
void handle_get_session_goals(int fd, User *user);
void handle_get_schedule(int fd, User *user);
void handle_post_schedule_refresh(int fd, User *user);
void handle_post_goal_shared_action(int fd, const HttpRequest *req, User *user);
void handle_post_goal_create_shared_root(int fd, const HttpRequest *req, User *user);

/* ── middleware + research handlers (middleware-handlers.c) ── */
void handle_post_research_start(int fd, const HttpRequest *req, User *user);
void handle_get_research_events(int fd, const char *full_path);
void handle_post_middleware_message(int fd, const HttpRequest *req, User *user);
void handle_post_middleware_permission(int fd, const HttpRequest *req, User *user);
void handle_get_middleware_events(int fd, const char *full_path, User *user);
void handle_get_middleware_session(int fd, const char *full_path, User *user);
void handle_get_chat_sessions(int fd, User *user);

/* ── profile handlers (profile-handlers.c) ── */
void handle_get_profile(int fd, User *user);
void handle_post_profile_update(int fd, const HttpRequest *req, User *user);
void handle_post_profile_avatar(int fd, const HttpRequest *req, User *user);
void handle_get_profile_avatar(int fd, const HttpRequest *req, User *user);

/* ── dev/time handlers (dev-handlers.c) ── */
void handle_get_dev_time(int fd);
void handle_post_dev_time_advance(int fd, const HttpRequest *req);
void handle_post_dev_time_reset(int fd);

/* ── journal handlers (journal/journal-handlers.c) ── */
void handle_post_journal_create(int fd, const HttpRequest *req, User *user);
void handle_get_journal_list(int fd, User *user);
void handle_get_journal_entry(int fd, const HttpRequest *req, User *user);
void handle_post_journal_update(int fd, const HttpRequest *req, User *user);
void handle_post_journal_delete(int fd, const HttpRequest *req, User *user);
void handle_post_journal_attach(int fd, const HttpRequest *req, User *user);
void handle_get_journal_file(int fd, const HttpRequest *req, User *user);
void handle_post_journal_embed(int fd, const HttpRequest *req, User *user);
void handle_post_journal_embed_delete(int fd, const HttpRequest *req, User *user);

/* ── reminders handlers (journal/reminders-handlers.c) ── */
void handle_get_reminders(int fd, User *user);
void handle_post_reminders_save(int fd, const HttpRequest *req, User *user);
void handle_post_reminders_delete(int fd, const HttpRequest *req, User *user);

/* ── review handlers (review-handlers.c) ── */
void handle_post_submission_create(int fd, const HttpRequest *req, User *user);
void handle_post_submission_file(int fd, const HttpRequest *req, User *user);

#endif
