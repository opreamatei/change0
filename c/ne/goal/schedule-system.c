#include "schedule-system.h"
#include "goal-health.h"
#include "goal-info.h"
#include "goal-util.h"
#include "srv/user/user-management.h"
#include "lib/util/time-util.h"

#include <stdlib.h>
#include <string.h>

static Goal *first_leaf(Goal *g) {
	while (g->subgoals_len > 0) {
		g = FindGoalFromIndex(g->journey_id, g->subgoals[0]);
		change_assert(g, "Broken subgoal reference while finding first leaf.\n");
	}

	return g;
}

static Goal *next_leaf(Goal *g) {
	while (1) {
		if (g->next != 0) {
			g = FindGoalFromIndex(g->journey_id, g->next);
			change_assert(g, "Broken next reference while refreshing schedule.\n");

			return first_leaf(g);
		}

		if (g->parent == 0)
			return NULL;

		g = FindGoalFromIndex(g->journey_id, g->parent);
		change_assert(g, "Broken parent reference while refreshing schedule.\n");
	}
}

void RefreshSchedule(User *user) {
	RunGoalHealthCheck(user);

	if (user->schedule_table) {
		free(user->schedule_table);
		user->schedule_table = NULL;
	}

	user->schedule_len = 0;

	size_t total_due = 0;
	Goal **all_due = NULL;

	for (size_t ji = 0; ji < user->journey_count; ji++) {
		size_t due_len = 0;
		Goal **due = GetLeafDueGoals(&due_len, user->journeys[ji], user->id);
		if (due_len == 0) { free(due); continue; }

		all_due = realloc(all_due, (total_due + due_len) * sizeof(Goal *));
		change_assert(all_due, "Couldn't allocate due goals buffer.\n");
		for (size_t i = 0; i < due_len; i++)
			all_due[total_due++] = due[i];
		free(due);
	}

	if (total_due == 0) {
		user->schedule_needs_refresh = 0;
		return;
	}

	size_t schedule_len = 0;
	for (size_t i = 0; i < total_due; i++) {
		Goal *g = all_due[i];
		while (g) { schedule_len++; g = next_leaf(g); }
	}

	user->schedule_table = malloc(schedule_len * sizeof(struct ScheduleEntry));
	change_assert(user->schedule_table, "Couldn't allocate schedule table.\n");

	for (size_t i = 0; i < total_due; i++) {
		Goal *g = all_due[i];

		/* Skip if already covered by an earlier chain walk in all_due */
		_Bool covered = 0;
		for (size_t s = 0; s < user->schedule_len; s++) {
			if (user->schedule_table[s].goalIndex == g->localIndex &&
				strcmp(user->schedule_table[s].journey_id, g->journey_id) == 0) {
				covered = 1;
				break;
			}
		}
		if (covered) continue;

		time_t start_time;
		if (g->start_date && g->end_date) {
			/*
			 * GetLeafDueGoals returned a finished goal because its immediate
			 * next sibling is pending.  Don't re-schedule the finished goal —
			 * jump straight to the next leaf and use the actual end time as
			 * the base for the rest of the chain.
			 */
			start_time = g->end_date + g->pauseToNext;
			g = next_leaf(g);
			if (!g) continue;
		} else if (g->start_date) {
			/* Active (started, not yet ended). */
			start_time = g->start_date;
		} else if (g->prev == 0) {
			/*
			 * Fresh chain: no previous leaf, nothing started.
			 * Anchor to the current time; pauseToNext values on subsequent
			 * goals (set by RunGoalHealthCheck) encode the correct gaps.
			 */
			start_time = change_time_now();
		} else {
			/* Not started yet — use the previous leaf's end date. */
			Goal *prev = FindGoalFromIndex(g->journey_id, g->prev);
			change_assert(prev, "Due goal [%zu] has broken prev reference [%zu].\n", g->localIndex, g->prev);
			start_time = prev->end_date + prev->pauseToNext;
		}

		while (g) {
			user->schedule_table[user->schedule_len].time = start_time;
			user->schedule_table[user->schedule_len].goalIndex = g->localIndex;
			strncpy(user->schedule_table[user->schedule_len].journey_id, g->journey_id, 32);
			user->schedule_table[user->schedule_len].journey_id[32] = '\0';
			user->schedule_len++;

			time_t supposed_end_time = start_time + CalcGoalRequiredTime(g);
			start_time = supposed_end_time + g->pauseToNext;

			g = next_leaf(g);
		}
	}

	free(all_due);
	user->schedule_needs_refresh = 0;
}

const struct ScheduleEntry* GetSchedule(size_t *out_len, User *user) {
	if (user->schedule_needs_refresh)
		RefreshSchedule(user);
	*out_len = user->schedule_len;
	return user->schedule_table;
}

// The threshold in second filters goals from x seconds away
void SerializeScheduleData(String *buffer, time_t threshold, User *user){
	time_t absolute_time = change_time_now() + threshold;
	char absolute_time_buf[128];
	format_time_human(absolute_time, absolute_time_buf, sizeof(absolute_time_buf));

	CatTemplateString(buffer, "USER SCHEDULE REPORT, starting at or after %s:\n\n[", absolute_time_buf);

	size_t schedule_len = 0;
	const struct ScheduleEntry *schedule_data = GetSchedule(&schedule_len, user);

	time_t day_work_end = absolute_time + 60 * 60 * 24;
	time_t week_work_end = absolute_time + 60 * 60 * 24 * 7;

	time_t day_work_hours = 0;
	time_t week_work_hours = 0;
	char day_work_end_buf[128];
	char week_work_end_buf[128];

	for (size_t i = 0; i < schedule_len; i++){
		const struct ScheduleEntry event = schedule_data[i];

		if (event.time < absolute_time) continue;

		Goal* goal = FindGoalFromIndex(event.journey_id, event.goalIndex);
		change_assert(goal, "Found event entry with invalid goal.\n");

			if (goal->subgoals_len == 0 && event.time >= absolute_time && event.time < day_work_end)
				day_work_hours += CalcGoalRequiredTime(goal);

			if (goal->subgoals_len == 0 && event.time >= absolute_time && event.time < week_work_end)
				week_work_hours += CalcGoalRequiredTime(goal);
	}

	format_time_human(day_work_end, day_work_end_buf, sizeof(day_work_end_buf));
	format_time_human(week_work_end, week_work_end_buf, sizeof(week_work_end_buf));

	CatTemplateString(buffer, "Total work time relative (finish and unfisnihed included):\n-Work to do untill %s : %zu\n-Work to do untill %s : %zu\n\n Schedule detailed: \n",
					day_work_end_buf, day_work_hours, week_work_end_buf, week_work_hours
				);

	_Bool first = 1;
	for (size_t i = 0; i < schedule_len; i++){
		const struct ScheduleEntry event = schedule_data[i];

		if (event.time < absolute_time) continue;

		Goal* goal = FindGoalFromIndex(event.journey_id, event.goalIndex);
		change_assert(goal, "Found event entry with invalid goal.\n");

			size_t l;
			char* serialized_info = SerializeGoal(goal, &l, "goal-info", 0);
			char* esc_goal_info = json_escape_dup(serialized_info);
			char event_time_buf[128];

			format_time_human(event.time, event_time_buf, sizeof(event_time_buf));

			if (!first) CatFixed(buffer, ",");
			CatTemplateString(buffer, "{\"date\":\"%s\",\"goal_info\":\"%s\"}", event_time_buf, esc_goal_info);
			first = 0;

			free(esc_goal_info);
			free(serialized_info);
	}
	CatFixed(buffer, "]");
}
