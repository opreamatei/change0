#include "time-util.h"

static time_t CHANGE_TIME_OFFSET_SECONDS = 0;

time_t change_time_now(void) {
    return time(NULL) + CHANGE_TIME_OFFSET_SECONDS;
}

time_t change_time_get_offset_seconds(void) {
    return CHANGE_TIME_OFFSET_SECONDS;
}

time_t change_time_advance_seconds(time_t delta_seconds) {
    CHANGE_TIME_OFFSET_SECONDS += delta_seconds;
    return change_time_now();
}

void change_time_reset(void) {
    CHANGE_TIME_OFFSET_SECONDS = 0;
}

char *change_ctime(const time_t *value) {
    return ctime(value);
}
