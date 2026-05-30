#include "central-internal.h"
#include "central-server.h"
#include "journey.h"
#include "http-util.h"
#include "user-management.h"
#include "connections.h"
#include "util.h"
#include "json.h"
#include "config.h"
#include "ne/goal/goal.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define SHARED_JOURNEYS_DIR  PROJECT_ROOT "data/shared-journeys/"
#define ROOT_PROPOSALS_DIR   PROJECT_ROOT "data/shared-journeys/proposals/"
#define ROOT_PROPOSAL_ID_SIZE 33
#define MAX_PENDING_ROOT_PROPOSALS 256

static Journey SharedJourneyTable[MAX_JOURNEYS];
static size_t  SharedJourneyCount = 0;

/* forward declarations — defined after the shared-journey helpers */
static void init_proposals(void);
static void free_proposals(void);

/*
 * A root-goal proposal is the lightweight artifact users vote on before a
 * real Goal is materialized inside the shared journey. The proposer fills
 * a rough title + extra_info; the partner approves (or declines). Only
 * when both have approved does any client finalize the proposal by
 * running the goal-creation pipeline locally and pushing the result back.
 *
 * Storage is intentionally simple: one fixed table, one JSON file per
 * proposal under ROOT_PROPOSALS_DIR. We do not garbage-collect declined
 * or finalized proposals at runtime — the load step skips finalized ones
 * by re-reading the journey state.
 */
typedef struct RootGoalProposal {
	char id[ROOT_PROPOSAL_ID_SIZE];
	char journey_id[JOURNEY_ID_SIZE];
	char proposed_by[USER_ID_SIZE];
	String title;
	String extra_info;
	_Bool a_approved;       /* a/b indices refer to the journey's users[0]/users[1] */
	_Bool b_approved;
	_Bool declined;
	_Bool finalized;
	char finalized_goal_id[33];
	time_t proposed_at;
} RootGoalProposal;

static RootGoalProposal RootProposalTable[MAX_PENDING_ROOT_PROPOSALS];
static size_t           RootProposalCount = 0;

static void ensure_directory(const char *path)
{
	if (mkdir(path, 0755) != 0 && errno != EEXIST)
		change_assert(0, "Could not create shared-journeys directory.\n");
}

static void load_directory_journeys(const char *dir, Journey *table, size_t *count, size_t max)
{
	DIR *d = opendir(dir);
	if (!d) return;

	struct dirent *e;
	while ((e = readdir(d)) != NULL && *count < max) {
		size_t nlen = strlen(e->d_name);
		if (nlen < 6 || strcmp(e->d_name + nlen - 5, ".json") != 0)
			continue;

		char path[512];
		snprintf(path, sizeof(path), "%s%s", dir, e->d_name);

		Journey *j = &table[(*count)++];
		memset(j, 0, sizeof(*j));
		InitString(&j->title, 64);
		InitString(&j->extra_info, 256);
		LoadJourneyFromFile(j, path);
	}

	closedir(d);
}

void init_shared_journeys(void)
{
	memset(SharedJourneyTable, 0, sizeof(SharedJourneyTable));
	SharedJourneyCount = 0;
	mkdir(DATA_ROOT_DIRECTORY, 0755);
	ensure_directory(SHARED_JOURNEYS_DIR);
	load_directory_journeys(SHARED_JOURNEYS_DIR, SharedJourneyTable, &SharedJourneyCount, MAX_JOURNEYS);
	init_proposals();
}

void free_shared_journeys(void)
{
	for (size_t i = 0; i < SharedJourneyCount; i++) {
		Journey *j = &SharedJourneyTable[i];
		FreeString(&j->title);
		FreeString(&j->extra_info);
		for (size_t k = 0; k < j->goals_count; k++) {
			Goal *g = j->goals[k];
			if (!g) continue;
			if (g->title.p) FreeString(&g->title);
			if (g->extra_info.p) FreeString(&g->extra_info);
			free(g->subgoals);
			free(g);
		}
	}
	SharedJourneyCount = 0;
	free_proposals();
}

static Journey *find_shared_journey(const char *id)
{
	for (size_t i = 0; i < SharedJourneyCount; i++)
		if (strcmp(SharedJourneyTable[i].id, id) == 0)
			return &SharedJourneyTable[i];
	return NULL;
}

static Journey *find_shared_journey_by_pair(const char *user_a, const char *user_b)
{
	for (size_t i = 0; i < SharedJourneyCount; i++) {
		Journey *j = &SharedJourneyTable[i];
		if (FindUserIndexInJourney(j, user_a) >= MAX_JOURNEY_USERS) continue;
		if (FindUserIndexInJourney(j, user_b) >= MAX_JOURNEY_USERS) continue;
		return j;
	}
	return NULL;
}

static void persist_shared_journey(const Journey *j)
{
	char path[512];
	snprintf(path, sizeof(path), SHARED_JOURNEYS_DIR "%s.json", j->id);
	ExportJourneyTo(j, path);
}

static void persist_proposal(const RootGoalProposal *p)
{
	char path[512];
	snprintf(path, sizeof(path), ROOT_PROPOSALS_DIR "%s.json", p->id);
	char *esc_title = json_escape_dup(p->title.p ? p->title.p : "");
	char *esc_extra = json_escape_dup(p->extra_info.p ? p->extra_info.p : "");
	String out; InitString(&out, 512);
	CatTemplateString(&out,
		"{\"id\":\"%s\",\"journey_id\":\"%s\",\"proposed_by\":\"%s\","
		"\"title\":\"%s\",\"extra_info\":\"%s\","
		"\"a_approved\":%s,\"b_approved\":%s,\"declined\":%s,\"finalized\":%s,"
		"\"finalized_goal_id\":\"%s\",\"proposed_at\":%lld}",
		p->id, p->journey_id, p->proposed_by,
		esc_title, esc_extra,
		p->a_approved ? "true" : "false",
		p->b_approved ? "true" : "false",
		p->declined   ? "true" : "false",
		p->finalized  ? "true" : "false",
		p->finalized_goal_id,
		(long long)p->proposed_at);
	dump_to_file(path, out.p, out.len);
	FreeString(&out);
	free(esc_title);
	free(esc_extra);
}

static _Bool load_proposal_from_file(RootGoalProposal *p, const char *path)
{
	size_t file_len = 0;
	char *buf = readFile((char *)path, &file_len);
	if (!buf || file_len == 0) { free(buf); return 0; }

	json_value *doc = json_parse(buf, file_len);
	free(buf);
	if (!doc || doc->type != json_object) {
		if (doc) json_value_free(doc);
		return 0;
	}

	memset(p, 0, sizeof(*p));
	InitString(&p->title, 64);
	InitString(&p->extra_info, 256);

	for (unsigned i = 0; i < doc->u.object.length; i++) {
		json_object_entry *e = &doc->u.object.values[i];
		json_value *v = e->value;
		if      (!strcmp(e->name, "id")               && v->type == json_string)
			strncpy(p->id,               v->u.string.ptr, ROOT_PROPOSAL_ID_SIZE - 1);
		else if (!strcmp(e->name, "journey_id")        && v->type == json_string)
			strncpy(p->journey_id,       v->u.string.ptr, JOURNEY_ID_SIZE - 1);
		else if (!strcmp(e->name, "proposed_by")       && v->type == json_string)
			strncpy(p->proposed_by,      v->u.string.ptr, USER_ID_SIZE - 1);
		else if (!strcmp(e->name, "title")             && v->type == json_string)
			CatString(&p->title,         v->u.string.ptr, v->u.string.length);
		else if (!strcmp(e->name, "extra_info")        && v->type == json_string)
			CatString(&p->extra_info,    v->u.string.ptr, v->u.string.length);
		else if (!strcmp(e->name, "a_approved")        && v->type == json_boolean)
			p->a_approved = v->u.boolean;
		else if (!strcmp(e->name, "b_approved")        && v->type == json_boolean)
			p->b_approved = v->u.boolean;
		else if (!strcmp(e->name, "declined")          && v->type == json_boolean)
			p->declined   = v->u.boolean;
		else if (!strcmp(e->name, "finalized")         && v->type == json_boolean)
			p->finalized  = v->u.boolean;
		else if (!strcmp(e->name, "finalized_goal_id") && v->type == json_string)
			strncpy(p->finalized_goal_id, v->u.string.ptr, sizeof(p->finalized_goal_id) - 1);
		else if (!strcmp(e->name, "proposed_at")       && v->type == json_integer)
			p->proposed_at = (time_t)v->u.integer;
	}

	json_value_free(doc);
	return 1;
}

static void init_proposals(void)
{
	memset(RootProposalTable, 0, sizeof(RootProposalTable));
	RootProposalCount = 0;
	ensure_directory(ROOT_PROPOSALS_DIR);
	DIR *d = opendir(ROOT_PROPOSALS_DIR);
	if (!d) return;

	struct dirent *e;
	while ((e = readdir(d)) != NULL && RootProposalCount < MAX_PENDING_ROOT_PROPOSALS) {
		size_t nlen = strlen(e->d_name);
		if (nlen < 6 || strcmp(e->d_name + nlen - 5, ".json") != 0)
			continue;
		char path[512];
		snprintf(path, sizeof(path), ROOT_PROPOSALS_DIR "%s", e->d_name);
		RootGoalProposal tmp;
		if (!load_proposal_from_file(&tmp, path)) continue;
		if (tmp.declined || tmp.finalized) {
			FreeString(&tmp.title);
			FreeString(&tmp.extra_info);
			continue;
		}
		RootProposalTable[RootProposalCount++] = tmp;
	}
	closedir(d);
}

static void free_proposals(void)
{
	for (size_t i = 0; i < RootProposalCount; i++) {
		FreeString(&RootProposalTable[i].title);
		FreeString(&RootProposalTable[i].extra_info);
	}
	RootProposalCount = 0;
}

static RootGoalProposal *find_proposal(const char *proposal_id)
{
	for (size_t i = 0; i < RootProposalCount; i++)
		if (strcmp(RootProposalTable[i].id, proposal_id) == 0)
			return &RootProposalTable[i];
	return NULL;
}

void handle_get_shared_journey(int fd, const char *journey_id)
{
	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}

	String out;
	InitString(&out, 1);
	SerializeJourney(j, &out);
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

/*
 * Pull participants out of the request body.
 *
 * Expected shape: {"user_ids": ["...", "..."]}. We assert loudly when:
 *  - the field is missing (caller should reject the request, not us)
 *  - the array is empty or larger than MAX_JOURNEY_USERS
 *  - any element is not a string
 *  - any user id does not resolve to a known central user
 *
 * On success the journey's user table is filled with each participant's
 * id, name, and description (description is the public profile summary the
 * user already pushed to central — no deep search runs here).
 *
 * Returns 1 on success, 0 if the body is missing the field (so the caller
 * can return a clean 400). All other failure modes hit change_assert: they
 * indicate the client sent inconsistent data and we want a loud stop, not
 * a silent partial journey.
 */
static _Bool populate_shared_journey_users(Journey *j, const char *body, size_t body_len)
{
	json_value *root = json_parse(body, body_len);
	change_assert(root && root->type == json_object,
		"populate_shared_journey_users: request body is not a JSON object.\n");

	json_value *arr = json_object_get(root, "user_ids");
	if (!arr) { json_value_free(root); return 0; }

	change_assert(arr->type == json_array,
		"populate_shared_journey_users: user_ids must be an array.\n");
	change_assert(arr->u.array.length >= 1,
		"populate_shared_journey_users: user_ids must list at least one participant.\n");
	change_assert(arr->u.array.length <= MAX_JOURNEY_USERS,
		"populate_shared_journey_users: too many participants (%u, max %d).\n",
		arr->u.array.length, MAX_JOURNEY_USERS);

	for (unsigned i = 0; i < arr->u.array.length; i++) {
		json_value *v = arr->u.array.values[i];
		change_assert(v && v->type == json_string,
			"populate_shared_journey_users: user_ids[%u] is not a string.\n", i);

		char user_id[USER_ID_SIZE];
		size_t id_len = v->u.string.length;
		change_assert(id_len > 0 && id_len < sizeof(user_id),
			"populate_shared_journey_users: user_ids[%u] has invalid length %zu.\n", i, id_len);
		memcpy(user_id, v->u.string.ptr, id_len);
		user_id[id_len] = '\0';

		User *u = FindUserByID(user_id);
		change_assert(u, "populate_shared_journey_users: unknown user [%s].\n", user_id);

		const char *display_name = (u->name.p && u->name.len) ? u->name.p : "";
		const char *summary      = (u->description.p && u->description.len) ? u->description.p : "";
		AddUserToJourney(j, u->id, display_name, summary);
	}

	json_value_free(root);
	return 1;
}

void handle_create_shared_journey(int fd, CentralRequest *req)
{
	if (SharedJourneyCount >= MAX_JOURNEYS) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"journey_table_full\"}");
		return;
	}

	char *name = extract_string_field(req->body, req->body_len, "name");
	if (!name || !*name) {
		free(name);
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_name\"}");
		return;
	}

	Journey *j = &SharedJourneyTable[SharedJourneyCount++];
	memset(j, 0, sizeof(*j));
	InitString(&j->title, strlen(name) + 1);
	CatString(&j->title, name, strlen(name));
	InitString(&j->extra_info, 256);
	CatFixed(&j->extra_info, DEFAULT_JOURNEY_EXTRA_INFO);
	random_id(j->id, JOURNEY_ID_SIZE);
	j->is_shared = 1;
	free(name);

	if (!populate_shared_journey_users(j, req->body, req->body_len)) {
		/* Roll back the partially-built journey: missing user_ids is a 400, not a server fault. */
		FreeString(&j->title);
		FreeString(&j->extra_info);
		memset(j, 0, sizeof(*j));
		SharedJourneyCount--;
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_user_ids\"}");
		return;
	}

	persist_shared_journey(j);

	String out;
	InitString(&out, 128);
	char *esc_title = json_escape_dup(j->title.p);
	CatTemplateString(&out, "{\"ok\":true,\"id\":\"%s\",\"title\":\"%s\",\"user_count\":%zu}",
		j->id, esc_title, j->user_count);
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
	free(esc_title);
}

/*
 * Build a compact listing of shared journeys this user participates in.
 * The full goal tree is intentionally NOT included — callers fetch
 * /journey/<id> for the heavy payload. This keeps the listing cheap to poll.
 */
void handle_list_shared_journeys(int fd, const char *query)
{
	char user_id[USER_ID_SIZE] = {0};
	if (query) {
		const char *p = strstr(query, "user_id=");
		if (p) {
			p += 8;
			size_t i = 0;
			while (*p && *p != '&' && i < USER_ID_SIZE - 1)
				user_id[i++] = *p++;
			user_id[i] = '\0';
		}
	}
	if (!user_id[0]) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}

	String out;
	InitString(&out, 512);
	CatFixed(&out, "{\"ok\":true,\"journeys\":[");

	_Bool first = 1;
	for (size_t i = 0; i < SharedJourneyCount; i++) {
		Journey *j = &SharedJourneyTable[i];
		if (FindUserIndexInJourney(j, user_id) >= MAX_JOURNEY_USERS) continue;

		char *esc_id    = json_escape_dup(j->id);
		char *esc_title = json_escape_dup(j->title.p ? j->title.p : "");

		if (!first) CatFixed(&out, ",");
		first = 0;

		size_t root_count = 0;
		for (size_t gi = 0; gi < j->goals_count; gi++)
			if (j->goals[gi] && j->goals[gi]->parent == 0) root_count++;

		CatTemplateString(&out,
			"{\"id\":\"%s\",\"title\":\"%s\",\"user_count\":%zu,\"goal_count\":%zu,\"root_count\":%zu,\"participants\":[",
			esc_id, esc_title, j->user_count, j->goals_count, root_count);

		for (size_t u = 0; u < j->user_count; u++) {
			JourneyUser *ju = &j->users[u];
			char *esc_uid  = json_escape_dup(ju->id);
			char *esc_name = json_escape_dup(ju->display_name.p ? ju->display_name.p : "");

			if (u > 0) CatFixed(&out, ",");
			CatTemplateString(&out,
				"{\"index\":%zu,\"id\":\"%s\",\"display_name\":\"%s\"}",
				u, esc_uid, esc_name);

			free(esc_uid);
			free(esc_name);
		}

		CatFixed(&out, "]}");
		free(esc_id);
		free(esc_title);
	}

	CatFixed(&out, "]}");
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

const char *EnsureSharedJourneyForPair(const char *user_a_id, const char *user_b_id)
{
	change_assert(user_a_id && *user_a_id, "EnsureSharedJourneyForPair: missing user A id.\n");
	change_assert(user_b_id && *user_b_id, "EnsureSharedJourneyForPair: missing user B id.\n");

	Journey *existing = find_shared_journey_by_pair(user_a_id, user_b_id);
	if (existing) return existing->id;

	change_assert(SharedJourneyCount < MAX_JOURNEYS,
		"EnsureSharedJourneyForPair: shared journey table is full.\n");

	User *ua = FindUserByID((char *)user_a_id);
	User *ub = FindUserByID((char *)user_b_id);
	change_assert(ua && ub,
		"EnsureSharedJourneyForPair: both users must be known to central (a=%s, b=%s).\n",
		user_a_id, user_b_id);

	String title; InitString(&title, 128);
	ai_generate_shared_journey_name(ua, ub, &title);
	change_assert(title.len > 0, "EnsureSharedJourneyForPair: title generator produced empty string.\n");

	Journey *j = &SharedJourneyTable[SharedJourneyCount++];
	memset(j, 0, sizeof(*j));
	random_id(j->id, JOURNEY_ID_SIZE);
	InitString(&j->title, title.len + 1);
	CatString(&j->title, title.p, title.len);
	InitString(&j->extra_info, 256);
	CatFixed(&j->extra_info, DEFAULT_JOURNEY_EXTRA_INFO);
	j->is_shared = 1;

	const char *name_a = (ua->name.p && ua->name.len) ? ua->name.p : "";
	const char *desc_a = (ua->description.p && ua->description.len) ? ua->description.p : "";
	const char *name_b = (ub->name.p && ub->name.len) ? ub->name.p : "";
	const char *desc_b = (ub->description.p && ub->description.len) ? ub->description.p : "";
	AddUserToJourney(j, ua->id, name_a, desc_a);
	AddUserToJourney(j, ub->id, name_b, desc_b);

	persist_shared_journey(j);
	printf("[shared-journey] auto-created [%s] (%s) for users %s + %s\n",
		j->id, title.p, ua->id, ub->id);

	FreeString(&title);
	return j->id;
}

void handle_update_shared_journey(int fd, const char *journey_id, CentralRequest *req)
{
	if (!req->body || req->body_len == 0) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}

	LoadJourneyFromBuffer(j, req->body, req->body_len);
	persist_shared_journey(j);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_propose_root_goal(int fd, const char *journey_id, CentralRequest *req)
{
	if (!req->body || req->body_len == 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}

	if (RootProposalCount >= MAX_PENDING_ROOT_PROPOSALS) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"proposal_table_full\"}");
		return;
	}

	char *user_id    = extract_string_field(req->body, req->body_len, "user_id");
	char *title      = extract_string_field(req->body, req->body_len, "title");
	char *extra_info = extract_string_field(req->body, req->body_len, "extra_info");

	if (!user_id || !*user_id || !title || !*title) {
		free(user_id); free(title); free(extra_info);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}

	size_t user_idx = FindUserIndexInJourney(j, user_id);
	if (user_idx >= MAX_JOURNEY_USERS) {
		free(user_id); free(title); free(extra_info);
		http_send_json(fd, 403, "Forbidden", "{\"ok\":false,\"error\":\"not_a_participant\"}");
		return;
	}

	RootGoalProposal *p = &RootProposalTable[RootProposalCount++];
	memset(p, 0, sizeof(*p));
	random_id(p->id, ROOT_PROPOSAL_ID_SIZE);
	strncpy(p->journey_id,  journey_id, JOURNEY_ID_SIZE - 1);
	strncpy(p->proposed_by, user_id,    USER_ID_SIZE - 1);
	InitString(&p->title, strlen(title) + 1);
	CatString(&p->title, title, strlen(title));
	InitString(&p->extra_info, 256);
	if (extra_info && *extra_info)
		CatString(&p->extra_info, extra_info, strlen(extra_info));
	p->proposed_at = change_time_now();

	if (user_idx == 0) p->a_approved = 1;
	else               p->b_approved = 1;

	persist_proposal(p);

	/* Inject a proposal message into the connection chat so the partner sees it inline. */
	if (j->user_count >= 2) {
		UserConn *conn = find_pair(j->users[0].id, j->users[1].id);
		if (conn && conn->state == CONN_CONFIRMED) {
			char *esc_proposal_id = json_escape_dup(p->id);
			char *esc_journey_id  = json_escape_dup(p->journey_id);
			char *esc_title       = json_escape_dup(c_str(&p->title));
			char *esc_extra       = json_escape_dup(c_str(&p->extra_info));
			char msg_text[MESSAGE_TEXT_SIZE];
			snprintf(msg_text, sizeof(msg_text),
				"{\"_type\":\"proposal\",\"proposal_id\":\"%s\",\"journey_id\":\"%s\","
				"\"title\":\"%s\",\"extra_info\":\"%s\"}",
				esc_proposal_id, esc_journey_id, esc_title, esc_extra);
			free(esc_proposal_id); free(esc_journey_id);
			free(esc_title);       free(esc_extra);
			SendUserConnMessage(conn->id, p->proposed_by, msg_text);
		}
	}

	free(user_id); free(title); free(extra_info);

	String out; InitString(&out, 64);
	char *esc_id = json_escape_dup(p->id);
	CatTemplateString(&out, "{\"ok\":true,\"id\":\"%s\"}", esc_id);
	free(esc_id);
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

void handle_approve_root_goal(int fd, const char *journey_id, CentralRequest *req)
{
	if (!req->body || req->body_len == 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}

	char *user_id     = extract_string_field(req->body, req->body_len, "user_id");
	char *proposal_id = extract_string_field(req->body, req->body_len, "proposal_id");

	if (!user_id || !*user_id || !proposal_id || !*proposal_id) {
		free(user_id); free(proposal_id);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}

	size_t user_idx = FindUserIndexInJourney(j, user_id);
	if (user_idx >= MAX_JOURNEY_USERS) {
		free(user_id); free(proposal_id);
		http_send_json(fd, 403, "Forbidden", "{\"ok\":false,\"error\":\"not_a_participant\"}");
		return;
	}

	RootGoalProposal *p = find_proposal(proposal_id);
	if (!p || strcmp(p->journey_id, journey_id) != 0 || p->declined || p->finalized) {
		free(user_id); free(proposal_id);
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"proposal_not_found\"}");
		return;
	}

	if (user_idx == 0) p->a_approved = 1;
	else               p->b_approved = 1;

	persist_proposal(p);
	free(user_id); free(proposal_id);

	_Bool both = p->a_approved && p->b_approved;
	String out; InitString(&out, 64);
	CatTemplateString(&out, "{\"ok\":true,\"both_approved\":%s}", both ? "true" : "false");
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

void handle_decline_root_goal(int fd, const char *journey_id, CentralRequest *req)
{
	if (!req->body || req->body_len == 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}

	char *user_id     = extract_string_field(req->body, req->body_len, "user_id");
	char *proposal_id = extract_string_field(req->body, req->body_len, "proposal_id");

	if (!user_id || !*user_id || !proposal_id || !*proposal_id) {
		free(user_id); free(proposal_id);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}

	if (FindUserIndexInJourney(j, user_id) >= MAX_JOURNEY_USERS) {
		free(user_id); free(proposal_id);
		http_send_json(fd, 403, "Forbidden", "{\"ok\":false,\"error\":\"not_a_participant\"}");
		return;
	}

	RootGoalProposal *p = find_proposal(proposal_id);
	if (!p || strcmp(p->journey_id, journey_id) != 0 || p->finalized) {
		free(user_id); free(proposal_id);
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"proposal_not_found\"}");
		return;
	}

	p->declined = 1;
	persist_proposal(p);
	free(user_id); free(proposal_id);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_finalize_root_goal(int fd, const char *journey_id, CentralRequest *req)
{
	if (!req->body || req->body_len == 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}
	(void)j;

	char *proposal_id = extract_string_field(req->body, req->body_len, "proposal_id");
	char *goal_id     = extract_string_field(req->body, req->body_len, "goal_id");

	if (!proposal_id || !*proposal_id || !goal_id || !*goal_id) {
		free(proposal_id); free(goal_id);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}

	RootGoalProposal *p = find_proposal(proposal_id);
	if (!p || strcmp(p->journey_id, journey_id) != 0 || p->declined || p->finalized) {
		free(proposal_id); free(goal_id);
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"proposal_not_found\"}");
		return;
	}

	change_assert(p->a_approved && p->b_approved,
		"handle_finalize_root_goal: proposal [%s] finalized without both approvals.\n", p->id);

	p->finalized = 1;
	strncpy(p->finalized_goal_id, goal_id, sizeof(p->finalized_goal_id) - 1);
	persist_proposal(p);
	free(proposal_id); free(goal_id);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_list_root_proposals(int fd, const char *journey_id, const char *query)
{
	(void)query;

	Journey *j = find_shared_journey(journey_id);
	if (!j) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"journey_not_found\"}");
		return;
	}
	(void)j;

	String out; InitString(&out, 512);
	CatFixed(&out, "{\"ok\":true,\"proposals\":[");
	_Bool first = 1;

	for (size_t i = 0; i < RootProposalCount; i++) {
		RootGoalProposal *p = &RootProposalTable[i];
		if (strcmp(p->journey_id, journey_id) != 0) continue;
		if (p->declined) continue;

		char *esc_id    = json_escape_dup(p->id);
		char *esc_by    = json_escape_dup(p->proposed_by);
		char *esc_title = json_escape_dup(p->title.p ? p->title.p : "");
		char *esc_extra = json_escape_dup(p->extra_info.p ? p->extra_info.p : "");

		if (!first) CatFixed(&out, ",");
		first = 0;

		CatTemplateString(&out,
			"{\"id\":\"%s\",\"proposed_by\":\"%s\",\"title\":\"%s\",\"extra_info\":\"%s\","
			"\"a_approved\":%s,\"b_approved\":%s,\"finalized\":%s,"
			"\"finalized_goal_id\":\"%s\",\"proposed_at\":%lld}",
			esc_id, esc_by, esc_title, esc_extra,
			p->a_approved ? "true" : "false",
			p->b_approved ? "true" : "false",
			p->finalized  ? "true" : "false",
			p->finalized_goal_id,
			(long long)p->proposed_at);

		free(esc_id); free(esc_by); free(esc_title); free(esc_extra);
	}

	CatFixed(&out, "]}");
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
}
