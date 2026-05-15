#include "user-schedule.h"
#include "goal-info.h"
#include "goal-util.h"

#include <stdlib.h>
#include <string.h>

static struct ScheduleEntry* SCHEDULE_TABLE = NULL;
static size_t SCHEDULE_TABLE_LEN = 0;

_Bool SCHEDULE_NEEDS_REFRESH = 1;

static Goal *first_leaf(Goal *g) {
	while (g->subgoals_len > 0) {
		g = FindGoalFromIndex(g->subgoals[0]);
		change_assert(g, "Broken subgoal reference while finding first leaf.\n");
	}

	return g;
}

static Goal *next_leaf(Goal *g) {
	while (1) {
		if (g->next != 0) {
			g = FindGoalFromIndex(g->next);
			change_assert(g, "Broken next reference while refreshing schedule.\n");

			return first_leaf(g);
		}

		if (g->parent == 0)
			return NULL;

		// if no slibing, go to parent
		g = FindGoalFromIndex(g->parent);
		change_assert(g, "Broken parent reference while refreshing schedule.\n");
	}
}

void RefreshSchedule() {
	if (SCHEDULE_TABLE) {
		free(SCHEDULE_TABLE);
		SCHEDULE_TABLE = NULL;
	}

	SCHEDULE_TABLE_LEN = 0;

	size_t due_len = 0;
	Goal **due = GetLeafDueGoals(&due_len);

	if (due_len == 0) {
		SCHEDULE_NEEDS_REFRESH = 0;
		return;
	}

	size_t schedule_len = 0;

	for (size_t i = 0; i < due_len; i++) {
		Goal *g = due[i];

		while (g) {
			schedule_len++;
			g = next_leaf(g);
		}
	}

	SCHEDULE_TABLE = malloc(schedule_len * sizeof(struct ScheduleEntry));
	change_assert(SCHEDULE_TABLE, "Couldn't allocate schedule table.\n");

	for (size_t i = 0; i < due_len; i++) {
		Goal *g = due[i];

		time_t start_time;

		if (g->start_date) {
			start_time = g->start_date;
		} else {
			Goal *prev = FindGoalFromIndex(g->prev);
			change_assert(prev, "Due goal [%zu] has broken prev reference [%zu].\n", g->globalIndex, g->prev);

			start_time = prev->end_date + prev->pauseToNext;
		}

		// TODO make sure you come back to understand this deeply
		while (g) {
			SCHEDULE_TABLE[SCHEDULE_TABLE_LEN].time = start_time;
			SCHEDULE_TABLE[SCHEDULE_TABLE_LEN].goalIndex = g->globalIndex;
			SCHEDULE_TABLE_LEN++;

			time_t supposed_end_time = start_time + CalcGoalRequiredTime(g);
			start_time = supposed_end_time + g->pauseToNext;

			g = next_leaf(g);
		}
	}

	if (due) {
		free(due);
	}

	SCHEDULE_NEEDS_REFRESH = 0;
}

const struct ScheduleEntry* GetSchedule(size_t *out_len) {
	if (SCHEDULE_NEEDS_REFRESH)
		RefreshSchedule();
	*out_len = SCHEDULE_TABLE_LEN;
	return SCHEDULE_TABLE;
}

// The threshold in second filters goals from x seconds away
void SerializeScheduleData(String *buffer, time_t threshold){
	time_t absolute_time = change_time_now() + threshold;
	char absolute_time_buf[128];
	snprintf(absolute_time_buf, sizeof(absolute_time_buf), "%s", ctime(&absolute_time));
	absolute_time_buf[strcspn(absolute_time_buf, "\n")] = '\0';

	CatTemplateString(buffer, "USER SCHEDULE REPORT, starting at or after %s:\n\n[", absolute_time_buf);

	size_t schedule_len = 0;
	const struct ScheduleEntry *schedule_data = GetSchedule(&schedule_len);

	time_t day_work_end = absolute_time + 60 * 60 * 24;
	time_t week_work_end = absolute_time + 60 * 60 * 24 * 7;

	time_t day_work_hours = 0;
	time_t week_work_hours = 0;
	char day_work_end_buf[128];
	char week_work_end_buf[128];

	for (size_t i = 0; i < schedule_len; i++){
		const struct ScheduleEntry event = schedule_data[i];

		if (event.time < absolute_time) continue;

		Goal* goal = FindGoalFromIndex(event.goalIndex);
		change_assert(goal, "Found event entry with invalid goal.\n");

			time_t req_time = CalcGoalRequiredTime(goal);

			if (goal->subgoals_len == 0 && event.time >= absolute_time && event.time < day_work_end){
				day_work_hours += CalcGoalRequiredTime(goal);
			}

			if (goal->subgoals_len == 0 && event.time >= absolute_time && event.time < week_work_end){
				week_work_hours += CalcGoalRequiredTime(goal);
			}
	}

	snprintf(day_work_end_buf, sizeof(day_work_end_buf), "%s", ctime(&day_work_end));
	snprintf(week_work_end_buf, sizeof(week_work_end_buf), "%s", ctime(&week_work_end));
	day_work_end_buf[strcspn(day_work_end_buf, "\n")] = '\0';
	week_work_end_buf[strcspn(week_work_end_buf, "\n")] = '\0';

	CatTemplateString(buffer, "Total work time relative (finish and unfisnihed included):\n-Work to do untill %s : %zu\n-Work to do untill %s : %zu\n\n Schedule detailed: \n",
					day_work_end_buf, day_work_hours, week_work_end_buf, week_work_hours
				);

	_Bool first = 1;
	for (size_t i = 0; i < schedule_len; i++){
		const struct ScheduleEntry event = schedule_data[i];

		if (event.time < absolute_time) continue;

		Goal* goal = FindGoalFromIndex(event.goalIndex);
		change_assert(goal, "Found event entry with invalid goal.\n");

			size_t l;
			char* serialized_info = SerializeGoal(goal, &l, "goal-info", 0);
			char* esc_goal_info = json_escape_dup(serialized_info);
			char event_time_buf[128];

			snprintf(event_time_buf, sizeof(event_time_buf), "%s", ctime(&event.time));
			event_time_buf[strcspn(event_time_buf, "\n")] = '\0';

			if (!first) CatFixed(buffer, ",");
			CatTemplateString(buffer, "{\"date\":\"%s\",\"goal_info\":\"%s\"}", event_time_buf, esc_goal_info);
			first = 0;

			free(esc_goal_info);
			free(serialized_info);
	}
	CatFixed(buffer, "]");
}
