#include "internal.h"
#include "http-util.h"
#include "profile/user-profile.h"
#include "user-management.h"
#include "connections.h"
#include "util.h"

#include <string.h>

static _Bool is_user_editable_key(const char *key)
{
	static const char *editable[] = { "age", "work_day_start", "daily_work_hours", NULL };
	for (int i = 0; editable[i]; i++)
		if (strcmp(key, editable[i]) == 0) return 1;
	return 0;
}

void handle_get_profile(int fd, User *user)
{
	String derived;
	String response;
	char  *esc_name;
	char  *esc_derived;
	char  *esc_desc;

	InitString(&derived,  2048);
	InitString(&response, 4096);

	SerializeUserProfileDerivedSummary(user, &derived);

	esc_name    = json_escape_dup(user->name.p        ? user->name.p        : "");
	esc_derived = json_escape_dup(derived.p            ? derived.p            : "");
	esc_desc    = json_escape_dup(user->description.p  ? user->description.p  : "");

	CatTemplateString(&response,
		"{\"ok\":true,\"name\":\"%s\",\"user_id\":\"%s\",\"derived\":\"%s\","
		"\"discoverable\":%s,\"description\":\"%s\"}",
		esc_name, user->id, esc_derived,
		user->discoverable ? "true" : "false",
		esc_desc);

	free(esc_name);
	free(esc_derived);
	free(esc_desc);

	http_send_json(fd, 200, "OK", response.p);

	FreeString(&response);
	FreeString(&derived);
}

void handle_post_profile_update(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char key[64]    = {0};
	char value[1024] = {0};

	if (!json_get_string_field(req->body, "key", key, sizeof(key)) || !key[0]) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_key\"}");
		return;
	}

	if (strcmp(key, "name") == 0) {
		json_get_string_field(req->body, "value", value, sizeof(value));
		if (!value[0]) {
			http_send_json(fd, 400, "Bad Request",
				"{\"ok\":false,\"error\":\"empty_name\"}");
			return;
		}
		EmptyString(&user->name);
		CatString(&user->name, value, strlen(value));
		SaveUser(user);
		http_send_json(fd, 200, "OK", "{\"ok\":true}");
		return;
	}

	if (strcmp(key, "discoverable") == 0) {
		json_get_string_field(req->body, "value", value, sizeof(value));
		if (strcmp(value, "true") == 0 || strcmp(value, "1") == 0) {
			char desc[1024] = {0};
			json_get_string_field(req->body, "description", desc, sizeof(desc));
			SetUserDiscoverable(user, desc[0] ? desc : (user->description.p ? user->description.p : ""));
		} else {
			SetUserPrivate(user);
		}
		http_send_json(fd, 200, "OK", "{\"ok\":true}");
		return;
	}

	if (strcmp(key, "description") == 0) {
		json_get_string_field(req->body, "value", value, sizeof(value));
		UpdateUserDescription(user, value);
		http_send_json(fd, 200, "OK", "{\"ok\":true}");
		return;
	}

	if (!is_user_editable_key(key)) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"key_not_editable\"}");
		return;
	}

	json_get_string_field(req->body, "value", value, sizeof(value));
	UserProfileSetDerivedField(user, key, value);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}
