#ifndef HTTP_UTIL_H
#define HTTP_UTIL_H

#include <stddef.h>

int  http_send_all(int fd, const void *data, size_t len);
void http_send_json(int fd, int status, const char *reason, const char *body);

int   central_connect(void);
char *central_recv_body(int fd, size_t *out_len);

#endif
