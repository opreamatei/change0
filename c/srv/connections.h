#ifndef CONNECTIONS_H
#define CONNECTIONS_H

#include "user-management.h"
#include "lib/util/util.h"

#include <time.h>

#define MAX_CONNECTIONS    256
#define MAX_MESSAGES       1024
#define CONNECTION_ID_SIZE 33
#define MATCH_REASON_SIZE  512
#define MESSAGE_TEXT_SIZE  2048

typedef char connection_id_like[CONNECTION_ID_SIZE];

typedef enum {
	CONN_PROPOSED  = 0,  /* needs both users to approve */
	CONN_CONFIRMED = 1,  /* both approved, chat allowed */
	CONN_DECLINED  = 2,  /* one user declined */
} ConnState;

typedef struct {
	connection_id_like id;
	user_id_like a, b;
	_Bool a_approved;
	_Bool b_approved;
	ConnState state;
	time_t proposed_at;
	/* Why central matched them. Visible to both users. Must avoid leaking
	 * description content directly — phrase it as overlapping themes. */
	char reason[MATCH_REASON_SIZE];
} UserConn;

typedef struct {
	connection_id_like connection_id;
	user_id_like sender;
	time_t at;
	char text[MESSAGE_TEXT_SIZE];
} UserConnMessage;

/* lifecycle */
void InitConnectionSystem(void);
void FreeConnectionSystem(void);

/* user opt-in. Triggers matching pass if becoming discoverable. */
void SetUserDiscoverable(User *u, const char *description);
void SetUserPrivate(User *u);
void UpdateUserDescription(User *u, const char *description);

/* Find matches for one user and propose them (a_approved=false until they accept). */
/* Returns number of new connection proposals created. */
size_t FindMatchForUser(User *a);
/* Walk all discoverable users and match every compatible pair. Idempotent. */
void RunMatchingPass(void);

/* per-user queries */
UserConn *FindUserConn(const char *connection_id);
size_t ListConnsForUser(const char *user_id, UserConn **out, size_t out_max);

/* decisions. Both must approve for CONFIRMED. */
_Bool ApproveConn(const char *connection_id, const char *user_id);
_Bool DeclineConn(const char *connection_id, const char *user_id);

/* chat — only allowed when CONFIRMED */
_Bool SendUserConnMessage(const char *connection_id, const char *sender_id, const char *text);
size_t ListConnMessages(const char *connection_id, UserConnMessage **out, size_t out_max);

/* lookup other party of a confirmed connection */
User *OtherUserInConn(const UserConn *c, const char *me);

#endif
