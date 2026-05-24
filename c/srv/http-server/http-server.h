#ifndef HTTP_SERVER_HEADER
#define HTTP_SERVER_HEADER

#include <stddef.h>
#include "user-management.h"

/*
 * The HTTP server is a per-user "client server". Pass port = 0 to let the
 * OS pick an ephemeral port; read it back with client_server_port().
 */
void start_server(int port, User *user);
void stop_server();
int server_is_running(void);
int client_server_port(void);
void ds_emit_event(const char* id, const char* type, const char* buffer, size_t buffer_len);
void goal_emit_event(const char* id, const char* type, const char* buffer, size_t buffer_len);

#endif
