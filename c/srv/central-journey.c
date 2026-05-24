#include "central-internal.h"
#include "central-server.h"
#include "journey.h"
#include "http-util.h"
#include "util.h"
#include "config.h"
#include "ne/goal/goal.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define SHARED_JOURNEYS_DIR PROJECT_ROOT "shared-journeys/"

static Journey SharedJourneyTable[MAX_JOURNEYS];
static size_t  SharedJourneyCount = 0;

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
	ensure_directory(SHARED_JOURNEYS_DIR);
	load_directory_journeys(SHARED_JOURNEYS_DIR, SharedJourneyTable, &SharedJourneyCount, MAX_JOURNEYS);
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
}

static Journey *find_shared_journey(const char *id)
{
	for (size_t i = 0; i < SharedJourneyCount; i++)
		if (strcmp(SharedJourneyTable[i].id, id) == 0)
			return &SharedJourneyTable[i];
	return NULL;
}

static void persist_shared_journey(const Journey *j)
{
	char path[512];
	snprintf(path, sizeof(path), SHARED_JOURNEYS_DIR "%s.json", j->id);
	ExportJourneyTo(j, path);
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
	free(name);

	persist_shared_journey(j);

	String out;
	InitString(&out, 128);
	char *esc_title = json_escape_dup(j->title.p);
	CatTemplateString(&out, "{\"ok\":true,\"id\":\"%s\",\"title\":\"%s\"}", j->id, esc_title);
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
	free(esc_title);
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
