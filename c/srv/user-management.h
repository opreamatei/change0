#ifndef USER_MANAGEMENT_SYSTEM
#define USER_MANAGEMENT_SYSTEM

#include "util.h"
#include "journey.h"

#define MAX_USERS 8
#define USER_ID_SIZE 32
#define DEFAULT_USER_NAME "andrei"

typedef char user_id_like[USER_ID_SIZE];

typedef struct UserType {
	String name;
	user_id_like id;
	String User_profile_data; // TODO : Sync this one with USER_PROFILE DEFAULT

	Journey *ownJourney;
} User;

extern User USER_TABLE[MAX_USERS];
extern size_t USER_COUNT;
extern User *LocalUser;

_Bool MatchesUserID(User* u, user_id_like id);
User* FindUserByID(user_id_like id);

User* NewUser(String *name);
void FreeUser(User *user);

void InitUserSystem();
void FreeUserSystem();

void BuildUserPath(
    const User *u,
    char *out,
    size_t out_size,
    const char *filename
);

void SetUserExportDirectory(
    const User *u,
    char *user_dir,
    size_t max_size,
    const char *filename
);

/* Convenience helpers */
void GetUserGraphExportPath(
    const User *u,
    char *path
);

void GetUserGoalExportPath(
    const User *u,
    char *path
);

void GetUserProfileExportPath(
    const User *u,
    char *path
);

#endif
