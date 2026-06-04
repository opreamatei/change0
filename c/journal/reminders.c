#define _POSIX_C_SOURCE 200809L

#include "reminders.h"
#include "config.h"
#include "util.h"
#include "http-util.h"
#include "time-util.h"
#include "../lib/jsonp/json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define REMINDERS_FILENAME "reminders.json"

void RemindersGetPath(const User *u, char *out, size_t cap)
{
	snprintf(out, cap, USER_DATA_DIRECTORY "%s/" REMINDERS_FILENAME, u->id);
}

static char *read_file_text(const char *path)
{
	FILE *fp = fopen(path, "rb");
	if (!fp) return NULL;
	fseek(fp, 0, SEEK_END);
	long sz = ftell(fp);
	rewind(fp);
	if (sz < 0) { fclose(fp); return NULL; }
	char *buf = malloc((size_t)sz + 1);
	if (!buf) { fclose(fp); return NULL; }
	fread(buf, 1, (size_t)sz, fp);
	buf[sz] = '\0';
	fclose(fp);
	return buf;
}

static int write_file(const char *path, const char *data, size_t len)
{
	FILE *fp = fopen(path, "wb");
	if (!fp) return -1;
	if (len > 0) fwrite(data, 1, len, fp);
	fclose(fp);
	return 0;
}

static json_value *obj_get(json_value *obj, const char *key)
{
	if (!obj || obj->type != json_object || !key) return NULL;
	for (unsigned i = 0; i < obj->u.object.length; i++) {
		if (strcmp(obj->u.object.values[i].name, key) == 0)
			return obj->u.object.values[i].value;
	}
	return NULL;
}

static void parse_reminder(json_value *item, Reminder *r)
{
	memset(r, 0, sizeof(*r));
	r->enabled = 1;

	json_value *v;

	v = obj_get(item, "id");
	if (v && v->type == json_string)
		strncpy(r->id, v->u.string.ptr, sizeof(r->id) - 1);

	v = obj_get(item, "title");
	if (v && v->type == json_string)
		strncpy(r->title, v->u.string.ptr, sizeof(r->title) - 1);

	v = obj_get(item, "hour");
	if (v && v->type == json_integer) r->hour = (int)v->u.integer;

	v = obj_get(item, "minute");
	if (v && v->type == json_integer) r->minute = (int)v->u.integer;

	v = obj_get(item, "days");
	if (v && v->type == json_integer) r->days = (uint8_t)v->u.integer;

	v = obj_get(item, "end_time");
	if (v && v->type == json_integer) r->end_time = (time_t)v->u.integer;

	v = obj_get(item, "enabled");
	if (v) {
		if (v->type == json_boolean) r->enabled = v->u.boolean ? 1 : 0;
		else if (v->type == json_integer) r->enabled = (v->u.integer != 0) ? 1 : 0;
	}
}

int RemindersList(const User *u, Reminder *out, int *count)
{
	char path[512];
	RemindersGetPath(u, path, sizeof(path));

	*count = 0;
	char *raw = read_file_text(path);
	if (!raw) return 0;

	json_value *doc = json_parse(raw, strlen(raw));
	free(raw);
	if (!doc || doc->type != json_array) {
		if (doc) json_value_free(doc);
		return 0;
	}

	int n = 0;
	for (unsigned i = 0; i < doc->u.array.length && n < REMINDERS_MAX; i++) {
		json_value *item = doc->u.array.values[i];
		if (!item || item->type != json_object) continue;
		parse_reminder(item, &out[n]);
		if (out[n].id[0]) n++;
	}

	json_value_free(doc);
	*count = n;
	return 0;
}

static void reminder_to_json(const Reminder *r, String *s)
{
	char *esc_title = json_escape_dup(r->title);
	CatTemplateString(s,
		"{\"id\":\"%s\",\"title\":\"%s\","
		"\"hour\":%d,\"minute\":%d,"
		"\"days\":%d,\"end_time\":%lld,\"enabled\":%s}",
		r->id,
		esc_title ? esc_title : "",
		r->hour, r->minute,
		(int)r->days,
		(long long)r->end_time,
		r->enabled ? "true" : "false");
	free(esc_title);
}

static int save_list(const User *u, const Reminder *list, int count)
{
	char path[512];
	RemindersGetPath(u, path, sizeof(path));

	String s;
	InitString(&s, 512);
	CatString(&s, "[", 1);
	for (int i = 0; i < count; i++) {
		if (i > 0) CatString(&s, ",", 1);
		reminder_to_json(&list[i], &s);
	}
	CatString(&s, "]", 1);

	int rc = write_file(path, s.p, s.len);
	FreeString(&s);
	return rc;
}

int RemindersSave(const User *u, const Reminder *r)
{
	Reminder list[REMINDERS_MAX];
	int count = 0;
	RemindersList(u, list, &count);

	for (int i = 0; i < count; i++) {
		if (strcmp(list[i].id, r->id) == 0) {
			list[i] = *r;
			return save_list(u, list, count);
		}
	}

	if (count >= REMINDERS_MAX) return -1;
	list[count] = *r;
	if (!list[count].id[0])
		snprintf(list[count].id, REMINDER_ID_SIZE, "r%ld_%04x",
			(long)change_time_now(), (unsigned)(rand() & 0xFFFF));
	return save_list(u, list, count + 1);
}

int RemindersDelete(const User *u, const char *id)
{
	Reminder list[REMINDERS_MAX];
	int count = 0;
	RemindersList(u, list, &count);

	int found = 0, n = 0;
	for (int i = 0; i < count; i++) {
		if (strcmp(list[i].id, id) == 0) { found = 1; continue; }
		list[n++] = list[i];
	}
	if (!found) return -1;
	return save_list(u, list, n);
}

char *RemindersListJson(const User *u)
{
	Reminder list[REMINDERS_MAX];
	int count = 0;
	RemindersList(u, list, &count);

	String s;
	InitString(&s, 512);
	CatString(&s, "[", 1);
	for (int i = 0; i < count; i++) {
		if (i > 0) CatString(&s, ",", 1);
		reminder_to_json(&list[i], &s);
	}
	CatString(&s, "]", 1);

	char *out = s.p;
	s.p = NULL;
	FreeString(&s);
	return out;
}
