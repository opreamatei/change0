#include "internal.h"

/* Defined in central-server/shared-journey.c; forward-declared here to break
 * the circular header dependency (central-server links connections). */
const char *EnsureSharedJourneyForPair(const char *user_a_id, const char *user_b_id);

UserConn ConnectionTable[MAX_CONNECTIONS];
size_t ConnectionCount = 0;
UserConnMessage MessageTable[MAX_MESSAGES];
size_t MessageCount = 0;
pthread_mutex_t conn_lock = PTHREAD_MUTEX_INITIALIZER;

/* -------- lookup helpers -------- */

UserConn *FindUserConn(const char *connection_id)
{
	if (!connection_id) return NULL;
	for (size_t i = 0; i < ConnectionCount; i++)
		if (strcmp(ConnectionTable[i].id, connection_id) == 0)
			return &ConnectionTable[i];
	return NULL;
}

UserConn *find_pair(const char *a, const char *b)
{
	for (size_t i = 0; i < ConnectionCount; i++) {
		UserConn *c = &ConnectionTable[i];
		if ((strcmp(c->a, a) == 0 && strcmp(c->b, b) == 0) ||
		    (strcmp(c->a, b) == 0 && strcmp(c->b, a) == 0))
			return c;
	}
	return NULL;
}

size_t ListConnsForUser(const char *user_id, UserConn **out, size_t out_max)
{
	size_t n = 0;
	for (size_t i = 0; i < ConnectionCount && n < out_max; i++) {
		UserConn *c = &ConnectionTable[i];
		if (strcmp(c->a, user_id) == 0) {
			out[n++] = c;
		} else if (strcmp(c->b, user_id) == 0 && c->a_approved) {
			out[n++] = c;
		}
	}
	return n;
}

User *OtherUserInConn(const UserConn *c, const char *me)
{
	if (!c || !me) return NULL;
	if (strcmp(c->a, me) == 0) return FindUserByID((char *)c->b);
	if (strcmp(c->b, me) == 0) return FindUserByID((char *)c->a);
	return NULL;
}

/* -------- decisions -------- */

static void recompute_state(UserConn *c)
{
	if (c->state == CONN_DECLINED) return;
	if (c->a_approved && c->b_approved) c->state = CONN_CONFIRMED;
	else c->state = CONN_PROPOSED;
}

_Bool ApproveConn(const char *connection_id, const char *user_id)
{
	pthread_mutex_lock(&conn_lock);
	UserConn *c = FindUserConn(connection_id);
	if (!c || c->state == CONN_DECLINED) {
		pthread_mutex_unlock(&conn_lock);
		return 0;
	}

	if (strcmp(c->a, user_id) == 0) c->a_approved = 1;
	else if (strcmp(c->b, user_id) == 0) c->b_approved = 1;
	else {
		pthread_mutex_unlock(&conn_lock);
		return 0;
	}

	ConnState previous = c->state;
	recompute_state(c);
	persist_connection(c);

	/*
	 * On the transition into CONFIRMED we materialize the shared journey.
	 * Idempotent — EnsureSharedJourneyForPair returns the existing id if
	 * the pair already has one. Done while holding conn_lock to avoid two
	 * approvals racing into duplicate journeys.
	 */
	_Bool just_confirmed = (previous != CONN_CONFIRMED && c->state == CONN_CONFIRMED);
	char a_copy[USER_ID_SIZE], b_copy[USER_ID_SIZE];
	if (just_confirmed) {
		strncpy(a_copy, c->a, sizeof(a_copy) - 1); a_copy[sizeof(a_copy) - 1] = '\0';
		strncpy(b_copy, c->b, sizeof(b_copy) - 1); b_copy[sizeof(b_copy) - 1] = '\0';
	}

	pthread_mutex_unlock(&conn_lock);

	if (just_confirmed)
		(void)EnsureSharedJourneyForPair(a_copy, b_copy);

	return 1;
}

_Bool DeclineConn(const char *connection_id, const char *user_id)
{
	pthread_mutex_lock(&conn_lock);
	UserConn *c = FindUserConn(connection_id);
	if (!c || (strcmp(c->a, user_id) != 0 && strcmp(c->b, user_id) != 0)) {
		pthread_mutex_unlock(&conn_lock);
		return 0;
	}
	c->state = CONN_DECLINED;
	persist_connection(c);
	pthread_mutex_unlock(&conn_lock);
	return 1;
}

/* -------- chat -------- */

_Bool SendUserConnMessage(const char *connection_id, const char *sender_id, const char *text)
{
	if (!text || !*text) return 0;
	pthread_mutex_lock(&conn_lock);
	UserConn *c = FindUserConn(connection_id);
	if (!c || c->state != CONN_CONFIRMED ||
	    (strcmp(c->a, sender_id) != 0 && strcmp(c->b, sender_id) != 0) ||
	    MessageCount >= MAX_MESSAGES) {
		pthread_mutex_unlock(&conn_lock);
		return 0;
	}

	UserConnMessage *m = &MessageTable[MessageCount];
	memset(m, 0, sizeof(*m));
	strncpy(m->connection_id, connection_id, CONNECTION_ID_SIZE - 1);
	strncpy(m->sender, sender_id, USER_ID_SIZE - 1);
	m->at = change_time_now();
	size_t n = strlen(text);
	if (n >= MESSAGE_TEXT_SIZE) n = MESSAGE_TEXT_SIZE - 1;
	memcpy(m->text, text, n);
	m->text[n] = 0;
	MessageCount++;
	pthread_mutex_unlock(&conn_lock);

	append_message_to_file(m);
	return 1;
}

size_t ListConnMessages(const char *connection_id, UserConnMessage **out, size_t out_max)
{
	size_t n = 0;
	for (size_t i = 0; i < MessageCount && n < out_max; i++)
		if (strcmp(MessageTable[i].connection_id, connection_id) == 0)
			out[n++] = &MessageTable[i];
	return n;
}

/* -------- discoverability + matching -------- */

void SetUserDiscoverable(User *u, const char *description)
{
	change_assert(u, "SetUserDiscoverable: NULL user");
	u->discoverable = 1;
	EmptyString(&u->description);
	if (description && *description)
		CatString(&u->description, (char *)description, strlen(description));
	SaveUser(u);
}

void SetUserPrivate(User *u)
{
	change_assert(u, "SetUserPrivate: NULL user");
	u->discoverable = 0;
	SaveUser(u);
}

void UpdateUserDescription(User *u, const char *description)
{
	change_assert(u, "UpdateUserDescription: NULL user");
	EmptyString(&u->description);
	if (description && *description)
		CatString(&u->description, (char *)description, strlen(description));
	SaveUser(u);
}

/* Find and propose matches for a single user against all discoverable others.
   The AI sees all candidates at once — one call, unbiased.
   Creates connections with a_approved=false — the initiator must approve first
   before the other party sees the proposal.
   Returns total proposals pending (new + already waiting). */
size_t FindMatchForUser(User *a)
{
	change_assert(a, "FindMatchForUser: NULL user");
	if (!a->discoverable || !a->description.p || a->description.len == 0) return 0;

	size_t already_pending = 0;
	pthread_mutex_lock(&conn_lock);
	for (size_t i = 0; i < ConnectionCount; i++) {
		UserConn *c = &ConnectionTable[i];
		if (c->state == CONN_PROPOSED && strcmp(c->a, a->id) == 0 && !c->a_approved)
			already_pending++;
	}
	pthread_mutex_unlock(&conn_lock);

	User *candidates[MAX_USERS];
	size_t candidate_count = 0;

	for (size_t j = 0; j < USER_COUNT; j++) {
		User *b = &USER_TABLE[j];
		if (strcmp(a->id, b->id) == 0) continue;
		if (!b->discoverable || !b->description.p || b->description.len == 0) continue;

		pthread_mutex_lock(&conn_lock);
		int skip = (ConnectionCount >= MAX_CONNECTIONS) || (find_pair(a->id, b->id) != NULL);
		pthread_mutex_unlock(&conn_lock);
		if (skip) continue;

		candidates[candidate_count++] = b;
	}

	if (candidate_count == 0)
		return already_pending;

	MatchResult results[MAX_USERS];
	MatchResult shortlist[MAX_USERS];
	MatchResult final_results[CONNECTION_FINAL_MATCH_LIMIT];
	size_t match_count = ai_find_matches(a, candidates, candidate_count,
	                                     results, MAX_USERS);
	size_t shortlist_count = dedupe_match_results(results, match_count,
	                                              shortlist, MAX_USERS);
	size_t final_count = ai_pick_final_matches(a, candidates, shortlist,
	                                           shortlist_count,
	                                           final_results,
	                                           CONNECTION_FINAL_MATCH_LIMIT);

	size_t new_proposals = 0;
	for (size_t m = 0; m < final_count; m++) {
		User *b = candidates[final_results[m].index];

		pthread_mutex_lock(&conn_lock);
		if (!find_pair(a->id, b->id) && ConnectionCount < MAX_CONNECTIONS) {
			UserConn *c = &ConnectionTable[ConnectionCount++];
			memset(c, 0, sizeof(*c));
			random_id(c->id, CONNECTION_ID_SIZE - 1);
			c->id[CONNECTION_ID_SIZE - 1] = 0;
			strncpy(c->a, a->id, USER_ID_SIZE - 1);
			strncpy(c->b, b->id, USER_ID_SIZE - 1);
			c->state = CONN_PROPOSED;
			c->proposed_at = change_time_now();
			strncpy(c->reason, final_results[m].reason, sizeof(c->reason) - 1);
			persist_connection(c);
			new_proposals++;
		}
		pthread_mutex_unlock(&conn_lock);
	}

	return already_pending + new_proposals;
}

void RunMatchingPass(void)
{
	for (size_t i = 0; i < USER_COUNT; i++)
		(void)FindMatchForUser(&USER_TABLE[i]);
}
