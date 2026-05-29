#ifndef JOURNAL_H
#define JOURNAL_H

#include <stddef.h>
#include <time.h>
#include "user-management.h"

#define JOURNAL_ID_SIZE    48
#define JOURNAL_TITLE_SIZE 256

typedef enum {
	EMBED_GOAL    = 0,
	EMBED_JOURNAL,
	EMBED_IMAGE,
} EmbedType;

typedef struct {
	char   id[JOURNAL_ID_SIZE];
	char   title[JOURNAL_TITLE_SIZE];
	int    mood_index;    /* -1 = no mood; 0-11 = MOODS[] index */
	time_t last_updated;
	int    icon_index;    /* 0-based index into the UI icon palette */
} JournalMeta;

void  JournalGetDir(const User *u, char *out, size_t cap);
void  JournalEntryDir(const User *u, const char *eid, char *out, size_t cap);

int          JournalCreate(const User *u, const char *title, const char *text, int mood_index, int icon_index, JournalMeta *out);
JournalMeta *JournalList(const User *u, size_t *out_count);
int          JournalReadEntry(const User *u, const char *id, char **out_text, JournalMeta *out_meta);
int          JournalUpdate(const User *u, const char *id, const char *title, const char *text, int mood_index, int icon_index);
int          JournalDelete(const User *u, const char *id);

int    JournalAddFile(const User *u, const char *id, const char *filename, const void *data, size_t len);
char **JournalListFiles(const User *u, const char *id, size_t *out_count);
int    JournalReadFile(const User *u, const char *id, const char *filename, void **out_data, size_t *out_len);
char  *JournalBuildImageMemoriesJson(const User *u);

int   JournalAddEmbed(const User *u, const char *id, EmbedType type, const char *ref, const char *snapshot_json);
int   JournalRemoveEmbed(const User *u, const char *id, int index);
char *JournalReadEmbeds(const User *u, const char *id);

#endif
