#include "http-util.h"
#include "config.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int http_send_all(int fd, const void *data, size_t len)
{
	const char *p = data;
	size_t sent = 0;

	while (sent < len) {
#ifdef MSG_NOSIGNAL
		ssize_t n = send(fd, p + sent, len - sent, MSG_NOSIGNAL);
#else
		ssize_t n = send(fd, p + sent, len - sent, 0);
#endif
		if (n <= 0) {
			if (n < 0 && errno == EINTR) continue;
			return -1;
		}
		sent += (size_t)n;
	}
	return 0;
}

void http_send_json(int fd, int status, const char *reason, const char *body)
{
	char header[512];
	size_t body_len = body ? strlen(body) : 0;

	int n = snprintf(header, sizeof(header),
		"HTTP/1.1 %d %s\r\n"
		"Content-Type: application/json\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
		"Access-Control-Allow-Headers: Content-Type\r\n"
		"Content-Length: %zu\r\n"
		"Connection: close\r\n"
		"\r\n",
		status, reason, body_len);

	if (n <= 0 || (size_t)n >= sizeof(header)) return;
	http_send_all(fd, header, (size_t)n);
	if (body && body_len) http_send_all(fd, body, body_len);
}

int central_connect(void)
{
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) return -1;

	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family      = AF_INET;
	addr.sin_port        = htons(CENTRAL_SERVER_PORT);
	addr.sin_addr.s_addr = inet_addr("127.0.0.1");

	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

char *central_recv_body(int fd, size_t *out_len)
{
	char buf[65536];
	size_t total = 0;
	ssize_t r;

	while (total < sizeof(buf) - 1) {
		r = recv(fd, buf + total, sizeof(buf) - 1 - total, 0);
		if (r <= 0) break;
		total += (size_t)r;
	}
	buf[total] = '\0';

	char *body = strstr(buf, "\r\n\r\n");
	if (!body) return NULL;
	body += 4;

	size_t body_len = total - (size_t)(body - buf);
	char *result = malloc(body_len + 1);
	if (!result) return NULL;
	memcpy(result, body, body_len);
	result[body_len] = '\0';
	*out_len = body_len;
	return result;
}
