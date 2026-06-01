#include "user-management.h"
#include "journey.h"
#include "config.h"
#include "ne/graph/graph-export.h"
#include "ne/input/json-to-graph.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

extern User *alloc_user_slot(void);

/* Curated identity-colour palette: distinct, legible-on-dark hues. A new user
 * is assigned one at random; it is later overwritten by the dominant colour of
 * their profile picture. Kept here (not config) since it is purely cosmetic. */
static const char *USER_COLOR_PALETTE[] = {
	"#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6",
	"#ec4899", "#14b8a6", "#eab308", "#6366f1", "#ef4444",
	"#22c55e", "#0ea5e9",
};

/* Pick a palette colour into u->color. The user id is already random, so a byte
 * of it gives a stable-yet-arbitrary index without needing a separate RNG. */
static void assign_random_user_color(User *u)
{
	size_t n = sizeof(USER_COLOR_PALETTE) / sizeof(USER_COLOR_PALETTE[0]);
	size_t idx = (unsigned char)u->id[1] % n;
	EmptyString(&u->color);
	CatString(&u->color, USER_COLOR_PALETTE[idx], strlen(USER_COLOR_PALETTE[idx]));
}

static void ensure_dir(const char *path)
{
	if (mkdir(path, 0755) != 0 && errno != EEXIST)
		change_assert(0, "Could not create directory.\n");
}

static void make_user_dir(const User *u)
{
	char dir[USER_DIRECTORY_SIZE];
	GetUserDirectory(u, dir);
	ensure_dir(DATA_ROOT_DIRECTORY);
	ensure_dir(USER_DATA_DIRECTORY);
	ensure_dir(dir);
}

static void write_user_meta(const User *u)
{
	char path[USER_DIRECTORY_SIZE];
	String out;
	char *esc_name;
	char *esc_desc;

	GetUserMetaPath(u, path);
	esc_name = json_escape_dup(u->name.p ? u->name.p : "");
	esc_desc = json_escape_dup(u->description.p ? u->description.p : "");

	InitString(&out, 512 + (u->description.p ? u->description.len : 0));
	CatTemplateString(&out,
		"{\"id\":\"%s\",\"name\":\"%s\",\"port\":%d,"
		"\"discoverable\":%s,\"description\":\"%s\",\"color\":\"%s\",\"journeys\":[",
		u->id, esc_name, u->port,
		u->discoverable ? "true" : "false", esc_desc,
		u->color.p ? u->color.p : "");
	for (size_t i = 0; i < u->journey_count; i++) {
		if (i > 0) CatFixed(&out, ",");
		CatTemplateString(&out, "\"%s\"", u->journeys[i]);
	}
	CatFixed(&out, "]}\n");

	dump_to_file(path, out.p, out.len);

	FreeString(&out);
	free(esc_name);
	free(esc_desc);
}

static void load_user_journeys(User *u, json_value *journeys_v)
{
	if (!journeys_v || journeys_v->type != json_array) return;

	for (unsigned i = 0; i < journeys_v->u.array.length && u->journey_count < USER_MAX_JOURNEYS; i++) {
		json_value *jid_v = journeys_v->u.array.values[i];
		if (!jid_v || jid_v->type != json_string) continue;
		if (jid_v->u.string.length == 0 || jid_v->u.string.length >= JOURNEY_ID_SIZE) continue;

		Journey *j = AllocJourney();
		strncpy(j->id, jid_v->u.string.ptr, JOURNEY_ID_SIZE - 1);
		j->id[JOURNEY_ID_SIZE - 1] = '\0';

		char jpath[USER_DIRECTORY_SIZE];
		GetUserJourneyPath(u, j->id, jpath);
		LoadJourneyFromFile(j, jpath);

		memcpy(u->journeys[u->journey_count], j->id, JOURNEY_ID_SIZE);
		u->journey_count++;
	}
}

static _Bool load_user_from_dir(const char *id_dirname)
{
	size_t id_len = strlen(id_dirname);
	if (id_len == 0 || id_len >= USER_ID_SIZE)
		return 0;

	char meta_path[USER_DIRECTORY_SIZE];
	snprintf(meta_path, sizeof(meta_path),
		USER_DATA_DIRECTORY "%s/" USER_META_FILENAME, id_dirname);

	size_t file_len = 0;
	char *file_data = readFile(meta_path, &file_len);
	if (!file_data)
		return 0;

	User *u = alloc_user_slot();
	memcpy(u->id, id_dirname, id_len + 1);

	json_value *doc = json_parse(file_data, file_len);
	if (doc && doc->type == json_object) {
		json_value *v;

		v = json_object_get(doc, "name");
		if (v && v->type == json_string)
			CatString(&u->name, v->u.string.ptr, v->u.string.length);

		v = json_object_get(doc, "port");
		if (v && v->type == json_integer)
			u->port = (int)v->u.integer;

		v = json_object_get(doc, "discoverable");
		if (v && v->type == json_boolean)
			u->discoverable = v->u.boolean ? 1 : 0;

		v = json_object_get(doc, "description");
		if (v && v->type == json_string)
			CatString(&u->description, v->u.string.ptr, v->u.string.length);

		v = json_object_get(doc, "color");
		if (v && v->type == json_string && v->u.string.length > 0)
			CatString(&u->color, v->u.string.ptr, v->u.string.length);

		load_user_journeys(u, json_object_get(doc, "journeys"));
	}

	/* Legacy accounts predate identity colours — assign one now (and persist it
	 * below via the caller's normal save paths) so every user has a colour. */
	if (!u->color.p || u->color.len == 0)
		assign_random_user_color(u);

	if (doc) json_value_free(doc);
	free(file_data);

	char gr_path[USER_DIRECTORY_SIZE];
	GetUserGraphExportPath(u, gr_path);
	if (access(gr_path, R_OK) == 0)
		LoadGraphFromFile(gr_path, &u->nodes);

	SetupContextNodes(&u->nodes);

	return 1;
}

static void load_users_from_disk(void)
{
	DIR *d;
	struct dirent *e;
	struct stat st;
	char child[USER_DIRECTORY_SIZE];

	d = opendir(USER_DATA_DIRECTORY);
	if (!d)
		return;

	while ((e = readdir(d)) != NULL) {
		if (e->d_name[0] == '.')
			continue;

		snprintf(child, sizeof(child), USER_DATA_DIRECTORY "%s", e->d_name);
		if (stat(child, &st) != 0 || !S_ISDIR(st.st_mode))
			continue;

		if (USER_COUNT >= MAX_USERS)
			break;

		load_user_from_dir(e->d_name);
	}

	closedir(d);
}

User *NewUser(const String *name)
{
	User *u = alloc_user_slot();

	random_id(u->id, USER_ID_SIZE);
	assign_random_user_color(u);

	if (name && name->p && name->len > 0)
		CatString(&u->name, name->p, name->len);

	u->port = 9000 + (int)(USER_COUNT - 1);
	u->journey_count = 0;

	String journey_title;
	InitString(&journey_title, FSIZE(DEFAULT_JOURNEY_TITLE) + 2);
	CatFixed(&journey_title, DEFAULT_JOURNEY_TITLE);
	Journey *j = NewJourney(&journey_title);
	FreeString(&journey_title);
	AddToJourney(u, j);

	SetupContextNodes(&u->nodes);

	make_user_dir(u);
	write_user_meta(u);

	return u;
}

void InitUserSystem(void)
{
	USER_COUNT = 0;

	InitJourneySystem();

	ensure_dir(USER_DATA_DIRECTORY);
	load_users_from_disk();
}

void FreeUserSystem(void)
{
	for (size_t i = 0; i < USER_COUNT; i++)
		FreeUser(&USER_TABLE[i]);

	USER_COUNT = 0;
}

void SaveUser(User *u)
{
	write_user_meta(u);

	char gr_path[USER_DIRECTORY_SIZE];
	GetUserGraphExportPath(u, gr_path);
	ExportGraphTo(gr_path, &u->nodes);

	for (size_t i = 0; i < u->journey_count; i++) {
		Journey *j = FindJourneyByID(u->journeys[i]);
		if (!j) continue;
		char jpath[USER_DIRECTORY_SIZE];
		GetUserJourneyPath(u, j->id, jpath);
		ExportJourneyTo(j, jpath);
	}
}
