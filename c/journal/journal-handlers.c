#define _POSIX_C_SOURCE 200809L

#include "journal.h"
#include "journal-embeds.h"
#include "http-util.h"
#include "util.h"
#include "user-management.h"
#include "internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* ── MIME detection ── */

static const char *mime_from_ext(const char *filename)
{
	const char *dot = strrchr(filename, '.');
	if (!dot) return "application/octet-stream";
	dot++;
	if (strcasecmp(dot, "jpg")  == 0 || strcasecmp(dot, "jpeg") == 0) return "image/jpeg";
	if (strcasecmp(dot, "png")  == 0) return "image/png";
	if (strcasecmp(dot, "gif")  == 0) return "image/gif";
	if (strcasecmp(dot, "webp") == 0) return "image/webp";
	if (strcasecmp(dot, "pdf")  == 0) return "application/pdf";
	if (strcasecmp(dot, "txt")  == 0) return "text/plain";
	if (strcasecmp(dot, "mp4")  == 0) return "video/mp4";
	return "application/octet-stream";
}

/* ── helpers ── */

static void send_ok_id(int fd, const char *id)
{
	char buf[128];
	snprintf(buf, sizeof(buf), "{\"ok\":true,\"id\":\"%s\"}", id);
	http_send_json(fd, 200, "OK", buf);
}

/* ── POST /journal/create ── */

void handle_post_journal_create(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char title[JOURNAL_TITLE_SIZE] = {0};

	json_get_string_field(req->body, "title", title, sizeof(title));

	int mood_index = -1;
	int icon_index = 0;
	json_get_int_field(req->body, "mood_index", &mood_index);
	json_get_int_field(req->body, "icon_index", &icon_index);

	/* text may be large — use a heap buffer */
	char *text = NULL;
	size_t text_cap = 8192;
	text = malloc(text_cap);
	if (text) {
		text[0] = '\0';
		json_get_string_field(req->body, "text", text, text_cap);
	}

	JournalMeta m;
	int rc = JournalCreate(user, title, text ? text : "", mood_index, icon_index, &m);
	free(text);

	if (rc != 0) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"create_failed\"}");
		return;
	}

	send_ok_id(fd, m.id);
}

/* ── GET /journal/list ── */

void handle_get_journal_list(int fd, User *user)
{
	size_t      count = 0;
	JournalMeta *list = JournalList(user, &count);

	String out;
	InitString(&out, 1024);
	CatString(&out, "[", 1);

	for (size_t i = 0; i < count; i++) {
		if (i > 0) CatString(&out, ",", 1);

		char *esc_title = json_escape_dup(list[i].title);

		CatTemplateString(&out,
			"{\"id\":\"%s\",\"title\":\"%s\",\"mood_index\":%d,\"last_updated\":%ld,\"icon_index\":%d}",
			list[i].id,
			esc_title ? esc_title : "",
			list[i].mood_index,
			(long)list[i].last_updated,
			list[i].icon_index);

		free(esc_title);
	}

	CatString(&out, "]", 1);
	free(list);

	http_send_json(fd, 200, "OK", out.p);
	FreeString(&out);
}

/* ── GET /journal/entry?id=… ── */

void handle_get_journal_entry(int fd, const HttpRequest *req, User *user)
{
	const char *query = NULL;
	char path[256];
	split_path_and_query(req->path, path, sizeof(path), &query);

	char id[JOURNAL_ID_SIZE] = {0};
	if (!query || !query_get_param(query, "id", id, sizeof(id)) || !id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

	JournalMeta m;
	char *text = NULL;
	if (JournalReadEntry(user, id, &text, &m) != 0) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"not_found\"}");
		return;
	}

	size_t  fcount = 0;
	char  **files  = JournalListFiles(user, id, &fcount);
	char   *embeds = JournalReadEmbeds(user, id);

	String out;
	InitString(&out, 4096);

	char *esc_id    = json_escape_dup(m.id);
	char *esc_title = json_escape_dup(m.title);
	char *esc_text  = json_escape_dup(text ? text : "");

	CatTemplateString(&out,
		"{\"ok\":true,\"meta\":{\"id\":\"%s\",\"title\":\"%s\",\"mood_index\":%d,\"last_updated\":%ld,\"icon_index\":%d},"
		"\"text\":\"%s\",\"files\":[",
		esc_id ? esc_id : "",
		esc_title ? esc_title : "",
		m.mood_index,
		(long)m.last_updated,
		m.icon_index,
		esc_text ? esc_text : "");

	free(esc_id); free(esc_title); free(esc_text);

	for (size_t i = 0; i < fcount; i++) {
		if (i > 0) CatString(&out, ",", 1);
		char *esc_f = json_escape_dup(files[i]);
		CatTemplateString(&out, "\"%s\"", esc_f ? esc_f : "");
		free(esc_f);
		free(files[i]);
	}
	free(files);

	CatString(&out, "],\"embeds\":", 11);
	CatString(&out, embeds ? embeds : "[]", embeds ? strlen(embeds) : 2);
	CatString(&out, "}", 1);

	free(embeds);
	free(text);

	http_send_json(fd, 200, "OK", out.p);
	FreeString(&out);
}

/* ── POST /journal/update ── */

void handle_post_journal_update(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char id[JOURNAL_ID_SIZE]       = {0};
	char title[JOURNAL_TITLE_SIZE] = {0};

	json_get_string_field(req->body, "id",    id,    sizeof(id));
	json_get_string_field(req->body, "title", title, sizeof(title));

	int mood_index = -2;  /* sentinel: not provided */
	int icon_index = -1;  /* -1 = don't change */
	json_get_int_field(req->body, "mood_index", &mood_index);
	json_get_int_field(req->body, "icon_index", &icon_index);

	char *text = NULL;
	size_t text_cap = 8192;
	text = malloc(text_cap);
	if (text) {
		text[0] = '\0';
		json_get_string_field(req->body, "text", text, text_cap);
	}

	int rc = JournalUpdate(user, id,
		title[0] ? title : NULL,
		(text && text[0]) ? text : NULL,
		mood_index,
		icon_index);
	free(text);

	if (rc != 0) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"not_found\"}");
		return;
	}

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

/* ── POST /journal/delete ── */

void handle_post_journal_delete(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char id[JOURNAL_ID_SIZE] = {0};
	json_get_string_field(req->body, "id", id, sizeof(id));

	if (!id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_id\"}");
		return;
	}

	if (JournalDelete(user, id) != 0) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"not_found\"}");
		return;
	}

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

/* ── POST /journal/attach?id=…&f=… ── */

void handle_post_journal_attach(int fd, const HttpRequest *req, User *user)
{
	const char *query = NULL;
	char path[256];
	split_path_and_query(req->path, path, sizeof(path), &query);

	char id[JOURNAL_ID_SIZE] = {0};
	char fname[256]          = {0};

	if (!query ||
	    !query_get_param(query, "id", id, sizeof(id)) ||
	    !id[0] ||
	    !query_get_param(query, "f", fname, sizeof(fname)) ||
	    !fname[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_params\"}");
		return;
	}

	if (!req->body || req->body_len == 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"empty_body\"}");
		return;
	}

	if (JournalAddFile(user, id, fname, req->body, req->body_len) != 0) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"write_failed\"}");
		return;
	}

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

/* ── GET /journal/file?id=…&f=… ── */

void handle_get_journal_file(int fd, const HttpRequest *req, User *user)
{
	const char *query = NULL;
	char path[256];
	split_path_and_query(req->path, path, sizeof(path), &query);

	char id[JOURNAL_ID_SIZE] = {0};
	char fname[256]          = {0};

	if (!query ||
	    !query_get_param(query, "id", id, sizeof(id)) ||
	    !id[0] ||
	    !query_get_param(query, "f", fname, sizeof(fname)) ||
	    !fname[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_params\"}");
		return;
	}

	void  *data = NULL;
	size_t len  = 0;
	if (JournalReadFile(user, id, fname, &data, &len) != 0) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"file_not_found\"}");
		return;
	}

	const char *mime = mime_from_ext(fname);

	char header[512];
	int  hlen = snprintf(header, sizeof(header),
		"HTTP/1.1 200 OK\r\n"
		"Content-Type: %s\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Content-Length: %zu\r\n"
		"Connection: close\r\n"
		"\r\n",
		mime, len);

	http_send_all(fd, header, (size_t)hlen);
	if (data && len) http_send_all(fd, data, len);
	free(data);
}

/* ── POST /journal/embed/delete ── */

void handle_post_journal_embed_delete(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char id[JOURNAL_ID_SIZE] = {0};
	int  index = -1;

	json_get_string_field(req->body, "id",    id,    sizeof(id));
	json_get_int_field   (req->body, "index", &index);

	if (!id[0] || index < 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}

	if (JournalRemoveEmbed(user, id, index) != 0) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"not_found\"}");
		return;
	}

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

/* ── POST /journal/embed ── */

void handle_post_journal_embed(int fd, const HttpRequest *req, User *user)
{
	if (!req->body) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
		return;
	}

	char id[JOURNAL_ID_SIZE] = {0};
	char type_str[32]        = {0};
	char ref[256]            = {0};
	char caption[512]        = {0};

	json_get_string_field(req->body, "id",      id,       sizeof(id));
	json_get_string_field(req->body, "type",    type_str, sizeof(type_str));
	json_get_string_field(req->body, "ref",     ref,      sizeof(ref));
	json_get_string_field(req->body, "caption", caption,  sizeof(caption));

	if (!id[0] || !type_str[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}

	EmbedType etype = EmbedTypeFromString(type_str);
	if ((int)etype < 0) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"unknown_embed_type\"}");
		return;
	}

	char snapshot[1024] = {0};
	switch (etype) {
	case EMBED_GOAL:
		JournalEmbedGoal(ref, user, snapshot, sizeof(snapshot));
		break;
	case EMBED_JOURNAL:
		JournalEmbedJournal(ref, user, snapshot, sizeof(snapshot));
		break;
	case EMBED_IMAGE:
		JournalEmbedImage(ref, caption, snapshot, sizeof(snapshot));
		break;
	}

	if (JournalAddEmbed(user, id, etype, ref, snapshot[0] ? snapshot : "{}") != 0) {
		http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"embed_failed\"}");
		return;
	}

	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}
