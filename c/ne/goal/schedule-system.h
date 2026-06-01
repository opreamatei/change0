#ifndef SCHEDULE_FUNCTIONALITY
#define SCHEDULE_FUNCTIONALITY

#include <stddef.h>
#include <time.h>
#include "util.h"

typedef struct UserType User;

struct ScheduleEntry {
	time_t time;        /* absolute wall-clock start of this work session */
	time_t duration;    /* required_time of the goal, in seconds */
	size_t goalIndex;
	char journey_id[33];
};

void RefreshSchedule(User *user);
const struct ScheduleEntry* GetSchedule(size_t *out_len, User *user);
void SerializeScheduleData(String *buffer, time_t threshold, User *user);

#endif
