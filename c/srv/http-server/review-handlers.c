#define _POSIX_C_SOURCE 200809L

#include "internal.h"
#include "http-util.h"
#include "reviews.h"
#include "goal/goal-util.h"
#include "goal/goal.h"
#include "user-management.h"
#include "journey.h"
#include "util.h"
#include "config.h"
#include "lib/openai/openai.h"
#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

/* ── allowed attachment extensions ── */

static int allowed_ext(const char *filename)
{
    const char *dot = strrchr(filename, '.');
    if (!dot) return 0;
    dot++;
    return strcasecmp(dot, "jpg")  == 0 || strcasecmp(dot, "jpeg") == 0 ||
           strcasecmp(dot, "png")  == 0 || strcasecmp(dot, "gif")  == 0 ||
           strcasecmp(dot, "webp") == 0 || strcasecmp(dot, "pdf")  == 0 ||
           strcasecmp(dot, "glb")  == 0 || strcasecmp(dot, "mp3")  == 0;
}

/* ── goal tree context builder (root + first 2 layers) ── */

static void append_goal_layer(String *ctx, Goal *g, const char *journey_id, int depth)
{
    if (!g) return;
    const char *title = g->title.p     ? g->title.p     : "";
    const char *info  = g->extra_info.p ? g->extra_info.p : "";

    if (depth == 0) {
        CatTemplateString(ctx, "Root: %s. %s\n", title, info);
    } else {
        for (int i = 0; i < depth; i++) CatFixed(ctx, "  ");
        CatTemplateString(ctx, "- %s\n", title);
    }

    if (depth >= 2) return;
    for (size_t i = 0; i < g->subgoals_len; i++) {
        Goal *child = FindGoalFromIndex(journey_id, g->subgoals[i]);
        if (child) append_goal_layer(ctx, child, journey_id, depth + 1);
    }
}

/* ── AI helpers ── */

static char *ai_call_single_string(const char *prompt_str,
                                   const char *schema_str,
                                   const char *schema_name,
                                   const char *field)
{
    ai_gpt_request req = {0};
    req.model       = AI_OPENAI_MODEL_GPT_5_4_MINI;
    req.schema_name = schema_name;

    InitString(&req.prompt, strlen(prompt_str) + 1);
    CatString(&req.prompt, (char *)prompt_str, strlen(prompt_str));

    InitString(&req.schema, strlen(schema_str) + 1);
    CatString(&req.schema, (char *)schema_str, strlen(schema_str));

    String *raw = ai_openai_call_gpt_request(&req);
    FreeString(&req.prompt);
    FreeString(&req.schema);

    if (!raw) return NULL;

    json_value *doc = json_parse(raw->p, raw->len);
    FreeString(raw);
    free(raw);

    if (!doc || doc->type != json_object) {
        if (doc) json_value_free(doc);
        return NULL;
    }

    char *result = NULL;
    json_value *v = json_object_get(doc, field);
    if (v && v->type == json_string && v->u.string.length > 0) {
        result = malloc(v->u.string.length + 1);
        if (result) {
            memcpy(result, v->u.string.ptr, v->u.string.length);
            result[v->u.string.length] = '\0';
        }
    }
    json_value_free(doc);
    return result;
}

/* ── POST /submissions/create ── */

void handle_post_submission_create(int fd, const HttpRequest *req, User *user)
{
    if (!req->body) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_body\"}");
        return;
    }

    char goal_id[GOAL_ID_SIZE + 1] = {0};
    char user_desc[2048]            = {0};

    json_get_string_field(req->body, "goal_id",          goal_id,   sizeof(goal_id));
    json_get_string_field(req->body, "user_description", user_desc, sizeof(user_desc));

    if (!goal_id[0]) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_goal_id\"}");
        return;
    }

    /* find goal across all user journeys */
    Goal    *goal    = NULL;
    Journey *journey = NULL;
    for (size_t ji = 0; ji < user->journey_count && !goal; ji++) {
        const char *jid = user->journeys[ji];
        Journey *j = FindJourneyByID(jid);
        if (!j) continue;
        if (j->is_shared) FetchSharedJourney(jid);
        size_t count = 0;
        Goal **goals = GetGoalsSorted(&count, jid);
        for (size_t gi = 0; gi < count; gi++) {
            if (!goals[gi]) continue;
            char cur[GOAL_ID_SIZE + 1];
            snprintf(cur, sizeof(cur), "%.*s", GOAL_ID_SIZE, goals[gi]->id);
            if (strcmp(cur, goal_id) == 0) {
                goal    = goals[gi];
                journey = j;
                break;
            }
        }
        free(goals);
    }

    if (!goal) {
        http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"goal_not_found\"}");
        return;
    }

    /* must be a root goal */
    if (CalcGoalRoot(goal) != goal) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"not_root_goal\"}");
        return;
    }

    /* must be completed */
    if (goal->end_date == 0) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"goal_not_completed\"}");
        return;
    }

    /* build context string for AI */
    String ctx;
    InitString(&ctx, 512);
    append_goal_layer(&ctx, goal, goal->journey_id, 0);

    const char *title = goal->title.p     ? goal->title.p     : "";
    const char *info  = goal->extra_info.p ? goal->extra_info.p : "";
    const char *child = ctx.p              ? ctx.p              : "";

    /* generate label */
    String label_prompt;
    InitString(&label_prompt, sizeof(REVIEW_LABEL_PROMPT) + strlen(title) + strlen(info) + strlen(child) + 32);
    CatTemplateString(&label_prompt, REVIEW_LABEL_PROMPT, title, info, child);

    char *ai_label = ai_call_single_string(
        label_prompt.p, REVIEW_LABEL_SCHEMA, "review_label", "label");
    FreeString(&label_prompt);

    if (!ai_label) ai_label = strdup("Unknown");

    /* generate description */
    String desc_prompt;
    InitString(&desc_prompt, sizeof(REVIEW_DESCRIPTION_PROMPT) + strlen(title) + strlen(info) + strlen(child) + 32);
    CatTemplateString(&desc_prompt, REVIEW_DESCRIPTION_PROMPT, title, info, child);

    char *ai_desc = ai_call_single_string(
        desc_prompt.p, REVIEW_DESCRIPTION_SCHEMA, "review_description", "description");
    FreeString(&desc_prompt);
    FreeString(&ctx);

    if (!ai_desc) ai_desc = strdup("A completed personal goal.");

    GoalSubmission *sub = CreateSubmission(ai_label, ai_desc, user_desc);
    free(ai_label);
    free(ai_desc);

    if (!sub) {
        http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"submission_failed\"}");
        return;
    }

    char *esc_label = json_escape_dup(sub->ai_label);
    char *esc_desc  = json_escape_dup(sub->ai_description.p ? sub->ai_description.p : "");

    char resp[1024];
    snprintf(resp, sizeof(resp),
        "{\"ok\":true,\"id\":\"%s\",\"ai_label\":\"%s\",\"ai_description\":\"%s\"}",
        sub->id, esc_label, esc_desc);

    free(esc_label);
    free(esc_desc);

    http_send_json(fd, 200, "OK", resp);
}

/* ── POST /submissions/file?id=…&f=… ── */

void handle_post_submission_file(int fd, const HttpRequest *req, User *user)
{
    (void)user;

    const char *query = NULL;
    char path[256];
    split_path_and_query(req->path, path, sizeof(path), &query);

    char sub_id[SUBMISSION_ID_SIZE] = {0};
    char fname[256]                  = {0};

    if (!query ||
        !query_get_param(query, "id", sub_id, sizeof(sub_id)) || !sub_id[0] ||
        !query_get_param(query, "f",  fname,  sizeof(fname))  || !fname[0]) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_params\"}");
        return;
    }

    if (!req->body || req->body_len == 0) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"empty_body\"}");
        return;
    }

    if (!allowed_ext(fname)) {
        http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"invalid_extension\"}");
        return;
    }

    if (AddSubmissionFile(sub_id, fname, req->body, req->body_len) != 0) {
        http_send_json(fd, 500, "Internal Server Error", "{\"ok\":false,\"error\":\"write_failed\"}");
        return;
    }

    http_send_json(fd, 200, "OK", "{\"ok\":true}");
}
