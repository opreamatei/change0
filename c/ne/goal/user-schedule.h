#ifndef SCHEDULE_FUNCTIONALITY
#define SCHEDULE_FUNCTIONALITY

#include <stddef.h>
#include <time.h>
#include "util.h"

struct ScheduleEntry {
	time_t time;
	size_t goalIndex;
	char journey_id[33];
};

extern _Bool SCHEDULE_NEEDS_REFRESH;

void RefreshSchedule(const char *journey_id);
const struct ScheduleEntry* GetSchedule(size_t *out_len, const char *journey_id);
void SerializeScheduleData(String *buffer, time_t threshold, const char *journey_id);

#endif
