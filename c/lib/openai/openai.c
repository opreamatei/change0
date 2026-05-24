#define _POSIX_C_SOURCE 200112L

#include "openai.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <netdb.h>
#include <sys/socket.h>

#include <openssl/ssl.h>
#include <openssl/err.h>

#include "config.h"
#include "util.h"
#include "assert.h"

#define AI_OPENAI_HOST "api.openai.com"
#define AI_OPENAI_PORT "443"
#define AI_OPENAI_RAW_CAP (4 * 1024 * 1024)
#define AI_OPENAI_MAX_RETRIES 5

typedef struct {
    int fd;
    SSL_CTX *ctx;
    SSL *ssl;
} ai_tls_conn;

static void ai_tls_close(ai_tls_conn *c) {
    if (!c) return;

    if (c->ssl) {
        /* Skip SSL_shutdown: we use Connection: close so the server has
         * already closed the session.  Calling SSL_shutdown after an abrupt
         * close (RST / no TLS close_notify) writes to a dead socket and can
         * fault inside OpenSSL's BIO layer even with SIGPIPE ignored. */
        SSL_free(c->ssl);
        c->ssl = NULL;
    }

    if (c->ctx) {
        SSL_CTX_free(c->ctx);
        c->ctx = NULL;
    }

    if (c->fd >= 0) {
        close(c->fd);
        c->fd = -1;
    }
}

static const char *ai_get_api_key(void) {
    return getenv("OPENAI_API_KEY");
}

static ai_openai_status ai_tls_connect(ai_tls_conn *conn) {
    if (!conn) return AI_OPENAI_ERR_ARG;

    conn->fd = -1;
    conn->ctx = NULL;
    conn->ssl = NULL;

    struct addrinfo hints;
    struct addrinfo *res = NULL;

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    int gai = getaddrinfo(AI_OPENAI_HOST, AI_OPENAI_PORT, &hints, &res);
    if (gai != 0) {
        return AI_OPENAI_ERR_DNS;
    }

    int fd = -1;

    for (struct addrinfo *it = res; it; it = it->ai_next) {
        fd = socket(it->ai_family, it->ai_socktype, it->ai_protocol);
        if (fd < 0) continue;

        if (connect(fd, it->ai_addr, it->ai_addrlen) == 0) {
            break;
        }

        close(fd);
        fd = -1;
    }

    if (fd < 0) {
        freeaddrinfo(res);
        return AI_OPENAI_ERR_CONNECT;
    }

    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) {
        freeaddrinfo(res);
        close(fd);
        return AI_OPENAI_ERR_TLS;
    }

    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
    SSL_CTX_set_default_verify_paths(ctx);

    SSL *ssl = SSL_new(ctx);
    if (!ssl) {
        freeaddrinfo(res);
        SSL_CTX_free(ctx);
        close(fd);
        return AI_OPENAI_ERR_TLS;
    }

    SSL_set_fd(ssl, fd);
    SSL_set_tlsext_host_name(ssl, AI_OPENAI_HOST);

    if (SSL_connect(ssl) <= 0) {
        freeaddrinfo(res);
        SSL_free(ssl);
        SSL_CTX_free(ctx);
        close(fd);
        return AI_OPENAI_ERR_TLS;
    }

    freeaddrinfo(res);

    conn->fd = fd;
    conn->ctx = ctx;
    conn->ssl = ssl;

    return AI_OPENAI_OK;
}

static ai_openai_status ai_ssl_write_all(SSL *ssl, const char *buf, size_t len) {
    if (!ssl || !buf) return AI_OPENAI_ERR_ARG;

    size_t sent = 0;

    while (sent < len) {
        int n = SSL_write(ssl, buf + sent, (int)(len - sent));
        if (n <= 0) {
            return AI_OPENAI_ERR_WRITE;
        }

        sent += (size_t)n;
    }

    return AI_OPENAI_OK;
}

static ai_openai_status ai_read_all(SSL *ssl, String *out) {
    if (!ssl || !out) return AI_OPENAI_ERR_ARG;

    InitString(out, 8192);

    for (;;) {
        char chunk[8192];
        int n = SSL_read(ssl, chunk, sizeof(chunk));

        if (n > 0) {
            if (out->len + (size_t)n + 1 > AI_OPENAI_RAW_CAP) {
                FreeString(out);
                out->p = NULL;
                out->len = 0;
                out->cap = 0;
                out->used = 0;
                return AI_OPENAI_ERR_READ;
            }

            CatString(out, chunk, (size_t)n);
            continue;
        }

        /* SSL_ERROR_ZERO_RETURN  = clean TLS close_notify.
         * SSL_ERROR_SYSCALL/errno=0 = server closed TCP without close_notify
         *   (common with Connection: close).
         * Both mean "no more data" — treat as success.
         * Any other error means something actually went wrong. */
        int ssl_err = SSL_get_error(ssl, n);
        if (ssl_err == SSL_ERROR_ZERO_RETURN)
            return AI_OPENAI_OK;
        if (ssl_err == SSL_ERROR_SYSCALL && errno == 0)
            return AI_OPENAI_OK;

        FreeString(out);
        out->p = NULL;
        out->len = 0;
        out->cap = 0;
        out->used = 0;
        return AI_OPENAI_ERR_READ;
    }
}

static char *ai_find_body(char *http_response) {
    char *p = strstr(http_response, "\r\n\r\n");
    return p ? p + 4 : NULL;
}

static int ai_http_status_code(const char *http_response) {
    if (!http_response) return 0;

    int code = 0;

    if (sscanf(http_response, "HTTP/%*s %d", &code) == 1) {
        return code;
    }

    return 0;
}

/* Strip bare control characters from AI text output.
 * Passes all printable ASCII and all UTF-8 multi-byte sequences (>= 0x80). */
static void sanitize_ai_output(char *buf, size_t len) {
    if (!buf) return;
    for (size_t i = 0; i < len; i++) {
        unsigned char ch = (unsigned char)buf[i];
        if (ch < 0x20 && ch != '\n' && ch != '\r' && ch != '\t')
            buf[i] = ' ';
    }
}

static int ai_extract_json_string_field(
    const char *json,
    const char *field,
    char *out,
    size_t out_size
) {
    if (!json || !field || !out || out_size == 0) return 0;

    char needle[128];

    int written = snprintf(needle, sizeof(needle), "\"%s\"", field);
    if (written <= 0 || (size_t)written >= sizeof(needle)) return 0;

    const char *p = strstr(json, needle);
    if (!p) return 0;

    p = strchr(p, ':');
    if (!p) return 0;

    p++;

    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        p++;
    }

    if (*p != '"') return 0;

    p++;

    const char *end = strchr(p, '"');
    if (!end) return 0;

    size_t len = (size_t)(end - p);
    if (len + 1 > out_size) return 0;

    memcpy(out, p, len);
    out[len] = '\0';

    return 1;
}

static ai_openai_status ai_dup_string(const char *src, String *dst) {
    if (!src || !dst) return AI_OPENAI_ERR_ARG;

    size_t len = strlen(src);

    InitString(dst, len + 1);
    CatString(dst, (char *)src, len);

    return AI_OPENAI_OK;
}

static _Bool ai_should_retry_status(ai_openai_status st) {
    return st == AI_OPENAI_ERR_DNS ||
           st == AI_OPENAI_ERR_CONNECT ||
           st == AI_OPENAI_ERR_TLS ||
           st == AI_OPENAI_ERR_WRITE ||
           st == AI_OPENAI_ERR_READ;
}

static ai_openai_status ai_openai_request(
    const char *request,
    ai_openai_response *out,
    int expect_id
) {
    if (!request || !out) return AI_OPENAI_ERR_ARG;

    ai_openai_status last_status = AI_OPENAI_ERR_ARG;

    for (int attempt = 0; attempt < AI_OPENAI_MAX_RETRIES; attempt++) {
        memset(out, 0, sizeof(*out));

        ai_tls_conn conn;

        ai_openai_status st = ai_tls_connect(&conn);
        if (st != AI_OPENAI_OK) {
            last_status = st;
            if (ai_should_retry_status(st) && attempt + 1 < AI_OPENAI_MAX_RETRIES) {
                sleep(1);
                continue;
            }
            return st;
        }

        st = ai_ssl_write_all(conn.ssl, request, strlen(request));
        if (st != AI_OPENAI_OK) {
            ai_tls_close(&conn);
            last_status = st;
            if (ai_should_retry_status(st) && attempt + 1 < AI_OPENAI_MAX_RETRIES) {
                sleep(1);
                continue;
            }
            return st;
        }

        String raw = {0};

        st = ai_read_all(conn.ssl, &raw);

        ai_tls_close(&conn);

        if (st != AI_OPENAI_OK) {
            last_status = st;
            if (ai_should_retry_status(st) && attempt + 1 < AI_OPENAI_MAX_RETRIES) {
                sleep(1);
                continue;
            }
            return st;
        }

        int code = ai_http_status_code(c_str(&raw));

        if (code < 200 || code >= 300) {
            dump_to_file(PROJECT_ROOT "sent.txt", request, strlen(request));
            dump_to_file(PROJECT_ROOT "received.txt", c_str(&raw), raw.len);

            out->raw_http = raw;

            char *body = ai_find_body(c_str(&out->raw_http));
            if (body) {
                ai_dup_string(body, &out->body);
            }

            return AI_OPENAI_ERR_HTTP;
        }

        char *body = ai_find_body(c_str(&raw));
        if (!body) {
            FreeString(&raw);
            return AI_OPENAI_ERR_PARSE;
        }

        out->raw_http = raw;

        st = ai_dup_string(body, &out->body);
        if (st != AI_OPENAI_OK) {
            ai_openai_response_free(out);
            return st;
        }

        if (expect_id) {
            if (!ai_extract_json_string_field(
                    c_str(&out->body),
                    "id",
                    out->id,
                    sizeof(out->id)
                )) {
                ai_openai_response_free(out);
                return AI_OPENAI_ERR_PARSE;
            }
        }

        return AI_OPENAI_OK;
    }

    return last_status;
}

ai_openai_status ai_openai_create_response(
    const char *json_body,
    ai_openai_response *out
) {
    if (!json_body || !out) return AI_OPENAI_ERR_ARG;

    const char *api_key = ai_get_api_key();
    if (!api_key || !*api_key) {
        return AI_OPENAI_ERR_ENV;
    }

    size_t body_len = strlen(json_body);
    size_t cap = body_len + strlen(api_key) + 2048;

    char *req = malloc(cap);
    if (!req) return AI_OPENAI_ERR_ALLOC;

    int n = snprintf(
        req,
        cap,
        "POST /v1/responses HTTP/1.1\r\n"
        "Host: " AI_OPENAI_HOST "\r\n"
        "Authorization: Bearer %s\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n"
        "\r\n"
        "%s",
        api_key,
        body_len,
        json_body
    );

    if (n < 0 || (size_t)n >= cap) {
        free(req);
        return AI_OPENAI_ERR_ALLOC;
    }

    ai_openai_status st = ai_openai_request(req, out, 1);

    free(req);

    return st;
}

ai_openai_status ai_openai_get_response(
    const char *response_id,
    ai_openai_response *out
) {
    if (!response_id || !*response_id || !out) return AI_OPENAI_ERR_ARG;

    const char *api_key = ai_get_api_key();
    if (!api_key || !*api_key) {
        return AI_OPENAI_ERR_ENV;
    }

    size_t cap = strlen(response_id) + strlen(api_key) + 2048;

    char *req = malloc(cap);
    if (!req) return AI_OPENAI_ERR_ALLOC;

    int n = snprintf(
        req,
        cap,
        "GET /v1/responses/%s HTTP/1.1\r\n"
        "Host: " AI_OPENAI_HOST "\r\n"
        "Authorization: Bearer %s\r\n"
        "Content-Type: application/json\r\n"
        "Connection: close\r\n"
        "\r\n",
        response_id,
        api_key
    );

    if (n < 0 || (size_t)n >= cap) {
        free(req);
        return AI_OPENAI_ERR_ALLOC;
    }

    ai_openai_status st = ai_openai_request(req, out, 1);

    free(req);

    return st;
}

void ai_openai_response_free(ai_openai_response *resp) {
    if (!resp) return;

    FreeString(&resp->raw_http);
    FreeString(&resp->body);

    resp->raw_http.p = NULL;
    resp->raw_http.len = 0;
    resp->raw_http.cap = 0;
    resp->raw_http.used = 0;

    resp->body.p = NULL;
    resp->body.len = 0;
    resp->body.cap = 0;
    resp->body.used = 0;

    resp->id[0] = '\0';
}

const char *ai_openai_strerror(ai_openai_status status) {
    switch (status) {
        case AI_OPENAI_OK: return "ok";
        case AI_OPENAI_ERR_ARG: return "invalid argument";
        case AI_OPENAI_ERR_ENV: return "OPENAI_API_KEY not set";
        case AI_OPENAI_ERR_DNS: return "DNS resolution failed";
        case AI_OPENAI_ERR_SOCKET: return "socket error";
        case AI_OPENAI_ERR_CONNECT: return "connect error";
        case AI_OPENAI_ERR_TLS: return "TLS error";
        case AI_OPENAI_ERR_WRITE: return "write error";
        case AI_OPENAI_ERR_READ: return "read error";
        case AI_OPENAI_ERR_PARSE: return "parse error";
        case AI_OPENAI_ERR_ALLOC: return "allocation error";
        case AI_OPENAI_ERR_HTTP: return "non-2xx HTTP response";
        default: return "unknown error";
    }
}

char *openai_extract_output_text_dup(json_value *root, size_t *out_len) {
    if (!(root && root->type == json_object)) {
        assert("Invalid OpenAI root JSON.\n");
    }

    json_value *output = NULL;

    for (unsigned i = 0; i < root->u.object.length; i++) {
        json_object_entry *e = &root->u.object.values[i];

        if (strcmp(e->name, "output") == 0) {
            output = e->value;
            break;
        }
    }

    if (!(output && output->type == json_array)) {
        assert("Missing output array in OpenAI response.\n");
    }

    for (unsigned i = 0; i < output->u.array.length; i++) {
        json_value *item = output->u.array.values[i];
        if (!item || item->type != json_object) continue;

        json_value *content = NULL;

        for (unsigned j = 0; j < item->u.object.length; j++) {
            json_object_entry *e = &item->u.object.values[j];

            if (strcmp(e->name, "content") == 0) {
                content = e->value;
                break;
            }
        }

        if (!content || content->type != json_array) continue;

        for (unsigned k = 0; k < content->u.array.length; k++) {
            json_value *c = content->u.array.values[k];
            if (!c || c->type != json_object) continue;

            json_value *text = NULL;

            for (unsigned t = 0; t < c->u.object.length; t++) {
                json_object_entry *e = &c->u.object.values[t];

                if (strcmp(e->name, "text") == 0) {
                    text = e->value;
                    break;
                }
            }

            if (text && text->type == json_string) {
                size_t len = text->u.string.length;

                char *dup = malloc(len + 1);
                if (!dup) {
                    assert("Failed to allocate extracted OpenAI text.\n");
                }

                memcpy(dup, text->u.string.ptr, len);
                dup[len] = '\0';
                sanitize_ai_output(dup, len);

                if (out_len) {
                    *out_len = len;
                }

                return dup;
            }
        }
    }

    assert("Could not extract text from OpenAI response.\n");
    return NULL;
}

json_value *openai_extract_text_json(json_value *root) {
    size_t len = 0;

    char *text = openai_extract_output_text_dup(root, &len);
    if (!text) {
        assert("Failed to extract OpenAI text.\n");
    }

    json_value *parsed = json_parse(text, len);

    free(text);

    if (!parsed) {
        assert("Failed to parse extracted OpenAI text as JSON.\n");
    }

    return parsed;
}

const char *ai_openai_model_name(ai_openai_model model) {
    switch (model) {
        case AI_OPENAI_MODEL_GPT_5_5:       return "gpt-5.5";
        case AI_OPENAI_MODEL_GPT_5_4_MINI:  return "gpt-5.4-mini";
        case AI_OPENAI_MODEL_GPT_5_4_NANO:  return "gpt-5.4-nano";
        case AI_OPENAI_MODEL_GPT_5_1:       return "gpt-5.1";
        case AI_OPENAI_MODEL_GPT_5_MINI:    return "gpt-5-mini";
        default:                            return "gpt-5.4-mini";
    }
}

String *ai_openai_call_gpt_request(ai_gpt_request *req) {
    cassert(req, "Error: NULL ai_gpt_request passed.\n");
    cassert(req->prompt.p, "Error: request prompt is NULL.\n");
    cassert(req->schema.p, "Error: request schema is NULL.\n");

    const char *model = ai_openai_model_name(req->model);
    cassert(model, "Error: ai_openai_model_name returned NULL.\n");

    const char *schema_name = req->schema_name
        ? req->schema_name
        : "openai_structured_response";

    size_t schema_name_len = strlen(schema_name);
    cassert(
        schema_name_len > 0 && schema_name_len <= 64,
        "Error: OpenAI schema_name must be 1-64 characters.\n"
    );

    for (size_t i = 0; i < schema_name_len; i++) {
        char c = schema_name[i];

        int ok =
            (c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c == '_' ||
            c == '-';

        cassert(ok, "Error: OpenAI schema_name may only contain letters, digits, underscores, and dashes.\n");
    }

    json_value *schema_root = json_parse(c_str(&req->schema), req->schema.len);
    cassert(schema_root, "Error: request schema is not valid JSON.\n");
    json_value_free(schema_root);

    char *escaped_prompt = json_escape_dup(c_str(&req->prompt));
    cassert(escaped_prompt, "Error: Failed to escape prompt.\n");

    char *escaped_schema_name = json_escape_dup(schema_name);
    cassert(escaped_schema_name, "Error: Failed to escape schema name.\n");

    size_t body_cap =
        strlen(model) +
        strlen(escaped_prompt) +
        strlen(escaped_schema_name) +
        req->schema.len +
        2048;

    char *json_body = malloc(body_cap);
    cassert(json_body, "Error: Failed to allocate OpenAI JSON body.\n");

    int body_size = snprintf(
        json_body,
        body_cap,
        "{"
            "\"model\":\"%s\","
            "\"input\":\"%s\","
            "\"text\":{"
                "\"format\":{"
                    "\"type\":\"json_schema\","
                    "\"name\":\"%s\","
                    "\"strict\":true,"
                    "\"schema\":%s"
                "}"
            "}"
        "}",
        model,
        escaped_prompt,
        escaped_schema_name,
        c_str(&req->schema)
    );

    free(escaped_prompt);
    free(escaped_schema_name);

    cassert(
        body_size > 0 && (size_t)body_size < body_cap,
        "Error: Failed to build OpenAI request JSON body.\n"
    );

    ai_openai_response created = {0};
    ai_openai_status st = ai_openai_create_response(json_body, &created);

    if (st != AI_OPENAI_OK) {
        fprintf(stderr, "OpenAI request failed: %s\n", ai_openai_strerror(st));
        fprintf(stderr, "OpenAI request body:\n%s\n", json_body);

        if (created.body.p) {
            fprintf(
                stderr,
                "OpenAI response body:\n%.*s\n",
                (int)created.body.len,
                c_str(&created.body)
            );
        } else {
            fprintf(stderr, "OpenAI response body: <empty>\n");
        }

        ai_openai_response_free(&created);
        free(json_body);

        cassert(0, "Error: OpenAI request failed. Check sent.txt and received.txt\n");
    }

    free(json_body);

    cassert(created.body.p, "Error: OpenAI returned empty body.\n");

    json_value *root = json_parse(c_str(&created.body), created.body.len);
    cassert(root, "Error: Failed to parse OpenAI response body.\n");

    ai_openai_response_free(&created);

    size_t answer_len = 0;
    char *answer = openai_extract_output_text_dup(root, &answer_len);

    json_value_free(root);

    cassert(answer, "Error: Failed to extract OpenAI output text.\n");

    String *out = CreateStringFrom(answer, answer_len);

    free(answer);

    return out;
}
