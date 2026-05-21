#include "user-management.h"
#include "journey.h"
#include "config.h"

extern _Bool ExportGraphTo(char *path);

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/types.h>

User USER_TABLE[MAX_USERS] = {0};
size_t USER_COUNT = 0;

static void ensure_dir(const char *path)
{
	if (mkdir(path, 0755) != 0 && errno != EEXIST)
		change_assert(0, "Could not create directory.\n");
}

static void make_user_dir(const User *u)
{
	char dir[USER_DIRECTORY_SIZE];
	GetUserDirectory(u, dir);
	ensure_dir(USER_DATA_DIRECTORY);
	ensure_dir(dir);
}

static void write_user_meta(const User *u)
{
	char path[USER_DIRECTORY_SIZE];
	String out;
	char *esc_name;

	GetUserMetaPath(u, path);
	esc_name = json_escape_dup(u->name.p ? u->name.p : "");

	InitString(&out, 512);
	CatTemplateString(&out, "{\"id\":\"%s\",\"name\":\"%s\",\"journeys\":[", u->id, esc_name);
	for (size_t i = 0; i < u->journey_count; i++) {
		if (i > 0) CatFixed(&out, ",");
		CatTemplateString(&out, "\"%s\"", u->journeys[i]);
	}
	CatFixed(&out, "]}\n");

	dump_to_file(path, out.p, out.len);

	FreeString(&out);
	free(esc_name);
}

_Bool MatchesUserID(User *u, user_id_like id)
{
	return strcmp(u->id, id) == 0;
}

User *FindUserByID(user_id_like id)
{
	for (size_t i = 0; i < USER_COUNT; i++) {
		User *u = &USER_TABLE[i];
		if (MatchesUserID(u, id))
			return u;
	}
	return NULL;
}

User *FindUserByName(const char *name)
{
	if (!name)
		return NULL;

	for (size_t i = 0; i < USER_COUNT; i++) {
		User *u = &USER_TABLE[i];
		if (u->name.p && strcmp(u->name.p, name) == 0)
			return u;
	}
	return NULL;
}

/*
 * Allocate a fresh slot. Caller fills id and name (or supplies name and
 * leaves id-generation to NewUser).
 */
static User *alloc_user_slot(void)
{
	change_assert(USER_COUNT < MAX_USERS, "Max users limit reached");

	User *u = &USER_TABLE[USER_COUNT];

	memset(u, 0, sizeof(*u));
	InitString(&u->name, 128);

	USER_COUNT++;

	return u;
}

User *NewUser(const String *name)
{
	User *u = alloc_user_slot();

	random_id(u->id, USER_ID_SIZE);

	if (name && name->p && name->len > 0)
		CatString(&u->name, name->p, name->len);

	u->journey_count = 0;

	String journey_title;
	InitString(&journey_title, FSIZE(DEFAULT_JOURNEY_TITLE) + 2);
	CatFixed(&journey_title, DEFAULT_JOURNEY_TITLE);
	Journey *j = NewJourney(&journey_title);
	FreeString(&journey_title);
	AddToJourney(u, j);

	make_user_dir(u);
	write_user_meta(u);

	return u;
}

void FreeUser(User *user)
{
	FreeString(&user->name);
}

/*
 * Load a User from <user-data>/<id>/.meta . The directory name is taken
 * as authoritative for the id; the .meta is only consulted for the name.
 */
static _Bool load_user_from_dir(const char *id_dirname)
{
	char meta_path[USER_DIRECTORY_SIZE];
	size_t file_len = 0;
	char *file_data;
	json_value *doc = NULL;
	json_value *name_v;
	User *u;
	size_t id_len = strlen(id_dirname);

	if (id_len == 0 || id_len >= USER_ID_SIZE)
		return 0;

	snprintf(meta_path, sizeof(meta_path),
		USER_DATA_DIRECTORY "%s/" USER_META_FILENAME, id_dirname);

	file_data = readFile(meta_path, &file_len);
	if (!file_data)
		return 0;

	u = alloc_user_slot();
	memcpy(u->id, id_dirname, id_len + 1);

	doc = json_parse(file_data, file_len);
	if (doc && doc->type == json_object) {
		name_v = json_object_get(doc, "name");
		if (name_v && name_v->type == json_string)
			CatString(&u->name, name_v->u.string.ptr, name_v->u.string.length);

		json_value *journeys_v = json_object_get(doc, "journeys");
		if (journeys_v && journeys_v->type == json_array) {
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
	}

	if (doc)
		json_value_free(doc);
	free(file_data);
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

void InitUserSystem(void)
{
	USER_COUNT = 0;

	InitJourneySystem();

	ensure_dir(USER_DATA_DIRECTORY);
	load_users_from_disk();

	if (USER_COUNT == 0) {
		String default_name;
		InitString(&default_name, FSIZE(DEFAULT_USER_NAME) + 2);
		CatFixed(&default_name, DEFAULT_USER_NAME);
		NewUser(&default_name);
		FreeString(&default_name);
	}

}

void FreeUserSystem(void)
{
	for (size_t i = 0; i < USER_COUNT; i++)
		FreeUser(&USER_TABLE[i]);

	USER_COUNT = 0;
}

void GetUserDirectory(const User *u, char *out)
{
	change_assert(u, "GetUserDirectory: user is NULL.\n");
	int n = snprintf(out, USER_DIRECTORY_SIZE, USER_DATA_DIRECTORY "%s", u->id);
	change_assert(n > 0 && (size_t)n < USER_DIRECTORY_SIZE, "User directory too long.\n");
}

void GetUserFilePath(const User *u, const char *filename, char *out)
{
	change_assert(u, "GetUserFilePath: user is NULL.\n");
	int n = snprintf(out, USER_DIRECTORY_SIZE,
		USER_DATA_DIRECTORY "%s/%s", u->id, filename);
	change_assert(n > 0 && (size_t)n < USER_DIRECTORY_SIZE, "User path too long.\n");
}

void GetUserGraphExportPath(const User *u, char *path)
{
	GetUserFilePath(u, USER_GRAPH_EXPORT_FILENAME, path);
}

void GetUserJourneyPath(const User *u, const char *journey_id, char *out)
{
	char filename[64];
	snprintf(filename, sizeof(filename), "journey-%s.json", journey_id);
	GetUserFilePath(u, filename, out);
}

void GetUserProfileExportPath(const User *u, char *path)
{
	GetUserFilePath(u, USER_PROFILE_EXPORT_FILENAME, path);
}

void GetUserMetaPath(const User *u, char *path)
{
	GetUserFilePath(u, USER_META_FILENAME, path);
}

void AddToJourney(User *u, const Journey *j) {
	change_assert(u->journey_count < MAX_JOURNEYS, "Max journey count per user reached. [%s]\n", u->id);
	memcpy((char *)u->journeys[u->journey_count], j->id, JOURNEY_ID_SIZE);
	u->journey_count++;
}

void SaveUser(User *u) {
	write_user_meta(u);

	char gr_path[USER_DIRECTORY_SIZE];
	GetUserGraphExportPath(u, gr_path);
	ExportGraphTo(gr_path);

	for (size_t i = 0; i < u->journey_count; i++) {
		Journey *j = FindJourneyByID(u->journeys[i]);
		if (!j) continue;
		char jpath[USER_DIRECTORY_SIZE];
		GetUserJourneyPath(u, j->id, jpath);
		ExportJourneyTo(j, jpath);
	}
}
