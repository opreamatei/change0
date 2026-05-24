#include "central-internal.h"
#include "central-server.h"
#include "http-server.h"
#include "http-util.h"
#include "user-management.h"
#include "util.h"
#include "json.h"

#include <stdlib.h>
#include <string.h>

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
			"%s{\"id\":\"%s\",\"name\":\"%s\"}",
			i == 0 ? "" : ",",
			u->id, esc_name);
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
