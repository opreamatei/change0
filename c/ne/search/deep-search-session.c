#include "deep-search-session.h"
#include "command-parsing.h"
#include "deep-search-execute.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lib/openai/openai.h"
#include "graph-engine.h"
#include "globals.h"
#include "config.h"

static ds_emit_like_func ds_emit = NULL;

_Bool init_ds_memory(DS_memory *d){
	if (!d) return 0;

	// they auto assert
	InitString(&d->dynamic, 1);
	InitString(&d->persistent, 1);

	return 1;
}

// assuming d is stack allocated
void free_ds_memory(DS_memory *d){
	if (!d) return;
	FreeString(&d->persistent);
	FreeString(&d->dynamic);
}

static void write_round_header(DS_memory* mem, size_t depth, char* ds_id){
	char header[32];
	size_t size = sprintf(header, "\n\n------------- Round [%zu]:\n\n", depth);
	CatString(&mem->dynamic, header, size);

	ds_emit(ds_id, "round-start", header, size);
}

static void fail_finish(DS_memory *mem, String *conclusion, size_t depth, Task* task){
	char *buff = malloc(conclusion->len + 256);
	cassert(buff, "Can't allocate quick memory to fill a buffer");

	size_t size = sprintf(buff, "Agent tried to finish early, but minimum round is %zu, reason : [%s]\n", task->minDepth, c_str(conclusion));

	CatString(&mem->dynamic, buff, size);
	free(buff);
}

_Bool try_terminate(DS_memory *mem, String *out, size_t depth, Task* task, String *conclusion){

	if (conclusion->len > 0){
		if (depth < task->minDepth){
			fail_finish(mem, conclusion, depth, task);
			return 0; // did not finish
		}else{
			CopyString(out, conclusion);
			return 1; // did finish
		}
	}

	return 0; // did not finish
}

static inline void write_feedback(DS_memory* mem, String* out, String* reason){
	printf("\n%s\n\n", reason->p);
	CatTemplateString(&mem->persistent, "{ Server Intervention :  You had previously tried to execute this task, but failed the automatic validation, here is feedback: [%s]. Your previous response that caused the failing is [%s]. You may repeat the round with this hint. }", c_str(reason), c_str(&mem->dynamic));
	EmptyString(&mem->dynamic);
}

static _Bool judge_result(String *out, String* reason, Task *task, char *ds_id){
	ds_emit(ds_id, "judge-start", "{\"judge\":true}", FSIZE("{\"judge\":true}"));
	
	size_t len = 0; 

	_Bool pass = 0;
	_Bool received_pass = 0;

	json_value *root = call_gpt_judge(out, task);
	cassert(root, "Judge root is NULL.\n");

	char *json_raw = openai_extract_output_text_dup(root, &len);
	cassert(json_raw, "Failed to extract judge JSON text.\n");
	cassert(len > 0, "Judge returned empty JSON text.\n");

	json_value *json_parsed = json_parse(json_raw, len);
	cassert(json_parsed, "Judge result isn't JSON.\n");
	cassert(json_parsed->type == json_object, "Judge JSON is not an object.\n");

	parse_judge_result(json_parsed, reason, &received_pass, &pass);
	cassert(received_pass, "Judge JSON didn't provide a pass field.\n");

	json_value_free(json_parsed);
	json_value_free(root);
	free(json_raw);

	if (pass) {
		ds_emit(ds_id, "judge-pass", "yes", 3);
		return 1;
	}

	printf("Judge reason : %s", c_str(reason));

	cassert(reason->len, "No provided reason.\n");

	// EMIT JUDGE RESULT
	ds_emit(ds_id, "judge-fail", c_str(reason), reason->len);

	return 0;
}

// TODO Implement a score mechanism as a third way of searching andd the default one.
// a node value is (weight * 0.8) + (activation * 0.3)
// Or even make it in more "human" formats like variants of a * weight + b * activation
// where a and b depend on the context

static _Bool think(DS_memory *mem, String *out, size_t depth, Task* task, char *ds_id){

	size_t respsize;
	char* response = call_gpt_deepsearch(mem, &respsize);

	ds_emit(ds_id, "ds-model-response", response, respsize);

	printf("Response : %s\n\n", response);

	write_round_header(mem, depth, ds_id);
	CatString(&mem->dynamic, response, respsize);

	// Parse JSON
	json_value *doc = json_parse(response, respsize);
	cassert(doc, "Error : Can't parse resp as json.\n");
	cassert(doc->type == json_object, "Error : json is not an object.\n");


	// check if finished

	String conclusion; InitString(&conclusion, 1024);
	exec_response(doc, &mem->dynamic, depth, &conclusion, ds_id);

	_Bool terminated = try_terminate(mem, out, depth, task, &conclusion);
	
	free(response);
	json_value_free(doc);
	FreeString(&conclusion);

	return terminated;
}

static void lazy_load(){
    if (ds_emit == NULL){
        ds_emit = (ds_emit_like_func)ReadGlobalPointer("ds_emit", FSIZE("ds_emit"));
	cassert(ds_emit, "Can't load ds_emit");
    }
}

void start_ds_session(Task *task, char* id, String* out){
	lazy_load();

	DS_memory mem;
	if (massert(init_ds_memory(&mem), "Couldn't allocate memory for ds session"))
		return;

	InitString(out, 1024);
	
	ResizeString(&mem.persistent, sizeof(DS_PERSISTENT_PROMPT) + task->name.len + 1);

	size_t req_space = sprintf(mem.persistent.p, DS_PERSISTENT_PROMPT, c_str(&task->name));


	if (req_space >= mem.persistent.cap){
		fprintf(stderr, "Req size : %zu, Mem Size : %zu", req_space, mem.persistent.cap);
		cassert(0, "Error : Increase Persistent memory size (Macro) to solve this.\n");
	}
	mem.persistent.len = req_space;

	ds_emit(id, "p-mem", mem.persistent.p, mem.persistent.len);

	RefreshGraph();

	ds_emit(id, "ds-start", "{\"start\" : true}", FSIZE("{\"start\" : true}"));
	
	// internal external depth
	size_t idepth = 1, edepth = 1;
	String reason; InitString(&reason, 1024);

	while (++edepth){
		cassert(edepth < 10, "Error : External Depth went way too hight\n");

		idepth = 1;
		while(idepth++) {
			_Bool status = think(&mem, out, idepth, task, id);
			if (status == 1) break;
			cassert(idepth < 100, "Error : Internal Depth went way too high\n");
		}

		_Bool success = judge_result(out, &reason, task, id);
		if (success) break;


		// failed task 
		write_feedback(&mem, out, &reason);
	}

	ds_emit(id, "d-mem", mem.dynamic.p, mem.dynamic.len);
	ds_emit(id, "p-mem", mem.persistent.p, mem.persistent.len);
	ds_emit(id, "ds-end", out->p, out->len);

	printf("[debug] Persistent Memory : %s", mem.persistent.p);
	printf("[debug] Dynamic Memory : %s", mem.dynamic.p);

	FreeString(&reason);
	free_ds_memory(&mem);
}
