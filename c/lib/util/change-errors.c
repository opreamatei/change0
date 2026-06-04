#include "config.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <time.h>
#include "change-errors.h"
#include "time-util.h"
#include <string.h>

_Bool massert(_Bool assertion, const char* message){
	if (!assertion && message) fprintf(stderr, "%s", message);
	return !assertion;
}

void cassert(_Bool assertion, const char* message){
	/*
	if (!assertion && message){
		char file_name[256];
		time_t now = time(NULL);

		sprintf(file_name, DEFAULT_DUMP_DIRECTORY "error %s", ctime(&now));
		dump_to_file(file_name, FSTRING_SIZE_PARAMS(message));

		fprintf(stderr, "----------------------\n\n\nCHANGE FAILURE MESSAGE\n\n\n[%s]", message);
		exit(EXIT_FAILURE);
	}
	*/

	change_assert(assertion, "%s", message);
}

void change_assert_impl(
	_Bool assertion,
	const char* file,
	int line,
	const char* func,
	const char* fmt,
	...
){
	if (assertion) return;

	if (!fmt) {
		fmt = "Assertion failed";
	}

	va_list args;
	va_start(args, fmt);

	va_list args_copy;
	va_copy(args_copy, args);

	int needed = vsnprintf(NULL, 0, fmt, args_copy);
	va_end(args_copy);

	char fallback_message[1024];
	char* user_message = NULL;

	if (needed < 0) {
		snprintf(fallback_message, sizeof(fallback_message), "Assertion message formatting failed");
		user_message = fallback_message;
	} else {
		user_message = malloc((size_t)needed + 1);

		if (user_message) {
			vsnprintf(user_message, (size_t)needed + 1, fmt, args);
		} else {
			vsnprintf(fallback_message, sizeof(fallback_message), fmt, args);
			user_message = fallback_message;
		}
	}

	va_end(args);

	time_t now = change_time_now();
	struct tm* tm_info = localtime(&now);

	char timestamp[64];

	if (tm_info) {
		strftime(timestamp, sizeof(timestamp), "%Y-%m-%d_%H-%M-%S", tm_info);
	} else {
		snprintf(timestamp, sizeof(timestamp), "unknown-time");
	}

	char file_name[512];

	snprintf(
		file_name,
		sizeof(file_name),
		DEFAULT_DUMP_DIRECTORY "error_%s.log",
		timestamp
	);

	char final_message[4096];

	int final_len = snprintf(
		final_message,
		sizeof(final_message),
		"----------------------\n\n\n"
		"CHANGE FAILURE MESSAGE\n\n\n"
		"File: %s\n"
		"Line: %d\n"
		"Function: %s\n\n"
		"[%s]\n",
		file,
		line,
		func,
		user_message
	);

	if (final_len < 0) {
		fprintf(stderr, "CHANGE FAILURE MESSAGE\n[Could not format failure message]\n");
	} else {
		size_t write_len = strlen(final_message);

		dump_to_file(file_name, final_message, write_len);

		fprintf(stderr, "%s", final_message);
	}

	if (user_message != fallback_message) {
		free(user_message);
	}

	exit(EXIT_FAILURE);
}

void dump_to_file(const char *path, const char *data, size_t len){
    FILE *f = fopen(path, "wb");
    cassert(f, "Failed to open debug file.\n");

    size_t written = fwrite(data, 1, len, f);
    cassert(written == len, "Failed to write full buffer to file.\n");

    fclose(f);
}
