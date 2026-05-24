#include "internal.h"
#include "http-util.h"
#include "time-util.h"
#include "util.h"

#include <stdio.h>

void handle_get_dev_time(int fd)
{
	char response[256];
	int  len = snprintf(response, sizeof(response),
		"{\"ok\":true,\"now\":%lld,\"offset_seconds\":%lld}",
		(long long)change_time_now(),
		(long long)change_time_get_offset_seconds());

	if (len < 0 || (size_t)len >= sizeof(response)) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}");
		return;
	}

	http_send_json(fd, 200, "OK", response);
}

void handle_post_dev_time_advance(int fd, const HttpRequest *req)
{
	int  delta = 0;
	char response[256];
	int  len;

	if (!req->body) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	if (!json_get_int_field(req->body, "seconds", &delta)) {
		http_send_json(fd, 400, "Bad Request",
			"{\"ok\":false,\"error\":\"missing_seconds\"}");
		return;
	}

	len = snprintf(response, sizeof(response),
		"{\"ok\":true,\"now\":%lld,\"offset_seconds\":%lld}",
		(long long)change_time_advance_seconds((time_t)delta),
		(long long)change_time_get_offset_seconds());

	if (len < 0 || (size_t)len >= sizeof(response)) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}");
		return;
	}

	http_send_json(fd, 200, "OK", response);
}

void handle_post_dev_time_reset(int fd)
{
	char response[256];
	int  len;

	change_time_reset();

	len = snprintf(response, sizeof(response),
		"{\"ok\":true,\"now\":%lld,\"offset_seconds\":%lld}",
		(long long)change_time_now(),
		(long long)change_time_get_offset_seconds());

	if (len < 0 || (size_t)len >= sizeof(response)) {
		http_send_json(fd, 500, "Internal Server Error",
			"{\"ok\":false,\"error\":\"response_too_large\"}");
		return;
	}

	http_send_json(fd, 200, "OK", response);
}
