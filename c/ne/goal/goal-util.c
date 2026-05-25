#include "goal-util.h"
#include "globals.h"
#include "srv/user/journey.h"
#include <string.h>
#include <stdlib.h>

static inline _Bool is_leaf(Goal *g){
	return g->subgoals_len == 0;
}

enum GOAL_STATUS ValidateGoal(Goal *g, time_t now)
{
	if (g->subgoals_len > 0)
		return GOAL_VALID;

	if (g->start_date && !g->end_date && (now - g->start_date) > CalcGoalRequiredTime(g) * (1 + GOAL_REQUIRED_TIME_ERROR_MARGIN) ){
		return GOAL_INVALID;
	}

	return GOAL_VALID;
}

time_t CalcGoalRequiredTime(Goal *g){
	change_assert(g, "Goal with required time of 0 must not exist [%s]", g->title.p);

	if (g->subgoals_len == 0){
		return g->required_time;
	}

	time_t sum = 0;

	for (size_t i = 0; i < g->subgoals_len; i++){
		Goal *subgoal = FindGoalFromIndex(g->journey_id, g->subgoals[i]);

		sum += CalcGoalRequiredTime(subgoal);
		sum += subgoal->pauseToNext;
	}

	g->required_time = sum;

	return sum;
}

void GoalSystemLazyLoad(goal_emit_like_func *goal_emit){
	if (*goal_emit == NULL){
		*goal_emit = (goal_emit_like_func)ReadGlobalPointer(FSTRING_SIZE_PARAMS("goal_emit"));
		change_assert(*goal_emit, "Can't load goal_emit");
	}
}

void JourneySystemLazyLoad(journey_str_func *title, journey_str_func *info){
	if (title && !*title){
		*title = (journey_str_func)ReadGlobalPointer(FSTRING_SIZE_PARAMS("journey_title"));
		change_assert(*title, "Can't load journey_title — InitJourneySystem not called?\n");
	}
	if (info && !*info){
		*info = (journey_str_func)ReadGlobalPointer(FSTRING_SIZE_PARAMS("journey_info"));
		change_assert(*info, "Can't load journey_info — InitJourneySystem not called?\n");
	}
}

void CreateGoalDSId(char* name, char* deep_search_id){
	size_t index_end = MIN(strlen(name), 200);
	memcpy(deep_search_id, name, index_end);

	memcpy(deep_search_id + index_end, FSTRING_SIZE_PARAMS("-deep-search-id"));
	*(deep_search_id + index_end + FSIZE("-deep-search-id")) = '\0';
}

void CreateSubgoalId(Goal *parent, size_t child_index, goalIDType out)
{
	memset(out, 0, GOAL_ID_SIZE + 1);
	random_id(out, GOAL_ID_SIZE + 1);
	out[32] = '\0';
}

Goal *CreateGoal(char goalId[], String *input_goal, String *input_extrainfo, size_t estimated_time, size_t parent_index, size_t depth, const char *journey_id)
{
	Goal *g = malloc(sizeof(Goal));

	InitString(&g->title, input_goal->len + 1);
	CopyString(&g->title, input_goal);

	InitString(&g->extra_info, input_extrainfo->len + 1);
	CopyString(&g->extra_info, input_extrainfo);

	g->required_time = estimated_time;

	memset(g->id, 0, sizeof(g->id));
	memcpy(g->id, goalId, 32);
	g->id[32] = '\0';

	g->subgoals = NULL;
	g->subgoals_len = 0;
	g->minPauseToNext = 0;
	g->pauseToNext = 0;
	g->priority = 0;
	g->prev = 0;
	g->next = 0;
	g->start_date = 0;
	g->end_date = 0;
	g->retry_depth = 0;
	g->localIndex = 0;
	g->depth = depth;
	g->parent = parent_index;
	g->assigned_to = JOURNEY_USER_UNASSIGNED;

	Journey *j = FindJourneyByID(journey_id);
	change_assert(j, "CreateGoal: unknown journey. [%s]\n", journey_id);

	AddGoalToJourney(j, g);

	return g;
}

Goal *CalcGoalRoot(Goal *g){
	while (g->parent != 0){
		g = FindGoalFromIndex(g->journey_id, g->parent);
	}
	return g;
}

static journey_str_func journey_get_title = NULL;
static journey_str_func journey_get_info  = NULL;

void PersonalizeGoal(String* input1, String *input2, String* out, char* goalId, String *feedback, start_ds_session_like_func start_ds_session, const char *journey_id, User *user){
	change_assert(input1 && input1->p, "PersonalizeGoal: input1 is NULL\n");
	change_assert(start_ds_session, "PersonalizeGoal: start_ds_session is NULL\n");

	char search_id[256];
	CreateGoalDSId(c_str(input1), search_id);

	JourneySystemLazyLoad(&journey_get_title, &journey_get_info);
	const char *jt = (journey_id && journey_id[0]) ? journey_get_title(journey_id) : NULL;
	const char *ji = (journey_id && journey_id[0]) ? journey_get_info(journey_id)  : NULL;

	Task task = {0};
	create_goal_task(input1, input2, feedback, &task, jt, ji);

	start_ds_session(&task, search_id, out, user);
}

Goal *FindGoalByID(goalIDType id, const char *journey_id){
	size_t len = 0;
	Goal **goals = GetGoalsSorted(&len, journey_id);

	Goal *found = NULL;
	for (size_t i = 0; i < len; i++){
		if (!goals[i]) continue;
		if (strcmp(goals[i]->id, id) == 0) {
			found = goals[i];
			break;
		}
	}
	free(goals);
	return found;
}

static size_t EstimateGoalsJSONSize(Goal **container, size_t goals_amm) {
	size_t total = 128;

	for (size_t i = 0; i < goals_amm; i++) {
		Goal *g = container[i];
		if (!g) continue;

		total += 256;
		total += g->title.len;
		total += g->extra_info.len;
		total += g->subgoals_len * 24;
	}

	return total;
}

void SerializeGoalList(Goal **goals, size_t count, String *buffer) {
	if (count == 0) {
		CatFixed(buffer, "[]");
		return;
	}

	ResizeString(buffer, EstimateGoalsJSONSize(goals, count));
	EmptyString(buffer);

	CatFixed(buffer, "[");
	_Bool first = 1;

	for (size_t i = 0; i < count; i++) {
		Goal *g = goals[i];
		if (!g) continue;

		char *esc_title = json_escape_dup(g->title.p ? g->title.p : "");
		char *esc_extra_info = json_escape_dup(g->extra_info.p ? g->extra_info.p : "");
		char *esc_id = json_escape_dup(g->id);

		cassert(esc_title, "Failed to escape goal title.\n");
		cassert(esc_extra_info, "Failed to escape goal extra info.\n");
		cassert(esc_id, "Failed to escape goal id.\n");

		if (!first)
			CatFixed(buffer, ",");

		CatTemplateString(buffer,
				"{"
				"\"title\":\"%s\","
				"\"extra_info\":\"%s\","
				"\"start_date\":%lld,"
				"\"end_date\":%lld,"
				"\"required_time\":%lld,"
				"\"min_pause_to_next\":%lld,"
				"\"pause_to_next\":%lld,"
				"\"subgoals_len\":%zu,"
				"\"parent\":%zu,"
				"\"prev\":%zu,"
				"\"next\":%zu,"
				"\"localIndex\":%zu,"
				"\"depth\":%zu,"
				"\"retry_depth\":%zu,"
				"\"priority\":%zu,"
				"\"assigned_to\":%u,"
				"\"id\":\"%s\","
				"\"subgoals\":[",
				esc_title,
				esc_extra_info,
				(long long)g->start_date,
				(long long)g->end_date,
				(long long)g->required_time,
				(long long)g->minPauseToNext,
				(long long)g->pauseToNext,
				g->subgoals_len,
				g->parent,
				g->prev,
				g->next,
				g->localIndex,
				g->depth,
				g->retry_depth,
				g->priority,
				(unsigned)g->assigned_to,
				esc_id
					);

		for (size_t j = 0; j < g->subgoals_len; j++) {
			if (j > 0)
				CatFixed(buffer, ",");
			CatTemplateString(buffer, "%zu", g->subgoals[j]);
		}

		CatFixed(buffer, "]}");
		first = 0;

		free(esc_title);
		free(esc_extra_info);
		free(esc_id);
	}

	CatFixed(buffer, "]");
}

void SerializeAllGoals(String *buffer, const char *journey_id){
	size_t count = 0;
	Goal **goals = GetGoalsSorted(&count, journey_id);

	SerializeGoalList(goals, count, buffer);

	free(goals);
}

Goal** GetLeafDueGoals(size_t *size, const char *journey_id, const char *user_id){

	*size = 0;
	size_t goals_len = 0;
	Goal **goals = GetGoalsSorted(&goals_len, journey_id);

	Journey *journey = FindJourneyByID(journey_id);
	_Bool apply_user_filter = 0;
	size_t my_index = MAX_JOURNEY_USERS;

	if (journey && journey->is_shared && user_id) {
		my_index = FindUserIndexInJourney(journey, user_id);
		change_assert(my_index < journey->user_count,
			"GetLeafDueGoals: user [%s] is not a participant of shared journey [%s].\n",
			user_id, journey->id);
		apply_user_filter = 1;
	}

	for (size_t pass = 0; pass < 2; pass++) {
		Goal **out = NULL;
		size_t w = 0;

		if (pass == 1) {
			if (*size == 0) { free(goals); return NULL; }
			out = malloc(*size * sizeof(Goal*));
			change_assert(out, "Couldn't allocate memory for due leaf out.\n");
		}

		for (size_t i = 0; i < goals_len; i++){
			Goal *g = goals[i];
			if (!g) continue;
			Goal *next = FindGoalFromIndex(g->journey_id, g->next);

			_Bool goalStartedNotEnded = (g->start_date && !g->end_date);
			_Bool goalStartedEnded    = (g->start_date && g->end_date);
			_Bool nextNotStartedNotEnded = g->next && next && !next->start_date && !next->end_date;

			if (!(goalStartedNotEnded || (goalStartedEnded && nextNotStartedNotEnded)))
				continue;

			if (apply_user_filter && g->subgoals_len == 0 && g->assigned_to != my_index)
				continue;

			if (pass == 0) (*size)++;
			else           out[w++] = g;
		}

		if (pass == 1) {
			free(goals);
			return out;
		}
	}

	free(goals);
	return NULL;
}
