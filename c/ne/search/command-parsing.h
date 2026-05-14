#ifndef COMMAND_PARSING_LIBRARY
#define COMMAND_PARSING_LIBRARY

#include "../lib/jsonp/json.h"
#include "../lib/util/util.h"
#include "goal-util.h"
#include "node.h"

void print_global_context_nodes(String *buff, char *suffix);

_Bool decompose_command_1_params(
		json_value *doc, String *ErrorBuff,
		int_fast64_t *percentage,
		char (*criteria)[16], size_t *criteria_length,
		String *intent
		);

_Bool decompose_command_2_params(
		json_value *doc, String *ErrorBuff, 
		int_fast64_t *percentage, 
		char (*target)[NODE_LABEL_CAP], size_t *target_length, 
		char (*criteria)[16], size_t *criteria_length,
		int_fast64_t *context,
		String *intent);

_Bool decompose_command_3_params(
	json_value* doc, String* ErrorBuff,
	char (*target)[NODE_LABEL_CAP], size_t *target_length,
	int_fast64_t *context,
	int_fast64_t *percA, int_fast64_t *percW,
	int_fast64_t *depth,
	String *intent
	);

_Bool decompose_command_4_params(
		json_value *doc, String *ErrorBuff,
		char (*mode)[16], size_t *mode_length,
		size_t *max
		);

_Bool decompose_command_5_params(
		json_value *doc, String *ErrorBuff,
		goalIDType *goal_id,
		int_fast64_t *depth
		);

_Bool decompose_command_6_params(
		json_value *doc, String *ErrorBuff,
		goalIDType *goal_id,
		char (*method)[32], size_t *method_length
		);

_Bool decompose_command_7_params(
		json_value *doc, String *ErrorBuff,
		time_t *offset_schedule
		);

void cat_perc_to_buffer(String *buffer, int_fast64_t percentage);

void parse_exec_response(json_value* doc, _Bool *finished, json_value** original_conclusion, int_fast64_t *command);

void parse_judge_result(json_value* doc, String *reason, _Bool *received_pass, _Bool *pass);


#endif
