#ifndef JOURNAL_EMBEDS_H
#define JOURNAL_EMBEDS_H

#include <stddef.h>
#include "journal.h"
#include "user-management.h"

EmbedType EmbedTypeFromString(const char *s);

void JournalEmbedGoal   (const char *goal_ref,  User *user, char *out, size_t cap);
void JournalEmbedJournal(const char *entry_ref, User *user, char *out, size_t cap);
void JournalEmbedImage  (const char *file_ref, const char *caption, char *out, size_t cap);

#endif
