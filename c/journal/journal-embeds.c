#include "journal-embeds.h"
#include "goal-util.h"
#include "http-util.h"
#include "util.h"

#include <stdio.h>
#include <string.h>

EmbedType EmbedTypeFromString(const char *s)
{
	if (!s) return (EmbedType)-1;
	if (strcmp(s, "goal")    == 0) return EMBED_GOAL;
	if (strcmp(s, "journal") == 0) return EMBED_JOURNAL;
	if (strcmp(s, "image")   == 0) return EMBED_IMAGE;
	return (EmbedType)-1;
}

void JournalEmbedGoal(const char *goal_ref, User *user, char *out, size_t cap)
{
	out[0] = '\0';
	if (!goal_ref || !user) return;

	/* search across all user journeys */
	Goal *g = NULL;
	for (size_t ji = 0; ji < user->journey_count && !g; ji++)
		g = FindGoalByID((char *)goal_ref, user->journeys[ji]);

	if (!g) {
		snprintf(out, cap, "{\"error\":\"goal_not_found\"}");
		return;
	}

	char *esc_title = json_escape_dup(g->title.p ? g->title.p : "");
	snprintf(out, cap,
		"{\"title\":\"%s\",\"started\":%s,\"ended\":%s,\"priority\":%zu}",
		esc_title ? esc_title : "",
		g->start_date > 0 ? "true" : "false",
		g->end_date   > 0 ? "true" : "false",
		g->priority);
	free(esc_title);
}

void JournalEmbedJournal(const char *entry_ref, User *user, char *out, size_t cap)
{
	out[0] = '\0';
	if (!entry_ref || !user) return;

	JournalMeta m;
	if (JournalReadEntry(user, entry_ref, NULL, &m) != 0) {
		snprintf(out, cap, "{\"error\":\"entry_not_found\"}");
		return;
	}

	char *esc_title = json_escape_dup(m.title);
	snprintf(out, cap, "{\"title\":\"%s\"}", esc_title ? esc_title : "");
	free(esc_title);
}

void JournalEmbedImage(const char *file_ref, const char *caption, char *out, size_t cap)
{
	char *esc_caption = json_escape_dup(caption ? caption : "");
	char *esc_file    = json_escape_dup(file_ref ? file_ref : "");
	snprintf(out, cap,
		"{\"caption\":\"%s\",\"file\":\"%s\"}",
		esc_caption ? esc_caption : "",
		esc_file ? esc_file : "");
	free(esc_caption);
	free(esc_file);
}
