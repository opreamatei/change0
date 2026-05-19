#include "user-management.h"
#include "string.h"
#include "config.h"

User USER_TABLE[MAX_USERS] = {0};
size_t USER_COUNT = 0;
User* LocalUser = NULL;

// Warning: If user doens't exist, local user becomes NULL
static void setLocalUser(user_id_like id){
	User *u = FindUserByID(id);
	LocalUser = u; 
}

_Bool MatchesUserID(User* u, user_id_like id){
	return strcmp(u->id, id) == 0;
}

User* FindUserByID(user_id_like id){
	for (size_t i = 0; i < USER_COUNT; i++){
		User *u = &USER_TABLE[i];
		if (MatchesUserID(u, id)){
			return u;
		}
	}
	return NULL;
}

User* NewUser(String *name){
	change_assert(USER_COUNT < MAX_USERS, "Max users limit reached");

	User *u = &USER_TABLE[USER_COUNT];

	InitString(&u->name, 128);

	USER_COUNT ++;

	return u;
}

void FreeUser(User *user){
	FreeString(&user->name);
}

void InitUserSystem(){
	USER_COUNT = 0;
	
	String default_user_name;
	{
		// calc defualt user name
		InitString(&default_user_name, FSIZE(DEFAULT_USER_NAME) + 2);
		CatFixed(&default_user_name, DEFAULT_USER_NAME);
	}

	User *u = NewUser(&default_user_name);

	setLocalUser(u->id);
}

void FreeUserSystem(){

	for (size_t i = 0; i < USER_COUNT; i++){
		FreeUser(&USER_TABLE[i]);
	}

	USER_COUNT = 0;
	LocalUser = NULL;
}

void SetUserExportDirectory(const User *u, char *user_dir, size_t max_size, const char* filename){
	change_assert(u, "No user received here\n");
	size_t len = snprintf(user_dir, max_size, USER_DATA_DIRECTORY "%s/%s", u->id, filename );
	change_assert(len < max_size, "Make MAX SIZE bigger\n");
}

void SetUserGraphExportDirectory(
    User *u,
    char *user_dir
)
{
    SetUserExportDirectory(
        u,
        user_dir,
        USER_DIRECTORY_SIZE,
        USER_GRAPH_EXPORT_FILENAME
    );
}

void SetUserGoalExportDirectory(
    User *u,
    char *user_dir
)
{
    SetUserExportDirectory(
        u,
        user_dir,
        USER_DIRECTORY_SIZE,
        USER_GOAL_EXPORT_FILENAME
    );
}

void SetUserProfileExportDirectory(
    User *u,
    char *user_dir
)
{
    SetUserExportDirectory(
        u,
        user_dir,
	USER_DIRECTORY_SIZE,
        USER_PROFILE_EXPORT_FILENAME
    );
}
