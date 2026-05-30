#define _POSIX_C_SOURCE 200809L

#include "central-internal.h"
#include "http-util.h"
#include "reviews.h"
#include "util.h"
#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* ── MIME detection (glb + mp3 extended) ── */

static const char *submission_mime(const char *filename)
{
    const char *dot = strrchr(filename, '.');
    if (!dot) return "application/octet-stream";
    dot++;
    if (strcasecmp(dot, "jpg")  == 0 || strcasecmp(dot, "jpeg") == 0) return "image/jpeg";
    if (strcasecmp(dot, "png")  == 0) return "image/png";
    if (strcasecmp(dot, "gif")  == 0) return "image/gif";
    if (strcasecmp(dot, "webp") == 0) return "image/webp";
    if (strcasecmp(dot, "pdf")  == 0) return "application/pdf";
    if (strcasecmp(dot, "glb")  == 0) return "model/gltf-binary";
    if (strcasecmp(dot, "mp3")  == 0) return "audio/mpeg";
    return "application/octet-stream";
}

/* ── GET /submissions/pending?user_id=…&label=… ── */

void handle_get_submissions_pending(int fd, const char *query)
{
    char reviewer_id[64]  = {0};
    char reviewer_label[SUBMISSION_LABEL_MAX] = {0};

    if (query) {
        query_get_param(query, "user_id", reviewer_id, sizeof(reviewer_id));
        query_get_param(query, "label",   reviewer_label, sizeof(reviewer_label));
    }

    if (!reviewer_id[0]) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
        return;
    }

    GoalSubmission *results[5];
    size_t count = ListPendingForReviewer(reviewer_id, reviewer_label, results, 5);

    String out;
    InitString(&out, 1024);
    CatFixed(&out, "{\"ok\":true,\"submissions\":[");

    for (size_t i = 0; i < count; i++) {
        GoalSubmission *s = results[i];
        char *esc_label = json_escape_dup(s->ai_label);
        char *esc_desc  = json_escape_dup(s->ai_description.p ? s->ai_description.p : "");

        CatTemplateString(&out,
            "%s{\"id\":\"%s\","
            "\"ai_label\":\"%s\","
            "\"ai_description\":\"%s\","
            "\"file_count\":%d,"
            "\"submitted_at\":%lld,"
            "\"files\":[",
            i == 0 ? "" : ",",
            s->id, esc_label, esc_desc,
            s->file_count,
            (long long)s->submitted_at);

        for (int fi = 0; fi < s->file_count; fi++) {
            char *esc_f = json_escape_dup(s->files[fi]);
            CatTemplateString(&out, "%s\"%s\"", fi == 0 ? "" : ",", esc_f);
            free(esc_f);
        }
        CatFixed(&out, "]}");

        free(esc_label);
        free(esc_desc);
    }

    CatFixed(&out, "]}");
    http_send_json(fd, 200, "OK", out.p);
    FreeString(&out);
}

/* ── POST /submissions/<id>/review ── */

void handle_post_submission_review(int fd, const char *sub_id, CentralRequest *req)
{
    char *reviewer_id = extract_string_field(req->body, req->body_len, "reviewer_id");
    int   score       = 0;
    json_get_int_field(req->body, "score", &score);

    if (!reviewer_id || !reviewer_id[0] || score < 1 || score > 5) {
        free(reviewer_id);
        http_send_json(fd, 400, "Bad Request",
            "{\"ok\":false,\"error\":\"missing_or_invalid_fields\"}");
        return;
    }

    int result = SubmitReview(sub_id, reviewer_id, score);
    free(reviewer_id);

    switch (result) {
    case 0:
        http_send_json(fd, 200, "OK", "{\"ok\":true}");
        break;
    case 1:
        http_send_json(fd, 429, "Too Many Requests",
            "{\"ok\":false,\"error\":\"daily_limit\"}");
        break;
    case 2:
        http_send_json(fd, 409, "Conflict",
            "{\"ok\":false,\"error\":\"already_reviewed\"}");
        break;
    default:
        http_send_json(fd, 500, "Internal Server Error",
            "{\"ok\":false,\"error\":\"review_failed\"}");
        break;
    }
}

/* ── GET /submissions/<id>/status ── */

void handle_get_submission_status(int fd, const char *sub_id)
{
    GoalSubmission *s = FindSubmission(sub_id);
    if (!s) {
        http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"not_found\"}");
        return;
    }
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"ok\":true,\"authentic\":%s}",
             s->authentic ? "true" : "false");
    http_send_json(fd, 200, "OK", buf);
}

/* ── GET /submissions/file?id=…&f=… ── */

void handle_get_submission_file(int fd, const char *query)
{
    char sub_id[SUBMISSION_ID_SIZE] = {0};
    char fname[256]                  = {0};

    if (!query ||
        !query_get_param(query, "id", sub_id, sizeof(sub_id)) || !sub_id[0] ||
        !query_get_param(query, "f",  fname,  sizeof(fname))  || !fname[0]) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_params\"}");
        return;
    }

    void  *data = NULL;
    size_t len  = 0;
    if (ReadSubmissionFile(sub_id, fname, &data, &len) != 0) {
        http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"file_not_found\"}");
        return;
    }

    const char *mime = submission_mime(fname);

    char header[512];
    int hlen = snprintf(header, sizeof(header),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: %s\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n"
        "\r\n",
        mime, len);

    http_send_all(fd, header, (size_t)hlen);
    if (data && len) http_send_all(fd, data, len);
    free(data);
}
