#ifndef CENTRAL_SERVER_HEADER
#define CENTRAL_SERVER_HEADER

/*
 * Meta-only server. It does not talk to the goal/graph engines.
 *
 * Endpoints:
 *   GET  /users               list of {id, name}
 *   POST /users/create        body: {"name": "..."}
 *   POST /users/select        body: {"id": "..."}      -> starts client server
 *                                                         bound to that user on an
 *                                                         OS-chosen port,
 *                                                         returns {id, name, port}
 */
void start_central_server(int port);
void stop_central_server(void);
int central_server_is_running(void);

#endif
