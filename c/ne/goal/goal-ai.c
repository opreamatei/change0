#include "goal-ai.h"
#include "change-errors.h"
#include "config.h"
#include "node.h"
#include "openai.h"
#include <string.h>
#include "deep-search-session.h"
#include "goal-info.h"
#include "srv/user/journey.h"

static journey_str_func journey_get_title = NULL;

static void AICallExtractionGoalSchema(String *input, String *out, String* feedback)
{
    String prompt;
    InitString(&prompt, input->len + 2048);

    /*
     * Feedback should only be necesary on the personalize goal
    if (feedback != NULL){
	    CatString(&prompt, feedback->p, feedback->len);
    }
    */

    CatTemplateString(&prompt, GOAL_JSON_EXTRACT_PROMPT, c_str(input));

    ai_gpt_request req = {0};
    req.prompt = prompt;
    InitString(&req.schema, sizeof(OPENAI_GOAL_EXTRACT_SCHEMA_JSON) + 1);
    CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_GOAL_EXTRACT_SCHEMA_JSON));

    req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
    req.schema_name = "goal_extraction";


    printf("Calling extracter... \n\n");

    String *result = ai_openai_call_gpt_request(&req);
    cassert(result, "OpenAI goal extraction call failed.\n");

    printf("Result is %s\n", result->p);

    CatString(out, result->p, result->len);

    FreeString(&prompt);
    FreeString(&req.schema);
    FreeString(result);
}

_Bool ExtractGoalFromText(String* text, String* title, String* extrainfo, time_t *estimated_time, size_t *priority, _Bool forceEstTime, String *feedback){
	
	String json_extract_result;

	// extract process goals
	InitString(title, 256); InitString(extrainfo, 1024);
	InitString(&json_extract_result, 2048);
	if (priority)
		*priority = 0;

	if (feedback)
		EmptyString(feedback);

	printf("Extracing goal... \n\n");

	AICallExtractionGoalSchema(text, &json_extract_result, feedback);

	json_value* doc = json_parse(c_str(&json_extract_result), json_extract_result.len);
	//change_assert(doc && doc->type == json_object, "Goal is not an object or is not a json\n\n\n%s", c_str(text));
	if (!doc || !(doc->type == json_object)){
		return 0;
	}

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry candidate = doc->u.object.values[i];

		if (strcmp(candidate.name, "extrainfo") == 0){
			//change_assert(candidate.value->type == json_string, "JSON \"extrainfo\" is not a string. \n\n[%s]\n", c_str(text));
			if (candidate.value->type != json_string)
				return 0;
			
			CatString(extrainfo, candidate.value->u.string.ptr, candidate.value->u.string.length);
		}else if (strcmp(candidate.name, "title") == 0){
			//change_assert(candidate.value->type == json_string, "JSON \"title\" is not a string. \n\n[%s]\n", c_str(text));
			if (candidate.value->type != json_string)
				return 0;
			
			CatString(title, candidate.value->u.string.ptr, candidate.value->u.string.length);
		}else if (forceEstTime && strcmp(candidate.name, "estimated_time") == 0){
			//change_assert(candidate.value->type == json_integer, "JSON \"estimated_time\" is not an integer. \n\n[%s]\n", c_str(text));
			if (candidate.value->type != json_integer)
				return 0;
			
			*estimated_time = candidate.value->u.integer;
		}else if (strcmp(candidate.name, "priority") == 0){
			if (candidate.value->type == json_null) {
				if (priority)
					*priority = 0;
				continue;
			}
			if (candidate.value->type != json_integer)
				return 0;

			if (priority)
				*priority = (size_t)CLAMP(0, 5, candidate.value->u.integer);
		}
	}

	if (extrainfo->len < 3)
		CatFixed(feedback, "\nFeedback Error : Extra info length is too small or you haven't passed an extra info.\n");
	
	if (title->len < 3)
		CatFixed(feedback, "\nFeedback Error : Title length is too small or you haven't passed a title.\n");

	if (*estimated_time == 0 && forceEstTime)
		CatFixed(feedback, "\nFeedback Error : You either forgot to pass estimated_time or its length was set to 0 which is not allowed.\n");
	

	json_value_free(doc);

	return 1;

}

void SetGoalShortenPrompt(Goal* g, String* prompt, time_t now){
	time_t old_required_time = g->required_time;
	cassert(g->start_date, "You can't shorten a goal without start date.");

	time_t estimated_end_date = g->start_date + old_required_time;

	int64_t remaining_time = estimated_end_date - now;
	time_t initial_timeframe = g->required_time;

	char* title = c_str(&g->title);
	char* extra_info = c_str(&g->extra_info);

	// user action will be last max 20 goals
	String user_action; InitString(&user_action, 4096);
	SerializeUserGoalHistoryUpTo(g, &user_action, 20);

	String same_layer; InitString(&same_layer, 2048);
	SerializeSlibingGoals(g, &same_layer);

	String goal_parent_chain; InitString(&goal_parent_chain, 2048);
	SerializeGoalParentChain(g, &goal_parent_chain);

	String goal_brothers_chain; InitString(&goal_brothers_chain, 2048);
	SerializeGoalLinkedSlibingsChain(g, &goal_brothers_chain, 0);

	char* user_action_raw = user_action.p;
	char* same_layer_raw = same_layer.p;
	char* goal_parent_chain_raw = goal_parent_chain.p;
	char* goal_brothers_chain_raw = goal_brothers_chain.p;

	size_t estimated_size = user_action.len + same_layer.len + goal_parent_chain.len + g->title.len + g->extra_info.len + sizeof(SHORTEN_GOAL_AI_PROMPT) + 1024;

	CatTemplateString(prompt, SHORTEN_GOAL_AI_PROMPT, 
			title, extra_info,
			user_action_raw, 
			initial_timeframe,
			remaining_time,
			same_layer_raw,
			goal_parent_chain_raw,
			goal_brothers_chain_raw
		);

	FreeString(&user_action);
	FreeString(&same_layer);
	FreeString(&goal_parent_chain);
	FreeString(&goal_brothers_chain);
}

void SetGoalDecompositionPrompt(Goal* g, String* prompt, time_t now, User *user){
	time_t old_required_time = g->required_time;

	time_t estimated_end_date = g->start_date + old_required_time;

	time_t required_time = CalcGoalRequiredTime(g);
	size_t depth = g->depth;
	char* title = c_str(&g->title);
	char* extra_info = c_str(&g->extra_info);

	// user action will be last max 20 goals
	String user_action; InitString(&user_action, 4096);
	SerializeUserGoalHistoryUpTo(g, &user_action, 20);

	String same_layer; InitString(&same_layer, 2048);
	SerializeSlibingGoals(g, &same_layer);

	String goal_parent_chain; InitString(&goal_parent_chain, 2048);
	SerializeGoalParentChain(g, &goal_parent_chain);

	String goal_brothers_chain; InitString(&goal_brothers_chain, 2048);
	SerializeGoalLinkedSlibingsChain(g, &goal_brothers_chain, 0);

	String goal_uncle_chain; InitString(&goal_uncle_chain, 2048);
	SerializeGoalParentSlibings(g, &goal_uncle_chain, 1);

	size_t estimated_size = user_action.len + same_layer.len + goal_parent_chain.len + g->title.len + g->extra_info.len + sizeof(SHORTEN_GOAL_AI_PROMPT) + 1024;

	String personalization_context; InitString(&personalization_context, 2048);
	Task task = {0};
	task.minDepth = 2;
	InitString(&task.name, 2048);
	CatTemplateString(&task.name, GOAL_DECOMPOSITION_PERSONAL_CONTEXT_PROMPT, g->title.p, g->extra_info.p, goal_parent_chain.p);

	start_ds_session(&task, g->id, &personalization_context, user);

	/* Prepend journey title to the personalization context (cheap: title only). */
	Goal *root = CalcGoalRoot(g);
	if (root->journey_id[0]) {
		JourneySystemLazyLoad(&journey_get_title, NULL);
		const char *jt = journey_get_title(root->journey_id);
		if (jt && jt[0]) {
			String with_journey; InitString(&with_journey, personalization_context.len + 128);
			CatTemplateString(&with_journey, "[Journey: %s]\n", jt);
			CatString(&with_journey, personalization_context.p, personalization_context.len);
			FreeString(&personalization_context);
			personalization_context = with_journey;
		}
	}

	char* user_action_raw = user_action.p;
	char* same_layer_raw = same_layer.p;
	char* goal_parent_chain_raw = goal_parent_chain.p;
	char* goal_brothers_chain_raw = goal_brothers_chain.p;
	char* goal_uncle_chain_raw = goal_uncle_chain.p;
	char* personalization_context_raw = personalization_context.p;


	CatTemplateString(prompt, DECOMPOSE_GOAL_AI_PROMPT, 
			title, 
			extra_info,
			required_time,
			depth,
			user_action_raw,
			personalization_context_raw,
			goal_parent_chain_raw,
			goal_brothers_chain_raw,
			goal_uncle_chain_raw
		);

	FreeString(&user_action);
	FreeString(&same_layer);
	FreeString(&goal_parent_chain);
	FreeString(&goal_brothers_chain);
	FreeString(&goal_uncle_chain);
	FreeString(&task.name);
	FreeString(&personalization_context);
}

// AI generated function
void ParseDecompositionSubgoal(
	json_value *item,
	String *title,
	String *extrainfo,
	size_t *estimated_time,
	time_t *min_pause_to_next,
	time_t *pause_to_next
) {
	change_assert(item && item->type == json_object, "Subgoal item is not an object.\n");

	json_value *title_json = json_object_get(item, "title");
	json_value *extrainfo_json = json_object_get(item, "extrainfo");
	json_value *estimated_time_json = json_object_get(item, "estimated_time");
	json_value *min_pause_to_next_json = json_object_get(item, "min_pause_to_next");
	json_value *pause_to_next_json = json_object_get(item, "pause_to_next");

	change_assert(title_json && title_json->type == json_string, "Subgoal title missing or invalid.\n");
	change_assert(extrainfo_json && extrainfo_json->type == json_string, "Subgoal extrainfo missing or invalid.\n");
	change_assert(estimated_time_json && estimated_time_json->type == json_integer, "Subgoal estimated_time missing or invalid.\n");
	change_assert(min_pause_to_next_json && min_pause_to_next_json->type == json_integer, "Subgoal min_pause_to_next missing or invalid.\n");
	change_assert(pause_to_next_json && pause_to_next_json->type == json_integer, "Subgoal pause_to_next missing or invalid.\n");

	change_assert(title_json->u.string.length >= 3, "Subgoal title is too short.\n");
	change_assert(extrainfo_json->u.string.length >= 10, "Subgoal extrainfo is too short.\n");
	change_assert(estimated_time_json->u.integer > 0, "Subgoal estimated_time must be positive.\n");
	change_assert(min_pause_to_next_json->u.integer >= 0, "Subgoal min_pause_to_next must be non-negative.\n");
	change_assert(pause_to_next_json->u.integer >= 0, "Subgoal pause_to_next must be non-negative.\n");

	InitString(title, title_json->u.string.length + 64);
	CatString(title, title_json->u.string.ptr, title_json->u.string.length);

	InitString(extrainfo, extrainfo_json->u.string.length + 256);
	CatString(extrainfo, extrainfo_json->u.string.ptr, extrainfo_json->u.string.length);

	*estimated_time = (size_t)estimated_time_json->u.integer;
	*min_pause_to_next = (time_t)MIN(min_pause_to_next_json->u.integer, pause_to_next_json->u.integer);
	*pause_to_next = (time_t)pause_to_next_json->u.integer;
}

// AI generated function
String *CallGoalDecompositionAI(String *prompt)
{
	ai_gpt_request req = {0};

	req.prompt = *prompt;

	InitString(&req.schema, sizeof(OPENAI_GOAL_DECOMPOSITION_SCHEMA_JSON) + 1);
	CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_GOAL_DECOMPOSITION_SCHEMA_JSON));

	req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
	req.schema_name = "goal_decomposition";

	printf("\n\n------------------\n\nCalling goal decomposition...\n\n------------------\n\n");

	String *result = ai_openai_call_gpt_request(&req);
	cassert(result, "OpenAI goal decomposition call failed.\n");

	FreeString(&req.schema);

	return result;
}

String *CallSharedGoalDecompositionAI(String *prompt)
{
	ai_gpt_request req = {0};

	req.prompt = *prompt;

	InitString(&req.schema, sizeof(OPENAI_SHARED_GOAL_DECOMPOSITION_SCHEMA_JSON) + 1);
	CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_SHARED_GOAL_DECOMPOSITION_SCHEMA_JSON));

	req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
	req.schema_name = "shared_goal_decomposition";

	printf("\n\n------------------\n\nCalling shared goal decomposition...\n\n------------------\n\n");

	String *result = ai_openai_call_gpt_request(&req);
	change_assert(result, "OpenAI shared goal decomposition call failed.\n");

	FreeString(&req.schema);

	return result;
}

void ParseSharedDecompositionSubgoal(
	json_value *item,
	String *title,
	String *extrainfo,
	size_t *estimated_time,
	time_t *min_pause_to_next,
	time_t *pause_to_next,
	uint8_t *assigned_to
) {
	ParseDecompositionSubgoal(item, title, extrainfo, estimated_time, min_pause_to_next, pause_to_next);

	json_value *assigned_json = json_object_get(item, "assigned_to");
	change_assert(assigned_json && assigned_json->type == json_integer,
		"Shared subgoal assigned_to missing or invalid.\n");
	change_assert(assigned_json->u.integer >= 0 && assigned_json->u.integer <= 0xFF,
		"Shared subgoal assigned_to out of byte range: %lld.\n",
		(long long)assigned_json->u.integer);

	*assigned_to = (uint8_t)assigned_json->u.integer;
}

static void set_shared_goal_decomposition_prompt(Goal *g, String *prompt, time_t now, User *user)
{
	(void)now;
	(void)user;

	change_assert(g->journey_id[0],
		"set_shared_goal_decomposition_prompt: goal [%s] has no journey id.\n", g->title.p);
	Journey *j = FindJourneyByID(g->journey_id);
	change_assert(j, "set_shared_goal_decomposition_prompt: journey [%s] not found.\n", g->journey_id);
	change_assert(j->is_shared, "set_shared_goal_decomposition_prompt: journey [%s] is not shared.\n", j->id);
	change_assert(j->user_count > 0,
		"set_shared_goal_decomposition_prompt: shared journey [%s] has no participants.\n", j->id);

	time_t required_time = CalcGoalRequiredTime(g);
	size_t depth = g->depth;
	char *title = c_str(&g->title);
	char *extra_info = c_str(&g->extra_info);

	String completion;  InitString(&completion, 2048);
	String delay;       InitString(&delay, 1024);
	String parent_chain; InitString(&parent_chain, 2048);
	String siblings;    InitString(&siblings, 2048);
	String uncles;      InitString(&uncles, 2048);
	String participants; InitString(&participants, 2048);

	SerializeJourneyCompletionAttribution(&completion, 20, j->id);
	SerializeJourneyDelayAttribution(&delay, 10, j->id);
	SerializeGoalParentChain(g, &parent_chain);
	SerializeSlibingGoals(g, &siblings);
	SerializeGoalParentSlibings(g, &uncles, 1);
	SerializeJourneyParticipants(&participants, j->id);

	CatTemplateString(prompt, SHARED_DECOMPOSE_GOAL_AI_PROMPT,
		title,
		extra_info,
		(size_t)required_time,
		depth,
		completion.p,
		delay.p,
		parent_chain.p,
		siblings.p,
		uncles.p,
		participants.p,
		(size_t)SHARED_LEAF_MAX_SECONDS
	);

	FreeString(&participants);
	FreeString(&uncles);
	FreeString(&siblings);
	FreeString(&parent_chain);
	FreeString(&delay);
	FreeString(&completion);
}

_Bool BuildDecomposePrompt(Goal *g, String *prompt, time_t now, User *user)
{
	change_assert(g, "BuildDecomposePrompt: NULL goal.\n");
	change_assert(prompt, "BuildDecomposePrompt: NULL prompt buffer.\n");

	Journey *j = g->journey_id[0] ? FindJourneyByID(g->journey_id) : NULL;
	if (j && j->is_shared) {
		set_shared_goal_decomposition_prompt(g, prompt, now, user);
		return 1;
	}

	SetGoalDecompositionPrompt(g, prompt, now, user);
	return 0;
}

/*
 * The shared adaptation call is the one place where we skip deep search.
 * To keep the downstream pipeline identical, we constrain the model to the
 * existing extract-schema JSON shape, then re-emit it as the TITLE /
 * EXTRA_INFO / ESTIMATED_TIME / PRIORITY section block that ExtractGoalFromText
 * already understands. That gives us strict validation here and zero
 * downstream changes.
 */
static void run_shared_goal_adaptation(
	Journey *j,
	String *input1, String *input2, String *feedback,
	String *out
) {
	String participants; InitString(&participants, 2048);
	SerializeJourneyParticipants(&participants, j->id);

	const char *jt = j->title.p ? j->title.p : DEFAULT_JOURNEY_TITLE;
	const char *ji = j->extra_info.p ? j->extra_info.p : DEFAULT_JOURNEY_EXTRA_INFO;
	const char *fb = (feedback && feedback->p) ? feedback->p : "";

	String prompt;
	InitString(&prompt,
		sizeof(SHARED_GOAL_ADAPTATION_PROMPT) + strlen(jt) + strlen(ji) +
		input1->len + (input2 ? input2->len : 0) + strlen(fb) + participants.len + 256);

	CatTemplateString(&prompt, SHARED_GOAL_ADAPTATION_PROMPT,
		jt,
		ji,
		c_str(input1),
		input2 ? c_str(input2) : "",
		fb,
		participants.p
	);

	ai_gpt_request req = {0};
	req.prompt = prompt;
	req.model  = AI_OPENAI_MODEL_GPT_5_4_MINI;
	req.schema_name = "shared_goal_adaptation";
	InitString(&req.schema, sizeof(OPENAI_GOAL_EXTRACT_SCHEMA_JSON) + 1);
	CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_GOAL_EXTRACT_SCHEMA_JSON));

	printf("\n\n------------------\n\nCalling shared goal adaptation...\n\n------------------\n\n");

	String *result = ai_openai_call_gpt_request(&req);
	change_assert(result, "OpenAI shared goal adaptation call failed.\n");

	json_value *doc = json_parse(result->p, result->len);
	change_assert(doc && doc->type == json_object,
		"Shared goal adaptation result is not a JSON object:\n%s\n", result->p);

	const char *title_s = NULL, *extra_s = NULL;
	long long est_time = 0;
	long long priority = 0;

	for (size_t i = 0; i < doc->u.object.length; i++) {
		json_object_entry e = doc->u.object.values[i];
		if (!strcmp(e.name, "title")) {
			change_assert(e.value->type == json_string,
				"Shared goal adaptation title is not a string.\n");
			title_s = e.value->u.string.ptr;
		} else if (!strcmp(e.name, "extrainfo")) {
			change_assert(e.value->type == json_string,
				"Shared goal adaptation extrainfo is not a string.\n");
			extra_s = e.value->u.string.ptr;
		} else if (!strcmp(e.name, "estimated_time")) {
			change_assert(e.value->type == json_integer,
				"Shared goal adaptation estimated_time is not an integer.\n");
			est_time = e.value->u.integer;
		} else if (!strcmp(e.name, "priority")) {
			if (e.value->type == json_integer)
				priority = e.value->u.integer;
		}
	}

	change_assert(title_s && extra_s,
		"Shared goal adaptation response missing title or extrainfo.\n");
	change_assert(est_time > 0,
		"Shared goal adaptation estimated_time must be positive (got %lld).\n", est_time);

	EmptyString(out);
	ResizeString(out, strlen(title_s) + strlen(extra_s) + 256);
	CatTemplateString(out,
		"TITLE: %s\n"
		"EXTRA_INFO: %s\n"
		"ESTIMATED_TIME: %lld\n"
		"PRIORITY: %lld\n",
		title_s, extra_s, est_time, priority);

	json_value_free(doc);
	FreeString(&req.schema);
	FreeString(&prompt);
	FreeString(&participants);
	FreeString(result);
	free(result);
}

void BuildGoalAdaptationPrompt(
	String *input1, String *input2, String *feedback,
	String *out, char *goalId,
	start_ds_session_like_func start_ds_session,
	const char *journey_id, User *user
) {
	change_assert(input1 && input1->p, "BuildGoalAdaptationPrompt: input1 is NULL.\n");
	change_assert(out, "BuildGoalAdaptationPrompt: out is NULL.\n");
	change_assert(goalId, "BuildGoalAdaptationPrompt: goalId is NULL.\n");
	change_assert(user, "BuildGoalAdaptationPrompt: user is NULL.\n");

	Journey *j = (journey_id && journey_id[0]) ? FindJourneyByID(journey_id) : NULL;

	if (!j || !j->is_shared) {
		PersonalizeGoal(input1, input2, out, goalId, feedback, start_ds_session, journey_id, user);
		return;
	}

	change_assert(j->user_count >= 2,
		"BuildGoalAdaptationPrompt: shared journey [%s] needs at least 2 participants, has %zu.\n",
		j->id, j->user_count);

	run_shared_goal_adaptation(j, input1, input2, feedback, out);
}
