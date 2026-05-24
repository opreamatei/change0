#ifndef GOAL_HEALTH_H
#define GOAL_HEALTH_H

#include "goal-util.h"

/*
 * Adjusts pauseToNext on pending leaf goals so they land inside the user's
 * configured work block. Roots are processed in priority order (5 = highest).
 * pauseToNext is only ever increased, never shortened.
 * Saves the user if any changes were made.
 */
void RunGoalHealthCheck(User *user);

#endif
