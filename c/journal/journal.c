#define _POSIX_C_SOURCE 200809L

#include "journal.h"
#include "config.h"
#include "util.h"
#include "time-util.h"
#include "http-util.h"
#include "../lib/jsonp/json.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

static int write_file(const char *path, const void *data, size_t len);
static char *read_file_text(const char *path);

static json_value *json_object_get_value(json_value *obj, const char *key)
{
	if (!obj || obj->type != json_object || !key) return NULL;
	for (unsigned i = 0; i < obj->u.object.length; i++) {
		json_object_entry *entry = &obj->u.object.values[i];
		if (strcmp(entry->name, key) == 0)
			return entry->value;
	}
	return NULL;
}

static const char *embed_type_str(EmbedType t)
{
	switch (t) {
	case EMBED_GOAL:    return "goal";
	case EMBED_JOURNAL: return "journal";
	case EMBED_IMAGE:   return "image";
	}
	return "unknown";
}

void JournalGetDir(const User *u, char *out, size_t cap)
{
	snprintf(out, cap, USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME, u->id);
}

void JournalEntryDir(const User *u, const char *eid, char *out, size_t cap)
{
	snprintf(out, cap, USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s", u->id, eid);
}

static void journal_gen_id(char *out)
{
	static int seeded = 0;
	if (!seeded) {
		srand((unsigned)change_time_now() ^ (unsigned)getpid());
		seeded = 1;
	}
	snprintf(out, JOURNAL_ID_SIZE, "%ld_%04x", (long)change_time_now(), rand() & 0xFFFF);
}

static int safe_filename(const char *f)
{
	if (!f || !f[0]) return 0;
	if (strstr(f, "..")) return 0;
	if (strchr(f, '/'))  return 0;
	return 1;
}

static _Bool image_filename(const char *f)
{
	const char *dot = strrchr(f, '.');
	if (!dot) return 0;
	dot++;
	return
		strcasecmp(dot, "jpg") == 0 ||
		strcasecmp(dot, "jpeg") == 0 ||
		strcasecmp(dot, "png") == 0 ||
		strcasecmp(dot, "gif") == 0 ||
		strcasecmp(dot, "webp") == 0;
}

static void journal_file_meta_path(const User *u, const char *id, const char *filename, char *out, size_t cap)
{
	snprintf(out, cap,
		USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s/files/.%s.meta.json",
		u->id, id, filename);
}

static void write_file_meta(const User *u, const char *id, const char *filename)
{
	char path[768];
	journal_file_meta_path(u, id, filename, path, sizeof(path));

	String out;
	InitString(&out, 128);
	CatTemplateString(&out, "{\"uploaded_at\":%ld}", (long)change_time_now());
	write_file(path, out.p, out.len);
	FreeString(&out);
}

static time_t read_file_uploaded_at(const User *u, const char *id, const char *filename)
{
	char path[768];
	journal_file_meta_path(u, id, filename, path, sizeof(path));
	char *raw = read_file_text(path);
	int ts = 0;

	if (!raw) return 0;
	json_get_int_field(raw, "uploaded_at", &ts);
	free(raw);
	return (time_t)ts;
}

static int write_file(const char *path, const void *data, size_t len)
{
	FILE *fp = fopen(path, "wb");
	if (!fp) return -1;
	if (len > 0) fwrite(data, 1, len, fp);
	fclose(fp);
	return 0;
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

static void write_meta(const char *dir, const JournalMeta *m)
{
	char path[512];
	snprintf(path, sizeof(path), "%s/meta.json", dir);

	char *esc_title = json_escape_dup(m->title);

	String s;
	InitString(&s, 512);
	CatTemplateString(&s,
		"{\"id\":\"%s\",\"title\":\"%s\",\"mood_index\":%d,\"last_updated\":%ld,\"icon_index\":%d}",
		m->id, esc_title ? esc_title : "", m->mood_index,
		(long)m->last_updated, m->icon_index);

	free(esc_title);

	write_file(path, s.p, s.len);
	FreeString(&s);
}

static int read_meta(const char *dir, JournalMeta *m)
{
	char path[512];
	snprintf(path, sizeof(path), "%s/meta.json", dir);

	char *raw = read_file_text(path);
	if (!raw) return -1;

	memset(m, 0, sizeof(*m));
	m->mood_index = -1;   /* default: no mood */

	json_get_string_field(raw, "id",    m->id,    sizeof(m->id));
	json_get_string_field(raw, "title", m->title, sizeof(m->title));
	json_get_int_field(raw, "mood_index", &m->mood_index);

	/* backward compat: extract mood from old "tags" field */
	if (m->mood_index == -1) {
		char old_tags[256] = {0};
		json_get_string_field(raw, "tags", old_tags, sizeof(old_tags));
		if (old_tags[0]) {
			char *p = old_tags;
			while (*p) {
				if (strncmp(p, "mood:", 5) == 0) {
					m->mood_index = atoi(p + 5);
					break;
				}
				while (*p && *p != ',') p++;
				if (*p == ',') p++;
			}
		}
	}

	if (!m->id[0]) {
		const char *base = strrchr(dir, '/');
		base = base ? base + 1 : dir;
		strncpy(m->id, base, sizeof(m->id) - 1);
	}

	int ts = 0;
	json_get_int_field(raw, "last_updated", &ts);
	m->last_updated = (time_t)ts;

	json_get_int_field(raw, "icon_index", &m->icon_index);

	free(raw);
	return 0;
}

int JournalCreate(const User *u, const char *title, const char *text, int mood_index, int icon_index, JournalMeta *out)
{
	char jdir[512];
	JournalGetDir(u, jdir, sizeof(jdir));
	mkdir(jdir, 0755);

	JournalMeta m;
	memset(&m, 0, sizeof(m));
	m.mood_index = -1;
	journal_gen_id(m.id);
	strncpy(m.title, title ? title : "", sizeof(m.title) - 1);
	m.mood_index   = mood_index;
	m.last_updated = change_time_now();
	m.icon_index   = icon_index;

	char edir[512];
	JournalEntryDir(u, m.id, edir, sizeof(edir));
	if (mkdir(edir, 0755) != 0) return -1;

	char path[768];
	snprintf(path, sizeof(path), "%s/entry.txt", edir);
	write_file(path, text ? text : "", text ? strlen(text) : 0);

	write_meta(edir, &m);

	if (out) *out = m;
	return 0;
}

JournalMeta *JournalList(const User *u, size_t *out_count)
{
	char jdir[512];
	JournalGetDir(u, jdir, sizeof(jdir));

	DIR *d = opendir(jdir);
	if (!d) { *out_count = 0; return NULL; }

	size_t cap = 64;
	size_t cnt = 0;
	JournalMeta *arr = malloc(cap * sizeof(JournalMeta));
	if (!arr) { closedir(d); *out_count = 0; return NULL; }

	struct dirent *de;
	while ((de = readdir(d)) != NULL) {
		if (de->d_name[0] == '.') continue;

		char edir[768];
		snprintf(edir, sizeof(edir), "%s/%s", jdir, de->d_name);

		struct stat st;
		if (stat(edir, &st) != 0 || !S_ISDIR(st.st_mode)) continue;

		if (cnt >= cap) {
			cap *= 2;
			JournalMeta *tmp = realloc(arr, cap * sizeof(JournalMeta));
			if (!tmp) break;
			arr = tmp;
		}

		if (read_meta(edir, &arr[cnt]) == 0)
			cnt++;
	}
	closedir(d);

	/* sort descending by id (lexicographic = chronological) */
	for (size_t i = 0; i < cnt; i++) {
		for (size_t j = i + 1; j < cnt; j++) {
			if (strcmp(arr[i].id, arr[j].id) < 0) {
				JournalMeta tmp = arr[i];
				arr[i] = arr[j];
				arr[j] = tmp;
			}
		}
	}

	*out_count = cnt;
	return arr;
}

int JournalReadEntry(const User *u, const char *id, char **out_text, JournalMeta *out_meta)
{
	if (!safe_filename(id)) return -1;

	char edir[512];
	JournalEntryDir(u, id, edir, sizeof(edir));

	if (out_meta && read_meta(edir, out_meta) != 0) return -1;

	if (out_text) {
		char path[768];
		snprintf(path, sizeof(path), "%s/entry.txt", edir);
		*out_text = read_file_text(path);
	}

	return 0;
}

int JournalUpdate(const User *u, const char *id, const char *title, const char *text, int mood_index, int icon_index)
{
	if (!safe_filename(id)) return -1;

	char edir[512];
	JournalEntryDir(u, id, edir, sizeof(edir));

	JournalMeta m;
	if (read_meta(edir, &m) != 0) return -1;

	if (title)           strncpy(m.title, title, sizeof(m.title) - 1);
	if (mood_index >= -1) m.mood_index = mood_index;
	if (icon_index >= 0)  m.icon_index = icon_index;
	m.last_updated = change_time_now();
	write_meta(edir, &m);

	if (text) {
		char path[768];
		snprintf(path, sizeof(path), "%s/entry.txt", edir);
		write_file(path, text, strlen(text));
	}

	return 0;
}

static int rmdir_r(const char *path)
{
	DIR *d = opendir(path);
	if (!d) return -1;

	struct dirent *de;
	char buf[768];
	while ((de = readdir(d)) != NULL) {
		if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
		snprintf(buf, sizeof(buf), "%s/%s", path, de->d_name);
		struct stat st;
		if (stat(buf, &st) == 0 && S_ISDIR(st.st_mode))
			rmdir_r(buf);
		else
			unlink(buf);
	}
	closedir(d);
	return rmdir(path);
}

int JournalDelete(const User *u, const char *id)
{
	if (!safe_filename(id)) return -1;
	char edir[512];
	JournalEntryDir(u, id, edir, sizeof(edir));
	return rmdir_r(edir);
}

int JournalAddFile(const User *u, const char *id, const char *filename, const void *data, size_t len)
{
	if (!safe_filename(id) || !safe_filename(filename)) return -1;

	char fdir[512];
	snprintf(fdir, sizeof(fdir),
		USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s/files", u->id, id);
	mkdir(fdir, 0755);

	char path[768];
	snprintf(path, sizeof(path), "%s/%s", fdir, filename);
	if (write_file(path, data, len) != 0) return -1;
	write_file_meta(u, id, filename);
	return 0;
}

char **JournalListFiles(const User *u, const char *id, size_t *out_count)
{
	char fdir[512];
	snprintf(fdir, sizeof(fdir),
		USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s/files", u->id, id);

	DIR *d = opendir(fdir);
	if (!d) { *out_count = 0; return NULL; }

	size_t cap = 16, cnt = 0;
	char **arr = malloc(cap * sizeof(char *));
	if (!arr) { closedir(d); *out_count = 0; return NULL; }

	struct dirent *de;
	while ((de = readdir(d)) != NULL) {
		if (de->d_name[0] == '.') continue;
		if (cnt >= cap) {
			cap *= 2;
			char **tmp = realloc(arr, cap * sizeof(char *));
			if (!tmp) break;
			arr = tmp;
		}
		arr[cnt++] = strdup(de->d_name);
	}
	closedir(d);
	*out_count = cnt;
	return arr;
}

int JournalReadFile(const User *u, const char *id, const char *filename, void **out_data, size_t *out_len)
{
	if (!safe_filename(id) || !safe_filename(filename)) return -1;

	char path[768];
	snprintf(path, sizeof(path),
		USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s/files/%s",
		u->id, id, filename);

	FILE *fp = fopen(path, "rb");
	if (!fp) return -1;

	fseek(fp, 0, SEEK_END);
	long sz = ftell(fp);
	rewind(fp);
	if (sz < 0) { fclose(fp); return -1; }

	void *buf = malloc((size_t)sz);
	if (!buf) { fclose(fp); return -1; }
	fread(buf, 1, (size_t)sz, fp);
	fclose(fp);

	*out_data = buf;
	*out_len  = (size_t)sz;
	return 0;
}

int JournalAddEmbed(const User *u, const char *id, EmbedType type, const char *ref, const char *snapshot_json)
{
	if (!safe_filename(id)) return -1;

	char path[768];
	snprintf(path, sizeof(path),
		USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s/embeds.json",
		u->id, id);

	/* load existing array */
	char *existing = read_file_text(path);
	int   count    = 0;

	/* count existing entries: each starts with '{' after '[' */
	if (existing) {
		const char *p = existing;
		while ((p = strchr(p, '{')) != NULL) { count++; p++; }
	}

	char *esc_ref      = json_escape_dup(ref ? ref : "");
	char *esc_snapshot = snapshot_json ? strdup(snapshot_json) : strdup("{}");

	String out;
	InitString(&out, 1024);
	CatTemplateString(&out, "[");

	if (existing && count > 0) {
		/* strip leading '[' and trailing ']' */
		const char *inner = strchr(existing, '[');
		if (inner) inner++;
		else       inner = existing;

		/* trim trailing whitespace and ']' */
		size_t ilen = strlen(inner);
		while (ilen > 0 && (inner[ilen-1] == ']' || inner[ilen-1] == '\n' || inner[ilen-1] == ' '))
			ilen--;

		CatString(&out, (char *)inner, ilen);
		CatString(&out, ",", 1);
	}

	CatTemplateString(&out,
		"{\"type\":\"%s\",\"ref\":\"%s\",\"snapshot\":%s,\"snapped_at\":%ld}]",
		embed_type_str(type),
		esc_ref ? esc_ref : "",
		esc_snapshot,
		(long)change_time_now());

	free(esc_ref);
	free(esc_snapshot);
	free(existing);

	write_file(path, out.p, out.len);
	FreeString(&out);
	return 0;
}

int JournalRemoveEmbed(const User *u, const char *id, int index)
{
	if (!safe_filename(id) || index < 0) return -1;

	char path[768];
	snprintf(path, sizeof(path),
		USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s/embeds.json",
		u->id, id);

	char *raw = read_file_text(path);
	if (!raw) return -1;

	/* collect each top-level JSON object using balanced-brace scanning */
	const char *starts[64];
	size_t      lens[64];
	int         count = 0;
	const char *p = raw;

	while (*p && count < 64) {
		while (*p && *p != '{') p++;
		if (!*p) break;

		const char *obj_start = p;
		int   depth  = 0;
		int   in_str = 0;
		char  prev   = 0;

		while (*p) {
			if (!in_str) {
				if      (*p == '{')  depth++;
				else if (*p == '}') { if (--depth == 0) { p++; break; } }
				else if (*p == '"')  in_str = 1;
			} else {
				if (*p == '"' && prev != '\\') in_str = 0;
			}
			prev = *p++;
		}

		starts[count] = obj_start;
		lens[count]   = (size_t)(p - obj_start);
		count++;
	}

	if (index >= count) { free(raw); return -1; }

	String out;
	InitString(&out, 512);
	CatString(&out, "[", 1);
	int first = 1;
	for (int i = 0; i < count; i++) {
		if (i == index) continue;
		if (!first) CatString(&out, ",", 1);
		CatString(&out, (char *)starts[i], lens[i]);
		first = 0;
	}
	CatString(&out, "]", 1);

	free(raw);
	write_file(path, out.p, out.len);
	FreeString(&out);
	return 0;
}

char *JournalReadEmbeds(const User *u, const char *id)
{
	if (!safe_filename(id)) return NULL;
	char path[768];
	snprintf(path, sizeof(path),
		USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s/embeds.json",
		u->id, id);
	return read_file_text(path);
}

typedef struct {
	char entry_id[JOURNAL_ID_SIZE];
	char entry_title[JOURNAL_TITLE_SIZE];
	char file[256];
	char caption[512];
	time_t snapped_at;
	time_t uploaded_at;
} JournalImageMemory;

static int memory_cmp_desc(const void *a, const void *b)
{
	const JournalImageMemory *ma = a;
	const JournalImageMemory *mb = b;
	if (ma->snapped_at < mb->snapped_at) return 1;
	if (ma->snapped_at > mb->snapped_at) return -1;
	if (ma->uploaded_at < mb->uploaded_at) return 1;
	if (ma->uploaded_at > mb->uploaded_at) return -1;
	return strcmp(ma->file, mb->file);
}

char *JournalBuildImageMemoriesJson(const User *u)
{
	char jdir[512];
	DIR *d;
	struct dirent *de;
	JournalImageMemory *items = NULL;
	size_t count = 0, cap = 0;
	String out;

	JournalGetDir(u, jdir, sizeof(jdir));
	d = opendir(jdir);
	if (!d) {
		char *empty = strdup("[]");
		return empty;
	}

	while ((de = readdir(d)) != NULL) {
		if (de->d_name[0] == '.') continue;

		char edir[768];
		struct stat st;
		JournalMeta meta;
		snprintf(edir, sizeof(edir), "%s/%s", jdir, de->d_name);
		if (stat(edir, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
		memset(&meta, 0, sizeof(meta));
		read_meta(edir, &meta);

		char embeds_path[768];
		snprintf(embeds_path, sizeof(embeds_path), "%s/embeds.json", edir);
		char *raw = read_file_text(embeds_path);
		if (!raw) continue;

		json_value *doc = json_parse(raw, strlen(raw));
		free(raw);
		if (!doc || doc->type != json_array) {
			if (doc) json_value_free(doc);
			continue;
		}

		for (unsigned i = 0; i < doc->u.array.length; i++) {
			json_value *item = doc->u.array.values[i];
			if (!item || item->type != json_object) continue;

			json_value *type = json_object_get_value(item, "type");
			if (!type || type->type != json_string || strcmp(type->u.string.ptr, "image") != 0) continue;

			json_value *ref = json_object_get_value(item, "ref");
			json_value *snapshot = json_object_get_value(item, "snapshot");
			json_value *snapped_at = json_object_get_value(item, "snapped_at");
			if (!ref || ref->type != json_string || !image_filename(ref->u.string.ptr)) continue;
			if (!snapshot || snapshot->type != json_object) continue;

			json_value *caption = json_object_get_value(snapshot, "caption");
			json_value *file = json_object_get_value(snapshot, "file");
			const char *file_name = (file && file->type == json_string && file->u.string.ptr[0])
				? file->u.string.ptr
				: ref->u.string.ptr;
			if (!file_name[0] || !image_filename(file_name)) continue;

			if (count >= cap) {
				cap = cap ? cap * 2 : 16;
				JournalImageMemory *tmp = realloc(items, cap * sizeof(*items));
				if (!tmp) break;
				items = tmp;
			}

			memset(&items[count], 0, sizeof(*items));
			strncpy(items[count].entry_id, de->d_name, sizeof(items[count].entry_id) - 1);
			strncpy(items[count].entry_title, meta.title, sizeof(items[count].entry_title) - 1);
			strncpy(items[count].file, file_name, sizeof(items[count].file) - 1);
			if (caption && caption->type == json_string)
				strncpy(items[count].caption, caption->u.string.ptr, sizeof(items[count].caption) - 1);
			if (snapped_at && snapped_at->type == json_integer)
				items[count].snapped_at = (time_t)snapped_at->u.integer;
			items[count].uploaded_at = read_file_uploaded_at(u, de->d_name, file_name);
			count++;
		}

		json_value_free(doc);
	}
	closedir(d);

	qsort(items, count, sizeof(*items), memory_cmp_desc);

	InitString(&out, 1024);
	CatString(&out, "[", 1);
	for (size_t i = 0; i < count; i++) {
		char *esc_entry = json_escape_dup(items[i].entry_id);
		char *esc_title = json_escape_dup(items[i].entry_title);
		char *esc_file = json_escape_dup(items[i].file);
		char *esc_caption = json_escape_dup(items[i].caption);
		if (i > 0) CatString(&out, ",", 1);
		CatTemplateString(&out,
			"{\"entry_id\":\"%s\",\"entry_title\":\"%s\",\"file\":\"%s\",\"caption\":\"%s\",\"snapped_at\":%ld,\"uploaded_at\":%ld}",
			esc_entry ? esc_entry : "",
			esc_title ? esc_title : "",
			esc_file ? esc_file : "",
			esc_caption ? esc_caption : "",
			(long)items[i].snapped_at,
			(long)items[i].uploaded_at);
		free(esc_entry);
		free(esc_title);
		free(esc_file);
		free(esc_caption);
	}
	CatString(&out, "]", 1);
	free(items);
	return out.p;
}
