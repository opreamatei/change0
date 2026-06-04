#include "user-profile.h"

#include "util.h"
#include "user-management.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// AI GENERATED Mostly

/* The "derived" profile section is an internal key=value\n text store, NOT JSON.
 * Values must be persisted RAW here — JSON-escaping only happens at the actual
 * JSON boundary (the OpenAI request body). Escaping on store + reading back
 * without unescaping caused backslashes to double on every save (2^n growth). */
#define DERIVED_MAX_LATEST_INPUT 2048
#define DERIVED_MAX_SOURCE       256
#define DERIVED_MAX_GOAL_EVENT   256
#define DERIVED_MAX_GOAL_ID      64
#define DERIVED_MAX_GOAL_TITLE   512

static void init_profile_file_if_missing(User *u)
{
	char directory[USER_DIRECTORY_SIZE];
	GetUserProfileExportPath(u, directory);

	size_t len = 0;
	char *existing = readFile(directory, &len);
	if (existing) {
		free(existing);
		return;
	}

	static const char initial_file[] =
		USER_PROFILE_HEADER
		USER_PROFILE_INPUTS_MARKER
		USER_PROFILE_GOALS_MARKER
		USER_PROFILE_DERIVED_MARKER;

	dump_to_file(directory, initial_file, sizeof(initial_file) - 1);
}

static void slice_between_markers(
	const char *file_data,
	const char *start_marker,
	const char *end_marker,
	String *out
)
{
	const char *start = strstr(file_data, start_marker);
	const char *end = end_marker ? strstr(file_data, end_marker) : NULL;

	EmptyString(out);

	if (!start)
		return;

	start += strlen(start_marker);

	if (!end)
		end = file_data + strlen(file_data);

	if (end < start)
		return;

	CatString(out, (char *)start, (size_t)(end - start));
}

static void read_profile_sections(User *u, String *inputs, String *goals, String *derived)
{
	char directory[USER_DIRECTORY_SIZE];
	GetUserProfileExportPath(u, directory);

	size_t len = 0;
	char *file_data = NULL;

	init_profile_file_if_missing(u);
	file_data = readFile(directory, &len);
	if (!file_data)
		return;

	slice_between_markers(file_data, USER_PROFILE_INPUTS_MARKER, USER_PROFILE_GOALS_MARKER, inputs);
	slice_between_markers(file_data, USER_PROFILE_GOALS_MARKER, USER_PROFILE_DERIVED_MARKER, goals);
	slice_between_markers(file_data, USER_PROFILE_DERIVED_MARKER, NULL, derived);

	free(file_data);
}

static void write_profile_sections(User *u, String *inputs, String *goals, String *derived)
{
	char directory[USER_DIRECTORY_SIZE];
	GetUserProfileExportPath(u, directory);

	String out;
	InitString(&out, inputs->len + goals->len + derived->len + 512);

	CatFixed(&out, USER_PROFILE_HEADER);
	CatFixed(&out, USER_PROFILE_INPUTS_MARKER);
	CatString(&out, inputs->p, inputs->len);
	CatFixed(&out, USER_PROFILE_GOALS_MARKER);
	CatString(&out, goals->p, goals->len);
	CatFixed(&out, USER_PROFILE_DERIVED_MARKER);
	CatString(&out, derived->p, derived->len);

	dump_to_file(directory, out.p, out.len);

	FreeString(&out);
}

static void derived_state_init(UserProfileDerivedState *state)
{
	InitString(&state->latest_input_source, 256);
	InitString(&state->latest_input, 2048);
	InitString(&state->last_goal_event, 256);
	InitString(&state->last_goal_id, 128);
	InitString(&state->last_goal_title, 512);
	InitString(&state->current_focus_goal_id, 128);
	InitString(&state->current_focus_goal_title, 512);
	state->updated_at = 0;
}

static void derived_state_free(UserProfileDerivedState *state)
{
	FreeString(&state->latest_input_source);
	FreeString(&state->latest_input);
	FreeString(&state->last_goal_event);
	FreeString(&state->last_goal_id);
	FreeString(&state->last_goal_title);
	FreeString(&state->current_focus_goal_id);
	FreeString(&state->current_focus_goal_title);
}

static void set_string_from_line(String *dst, const char *value)
{
	EmptyString(dst);
	if (value)
		CatString(dst, (char *)value, strlen(value));
}

/* Sanitize a value for the plain-text derived store on WRITE: only newlines are
 * illegal (they delimit lines), so replace them with spaces. No JSON escaping. */
static char *sanitize_inline_dup(const char *src)
{
	const char *s = src ? src : "";
	size_t len = strlen(s);
	char *out = malloc(len + 1);
	change_assert(out, "Could not allocate while sanitizing derived field for write.\n");
	for (size_t i = 0; i < len; i++) {
		char c = s[i];
		out[i] = (c == '\n' || c == '\r') ? ' ' : c;
	}
	out[len] = '\0';
	return out;
}

/* Set a derived field on LOAD, healing legacy corruption: collapse runs of
 * backslashes (escape-doubling artifacts) to a single backslash, neutralize
 * newlines, and clamp length so a poisoned field can never dominate a prompt. */
static void set_string_from_line_clamped(String *dst, const char *value, size_t max)
{
	EmptyString(dst);
	if (!value)
		return;

	size_t srclen = strlen(value);
	char *buf = malloc(srclen + 1);
	change_assert(buf, "Could not allocate while sanitizing derived field on load.\n");

	size_t n = 0;
	_Bool prev_backslash = 0;
	for (size_t i = 0; i < srclen && n < max; i++) {
		char c = value[i];
		if (c == '\n' || c == '\r')
			c = ' ';
		if (c == '\\') {
			if (prev_backslash)
				continue; /* drop consecutive backslashes */
			prev_backslash = 1;
		} else {
			prev_backslash = 0;
		}
		buf[n++] = c;
	}
	buf[n] = '\0';

	CatString(dst, buf, n);
	free(buf);
}

static void parse_derived_line(UserProfileDerivedState *state, char *line)
{
	char *eq = strchr(line, '=');
	if (!eq)
		return;

	*eq = '\0';
	eq++;

	if (strcmp(line, "latest_input_source") == 0) {
		set_string_from_line_clamped(&state->latest_input_source, eq, DERIVED_MAX_SOURCE);
		return;
	}

	if (strcmp(line, "latest_input") == 0) {
		set_string_from_line_clamped(&state->latest_input, eq, DERIVED_MAX_LATEST_INPUT);
		return;
	}

	if (strcmp(line, "last_goal_event") == 0) {
		set_string_from_line_clamped(&state->last_goal_event, eq, DERIVED_MAX_GOAL_EVENT);
		return;
	}

	if (strcmp(line, "last_goal_id") == 0) {
		set_string_from_line_clamped(&state->last_goal_id, eq, DERIVED_MAX_GOAL_ID);
		return;
	}

	if (strcmp(line, "last_goal_title") == 0) {
		set_string_from_line_clamped(&state->last_goal_title, eq, DERIVED_MAX_GOAL_TITLE);
		return;
	}

	if (strcmp(line, "current_focus_goal_id") == 0) {
		set_string_from_line_clamped(&state->current_focus_goal_id, eq, DERIVED_MAX_GOAL_ID);
		return;
	}

	if (strcmp(line, "current_focus_goal_title") == 0) {
		set_string_from_line_clamped(&state->current_focus_goal_title, eq, DERIVED_MAX_GOAL_TITLE);
		return;
	}
}

static void parse_derived_state(String *derived_section, UserProfileDerivedState *state)
{
	char *cursor = NULL;
	char *line = NULL;

	if (!derived_section || !derived_section->p || derived_section->len == 0)
		return;

	cursor = malloc(derived_section->len + 1);
	change_assert(cursor, "Coudln't allocate memory in parse derived state.\n");
	change_assert(cursor, "Could not duplicate derived profile section.\n");
	memcpy(cursor, derived_section->p, derived_section->len + 1);

	line = strtok(cursor, "\n");
	while (line) {
		parse_derived_line(state, line);
		line = strtok(NULL, "\n");
	}

	free(cursor);
}

/* Keys owned by write_derived_state — anything else is a user/AI custom field and must be preserved. */
static const char * const FIXED_DERIVED_KEYS[] = {
	"updated_at",
	"profile_kind",
	"profile_note",
	"latest_input_source",
	"latest_input",
	"last_goal_event",
	"last_goal_id",
	"last_goal_title",
	"current_focus_goal_id",
	"current_focus_goal_title",
	NULL
};

static _Bool is_fixed_derived_key(const char *line)
{
	for (int i = 0; FIXED_DERIVED_KEYS[i]; i++) {
		size_t klen = strlen(FIXED_DERIVED_KEYS[i]);
		if (strncmp(line, FIXED_DERIVED_KEYS[i], klen) == 0 && line[klen] == '=')
			return 1;
	}
	return 0;
}

/* derived_section is both input (custom fields to preserve) and output (full new section). */
static void write_derived_state(String *derived_section, UserProfileDerivedState *state)
{
	char time_buffer[128];
	char *esc_latest_input_source = NULL;
	char *esc_latest_input = NULL;
	char *esc_last_goal_event = NULL;
	char *esc_last_goal_id = NULL;
	char *esc_last_goal_title = NULL;
	char *esc_current_focus_goal_id = NULL;
	char *esc_current_focus_goal_title = NULL;
	char *old_copy = NULL;
	String out;

	if (!state->updated_at)
		state->updated_at = change_time_now();

	snprintf(time_buffer, sizeof(time_buffer), "%s", change_ctime(&state->updated_at));
	trim_newline_inplace(time_buffer);
	/* Store RAW (newline-sanitized) — not JSON-escaped. See note at top of file. */
	esc_latest_input_source = sanitize_inline_dup(state->latest_input_source.p);
	esc_latest_input = sanitize_inline_dup(state->latest_input.p);
	esc_last_goal_event = sanitize_inline_dup(state->last_goal_event.p);
	esc_last_goal_id = sanitize_inline_dup(state->last_goal_id.p);
	esc_last_goal_title = sanitize_inline_dup(state->last_goal_title.p);
	esc_current_focus_goal_id = sanitize_inline_dup(state->current_focus_goal_id.p);
	esc_current_focus_goal_title = sanitize_inline_dup(state->current_focus_goal_title.p);

	/* Save a copy of old custom lines before overwriting. */
	if (derived_section->len > 0) {
		old_copy = malloc(derived_section->len + 1);
		if (old_copy) {
			memcpy(old_copy, derived_section->p, derived_section->len);
			old_copy[derived_section->len] = '\0';
		}
	}

	InitString(&out, derived_section->cap > 0 ? derived_section->cap : 1024);

	CatTemplateString(&out, "updated_at=%s\n", time_buffer);
	CatFixed(&out, "profile_kind=automated_mvp_memory\n");
	CatFixed(&out, "profile_note=system-maintained operational summary for the MVP, not a psychological truth\n");
	CatTemplateString(&out, "latest_input_source=%s\n", esc_latest_input_source);
	CatTemplateString(&out, "latest_input=%s\n", esc_latest_input);
	CatTemplateString(&out, "last_goal_event=%s\n", esc_last_goal_event);
	CatTemplateString(&out, "last_goal_id=%s\n", esc_last_goal_id);
	CatTemplateString(&out, "last_goal_title=%s\n", esc_last_goal_title);
	CatTemplateString(&out, "current_focus_goal_id=%s\n", esc_current_focus_goal_id);
	CatTemplateString(&out, "current_focus_goal_title=%s\n", esc_current_focus_goal_title);

	/* Re-append any custom (non-fixed) lines from the old section. */
	if (old_copy) {
		char *line = strtok(old_copy, "\n");
		while (line) {
			if (*line && !is_fixed_derived_key(line)) {
				CatString(&out, line, strlen(line));
				CatFixed(&out, "\n");
			}
			line = strtok(NULL, "\n");
		}
		free(old_copy);
	}

	/* Replace derived_section content with the new merged output. */
	EmptyString(derived_section);
	CatString(derived_section, out.p, out.len);
	FreeString(&out);

	free(esc_current_focus_goal_title);
	free(esc_current_focus_goal_id);
	free(esc_last_goal_title);
	free(esc_last_goal_id);
	free(esc_last_goal_event);
	free(esc_latest_input);
	free(esc_latest_input_source);
}

static void append_input_record(String *inputs, const char *source, const char *text, time_t now)
{
	char time_buffer[128];
	char *esc_source = json_escape_dup(source ? source : "");
	char *esc_text = json_escape_dup(text ? text : "");

	snprintf(time_buffer, sizeof(time_buffer), "%s", change_ctime(&now));
	trim_newline_inplace(time_buffer);

	CatTemplateString(
		inputs,
		"{\"ts\":\"%s\",\"source\":\"%s\",\"text\":\"%s\"}\n",
		time_buffer,
		esc_source,
		esc_text
	);

	free(esc_source);
	free(esc_text);
}

static void append_goal_record(String *goals, const char *event_type, Goal *goal, const char *details, time_t now)
{
	char time_buffer[128];
	char *esc_event = json_escape_dup(event_type ? event_type : "");
	char *esc_goal_id = json_escape_dup(goal ? goal->id : "");
	char *esc_title = json_escape_dup(goal && goal->title.p ? goal->title.p : "");
	char *esc_details = json_escape_dup(details ? details : "");

	snprintf(time_buffer, sizeof(time_buffer), "%s", change_ctime(&now));
	trim_newline_inplace(time_buffer);

	CatTemplateString(
		goals,
		"{\"ts\":\"%s\",\"event\":\"%s\",\"goal_id\":\"%s\",\"goal_title\":\"%s\",\"goal_depth\":%zu,\"details\":\"%s\"}\n",
		time_buffer,
		esc_event,
		esc_goal_id,
		esc_title,
		goal ? goal->depth : 0,
		esc_details
	);

	free(esc_details);
	free(esc_title);
	free(esc_goal_id);
	free(esc_event);
}

void UserProfileRecordInput(User *u, const char *source, const char *text)
{
	String inputs, goals, derived;
	UserProfileDerivedState state;

	if (!u)
		return;

	InitString(&inputs, 1024);
	InitString(&goals, 1024);
	InitString(&derived, 1024);
	derived_state_init(&state);

	read_profile_sections(u, &inputs, &goals, &derived);
	parse_derived_state(&derived, &state);

	time_t now = change_time_now();
	append_input_record(&inputs, source, text, now);

	state.updated_at = now;
	EmptyString(&state.latest_input_source);
	EmptyString(&state.latest_input);
	if (source) {
		size_t slen = strlen(source);
		if (slen > DERIVED_MAX_SOURCE) slen = DERIVED_MAX_SOURCE;
		CatString(&state.latest_input_source, (char *)source, slen);
	}
	if (text) {
		size_t tlen = strlen(text);
		if (tlen > DERIVED_MAX_LATEST_INPUT) tlen = DERIVED_MAX_LATEST_INPUT;
		CatString(&state.latest_input, (char *)text, tlen);
	}

	write_derived_state(&derived, &state);
	write_profile_sections(u, &inputs, &goals, &derived);

	derived_state_free(&state);
	FreeString(&derived);
	FreeString(&goals);
	FreeString(&inputs);
}

static void copy_derived_line_if_not_key(String *out, const char *line, const char *key)
{
	size_t key_len = strlen(key);

	if (strncmp(line, key, key_len) == 0 && line[key_len] == '=')
		return;

	CatString(out, (char *)line, strlen(line));
	CatFixed(out, "\n");
}

static void rewrite_derived_field(User *u, const char *key, const char *value, _Bool keep_field)
{
	String inputs, goals, derived, new_derived;
	char *cursor = NULL;
	char *line = NULL;
	char *esc_value = NULL;
	_Bool found = 0;

	change_assert(key && *key, "Derived profile field key must not be empty.\n");

	if (!u)
		return;

	InitString(&inputs, 1024);
	InitString(&goals, 1024);
	InitString(&derived, 1024);
	InitString(&new_derived, 1024);

	read_profile_sections(u, &inputs, &goals, &derived);

	if (derived.len > 0) {
		cursor = malloc(derived.len + 1);
		change_assert(cursor, "Could not duplicate derived profile while rewriting field.\n");
		memcpy(cursor, derived.p, derived.len + 1);

		line = strtok(cursor, "\n");
		while (line) {
			size_t key_len = strlen(key);
			if (strncmp(line, key, key_len) == 0 && line[key_len] == '=') {
				found = 1;
				if (keep_field) {
					esc_value = sanitize_inline_dup(value ? value : "");
					CatTemplateString(&new_derived, "%s=%s\n", key, esc_value);
					free(esc_value);
					esc_value = NULL;
				}
			} else {
				copy_derived_line_if_not_key(&new_derived, line, key);
			}

			line = strtok(NULL, "\n");
		}

		free(cursor);
	}

	if (keep_field && !found) {
		esc_value = sanitize_inline_dup(value ? value : "");
		CatTemplateString(&new_derived, "%s=%s\n", key, esc_value);
		free(esc_value);
	}

	write_profile_sections(u, &inputs, &goals, &new_derived);

	FreeString(&new_derived);
	FreeString(&derived);
	FreeString(&goals);
	FreeString(&inputs);
}

void UserProfileSetDerivedField(User *u, const char *key, const char *value)
{
	rewrite_derived_field(u, key, value, 1);
}

void UserProfileClearDerivedField(User *u, const char *key)
{
	rewrite_derived_field(u, key, "", 0);
}

_Bool UserProfileGetDerivedField(User *u, const char *key, char *out, size_t out_size)
{
	String inputs, goals, derived;
	char *cursor;
	char *line;
	size_t key_len;
	_Bool found = 0;

	if (!u || !key || !out || out_size == 0)
		return 0;

	InitString(&inputs, 256);
	InitString(&goals, 256);
	InitString(&derived, 1024);

	read_profile_sections(u, &inputs, &goals, &derived);

	key_len = strlen(key);

	if (derived.len > 0) {
		cursor = malloc(derived.len + 1);
		if (cursor) {
			memcpy(cursor, derived.p, derived.len);
			cursor[derived.len] = '\0';
			line = strtok(cursor, "\n");
			while (line) {
				if (strncmp(line, key, key_len) == 0 && line[key_len] == '=') {
					const char *val = line + key_len + 1;
					strncpy(out, val, out_size - 1);
					out[out_size - 1] = '\0';
					found = 1;
					break;
				}
				line = strtok(NULL, "\n");
			}
			free(cursor);
		}
	}

	FreeString(&derived);
	FreeString(&goals);
	FreeString(&inputs);

	return found;
}

static void append_last_lines(String *src, size_t max_entries, String *out)
{
	size_t count = 0;
	size_t start = 0;

	if (!src || !src->p || src->len == 0) {
		CatFixed(out, "No entries.\n");
		return;
	}

	if (max_entries == 0)
		max_entries = 1;

	for (size_t i = src->len; i > 0; i--) {
		if (src->p[i - 1] == '\n') {
			if (i < src->len)
				count++;
			if (count >= max_entries) {
				start = i;
				break;
			}
		}
	}

	if (count < max_entries)
		start = 0;

	CatString(out, src->p + start, src->len - start);
}

void SerializeUserProfileHistorySection(User *u, const char *section, size_t max_entries, String *out)
{
	String inputs, goals, derived;
	const char *normalized = section ? section : "";

	change_assert(out, "SerializeUserProfileHistorySection requires output string.\n");

	if (!u) {
		EmptyString(out);
		CatFixed(out, "No active user.\n");
		return;
	}

	InitString(&inputs, 1024);
	InitString(&goals, 1024);
	InitString(&derived, 1024);
	read_profile_sections(u, &inputs, &goals, &derived);

	EmptyString(out);

	if (strcmp(normalized, "inputs") == 0 || strcmp(normalized, "input-history") == 0) {
		CatFixed(out, "User profile input history:\n");
		append_last_lines(&inputs, max_entries, out);
	} else if (strcmp(normalized, "goal-activity") == 0 || strcmp(normalized, "goals") == 0) {
		CatFixed(out, "User profile goal activity:\n");
		append_last_lines(&goals, max_entries, out);
	} else {
		CatTemplateString(out, "Unknown user-profile history section [%s]. Valid sections: inputs, goal-activity.\n", normalized);
	}

	FreeString(&derived);
	FreeString(&goals);
	FreeString(&inputs);
}

void SerializeUserProfileDerivedSummary(User *u, String *out)
{
	String inputs, goals, derived;

	change_assert(out, "SerializeUserProfileDerivedSummary requires output string.\n");

	if (!u) {
		EmptyString(out);
		CatFixed(out, "No active user.\n");
		return;
	}

	InitString(&inputs, 1024);
	InitString(&goals, 1024);
	InitString(&derived, 1024);
	read_profile_sections(u, &inputs, &goals, &derived);

	EmptyString(out);
	CatFixed(out, "Automated MVP user-profile summary:\n");

	if (derived.len == 0)
		CatFixed(out, "No derived summary yet.\n");
	else
		CatString(out, derived.p, derived.len);

	FreeString(&derived);
	FreeString(&goals);
	FreeString(&inputs);
}

void UserProfileRecordGoalEvent(User *u, const char *event_type, Goal *goal, const char *details)
{
	String inputs, goals, derived;
	UserProfileDerivedState state;
	time_t now = change_time_now();

	if (!u || !goal || !event_type)
		return;

	InitString(&inputs, 1024);
	InitString(&goals, 1024);
	InitString(&derived, 1024);
	derived_state_init(&state);

	read_profile_sections(u, &inputs, &goals, &derived);
	parse_derived_state(&derived, &state);

	append_goal_record(&goals, event_type, goal, details, now);

	state.updated_at = now;
	EmptyString(&state.last_goal_event);
	EmptyString(&state.last_goal_id);
	EmptyString(&state.last_goal_title);
	CatString(&state.last_goal_event, (char *)event_type, strlen(event_type));
	CatString(&state.last_goal_id, goal->id, strlen(goal->id));
	CatString(&state.last_goal_title, goal->title.p, goal->title.len);

	if (
		strcmp(event_type, "goal_created") == 0 ||
		strcmp(event_type, "goal_repaired") == 0 ||
		strcmp(event_type, "goal_started") == 0 ||
		strcmp(event_type, "goal_started_deep") == 0
	) {
		EmptyString(&state.current_focus_goal_id);
		EmptyString(&state.current_focus_goal_title);
		CatString(&state.current_focus_goal_id, goal->id, strlen(goal->id));
		CatString(&state.current_focus_goal_title, goal->title.p, goal->title.len);
	} else if (strcmp(event_type, "goal_ended") == 0 &&
	           strcmp(state.current_focus_goal_id.p, goal->id) == 0) {
		EmptyString(&state.current_focus_goal_id);
		EmptyString(&state.current_focus_goal_title);
	}

	write_derived_state(&derived, &state);
	write_profile_sections(u, &inputs, &goals, &derived);

	derived_state_free(&state);
	FreeString(&derived);
	FreeString(&goals);
	FreeString(&inputs);
}
