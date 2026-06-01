#include "goal-health.h"
#include "srv/user/user-management.h"

/*
 * RETIRED.
 *
 * This used to adjust pauseToNext on pending leaves to pack them into the user's
 * work block. That overloaded pauseToNext (which also feeds CalcGoalRequiredTime,
 * so inflating it to cross a day ballooned a goal's estimated time), only ever
 * grew the pause (so the schedule rotted and never tightened back up), and
 * mutated persisted goal data on every recompute.
 *
 * Calendar placement now lives entirely in RefreshSchedule (schedule-system.c),
 * computed at read-time into the schedule table — pauseToNext stays the small
 * intrinsic rest between sessions. This is kept as a no-op so the dirty flag and
 * its existing setters remain harmless.
 */
void RunGoalHealthCheck(User *user)
{
	if (!user) return;
	user->goal_health_needs_refresh = 0;
}
