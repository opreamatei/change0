#include "central-internal.h"
#include "central-server.h"
#include "http-server.h"
#include "http-util.h"
#include "user-management.h"
#include "reviews.h"
#include "util.h"
#include "json.h"

#include <stdlib.h>
#include <string.h>
#include <strings.h>

char *extract_string_field(const char *body, size_t body_len, const char *key)
{
	if (!body || body_len == 0)
		return NULL;

	json_value *root = json_parse(body, body_len);
	if (!root || root->type != json_object) {
		if (root) json_value_free(root);
		return NULL;
	}

	char *result = NULL;
	json_value *val = json_object_get(root, key);
	if (val && val->type == json_string) {
		result = malloc(val->u.string.length + 1);
		if (result) {
			memcpy(result, val->u.string.ptr, val->u.string.length);
			result[val->u.string.length] = '\0';
		}
	}

	json_value_free(root);
	return result;
}

static void write_user_array(String *out)
{
	CatFixed(out, "{\"ok\":true,\"users\":[");
	for (size_t i = 0; i < USER_COUNT; i++) {
		User *u = &USER_TABLE[i];
		char *esc_name = json_escape_dup(u->name.p ? u->name.p : "");
		CatTemplateString(out,
			"%s{\"id\":\"%s\",\"name\":\"%s\",\"color\":\"%s\"}",
			i == 0 ? "" : ",",
			u->id, esc_name, u->color.p ? u->color.p : "");
		free(esc_name);
	}
	CatFixed(out, "]}");
}

void handle_list_users(int fd)
{
	String out;
	InitString(&out, 256);
	write_user_array(&out);
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

void handle_create_user(int fd, CentralRequest *req)
{
	char *name = extract_string_field(req->body, req->body_len, "name");
	if (!name || !*name) {
		free(name);
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_name\"}");
		return;
	}

	String name_str;
	InitString(&name_str, strlen(name) + 1);
	CatString(&name_str, name, strlen(name));
	User *u = NewUser(&name_str);
	FreeString(&name_str);
	free(name);

	String out;
	InitString(&out, 256);
	char *esc_name = json_escape_dup(u->name.p ? u->name.p : "");
	CatTemplateString(&out,
		"{\"ok\":true,\"id\":\"%s\",\"name\":\"%s\"}",
		u->id, esc_name);
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
	free(esc_name);
}

void handle_select_user(int fd, CentralRequest *req)
{
	char *id = extract_string_field(req->body, req->body_len, "id");
	if (!id || !*id) {
		free(id);
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

	User *u = FindUserByID(id);
	free(id);

	if (!u) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"user_not_found\"}");
		return;
	}

	stop_server();
	start_server(u->port, u);

	String out;
	InitString(&out, 256);
	char *esc_name = json_escape_dup(u->name.p ? u->name.p : "");
	CatTemplateString(&out,
		"{\"ok\":true,\"id\":\"%s\",\"name\":\"%s\",\"port\":%d}",
		u->id, esc_name, client_server_port());
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
	free(esc_name);
}

/* GET /users/avatar?id=<userId> — serves a user's avatar from the shared disk
 * layout so the collab view can show real profile pictures. */
static const char *central_avatar_mime(const char *ext)
{
	if (!ext) return "application/octet-stream";
	if (strcasecmp(ext, "jpg") == 0 || strcasecmp(ext, "jpeg") == 0) return "image/jpeg";
	if (strcasecmp(ext, "png")  == 0) return "image/png";
	if (strcasecmp(ext, "gif")  == 0) return "image/gif";
	if (strcasecmp(ext, "webp") == 0) return "image/webp";
	return "application/octet-stream";
}

void handle_get_user_avatar(int fd, const char *query)
{
	char id[64] = {0};
	if (!query || !query_get_param(query, "id", id, sizeof(id)) || !id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

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
		central_avatar_mime(ext), len);

	http_send_all(fd, header, (size_t)hlen);
	if (data && len) http_send_all(fd, data, len);
	free(data);
}

/* GET /users/authentic-goals?id=<userId> — the goal ids this user has had
 * peer-verified, so a viewer can mark those achievements as authentic.
 * Computed live from the submissions table (always fresh). */
void handle_get_user_authentic_goals(int fd, const char *query)
{
	char id[64] = {0};
	if (!query || !query_get_param(query, "id", id, sizeof(id)) || !id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

	const char *ids[MAX_SUBMISSIONS];
	size_t n = ListAuthenticGoalIds(id, ids, MAX_SUBMISSIONS);

	String out;
	InitString(&out, 128 + n * 40);
	CatFixed(&out, "{\"ok\":true,\"goal_ids\":[");
	for (size_t i = 0; i < n; i++) {
		char *esc = json_escape_dup(ids[i]);
		CatTemplateString(&out, "%s\"%s\"", i ? "," : "", esc ? esc : "");
		free(esc);
	}
	CatFixed(&out, "]}");

	http_send_json(fd, 200, "OK", out.p);
	FreeString(&out);
}

/* GET /users/profile?id=<userId> — serves a user's public goal-portfolio
 * snapshot (data/users/<id>/profile.json) so others can view their goals and
 * achievements. 404 when the user has not shared (no snapshot file). */
void handle_get_user_profile(int fd, const char *query)
{
	char id[64] = {0};
	if (!query || !query_get_param(query, "id", id, sizeof(id)) || !id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

	void  *data = NULL;
	size_t len  = 0;
	if (ReadUserProfileSnapshot(id, &data, &len) != 0) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"not_shared\"}");
		return;
	}

	char header[256];
	int hlen = snprintf(header, sizeof(header),
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: application/json\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Cache-Control: no-cache\r\n"
		"Content-Length: %zu\r\n"
		"Connection: close\r\n"
		"\r\n",
		len);

	http_send_all(fd, header, (size_t)hlen);
	if (data && len) http_send_all(fd, data, len);
	free(data);
}
