#include "goal-info.h"
#include <stdlib.h>
#include <string.h>

char* SerializeGoal(Goal* g, size_t *length, char* relation, _Bool showExtraInfo){
	*length = sizeof(OTHER_GOAL_TEMPLATE_RICH) + g->extra_info.len + g->title.len + 512;

	char* main_buffer = malloc(*length);
	cassert(main_buffer, "Coudln't malloc mem for main buffer\n");

	char end_time_buffer[128];
	size_t temp_len = sprintf(end_time_buffer, "%s", g->end_date == 0 ? "goal is not finished" : change_ctime(&g->end_date));
	cassert(temp_len < 128, "Buffer too small 0\n");

	char start_time_buffer[128];
	temp_len = sprintf(start_time_buffer, "%s", g->start_date == 0 ? "goal is not started" : change_ctime(&g->start_date));
	cassert(temp_len < 128, "Buffer too small 0\n");

	end_time_buffer[strcspn(end_time_buffer, "\n")] = '\0';
	start_time_buffer[strcspn(start_time_buffer, "\n")] = '\0';

	char completion_metrics_buffer[256] = "\0";
	const size_t req_time = CalcGoalRequiredTime(g);
	_Bool can_display_efficiency = g->start_date != 0 && g->end_date != 0 && g->start_date != g->end_date && req_time;

	if (can_display_efficiency){
		size_t difference = (g->end_date - g->start_date);
		double efficiency = (double)req_time / (double)(g->end_date - g->start_date) * 100.0;
		temp_len = sprintf(completion_metrics_buffer, "Actual duration: about %zu seconds, Time efficiency: %.2f%%", difference, efficiency);
		change_assert(temp_len < 256, "Buffer too small 0\n");
	}
	
	int actual_len = -1; // this should give overflow and max value
	if (can_display_efficiency)
		actual_len = snprintf(main_buffer, *length, OTHER_GOAL_TEMPLATE_RICH, relation, g->title.p, showExtraInfo ? g->extra_info.p : "[hidden]", g->depth, req_time, start_time_buffer, end_time_buffer, completion_metrics_buffer);
	else
		actual_len = snprintf(main_buffer, *length, OTHER_GOAL_TEMPLATE, relation, g->title.p, showExtraInfo ? g->extra_info.p : "[hidden]", g->depth, req_time, start_time_buffer, end_time_buffer);

	change_assert(actual_len >= 0, "Failed to calc an actual len [%d]", actual_len);
	change_assert(actual_len < *length, "You calculated the max len wrong. max [%zu] and actual [%d]\n", *length, actual_len);

	*length = actual_len;

	return main_buffer;
}

void SerializeUserGoalHistory(String *buffer, size_t max){

	size_t i = 0;

	for (size_t currentIndex = GOAL_CONTAINER_COUNT;
			currentIndex-- > INITIAL_GOAL_INDEX && i < max;){

		Goal *g = FindGoalFromIndex(currentIndex);

		if (!g) continue;

		if (g->start_date != 0){

			size_t register_len_size = 0;

			char* info = SerializeGoal(
					g,
					&register_len_size,
					"example-goal",
					1
					);

			cassert(info, "Something failed when providing goal info.\n");

			CatString(buffer, info, register_len_size);

			free(info);

			i++;
		}
	}
}
 
void SerializeUserGoalHistoryUpTo(Goal* g, String *buffer, int max){

	size_t currentIndex = g->globalIndex - 1;
	int i = 0;

	for (size_t currentIndex = g->globalIndex;
			currentIndex-- > INITIAL_GOAL_INDEX && i < max;){
		Goal *g = FindGoalFromIndex(currentIndex);
		if (!g) continue;

		if (g->start_date != 0){
			size_t register_len_size = 0;
			char* info = SerializeGoal(g, &register_len_size, "example-goal", 1);
			cassert(info, "Something failed when provdiing info.\n");
			CatString(buffer, info, register_len_size);
			free(info);
			i++;
		}

		currentIndex --;
	}
}

void SerializeSlibingGoals(Goal *g, String *buffer){
	if (g->parent == 0) {
		CatString(buffer, FSTRING_SIZE_PARAMS("Root goal has no same-layer siblings.\n"));
		return;
	}

	Goal* parent = FindGoalFromIndex(g->parent);

	for (size_t i = 0; i < parent->subgoals_len; i++){
		Goal *slibing = FindGoalFromIndex(parent->subgoals[i]);

		size_t len = 0;
		char* info = SerializeGoal(slibing, &len, "brother-goal", 1);
		CatString(buffer, info, len);

		free(info);
	}
}

void SerializeGoalParentChain(Goal *g, String *buffer){
	
	while (g->parent != 0){
		g = FindGoalFromIndex(g->parent);

		size_t len;
		char* info = SerializeGoal(g, &len, "parent-goal", 1);

		CatString(buffer, info, len);

		free(info);
	}
}

void SerializeGoalLinkedSlibingsChain(Goal *g, String *buffer, _Bool displayInfo){
	
	CatString(buffer, FSTRING_SIZE_PARAMS("Follow-up goals: \n"));
	Goal* original = g;

	while (g->next != 0){
		g = FindGoalFromIndex(g->next);

		size_t len;
		char* info = SerializeGoal(g, &len, "follow-up-goal", displayInfo);

		CatString(buffer, info, len);

		free(info);
	}

	g = original;
	CatString(buffer, FSTRING_SIZE_PARAMS("\n\nPrevious goals: \n"));
	while (g->prev != 0){
		g = FindGoalFromIndex(g->prev);

		size_t len;
		char* info = SerializeGoal(g, &len, "prev-goal", displayInfo);

		CatString(buffer, info, len);

		free(info);
	}
}

void SerializeGoalParentSlibings(Goal *g, String *buffer, _Bool displayInfo){
	if (g->parent == 0){
		CatString(buffer, FSTRING_SIZE_PARAMS("Root goal has no uncle because it's a root goal."));
		return;
	}
	Goal* parent = FindGoalFromIndex(g->parent);
	if (parent == 0){
		CatString(buffer, FSTRING_SIZE_PARAMS("This is a root goal, it doesn't have any uncles."));
		return;
	}

	CatString(buffer, FSTRING_SIZE_PARAMS("Uncles divided by follow up and previous relative to parent goal:\n"));

	SerializeGoalLinkedSlibingsChain(parent, buffer, displayInfo);
}

// AI Generated
void SerializeDueGoals(String *buffer, size_t max){

	size_t emitted = 0;

	for (size_t currentIndex = GOAL_CONTAINER_COUNT;
			currentIndex-- > INITIAL_GOAL_INDEX && emitted < max;){

		Goal *g = FindGoalFromIndex(currentIndex);

		if (!g) continue;

		// due / unfinished goals only
		if (g->end_date == 0){

			size_t len = 0;

			char* info = SerializeGoal(
					g,
					&len,
					"due-goal",
					1
					);

			cassert(info, "Something failed when serializing due goal.\n");

			CatString(buffer, info, len);

			free(info);

			emitted++;
		}
	}
}

void SerializeLeafDueGoals(String *buffer, size_t max){

	size_t emitted = 0;

	for (size_t currentIndex = GOAL_CONTAINER_COUNT;
			currentIndex-- > INITIAL_GOAL_INDEX && emitted < max;){

		Goal *g = FindGoalFromIndex(currentIndex);

		if (!g) continue;

		// due / unfinished goals only
		if (g->end_date == 0){

			size_t len = 0;

			char* info = SerializeGoal(
					g,
					&len,
					"due-goal",
					1
					);

			cassert(info, "Something failed when serializing due goal.\n");

			CatString(buffer, info, len);

			free(info);

			emitted++;
		}
	}
}
