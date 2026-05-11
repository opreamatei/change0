#ifndef SCHEDULE_FUNCTIONALITY
#define SCHEDULE_FUNCTIONALITY

#include <stddef.h>
#include <time.h>

struct ScheduleEntry {
	time_t time;
	size_t goal_id;
};

extern _Bool SCHEDULE_NEEDS_REFRESH;

void RefreshSchedule();

#endif
