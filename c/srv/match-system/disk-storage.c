#include "internal.h"

/* -------- persistence -------- */

void ensure_conn_dir(void)
{
	if (mkdir(USER_DATA_DIRECTORY, 0755) != 0 && errno != EEXIST)
		change_assert(0, "connections: cannot create user-data dir");
	if (mkdir(CONN_DIR, 0755) != 0 && errno != EEXIST)
		change_assert(0, "connections: cannot create connections dir");
}

void conn_path(const char *id, const char *ext, char *out, size_t out_size)
{
	int n = snprintf(out, out_size, CONN_DIR "%s%s", id, ext);
	change_assert(n > 0 && (size_t)n < out_size, "connections: path too long");
}

void persist_connection(const UserConn *c)
{
	char path[512];
	conn_path(c->id, CONN_EXT, path, sizeof(path));

	char *esc_reason = json_escape_dup(c->reason);
	String out;
	InitString(&out, 512);
	CatTemplateString(&out,
		"{\"id\":\"%s\",\"a\":\"%s\",\"b\":\"%s\","
		"\"a_approved\":%s,\"b_approved\":%s,\"state\":%d,"
		"\"proposed_at\":%lld,\"reason\":\"%s\"}\n",
		c->id, c->a, c->b,
		c->a_approved ? "true" : "false",
		c->b_approved ? "true" : "false",
		(int)c->state,
		(long long)c->proposed_at,
		esc_reason);
	dump_to_file(path, out.p, out.len);
	FreeString(&out);
	free(esc_reason);
}

void append_message_to_file(const UserConnMessage *m)
{
	char path[512];
	conn_path(m->connection_id, MSG_EXT, path, sizeof(path));

	char *esc_text = json_escape_dup(m->text);
	String line;
	InitString(&line, 256 + strlen(m->text));
	CatTemplateString(&line,
		"{\"sender\":\"%s\",\"at\":%lld,\"text\":\"%s\"}\n",
		m->sender, (long long)m->at, esc_text);

	FILE *f = fopen(path, "ab");
	change_assert(f, "connections: cannot append message to %s", path);
	fwrite(line.p, 1, line.len, f);
	fclose(f);

	FreeString(&line);
	free(esc_text);
}

static void copy_str(char *dst, size_t cap, const char *src, size_t len)
{
	if (len >= cap) len = cap - 1;
	memcpy(dst, src, len);
	dst[len] = '\0';
}

static void load_connection_from_file(const char *path)
{
	change_assert(ConnectionCount < MAX_CONNECTIONS, "connections: table full while loading");
	size_t flen = 0;
	char *data = readFile((char *)path, &flen);
	if (!data) return;

	json_value *doc = json_parse(data, flen);
	if (!doc || doc->type != json_object) {
		free(data);
		if (doc) json_value_free(doc);
		return;
	}

	UserConn *c = &ConnectionTable[ConnectionCount];
	memset(c, 0, sizeof(*c));

	json_value *v;

	v = json_object_get(doc, "id");
	if (v && v->type == json_string)
		copy_str(c->id, CONNECTION_ID_SIZE, v->u.string.ptr, v->u.string.length);

	v = json_object_get(doc, "a");
	if (v && v->type == json_string)
		copy_str(c->a, USER_ID_SIZE, v->u.string.ptr, v->u.string.length);

	v = json_object_get(doc, "b");
	if (v && v->type == json_string)
		copy_str(c->b, USER_ID_SIZE, v->u.string.ptr, v->u.string.length);

	v = json_object_get(doc, "a_approved");
	if (v && v->type == json_boolean) c->a_approved = v->u.boolean ? 1 : 0;

	v = json_object_get(doc, "b_approved");
	if (v && v->type == json_boolean) c->b_approved = v->u.boolean ? 1 : 0;

	v = json_object_get(doc, "state");
	if (v && v->type == json_integer) c->state = (ConnState)v->u.integer;

	v = json_object_get(doc, "proposed_at");
	if (v && v->type == json_integer) c->proposed_at = (time_t)v->u.integer;

	v = json_object_get(doc, "reason");
	if (v && v->type == json_string)
		copy_str(c->reason, MATCH_REASON_SIZE, v->u.string.ptr, v->u.string.length);

	json_value_free(doc);
	free(data);

	if (c->id[0]) ConnectionCount++;
}

static void load_messages_for(const char *connection_id)
{
	char path[512];
	conn_path(connection_id, MSG_EXT, path, sizeof(path));
	size_t flen = 0;
	char *data = readFile(path, &flen);
	if (!data) return;

	size_t i = 0;
	while (i < flen && MessageCount < MAX_MESSAGES) {
		size_t start = i;
		while (i < flen && data[i] != '\n') i++;
		size_t line_len = i - start;
		if (i < flen) i++;
		if (line_len == 0) continue;

		json_value *doc = json_parse(data + start, line_len);
		if (!doc || doc->type != json_object) {
			if (doc) json_value_free(doc);
			continue;
		}

		UserConnMessage *m = &MessageTable[MessageCount];
		memset(m, 0, sizeof(*m));
		strncpy(m->connection_id, connection_id, CONNECTION_ID_SIZE - 1);

		json_value *v;

		v = json_object_get(doc, "sender");
		if (v && v->type == json_string)
			copy_str(m->sender, USER_ID_SIZE, v->u.string.ptr, v->u.string.length);

		v = json_object_get(doc, "at");
		if (v && v->type == json_integer) m->at = (time_t)v->u.integer;

		v = json_object_get(doc, "text");
		if (v && v->type == json_string)
			copy_str(m->text, MESSAGE_TEXT_SIZE, v->u.string.ptr, v->u.string.length);

		json_value_free(doc);
		if (m->sender[0] && m->text[0]) MessageCount++;
	}

	free(data);
}

/* -------- lifecycle -------- */

void InitConnectionSystem(void)
{
	ConnectionCount = 0;
	MessageCount = 0;
	ensure_conn_dir();

	DIR *d = opendir(CONN_DIR);
	if (!d) return;
	struct dirent *e;
	while ((e = readdir(d)) != NULL) {
		size_t n = strlen(e->d_name);
		if (n < 6 || strcmp(e->d_name + n - 5, CONN_EXT) != 0) continue;
		char path[512];
		snprintf(path, sizeof(path), CONN_DIR "%s", e->d_name);
		load_connection_from_file(path);
	}
	closedir(d);

	for (size_t i = 0; i < ConnectionCount; i++)
		load_messages_for(ConnectionTable[i].id);
}

void FreeConnectionSystem(void)
{
	ConnectionCount = 0;
	MessageCount = 0;
}
