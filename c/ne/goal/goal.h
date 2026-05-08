#ifndef GOAL_CHANGE_HEADER
#define GOAL_CHANGE_HEADER

#include <stddef.h>
#include <time.h>
#include "util.h"
#include "goal-util.h"

void FreeGoal(Goal *g);
void FreeGoals();
Goal* CreateUserGoal(String *input1, String *input2, goalIDType goalID);

void InitGoalSystem();
_Bool DecomposeGoal(Goal *g);

void UpdateGoal(Goal *g, time_t now);
Goal* ComputePartialDecomposition(Goal *goal);


#endif
