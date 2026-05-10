#ifndef GOAL_UTIL_DECLARATIONS
#define GOAL_UTIL_DECLARATIONS

#include <stddef.h>
#include <time.h>
#include "config.h"
#include "node.h"
#include "util.h"

#define GOAL_REQUIRED_TIME_ERROR_MARGIN 0.5
#define INITIAL_GOAL_INDEX 1 // must be > 0
#define GOAL_ID_SIZE 32
#define GOAL_MIN_SECONDS 60 * 16

typedef _Bool (*goal_emit_like_func)(const char* id, const char *type, const char *buffer, size_t buffer_len);

typedef char goalIDType[GOAL_ID_SIZE + 1];

typedef void (start_ds_session_like_func)(Task *task, char* id, String* out);

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
	
	size_t globalIndex;
	size_t depth;
	size_t retry_depth;

	size_t priority;

	goalIDType id;
} Goal;

enum GOAL_STATUS {
	GOAL_VALID=0,
	GOAL_INVALID
};

extern Goal *GOAL_CONTAINER[1024];
extern size_t GOAL_CONTAINER_COUNT;

static inline Goal *FindGoalFromIndex(size_t index)
{
    if (index == 0 || index >= GOAL_CONTAINER_COUNT)
        return NULL;

    return GOAL_CONTAINER[index];
}

static inline void link_goals(Goal* a, Goal* b){
	a->next = b->globalIndex;
	b->prev = a->globalIndex;
}

static void create_goal_task(String* input1, String* input2, String *feedback, Task *task){
	size_t feedback_len = feedback ? feedback->len : 0;
	ResizeString(&task->name, sizeof(GOAL_ADAPTATION_PROMPT) + input1->len + input2->len + feedback_len + 32);
	size_t new_len = sprintf(
		c_str(&task->name),
		GOAL_ADAPTATION_PROMPT,
		c_str(input1),
		c_str(input2),
		feedback ? c_str(feedback) : ""
	);
	cassert(new_len < task->name.cap, "This should be impossible...\n");

	task->name.len = new_len;
		
	task->minDepth = 1;
} 

void GoalSystemLazyLoad(goal_emit_like_func *goal_emit);
void CreateSubgoalId(Goal *parent, size_t child_index, char out[33]);
Goal *CreateGoal(char goalId[], String *input_goal, String *input_extrainfo, size_t estimated_time, size_t parent_index, size_t depth);
Goal *ExternalFindGoal(size_t id);

time_t CalcGoalRequiredTime(Goal *g);
enum GOAL_STATUS ValidateGoal(Goal *g, time_t now);
void CreateGoalDSId(char* name, char* deep_search_id);
void PersonalizeGoal(String* input1, String *input2, String* out, char* goalId, String *feedback, start_ds_session_like_func start_ds_session);

Goal **GetGoalsContainer(size_t *len);
Goal *CalcGoalRoot(Goal *g);
Goal *FindGoalByID(goalIDType id);
void SerializeAllGoals(String *buffer);
void ExportGoalsTo(char* path);
void LoadGoalsFromFile(char* path);

time_t StartGoal(goalIDType goalID);
time_t EndGoal(goalIDType goalID);

#endif
