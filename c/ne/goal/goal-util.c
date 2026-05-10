#include "goal-util.h"
#include "globals.h"
#include <string.h>
#include <stdlib.h>

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
		sum += subgoal->pauseToNext;
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
void CreateSubgoalId(Goal *parent, size_t child_index, goalIDType out)
{
	memset(out, 0, GOAL_ID_SIZE + 1);

	//int n = snprintf(out, 33, "g%zu-%zu", parent->globalIndex, child_index + 1);
	// TODO merge the two techniques
	random_id(out, GOAL_ID_SIZE + 1);
	out[32] = '\0';
	//change_assert(n > 0 && n < 33, "Failed to create subgoal id.\n");
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
	g->minPauseToNext = 0;
	g->pauseToNext = 0;
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

void PersonalizeGoal(String* input1, String *input2, String* out, char* goalId, String *feedback, start_ds_session_like_func start_ds_session){

	// Init params
	char search_id[256];
	CreateGoalDSId(c_str(input1), search_id);

	Task task = {0};
	create_goal_task(input1, input2, feedback, &task);

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

static void ClearGoalsContainer(void) {
	for (size_t i = INITIAL_GOAL_INDEX; i < GOAL_CONTAINER_COUNT; i++) {
		Goal *g = GOAL_CONTAINER[i];
		if (!g) continue;

		if (g->title.p) {
			FreeString(&g->title);
		}

		if (g->extra_info.p) {
			FreeString(&g->extra_info);
		}

		free(g->subgoals);
		g->subgoals = NULL;
		g->subgoals_len = 0;

		free(g);
		GOAL_CONTAINER[i] = NULL;
	}

	GOAL_CONTAINER_COUNT = INITIAL_GOAL_INDEX;
}

static size_t EstimateGoalsJSONSize(Goal **container, size_t goals_amm) {
    size_t total = 128; // '[' + ']'

    for (size_t i = 0; i < goals_amm; i++) {
        Goal *g = container[i];

        total += 256; 

        total += g->title.len;
        total += g->extra_info.len;

        total += g->subgoals_len * 24;
    }

    return total;
}

void SerializeAllGoals(String *buffer){

	size_t goals_amm = 0;
	Goal** container = GetGoalsContainer(&goals_amm);

	if (goals_amm == 0){
		CatFixed(buffer, "[]");
		return;
	};

	ResizeString(buffer, EstimateGoalsJSONSize(container, goals_amm));
	EmptyString(buffer);

	CatFixed(buffer, "[");

	for (size_t i = 0; i < goals_amm; i++) {
		Goal *g = container[i];

		char *esc_title = json_escape_dup(g->title.p ? g->title.p : "");
		char *esc_extra_info = json_escape_dup(g->extra_info.p ? g->extra_info.p : "");
		char *esc_id = json_escape_dup(g->id);

		cassert(esc_title, "Failed to escape goal title.\n");
		cassert(esc_extra_info, "Failed to escape goal extra info.\n");
		cassert(esc_id, "Failed to escape goal id.\n");

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
				"\"globalIndex\":%zu,"
				"\"depth\":%zu,"
				"\"retry_depth\":%zu,"
				"\"priority\":%zu,"
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
				g->globalIndex,
				g->depth,
				g->retry_depth,
				g->priority,
				esc_id
					);

		for (size_t j = 0; j < g->subgoals_len; j++) {
			if (j > 0) {
				CatFixed(buffer, ",");
			}

			CatTemplateString(buffer, "%zu", g->subgoals[j]);
		}

		CatTemplateString(buffer, "]}%c", i != goals_amm - 1 ? ',' : ' ');

		free(esc_title);
		free(esc_extra_info);
		free(esc_id);
	}

	CatFixed(buffer, "]");
}

void ExportGoalsTo(char* path){
	String buff; InitString(&buff,1);
	SerializeAllGoals(&buff);
	dump_to_file(path, buff.p, buff.len);
	FreeString(&buff);
}

void LoadGoalsFromFile(char* path) {
	ClearGoalsContainer();

	size_t len = 0;
	char *buff = readFile(path, &len);
	if (massert(buff, "Couldn't load goals from file.\n")) {
		return;
	}

	json_value *doc = json_parse(buff, len);
	change_assert(doc, "Couldn't parse goals file [%s]\n", path);
	change_assert(doc->type == json_array, "Goals file must contain a JSON array.\n");

	size_t max_index = INITIAL_GOAL_INDEX - 1;

	for (unsigned i = 0; i < doc->u.array.length; i++) {
		json_value *item = doc->u.array.values[i];
		change_assert(item && item->type == json_object, "Goal item at [%u] is not an object.\n", i);

		int64_t global_index_raw = -1;

		for (unsigned j = 0; j < item->u.object.length; j++) {
			json_object_entry *entry = &item->u.object.values[j];
			if (strcmp(entry->name, "globalIndex") == 0) {
				change_assert(entry->value && entry->value->type == json_integer, "Goal globalIndex missing or not integer.\n");
				global_index_raw = entry->value->u.integer;
				break;
			}
		}

		change_assert(global_index_raw >= (int64_t)INITIAL_GOAL_INDEX, "Goal globalIndex must be >= %d.\n", INITIAL_GOAL_INDEX);
		change_assert(global_index_raw < 1024, "Goal globalIndex out of bounds.\n");

		size_t global_index = (size_t)global_index_raw;
		if (global_index > max_index) {
			max_index = global_index;
		}
	}

	GOAL_CONTAINER_COUNT = max_index + 1;

	for (size_t i = INITIAL_GOAL_INDEX; i < GOAL_CONTAINER_COUNT; i++) {
		GOAL_CONTAINER[i] = NULL;
	}

	for (unsigned i = 0; i < doc->u.array.length; i++) {
		json_value *item = doc->u.array.values[i];
		Goal *g = calloc(1, sizeof(Goal));
		cassert(g, "Failed to allocate goal while loading.\n");
		json_value *subgoals = NULL;
		const char *title = NULL;
		const char *extra_info = NULL;
		const char *id = NULL;
		size_t global_index = 0;

		for (unsigned j = 0; j < item->u.object.length; j++) {
			json_object_entry *entry = &item->u.object.values[j];
			json_value *value = entry->value;

			if (strcmp(entry->name, "title") == 0) {
				change_assert(value && value->type == json_string, "Goal title missing or not string.\n");
				title = value->u.string.ptr;
			} else if (strcmp(entry->name, "extra_info") == 0) {
				change_assert(value && value->type == json_string, "Goal extra_info missing or not string.\n");
				extra_info = value->u.string.ptr;
			} else if (strcmp(entry->name, "id") == 0) {
				change_assert(value && value->type == json_string, "Goal id missing or not string.\n");
				id = value->u.string.ptr;
			} else if (strcmp(entry->name, "start_date") == 0) {
				change_assert(value && value->type == json_integer, "Goal start_date missing or not integer.\n");
				g->start_date = (time_t)value->u.integer;
			} else if (strcmp(entry->name, "end_date") == 0) {
				change_assert(value && value->type == json_integer, "Goal end_date missing or not integer.\n");
				g->end_date = (time_t)value->u.integer;
			} else if (strcmp(entry->name, "required_time") == 0) {
				change_assert(value && value->type == json_integer, "Goal required_time missing or not integer.\n");
				g->required_time = (time_t)value->u.integer;
			} else if (strcmp(entry->name, "min_pause_to_next") == 0) {
				change_assert(value && value->type == json_integer, "Goal min_pause_to_next missing or not integer.\n");
				g->minPauseToNext = (time_t)value->u.integer;
			} else if (strcmp(entry->name, "pause_to_next") == 0) {
				change_assert(value && value->type == json_integer, "Goal pause_to_next missing or not integer.\n");
				g->pauseToNext = (time_t)value->u.integer;
			} else if (strcmp(entry->name, "parent") == 0) {
				change_assert(value && value->type == json_integer, "Goal parent missing or not integer.\n");
				g->parent = (size_t)value->u.integer;
			} else if (strcmp(entry->name, "prev") == 0) {
				change_assert(value && value->type == json_integer, "Goal prev missing or not integer.\n");
				g->prev = (size_t)value->u.integer;
			} else if (strcmp(entry->name, "next") == 0) {
				change_assert(value && value->type == json_integer, "Goal next missing or not integer.\n");
				g->next = (size_t)value->u.integer;
			} else if (strcmp(entry->name, "globalIndex") == 0) {
				change_assert(value && value->type == json_integer, "Goal globalIndex missing or not integer.\n");
				change_assert(value->u.integer >= (int64_t)INITIAL_GOAL_INDEX, "Goal globalIndex must be >= %d.\n", INITIAL_GOAL_INDEX);
				global_index = (size_t)value->u.integer;
				g->globalIndex = global_index;
			} else if (strcmp(entry->name, "depth") == 0) {
				change_assert(value && value->type == json_integer, "Goal depth missing or not integer.\n");
				g->depth = (size_t)value->u.integer;
			} else if (strcmp(entry->name, "retry_depth") == 0) {
				change_assert(value && value->type == json_integer, "Goal retry_depth missing or not integer.\n");
				g->retry_depth = (size_t)value->u.integer;
			} else if (strcmp(entry->name, "priority") == 0) {
				change_assert(value && value->type == json_integer, "Goal priority missing or not integer.\n");
				g->priority = (size_t)value->u.integer;
			} else if (strcmp(entry->name, "subgoals") == 0) {
				change_assert(value && value->type == json_array, "Goal subgoals missing or not array.\n");
				subgoals = value;
			}
		}

		change_assert(title, "Goal title field missing.\n");
		change_assert(extra_info, "Goal extra_info field missing.\n");
		change_assert(id, "Goal id field missing.\n");
		change_assert(global_index >= INITIAL_GOAL_INDEX, "Goal globalIndex field missing.\n");
		change_assert(!GOAL_CONTAINER[global_index], "Duplicate goal globalIndex [%zu].\n", global_index);
		change_assert(subgoals, "Goal subgoals field missing.\n");

		InitString(&g->title, strlen(title) + 1);
		CatString(&g->title, (char *)title, strlen(title));

		InitString(&g->extra_info, strlen(extra_info) + 1);
		CatString(&g->extra_info, (char *)extra_info, strlen(extra_info));

		change_assert(strlen(id) <= GOAL_ID_SIZE, "Goal id too long for goal [%zu].\n", global_index);
		memset(g->id, 0, sizeof(g->id));
		memcpy(g->id, id, strlen(id));
		g->id[GOAL_ID_SIZE] = '\0';

		g->subgoals_len = subgoals->u.array.length;
		if (g->subgoals_len > 0) {
			g->subgoals = malloc(sizeof(size_t) * g->subgoals_len);
			cassert(g->subgoals, "Failed to allocate subgoals while loading goals.\n");

			for (unsigned j = 0; j < subgoals->u.array.length; j++) {
				json_value *subgoal = subgoals->u.array.values[j];
				change_assert(subgoal && subgoal->type == json_integer, "Subgoal reference is not integer for [%zu].\n", global_index);
				change_assert(subgoal->u.integer >= 0, "Subgoal reference is negative for [%zu].\n", global_index);
				g->subgoals[j] = (size_t)subgoal->u.integer;
			}
		}

		GOAL_CONTAINER[global_index] = g;
	}

	json_value_free(doc);
	free(buff);
}
