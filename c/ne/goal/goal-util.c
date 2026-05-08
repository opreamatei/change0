#include "goal-util.h"
#include "globals.h"
#include <string.h>

Goal *GOAL_CONTAINER[1024];
size_t GOAL_CONTAINER_COUNT = INITIAL_GOAL_INDEX;

enum GOAL_STATUS ValidateGoal(Goal *g, time_t now)
{
	// parent goals are valid because they depend on children validation
	if (g->subgoals_len > 0)
		return GOAL_VALID;

	if (g->start_date && !g->end_date && (now - g->start_date) > CalcGoalRequiredTime(g) * (1 + GOAL_REQUIRED_TIME_ERROR_MARGIN) ){
		// goal is imposible to finish
		return GOAL_INVALID;
	}

	// goal hasn't started
	return GOAL_VALID;
}

time_t CalcGoalRequiredTime(Goal *g){
	change_assert(g, "Goal with required time of 0 must not exist [%s]", g->title.p);

	/*
		If a goal has children, return the children sum
		else return the default required time 
	*/

	if (g->subgoals_len == 0){
		return g->required_time;
	}

	time_t sum = 0;

	for (size_t i = 0; i < g->subgoals_len; i++){
		Goal *subgoal = FindGoalFromIndex(g->subgoals[i]);
		
		sum += CalcGoalRequiredTime(subgoal);		
	}

	// also cache the calculated required just in case children are regenerated
	g->required_time = sum;

	return sum;
}

void GoalSystemLazyLoad(goal_emit_like_func *goal_emit){
    if (*goal_emit == NULL){
        *goal_emit = (goal_emit_like_func)ReadGlobalPointer(FSTRING_SIZE_PARAMS("goal_emit"));
	change_assert(goal_emit, "Can't load goal_emit");
    }
}

Goal *ExternalFindGoal(size_t id){
	return FindGoalFromIndex(id);
}

void CreateGoalDSId(char* name, char* deep_search_id){
	size_t index_end = MIN(strlen(name), 200);
	memcpy(deep_search_id, name, index_end);

	memcpy(deep_search_id + index_end, FSTRING_SIZE_PARAMS("-deep-search-id"));
	*(deep_search_id + index_end + FSIZE("-deep-search-id")) = '\0';
}

// AI generated function
void CreateSubgoalId(Goal *parent, size_t child_index, char out[33])
{
	memset(out, 0, 33);

	int n = snprintf(out, 33, "g%zu-%zu", parent->globalIndex, child_index + 1);

	change_assert(n > 0 && n < 33, "Failed to create subgoal id.\n");
}

Goal *CreateGoal(char goalId[], String *input_goal, String *input_extrainfo, size_t estimated_time, size_t parent_index, size_t depth)
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
	g->priority = 0;
	g->prev = 0;
	g->next = 0;
	g->start_date = 0;
	g->end_date = 0;
	g->retry_depth = 0;
	g->globalIndex = GOAL_CONTAINER_COUNT;
	g->depth = depth;

	g->parent = parent_index;

	GOAL_CONTAINER[GOAL_CONTAINER_COUNT] = g;

	GOAL_CONTAINER_COUNT++;

	return g;
}

Goal *CalcGoalRoot(Goal *g){
	while (g->parent != 0){
		g = FindGoalFromIndex(g->parent);
	}
	return g;
}
 
Goal **GetGoalsContainer(size_t *len){
	*len = GOAL_CONTAINER_COUNT - INITIAL_GOAL_INDEX;
	return &GOAL_CONTAINER[1];
}

void PersonalizeGoal(String* input1, String *input2, String* out, char* goalId, start_ds_session_like_func start_ds_session){
	InitString(out, 2048);

	// Init params
	char search_id[256];
	CreateGoalDSId(c_str(input1), search_id);

	Task task = {0};
	create_goal_task(input1, input2, &task);
	
	// customize goal
	start_ds_session(&task, search_id, out);

}

Goal *FindGoalByID(goalIDType id){
	// TODO : use a goal_id
	size_t len = GOAL_CONTAINER_COUNT - INITIAL_GOAL_INDEX;
	Goal** goals = GetGoalsContainer(&len);
	
	for (size_t i = 0; i < len; i++){
		Goal* goal = goals[i];
		if (strcmp(goal->id, id) == 0)
			return goal;
	}
		return NULL;
}

time_t StartGoal(goalIDType goalID){
	Goal* g = FindGoalByID(goalID);
	change_assert(g, "Goal not found, target goal id %s, serialized goals.", goalID);

	time_t now = time(NULL);

	g->start_date = now;
	
	return now;
}

time_t EndGoal(goalIDType goalID){
	Goal* g = FindGoalByID(goalID);
	change_assert(g, "Goal not found, target goal id %s, serialized goals.", goalID);

	time_t now = time(NULL);

	g->end_date = now;
	
	return now;
}
