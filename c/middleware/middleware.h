#ifndef CHANGE_MIDDLEWARE_H
#define CHANGE_MIDDLEWARE_H

#include "util.h"
#include "goal/goal-util.h"

typedef _Bool (*middleware_emit_like_func)(const char *id, const char *type, const char *buffer, size_t buffer_len);

typedef struct {
	String assistant_message;
	String response_type;
	String permission_id;
} MiddlewareResult;

void InitMiddlewareResult(MiddlewareResult *result);
void FreeMiddlewareResult(MiddlewareResult *result);

MiddlewareResult RunClientMiddleware(
	const char *session_id,
	const char *user_input,
	start_ds_session_like_func *start_ds_session,
	middleware_emit_like_func emit,
	User *user
);

_Bool ResolveMiddlewarePermission(
	const char *permission_id,
	_Bool approved,
	middleware_emit_like_func emit,
	User *user
);

char* ExportMiddlewareSessionJSON(const char *session_id);
char* ListChatSessionsJSON(const char *user_prefix);

#endif
