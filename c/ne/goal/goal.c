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
#include "deep-search-session.h"
#include "goal-ai.h"

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
	ExtractGoalFromText(out, &new_title, &new_extra_info, &new_estimated_time, 0);
	
	change_assert(new_title.len > 1 && new_extra_info.len > 1, "Goal title or extra info is broken. title : [%s], info : [%s]\n", new_title.p, new_extra_info.p);

	CatTemplateString(&g->extra_info, "\n user failed to finish goal [%s] so was shortened to [%s] in date [%s]\n", g->title.p, new_title.p, ctime(&now));

	CopyString(&g->title, &new_title);
	CopyString(&g->extra_info, &new_extra_info);

	FreeString(&prompt);
	FreeString(out);
}

static void repair_goal_leaf(Goal *g)
{
	change_assert(g->subgoals_len == 0, "Only leaf goals can be repaired directly [%s]\n", g->title.p);
	
	time_t max_end_date = g->start_date + g->required_time * (1 + GOAL_REQUIRED_TIME_ERROR_MARGIN);
	time_t now = time(NULL);

	time_t delta = (max_end_date - now) * (max_end_date - g->start_date);
	
	_Bool shouldExtend = g->retry_depth < 2;
	g->retry_depth ++;

	if (shouldExtend){
		// increase goal by 25%
		time_t old_time = CalcGoalRequiredTime(g);
		time_t new_time = (old_time * 125) / 100;

		g->required_time = new_time;
		CatTemplateString(&g->extra_info, "\n[Goal was extended on date [%s] from [%zu] to [%zu]]\n", ctime(&now), old_time, new_time);
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
Goal* CreateUserGoal(String *input1, String *input2, goalIDType goalId)
{
	GoalSystemLazyLoad(&goal_emit);

	String title, extra_info, deep_search_result;
	time_t estimated_time = 0;

	PersonalizeGoal(input1, input2, &deep_search_result, goalId, start_ds_session);
	goal_emit(goalId, "deep-search-final-recomandation", deep_search_result.p, deep_search_result.len);
	ExtractGoalFromText(&deep_search_result, &title, &extra_info, &estimated_time, 1);

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

	return created;
}

// AI assisted function
_Bool DecomposeGoal(Goal *g){
	
	if (g->subgoals_len != 0){
		printf("Goal seems already decomposed.\n");
		return 0;
	}
	if (g->required_time < GOAL_MIN_SECONDS){
		printf("Goal si too short to decompose, shortest is 15 minutes");
		return 0;
	}

	String prompt;
	InitString(&prompt, 2048);

	SetGoalDecompositionPrompt(g, &prompt, time(NULL));

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

		ParseDecompositionSubgoal(item, &title, &extrainfo, &estimated_time);

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

