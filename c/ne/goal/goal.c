#include "goal.h"
#include <assert.h>
#include <openssl/x509.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <string.h>
#include <unistd.h>
#include "json.h"
#include "openai.h"
#include "goal-ai.h"
#include "user-schedule.h"

static goal_emit_like_func goal_emit = NULL;

void InitGoalSystem(){
	GOAL_CONTAINER_COUNT = INITIAL_GOAL_INDEX;
	// Init system will go here
}

static void shorten_goal(Goal *g, time_t now){
	String prompt; InitString(&prompt, 256);

	SetGoalShortenPrompt(g, &prompt, now);

	ai_gpt_request req = {0};
	req.prompt = prompt;
	InitString(&req.schema, sizeof(OPENAI_GOAL_EXTRACT_SCHEMA_JSON) + 1);
	CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_GOAL_EXTRACT_SCHEMA_JSON));

	req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
	req.schema_name = "goal_extract";

	String *out = ai_openai_call_gpt_request(&req);

	String new_title, new_extra_info;
	time_t new_estimated_time = 0; // this should not matter
	ExtractGoalFromText(out, &new_title, &new_extra_info, &new_estimated_time, 0, NULL);
	
	change_assert(new_title.len > 1 && new_extra_info.len > 1, "Goal title or extra info is broken. title : [%s], info : [%s]\n", new_title.p, new_extra_info.p);

	CatTemplateString(&g->extra_info, "\n user failed to finish goal [%s] so was shortened to [%s] in date [%s]\n", g->title.p, new_title.p, change_ctime(&now));

	CopyString(&g->title, &new_title);
	CopyString(&g->extra_info, &new_extra_info);

	FreeString(&prompt);
	FreeString(out);
}

static void repair_goal_leaf(Goal *g)
{
	change_assert(g->subgoals_len == 0, "Only leaf goals can be repaired directly [%s]\n", g->title.p);
	
	time_t max_end_date = g->start_date + g->required_time * (1 + GOAL_REQUIRED_TIME_ERROR_MARGIN);
	time_t now = change_time_now();

	time_t delta = (max_end_date - now) * (max_end_date - g->start_date);
	
	_Bool shouldExtend = g->retry_depth < 2;
	g->retry_depth ++;

	if (shouldExtend){
		// increase goal by 25%
		time_t old_time = CalcGoalRequiredTime(g);
		time_t new_time = (old_time * 125) / 100;

		g->required_time = new_time;
		CatTemplateString(&g->extra_info, "\n[Goal was extended on date [%s] from [%zu] to [%zu]]\n", change_ctime(&now), old_time, new_time);
	}else{
		shorten_goal(g, now);
		g->retry_depth = 0;
	}
}

void UpdateGoal(Goal *g, time_t now)
{
	if (!g)
		return;

	for (size_t i = 0; i < g->subgoals_len; i++)
		UpdateGoal(FindGoalFromIndex(g->subgoals[i]), now);

	enum GOAL_STATUS status = ValidateGoal(g, now);

	if (status == GOAL_VALID)
		return;

	repair_goal_leaf(g);
}

void FreeGoal(Goal *g)
{
	if (!g)
		return;
	if (!g->title.p)
		return;
	for (size_t i = 0; i < g->subgoals_len; i++)
		FreeGoal(FindGoalFromIndex(g->subgoals[i]));

	if (g->title.p)
		FreeString(&g->title);
	if (g->extra_info.p){
		FreeString(&g->extra_info);
	}
	if (g->subgoals){
		free(g->subgoals);
		g->subgoals = NULL;
	}
	if (g){
		free(g);
	}
}

void FreeGoals()
{
	for (size_t i = INITIAL_GOAL_INDEX; i < GOAL_CONTAINER_COUNT; i++)
	{
		Goal* g = FindGoalFromIndex(i);

		if (!g || g->parent != 0) continue;

		FreeGoal(GOAL_CONTAINER[i]);
		GOAL_CONTAINER[i] = NULL;
	}

	GOAL_CONTAINER_COUNT = INITIAL_GOAL_INDEX;
}

// those are mapped to input1 -> title input2 -> extrainfo
Goal* CreateUserGoal(String *input1, String *input2, start_ds_session_like_func* start_ds_session)
{
	GoalSystemLazyLoad(&goal_emit);

	String title, extra_info, deep_search_result;
	time_t estimated_time = 0;
	goalIDType goalId;
	random_id(goalId, GOAL_ID_SIZE + 1);
	goalId[32] = '\0';

	InitString(&deep_search_result, 2048);
	
	_Bool success = 0;
	size_t depth_error = 0;
	String feedback_intervention; InitString(&feedback_intervention, 512);

	while (!success){
		EmptyString(&deep_search_result);

		PersonalizeGoal(input1, input2, &deep_search_result, goalId, &feedback_intervention, start_ds_session);

		goal_emit(goalId, "deep-search-final-recomandation", deep_search_result.p, deep_search_result.len);

		success = ExtractGoalFromText(&deep_search_result, &title, &extra_info, &estimated_time, 1, &feedback_intervention);

		if (estimated_time == 0){
			CatTemplateString(&feedback_intervention, "\n\nServer intervention : \"The server detected your previous response (%s) had an invalid estimate_time of 0, please consider estimated time being the total time of the goal, 0 is not allowed. Please Retry.\n\"", title.p);
			success = 0;
		}

		depth_error++; 
		change_assert(depth_error < 10, "Depth went way to high");
		
		if (!success){
			printf("\n\nERROR WHEN EXTRACTING, WARING THIS WILL NOT SAVE : %s, %s, %zu", title.p, extra_info.p, estimated_time);
		}
	}

	FreeString(&feedback_intervention);

	// emit info to client
	goal_emit(goalId, "title", title.p, title.len);
	goal_emit(goalId, "extra-info", extra_info.p, extra_info.len);

	char total_time_buff[32] = {0};
	size_t len = snprintf(total_time_buff, sizeof(total_time_buff), "%ld", (long)estimated_time);
	change_assert(len < sizeof(total_time_buff), "time buffer too small\n");

	goal_emit(goalId, "time", total_time_buff, len);

	printf("before create_goal\n");
	Goal *created = CreateGoal(goalId, &title, &extra_info, estimated_time, 0, 1);
	printf("after create_goal [%p]\n", (void*)created);

	FreeString(&title);
	FreeString(&extra_info);
	FreeString(&deep_search_result);

	printf("Perfoming the partical decompsition...\n");
	ComputePartialDecomposition(created);

	return created;
}

// AI assisted function
_Bool DecomposeGoal(Goal *g){
	
	if (g->subgoals_len != 0){
		printf("Goal seems already decomposed.\n");
		return 1;
	}
	if (g->required_time < GOAL_MIN_SECONDS){
		printf("Goal si too short to decompose, shortest is 15 minutes");
		return 0;
	}

	String prompt;
	InitString(&prompt, 2048);

	SetGoalDecompositionPrompt(g, &prompt, change_time_now());

	String *out = CallGoalDecompositionAI(&prompt);
	cassert(out, "Goal decomposition returned NULL.\n");

	json_value *doc = json_parse(c_str(out), out->len);
	change_assert(doc && doc->type == json_object, "Goal decomposition result is not a JSON object:\n%s\n", c_str(out));

	json_value *subgoals_json = json_object_get(doc, "subgoals");
	change_assert(subgoals_json && subgoals_json->type == json_array, "Goal decomposition JSON has no subgoals array.\n");

	size_t subgoal_count = subgoals_json->u.array.length;

	change_assert(subgoal_count >= 2, "Goal decomposition must create at least 2 subgoals.\n");
	change_assert(subgoal_count <= 9, "Goal decomposition created too many subgoals: [%zu].\n", subgoal_count);
	change_assert(GOAL_CONTAINER_COUNT + subgoal_count <= 1024, "Not enough room in GOAL_CONTAINER for decomposition.\n");

	size_t *subgoal_indexes = malloc(sizeof(size_t) * subgoal_count);
	cassert(subgoal_indexes, "Could not allocate subgoal index array.\n");

	Goal *previous = NULL;

	for (size_t i = 0; i < subgoal_count; i++) {
		json_value *item = subgoals_json->u.array.values[i];

		String title;
		String extrainfo;
		size_t estimated_time = 0;
		time_t min_pause_to_next = 0;
		time_t pause_to_next = 0;

		ParseDecompositionSubgoal(item, &title, &extrainfo, &estimated_time, &min_pause_to_next, &pause_to_next);

		char child_goal_id[33];
		CreateSubgoalId(g, i, child_goal_id);

		Goal *child = CreateGoal(
			child_goal_id,
			&title,
			&extrainfo,
			estimated_time,
			g->globalIndex,
			g->depth + 1
		);
		child->minPauseToNext = min_pause_to_next;
		child->pauseToNext = pause_to_next;

		subgoal_indexes[i] = child->globalIndex;

		if (previous)
			link_goals(previous, child);

		previous = child;

		FreeString(&title);
		FreeString(&extrainfo);
	}

	g->subgoals = subgoal_indexes;
	g->subgoals_len = subgoal_count;
	g->required_time = CalcGoalRequiredTime(g);

	json_value_free(doc);
	FreeString(&prompt);
	FreeString(out);

	printf("Goal decomposed into [%zu] subgoals.\n", subgoal_count);

	return 1;
}

// goes on the first layer deep untill the goals are less than 1 hour
Goal* ComputePartialDecomposition(Goal *goal){
	Goal* g = goal;
	while (g){
		if (g->required_time < 60 * 60) break;

		_Bool decomposition_result = DecomposeGoal(g);
		change_assert(decomposition_result, "Couldn't decompose goal : [%s]\n\n", g->title.p);

		// 20 min cap
		if (g->required_time < 60 * 20) break;
		size_t nextGoalIndex = g->subgoals[0]; // pick first one

		g = FindGoalFromIndex(nextGoalIndex);
		change_assert(g, "Coudln't find first born after decomposition\n\n");
	}

	return g;
}


Goal* DecomposeToLeaf(Goal *g) {
	while (g->subgoals_len > 0 || g->required_time >= GOAL_MIN_SECONDS * 2) {
		if (g->subgoals_len > 0) {
			Goal *child = FindGoalFromIndex(g->subgoals[0]);
			change_assert(child, "Broken subgoals[0] in DecomposeToLeaf. %s\n", child->title.p);
			g = child;
		} else {
			if (!DecomposeGoal(g)) break;
		}
	}
	return g;
}

static _Bool goal_is_unstarted(Goal *g) {
	return g && !g->start_date && !g->end_date;
}

static Goal* last_leaf(Goal *g) {
	if (!g) return NULL;

	while (g->subgoals_len > 0) {
		Goal *child = FindGoalFromIndex(g->subgoals[g->subgoals_len - 1]);
		change_assert(child, "Broken last subgoal reference in last_leaf.\n");
		g = child;
	}

	return g;
}

static Goal* previous_timeline_leaf(Goal *g) {
	Goal *current = g;

	while (current) {
		if (current->prev) {
			Goal *prev = FindGoalFromIndex(current->prev);
			change_assert(prev, "Broken prev reference in previous_timeline_leaf.\n");
			return last_leaf(prev);
		}

		if (!current->parent) return NULL;

		current = FindGoalFromIndex(current->parent);
		change_assert(current, "Broken parent reference in previous_timeline_leaf.\n");
	}

	return NULL;
}

static Goal* first_unstarted_leaf(Goal *g) {
	if (!g) return NULL;

	while (g->subgoals_len == 0 &&
	       g->required_time >= GOAL_MIN_SECONDS * 2 &&
	       goal_is_unstarted(g)) {
		if (!DecomposeGoal(g)) break;
	}

	if (g->subgoals_len == 0)
		return goal_is_unstarted(g) ? g : NULL;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->subgoals[i]);
		change_assert(child, "Broken subgoal reference in first_unstarted_leaf.\n");

		Goal *leaf = first_unstarted_leaf(child);
		if (leaf) return leaf;
	}

	return NULL;
}

static _Bool can_start_leaf(Goal *g) {
	Goal *previous;

	if (!goal_is_unstarted(g) || g->subgoals_len != 0) return 0;

	previous = previous_timeline_leaf(g);
	while (previous) {
		if (!previous->end_date) return 0;
		previous = previous_timeline_leaf(previous);
	}

	return 1;
}

static Goal* first_startable_leaf(Goal *g) {
	g = first_unstarted_leaf(g);
	if (!g || !can_start_leaf(g)) return NULL;
	return g;
}

Goal* StartGoalDeepFromGoal(Goal *g) {
	change_assert(g, "Goal not found in StartGoalDeepFromGoal.\n");
	g = first_startable_leaf(g);
	if (!g) return NULL;
	g->start_date = change_time_now();
	return g;
}

Goal* StartGoalDeep(goalIDType goalID) {
	Goal* g = FindGoalByID(goalID);
	change_assert(g, "Goal not found in StartGoalDeep: %s", goalID);
	return StartGoalDeepFromGoal(g);
}

Goal** GetSessionGoals(size_t *out_len) {
	*out_len = 0;
	size_t goals_len = 0;
	Goal **goals = GetGoalsContainer(&goals_len);

	Goal *seen[1024] = {0};
	size_t count = 0;
	for (size_t i = 0; i < goals_len; i++) {
		Goal *g = goals[i];
		if (!g || g->parent != 0) continue;

		g = first_startable_leaf(g);
		if (g) seen[count++] = g;
	}

	if (count > 0) {
		Goal **out = malloc(count * sizeof(Goal*));
		change_assert(out, "GetSessionGoals: malloc failed.\n");
		for (size_t i = 0; i < count; i++)
			out[i] = seen[i];
		*out_len = count;
		return out;
	}

	return NULL;
}

time_t StartGoal(goalIDType goalID){
	Goal* g = FindGoalByID(goalID);
	change_assert(g, "Goal not found, target goal id %s, serialized goals.", goalID);

	time_t now = change_time_now();

	g->start_date = now;

	return now;
}

time_t EndGoalFromGoal(Goal *g){
	change_assert(g, "Goal not found in EndGoalFromGoal.\n");
	time_t now = change_time_now();

	g->end_date = now;

	SCHEDULE_NEEDS_REFRESH = 1;

	return now;
}

time_t EndGoal(goalIDType goalID){
	Goal* g = FindGoalByID(goalID);
	change_assert(g, "Goal not found, target goal id %s, serialized goals.", goalID);

	return EndGoalFromGoal(g);
}
