#ifndef GOAL_UTIL_DECLARATIONS
#define GOAL_UTIL_DECLARATIONS

#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include <string.h>
#include "config.h"
#include "node.h"
#include "util.h"
#include "globals.h"

/* Forward declaration — callers that need the full struct include user-management.h directly. */
typedef struct UserType User;

#define GOAL_REQUIRED_TIME_ERROR_MARGIN 0.5
#define INITIAL_GOAL_INDEX 1 /* must be > 0 */
#define GOAL_ID_SIZE 32
#define GOAL_MIN_SECONDS 60 * 16

typedef _Bool (*goal_emit_like_func)(const char* id, const char *type, const char *buffer, size_t buffer_len);
typedef const char* (*journey_str_func)(const char *id);
typedef char goalIDType[GOAL_ID_SIZE + 1];
typedef void (start_ds_session_like_func)(Task *task, char* id, String* out, User *user);

typedef struct GoalType {
	String title;
	String extra_info;

	time_t start_date;
	time_t end_date;
	time_t required_time;

	size_t *subgoals;
	size_t subgoals_len;

	size_t parent;
	size_t prev;
	size_t next;

	time_t minPauseToNext;
	time_t pauseToNext;

	size_t localIndex;
	size_t depth;
	size_t retry_depth;

	size_t priority;

	goalIDType id;
	char journey_id[33]; /* ID of the journey this root goal belongs to; empty for sub-goals */

	/*
	 * Shared-journey leaf ownership. JOURNEY_USER_UNASSIGNED (0xFF) means
	 * either "non-leaf" or "leaf produced before assignment ran". Any other
	 * value is an index into the parent Journey's `users` table. Solo
	 * journeys leave this at JOURNEY_USER_UNASSIGNED — the leaf filter
	 * treats unassigned leaves as belonging to the solo user.
	 */
	uint8_t assigned_to;
} Goal;

/* Second param changed from string goal_id to Goal* so callers pass the pointer directly. */
typedef void (*journey_add_root_func)(const char *journey_id, Goal *g);

enum GOAL_STATUS {
	GOAL_VALID=0,
	GOAL_INVALID
};

static inline void link_goals(Goal *a, Goal *b) {
	a->next = b->localIndex;
	b->prev = a->localIndex;
}

static void create_goal_task(String* input1, String* input2, String *feedback, Task *task, const char *journey_title, const char *journey_info){
	size_t feedback_len = feedback ? feedback->len : 0;
	size_t jt_len = journey_title ? strlen(journey_title) : 0;
	size_t ji_len = journey_info  ? strlen(journey_info)  : 0;
	ResizeString(&task->name, sizeof(GOAL_ADAPTATION_PROMPT) + jt_len + ji_len + input1->len + input2->len + feedback_len + 32);
	size_t new_len = sprintf(
		c_str(&task->name),
		GOAL_ADAPTATION_PROMPT,
		journey_title ? journey_title : DEFAULT_JOURNEY_TITLE,
		journey_info  ? journey_info  : DEFAULT_JOURNEY_EXTRA_INFO,
		c_str(input1),
		c_str(input2),
		feedback ? c_str(feedback) : ""
	);
	cassert(new_len < task->name.cap, "This should be impossible...\n");

	task->name.len = new_len;

	task->minDepth = 1;
}

/* Implemented in journey.c; declared here so goal files can use without a circular include. */
Goal *FindGoalFromIndex(const char *journey_id, size_t index);
Goal **GetGoalsSorted(size_t *out_count, const char *journey_id);
void ClearAllJourneyGoals(void);
void RemoveGoalFromJourneys(Goal *g);

void GoalSystemLazyLoad(goal_emit_like_func *goal_emit);
void JourneySystemLazyLoad(journey_str_func *title, journey_str_func *info);
void CreateSubgoalId(Goal *parent, size_t child_index, char out[33]);
Goal *CreateGoal(char goalId[], String *input_goal, String *input_extrainfo, size_t estimated_time, size_t parent_index, size_t depth, const char *journey_id);

time_t CalcGoalRequiredTime(Goal *g);
enum GOAL_STATUS ValidateGoal(Goal *g, time_t now);
void CreateGoalDSId(char* name, char* deep_search_id);
void PersonalizeGoal(String* input1, String *input2, String* out, char* goalId, String *feedback, start_ds_session_like_func start_ds_session, const char *journey_id, User *user);

Goal *CalcGoalRoot(Goal *g);
Goal *FindGoalByID(goalIDType id, const char *journey_id);
void SerializeGoalList(Goal **goals, size_t count, String *buffer);
void SerializeAllGoals(String *buffer, const char *journey_id);

/*
 * Returns the due goals for a journey. In solo journeys, behavior is
 * unchanged (every due goal is returned).
 *
 * In shared journeys, `user_id` filters to only those due goals assigned
 * to that participant. Pass NULL for `user_id` to opt out of the filter
 * (used by tooling that needs the global view, e.g. central-server export).
 *
 * The function asserts when a user_id is supplied for a shared journey
 * that does not list that user as a participant — silent fallthrough
 * would mask data-model bugs.
 */
Goal** GetLeafDueGoals(size_t *size, const char *journey_id, const char *user_id);

#endif
