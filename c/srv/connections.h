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

/* -------- AI matching internals -------- */

#define MATCH_SCHEMA \
	"{\"type\":\"object\"," \
	"\"properties\":{" \
	  "\"matches\":{\"type\":\"array\",\"items\":{" \
	    "\"type\":\"object\"," \
	    "\"properties\":{" \
	      "\"index\":{\"type\":\"integer\"}," \
	      "\"reason\":{\"type\":\"string\"}" \
	    "}," \
	    "\"required\":[\"index\",\"reason\"]," \
	    "\"additionalProperties\":false" \
	  "}}" \
	"}," \
	"\"required\":[\"matches\"]," \
	"\"additionalProperties\":false}"

/*
 * System prompt for the connection matcher.
 * %s substitutions in order:
 *   1. subject description
 *   2. candidate list (pre-formatted, numbered)
 *   3. retry feedback (empty string if first attempt)
 */
#define CONN_MATCH_PROMPT \
	"You are a connection system for a productivity and goal app. " \
	"Your job is to decide which of the listed candidates are worth introducing to the subject — " \
	"not romantically, but because they might find each other intellectually interesting, " \
	"share a way of thinking, or have genuine common ground worth a conversation. " \
	"This is not dating. Do not factor in romantic compatibility.\n\n" \
	"Subject: %s\n\n" \
	"Candidates:\n%s\n" \
	"Select only candidates with a real, specific reason to meet the subject — " \
	"shared curiosity, complementary perspectives, or overlapping depth in something. " \
	"Do not select candidates just because their description is non-empty. " \
	"IMPORTANT: If the subject's description ends with 'Does not want to be matched with: <X>', " \
	"treat that as a hard exclusion for any candidate fitting X. Apply the same rule in reverse. " \
	"For each selected match, provide a reason as one sentence shown to both people simultaneously — " \
	"write it so it reads naturally for either of them. " \
	"Use only 'you both', 'you seem', 'you share', or similar second-person plural phrasing. " \
	"Never use 'A', 'B', 'the subject', 'candidate N', 'one of you', 'the other'. " \
	"Return 0-based indices (candidate 1 = index 0). " \
	"If no candidates are a good fit, return an empty matches array.%s"

typedef struct {
	size_t index;
	char   reason[MATCH_REASON_SIZE];
} MatchResult;

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
