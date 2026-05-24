#include "http-util.h"
#include "config.h"
#include "util.h"
#include "change-errors.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define READ_CHUNK_SIZE    4096
#define INITIAL_BUFFER_CAP 8192
#define MAX_REQUEST_SIZE   (16 * 1024 * 1024)
#define MAX_HEADER_SIZE    (256 * 1024)

/* -------- raw socket send -------- */

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

/* -------- central server IPC -------- */

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

/* -------- HTTP request parsing -------- */

void handle_options(int fd)
{
	static const char *response =
		"HTTP/1.1 204 No Content\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
		"Access-Control-Allow-Headers: Content-Type\r\n"
		"Content-Length: 0\r\n"
		"Connection: close\r\n"
		"\r\n";

	http_send_all(fd, response, strlen(response));
}

static int ascii_ncasecmp_n(const char *a, const char *b, size_t n)
{
	for (size_t i = 0; i < n; i++) {
		unsigned char ca = (unsigned char)tolower((unsigned char)a[i]);
		unsigned char cb = (unsigned char)tolower((unsigned char)b[i]);
		if (ca != cb) return (int)ca - (int)cb;
		if (ca == '\0') return 0;
	}
	return 0;
}

const char *find_header_value(const char *headers, const char *name)
{
	size_t name_len = strlen(name);
	const char *p = headers;

	while (*p) {
		const char *line_end = strstr(p, "\r\n");
		if (!line_end) return NULL;

		if ((size_t)(line_end - p) > name_len &&
		    ascii_ncasecmp_n(p, name, name_len) == 0 &&
		    p[name_len] == ':') {
			const char *value = p + name_len + 1;
			while (*value == ' ' || *value == '\t') value++;
			return value;
		}

		p = line_end + 2;
		if (*p == '\r' && *(p + 1) == '\n') break;
	}

	return NULL;
}

static int parse_content_length(const char *headers, size_t *out_len)
{
	const char *value = find_header_value(headers, "Content-Length");
	if (!value) { *out_len = 0; return 0; }

	char *endptr = NULL;
	unsigned long long n = strtoull(value, &endptr, 10);
	if (endptr == value) return -1;

	*out_len = (size_t)n;
	return 0;
}

static int read_into_string(int fd, String *s, size_t max_total)
{
	char chunk[READ_CHUNK_SIZE];

	for (;;) {
		ssize_t n = recv(fd, chunk, sizeof(chunk), 0);
		if (n < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		if (n == 0) return 0;
		if (s->len + (size_t)n > max_total) return -1;
		CatString(s, chunk, (size_t)n);
		return 1;
	}
}

int read_http_request(int fd, HttpRequest *req)
{
	String raw;
	char *header_end = NULL;

	memset(req, 0, sizeof(*req));
	InitString(&raw, INITIAL_BUFFER_CAP);

	while (!header_end) {
		if (raw.len > MAX_HEADER_SIZE) {
			FreeString(&raw);
			return -1;
		}
		int rc = read_into_string(fd, &raw, MAX_REQUEST_SIZE);
		if (rc <= 0) {
			FreeString(&raw);
			return -1;
		}
		header_end = strstr(c_str(&raw), "\r\n\r\n");
	}

	size_t header_end_offset = (size_t)(header_end - c_str(&raw)) + 4;

	char *line_end = strstr(c_str(&raw), "\r\n");
	if (!line_end) {
		FreeString(&raw);
		return -1;
	}

	*line_end = '\0';
	if (sscanf(c_str(&raw), "%15s %255s", req->method, req->path) != 2) {
		FreeString(&raw);
		return -1;
	}
	*line_end = '\r';

	size_t content_length = 0;
	if (parse_content_length(c_str(&raw), &content_length) != 0) {
		FreeString(&raw);
		return -1;
	}
	if (content_length > MAX_REQUEST_SIZE) {
		FreeString(&raw);
		return -1;
	}

	while (raw.len < header_end_offset + content_length) {
		int rc = read_into_string(fd, &raw, MAX_REQUEST_SIZE);
		if (rc <= 0) {
			FreeString(&raw);
			return -1;
		}
	}

	req->body_len = content_length;
	req->body = malloc(content_length + 1);
	cassert(req->body != NULL, "Failed to allocate request body\n");

	if (content_length > 0)
		memcpy(req->body, c_str(&raw) + header_end_offset, content_length);
	req->body[content_length] = '\0';

	FreeString(&raw);
	return 0;
}

void free_http_request(HttpRequest *req)
{
	if (req->body) {
		free(req->body);
		req->body = NULL;
	}
	req->body_len = 0;
}

/* -------- path / query -------- */

void split_path_and_query(const char *full, char *path, size_t cap, const char **query)
{
	const char *q = strchr(full, '?');
	if (!q) {
		snprintf(path, cap, "%s", full);
		*query = NULL;
		return;
	}

	size_t path_len = (size_t)(q - full);
	if (path_len >= cap) path_len = cap - 1;
	memcpy(path, full, path_len);
	path[path_len] = '\0';
	*query = q + 1;
}

int query_get_param(const char *query, const char *key, char *out, size_t cap)
{
	if (!query || !key || !out || cap == 0) return 0;

	size_t key_len = strlen(key);
	const char *p = query;

	while (*p) {
		const char *amp = strchr(p, '&');
		const char *end = amp ? amp : p + strlen(p);
		const char *eq  = memchr(p, '=', (size_t)(end - p));

		if (eq) {
			size_t cur_key_len = (size_t)(eq - p);
			size_t val_len     = (size_t)(end - eq - 1);

			if (cur_key_len == key_len && memcmp(p, key, key_len) == 0) {
				if (val_len >= cap) val_len = cap - 1;
				memcpy(out, eq + 1, val_len);
				out[val_len] = '\0';
				return 1;
			}
		}

		if (!amp) break;
		p = amp + 1;
	}

	return 0;
}

/* -------- JSON field helpers -------- */

char *json_escape_dup_n(const char *src, size_t len)
{
	size_t cap = len * 6 + 1;
	char *out = malloc(cap);
	size_t w = 0;

	cassert(out != NULL, "Failed to allocate escaped json buffer\n");

	for (size_t i = 0; i < len; i++) {
		unsigned char c = (unsigned char)src[i];
		switch (c) {
		case '\"': out[w++] = '\\'; out[w++] = '\"'; break;
		case '\\': out[w++] = '\\'; out[w++] = '\\'; break;
		case '\n': out[w++] = '\\'; out[w++] = 'n';  break;
		case '\r': out[w++] = '\\'; out[w++] = 'r';  break;
		case '\t': out[w++] = '\\'; out[w++] = 't';  break;
		default:
			if (c < 0x20)
				w += (size_t)sprintf(out + w, "\\u%04x", (unsigned)c);
			else
				out[w++] = (char)c;
			break;
		}
	}

	out[w] = '\0';
	return out;
}

static const char *json_skip_ws(const char *p)
{
	while (*p && isspace((unsigned char)*p)) p++;
	return p;
}

int json_get_string_field(const char *json, const char *key, char *out, size_t cap)
{
	char pattern[128];
	size_t w = 0;

	if (!json || !key || !out || cap == 0) return 0;

	snprintf(pattern, sizeof(pattern), "\"%s\"", key);
	const char *p = strstr(json, pattern);
	if (!p) return 0;

	p += strlen(pattern);
	p = json_skip_ws(p);
	if (*p != ':') return 0;
	p = json_skip_ws(p + 1);
	if (*p != '\"') return 0;
	p++;

	const char *start = p;
	while (*p) {
		if (*p == '\\') { p++; if (*p) p++; continue; }
		if (*p == '\"') break;
		p++;
	}
	if (*p != '\"') return 0;

	while (start < p && w + 1 < cap) {
		if (*start == '\\') {
			start++;
			if (!*start) break;
			switch (*start) {
			case '\"': out[w++] = '\"'; break;
			case '\\': out[w++] = '\\'; break;
			case '/':  out[w++] = '/';  break;
			case 'b':  out[w++] = '\b'; break;
			case 'f':  out[w++] = '\f'; break;
			case 'n':  out[w++] = '\n'; break;
			case 'r':  out[w++] = '\r'; break;
			case 't':  out[w++] = '\t'; break;
			default:   out[w++] = *start; break;
			}
			start++;
		} else {
			out[w++] = *start++;
		}
	}

	out[w] = '\0';
	return 1;
}

int json_get_int_field(const char *json, const char *key, int *out)
{
	char pattern[128];

	if (!json || !key || !out) return 0;

	snprintf(pattern, sizeof(pattern), "\"%s\"", key);
	const char *p = strstr(json, pattern);
	if (!p) return 0;

	p += strlen(pattern);
	p = json_skip_ws(p);
	if (*p != ':') return 0;
	p = json_skip_ws(p + 1);

	char *endptr = NULL;
	errno = 0;
	long value = strtol(p, &endptr, 10);
	if (endptr == p || errno != 0) return 0;

	*out = (int)value;
	return 1;
}

int json_get_bool_or_int_field(const char *json, const char *key, int *out)
{
	char pattern[128];

	if (json_get_int_field(json, key, out))
		return 1;

	if (!json || !key || !out) return 0;

	snprintf(pattern, sizeof(pattern), "\"%s\"", key);
	const char *p = strstr(json, pattern);
	if (!p) return 0;

	p += strlen(pattern);
	p = json_skip_ws(p);
	if (*p != ':') return 0;
	p = json_skip_ws(p + 1);

	if (strncmp(p, "true",  4) == 0) { *out = 1; return 1; }
	if (strncmp(p, "false", 5) == 0) { *out = 0; return 1; }

	return 0;
}
