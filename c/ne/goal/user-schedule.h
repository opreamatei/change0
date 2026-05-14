#ifndef SCHEDULE_FUNCTIONALITY
#define SCHEDULE_FUNCTIONALITY

#include <stddef.h>
#include <time.h>
#include "util.h"

struct ScheduleEntry {
	time_t time;
	size_t goalIndex;
};

extern _Bool SCHEDULE_NEEDS_REFRESH;

void RefreshSchedule();
const struct ScheduleEntry* GetSchedule(size_t *out_len);
void SerializeScheduleData(String *buffer, time_t threshold);

#endif
