#include "time-util.h"
#include <stdio.h>

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

void format_time_human(time_t t, char *buf, size_t buf_size)
{
    time_t now = change_time_now();
    struct tm *tm_t = localtime(&t);
    int t_day   = tm_t->tm_yday;
    int t_year  = tm_t->tm_year;
    char hhmm[8];
    strftime(hhmm, sizeof(hhmm), "%H:%M", tm_t);

    struct tm *tm_now = localtime(&now);
    int now_day  = tm_now->tm_yday;
    int now_year = tm_now->tm_year;

    if (t_year == now_year && t_day == now_day) {
        snprintf(buf, buf_size, "today at %s", hhmm);
    } else if (t_year == now_year && t_day == now_day + 1) {
        snprintf(buf, buf_size, "tomorrow at %s", hhmm);
    } else {
        char dayname[8], month[8];
        strftime(dayname, sizeof(dayname), "%a", tm_t);
        strftime(month, sizeof(month), "%b", tm_t);
        snprintf(buf, buf_size, "%s %d %s at %s", dayname, tm_t->tm_mday, month, hhmm);
    }
}
