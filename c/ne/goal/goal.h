#ifndef GOAL_CHANGE_HEADER
#define GOAL_CHANGE_HEADER

#include <stddef.h>
#include <time.h>
#include "util.h"
#include "goal-util.h"

typedef struct GoalProgressSnapshot {
	String title;
	time_t start_date;
	time_t end_date;
	size_t child_count;
	struct GoalProgressSnapshot **children;
} GoalProgressSnapshot;

#define GOAL_REPAIR_MAX_JUDGE_ROUNDS 4

#define OPENAI_GOAL_REPAIR_BRANCH_JUDGE_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"pass\",\"feedback\"]," \
  "\"properties\":{" \
    "\"pass\":{\"type\":\"boolean\"}," \
    "\"feedback\":{\"type\":\"string\"}" \
  "}" \
"}"

void FreeGoal(Goal *g);
void FreeGoals();
Goal* CreateUserGoal(String *input1, String *input2, const char *journey_id, start_ds_session_like_func* start_ds_session, User *user);
Goal* RepairGoalBranch(Goal *old_branch, String *reason, start_ds_session_like_func *start_ds_session, User *user);

void InitGoalSystem();
_Bool DecomposeGoal(Goal *g, User *user);
Goal* DecomposeToLeaf(Goal *g, User *user);

void UpdateGoal(Goal *g, time_t now);
Goal* ComputePartialDecomposition(Goal *goal, User *user);

time_t StartGoal(goalIDType goalID, User *user);
void DropGoalTree(Goal *root, User *user);
Goal*  StartGoalDeep(goalIDType goalID, User *user);
Goal*  StartGoalDeepFromGoal(Goal *g, User *user);
time_t EndGoal(goalIDType goalID, User *user);
time_t EndGoalFromGoal(Goal *g, User *user);

Goal** GetSessionGoals(size_t *out_len, User *user);

#endif
