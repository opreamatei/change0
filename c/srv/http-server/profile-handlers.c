#include "internal.h"
#include "http-util.h"
#include "profile/user-profile.h"
#include "user-management.h"
#include "connections.h"
#include "journal.h"
#include "util.h"

#include <string.h>
#include <strings.h>

static _Bool is_user_editable_key(const char *key)
{
	static const char *editable[] = { "age", "work_day_start", "daily_work_hours", "onboarded", NULL };
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
	char  *memories;
	char   onboarded_val[16] = {0};
	_Bool  onboarded;

	InitString(&derived,  2048);
	InitString(&response, 4096);

	SerializeUserProfileDerivedSummary(user, &derived);

	/* A missing flag means a legacy account created before onboarding existed —
	 * treat those as already onboarded so they are never forced through the flow. */
	if (UserProfileGetDerivedField(user, "onboarded", onboarded_val, sizeof(onboarded_val)))
		onboarded = (strcmp(onboarded_val, "1") == 0 || strcmp(onboarded_val, "true") == 0);
	else
		onboarded = 1;

	esc_name    = json_escape_dup(user->name.p        ? user->name.p        : "");
	esc_derived = json_escape_dup(derived.p            ? derived.p            : "");
	esc_desc    = json_escape_dup(user->description.p  ? user->description.p  : "");
	memories    = JournalBuildImageMemoriesJson(user);

	CatTemplateString(&response,
		"{\"ok\":true,\"name\":\"%s\",\"user_id\":\"%s\",\"derived\":\"%s\","
		"\"discoverable\":%s,\"description\":\"%s\",\"color\":\"%s\",\"onboarded\":%s,\"memories\":%s}",
		esc_name, user->id, esc_derived,
		user->discoverable ? "true" : "false",
		esc_desc,
		user->color.p ? user->color.p : "",
		onboarded ? "true" : "false",
		memories ? memories : "[]");

	free(esc_name);
	free(esc_derived);
	free(esc_desc);
	free(memories);

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
			/* desc supplied → replace; otherwise NULL keeps any existing description. */
			SetUserDiscoverable(user, desc[0] ? desc : NULL);
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

	/* Identity colour — set client-side from the dominant colour of a freshly
	 * chosen avatar (a #rrggbb hex). Only accept a plausibly-formatted value. */
	if (strcmp(key, "color") == 0) {
		json_get_string_field(req->body, "value", value, sizeof(value));
		if (value[0] != '#' || strlen(value) != 7) {
			http_send_json(fd, 400, "Bad Request",
				"{\"ok\":false,\"error\":\"bad_color\"}");
			return;
		}
		EmptyString(&user->color);
		CatString(&user->color, value, strlen(value));
		SaveUser(user);
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
	if (strcmp(key, "work_day_start") == 0 || strcmp(key, "daily_work_hours") == 0)
		user->schedule_needs_refresh = 1;
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

/* ── profile avatar ── */

static const char *avatar_mime_from_ext(const char *ext)
{
	if (!ext) return "application/octet-stream";
	if (strcasecmp(ext, "jpg") == 0 || strcasecmp(ext, "jpeg") == 0) return "image/jpeg";
	if (strcasecmp(ext, "png")  == 0) return "image/png";
	if (strcasecmp(ext, "gif")  == 0) return "image/gif";
	if (strcasecmp(ext, "webp") == 0) return "image/webp";
	return "application/octet-stream";
}

/* POST /profile/avatar?ext=png  (raw image bytes in the body) */
void handle_post_profile_avatar(int fd, const HttpRequest *req, User *user)
{
	const char *query = NULL;
	char path[256];
	split_path_and_query(req->path, path, sizeof(path), &query);

	char ext[16] = {0};
	if (!query || !query_get_param(query, "ext", ext, sizeof(ext)) || !ext[0]) {
		/* fall back to deriving the extension from a filename param */
		char fname[256] = {0};
		if (query && query_get_param(query, "f", fname, sizeof(fname))) {
			const char *dot = strrchr(fname, '.');
			if (dot && dot[1]) snprintf(ext, sizeof(ext), "%s", dot + 1);
		}
	}

	if (strcmp(avatar_mime_from_ext(ext), "application/octet-stream") == 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"unsupported_image_type\"}");
		return;
	}
	if (!req->body || req->body_len == 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"empty_body\"}");
		return;
	}
	if (SaveUserAvatar(user->id, ext, req->body, req->body_len) != 0) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"write_failed\"}");
		return;
	}
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

/* GET /profile/avatar[?id=<userId>]  — defaults to the authenticated user */
void handle_get_profile_avatar(int fd, const HttpRequest *req, User *user)
{
	const char *query = NULL;
	char path[256];
	split_path_and_query(req->path, path, sizeof(path), &query);

	char id[64] = {0};
	if (!query || !query_get_param(query, "id", id, sizeof(id)) || !id[0])
		snprintf(id, sizeof(id), "%s", user->id);

	void  *data = NULL;
	size_t len  = 0;
	char   ext[16] = {0};
	if (ReadUserAvatar(id, &data, &len, ext, sizeof(ext)) != 0) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"no_avatar\"}");
		return;
	}

	char header[512];
	int hlen = snprintf(header, sizeof(header),
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: %s\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Cache-Control: no-cache\r\n"
		"Content-Length: %zu\r\n"
		"Connection: close\r\n"
		"\r\n",
		avatar_mime_from_ext(ext), len);

	http_send_all(fd, header, (size_t)hlen);
	if (data && len) http_send_all(fd, data, len);
	free(data);
}
