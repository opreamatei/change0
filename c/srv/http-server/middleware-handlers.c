#include "internal.h"
#include "http-server.h"
#include "http-util.h"
#include "middleware/middleware.h"
#include "search/deep-search-session.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void scope_session(const User *user, const char *sid, char *out, size_t out_size)
{
	snprintf(out, out_size, "%s:%s", user->id, (sid && sid[0]) ? sid : "default");
}

static _Bool middleware_emit_event(const char *id, const char *type, const char *buffer, size_t buffer_len)
{
	server_emit_event(id, type, buffer, buffer_len);
	return 1;
}

void handle_post_research_start(int fd, const HttpRequest *req, User *user)
{
	char   research_id[MAX_STREAM_ID_LEN + 1];
	char   task_name[256];
	int    min_rounds = 0;
	String out;
	Task   task = {0};

	research_id[0] = task_name[0] = '\0';

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (!json_get_string_field(req->body, "id", research_id, sizeof(research_id))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

	if (!json_get_string_field(req->body, "taskName", task_name, sizeof(task_name))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_task_name\"}");
		return;
	}

	if (!json_get_int_field(req->body, "minRounds", &min_rounds)) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_min_rounds\"}");
		return;
	}

	if (min_rounds < 1) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"invalid_min_rounds\"}");
		return;
	}

	printf("research/start id=%s taskName=%s minRounds=%d\n", research_id, task_name, min_rounds);

	memset(&task, 0, sizeof(task));
	InitString(&task.name, strlen(task_name) + 1);
	CatString(&task.name, task_name, strlen(task_name));
	task.minDepth = min_rounds;

	InitString(&out, 1024);

	ds_emit_event(research_id, "research_started", "deep search started", strlen("deep search started"));

	start_ds_session(&task, research_id, &out, user);

	http_send_json(fd, 200, "OK", c_str(&out));

	FreeString(&out);
	FreeString(&task.name);
}

void handle_get_research_events(int fd, const char *full_path)
{
	static const char *header =
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: text/event-stream\r\n"
		"Cache-Control: no-cache\r\n"
		"Connection: keep-alive\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"\r\n";

	char path_only[256];
	const char *query = NULL;
	char research_id[MAX_STREAM_ID_LEN + 1];

	split_path_and_query(full_path, path_only, sizeof(path_only), &query);
	research_id[0] = '\0';
	query_get_param(query, "id", research_id, sizeof(research_id));

	if (http_send_all(fd, header, strlen(header)) != 0) { close(fd); return; }
	if (!add_sse_client(fd, research_id[0] ? research_id : NULL)) { close(fd); return; }

	if (research_id[0])
		ds_emit_event(research_id, "sse_connected", "connected", strlen("connected"));
}

void handle_post_middleware_message(int fd, const HttpRequest *req, User *user)
{
	char session_id[MAX_STREAM_ID_LEN + 1];
	char input[4096];
	MiddlewareResult result;
	String out;
	char *esc_message      = NULL;
	char *esc_type         = NULL;
	char *esc_permission_id = NULL;

	session_id[0] = input[0] = '\0';

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	{
		char raw_sid[MAX_STREAM_ID_LEN + 1];
		raw_sid[0] = '\0';
		json_get_string_field(req->body, "sessionId",  raw_sid, sizeof(raw_sid)) ||
		json_get_string_field(req->body, "session_id", raw_sid, sizeof(raw_sid)) ||
		json_get_string_field(req->body, "id",         raw_sid, sizeof(raw_sid));
		scope_session(user, raw_sid, session_id, sizeof(session_id));
	}

	if (!json_get_string_field(req->body, "input",   input, sizeof(input)) &&
	    !json_get_string_field(req->body, "message", input, sizeof(input))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_input\"}");
		return;
	}

	if (input[0] == '\0') {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"empty_input\"}");
		return;
	}

	printf("middleware/message sessionId=%s input=%s\n", session_id, input);

	result = RunClientMiddleware(session_id, input, start_ds_session, middleware_emit_event, user);
	SaveUser(user);

	esc_message       = json_escape_dup(result.assistant_message.p);
	esc_type          = json_escape_dup(result.response_type.p);
	esc_permission_id = json_escape_dup(result.permission_id.p);

	InitString(&out, strlen(esc_message) + strlen(esc_type) + strlen(esc_permission_id) + 256);
	CatTemplateString(&out,
		"{\"ok\":true,\"sessionId\":\"%s\",\"type\":\"%s\",\"message\":\"%s\",\"permission_id\":\"%s\"}",
		session_id, esc_type, esc_message, esc_permission_id);

	http_send_json(fd, 200, "OK", out.p);

	free(esc_permission_id);
	free(esc_type);
	free(esc_message);
	FreeString(&out);
	FreeMiddlewareResult(&result);
}

void handle_post_middleware_permission(int fd, const HttpRequest *req, User *user)
{
	char  permission_id[128];
	int   approved_int = 0;
	_Bool ok;

	permission_id[0] = '\0';

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (!json_get_string_field(req->body, "permissionId",  permission_id, sizeof(permission_id)) &&
	    !json_get_string_field(req->body, "permission_id", permission_id, sizeof(permission_id)) &&
	    !json_get_string_field(req->body, "id",            permission_id, sizeof(permission_id))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_permission_id\"}");
		return;
	}

	if (!json_get_bool_or_int_field(req->body, "approved", &approved_int)) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_approved\"}");
		return;
	}

	ok = ResolveMiddlewarePermission(permission_id, approved_int != 0, middleware_emit_event, user);
	if (!ok) {
		http_send_json(fd, 404, "Not Found",
			"{\"ok\":false,\"error\":\"permission_not_found\"}");
		return;
	}

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_get_middleware_events(int fd, const char *full_path, User *user)
{
	static const char *header =
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: text/event-stream\r\n"
		"Cache-Control: no-cache\r\n"
		"Connection: keep-alive\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"\r\n";

	char path_only[256];
	const char *query = NULL;
	char raw_sid[MAX_STREAM_ID_LEN + 1];
	char session_id[MAX_STREAM_ID_LEN + 1];

	split_path_and_query(full_path, path_only, sizeof(path_only), &query);
	raw_sid[0] = '\0';

	if (!query_get_param(query, "sessionId",  raw_sid, sizeof(raw_sid)) &&
	    !query_get_param(query, "session_id", raw_sid, sizeof(raw_sid)))
		query_get_param(query, "id", raw_sid, sizeof(raw_sid));

	scope_session(user, raw_sid, session_id, sizeof(session_id));

	if (http_send_all(fd, header, strlen(header)) != 0) { close(fd); return; }
	if (!add_sse_client(fd, session_id))                { close(fd); return; }

	middleware_emit_event(session_id, "sse_connected", "connected", strlen("connected"));
}

void handle_get_middleware_session(int fd, const char *full_path, User *user)
{
	char path_only[256];
	const char *query = NULL;
	char raw_sid[MAX_STREAM_ID_LEN + 1];
	char session_id[MAX_STREAM_ID_LEN + 1];
	char *result_json = NULL;

	split_path_and_query(full_path, path_only, sizeof(path_only), &query);
	raw_sid[0] = '\0';

	if (!query_get_param(query, "sessionId",  raw_sid, sizeof(raw_sid)) &&
	    !query_get_param(query, "session_id", raw_sid, sizeof(raw_sid)))
		query_get_param(query, "id", raw_sid, sizeof(raw_sid));

	scope_session(user, raw_sid, session_id, sizeof(session_id));

	result_json = ExportMiddlewareSessionJSON(session_id);
	if (!result_json) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"session_export_failed\"}");
		return;
	}

	http_send_json(fd, 200, "OK", result_json);
	free(result_json);
}

void handle_post_onboarding_questions(int fd, const HttpRequest *req, User *user)
{
	char    goal_title[256];
	char    scope[2048];
	String *questions;

	goal_title[0] = scope[0] = '\0';

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (!json_get_string_field(req->body, "goalTitle", goal_title, sizeof(goal_title)) &&
	    !json_get_string_field(req->body, "title",     goal_title, sizeof(goal_title))) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_goal_title\"}");
		return;
	}

	json_get_string_field(req->body, "scope", scope, sizeof(scope));

	printf("onboarding/questions goalTitle=%s\n", goal_title);

	questions = GenerateOnboardingQuestions(user, goal_title, scope);
	if (!questions) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"question_generation_failed\"}");
		return;
	}

	/* questions->p is already the {"questions":[...]} object. */
	http_send_json(fd, 200, "OK", questions->p);
	FreeString(questions);
	free(questions);
}

void handle_get_chat_sessions(int fd, User *user)
{
	char  *json = ListChatSessionsJSON(user->id);
	String out;
	InitString(&out, 256);
	CatTemplateString(&out, "{\"ok\":true,\"sessions\":%s}", json ? json : "[]");
	free(json);
	http_send_json(fd, 200, "OK", out.p);
	FreeString(&out);
}
