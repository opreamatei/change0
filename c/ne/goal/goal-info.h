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

#endif
