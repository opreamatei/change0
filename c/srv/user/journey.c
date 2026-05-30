#include "journey.h"
#include "http-util.h"
#include "goal-util.h"
#include "globals.h"
#include "config.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>

Journey JourneyTable[MAX_JOURNEYS] = {0};
size_t JourneyTableCount = 0;

_Bool MatchesJourneyID(Journey *j, const char *id) {
	change_assert(j && id, "MatchesJourneyID: NULL argument\n");
	return strcmp(j->id, id) == 0;
}

Journey *FindJourneyByID(const char *id) {
	for (size_t i = 0; i < JourneyTableCount; i++) {
		Journey *j = &JourneyTable[i];
		if (MatchesJourneyID(j, id))
			return j;
	}
	return NULL;
}

static Journey *alloc_journey_slot(void) {
	change_assert(JourneyTableCount < MAX_JOURNEYS, "Max journeys limit reached");
	Journey *j = &JourneyTable[JourneyTableCount++];
	memset(j, 0, sizeof(*j));
	InitString(&j->title, 64);
	InitString(&j->extra_info, 256);
	return j;
}

Journey *AllocJourney(void) {
	return alloc_journey_slot();
}

Journey *NewJourney(String *name) {
	Journey *j = alloc_journey_slot();
	random_id(j->id, JOURNEY_ID_SIZE);
	CatString(&j->title, name->p, name->len);
	CatFixed(&j->extra_info, DEFAULT_JOURNEY_EXTRA_INFO);
	return j;
}

void AddGoalToJourney(Journey *j, Goal *g) {
	change_assert(j->goals_count < MAX_GOALS_PER_JOURNEY, "Max goals per journey reached [%s]\n", j->title.p);
	g->localIndex = j->goals_count + 1;
	strncpy(g->journey_id, j->id, JOURNEY_ID_SIZE - 1);
	g->journey_id[JOURNEY_ID_SIZE - 1] = '\0';
	j->goals[j->goals_count++] = g;
}

void AddUserToJourney(Journey *j, const char *user_id, const char *display_name, const char *context_summary) {
	change_assert(j, "AddUserToJourney: NULL journey.\n");
	change_assert(user_id && *user_id, "AddUserToJourney: empty user id.\n");
	change_assert(j->user_count < MAX_JOURNEY_USERS, "AddUserToJourney: journey [%s] user table is full.\n", j->id);

	JourneyUser *ju = &j->users[j->user_count];
	memset(ju, 0, sizeof(*ju));

	size_t id_len = strlen(user_id);
	change_assert(id_len < sizeof(ju->id), "AddUserToJourney: user id too long.\n");
	memcpy(ju->id, user_id, id_len);
	ju->id[id_len] = '\0';

	size_t name_len = display_name ? strlen(display_name) : 0;
	InitString(&ju->display_name, name_len + 1);
	if (name_len) CatString(&ju->display_name, (char *)display_name, name_len);

	size_t ctx_len = context_summary ? strlen(context_summary) : 0;
	InitString(&ju->context_summary, ctx_len + 1);
	if (ctx_len) CatString(&ju->context_summary, (char *)context_summary, ctx_len);

	j->user_count++;
}

size_t FindUserIndexInJourney(const Journey *j, const char *user_id) {
	if (!j || !user_id || !*user_id) return MAX_JOURNEY_USERS;
	for (size_t i = 0; i < j->user_count; i++)
		if (strcmp(j->users[i].id, user_id) == 0) return i;
	return MAX_JOURNEY_USERS;
}

void RemoveGoalFromJourneys(Goal *g) {
	if (!g || !g->journey_id[0] || g->localIndex == 0) return;
	Journey *j = FindJourneyByID(g->journey_id);
	if (!j || g->localIndex > j->goals_count) return;
	j->goals[g->localIndex - 1] = NULL;
}

Goal *FindGoalFromIndex(const char *journey_id, size_t index) {
	if (!journey_id || !*journey_id || index == 0) return NULL;
	Journey *j = FindJourneyByID(journey_id);
	if (!j || index > j->goals_count) return NULL;
	return j->goals[index - 1];
}

Goal **GetGoalsSorted(size_t *out_count, const char *journey_id) {
	size_t total = 0;
	for (size_t i = 0; i < JourneyTableCount; i++) {
		if (strcmp(JourneyTable[i].id, journey_id) != 0) continue;
		for (size_t k = 0; k < JourneyTable[i].goals_count; k++)
			if (JourneyTable[i].goals[k]) total++;
	}

	*out_count = total;
	if (total == 0)
		return NULL;

	Goal **arr = malloc(total * sizeof(Goal *));
	change_assert(arr, "GetGoalsSorted: malloc failed.\n");

	size_t w = 0;
	for (size_t i = 0; i < JourneyTableCount; i++) {
		Journey *j = &JourneyTable[i];
		if (strcmp(j->id, journey_id) != 0) continue;
		for (size_t k = 0; k < j->goals_count; k++)
			if (j->goals[k]) arr[w++] = j->goals[k];
	}

	for (size_t i = 1; i < w; i++) {
		Goal *key = arr[i];
		size_t j = i;
		while (j > 0 && arr[j - 1]->localIndex > key->localIndex) {
			arr[j] = arr[j - 1];
			j--;
		}
		arr[j] = key;
	}

	return arr;
}

void ClearAllJourneyGoals(void) {
	for (size_t i = 0; i < JourneyTableCount; i++) {
		Journey *j = &JourneyTable[i];
		for (size_t k = 0; k < j->goals_count; k++) {
			Goal *g = j->goals[k];
			if (!g) continue;
			if (g->title.p) FreeString(&g->title);
			if (g->extra_info.p) FreeString(&g->extra_info);
			if (g->tips.p) FreeString(&g->tips);
			free(g->subgoals);
			free(g);
			j->goals[k] = NULL;
		}
		j->goals_count = 0;
	}
}

static const char *GetJourneyTitleByID(const char *id) {
	Journey *j = FindJourneyByID((char *)id);
	return j ? j->title.p : "";
}

static const char *GetJourneyExtraInfoByID(const char *id) {
	Journey *j = FindJourneyByID((char *)id);
	return j ? j->extra_info.p : "";
}

static void free_journey_users(Journey *j) {
	for (size_t k = 0; k < j->user_count; k++) {
		JourneyUser *ju = &j->users[k];
		if (ju->display_name.p)   FreeString(&ju->display_name);
		if (ju->context_summary.p) FreeString(&ju->context_summary);
	}
	j->user_count = 0;
}

static void FreeJourneyEntry(Journey *j) {
	for (size_t k = 0; k < j->goals_count; k++) {
		Goal *g = j->goals[k];
		if (!g) continue;
		if (g->title.p) FreeString(&g->title);
		if (g->extra_info.p) FreeString(&g->extra_info);
			if (g->tips.p) FreeString(&g->tips);
		free(g->subgoals);
		free(g);
	}
	j->goals_count = 0;
	free_journey_users(j);
	FreeString(&j->title);
	FreeString(&j->extra_info);
}

void InitJourneySystem(void) {
	JourneyTableCount = 0;
	SetGlobalPointerF("journey_title", GetJourneyTitleByID);
	SetGlobalPointerF("journey_info",  GetJourneyExtraInfoByID);
}

void FreeJourneySystem(void) {
	for (size_t i = 0; i < JourneyTableCount; i++)
		FreeJourneyEntry(&JourneyTable[i]);
	JourneyTableCount = 0;
}

static void serialize_journey_users(const Journey *j, String *out) {
	CatFixed(out, "[");
	for (size_t i = 0; i < j->user_count; i++) {
		const JourneyUser *ju = &j->users[i];
		char *esc_id   = json_escape_dup(ju->id);
		char *esc_name = json_escape_dup(ju->display_name.p   ? ju->display_name.p   : "");
		char *esc_ctx  = json_escape_dup(ju->context_summary.p ? ju->context_summary.p : "");

		if (i > 0) CatFixed(out, ",");
		CatTemplateString(out,
			"{\"id\":\"%s\",\"display_name\":\"%s\",\"context_summary\":\"%s\"}",
			esc_id, esc_name, esc_ctx);

		free(esc_id);
		free(esc_name);
		free(esc_ctx);
	}
	CatFixed(out, "]");
}

void SerializeJourney(const Journey *j, String *out) {
	char *esc_id    = json_escape_dup(j->id);
	char *esc_title = json_escape_dup(j->title.p ? j->title.p : "");
	char *esc_extra = json_escape_dup(j->extra_info.p ? j->extra_info.p : "");

	String goals_buf; InitString(&goals_buf, 512);
	SerializeGoalList((Goal **)j->goals, j->goals_count, &goals_buf);

	String users_buf; InitString(&users_buf, 256);
	serialize_journey_users(j, &users_buf);

	ResizeString(out, 128 + j->title.len + j->extra_info.len + goals_buf.len + users_buf.len);
	CatTemplateString(out,
		"{\"id\":\"%s\",\"title\":\"%s\",\"extra_info\":\"%s\",\"is_shared\":%s,\"users\":%s,\"goals\":%s}",
		esc_id, esc_title, esc_extra,
		j->is_shared ? "true" : "false",
		users_buf.p, goals_buf.p);

	FreeString(&users_buf);
	FreeString(&goals_buf);
	free(esc_id);
	free(esc_title);
	free(esc_extra);
}

void ExportJourneyTo(const Journey *j, const char *path) {
	String out; InitString(&out, 1);
	SerializeJourney(j, &out);
	dump_to_file(path, out.p, out.len);
	FreeString(&out);
}

void LoadJourneyFromBuffer(Journey *j, const char *buf, size_t len) {
	json_value *doc = json_parse(buf, len);
	change_assert(doc && doc->type == json_object, "Journey buffer is not a JSON object.\n");

	json_value *id_v         = json_object_get(doc, "id");
	json_value *title_v      = json_object_get(doc, "title");
	json_value *extra_info_v = json_object_get(doc, "extra_info");
	json_value *is_shared_v  = json_object_get(doc, "is_shared");
	json_value *users_v      = json_object_get(doc, "users");
	json_value *goals_v      = json_object_get(doc, "goals");

	if (id_v && id_v->type == json_string) {
		strncpy(j->id, id_v->u.string.ptr, JOURNEY_ID_SIZE - 1);
		j->id[JOURNEY_ID_SIZE - 1] = '\0';
	}
	if (title_v && title_v->type == json_string) {
		EmptyString(&j->title);
		CatString(&j->title, title_v->u.string.ptr, title_v->u.string.length);
	}
	if (extra_info_v && extra_info_v->type == json_string) {
		EmptyString(&j->extra_info);
		CatString(&j->extra_info, extra_info_v->u.string.ptr, extra_info_v->u.string.length);
	}
	if (is_shared_v && is_shared_v->type == json_boolean)
		j->is_shared = is_shared_v->u.boolean ? 1 : 0;

	/* Replace any previously loaded participants. */
	free_journey_users(j);
	if (users_v && users_v->type == json_array) {
		change_assert(users_v->u.array.length <= MAX_JOURNEY_USERS,
			"LoadJourneyFromBuffer: journey [%s] has too many participants (%u).\n",
			j->id, users_v->u.array.length);

		for (unsigned ui = 0; ui < users_v->u.array.length; ui++) {
			json_value *item = users_v->u.array.values[ui];
			change_assert(item && item->type == json_object,
				"LoadJourneyFromBuffer: participant %u is not an object.\n", ui);

			const char *uid_s = NULL, *name_s = NULL, *ctx_s = NULL;
			for (unsigned fi = 0; fi < item->u.object.length; fi++) {
				json_object_entry *e = &item->u.object.values[fi];
				if (e->value->type != json_string) continue;
				if      (!strcmp(e->name, "id"))               uid_s  = e->value->u.string.ptr;
				else if (!strcmp(e->name, "display_name"))     name_s = e->value->u.string.ptr;
				else if (!strcmp(e->name, "context_summary"))  ctx_s  = e->value->u.string.ptr;
			}
			change_assert(uid_s && *uid_s,
				"LoadJourneyFromBuffer: participant %u is missing id.\n", ui);
			AddUserToJourney(j, uid_s, name_s ? name_s : "", ctx_s ? ctx_s : "");
		}
	}

	if (!goals_v || goals_v->type != json_array) {
		json_value_free(doc);
		return;
	}

	/* Free any previously loaded goals before reloading. */
	for (size_t k = 0; k < j->goals_count; k++) {
		Goal *g = j->goals[k];
		if (!g) continue;
		if (g->title.p) FreeString(&g->title);
		if (g->extra_info.p) FreeString(&g->extra_info);
			if (g->tips.p) FreeString(&g->tips);
		free(g->subgoals);
		free(g);
	}
	j->goals_count = 0;

	Goal  *temp[MAX_GOALS_PER_JOURNEY];
	size_t old_idx[MAX_GOALS_PER_JOURNEY];
	size_t loaded = 0;

	for (unsigned i = 0; i < goals_v->u.array.length; i++) {
		json_value *item = goals_v->u.array.values[i];
		if (!item || item->type != json_object) continue;

		Goal *g = calloc(1, sizeof(Goal));
		change_assert(g, "Failed to allocate goal while loading journey.\n");
		g->assigned_to = JOURNEY_USER_UNASSIGNED;

		json_value *subgoals_json = NULL;
		const char *title = NULL, *extra_info = NULL, *id = NULL, *tips = NULL;
		size_t saved_local_index = 0;

		for (unsigned fi = 0; fi < item->u.object.length; fi++) {
			json_object_entry *e = &item->u.object.values[fi];
			json_value *v = e->value;

			if (!strcmp(e->name, "title")) {
				title = v->u.string.ptr;
			} else if (!strcmp(e->name, "extra_info")) {
				extra_info = v->u.string.ptr;
			} else if (!strcmp(e->name, "tips")) {
				if (v->type == json_string) tips = v->u.string.ptr;
			} else if (!strcmp(e->name, "id")) {
				id = v->u.string.ptr;
			} else if (!strcmp(e->name, "start_date")) {
				g->start_date = (time_t)v->u.integer;
			} else if (!strcmp(e->name, "end_date")) {
				g->end_date = (time_t)v->u.integer;
			} else if (!strcmp(e->name, "required_time")) {
				g->required_time = (time_t)v->u.integer;
			} else if (!strcmp(e->name, "min_pause_to_next")) {
				g->minPauseToNext = (time_t)v->u.integer;
			} else if (!strcmp(e->name, "pause_to_next")) {
				g->pauseToNext = (time_t)v->u.integer;
			} else if (!strcmp(e->name, "parent")) {
				g->parent = (size_t)v->u.integer;
			} else if (!strcmp(e->name, "prev")) {
				g->prev = (size_t)v->u.integer;
			} else if (!strcmp(e->name, "next")) {
				g->next = (size_t)v->u.integer;
			} else if (!strcmp(e->name, "localIndex")) {
				saved_local_index = (size_t)(v->u.integer > 0 ? v->u.integer : 0);
			} else if (!strcmp(e->name, "depth")) {
				g->depth = (size_t)v->u.integer;
			} else if (!strcmp(e->name, "retry_depth")) {
				g->retry_depth = (size_t)v->u.integer;
			} else if (!strcmp(e->name, "priority")) {
				g->priority = (size_t)v->u.integer;
			} else if (!strcmp(e->name, "assigned_to")) {
				change_assert(v->u.integer >= 0 && v->u.integer <= 0xFF,
					"Goal assigned_to out of byte range in journey file.\n");
				g->assigned_to = (uint8_t)v->u.integer;
			} else if (!strcmp(e->name, "subgoals")) {
				subgoals_json = v;
			}
		}

		change_assert(title && extra_info && id && subgoals_json,
			"Required goal fields missing in journey file.\n");

		InitString(&g->title, strlen(title) + 1);
		CatString(&g->title, (char *)title, strlen(title));

		InitString(&g->extra_info, strlen(extra_info) + 1);
		CatString(&g->extra_info, (char *)extra_info, strlen(extra_info));

		InitString(&g->tips, (tips ? strlen(tips) : 0) + 1);
		if (tips) CatString(&g->tips, (char *)tips, strlen(tips));

		memset(g->id, 0, sizeof(g->id));
		strncpy(g->id, id, GOAL_ID_SIZE);
		g->id[GOAL_ID_SIZE] = '\0';

		g->subgoals_len = subgoals_json->u.array.length;
		if (g->subgoals_len > 0) {
			g->subgoals = malloc(sizeof(size_t) * g->subgoals_len);
			change_assert(g->subgoals, "Failed to allocate subgoals while loading journey.\n");
			for (unsigned si = 0; si < subgoals_json->u.array.length; si++) {
				json_value *sv = subgoals_json->u.array.values[si];
				change_assert(sv && sv->type == json_integer && sv->u.integer >= 0,
					"Subgoal ref invalid in journey file.\n");
				g->subgoals[si] = (size_t)sv->u.integer;
			}
		}

		change_assert(loaded < MAX_GOALS_PER_JOURNEY, "Too many goals in journey file.\n");
		old_idx[loaded] = saved_local_index;
		temp[loaded++] = g;
	}

	/* Add to journey — assigns fresh position-based localIndex. */
	for (size_t i = 0; i < loaded; i++)
		AddGoalToJourney(j, temp[i]);

	/* Remap saved cross-references to new localIndex values. */
	for (size_t i = 0; i < loaded; i++) {
		Goal *g = temp[i];
		for (size_t m = 0; m < loaded; m++) {
			if (old_idx[m] == g->parent && g->parent)  { g->parent = temp[m]->localIndex; break; }
		}
		for (size_t m = 0; m < loaded; m++) {
			if (old_idx[m] == g->prev && g->prev)       { g->prev   = temp[m]->localIndex; break; }
		}
		for (size_t m = 0; m < loaded; m++) {
			if (old_idx[m] == g->next && g->next)       { g->next   = temp[m]->localIndex; break; }
		}
		for (size_t si = 0; si < g->subgoals_len; si++)
			for (size_t m = 0; m < loaded; m++)
				if (old_idx[m] == g->subgoals[si]) { g->subgoals[si] = temp[m]->localIndex; break; }
	}

	json_value_free(doc);
}

void LoadJourneyFromFile(Journey *j, const char *path) {
	size_t file_len = 0;
	char *buff = readFile((char *)path, &file_len);
	if (massert(buff, "Couldn't load journey from file.\n"))
		return;
	LoadJourneyFromBuffer(j, buff, file_len);
	free(buff);
}


Journey *FetchSharedJourney(const char *journey_id) {
	int fd = central_connect();
	if (massert(fd >= 0, "FetchSharedJourney: couldn't connect to central server.\n"))
		return NULL;

	char req[256];
	int req_len = snprintf(req, sizeof(req),
		"GET /journey/%s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
		journey_id);
	http_send_all(fd, req, (size_t)req_len);

	size_t body_len = 0;
	char *body = central_recv_body(fd, &body_len);
	close(fd);

	if (!body || body_len == 0) { free(body); return NULL; }

	/* Check for existing slot first */
	Journey *j = FindJourneyByID(journey_id);
	if (!j) {
		change_assert(JourneyTableCount < MAX_JOURNEYS, "JourneyTable full.\n");
		j = &JourneyTable[JourneyTableCount++];
		memset(j, 0, sizeof(*j));
		InitString(&j->title, 64);
		InitString(&j->extra_info, 256);
	}

	LoadJourneyFromBuffer(j, body, body_len);
	j->is_shared = 1;
	free(body);
	return j;
}

void PushJourneyToCentral(const Journey *j) {
	String body; InitString(&body, 1);
	SerializeJourney(j, &body);

	int fd = central_connect();
	if (massert(fd >= 0, "PushJourneyToCentral: couldn't connect to central server.\n")) {
		FreeString(&body);
		return;
	}

	char header[256];
	int header_len = snprintf(header, sizeof(header),
		"POST /journey/%s HTTP/1.1\r\nHost: 127.0.0.1\r\n"
		"Content-Type: application/json\r\nContent-Length: %zu\r\n"
		"Connection: close\r\n\r\n",
		j->id, body.len);

	http_send_all(fd, header, (size_t)header_len);
	http_send_all(fd, body.p, body.len);
	close(fd);

	FreeString(&body);
}
