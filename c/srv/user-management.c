#include "user-management.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
