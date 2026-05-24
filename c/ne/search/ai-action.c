#include "ai-action.h"
#include "goal-info.h"
#include <stdio.h>
#include <stdlib.h>
#include "goal/goal-util.h"
#include "util.h"
#include "user-schedule.h"
#include <string.h>
#include "search.h"
#include "command-parsing.h"
#include "globals.h"
#include "profile/user-profile.h"

static ds_emit_like_func ds_emit = NULL;

static void lazy_load(){
    if (ds_emit == NULL)
        ds_emit = (ds_emit_like_func)ReadGlobalPointer("ds_emit", FSIZE("ds_emit"));
}

void run1(json_value* doc, String *dynamic_mem, char *ds_id, User *user){
	if (!dynamic_mem || !doc) return;
	lazy_load();

	NodeContainer *nc = &user->nodes;
	int_fast64_t percentage = -1;
	char criteria[16];
	size_t criteria_length;
	String intent; InitString(&intent, 256);

	if (decompose_command_1_params(doc, dynamic_mem, &percentage, &criteria, &criteria_length, &intent) == 0) return;

	size_t count = 0;

	Node** result;

	_Bool isActivation;

	if (!strcmp(criteria, "activation")){
		result = FilterNodeByActivationGlobal(percentage, &count, nc);
		isActivation = 1;
	}else if(!strcmp(criteria, "weight")){
		result = FilterNodeByWeightGlobal(percentage, &count, nc);
		isActivation = 0;
	}else {
		cassert(0, "You shouldn t arrive here unless the compiler is brain damaged :( \n");
	}

	if (!result){
		FreeString(&intent);
		return;
	}

	// Allocate 35 characters per node, 32 bonus
	String data;
	InitString(&data, count * (NODE_LABEL_CAP * 2 + 32) + 32);
	cassert(data.p, "Failed to allocate memory for data.\n");

	if (*intent.p != '\0'){
		CatFixed(&data, "Model Intention : \"");
		CatString(&data, intent.p, intent.len);
		CatFixed(&data, "\"\n\nTop ");
	}else{
		CatFixed(&data, "Top ");
	}

	// convert 0-100 to string
	cat_perc_to_buffer(&data, percentage);

	char s[256];
	CatString(&data, s, sprintf(s, "%c nodes by [%s]:\nCommand Result: ", '%', criteria));

	for (size_t i = 0; i < count; i++){
		char buffer[NODE_LABEL_CAP * 2 + 128];
		size_t len = sprintf(	
				buffer, 
				"{\"name\" : \"%s\", \"%s\" : %.2f, \"parent\" : \"%s\"}\n",
				result[i]->label,
				criteria,
				isActivation ? read_node_activation(nc, result[i]) : read_node_weight(nc, result[i]),
				result[i]->hasParent ? NodeAt(nc, result[i]->parent)->label : "NONE"
		       );
		CatString(&data, buffer, len);

		// count node as seen
		result[i]->times_seen ++;
	}

	CatString(dynamic_mem, c_str(&data), data.len);

	ds_emit(ds_id, "cmd-1", c_str(&data), data.len);

	FreeString(&data);
	free(result);
}

void run2(json_value* doc, String *dynamic_mem, char* ds_id, User *user){
	if (!doc || !dynamic_mem) return;
	lazy_load();

	NodeContainer *nc = &user->nodes;
	int_fast64_t percentage;
	int_fast64_t context;

	char target[NODE_LABEL_CAP];
	size_t target_length;
	char criteria[16];
	size_t criteria_length;

	String intent; InitString(&intent, 256);

	if (!decompose_command_2_params(doc, dynamic_mem, &percentage, &target, &target_length, &criteria, &criteria_length, &context, &intent, nc)) return;

	Node* node = FindNode(nc, target, target_length, NodeAt(nc, context));

	if (!node){
		CatFixed(dynamic_mem, "Error: Target Node not found in context. (Only context was found).\n");
		FreeString(&intent);
		return;
	}

	node->times_used ++;

	size_t count = 0;
	Connection** result;
	_Bool isActivation;

	if (node->ncount == 0){
		CatFixed(dynamic_mem, "Node has no neighbours.\n");
		return;
	}

	if (!strcmp(criteria, "activation")){
		result = FilterNodeNeighboursByActivation(node, percentage, &count);
		isActivation = 1;
	}else{
		isActivation = 0;
		result = FilterNodeNeighboursByWeight(node, percentage, &count);
	}

	if (!result){
		CatFixed(dynamic_mem, "Internal Error : No result.\n");
		FreeString(&intent);
		return;
	}

	String data;
	InitString(&data, count * (NODE_LABEL_CAP + 128) + 32);
	cassert(data.p, "Can't allocate memory for string here.\n");

	if (*intent.p != '\0'){
		CatFixed(&data, "Model Intention : \"");
		CatString(&data, intent.p, intent.len);
		CatFixed(&data, "\"\n\nTop ");
	}else{
		CatFixed(&data, "Top ");
	}

	cat_perc_to_buffer(&data, percentage);

	char s[256];
	size_t len = sprintf(s, "%c nodes related to [\"%s\"] by %s:\nCommand Result: ", '%', target, criteria);

	CatString(&data, s, len);

	for (size_t i = 0; i < count; i++){
		char buffer[NODE_LABEL_CAP + 128];
		Node* target = NodeAt(nc, result[i]->target);
		double relative = isActivation ? read_connection_activation(nc, result[i]) : read_connection_weight(nc, result[i]);
		double local = isActivation ? read_node_activation(nc, target) : read_node_weight(nc, target);
		size_t len = sprintf(	
				buffer, 
				"{\"name\": \"%s\", \"connection_%s\": %.2f, \"node_%s\": %.2f}\n",
				target->label,
				criteria,
				relative,
				criteria,
				local
		       );
		cassert(len < sizeof(buffer), "Here buffer is too small\n");

		target->times_seen ++;

		CatString(&data, buffer, len);
	}
	CatFixed(&data, "\n");

	ds_emit(ds_id, "cmd-2", c_str(&data), data.len);

	free(result);
	CatString(dynamic_mem, data.p, data.len);
	FreeString(&data);
}

void run3(json_value* doc, String *dynamic_mem, char* ds_id, User *user){
	if (!doc || !dynamic_mem) return;
	lazy_load();

	NodeContainer *nc = &user->nodes;
	char target[NODE_LABEL_CAP];
	size_t target_length = 0;

	int_fast64_t percA, percW, depth, context;
	String intent; InitString(&intent, 256);

	if (!decompose_command_3_params(doc, dynamic_mem, &target, &target_length, &context, &percA, &percW, &depth, &intent, nc)) return;

	Node* node = FindNode(nc, target, target_length, NodeAt(nc, context));

	if (!node){
		CatFixed(dynamic_mem, "Error: Target Node not found in context. (Only context was found).\n");
		FreeString(&intent);
		return;
	}

	size_t count = 0;

	
	size_t data_len = 0;
	char* data = ComputeNodeFamily(nc, node, percA, percW, depth, &data_len);

	if (*intent.p != '\0'){
		CatFixed(dynamic_mem, "Model Intention : \"");
		CatString(dynamic_mem, intent.p, intent.len);
		CatFixed(dynamic_mem, "\nCommand Result: ");
	}else{
		CatFixed(dynamic_mem, "Command Result: ");
	}

	CatString(dynamic_mem, data, data_len);

	ds_emit(ds_id, "cmd-3", data, data_len);

	free(data);
}

// Partially AI Generated
void run4(json_value* doc, String *dynamic_mem, char* ds_id, User *user){
	if (!doc || !dynamic_mem) return;
	lazy_load();

	const char *journey_id = user->journeys[0];
	size_t goals_len = 0;
	Goal **goals = GetGoalsSorted(&goals_len, journey_id);
	if (goals_len == 0){ free(goals); CatFixed(dynamic_mem, "Warning, you tried to run a goal-oriented command (4,5,6), but the user currently doesn't have any goals. Please avoid commands 4,5,6."); return;}

	char mode[16] = "roots";
	size_t mode_length = 5;
	size_t max = SIZE_MAX;

	decompose_command_4_params(doc, dynamic_mem, &mode, &mode_length, &max);

	String data;
	InitString(&data, 1024);
	change_assert(data.p, "Failed to allocate memory for command 4 data.\n");

	if (!strcmp(mode, "roots")){

		CatFixed(&data, "Current user Root Goals: {");

		_Bool first = 1;

		for (size_t i = 0; i < goals_len; i++){
			const Goal* g = goals[i];

			if (!g) continue;
			if (g->parent > 0) continue;

			const char* started_on;
			const char* finished_on;

			char started_buf[64];
			char finished_buf[64];

			if (g->start_date == 0) {
				started_on = "not started";
			} else {
				snprintf(started_buf, sizeof(started_buf), "%s", change_ctime(&g->start_date));
				started_buf[strcspn(started_buf, "\n")] = 0;
				started_on = started_buf;
			}

			if (g->end_date == 0) {
				finished_on = "not finished";
			} else {
				snprintf(finished_buf, sizeof(finished_buf), "%s", change_ctime(&g->end_date));
				finished_buf[strcspn(finished_buf, "\n")] = 0;
				finished_on = finished_buf;
			}

			if (!first)
				CatFixed(&data, ",");

			Goal *root = CalcGoalRoot((Goal *)g);
			size_t effective_priority = root ? root->priority : g->priority;

			CatTemplateString(
					&data,
					"{\"name\":\"%s\", "
					"\"extra-info\":\"%s\", "
					"\"finished_on\":\"%s\", "
					"\"started_on\":\"%s\", "
					"\"est-required-total-time-seconds\":%zu, "
					"\"id\":\"%s\", "
					"\"priority\":%zu}",
					g->title.p,
					g->extra_info.p,
					finished_on,
					started_on,
					(size_t)g->required_time,
					g->id,
					effective_priority
					);

			first = 0;
		}

		CatFixed(&data, "}");
	}
	else if (!strcmp(mode, "due")){
		CatFixed(&data, "Current user Due Goals:\n");
		SerializeDueGoals(&data, max, journey_id);
	}
	else if (!strcmp(mode, "history")){
		CatFixed(&data, "Current user Goal History:\n");
		SerializeUserGoalHistory(&data, max, journey_id);
	}
	else {
		CatFixed(&data, "Internal Error: Invalid command 4 mode.\n");
	}

	ds_emit(ds_id, "cmd-4", data.p, data.len);

	CatString(dynamic_mem, data.p, data.len);
	FreeString(&data);
	free(goals);
}

static void CatGoalTree(String* data, const Goal* g, int_fast64_t depth){
	Goal *root = CalcGoalRoot((Goal *)g);
	size_t effective_priority = root ? root->priority : g->priority;

	CatTemplateString(
			data,
			"{\"name\":\"%s\", "
			"\"extra-info\":\"%s\", "
			"\"est-required-total-time-seconds\":%zu, "
			"\"id\":\"%s\", "
			"\"priority\":%zu, "
			"\"children\":[",
			g->title.p,
			g->extra_info.p,
			(size_t)g->required_time,
			g->id,
			effective_priority
			);

	if (depth > 0 && g->subgoals_len > 0){
		for (size_t i = 0; i < g->subgoals_len; i++){
			const Goal* child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);

			CatGoalTree(data, child, depth - 1);

			if (i + 1 < g->subgoals_len){
				CatFixed(data, ",");
			}
		}
	}

	CatFixed(data, "]");

	if (g->subgoals_len == 0 && g->required_time > 3600){
		CatFixed(data, ", \"decomposition_status\":\"not yet decomposed\"");
	}

	CatFixed(data, "}");
}

// AI generated
void run5(json_value* doc, String *dynamic_mem, char* ds_id, User *user){
	if (!doc || !dynamic_mem) return;
	lazy_load();

	const char *journey_id = user->journeys[0];
	{ size_t _tmp = 0; Goal **_g = GetGoalsSorted(&_tmp, journey_id); free(_g); if (_tmp == 0){ CatFixed(dynamic_mem, "Warning, you tried to run a goal-oriented command (4,5,6), but the user currently doesn't have any goals. Please avoid commands 4,5,6."); return;} }

	goalIDType goal_id;
	int_fast64_t depth = 0;

	if (!decompose_command_5_params(doc, dynamic_mem, &goal_id, &depth)) return;

	if (depth < 1) depth = 1;
	if (depth > 5) depth = 5;

	Goal* goal = FindGoalByID(goal_id, journey_id);

	if (!goal){
		CatFixed(dynamic_mem, "Error: Goal not found.\n");
		return;
	}

	String data;
	InitString(&data, 1024);
	change_assert(data.p, "Failed to allocate memory for data.\n");

	CatFixed(&data, "Command Result: ");
	CatGoalTree(&data, goal, depth);

	ds_emit(ds_id, "cmd-5", data.p, data.len);

	CatString(dynamic_mem, data.p, data.len);
	FreeString(&data);
}

void run6(json_value* doc, String *dynamic_mem, char* ds_id, User *user){
	if (!doc || !dynamic_mem) return;
	lazy_load();

	const char *journey_id = user->journeys[0];
	{ size_t _tmp = 0; Goal **_g = GetGoalsSorted(&_tmp, journey_id); free(_g); if (_tmp == 0){ CatFixed(dynamic_mem, "Warning, you tried to run a goal-oriented command (4,5,6), but the user currently doesn't have any goals. Please avoid commands 4,5,6."); return;} }

	goalIDType goal_id;
	char method[32];
	size_t method_length = 0;

	if (!decompose_command_6_params(doc, dynamic_mem, &goal_id, &method, &method_length)) return;

	Goal* goal = FindGoalByID(goal_id, journey_id);

	if (!goal){
		CatFixed(dynamic_mem, "Error: Goal not found.\n");
		return;
	}

	String data;
	InitString(&data, 1024);
	cassert(data.p, "Failed to allocate memory for command 6 data.\n");

	CatFixed(&data, "Command Result: ");

	if (!strcmp(method, "history")){
		SerializeUserGoalHistoryUpTo(goal, &data, 100);
	}
	else if (!strcmp(method, "siblings")){
		SerializeSlibingGoals(goal, &data);
	}
	else if (!strcmp(method, "parents")){
		SerializeGoalParentChain(goal, &data);
	}
	else if (!strcmp(method, "linked-siblings")){
		SerializeGoalLinkedSlibingsChain(goal, &data, 1);
	}
	else if (!strcmp(method, "linked-siblings-hidden")){
		SerializeGoalLinkedSlibingsChain(goal, &data, 0);
	}
	else if (!strcmp(method, "uncles")){
		SerializeGoalParentSlibings(goal, &data, 1);
	}
	else if (!strcmp(method, "uncles-hidden")){
		SerializeGoalParentSlibings(goal, &data, 0);
	}
	else {
		CatFixed(&data, "Internal Error: Invalid command 6 method.\n");
	}

	ds_emit(ds_id, "cmd-6", data.p, data.len);

	CatString(dynamic_mem, data.p, data.len);
	FreeString(&data);
}

void run7(json_value* doc, String *dynamic_mem, char* ds_id, User *user){
	// call SerialzieScheduleData(String* buffer, time_t threshold time offset in seconds form now to fitler )
	if (!dynamic_mem || !doc) return;
	lazy_load();

	time_t offset_seconds;

	if (decompose_command_7_params(doc, dynamic_mem, &offset_seconds) == 0) return;

	// Allocate 35 characters per node, 32 bonus
	String data;
	InitString(&data, 2);
	change_assert(data.p, "Failed to allocate memory for data.\n");

	SerializeScheduleData(&data, offset_seconds, user);

	ds_emit(ds_id, "cmd-7", c_str(&data), data.len);

	CatString(dynamic_mem, data.p, data.len);

	FreeString(&data);
}

void run8(json_value* doc, String *dynamic_mem, char* ds_id, User *user){
	if (!dynamic_mem || !doc) return;
	lazy_load();

	char section[32];
	size_t section_length = 0;
	size_t max = 10;

	if (decompose_command_8_params(doc, dynamic_mem, &section, &section_length, &max) == 0) return;

	String data;
	InitString(&data, 1024);
	change_assert(data.p, "Failed to allocate memory for command 8 data.\n");

	SerializeUserProfileHistorySection(user, section, max, &data);

	ds_emit(ds_id, "cmd-8", c_str(&data), data.len);
	CatString(dynamic_mem, data.p, data.len);
	FreeString(&data);
}

void run9(json_value* doc, String *dynamic_mem, char* ds_id, User *user){
	if (!dynamic_mem || !doc) return;
	lazy_load();

	if (decompose_command_9_params(doc, dynamic_mem) == 0) return;

	String data;
	InitString(&data, 1024);
	change_assert(data.p, "Failed to allocate memory for command 9 data.\n");

	SerializeUserProfileDerivedSummary(user, &data);

	ds_emit(ds_id, "cmd-9", c_str(&data), data.len);
	CatString(dynamic_mem, data.p, data.len);
	FreeString(&data);
}
