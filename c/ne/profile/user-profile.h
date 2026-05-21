#ifndef USER_PROFILE_H
#define USER_PROFILE_H

#include "util.h"
#include "goal/goal-util.h"
#include "user-management.h"

#define USER_PROFILE_HEADER "CHANGE_USER_PROFILE_V1\n"
#define USER_PROFILE_INPUTS_MARKER "\n=== INPUT_HISTORY ===\n"
#define USER_PROFILE_GOALS_MARKER "\n=== GOAL_ACTIVITY ===\n"
#define USER_PROFILE_DERIVED_MARKER "\n=== DERIVED_PROFILE ===\n"

typedef struct {
	String latest_input_source;
	String latest_input;
	String last_goal_event;
	String last_goal_id;
	String last_goal_title;
	String current_focus_goal_id;
	String current_focus_goal_title;
	time_t updated_at;
} UserProfileDerivedState;

void UserProfileRecordInput(User *u, const char *source, const char *text);
void UserProfileRecordGoalEvent(User *u, const char *event_type, Goal *goal, const char *details);
void SerializeUserProfileHistorySection(User *u, const char *section, size_t max_entries, String *out);
void SerializeUserProfileDerivedSummary(User *u, String *out);
void UserProfileSetDerivedField(User *u, const char *key, const char *value);
void UserProfileClearDerivedField(User *u, const char *key);

#endif
