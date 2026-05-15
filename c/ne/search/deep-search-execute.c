#include "deep-search-execute.h" 
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ai-action.h"
#include "openai.h"
#include "util.h"
#include "command-parsing.h"
#include "config.h"

void exec_response(json_value* doc, String *dynamic_mem, size_t depth, String *conclusion, char* ds_id){

	_Bool finished = 0;
	json_value* original_conclusion = NULL;
	int_fast64_t command = -1;
	
	parse_exec_response(doc, &finished, &original_conclusion, &command);

	if (finished && !original_conclusion){
		CatFixed(dynamic_mem, "\nError : AI Model tried to finish, but have not passed a \"conclusion\" in response.");
		//cassert(!(finished && !original_conclusion), "Error : Finished but no conclusion passed");
		return;
	}

	if (finished && original_conclusion){
		CatString(conclusion, original_conclusion->u.string.ptr, original_conclusion->u.string.length);
		return;
	}

	if (command == 1)
		run1(doc, dynamic_mem, ds_id);
	else if (command == 2)
		run2(doc, dynamic_mem, ds_id);
	else if (command == 3)
		run3(doc, dynamic_mem, ds_id);
	else if (command == 4)
		run4(doc, dynamic_mem, ds_id);
	else if (command == 5)
		run5(doc, dynamic_mem, ds_id);
	else if (command == 6)
		run6(doc, dynamic_mem, ds_id);
	else if (command == 7)
		run7(doc, dynamic_mem, ds_id);
	else if (command == 8)
		run8(doc, dynamic_mem, ds_id);
	else if (command == 9)
		run9(doc, dynamic_mem, ds_id);
	else 
		CatTemplateString(dynamic_mem, "{Error : Commands are only 1-%d, you passed [%d] }", COMMAND_COUNT, command);
}

// Half is AI generated
static json_value *call_gpt_deep_search(DS_memory *mem){
	cassert(mem, "Error: NULL DS_memory passed.\n");
	cassert(mem->persistent.p, "Error: persistent prompt is NULL.\n");
	cassert(mem->dynamic.p, "Error: dynamic prompt is NULL.\n");

	/* persistent first, dynamic second */
	String prompt;
	InitString(&prompt, mem->persistent.len + mem->dynamic.len + 2);
	cassert(prompt.p, "Error: Failed to allocate prompt buffer.\n");

	CatString(&prompt, mem->persistent.p, mem->persistent.len);
	CatFixed(&prompt, "\n");
	CatString(&prompt, mem->dynamic.p, mem->dynamic.len);

	char *escaped_prompt = json_escape_dup(c_str(&prompt));
	cassert(escaped_prompt, "Error: Failed to escape prompt for JSON.\n");

	size_t body_cap =
		strlen(escaped_prompt) +
		sizeof(OPENAI_DEEP_SEARCH_SCHEMA_JSON) +
		1024;

	char *json_body = malloc(body_cap);
	cassert(json_body, "Error: Failed to allocate OpenAI request body.\n");

	int body_size = snprintf(
		json_body, body_cap,
		"{"
			"\"model\":\"gpt-5.4-mini\","
			"\"input\":\"%s\","
			"\"text\":{"
				"\"format\":{"
					"\"type\":\"json_schema\","
					"\"strict\":true,"
					"\"name\":\"deep_search_action\","
					"\"schema\":%s"
				"}"
			"}"
		"}",
		escaped_prompt,
		OPENAI_DEEP_SEARCH_SCHEMA_JSON
	);

	cassert(body_size > 0 && (size_t)body_size < body_cap,
		"Error: Failed to build OpenAI request body.\n");

	printf("Waiting for OPENAI resposne...\n");

	ai_openai_response created = {0};
	ai_openai_status st = ai_openai_create_response(json_body, &created);

	free(escaped_prompt);
	free(json_body);
	FreeString(&prompt);

	cassert(st == AI_OPENAI_OK, (char*) ai_openai_strerror(st));
	cassert(c_str(&created.body), "Error: OpenAI returned empty body.\n");

	json_value *root = json_parse(c_str(&created.body), created.body.len);
	cassert(root, "Error: Failed to parse OpenAI response body.\n");

	ai_openai_response_free(&created);

	return root;
}

char* call_gpt_deepsearch(DS_memory *mem, size_t *respsize){
	cassert(mem, "Error: mem is NULL.\n");
	cassert(respsize, "Error: respsize is NULL.\n");

	json_value *root = call_gpt_deep_search(mem);
	cassert(root, "Error: OpenAI root response is NULL.\n");

	char *response = openai_extract_output_text_dup(root, respsize);
	cassert(response, "Error: Failed to extract validated OpenAI JSON text.\n");

	json_value_free(root);
	return response;
}

json_value *call_gpt_judge(String *out, Task *task){
	cassert(out, "Error: NULL out passed.\n");
	cassert(task, "Error: NULL task passed.\n");

	size_t prompt_cap =
		strlen(DS_JUDGE_PROMPT) +
		task->name.len +
		out->len +
		64;

	char *prompt = malloc(prompt_cap);
	cassert(prompt, "Error: Failed to allocate judge prompt.\n");

	int written = snprintf(
		prompt, prompt_cap,
		DS_JUDGE_PROMPT,
		c_str(&task->name),
		c_str(out)
	);
	cassert(written > 0 && (size_t)written < prompt_cap, "Error: Failed to build judge prompt.\n");

	char *escaped_prompt = json_escape_dup(prompt);
	free(prompt);
	cassert(escaped_prompt, "Error: Failed to escape judge prompt.\n");

	size_t body_cap =
		strlen(escaped_prompt) +
		sizeof(OPENAI_DEEP_SEARCH_JUDGE_SCHEMA_JSON) +
		1024;

	char *json_body = malloc(body_cap);
	cassert(json_body, "Error: Failed to allocate judge request body.\n");

	int body_size = snprintf(
		json_body, body_cap,
		"{"
			"\"model\":\"gpt-5.4-mini\","
			"\"input\":\"%s\","
			"\"text\":{"
				"\"format\":{"
					"\"type\":\"json_schema\","
					"\"strict\":true,"
					"\"name\":\"deep_search_judge\","
					"\"schema\":%s"
				"}"
			"}"
		"}",
		escaped_prompt,
		OPENAI_DEEP_SEARCH_JUDGE_SCHEMA_JSON
	);

	free(escaped_prompt);
	cassert(body_size > 0 && (size_t)body_size < body_cap,
		"Error: Failed to build judge OpenAI request body.\n");

	printf("Waiting for OPENAI judge response...\n");

	ai_openai_response created = {0};
	ai_openai_status st = ai_openai_create_response(json_body, &created);
	free(json_body);

	cassert(st == AI_OPENAI_OK, (char*) ai_openai_strerror(st));
	cassert(c_str(&created.body), "Error: OpenAI judge returned empty body.\n");

	json_value *root = json_parse(c_str(&created.body), created.body.len);
	cassert(root, "Error: Failed to parse OpenAI judge response body.\n");

	ai_openai_response_free(&created);
	return root;
}
