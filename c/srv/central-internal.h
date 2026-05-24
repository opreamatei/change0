#ifndef CENTRAL_INTERNAL_H
#define CENTRAL_INTERNAL_H

#include <stddef.h>

/* shared request type used by all handler files */
typedef struct {
	char   method[8];
	char   path[128];
	char  *body;
	size_t body_len;
} CentralRequest;

/* shared JSON utility (defined in central-users.c) */
char *extract_string_field(const char *body, size_t body_len, const char *key);

/* journey handlers — central-journey.c */
void init_shared_journeys(void);
void free_shared_journeys(void);
void handle_get_shared_journey(int fd, const char *journey_id);
void handle_create_shared_journey(int fd, CentralRequest *req);
void handle_update_shared_journey(int fd, const char *journey_id, CentralRequest *req);

/* user handlers — central-users.c */
void handle_list_users(int fd);
void handle_create_user(int fd, CentralRequest *req);
void handle_select_user(int fd, CentralRequest *req);

/* connection handlers — central-conn.c */
void handle_conn_discoverable(int fd, CentralRequest *req);
void handle_conn_private(int fd, CentralRequest *req);
void handle_conn_update_description(int fd, CentralRequest *req);
void handle_conn_list(int fd, const char *query);
void handle_conn_approve(int fd, CentralRequest *req);
void handle_conn_decline(int fd, CentralRequest *req);
void handle_msg_send(int fd, CentralRequest *req);
void handle_msg_list(int fd, const char *query);

#endif
