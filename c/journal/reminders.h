#ifndef REMINDERS_H
#define REMINDERS_H

#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include "user-management.h"

#define REMINDER_ID_SIZE    32
#define REMINDER_TITLE_SIZE 128
#define REMINDERS_MAX       64

/*
 * days: bitmask of weekdays when the reminder fires.
 *   bit 0 = Sunday, 1 = Monday, ..., 6 = Saturday
 *   e.g. Mon–Fri = 0b0111110 = 62, every day = 127
 *
 * end_time: 0 = repeats forever; non-zero = stop firing after this timestamp.
 *   For one-shot: set end_time = target_unix_time + 10.
 */
typedef struct {
	char    id[REMINDER_ID_SIZE];
	char    title[REMINDER_TITLE_SIZE];
	int     hour;
	int     minute;
	uint8_t days;
	time_t  end_time;
	int     enabled;
} Reminder;

void  RemindersGetPath(const User *u, char *out, size_t cap);
int   RemindersList(const User *u, Reminder *out, int *count);
int   RemindersSave(const User *u, const Reminder *r);
int   RemindersDelete(const User *u, const char *id);
char *RemindersListJson(const User *u);

#endif
