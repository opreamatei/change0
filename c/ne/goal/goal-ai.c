#include "goal-ai.h"
#include "change-errors.h"
#include "config.h"
#include "node.h"
#include "openai.h"
#include <string.h>
#include "deep-search-session.h"
#include "goal-info.h"

void AICallExtractionGoalSchema(String *input, String *out)
{
    String prompt;
    InitString(&prompt, input->len + 2048);

    CatTemplateString(&prompt, GOAL_JSON_EXTRACT_PROMPT, c_str(input));

    ai_gpt_request req = {0};
    req.prompt = prompt;
    InitString(&req.schema, sizeof(OPENAI_GOAL_EXTRACT_SCHEMA_JSON) + 1);
    CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_GOAL_EXTRACT_SCHEMA_JSON));

    req.model = AI_OPENAI_MODEL_GPT_5_4_NANO;
    req.schema_name = "goal_extraction";

    printf("Calling extracter... \n\n");

    String *result = ai_openai_call_gpt_request(&req);
    cassert(result, "OpenAI goal extraction call failed.\n");

    CatString(out, result->p, result->len);

    FreeString(&prompt);
    FreeString(&req.schema);
    FreeString(result);
}

void ExtractGoalFromText(String* text, String* title, String* extrainfo, time_t *estimated_time, _Bool forceEstTime){
	String json_extract_result;

	// extract process goals
	InitString(title, 256); InitString(extrainfo, 1024);
	InitString(&json_extract_result, 2048);

	printf("Extracing goal... \n\n");

	AICallExtractionGoalSchema(text, &json_extract_result);

	json_value* doc = json_parse(c_str(&json_extract_result), json_extract_result.len);
	change_assert(doc && doc->type == json_object, "Goal is not an object or is not a json\n\n\n%s", c_str(text));

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry candidate = doc->u.object.values[i];

		if (strcmp(candidate.name, "extrainfo") == 0){
			change_assert(candidate.value->type == json_string, "JSON \"extrainfo\" is not a string. \n\n[%s]\n", c_str(text));
			CatString(extrainfo, candidate.value->u.string.ptr, candidate.value->u.string.length);
		}else if (strcmp(candidate.name, "title") == 0){
			change_assert(candidate.value->type == json_string, "JSON \"title\" is not a string. \n\n[%s]\n", c_str(text));
			CatString(title, candidate.value->u.string.ptr, candidate.value->u.string.length);
		}else if (forceEstTime && strcmp(candidate.name, "estimated_time") == 0){
			change_assert(candidate.value->type == json_integer, "JSON \"estimated_time\" is not an integer. \n\n[%s]\n", c_str(text));
			*estimated_time = candidate.value->u.integer;
		}
	}
	json_value_free(doc);

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

void SetGoalDecompositionPrompt(Goal* g, String* prompt, time_t now){
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

	start_ds_session(&task, g->id, &personalization_context);

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
	size_t *estimated_time
) {
	change_assert(item && item->type == json_object, "Subgoal item is not an object.\n");

	json_value *title_json = json_object_get(item, "title");
	json_value *extrainfo_json = json_object_get(item, "extrainfo");
	json_value *estimated_time_json = json_object_get(item, "estimated_time");

	change_assert(title_json && title_json->type == json_string, "Subgoal title missing or invalid.\n");
	change_assert(extrainfo_json && extrainfo_json->type == json_string, "Subgoal extrainfo missing or invalid.\n");
	change_assert(estimated_time_json && estimated_time_json->type == json_integer, "Subgoal estimated_time missing or invalid.\n");

	change_assert(title_json->u.string.length >= 3, "Subgoal title is too short.\n");
	change_assert(extrainfo_json->u.string.length >= 10, "Subgoal extrainfo is too short.\n");
	change_assert(estimated_time_json->u.integer > 0, "Subgoal estimated_time must be positive.\n");

	InitString(title, title_json->u.string.length + 64);
	CatString(title, title_json->u.string.ptr, title_json->u.string.length);

	InitString(extrainfo, extrainfo_json->u.string.length + 256);
	CatString(extrainfo, extrainfo_json->u.string.ptr, extrainfo_json->u.string.length);

	*estimated_time = (size_t)estimated_time_json->u.integer;
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

	printf("Calling goal decomposition...\n\n");

	String *result = ai_openai_call_gpt_request(&req);
	cassert(result, "OpenAI goal decomposition call failed.\n");

	FreeString(&req.schema);

	return result;
}


