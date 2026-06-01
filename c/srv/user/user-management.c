#include "user-management.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

User USER_TABLE[MAX_USERS] = {0};
size_t USER_COUNT = 0;

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

User *alloc_user_slot(void)
{
	change_assert(USER_COUNT < MAX_USERS, "Max users limit reached");

	User *u = &USER_TABLE[USER_COUNT];

	memset(u, 0, sizeof(*u));
	InitString(&u->name, 128);
	InitString(&u->description, 256);
	InitString(&u->color, 16);
	InitNodes(&u->nodes);
	u->schedule_needs_refresh = 1;
	u->goal_health_needs_refresh = 1;
	u->discoverable = 0;

	USER_COUNT++;

	return u;
}

void FreeUser(User *user)
{
	FreeString(&user->name);
	FreeString(&user->description);
	FreeString(&user->color);
	FreeNodes(&user->nodes);
	if (user->schedule_table) free(user->schedule_table);
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

/* user ids are random alphanumerics — reject anything else to avoid traversal. */
static _Bool avatar_safe_id(const char *id)
{
	if (!id || !id[0] || strlen(id) > 64) return 0;
	for (const char *p = id; *p; p++)
		if (!isalnum((unsigned char)*p)) return 0;
	return 1;
}

int SaveUserAvatar(const char *user_id, const char *ext, const void *data, size_t len)
{
	if (!avatar_safe_id(user_id) || !data || len == 0) return -1;

	char path[USER_DIRECTORY_SIZE];
	int n = snprintf(path, sizeof(path), USER_DATA_DIRECTORY "%s/avatar", user_id);
	if (n <= 0 || (size_t)n >= sizeof(path)) return -1;

	FILE *f = fopen(path, "wb");
	if (!f) return -1;
	size_t w = fwrite(data, 1, len, f);
	fclose(f);
	if (w != len) return -1;

	char epath[USER_DIRECTORY_SIZE];
	n = snprintf(epath, sizeof(epath), USER_DATA_DIRECTORY "%s/avatar.ext", user_id);
	if (n > 0 && (size_t)n < sizeof(epath)) {
		FILE *e = fopen(epath, "wb");
		if (e) { if (ext) fputs(ext, e); fclose(e); }
	}
	return 0;
}

int ReadUserAvatar(const char *user_id, void **out, size_t *out_len, char *ext_out, size_t ext_cap)
{
	if (!avatar_safe_id(user_id) || !out || !out_len) return -1;

	char path[USER_DIRECTORY_SIZE];
	int n = snprintf(path, sizeof(path), USER_DATA_DIRECTORY "%s/avatar", user_id);
	if (n <= 0 || (size_t)n >= sizeof(path)) return -1;

	FILE *f = fopen(path, "rb");
	if (!f) return -1;
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (sz <= 0) { fclose(f); return -1; }

	void *buf = malloc((size_t)sz);
	if (!buf) { fclose(f); return -1; }
	size_t r = fread(buf, 1, (size_t)sz, f);
	fclose(f);
	if (r != (size_t)sz) { free(buf); return -1; }

	*out = buf;
	*out_len = (size_t)sz;

	if (ext_out && ext_cap) {
		ext_out[0] = '\0';
		char epath[USER_DIRECTORY_SIZE];
		n = snprintf(epath, sizeof(epath), USER_DATA_DIRECTORY "%s/avatar.ext", user_id);
		if (n > 0 && (size_t)n < sizeof(epath)) {
			FILE *e = fopen(epath, "rb");
			if (e) {
				size_t er = fread(ext_out, 1, ext_cap - 1, e);
				ext_out[er] = '\0';
				fclose(e);
				for (size_t i = 0; i < er; i++)
					if (ext_out[i] == '\n' || ext_out[i] == '\r' || ext_out[i] == ' ') { ext_out[i] = '\0'; break; }
			}
		}
	}
	return 0;
}

void GetUserMetaPath(const User *u, char *path)
{
	GetUserFilePath(u, USER_META_FILENAME, path);
}

void AddToJourney(User *u, const Journey *j)
{
	change_assert(u->journey_count < MAX_JOURNEYS, "Max journey count per user reached. [%s]\n", u->id);
	memcpy((char *)u->journeys[u->journey_count], j->id, JOURNEY_ID_SIZE);
	u->journey_count++;
}
