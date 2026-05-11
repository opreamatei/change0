#include "user-schedule.h"
#include "goal-util.h"

#include <stdlib.h>

static struct ScheduleEntry* SCHEDULE_TABLE = NULL;
static size_t SCHEDULE_TABLE_LEN = 0;

_Bool SCHEDULE_NEEDS_REFRESH = 1;

static Goal *FirstLeaf(Goal *g) {
	while (g->subgoals_len > 0) {
		g = FindGoalFromIndex(g->subgoals[0]);
		change_assert(g, "Broken subgoal reference while finding first leaf.\n");
	}

	return g;
}

static Goal *NextTimelineLeaf(Goal *g) {
	while (1) {
		if (g->next != 0) {
			g = FindGoalFromIndex(g->next);
			change_assert(g, "Broken next reference while refreshing schedule.\n");

			return FirstLeaf(g);
		}

		if (g->parent == 0)
			return NULL;

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
			g = NextTimelineLeaf(g);
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

		while (g) {
			SCHEDULE_TABLE[SCHEDULE_TABLE_LEN].time = start_time;
			SCHEDULE_TABLE[SCHEDULE_TABLE_LEN].goal_id = g->globalIndex;
			SCHEDULE_TABLE_LEN++;

			time_t supposed_end_time = start_time + CalcGoalRequiredTime(g);
			start_time = supposed_end_time + g->pauseToNext;

			g = NextTimelineLeaf(g);
		}
	}

	if (due) {
		free(due);
	}

	SCHEDULE_NEEDS_REFRESH = 0;
}
