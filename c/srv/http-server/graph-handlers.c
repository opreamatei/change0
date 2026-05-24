#include "internal.h"
#include "http-util.h"
#include "graph-export.h"
#include "input/input-processor.h"
#include "user-management.h"
#include "util.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern void LoadGraphFromFile(char *path, NodeContainer *nc);

static char *get_graph_data(User *user)
{
	return SeriliazeGraph(&user->nodes);
}

void handle_get_graph(int fd, User *user)
{
	char *json = get_graph_data(user);

	if (!json) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"serialize_graph_failed\"}");
		return;
	}

	http_send_json(fd, 200, "OK", json);
	free(json);
}

void handle_post_graph_export(int fd, User *user)
{
	char path[USER_DIRECTORY_SIZE];
	char body[USER_DIRECTORY_SIZE + 32];

	if (!user) {
		http_send_json(fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"no_active_user\"}");
		return;
	}

	GetUserGraphExportPath(user, path);

	if (!ExportGraphTo(path, &user->nodes)) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"graph_export_failed\"}");
		return;
	}

	snprintf(body, sizeof(body), "{\"ok\":true,\"path\":\"%s\"}", path);
	http_send_json(fd, 200, "OK", body);
}

void handle_get_graph_load(int fd, User *user)
{
	char path[USER_DIRECTORY_SIZE];
	char body[USER_DIRECTORY_SIZE + 32];

	if (!user) {
		http_send_json(fd, 409, "Conflict",
			"{\"ok\":false,\"error\":\"no_active_user\"}");
		return;
	}

	GetUserGraphExportPath(user, path);

	if (access(path, R_OK) != 0) {
		if (errno == ENOENT) {
			http_send_json(fd, 404, "Not Found",
				"{\"ok\":false,\"error\":\"graph_copy_not_found\"}");
			return;
		}
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"graph_copy_not_readable\"}");
		return;
	}

	LoadGraphFromFile(path, &user->nodes);

	snprintf(body, sizeof(body), "{\"ok\":true,\"path\":\"%s\"}", path);
	http_send_json(fd, 200, "OK", body);
}

void handle_post_message(int fd, const HttpRequest *req, User *user)
{
	char input[1024];
	String inputS;

	input[0] = '\0';

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (!json_get_string_field(req->body, "input", input, sizeof(input))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_input\"}");
		return;
	}

	printf("message input=%s\n", input);

	size_t input_size = strlen(input);
	InitString(&inputS, input_size + 1);
	CatString(&inputS, input, input_size);

	DecomposeInputIntoGraph(&inputS, user);

	FreeString(&inputS);
	SaveUser(user);

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}
