#ifndef CHANGE_TIME_UTIL_H
#define CHANGE_TIME_UTIL_H

#include <time.h>

time_t change_time_now(void);
time_t change_time_get_offset_seconds(void);
time_t change_time_advance_seconds(time_t delta_seconds);
void change_time_reset(void);
char *change_ctime(const time_t *value);
/* Writes a human-readable label into buf (size >= 64): "Today at 09:00", "Tomorrow at 14:30", "Mon 26 May at 09:00". */
void format_time_human(time_t t, char *buf, size_t buf_size);

#endif
