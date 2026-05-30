#ifndef USER_MANAGEMENT_SYSTEM
#define USER_MANAGEMENT_SYSTEM

#include "util.h"
#include "ne/node.h"
#include "journey.h"
#include "ne/goal/schedule-system.h"

#define MAX_USERS 8
#define USER_ID_SIZE 32
#define USER_MAX_JOURNEYS 5

typedef char user_id_like[USER_ID_SIZE];

typedef struct UserType {
	String name;
	user_id_like id;
	int port;

	// 0 is the default user journey
	journey_id_like journeys[USER_MAX_JOURNEYS];
	size_t journey_count;

	NodeContainer nodes;

	struct ScheduleEntry *schedule_table;
	size_t schedule_len;
	_Bool schedule_needs_refresh;
	_Bool goal_health_needs_refresh;

	/* Connection discovery: opt-in only. Description is server-side only,
	 * never shown to other users. They see only the user's name + the reason
	 * the central server matched them. */
	_Bool discoverable;
	String description;
} User;

extern User USER_TABLE[MAX_USERS];
extern size_t USER_COUNT;

_Bool MatchesUserID(User* u, user_id_like id);
User* FindUserByID(user_id_like id);
User* FindUserByName(const char *name);

/*
 * NewUser allocates an in-memory User and persists its .meta file.
 * The caller passes the user-facing name; the id is generated.
 */
User* NewUser(const String *name);
void FreeUser(User *user);

/* On startup, scan data/users/ and rebuild the in-memory table. */
void InitUserSystem(void);
void FreeUserSystem(void);

/* path helpers (out must have at least USER_DIRECTORY_SIZE bytes) */
void GetUserDirectory(const User *u, char *out);
void GetUserFilePath(const User *u, const char *filename, char *out);

void GetUserGraphExportPath(const User *u, char *path);
void GetUserJourneyPath(const User *u, const char *journey_id, char *out);
void GetUserProfileExportPath(const User *u, char *path);
void GetUserMetaPath(const User *u, char *path);

/*
 * Profile avatar, stored raw under the user's data dir (data/users/<id>/avatar)
 * plus a sibling "avatar.ext" holding the image extension. Keyed by user id so
 * both the client server (own avatar) and the central server (other users'
 * avatars, for collab) can save/serve from the shared disk layout.
 * Return 0 on success, non-zero on failure. ReadUserAvatar mallocs *out.
 */
int SaveUserAvatar(const char *user_id, const char *ext, const void *data, size_t len);
int ReadUserAvatar(const char *user_id, void **out, size_t *out_len, char *ext_out, size_t ext_cap);

void AddToJourney(User *u, const Journey *j);

/* Saves meta, graph, and all journeys for the given user. */
void SaveUser(User *u);

#endif
