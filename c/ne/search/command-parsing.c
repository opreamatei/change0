#include "command-parsing.h"
#include "string.h"

void print_global_context_nodes(String *buff, char *suffix){
	for (uint_fast8_t i = 0; i < CONTEXT_COUNT; i++){
		CatString(buff, NodeAt(Contexts[i])->label, NodeAt(Contexts[i])->labelLength);
		if (i != CONTEXT_COUNT - 1) CatFixed(buff, ","); else CatFixed(buff, suffix);
	}
}

_Bool decompose_command_1_params(
		json_value *doc, String *ErrorBuff,
		int_fast64_t *percentage,
		char (*criteria)[16], size_t *criteria_length,
		String *intent
		){
	*criteria_length = 0;
	*percentage = -1;

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry entry = doc->u.object.values[i];
		if (!strcmp(entry.name, "percentage") && entry.value->type == json_integer)
			*percentage = CLAMP(0, 100, entry.value->u.integer);
		if (!strcmp(entry.name, "criteria") && entry.value->type == json_string){
			*criteria_length = MIN(entry.value->u.string.length, 15);
			if (
					strcmp(entry.value->u.string.ptr, "weight") != 0 &&
					strcmp(entry.value->u.string.ptr, "activation") != 0
			   ){
				CatFixed(ErrorBuff, "Error : \"criteria\" parameter must be \"activation\" or \"weight\".\n");
				return 0;
			};

			memcpy(*criteria, entry.value->u.string.ptr, *criteria_length);
			(*criteria)[*criteria_length] = '\0';
		}
		if (!strcmp(entry.name, "intent") && entry.value->type == json_string){
			CatString(intent, entry.value->u.string.ptr, entry.value->u.string.length);
		}
	}

	if (*percentage == -1){
		CatFixed(ErrorBuff, "\nError executing: No \"percentage\" argument passed (1-100)\n");
		return 0;
	};

	if (*criteria_length == 0){
		CatFixed(ErrorBuff, "\nError executing: You must pass a \"criteria\" parameter (\"activation\" or \"weight\").\n");
		return 0;
	};

	return 1;
}

_Bool decompose_command_2_params(
		json_value *doc, String *ErrorBuff, 
		int_fast64_t *percentage, 
		char (*target)[NODE_LABEL_CAP], size_t *target_length, 
		char (*criteria)[16], size_t *criteria_length,
		int_fast64_t *context,
		String *intent){
	*percentage = -1;
	*target_length = 0;
	*criteria_length = 0;
	*context = -1;

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry entry = doc->u.object.values[i];
		if (!strcmp(entry.name, "percentage") && entry.value->type == json_integer)
			*percentage = CLAMP(0, 100, entry.value->u.integer);
		if (!strcmp(entry.name, "node") && entry.value->type == json_string){
			*target_length = MIN(entry.value->u.string.length, NODE_LABEL_CAP - 1);
			memcpy(*target, entry.value->u.string.ptr, *target_length);
			(*target)[*target_length] = '\0';
		}
		if (!strcmp(entry.name, "criteria") && entry.value->type == json_string){
			*criteria_length = MIN(entry.value->u.string.length, 15);

			if (
					strcmp(entry.value->u.string.ptr, "weight") != 0 &&
					strcmp(entry.value->u.string.ptr, "activation") != 0
			   ){
				CatFixed(ErrorBuff, "Error : \"criteria\" parameter must be \"activation\" or \"weight\".\n");
				return 0;
			};

			memcpy(*criteria, entry.value->u.string.ptr, *criteria_length);
			(*criteria)[*criteria_length] = '\0';
		}
		if (!strcmp(entry.name, "context") && entry.value->type == json_string){
			lowerAll(&entry.value->u.string.ptr, entry.value->u.string.length);
			for (uint_fast8_t i = 0; i < CONTEXT_COUNT; i++){
				if (strcmp(entry.value->u.string.ptr, NodeAt(Contexts[i])->label) == 0){
					*context = Contexts[i];
					break;
				}
			}
			if (*context == -1){
				CatFixed(ErrorBuff, "Error : You passed an invalid context. Available Contexts:\n");
				print_global_context_nodes(ErrorBuff, "\n\n");
				return 0;
			}
		}
		if (!strcmp(entry.name, "intent") && entry.value->type == json_string){
			CatString(intent, entry.value->u.string.ptr, entry.value->u.string.length);
		}
	}

	if (*percentage == -1 || *target_length == 0 || *context == -1 || *criteria_length == 0){
		CatFixed(ErrorBuff, "Error : You must pass a \"percentage\" argument (1-100), a filter \"criteria\" (activation / weight) and a \"context\" (Node parent) in command 2. Available Contexts:\n");
		print_global_context_nodes(ErrorBuff, "\n\n");
		return 0;
	};

	*percentage = CLAMP(0, 100, *percentage);

	return 1;
}


_Bool decompose_command_3_params(
	json_value* doc, String* ErrorBuff,
	char (*target)[NODE_LABEL_CAP], size_t *target_length,
	int_fast64_t *context,
	int_fast64_t *percA, int_fast64_t *percW,
	int_fast64_t *depth,
	String *intent
	){

	*target_length = 0;
	*context = -1;
	*percA = -1;
	*percW = -1;
	*depth = 3;

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry entry = doc->u.object.values[i];
		if (!strcmp(entry.name, "node") && entry.value->type == json_string){
			*target_length = MIN(entry.value->u.string.length, NODE_LABEL_CAP - 1);
			memcpy(*target, entry.value->u.string.ptr, *target_length);
			(*target)[*target_length] = '\0';
		}
		if (!strcmp(entry.name, "depth") && entry.value->type == json_integer)
			*depth = entry.value->u.integer;
		if (!strcmp(entry.name, "percA") && entry.value->type == json_integer)
			*percA = entry.value->u.integer;
		if (!strcmp(entry.name, "percW") && entry.value->type == json_integer)
			*percW = entry.value->u.integer;
		if (!strcmp(entry.name, "context") && entry.value->type == json_string){
			lowerAll(&entry.value->u.string.ptr, entry.value->u.string.length);
			for (uint_fast8_t i = 0; i < CONTEXT_COUNT; i++){
				if (strcmp(entry.value->u.string.ptr, NodeAt(Contexts[i])->label) == 0){
					*context = Contexts[i];
					break;
				}
			}
			if (*context == -1){
				CatFixed(ErrorBuff, "Error : You passed an invalid context. Available Contexts:\n");
				print_global_context_nodes(ErrorBuff, "\n\n");
				return 0;
			}
		}
		if (!strcmp(entry.name, "intent") && entry.value->type == json_string){
			CatString(intent, entry.value->u.string.ptr, entry.value->u.string.length);
		}
	}

	if ((*percW == -1 && *percA == -1) || *target_length == 0 || *context == -1){
		CatFixed(ErrorBuff, "Error : You must either pass a \"percA\" filter (1-100), either a \"percW\" filter (1-100), or both. You also need a \"context\" (Node parent) in command 3. Available Contexts:\n");
		print_global_context_nodes(ErrorBuff, "\nYou can also pass an optional \"depth\" parameter (1-5, defaults to 3)\n\n");
		return 0;
	};
	
	// defaults to full coverage
	if (*percA == -1) *percA = 100;
	if (*percW == -1) *percW = 100; 

	*percA = CLAMP(0, 100, *percA);
	*percW = CLAMP(0, 100, *percW);

	return 1;
}

void cat_perc_to_buffer(String *buffer, int_fast64_t percentage){
	if (buffer->len + 2 < buffer->cap)
		ResizeString(buffer, MAX(buffer->len * 2, 8));
	
	cassert(buffer->len + 2 < buffer->cap, "Error : Buffer Doesn't have enough memory for 2 more characters");

	if (percentage >= 100){
		CatFixed(buffer, "100");
	}else if (percentage > 9){ // 2 digits
				   // We assume preallocated memory is enough
		*(buffer->p + buffer->len) = ('0' + percentage / 10);
		*(buffer->p + buffer->len + 1) = ('0' + percentage % 10);
		buffer->len += 2;
	}else if (percentage < 10 && percentage > -1){
		*(buffer->p + buffer->len) = ('0' + percentage); 
		buffer->len++;
	}
}

void parse_exec_response(json_value* doc, _Bool *finished, json_value** original_conclusion, int_fast64_t *command){
	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry *e = &doc->u.object.values[i];
		if (strcmp(e->name, "finished") == 0 && e->value->type == json_boolean)
			*finished = e->value->u.boolean;
		if (strcmp(e->name, "conclusion") == 0 && e->value->type == json_string)
			*original_conclusion = e->value;
		if (strcmp(e->name, "command") == 0 && e->value->type == json_integer)
			*command = e->value->u.integer;
	}
}

void parse_judge_result(json_value* doc, String *reason, _Bool *received_pass, _Bool *pass){
	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry e = doc->u.object.values[i];
		if (strcmp(e.name, "reason") == 0 && e.value->type == json_string){
			CatString(reason, e.value->u.string.ptr, e.value->u.string.length);
		}else if (strcmp(e.name, "pass") == 0 && e.value->type == json_boolean){
			*pass = e.value->u.boolean;
			*received_pass = 1;
		}
	}
}

_Bool decompose_command_4_params(
		json_value *doc, String *ErrorBuff,
		char (*mode)[16], size_t *mode_length,
		size_t *max
		){
	*mode_length = 5;
	memcpy(*mode, "roots", 5);
	(*mode)[5] = '\0';

	*max = SIZE_MAX;

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry entry = doc->u.object.values[i];

		if (!strcmp(entry.name, "mode") && entry.value->type == json_string){
			if (
					strcmp(entry.value->u.string.ptr, "roots") != 0 &&
					strcmp(entry.value->u.string.ptr, "due") != 0 &&
					strcmp(entry.value->u.string.ptr, "history") != 0
			   ){
				CatFixed(ErrorBuff,
						"Error : \"mode\" parameter must be one of: "
						"\"roots\", \"due\", or \"history\".\n");
				return 0;
			}

			*mode_length = MIN(entry.value->u.string.length, 15);
			memcpy(*mode, entry.value->u.string.ptr, *mode_length);
			(*mode)[*mode_length] = '\0';
		}

		if (!strcmp(entry.name, "max") && entry.value->type == json_integer){
			if (entry.value->u.integer < 0){
				CatFixed(ErrorBuff, "Error : \"max\" parameter must be >= 0.\n");
				return 0;
			}

			*max = (size_t)entry.value->u.integer;
		}
	}

	return 1;
}

_Bool decompose_command_5_params(
		json_value *doc, String *ErrorBuff,
		goalIDType *goal_id,
		int_fast64_t *depth
		){
	*depth = -1;
	*goal_id[0] = '\0';

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry entry = doc->u.object.values[i];

		if (!strcmp(entry.name, "goal_id") && entry.value->type == json_string){
			size_t goal_id_len = entry.value->u.string.length;
			memcpy(*goal_id, entry.value->u.string.ptr, goal_id_len);
			(*goal_id)[goal_id_len] = '\0';
		}

		if (!strcmp(entry.name, "depth") && entry.value->type == json_integer){
			*depth = entry.value->u.integer;
		}
	}

	if ((*goal_id)[0] == '\0'){
		CatFixed(ErrorBuff, "Error : You must pass a \"goal_id\" parameter in command 5.\n");
		return 0;
	}

	if (*depth == -1){
		CatFixed(ErrorBuff, "Error : You must pass a \"depth\" parameter in command 5. Valid range: 1-5.\n");
		return 0;
	}

	*depth = CLAMP(1, 5, *depth);

	return 1;
}

// AI Generated
_Bool decompose_command_6_params(
		json_value *doc, String *ErrorBuff,
		goalIDType *goal_id,
		char (*method)[32], size_t *method_length
		){
	*method_length = 0;
	(*goal_id)[0] = '\0';

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry entry = doc->u.object.values[i];

		if (!strcmp(entry.name, "goal_id") && entry.value->type == json_string){
			size_t goal_id_len = MIN(entry.value->u.string.length, sizeof(*goal_id) - 1);

			memcpy(*goal_id, entry.value->u.string.ptr, goal_id_len);
			(*goal_id)[goal_id_len] = '\0';
		}

		if (!strcmp(entry.name, "method") && entry.value->type == json_string){
			*method_length = MIN(entry.value->u.string.length, 31);

			if (
					strcmp(entry.value->u.string.ptr, "history") != 0 &&
					strcmp(entry.value->u.string.ptr, "siblings") != 0 &&
					strcmp(entry.value->u.string.ptr, "parents") != 0 &&
					strcmp(entry.value->u.string.ptr, "linked-siblings") != 0 &&
					strcmp(entry.value->u.string.ptr, "linked-siblings-hidden") != 0 &&
					strcmp(entry.value->u.string.ptr, "uncles") != 0 &&
					strcmp(entry.value->u.string.ptr, "uncles-hidden") != 0
			   ){
				CatFixed(ErrorBuff,
						"Error : \"method\" parameter must be one of: "
						"\"history\", \"siblings\", \"parents\", "
						"\"linked-siblings\", \"linked-siblings-hidden\", "
						"\"uncles\", or \"uncles-hidden\".\n");
				return 0;
			}

			memcpy(*method, entry.value->u.string.ptr, *method_length);
			(*method)[*method_length] = '\0';
		}
	}

	if ((*goal_id)[0] == '\0'){
		CatFixed(ErrorBuff, "Error : You must pass a \"goal_id\" parameter in command 6.\n");
		return 0;
	}

	if (*method_length == 0){
		CatFixed(ErrorBuff,
				"Error : You must pass a \"method\" parameter in command 6. "
				"Available methods: history, siblings, parents, linked-siblings, "
				"linked-siblings-hidden, uncles, uncles-hidden.\n");
		return 0;
	}

	return 1;
}

_Bool decompose_command_7_params(
		json_value *doc, String *ErrorBuff,
		time_t *offset_schedule
		){
	*offset_schedule = 0;

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry entry = doc->u.object.values[i];

		if (!strcmp(entry.name, "offset") && entry.value->type == json_integer)
			*offset_schedule = entry.value->u.integer;
	}

	return 1;
}
