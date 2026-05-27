#include "internal.h"
#include "http-util.h"
#include "util.h"

#include <string.h>
#include <unistd.h>

static void handle_not_found(int fd)
{
	http_send_json(fd, 404, "Not Found",
		"{\"ok\":false,\"error\":\"route_not_found\"}");
}

static void handle_bad_request(int fd)
{
	http_send_json(fd, 400, "Bad Request",
		"{\"ok\":false,\"error\":\"bad_request\"}");
}

/* returns 1 if caller should keep socket open (SSE) */
static int handle_request(int fd, const HttpRequest *req, User *user)
{
	char path[256];
	const char *query_unused = NULL;
	split_path_and_query(req->path, path, sizeof(path), &query_unused);

#define GET(p)  (strcmp(req->method, "GET")  == 0 && strcmp(path, (p)) == 0)
#define POST(p) (strcmp(req->method, "POST") == 0 && strcmp(path, (p)) == 0)

	if (strcmp(req->method, "OPTIONS") == 0) { handle_options(fd); return 0; }

	if (GET("/graph"))                  { handle_get_graph(fd, user);                        return 0; }
	if (POST("/graph/export"))          { handle_post_graph_export(fd, user);                return 0; }
	if (GET("/graph/load"))             { handle_get_graph_load(fd, user);                   return 0; }

	if (POST("/research/start"))        { handle_post_research_start(fd, req, user);         return 0; }
	if (GET("/research/events"))        { handle_get_research_events(fd, req->path);         return 1; }

	if (POST("/middleware/message"))    { handle_post_middleware_message(fd, req, user);     return 0; }
	if (POST("/middleware/permission")) { handle_post_middleware_permission(fd, req, user);  return 0; }
	if (GET("/middleware/events"))      { handle_get_middleware_events(fd, req->path, user); return 1; }
	if (GET("/middleware/session"))     { handle_get_middleware_session(fd, req->path, user);return 0; }
	if (GET("/chat/sessions"))          { handle_get_chat_sessions(fd, user);                return 0; }

	if (POST("/goal/create"))               { handle_post_goal_create(fd, req, user);                  return 0; }
	if (POST("/goal/create-shared-root"))   { handle_post_goal_create_shared_root(fd, req, user);      return 0; }
	if (POST("/goal/shared-action"))        { handle_post_goal_shared_action(fd, req, user);            return 0; }
	if (POST("/goal/start"))            { handle_post_goal_start(fd, req, user);             return 0; }
	if (POST("/goal/end"))              { handle_post_goal_end(fd, req, user);               return 0; }
	if (POST("/goal/decompose"))        { handle_post_goal_decompose(fd, req, user);         return 0; }
	if (POST("/goal/repair"))           { handle_post_goal_repair(fd, req, user);            return 0; }
	if (POST("/goal/drop"))             { handle_post_goal_drop(fd, req, user);              return 0; }
	if (POST("/goal/export"))           { handle_post_goal_export(fd, user);                 return 0; }
	if (GET("/goal/load"))              { handle_get_goal_load(fd, user);                    return 0; }
	if (GET("/goal/list"))              { handle_get_goal_list(fd, user);                    return 0; }
	if (GET("/goal/session"))           { handle_get_session_goals(fd, user);                return 0; }
	if (GET("/goal/events"))            { handle_get_goal_events(fd, req->path);             return 1; }

	if (GET("/profile"))                { handle_get_profile(fd, user);                      return 0; }
	if (POST("/profile/update"))        { handle_post_profile_update(fd, req, user);         return 0; }

	if (GET("/dev/time"))               { handle_get_dev_time(fd);                           return 0; }
	if (POST("/dev/time/advance"))      { handle_post_dev_time_advance(fd, req);             return 0; }
	if (POST("/dev/time/reset"))        { handle_post_dev_time_reset(fd);                    return 0; }

	if (POST("/message"))               { handle_post_message(fd, req, user);                return 0; }
	if (GET("/schedule"))               { handle_get_schedule(fd, user);                     return 0; }
	if (POST("/schedule/refresh"))      { handle_post_schedule_refresh(fd, user);            return 0; }

	if (POST("/journal/create"))  { handle_post_journal_create(fd, req, user);  return 0; }
	if (GET("/journal/list"))     { handle_get_journal_list(fd, user);          return 0; }
	if (GET("/journal/entry"))    { handle_get_journal_entry(fd, req, user);    return 0; }
	if (POST("/journal/update"))  { handle_post_journal_update(fd, req, user);  return 0; }
	if (POST("/journal/delete"))  { handle_post_journal_delete(fd, req, user);  return 0; }
	if (POST("/journal/attach"))  { handle_post_journal_attach(fd, req, user);  return 0; }
	if (GET("/journal/file"))     { handle_get_journal_file(fd, req, user);     return 0; }
	if (POST("/journal/embed"))   { handle_post_journal_embed(fd, req, user);   return 0; }

#undef GET
#undef POST

	handle_not_found(fd);
	return 0;
}

void handle_client(int fd, User *user)
{
	HttpRequest req;
	int keep_open = 0;

	if (read_http_request(fd, &req) != 0) {
		handle_bad_request(fd);
		close(fd);
		return;
	}

	keep_open = handle_request(fd, &req, user);
	free_http_request(&req);

	if (!keep_open)
		close(fd);
}
