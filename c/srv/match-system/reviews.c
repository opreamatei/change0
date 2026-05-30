#define _POSIX_C_SOURCE 200809L

#include "reviews.h"
#include "config.h"
#include "util.h"
#include "json.h"
#include "change-errors.h"

#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

static GoalSubmission  SubmissionTable[MAX_SUBMISSIONS];
static size_t          SubmissionCount = 0;
static pthread_mutex_t submissions_lock = PTHREAD_MUTEX_INITIALIZER;

/* ── path helpers ── */

static void sub_dir(const char *id, char *out, size_t cap)
{
    snprintf(out, cap, SUBMISSIONS_DIR "%s/", id);
}

static void meta_path(const char *id, char *out, size_t cap)
{
    snprintf(out, cap, SUBMISSIONS_DIR "%s/metadata.json", id);
}

static void attach_dir(const char *id, char *out, size_t cap)
{
    snprintf(out, cap, SUBMISSIONS_DIR "%s/attachments/", id);
}

static void reviews_dir(const char *id, char *out, size_t cap)
{
    snprintf(out, cap, SUBMISSIONS_DIR "%s/reviews/", id);
}

static void daily_path(const char *reviewer_id, char *out, size_t cap)
{
    snprintf(out, cap, SUBMISSIONS_DAILY_DIR "%s.json", reviewer_id);
}

static void ensure_dir(const char *path)
{
    if (mkdir(path, 0755) != 0 && errno != EEXIST)
        fprintf(stderr, "[reviews] mkdir failed: %s\n", path);
}

/* ── filename safety ── */

static int safe_fname(const char *f)
{
    if (!f || !f[0]) return 0;
    if (strstr(f, "..")) return 0;
    if (strchr(f, '/'))  return 0;
    return 1;
}

/* ── persist / load ── */

static void persist_metadata(const GoalSubmission *s)
{
    char path[512];
    meta_path(s->id, path, sizeof(path));

    char *esc_label = json_escape_dup(s->ai_label);
    char *esc_ai    = json_escape_dup(s->ai_description.p ? s->ai_description.p : "");
    char *esc_user  = json_escape_dup(s->user_description.p ? s->user_description.p : "");

    String out;
    InitString(&out, 1024);

    CatTemplateString(&out,
        "{\"id\":\"%s\","
        "\"ai_label\":\"%s\","
        "\"ai_description\":\"%s\","
        "\"user_description\":\"%s\","
        "\"file_count\":%d,"
        "\"authentic\":%s,"
        "\"submitted_at\":%lld,"
        "\"files\":[",
        s->id,
        esc_label,
        esc_ai,
        esc_user,
        s->file_count,
        s->authentic ? "true" : "false",
        (long long)s->submitted_at);

    for (int i = 0; i < s->file_count; i++) {
        char *esc_f = json_escape_dup(s->files[i]);
        CatTemplateString(&out, "%s\"%s\"", i == 0 ? "" : ",", esc_f);
        free(esc_f);
    }
    CatFixed(&out, "]}");

    dump_to_file(path, out.p, out.len);
    FreeString(&out);
    free(esc_label);
    free(esc_ai);
    free(esc_user);
}

static void load_metadata(GoalSubmission *s, const char *path)
{
    size_t flen = 0;
    char *buf = readFile((char *)path, &flen);
    if (!buf || flen == 0) { free(buf); return; }

    json_value *doc = json_parse(buf, flen);
    free(buf);
    if (!doc || doc->type != json_object) {
        if (doc) json_value_free(doc);
        return;
    }

    json_value *v;

    v = json_object_get(doc, "id");
    if (v && v->type == json_string)
        snprintf(s->id, sizeof(s->id), "%s", v->u.string.ptr);

    v = json_object_get(doc, "ai_label");
    if (v && v->type == json_string)
        snprintf(s->ai_label, sizeof(s->ai_label), "%s", v->u.string.ptr);

    v = json_object_get(doc, "ai_description");
    if (v && v->type == json_string) {
        InitString(&s->ai_description, v->u.string.length + 1);
        CatString(&s->ai_description, v->u.string.ptr, v->u.string.length);
    } else {
        InitString(&s->ai_description, 1);
    }

    v = json_object_get(doc, "user_description");
    if (v && v->type == json_string) {
        InitString(&s->user_description, v->u.string.length + 1);
        CatString(&s->user_description, v->u.string.ptr, v->u.string.length);
    } else {
        InitString(&s->user_description, 1);
    }

    v = json_object_get(doc, "file_count");
    if (v && v->type == json_integer)
        s->file_count = (int)v->u.integer;

    v = json_object_get(doc, "authentic");
    if (v && v->type == json_boolean)
        s->authentic = (_Bool)v->u.boolean;

    v = json_object_get(doc, "submitted_at");
    if (v && v->type == json_integer)
        s->submitted_at = (time_t)v->u.integer;

    v = json_object_get(doc, "files");
    if (v && v->type == json_array) {
        unsigned int fcount = v->u.array.length;
        if (fcount > SUBMISSION_MAX_FILES) fcount = SUBMISSION_MAX_FILES;
        s->file_count = (int)fcount;
        for (unsigned int i = 0; i < fcount; i++) {
            json_value *fv = v->u.array.values[i];
            if (fv && fv->type == json_string)
                snprintf(s->files[i], SUBMISSION_FNAME_MAX, "%s", fv->u.string.ptr);
        }
    }

    json_value_free(doc);
}

/* ── init / free ── */

void InitReviewSystem(void)
{
    memset(SubmissionTable, 0, sizeof(SubmissionTable));
    SubmissionCount = 0;

    ensure_dir(SUBMISSIONS_DIR);
    ensure_dir(SUBMISSIONS_DAILY_DIR);

    DIR *d = opendir(SUBMISSIONS_DIR);
    if (!d) return;

    struct dirent *e;
    while ((e = readdir(d)) != NULL && SubmissionCount < MAX_SUBMISSIONS) {
        if (e->d_name[0] == '.') continue;

        char meta[512];
        snprintf(meta, sizeof(meta), SUBMISSIONS_DIR "%s/metadata.json", e->d_name);

        GoalSubmission *s = &SubmissionTable[SubmissionCount];
        memset(s, 0, sizeof(*s));
        load_metadata(s, meta);

        if (s->id[0] != '\0')
            SubmissionCount++;
    }
    closedir(d);
}

void FreeReviewSystem(void)
{
    pthread_mutex_lock(&submissions_lock);
    for (size_t i = 0; i < SubmissionCount; i++) {
        FreeString(&SubmissionTable[i].ai_description);
        FreeString(&SubmissionTable[i].user_description);
    }
    SubmissionCount = 0;
    pthread_mutex_unlock(&submissions_lock);
}

/* ── creation ── */

GoalSubmission *CreateSubmission(const char *ai_label,
                                 const char *ai_description,
                                 const char *user_description)
{
    pthread_mutex_lock(&submissions_lock);

    if (SubmissionCount >= MAX_SUBMISSIONS) {
        pthread_mutex_unlock(&submissions_lock);
        return NULL;
    }

    GoalSubmission *s = &SubmissionTable[SubmissionCount];
    memset(s, 0, sizeof(*s));

    random_id(s->id, SUBMISSION_ID_SIZE - 1);
    s->id[SUBMISSION_ID_SIZE - 1] = '\0';

    snprintf(s->ai_label, sizeof(s->ai_label), "%s", ai_label ? ai_label : "");

    size_t ai_len   = ai_description   ? strlen(ai_description)   : 0;
    size_t user_len = user_description ? strlen(user_description) : 0;

    InitString(&s->ai_description,   ai_len   + 1);
    InitString(&s->user_description, user_len + 1);

    if (ai_len   > 0) CatString(&s->ai_description,   (char *)ai_description,   ai_len);
    if (user_len > 0) CatString(&s->user_description, (char *)user_description, user_len);

    s->file_count  = 0;
    s->authentic   = 0;
    s->submitted_at = time(NULL);

    char dir[512], att[512];
    sub_dir(s->id, dir, sizeof(dir));
    attach_dir(s->id, att, sizeof(att));
    ensure_dir(dir);
    ensure_dir(att);

    persist_metadata(s);

    SubmissionCount++;
    pthread_mutex_unlock(&submissions_lock);

    return s;
}

/* ── file attachment ── */

int AddSubmissionFile(const char *sub_id, const char *filename,
                      const void *data, size_t len)
{
    if (!safe_fname(sub_id) || !safe_fname(filename)) return -1;

    pthread_mutex_lock(&submissions_lock);

    GoalSubmission *s = NULL;
    for (size_t i = 0; i < SubmissionCount; i++) {
        if (strcmp(SubmissionTable[i].id, sub_id) == 0) {
            s = &SubmissionTable[i];
            break;
        }
    }

    if (!s || s->file_count >= SUBMISSION_MAX_FILES) {
        pthread_mutex_unlock(&submissions_lock);
        return -1;
    }

    char path[768];
    snprintf(path, sizeof(path), SUBMISSIONS_DIR "%s/attachments/%s", sub_id, filename);

    FILE *fp = fopen(path, "wb");
    if (!fp) {
        pthread_mutex_unlock(&submissions_lock);
        return -1;
    }
    if (len > 0) fwrite(data, 1, len, fp);
    fclose(fp);

    snprintf(s->files[s->file_count], SUBMISSION_FNAME_MAX, "%s", filename);
    s->file_count++;
    persist_metadata(s);

    pthread_mutex_unlock(&submissions_lock);
    return 0;
}

/* ── lookup ── */

GoalSubmission *FindSubmission(const char *sub_id)
{
    if (!sub_id) return NULL;
    for (size_t i = 0; i < SubmissionCount; i++)
        if (strcmp(SubmissionTable[i].id, sub_id) == 0)
            return &SubmissionTable[i];
    return NULL;
}

/* ── review status checks ── */

int HasReviewerReviewed(const char *sub_id, const char *reviewer_id)
{
    if (!safe_fname(sub_id)) return 0;

    char rdir[512];
    reviews_dir(sub_id, rdir, sizeof(rdir));

    DIR *d = opendir(rdir);
    if (!d) return 0;

    int found = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && !found) {
        size_t nlen = strlen(e->d_name);
        if (nlen < 6 || strcmp(e->d_name + nlen - 5, ".json") != 0) continue;

        char path[768];
        snprintf(path, sizeof(path), "%s%s", rdir, e->d_name);

        size_t flen = 0;
        char *buf = readFile(path, &flen);
        if (!buf) continue;

        json_value *doc = json_parse(buf, flen);
        free(buf);
        if (!doc || doc->type != json_object) {
            if (doc) json_value_free(doc);
            continue;
        }

        json_value *rv = json_object_get(doc, "reviewer_id");
        if (rv && rv->type == json_string &&
            strcmp(rv->u.string.ptr, reviewer_id) == 0)
            found = 1;

        json_value_free(doc);
    }
    closedir(d);
    return found;
}

/* ── file reading ── */

int ReadSubmissionFile(const char *sub_id, const char *filename,
                       void **out_data, size_t *out_len)
{
    if (!safe_fname(sub_id) || !safe_fname(filename)) return -1;

    char path[768];
    snprintf(path, sizeof(path), SUBMISSIONS_DIR "%s/attachments/%s", sub_id, filename);

    FILE *fp = fopen(path, "rb");
    if (!fp) return -1;

    fseek(fp, 0, SEEK_END);
    long sz = ftell(fp);
    rewind(fp);
    if (sz < 0) { fclose(fp); return -1; }

    void *buf = malloc((size_t)sz);
    if (!buf) { fclose(fp); return -1; }
    fread(buf, 1, (size_t)sz, fp);
    fclose(fp);

    *out_data = buf;
    *out_len  = (size_t)sz;
    return 0;
}

/* ── pending list ── */

size_t ListPendingForReviewer(const char *reviewer_id,
                               const char *reviewer_label,
                               GoalSubmission **out, size_t max)
{
    if (!reviewer_id || max == 0) return 0;

    GoalSubmission *matching[MAX_SUBMISSIONS];
    GoalSubmission *other[MAX_SUBMISSIONS];
    size_t nm = 0, no = 0;

    const char *rl = reviewer_label ? reviewer_label : "";

    for (size_t i = 0; i < SubmissionCount; i++) {
        GoalSubmission *s = &SubmissionTable[i];
        if (s->authentic) continue;
        if (HasReviewerReviewed(s->id, reviewer_id)) continue;

        /* simple case-insensitive substring match on label */
        _Bool match = 0;
        if (rl[0]) {
            char label_lo[SUBMISSION_LABEL_MAX];
            char rl_lo[SUBMISSION_LABEL_MAX];
            size_t j = 0;
            for (; s->ai_label[j] && j < sizeof(label_lo) - 1; j++)
                label_lo[j] = (char)(s->ai_label[j] | 0x20);
            label_lo[j] = '\0';
            j = 0;
            for (; rl[j] && j < sizeof(rl_lo) - 1; j++)
                rl_lo[j] = (char)(rl[j] | 0x20);
            rl_lo[j] = '\0';
            match = strstr(label_lo, rl_lo) != NULL;
        }

        if (match) matching[nm++] = s;
        else        other[no++]   = s;
    }

    size_t count = 0;
    for (size_t i = 0; i < nm && count < max; i++) out[count++] = matching[i];
    for (size_t i = 0; i < no && count < max; i++) out[count++] = other[i];
    return count;
}

/* ── daily limit ── */

int GetReviewsTodayCount(const char *reviewer_id)
{
    if (!safe_fname(reviewer_id)) return 0;

    char path[512];
    daily_path(reviewer_id, path, sizeof(path));

    size_t flen = 0;
    char *buf = readFile(path, &flen);
    if (!buf || flen == 0) { free(buf); return 0; }

    json_value *doc = json_parse(buf, flen);
    free(buf);
    if (!doc || doc->type != json_object) {
        if (doc) json_value_free(doc);
        return 0;
    }

    int count = 0;
    time_t reset_at = 0;

    json_value *v = json_object_get(doc, "count");
    if (v && v->type == json_integer) count = (int)v->u.integer;

    v = json_object_get(doc, "reset_at");
    if (v && v->type == json_integer) reset_at = (time_t)v->u.integer;

    json_value_free(doc);

    /* reset if 24h have passed */
    if (time(NULL) - reset_at >= 86400) return 0;
    return count;
}

static void update_daily_count(const char *reviewer_id, int count)
{
    char path[512];
    daily_path(reviewer_id, path, sizeof(path));

    char buf[128];
    int len = snprintf(buf, sizeof(buf),
        "{\"count\":%d,\"reset_at\":%lld}",
        count, (long long)time(NULL));
    dump_to_file(path, buf, (size_t)len);
}

/* ── submit review ── */

int SubmitReview(const char *sub_id, const char *reviewer_id, int score)
{
    if (!safe_fname(sub_id) || !safe_fname(reviewer_id)) return -1;

    int today = GetReviewsTodayCount(reviewer_id);
    if (today >= MAX_DAILY_REVIEWS) return 1;

    if (HasReviewerReviewed(sub_id, reviewer_id)) return 2;

    GoalSubmission *s = FindSubmission(sub_id);
    if (!s) return -1;

    /* create reviews/ subdir if needed */
    char rdir[512];
    reviews_dir(sub_id, rdir, sizeof(rdir));
    ensure_dir(rdir);

    /* write review file */
    char review_id[REVIEW_ID_SIZE];
    random_id(review_id, REVIEW_ID_SIZE - 1);
    review_id[REVIEW_ID_SIZE - 1] = '\0';

    char *esc_rev = json_escape_dup(reviewer_id);
    char review_json[512];
    int jlen = snprintf(review_json, sizeof(review_json),
        "{\"id\":\"%s\",\"submission_id\":\"%s\","
        "\"reviewer_id\":\"%s\",\"score\":%d,\"reviewed_at\":%lld}",
        review_id, sub_id, esc_rev, score, (long long)time(NULL));
    free(esc_rev);

    char rpath[768];
    snprintf(rpath, sizeof(rpath), "%s%s.json", rdir, review_id);
    dump_to_file(rpath, review_json, (size_t)jlen);

    /* mark authentic if score meets threshold */
    if (score >= 4) {
        pthread_mutex_lock(&submissions_lock);
        s->authentic = 1;
        persist_metadata(s);
        pthread_mutex_unlock(&submissions_lock);
    }

    update_daily_count(reviewer_id, today + 1);
    return 0;
}
