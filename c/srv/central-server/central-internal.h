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
/* List shared journeys for the user passed as ?user_id=... in the query string. */
void handle_list_shared_journeys(int fd, const char *query);

/*
 * Auto-create a shared journey for a pair of users once their connection is
 * approved by both. Idempotent: if a journey already lists both users, the
 * existing one is returned. The journey title is AI-generated from the two
 * public profiles. Returns the journey id (caller must not free).
 */
const char *EnsureSharedJourneyForPair(const char *user_a_id, const char *user_b_id);

/* Root-goal proposal endpoints — propose_root_goal.c (or shared-journey.c). */
void handle_propose_root_goal(int fd, const char *journey_id, CentralRequest *req);
void handle_approve_root_goal(int fd, const char *journey_id, CentralRequest *req);
void handle_decline_root_goal(int fd, const char *journey_id, CentralRequest *req);
void handle_finalize_root_goal(int fd, const char *journey_id, CentralRequest *req);
void handle_list_root_proposals(int fd, const char *journey_id, const char *query);

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
