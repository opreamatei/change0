#define _POSIX_C_SOURCE 200809L

#include "journal.h"
#include "config.h"
#include "util.h"
#include "time-util.h"
#include "http-util.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

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
	char *esc_tags  = json_escape_dup(m->tags);

	String s;
	InitString(&s, 512);
	CatTemplateString(&s,
		"{\"id\":\"%s\",\"title\":\"%s\",\"tags\":\"%s\",\"last_updated\":%ld,\"icon_index\":%d}",
		m->id, esc_title ? esc_title : "", esc_tags ? esc_tags : "",
		(long)m->last_updated, m->icon_index);

	free(esc_title);
	free(esc_tags);

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
	json_get_string_field(raw, "id",    m->id,    sizeof(m->id));
	json_get_string_field(raw, "title", m->title, sizeof(m->title));
	json_get_string_field(raw, "tags",  m->tags,  sizeof(m->tags));

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

int JournalCreate(const User *u, const char *title, const char *text, const char *tags, int icon_index, JournalMeta *out)
{
	char jdir[512];
	JournalGetDir(u, jdir, sizeof(jdir));
	mkdir(jdir, 0755);

	JournalMeta m;
	memset(&m, 0, sizeof(m));
	journal_gen_id(m.id);
	strncpy(m.title, title ? title : "", sizeof(m.title) - 1);
	strncpy(m.tags,  tags  ? tags  : "", sizeof(m.tags)  - 1);
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

int JournalUpdate(const User *u, const char *id, const char *title, const char *text, const char *tags, int icon_index)
{
	if (!safe_filename(id)) return -1;

	char edir[512];
	JournalEntryDir(u, id, edir, sizeof(edir));

	JournalMeta m;
	if (read_meta(edir, &m) != 0) return -1;

	if (title)       strncpy(m.title, title, sizeof(m.title) - 1);
	if (tags)        strncpy(m.tags,  tags,  sizeof(m.tags)  - 1);
	if (icon_index >= 0) m.icon_index = icon_index;
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
	return write_file(path, data, len);
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

char *JournalReadEmbeds(const User *u, const char *id)
{
	if (!safe_filename(id)) return NULL;
	char path[768];
	snprintf(path, sizeof(path),
		USER_DATA_DIRECTORY "%s/" USER_JOURNAL_DIRNAME "/%s/embeds.json",
		u->id, id);
	return read_file_text(path);
}
