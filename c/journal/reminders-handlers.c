#define _POSIX_C_SOURCE 200809L

#include "reminders.h"
#include "http-util.h"
#include "util.h"
#include "internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

void handle_get_reminders(int fd, User *user)
{
	char *json = RemindersListJson(user);
	String out;
	InitString(&out, 64);
	CatTemplateString(&out, "{\"ok\":true,\"reminders\":%s}", json ? json : "[]");
	free(json);
	http_send_json(fd, 200, "OK", out.p);
	FreeString(&out);
}

void handle_post_reminders_save(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	Reminder r;
	memset(&r, 0, sizeof(r));
	r.enabled = 1;
	r.hour    = 9;

	json_get_string_field(req->body, "id",    r.id,    sizeof(r.id));
	json_get_string_field(req->body, "title", r.title, sizeof(r.title));
	json_get_int_field(req->body, "hour",    &r.hour);
	json_get_int_field(req->body, "minute",  &r.minute);
	json_get_int_field(req->body, "enabled", &r.enabled);

	int days_int = 0;
	json_get_int_field(req->body, "days", &days_int);
	r.days = (uint8_t)days_int;

	int end_time_int = 0;
	json_get_int_field(req->body, "end_time", &end_time_int);
	r.end_time = (time_t)end_time_int;

	if (!r.id[0])
		snprintf(r.id, sizeof(r.id), "r%ld_%04x",
			(long)time(NULL), (unsigned)(rand() & 0xFFFF));
	if (!r.title[0])
		strncpy(r.title, "Reminder", sizeof(r.title) - 1);

	r.hour   = r.hour   < 0 ? 0 : (r.hour   > 23 ? 23 : r.hour);
	r.minute = r.minute < 0 ? 0 : (r.minute > 59 ? 59 : r.minute);

	if (RemindersSave(user, &r) != 0) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"save_failed\"}");
		return;
	}

	char buf[80];
	snprintf(buf, sizeof(buf), "{\"ok\":true,\"id\":\"%s\"}", r.id);
	http_send_json(fd, 200, "OK", buf);
}

void handle_post_reminders_delete(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char id[REMINDER_ID_SIZE] = {0};
	json_get_string_field(req->body, "id", id, sizeof(id));

	if (!id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

	if (RemindersDelete(user, id) != 0) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"not_found\"}");
		return;
	}

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}
