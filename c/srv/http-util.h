#ifndef HTTP_UTIL_H
#define HTTP_UTIL_H

#include <stddef.h>

/* -------- raw socket send -------- */
int  http_send_all(int fd, const void *data, size_t len);
void http_send_json(int fd, int status, const char *reason, const char *body);

/* -------- central server IPC -------- */
int   central_connect(void);
char *central_recv_body(int fd, size_t *out_len);

/* -------- HTTP request parsing -------- */
typedef struct {
	char   method[16];
	char   path[256];
	char  *body;
	size_t body_len;
} HttpRequest;

void        handle_options(int fd);
const char *find_header_value(const char *headers, const char *name);
int         read_http_request(int fd, HttpRequest *req);
void        free_http_request(HttpRequest *req);

/* -------- path / query -------- */
void split_path_and_query(const char *full, char *path, size_t cap, const char **query);
int  query_get_param(const char *query, const char *key, char *out, size_t cap);

/* -------- JSON field helpers -------- */
char *json_escape_dup_n(const char *src, size_t len);
int   json_get_string_field(const char *json, const char *key, char *out, size_t cap);
int   json_get_int_field(const char *json, const char *key, int *out);
int   json_get_bool_or_int_field(const char *json, const char *key, int *out);

#endif
