#ifndef GOAL_INFO_DEFINITIONS
#define GOAL_INFO_DEFINITIONS

#include "goal-util.h"

#define OTHER_GOAL_TEMPLATE \
"{\"relation\":\"%s\",\"goal_title\":\"%s\",\"goal_extrainfo\":\"%s\",\"depth\":%zu,\"estimated_time\":%zu,\"started_on_date\" : \"%s\",\"finished_on_date\":\"%s\"}\n"

#define OTHER_GOAL_TEMPLATE_RICH \
"{\"relation\":\"%s\",\"goal_title\":\"%s\",\"goal_extrainfo\":\"%s\",\"depth\":%zu,\"estimated_time\":%zu,\"started_on_date\" : \"%s\",\"finished_on_date\":\"%s\",\"time_efficiency_metric\" : \"%s\"}\n"

char* SerializeGoal(Goal* g, size_t *length, char* relation, _Bool showExtraInfo);

void SerializeUserGoalHistoryUpTo(Goal* g, String *buffer, int max);
void SerializeUserGoalHistory(String *buffer, size_t max, const char *journey_id);
void SerializeSlibingGoals(Goal *g, String *buffer);
void SerializeGoalParentChain(Goal *g, String *buffer);
void SerializeGoalLinkedSlibingsChain(Goal *g, String *buffer, _Bool displayInfo);
void SerializeGoalParentSlibings(Goal *g, String *buffer, _Bool displayInfo);
void SerializeStalledGoals(String *buffer, size_t max, const char *journey_id);
void SerializeDueGoals(String *buffer, size_t max, const char *journey_id);

/*
 * Shared-journey level views — they describe the journey as a whole, not
 * one user's goal history. Both lookups need the journey because the
 * participant index lives on the journey's users[] table, not on the goal.
 *
 * SerializeJourneyCompletionAttribution emits a compact line per completed
 * leaf identifying which participant finished it, with elapsed duration vs.
 * estimated time. Capped at `max` entries (most recent first).
 *
 * SerializeJourneyDelayAttribution emits a line per active leaf currently
 * over its estimated_time, identifying which participant owns it and by
 * how much it is overdue. Used to feed pacing back into the decomposer.
 *
 * Both return an empty placeholder string when the journey has no leaves
 * matching the predicate — never NULL.
 */
void SerializeJourneyCompletionAttribution(String *buffer, size_t max, const char *journey_id);
void SerializeJourneyDelayAttribution(String *buffer, size_t max, const char *journey_id);

/*
 * Render the shared-journey participants block exactly as the prompts
 * expect: one line per participant in the form
 *   "User <index> (<display_name>): <context_summary>\n"
 * If a context_summary is missing the line stops at the display_name.
 */
void SerializeJourneyParticipants(String *buffer, const char *journey_id);

#endif
