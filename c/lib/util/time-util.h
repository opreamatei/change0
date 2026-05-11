#ifndef CHANGE_TIME_UTIL_H
#define CHANGE_TIME_UTIL_H

#include <time.h>

time_t change_time_now(void);
time_t change_time_get_offset_seconds(void);
time_t change_time_advance_seconds(time_t delta_seconds);
void change_time_reset(void);
char *change_ctime(const time_t *value);

#endif
