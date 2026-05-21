#include "input-processor.h"

#include "json.h"
#include "openai.h"
#include "json-to-graph.h"
#include "profile/user-profile.h"
#include <string.h>
#include <stdio.h>
#include "config.h"
#include <stdlib.h>

static json_value *call_gpt_decomposition(String *input){
	String prompt; InitString(&prompt, sizeof(DECOMPOSITION_INTO_GRAPH_PROMPT) + input->len + 1);

	size_t required = sprintf(c_str(&prompt), DECOMPOSITION_INTO_GRAPH_PROMPT, c_str(input));
	cassert(required < prompt.cap, "You have not allocated sufficient space for response.\n");

	char *escaped_prompt = json_escape_dup(c_str(&prompt));

	size_t body_cap = strlen(escaped_prompt) + sizeof(OPENAI_DECOMPOSITION_SCHEMA_JSON) + 1024;
	char *json_body = malloc(body_cap);
	cassert(json_body, "Failed to allocate json body.\n");

	int body_size = snprintf(
		json_body, body_cap,
"{"
    "\"model\":\"gpt-5.4-mini\","
    "\"input\":\"%s\","
    "\"text\":{"
        "\"format\":{"
            "\"type\":\"json_schema\","
            "\"strict\":true,"
            "\"name\":\"identity_mock_bundle\","
            "\"schema\":%s"
        "}"
    "}"
"}",
		escaped_prompt,
		OPENAI_DECOMPOSITION_SCHEMA_JSON
	);
	cassert(body_size > 0 && (size_t)body_size < body_cap, "Failed to build OpenAI request body.\n");

	ai_openai_response created = {0};
	ai_openai_status st = ai_openai_create_response(json_body, &created);

	free(escaped_prompt);
	free(json_body);
	FreeString(&prompt);

	cassert(st == AI_OPENAI_OK, (char*) ai_openai_strerror(st));
	cassert(c_str(&created.body), "OpenAI returned empty body.\n");

	json_value *root = json_parse(c_str(&created.body), created.body.len);
	cassert(root, "Failed to parse OpenAI response body.\n");

	ai_openai_response_free(&created);

	return root;
}

// AI Generated function
static json_value* extract_ai_json(json_value *root){
    cassert(root && root->type == json_object, "Invalid root JSON.\n");

    json_value *output = NULL;

    // root["output"]
    for (unsigned i = 0; i < root->u.object.length; i++){
        json_object_entry *e = &root->u.object.values[i];
        if (strcmp(e->name, "output") == 0){
            output = e->value;
            break;
        }
    }

    cassert(output && output->type == json_array, "Missing output array.\n");

    for (unsigned i = 0; i < output->u.array.length; i++){
        json_value *item = output->u.array.values[i];
        if (!item || item->type != json_object) continue;

        json_value *content = NULL;

        // item["content"]
        for (unsigned j = 0; j < item->u.object.length; j++){
            json_object_entry *e = &item->u.object.values[j];
            if (strcmp(e->name, "content") == 0){
                content = e->value;
                break;
            }
        }

        if (!content || content->type != json_array) continue;

        for (unsigned k = 0; k < content->u.array.length; k++){
            json_value *c = content->u.array.values[k];
            if (!c || c->type != json_object) continue;

            json_value *text = NULL;

            // c["text"]
            for (unsigned t = 0; t < c->u.object.length; t++){
                json_object_entry *e = &c->u.object.values[t];
                if (strcmp(e->name, "text") == 0){
                    text = e->value;
                    break;
                }
            }

            if (text && text->type == json_string){

		printf("successfully indentified : %s\n\n", text->u.string.ptr);

                json_value *parsed = json_parse(text->u.string.ptr, text->u.string.length);
                cassert(parsed, "Failed to parse AI output JSON.\n");
                return parsed;
            }
        }
    }

    cassert(0, "Could not extract AI JSON text.\n");
    return NULL;
}

void DecomposeInputIntoGraph(String *input, User *user){

	json_value* root = NULL;
	UserProfileRecordInput(user, "input_to_graph", input ? input->p : "");

	printf("Generating response ...\n");
	root = call_gpt_decomposition(input);

	cassert(root, "Doc doesn't seem to exist \n");
	cassert(root->type == json_object, "Doc exists but is not an object \n");

	//cassert(root->u.object.length == CONTEXT_COUNT, "Doc has not CONTEXT_COUNT children. But it exists and it is an object\n");

	json_value* response_target = extract_ai_json(root);
	cassert(response_target, "Respose from OpenAI seems corrupt, can t parse\n");

	for (size_t i = 0; i < response_target->u.object.length; i++){
		json_object_entry entry = response_target->u.object.values[i];
	
		AddContextNodesFromJSON(entry.name, entry.name_length, entry.value);
	}


	json_value_free(response_target);
	json_value_free(root);
}
