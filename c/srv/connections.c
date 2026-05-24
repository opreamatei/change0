#include "connections.h"
#include "config.h"
#include "lib/util/util.h"
#include "lib/util/change-errors.h"
#include "lib/util/time-util.h"
#include "lib/jsonp/json.h"
#include "openai.h"

#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define CONN_DIR     PROJECT_ROOT "user-data/connections/"
#define CONN_EXT     ".conn"
#define MSG_EXT      ".msgs"

static UserConn         ConnectionTable[MAX_CONNECTIONS];
static size_t             ConnectionCount = 0;
static UserConnMessage  MessageTable[MAX_MESSAGES];
static size_t             MessageCount = 0;
static pthread_mutex_t  conn_lock = PTHREAD_MUTEX_INITIALIZER;

/* -------- AI-based pair matching -------- */

#define MATCH_SCHEMA \
	"{\"type\":\"object\"," \
	"\"properties\":{" \
	  "\"match\":{\"type\":\"boolean\"}," \
	  "\"reason\":{\"type\":\"string\"}" \
	"}," \
	"\"required\":[\"match\",\"reason\"]," \
	"\"additionalProperties\":false}"

/* Returns 1 if AI decides a and b are a good match, writes reason into reason_out.
   Retries up to 3 times on parse failure, feeding the error back to the model. */
static _Bool ai_should_match(const User *a, const User *b,
                              char *reason_out, size_t reason_size)
{
	String feedback;
	InitString(&feedback, 128);

	_Bool matched = 0;

	for (int attempt = 0; attempt < 3; attempt++) {
		String prompt;
		InitString(&prompt, 1024);
		CatTemplateString(&prompt,
			"You are a connection system for a productivity and goal app. "
			"Decide whether two people are worth introducing to each other — not romantically, "
			"but because they might find each other intellectually interesting, share a way of thinking, "
			"or have genuine common ground worth a conversation. "
			"This is not dating. Do not factor in romantic compatibility. Reply using the required JSON schema.\n\n"
			"Person A: %s\n"
			"Person B: %s\n\n"
			"Set match=true only if there is a real, specific reason they would enjoy meeting — "
			"shared curiosity, complementary perspectives, or overlapping depth in something. "
			"Do not match people just because their descriptions are non-empty. "
			"IMPORTANT: If either description ends with 'Does not want to be matched with: <X>', treat that as a hard exclusion — set match=false if the other person fits X. "
			"reason must be one sentence shown to both people simultaneously — write it so it reads naturally for either of them. "
			"Use only 'you both', 'you seem', 'you share', or similar second-person plural phrasing. "
			"Never use 'A', 'B', 'person A', 'person B', 'one of you', 'the other' — both people read the exact same sentence. "
			"If match=false, reason can be an empty string.%s",
			a->description.p ? a->description.p : "(no description)",
			b->description.p ? b->description.p : "(no description)",
			feedback.len > 0 ? feedback.p : "");
		FreeString(&feedback);
		InitString(&feedback, 128);

		ai_gpt_request req = {0};
		req.prompt     = prompt;
		req.model      = AI_OPENAI_MODEL_GPT_5_4_MINI;
		req.schema_name = "connection_match";
		InitString(&req.schema, sizeof(MATCH_SCHEMA) + 1);
		CatFixed(&req.schema, MATCH_SCHEMA);

		String *raw = ai_openai_call_gpt_request(&req);
		change_assert(raw, "ai_should_match: OpenAI call failed");

		FreeString(&prompt);
		FreeString(&req.schema);

		json_value *doc = json_parse(raw->p, raw->len);
		FreeString(raw);
		free(raw);

		if (!doc || doc->type != json_object) {
			CatFixed(&feedback, "\n[Previous response was not valid JSON. Return the schema exactly.]");
			if (doc) json_value_free(doc);
			continue;
		}

		json_value *jmatch  = NULL;
		json_value *jreason = NULL;
		for (size_t k = 0; k < doc->u.object.length; k++) {
			json_object_entry *e = &doc->u.object.values[k];
			if (strcmp(e->name, "match")  == 0) jmatch  = e->value;
			if (strcmp(e->name, "reason") == 0) jreason = e->value;
		}

		if (!jmatch || jmatch->type != json_boolean) {
			CatFixed(&feedback, "\n[\"match\" field missing or not boolean. Fix it.]");
			json_value_free(doc);
			continue;
		}

		matched = jmatch->u.boolean;
		if (matched && jreason && jreason->type == json_string) {
			size_t rlen = jreason->u.string.length;
			if (rlen >= reason_size) rlen = reason_size - 1;
			memcpy(reason_out, jreason->u.string.ptr, rlen);
			reason_out[rlen] = '\0';
		} else if (matched) {
			snprintf(reason_out, reason_size, "You seem like compatible people.");
		}

		json_value_free(doc);
		break;
	}

	FreeString(&feedback);
	return matched;
}

/* -------- persistence -------- */

static void ensure_conn_dir(void)
{
	if (mkdir(USER_DATA_DIRECTORY, 0755) != 0 && errno != EEXIST)
		change_assert(0, "connections: cannot create user-data dir");
	if (mkdir(CONN_DIR, 0755) != 0 && errno != EEXIST)
		change_assert(0, "connections: cannot create connections dir");
}

static void conn_path(const char *id, const char *ext, char *out, size_t out_size)
{
	int n = snprintf(out, out_size, CONN_DIR "%s%s", id, ext);
	change_assert(n > 0 && (size_t)n < out_size, "connections: path too long");
}

static void persist_connection(const UserConn *c)
{
	char path[512];
	conn_path(c->id, CONN_EXT, path, sizeof(path));

	char *esc_reason = json_escape_dup(c->reason);
	String out; InitString(&out, 512);
	CatTemplateString(&out,
		"{\"id\":\"%s\",\"a\":\"%s\",\"b\":\"%s\","
		"\"a_approved\":%s,\"b_approved\":%s,\"state\":%d,"
		"\"proposed_at\":%lld,\"reason\":\"%s\"}\n",
		c->id, c->a, c->b,
		c->a_approved ? "true" : "false",
		c->b_approved ? "true" : "false",
		(int)c->state,
		(long long)c->proposed_at,
		esc_reason);
	dump_to_file(path, out.p, out.len);
	FreeString(&out);
	free(esc_reason);
}

static void append_message_to_file(const UserConnMessage *m)
{
	char path[512];
	conn_path(m->connection_id, MSG_EXT, path, sizeof(path));

	char *esc_text = json_escape_dup(m->text);
	String line; InitString(&line, 256 + strlen(m->text));
	CatTemplateString(&line,
		"{\"sender\":\"%s\",\"at\":%lld,\"text\":\"%s\"}\n",
		m->sender, (long long)m->at, esc_text);

	FILE *f = fopen(path, "ab");
	change_assert(f, "connections: cannot append message to %s", path);
	fwrite(line.p, 1, line.len, f);
	fclose(f);

	FreeString(&line);
	free(esc_text);
}

static void load_connection_from_file(const char *path)
{
	change_assert(ConnectionCount < MAX_CONNECTIONS, "connections: table full while loading");
	size_t flen = 0;
	char *data = readFile((char *)path, &flen);
	if (!data) return;

	json_value *doc = json_parse(data, flen);
	if (!doc || doc->type != json_object) { free(data); if (doc) json_value_free(doc); return; }

	UserConn *c = &ConnectionTable[ConnectionCount];
	memset(c, 0, sizeof(*c));

	json_value *v;
	v = json_object_get(doc, "id");           if (v && v->type == json_string) { strncpy(c->id, v->u.string.ptr, CONNECTION_ID_SIZE - 1); c->id[CONNECTION_ID_SIZE - 1] = 0; }
	v = json_object_get(doc, "a");            if (v && v->type == json_string) { strncpy(c->a,  v->u.string.ptr, USER_ID_SIZE - 1);       c->a[USER_ID_SIZE - 1]       = 0; }
	v = json_object_get(doc, "b");            if (v && v->type == json_string) { strncpy(c->b,  v->u.string.ptr, USER_ID_SIZE - 1);       c->b[USER_ID_SIZE - 1]       = 0; }
	v = json_object_get(doc, "a_approved");   if (v && v->type == json_boolean) c->a_approved = v->u.boolean ? 1 : 0;
	v = json_object_get(doc, "b_approved");   if (v && v->type == json_boolean) c->b_approved = v->u.boolean ? 1 : 0;
	v = json_object_get(doc, "state");        if (v && v->type == json_integer) c->state = (ConnState)v->u.integer;
	v = json_object_get(doc, "proposed_at");  if (v && v->type == json_integer) c->proposed_at = (time_t)v->u.integer;
	v = json_object_get(doc, "reason");       if (v && v->type == json_string) { size_t n = v->u.string.length; if (n >= MATCH_REASON_SIZE) n = MATCH_REASON_SIZE - 1; memcpy(c->reason, v->u.string.ptr, n); c->reason[n] = 0; }

	json_value_free(doc);
	free(data);

	if (c->id[0]) ConnectionCount++;
}

static void load_messages_for(const char *connection_id)
{
	char path[512];
	conn_path(connection_id, MSG_EXT, path, sizeof(path));
	size_t flen = 0;
	char *data = readFile(path, &flen);
	if (!data) return;

	size_t i = 0;
	while (i < flen && MessageCount < MAX_MESSAGES) {
		size_t start = i;
		while (i < flen && data[i] != '\n') i++;
		size_t line_len = i - start;
		if (i < flen) i++;
		if (line_len == 0) continue;

		json_value *doc = json_parse(data + start, line_len);
		if (!doc || doc->type != json_object) { if (doc) json_value_free(doc); continue; }

		UserConnMessage *m = &MessageTable[MessageCount];
		memset(m, 0, sizeof(*m));
		strncpy(m->connection_id, connection_id, CONNECTION_ID_SIZE - 1);

		json_value *v;
		v = json_object_get(doc, "sender"); if (v && v->type == json_string) { strncpy(m->sender, v->u.string.ptr, USER_ID_SIZE - 1); m->sender[USER_ID_SIZE - 1] = 0; }
		v = json_object_get(doc, "at");     if (v && v->type == json_integer) m->at = (time_t)v->u.integer;
		v = json_object_get(doc, "text");   if (v && v->type == json_string) { size_t n = v->u.string.length; if (n >= MESSAGE_TEXT_SIZE) n = MESSAGE_TEXT_SIZE - 1; memcpy(m->text, v->u.string.ptr, n); m->text[n] = 0; }

		json_value_free(doc);
		if (m->sender[0] && m->text[0]) MessageCount++;
	}

	free(data);
}

/* -------- lifecycle -------- */

void InitConnectionSystem(void)
{
	ConnectionCount = 0;
	MessageCount = 0;
	ensure_conn_dir();

	DIR *d = opendir(CONN_DIR);
	if (!d) return;
	struct dirent *e;
	while ((e = readdir(d)) != NULL) {
		size_t n = strlen(e->d_name);
		if (n < 6 || strcmp(e->d_name + n - 5, CONN_EXT) != 0) continue;
		char path[512];
		snprintf(path, sizeof(path), CONN_DIR "%s", e->d_name);
		load_connection_from_file(path);
	}
	closedir(d);

	for (size_t i = 0; i < ConnectionCount; i++)
		load_messages_for(ConnectionTable[i].id);
}

void FreeConnectionSystem(void)
{
	ConnectionCount = 0;
	MessageCount = 0;
}

/* -------- lookup helpers -------- */

UserConn *FindUserConn(const char *connection_id)
{
	if (!connection_id) return NULL;
	for (size_t i = 0; i < ConnectionCount; i++)
		if (strcmp(ConnectionTable[i].id, connection_id) == 0)
			return &ConnectionTable[i];
	return NULL;
}

static UserConn *find_pair(const char *a, const char *b)
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
			out[n++] = c;  /* initiator always sees it */
		} else if (strcmp(c->b, user_id) == 0 && c->a_approved) {
			out[n++] = c;  /* other party only sees it after initiator approved */
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
	if (!c || c->state == CONN_DECLINED) { pthread_mutex_unlock(&conn_lock); return 0; }

	if      (strcmp(c->a, user_id) == 0) c->a_approved = 1;
	else if (strcmp(c->b, user_id) == 0) c->b_approved = 1;
	else { pthread_mutex_unlock(&conn_lock); return 0; }

	recompute_state(c);
	persist_connection(c);
	pthread_mutex_unlock(&conn_lock);
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
   Creates connections with a_approved=false — the initiator must approve first
   before the other party sees the proposal.
   Returns the number of new proposals created. */
size_t FindMatchForUser(User *a)
{
	size_t found = 0;
	change_assert(a, "FindMatchForUser: NULL user");
	if (!a->discoverable || !a->description.p || a->description.len == 0) return 0;

	/* count already-pending proposals so the caller knows there's something to review */
	pthread_mutex_lock(&conn_lock);
	for (size_t i = 0; i < ConnectionCount; i++) {
		UserConn *c = &ConnectionTable[i];
		if (c->state == CONN_PROPOSED && strcmp(c->a, a->id) == 0 && !c->a_approved)
			found++;
	}
	pthread_mutex_unlock(&conn_lock);

	for (size_t j = 0; j < USER_COUNT; j++) {
		User *b = &USER_TABLE[j];
		if (strcmp(a->id, b->id) == 0) continue;
		if (!b->discoverable || !b->description.p || b->description.len == 0) continue;

		/* quick pre-check under lock */
		pthread_mutex_lock(&conn_lock);
		int already = (ConnectionCount >= MAX_CONNECTIONS) || (find_pair(a->id, b->id) != NULL);
		pthread_mutex_unlock(&conn_lock);
		if (already) continue;

		/* AI call outside the lock — slow */
		char reason[512] = {0};
		if (!ai_should_match(a, b, reason, sizeof(reason))) continue;

		/* re-check and insert under lock (double-check after AI call) */
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
			strncpy(c->reason, reason, sizeof(c->reason) - 1);
			persist_connection(c);
			found++;
		}
		pthread_mutex_unlock(&conn_lock);
	}
	return found;
}

void RunMatchingPass(void)
{
	for (size_t i = 0; i < USER_COUNT; i++)
		(void)FindMatchForUser(&USER_TABLE[i]);
}
