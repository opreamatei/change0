#include "goal.h"
#include "globals.h"
#include <assert.h>
#include <openssl/x509.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <string.h>
#include <unistd.h>
#include <ctype.h>
#include "json.h"
#include "openai.h"
#include "goal-ai.h"
#include "goal-info.h"
#include "user-schedule.h"
#include "profile/user-profile.h"
#include "journey.h"

static goal_emit_like_func goal_emit = NULL;

void InitGoalSystem(){
	// Init system will go here
}

static void shorten_goal(Goal *g, time_t now){
	String prompt; InitString(&prompt, 256);

	SetGoalShortenPrompt(g, &prompt, now);

	ai_gpt_request req = {0};
	req.prompt = prompt;
	InitString(&req.schema, sizeof(OPENAI_GOAL_EXTRACT_SCHEMA_JSON) + 1);
	CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_GOAL_EXTRACT_SCHEMA_JSON));

	req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
	req.schema_name = "goal_extract";

	String *out = ai_openai_call_gpt_request(&req);

	String new_title, new_extra_info;
	time_t new_estimated_time = 0; // this should not matter
	size_t ignored_priority = 0;
	ExtractGoalFromText(out, &new_title, &new_extra_info, &new_estimated_time, &ignored_priority, 0, NULL);
	
	change_assert(new_title.len > 1 && new_extra_info.len > 1, "Goal title or extra info is broken. title : [%s], info : [%s]\n", new_title.p, new_extra_info.p);

	CatTemplateString(&g->extra_info, "\n user failed to finish goal [%s] so was shortened to [%s] in date [%s]\n", g->title.p, new_title.p, change_ctime(&now));

	CopyString(&g->title, &new_title);
	CopyString(&g->extra_info, &new_extra_info);

	FreeString(&prompt);
	FreeString(out);
}

static void repair_goal_leaf(Goal *g)
{
	change_assert(g->subgoals_len == 0, "Only leaf goals can be repaired directly [%s]\n", g->title.p);
	
	time_t max_end_date = g->start_date + g->required_time * (1 + GOAL_REQUIRED_TIME_ERROR_MARGIN);
	time_t now = change_time_now();

	time_t delta = (max_end_date - now) * (max_end_date - g->start_date);
	
	_Bool shouldExtend = g->retry_depth < 2;
	g->retry_depth ++;

	if (shouldExtend){
		// increase goal by 25%
		time_t old_time = CalcGoalRequiredTime(g);
		time_t new_time = (old_time * 125) / 100;

		g->required_time = new_time;
		CatTemplateString(&g->extra_info, "\n[Goal was extended on date [%s] from [%zu] to [%zu]]\n", change_ctime(&now), old_time, new_time);
	}else{
		shorten_goal(g, now);
		g->retry_depth = 0;
	}
}

static void print_goal_data(Goal *g, String *buffer){
	change_assert(g, "Got invalid goal when printing...\n");

	char start_date[128];
	char end_date[128];
	char *esc_title = NULL;
	char *esc_extra_info = NULL;

	snprintf(start_date, sizeof(start_date), "%s", g->start_date ? change_ctime(&g->start_date) : "not started");
	snprintf(end_date, sizeof(end_date), "%s", g->end_date ? change_ctime(&g->end_date) : "not ended");
	start_date[strcspn(start_date, "\n")] = '\0';
	end_date[strcspn(end_date, "\n")] = '\0';

	esc_title = json_escape_dup(g->title.p ? g->title.p : "");
	esc_extra_info = json_escape_dup(g->extra_info.p ? g->extra_info.p : "");
	change_assert(esc_title && esc_extra_info, "Could not escape goal data.\n");

	CatTemplateString(buffer,
			"{\"title\":\"%s\",\"goal_id\":\"%s\",\"localIndex\":%zu,\"depth\":%zu,\"required_time\":%lld,\"start_date\":\"%s\",\"end_date\":\"%s\",\"extra_info\":\"%s\"",
			esc_title,
			g->id,
			g->localIndex,
			g->depth,
			(long long)CalcGoalRequiredTime(g),
			start_date,
			end_date,
			esc_extra_info
		);

	if (g->subgoals_len > 0){
		CatFixed(buffer, ",\"children\":[");
		for (size_t i = 0; i < g->subgoals_len; i++){
			print_goal_data(FindGoalFromIndex(g->journey_id, g->subgoals[i]), buffer);
			if (i < g->subgoals_len - 1) CatFixed(buffer, ",");
		}
		CatFixed(buffer, "]");
	}

	if (g->start_date && !g->end_date)
		CatFixed(buffer, ", \"status\" : \"Warning: this goal is currently active.\"");

	if (!g->start_date && !g->end_date){
		size_t prev_index = g->prev;
		Goal *prev = FindGoalFromIndex(g->journey_id, prev_index);
		if (prev && prev->start_date && prev->end_date){
			CatFixed(buffer, ", \"status\" : \"Warning: this goal is next due.\"");
		}
	}
	

	CatFixed(buffer, "}");

	free(esc_extra_info);
	free(esc_title);
}

static void free_goal_tree_and_clear_container_jid(Goal *g, const char *jid)
{
	if (!g) return;

	const char *effective_jid = (g->journey_id[0]) ? g->journey_id : jid;

	for (size_t i = 0; i < g->subgoals_len; i++)
		free_goal_tree_and_clear_container_jid(FindGoalFromIndex(effective_jid, g->subgoals[i]), effective_jid);

	if (g->title.p)
		FreeString(&g->title);
	if (g->extra_info.p)
		FreeString(&g->extra_info);
	free(g->subgoals);

	RemoveGoalFromJourneys(g);
	free(g);
}

static void free_goal_tree_and_clear_container(Goal *g)
{
	free_goal_tree_and_clear_container_jid(g, g ? g->journey_id : "");
}

/* Move new_root from its temporary creation slot to the freed old slot. */
static void swap_goal_slot(Journey *j, Goal *g, size_t old_index, size_t new_original_index)
{
	if (!j) return;
	j->goals[old_index - 1] = g;
	if (new_original_index != old_index && new_original_index <= j->goals_count)
		j->goals[new_original_index - 1] = NULL;
}

static GoalProgressSnapshot *snapshot_goal_progress_tree(Goal *g)
{
	change_assert(g, "Cannot snapshot NULL goal.\n");

	GoalProgressSnapshot *snapshot = calloc(1, sizeof(GoalProgressSnapshot));
	change_assert(snapshot, "Could not allocate goal progress snapshot.\n");

	InitString(&snapshot->title, g->title.len + 1);
	CopyString(&snapshot->title, &g->title);

	snapshot->start_date = g->start_date;
	snapshot->end_date = g->end_date;
	snapshot->child_count = g->subgoals_len;

	if (snapshot->child_count > 0) {
		snapshot->children = calloc(snapshot->child_count, sizeof(GoalProgressSnapshot *));
		change_assert(snapshot->children, "Could not allocate goal progress snapshot children.\n");

		for (size_t i = 0; i < snapshot->child_count; i++) {
			Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
			change_assert(child, "Broken child while snapshotting goal progress.\n");
			snapshot->children[i] = snapshot_goal_progress_tree(child);
		}
	}

	return snapshot;
}

static void free_goal_progress_snapshot(GoalProgressSnapshot *snapshot)
{
	if (!snapshot) return;

	for (size_t i = 0; i < snapshot->child_count; i++)
		free_goal_progress_snapshot(snapshot->children[i]);

	free(snapshot->children);
	FreeString(&snapshot->title);
	free(snapshot);
}

static _Bool next_goal_title_token(const char *text, size_t *cursor, char out[64])
{
	size_t w = 0;

	while (text[*cursor] && !isalnum((unsigned char)text[*cursor]))
		(*cursor)++;

	if (!text[*cursor])
		return 0;

	while (text[*cursor] && isalnum((unsigned char)text[*cursor])) {
		if (w + 1 < 64)
			out[w++] = (char)tolower((unsigned char)text[*cursor]);
		(*cursor)++;
	}

	out[w] = '\0';
	return w > 0;
}

static _Bool normalized_goal_titles_equal(const char *a, const char *b)
{
	size_t ia = 0, ib = 0;
	char ta[64], tb[64];

	while (1) {
		_Bool ha = next_goal_title_token(a, &ia, ta);
		_Bool hb = next_goal_title_token(b, &ib, tb);

		if (!ha || !hb)
			return ha == hb;

		if (strcmp(ta, tb) != 0)
			return 0;
	}
}

static int count_shared_goal_title_tokens(const char *a, const char *b)
{
	size_t ia = 0;
	char ta[64];
	int shared = 0;

	while (next_goal_title_token(a, &ia, ta)) {
		size_t ib = 0;
		char tb[64];

		while (next_goal_title_token(b, &ib, tb)) {
			if (strcmp(ta, tb) == 0) {
				shared++;
				break;
			}
		}
	}

	return shared;
}

static _Bool first_goal_title_token_equal(const char *a, const char *b)
{
	size_t ia = 0, ib = 0;
	char ta[64], tb[64];

	if (!next_goal_title_token(a, &ia, ta) || !next_goal_title_token(b, &ib, tb))
		return 0;

	return strcmp(ta, tb) == 0;
}

static int goal_progress_match_score(const GoalProgressSnapshot *old_snapshot, Goal *new_goal, size_t old_index, size_t new_index)
{
	int shared = count_shared_goal_title_tokens(old_snapshot->title.p, new_goal->title.p);
	int score = shared * 10;

	if (normalized_goal_titles_equal(old_snapshot->title.p, new_goal->title.p))
		score += 100;

	if (first_goal_title_token_equal(old_snapshot->title.p, new_goal->title.p))
		score += 15;

	if (old_snapshot->child_count == new_goal->subgoals_len)
		score += 8;

	if (old_index == new_index)
		score += 8;
	else if (ABS((int)old_index - (int)new_index) == 1)
		score += 3;

	return score;
}

static void copy_goal_progress_state(Goal *dst, const GoalProgressSnapshot *src)
{
	if (src->end_date != 0) {
		dst->start_date = src->start_date;
		dst->end_date = src->end_date;
		return;
	}

	if (src->start_date != 0) {
		dst->start_date = src->start_date;
		dst->end_date = 0;
	}
}

static void clear_goal_progress_subtree(Goal *g)
{
	if (!g)
		return;

	g->start_date = 0;
	g->end_date = 0;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		change_assert(child, "Broken child while clearing invalid repaired progress.\n");
		clear_goal_progress_subtree(child);
	}
}

static _Bool all_goal_children_finished(Goal *g)
{
	if (!g || g->subgoals_len == 0)
		return 0;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		change_assert(child, "Broken child while checking parent completion.\n");
		if (!child->end_date)
			return 0;
	}

	return 1;
}

static void refresh_goal_completion_from_children_upwards(Goal *g, time_t now)
{
	while (g) {
		if (g->subgoals_len > 0 && all_goal_children_finished(g)) {
			if (!g->start_date)
				g->start_date = now;
			g->end_date = now;
		}

		if (g->parent == 0)
			break;

		g = FindGoalFromIndex(g->journey_id, g->parent);
		change_assert(g, "Broken parent while refreshing completion from children.\n");
	}
}

static int goal_progress_status(Goal *g)
{
	if (!g)
		return 0;

	if (g->end_date)
		return 2;

	if (g->start_date)
		return 1;

	return 0;
}

static _Bool subtree_has_any_progress(Goal *g)
{
	if (!g)
		return 0;

	if (g->start_date || g->end_date)
		return 1;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		change_assert(child, "Broken child while checking subtree progress.\n");
		if (subtree_has_any_progress(child))
			return 1;
	}

	return 0;
}

static time_t subtree_earliest_progress_time(Goal *g)
{
	time_t best = 0;

	if (!g)
		return 0;

	if (g->start_date)
		best = g->start_date;
	else if (g->end_date)
		best = g->end_date;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		change_assert(child, "Broken child while computing earliest subtree progress time.\n");
		time_t child_best = subtree_earliest_progress_time(child);
		if (child_best && (!best || child_best < best))
			best = child_best;
	}

	return best;
}

static time_t subtree_latest_end_time(Goal *g)
{
	time_t best = 0;

	if (!g)
		return 0;

	if (g->end_date)
		best = g->end_date;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		change_assert(child, "Broken child while computing latest subtree end time.\n");
		time_t child_best = subtree_latest_end_time(child);
		if (child_best > best)
			best = child_best;
	}

	return best;
}

static void normalize_goal_progress_order_recursive(Goal *g)
{
	if (!g)
		return;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		change_assert(child, "Broken child while normalizing repaired progress.\n");
		normalize_goal_progress_order_recursive(child);
	}

	_Bool sequence_locked = 0;
	_Bool any_progress = 0;
	_Bool all_children_finished = g->subgoals_len > 0;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		change_assert(child, "Broken child while enforcing repaired sequence order.\n");

		int status = goal_progress_status(child);
		if (sequence_locked && status != 0) {
			clear_goal_progress_subtree(child);
			status = 0;
		}

		if (status == 2) { // ended 
			any_progress = 1;
			continue;
		}

		if (status == 1) { // started
			any_progress = 1;
			sequence_locked = 1;
			all_children_finished = 0;
			continue;
		}

		if (subtree_has_any_progress(child)) {
			clear_goal_progress_subtree(child);
		}

		sequence_locked = 1;
		all_children_finished = 0;
	}

	if (g->subgoals_len == 0)
		return;

	if (all_children_finished) {
		time_t earliest = subtree_earliest_progress_time(g);
		time_t latest = subtree_latest_end_time(g);
		if (earliest && !g->start_date)
			g->start_date = earliest;
		if (latest)
			g->end_date = latest;
		return;
	}

	g->end_date = 0;
	if (!any_progress)
		return;

	if (!g->start_date) {
		time_t earliest = subtree_earliest_progress_time(g);
		if (earliest)
			g->start_date = earliest;
	}
}

static void transfer_goal_progress_recursive(Goal *new_goal, const GoalProgressSnapshot *old_snapshot, int parent_score)
{
	change_assert(new_goal && old_snapshot, "Cannot transfer progress from/to NULL goal state.\n");

	if (parent_score >= 18)
		copy_goal_progress_state(new_goal, old_snapshot);

	if (old_snapshot->child_count == 0 || new_goal->subgoals_len == 0)
		return;

	_Bool *used_old = calloc(old_snapshot->child_count, sizeof(_Bool));
	change_assert(used_old, "Could not allocate repair progress matcher state.\n");

	for (size_t new_i = 0; new_i < new_goal->subgoals_len; new_i++) {
		Goal *new_child = FindGoalFromIndex(new_goal->journey_id, new_goal->subgoals[new_i]);
		change_assert(new_child, "Broken new child while transferring repaired progress.\n");

		int best_score = -1;
		size_t best_old_i = 0;

		for (size_t old_i = 0; old_i < old_snapshot->child_count; old_i++) {
			if (used_old[old_i]) continue;

			int score = goal_progress_match_score(old_snapshot->children[old_i], new_child, old_i, new_i);
			if (score > best_score) {
				best_score = score;
				best_old_i = old_i;
			}
		}

		if (best_score >= 18) {
			used_old[best_old_i] = 1;
			transfer_goal_progress_recursive(new_child, old_snapshot->children[best_old_i], best_score);
		}
	}

	free(used_old);
}

static void rebase_goal_tree_jid(Goal *g, size_t parent_index, size_t depth, const char *jid)
{
	change_assert(g, "Cannot rebase NULL goal tree.\n");

	const char *effective_jid = (g->journey_id[0]) ? g->journey_id : jid;
	g->parent = parent_index;
	g->depth = depth;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(effective_jid, g->subgoals[i]);
		change_assert(child, "Broken child while rebasing repaired goal branch.\n");
		rebase_goal_tree_jid(child, g->localIndex, depth + 1, effective_jid);
	}
}

static void rebase_goal_tree(Goal *g, size_t parent_index, size_t depth)
{
	rebase_goal_tree_jid(g, parent_index, depth, g ? g->journey_id : "");
}

static void append_repair_history(Goal *new_branch, String *reason, String *old_goals_data, String *ds_out)
{
	time_t now = change_time_now();

	CatTemplateString(
		&new_branch->extra_info,
		"\n\n[Repaired on %s: %s]",
		change_ctime(&now),
		reason && reason->p ? reason->p : ""
		);
}

static void dump_goal_repair_failure_context(
	Goal *old_branch,
	size_t round_count,
	String *reason,
	String *old_goals_data,
	String *failure_reason_history,
	String *generation_feedback,
	String *last_ds_out,
	String *last_candidate
) {
	time_t now = change_time_now();
	char path[512];
	char title_slug[128];
	size_t w = 0;

	for (size_t i = 0; old_branch && i < old_branch->title.len && w + 1 < sizeof(title_slug); i++) {
		unsigned char ch = (unsigned char)old_branch->title.p[i];
		if (isalnum(ch)) {
			title_slug[w++] = (char)tolower(ch);
		} else if ((ch == ' ' || ch == '-' || ch == '_') && w > 0 && title_slug[w - 1] != '_') {
			title_slug[w++] = '_';
		}
	}
	if (w == 0) {
		memcpy(title_slug, FSTRING_SIZE_PARAMS("goal"));
		w = FSIZE("goal");
	}
	title_slug[w] = '\0';

	snprintf(
		path,
		sizeof(path),
		DEFAULT_DUMP_DIRECTORY "goal_repair_failure_%lld_%s.log",
		(long long)now,
		title_slug
	);

	String dump; InitString(&dump, 4096);
	CatTemplateString(
		&dump,
		"GOAL REPAIR FAILURE DUMP\n"
		"round_count=%zu\n"
		"goal_id=%s\n"
		"goal_title=%s\n"
		"user_reason=%s\n\n"
		"GENERATION_FEEDBACK\n%s\n\n"
		"JUDGE_FAILURE_HISTORY\n%s\n\n"
		"OLD_BRANCH\n%s\n\n"
		"LAST_DEEP_SEARCH_CONTEXT\n%s\n\n"
		"LAST_CANDIDATE\n%s\n",
		round_count,
		old_branch ? old_branch->id : "",
		old_branch ? old_branch->title.p : "",
		reason && reason->p ? reason->p : "",
		generation_feedback && generation_feedback->p ? generation_feedback->p : "",
		failure_reason_history && failure_reason_history->p ? failure_reason_history->p : "",
		old_goals_data && old_goals_data->p ? old_goals_data->p : "",
		last_ds_out && last_ds_out->p ? last_ds_out->p : "",
		last_candidate && last_candidate->p ? last_candidate->p : ""
	);

	dump_to_file(path, dump.p, dump.len);
	FreeString(&dump);
}

static void replace_goal_branch(Goal *old_branch, Goal *new_branch, GoalProgressSnapshot *old_progress, String *reason, String *old_goals_data, String *ds_out, User *user)
{
	size_t old_index = old_branch->localIndex;
	size_t old_parent = old_branch->parent;
	size_t old_prev = old_branch->prev;
	size_t old_next = old_branch->next;
	size_t old_depth = old_branch->depth;
	size_t old_retry_depth = old_branch->retry_depth;
	size_t old_priority = old_branch->priority;
	time_t old_start_date = old_branch->start_date;
	time_t old_end_date = old_branch->end_date;
	time_t old_min_pause = old_branch->minPauseToNext;
	time_t old_pause = old_branch->pauseToNext;
	goalIDType old_id;

	/* Save the journey before old_branch is freed. */
	Goal *old_root = CalcGoalRoot(old_branch);
	Journey *target_journey = (old_root && old_root->journey_id[0]) ? FindJourneyByID(old_root->journey_id) : NULL;

	memcpy(old_id, old_branch->id, sizeof(old_id));

	size_t new_original_index = new_branch->localIndex;

	free_goal_tree_and_clear_container(old_branch);

	new_branch->localIndex = old_index;
	new_branch->parent = old_parent;
	new_branch->prev = old_prev;
	new_branch->next = old_next;
	new_branch->depth = old_depth;
	new_branch->retry_depth = old_retry_depth;
	new_branch->priority = old_priority;
	new_branch->start_date = old_start_date;
	new_branch->end_date = old_end_date;
	new_branch->minPauseToNext = old_min_pause;
	new_branch->pauseToNext = old_pause;
	memcpy(new_branch->id, old_id, sizeof(new_branch->id));
	new_branch->id[GOAL_ID_SIZE] = '\0';

	Goal *parent = FindGoalFromIndex(target_journey ? target_journey->id : NULL, old_parent);
	if (parent) {
		for (size_t i = 0; i < parent->subgoals_len; i++) {
			if (parent->subgoals[i] == old_index || parent->subgoals[i] == new_original_index)
				parent->subgoals[i] = old_index;
		}
	}

	Goal *prev = FindGoalFromIndex(target_journey ? target_journey->id : NULL, old_prev);
	if (prev)
		prev->next = old_index;

	Goal *next = FindGoalFromIndex(target_journey ? target_journey->id : NULL, old_next);
	if (next)
		next->prev = old_index;

	rebase_goal_tree(new_branch, old_parent, old_depth);
	if (old_progress)
		transfer_goal_progress_recursive(new_branch, old_progress, 100);
	normalize_goal_progress_order_recursive(new_branch);
	refresh_goal_completion_from_children_upwards(new_branch, change_time_now());
	append_repair_history(new_branch, reason, old_goals_data, ds_out);
	CalcGoalRequiredTime(new_branch);

	if (target_journey)
		swap_goal_slot(target_journey, new_branch, old_index, new_original_index);

	UserProfileRecordGoalEvent(user, "goal_repaired", new_branch, reason && reason->p ? reason->p : "");

	user->schedule_needs_refresh = 1;
	user->goal_health_needs_refresh = 1;
}

static void build_goal_repair_ds_prompt(
	Goal *old_branch,
	String *reason,
	String *old_goals_data,
	String *failure_reason_history,
	String *prompt
) {
	String user_history;
	String same_layer;
	String parent_chain;
	String linked_siblings;
	String parent_siblings;

	InitString(&user_history, 4096);
	InitString(&same_layer, 2048);
	InitString(&parent_chain, 2048);
	InitString(&linked_siblings, 2048);
	InitString(&parent_siblings, 2048);

	SerializeUserGoalHistoryUpTo(old_branch, &user_history, 30);
	SerializeSlibingGoals(old_branch, &same_layer);
	SerializeGoalParentChain(old_branch, &parent_chain);
	SerializeGoalLinkedSlibingsChain(old_branch, &linked_siblings, 1);
	SerializeGoalParentSlibings(old_branch, &parent_siblings, 1);

	CatTemplateString(
		prompt,
		"You are investigating how to repair an existing goal branch for this specific user. "
		"The user's requested change is: [%s]. "
		"Current branch, including progress state and children: [%s]. "
		"Previous failed repair attempts and judge feedback: [%s]. "
		"Local user goal history before this branch: [%s]. "
		"Sibling goals at the same layer: [%s]. "
		"Parent goal chain: [%s]. "
		"Linked previous/follow-up goals around this branch: [%s]. "
		"Parent sibling/uncle context: [%s]. "
		"Use the identity graph, goal history, due goals, decomposition, relational goal context, and schedule evidence as needed. "
		"Produce a compact but evidence-grounded repair context report for a downstream goal-creation agent. "
		"The report must explain what should change, what must stay aligned with the parent/sibling structure, and what progress has already happened. "
		"Do not create the final goal tree yourself. Do not invent unsupported user traits. "
		"When using deep-search goal commands that require goal ids, use only exact runtime ids explicitly observed in command output. Never substitute a goal title, branch label, or summary into a goal_id field. "
		"If you do not have an exact runtime goal id yet, prefer other commands until you do. "
		"Critical progress rule: completed work in the old branch must be treated as retained foundation, not as future work to repeat; active unfinished work should be adapted or continued rather than discarded unless the user request explicitly invalidates it. "
		"End with clear practical constraints for the replacement branch.",
		reason && reason->p ? reason->p : "",
		old_goals_data && old_goals_data->p ? old_goals_data->p : "",
		failure_reason_history && failure_reason_history->p ? failure_reason_history->p : "",
		user_history.p,
		same_layer.p,
		parent_chain.p,
		linked_siblings.p,
		parent_siblings.p
	);

	FreeString(&parent_siblings);
	FreeString(&linked_siblings);
	FreeString(&parent_chain);
	FreeString(&same_layer);
	FreeString(&user_history);
}

static void build_goal_repair_creation_inputs(
	Goal *old_branch,
	String *reason,
	String *old_goals_data,
	String *ds_out,
	String *generation_feedback,
	String *prompt,
	String *feedback
) {
	CatTemplateString(
		prompt,
		"You are creating the replacement root goal payload for an already-investigated goal branch repair. "
		"Return JSON only with title, extrainfo, estimated_time, and priority. "
		"Existing branch title: [%s]. "
		"User requested repair/change: [%s]. "
		"Old branch with progress and structure: [%s]. "
		"Deep-search repair context: [%s]. "
		"Previous judge/generation correction feedback: [%s]. "
		"Server retry feedback: [%s]. "
		"Create a coherent replacement branch root goal that satisfies the requested change, stays compatible with parent/sibling context, and preserves already completed work as retained progress. "
		"The output is user-facing goal content, not an architectural summary. "
		"It must define the actual practice loop itself, not describe the repair process. "
		"Do not write meta language such as preserve structure, keep the same branch, replace semantics, handoff order, unchanged architecture, adapted work, or downstream linkage unless translated into the actual user activity. "
		"The first sentence of extrainfo must describe one concrete run of the loop itself. "
		"For this YouTube-style case, that means a specific watch-pause-rewind-apply-check learning loop, not a generic statement about learning. "
		"The root goal must stay concrete and narrow enough that its later children can refine it, rather than repeating structural instructions. "
		"The title must be short, concrete, and action-oriented. "
		"The extrainfo must summarize the concrete loop, success condition, excluded scope, and only the minimum constraints needed for later decomposition. "
		"Do not plan completed old work as future work again. If old active work is still relevant, continue or adapt it instead of dropping it. "
		"estimated_time must be a positive realistic elapsed-time estimate in seconds for the remaining replacement branch, not the already-completed old work. "
		"Do not use 0. "
		"priority must be an integer from 0 to 5. Use 0 when the existing branch priority should be preserved.",
			old_branch->title.p,
			reason && reason->p ? reason->p : "",
			old_goals_data && old_goals_data->p ? old_goals_data->p : "",
			ds_out && ds_out->p ? ds_out->p : "",
			generation_feedback && generation_feedback->p ? generation_feedback->p : "",
			feedback && feedback->p ? feedback->p : ""
	);
}

static void build_goal_repair_judge_prompt(
	String *reason,
	String *old_goals_data,
	String *new_branch_ser,
	String *ds_out,
	String *failure_reason_history,
	String *prompt
) {
	CatTemplateString(
		prompt,
		"You are judging whether a regenerated goal branch is acceptable. "
		"Return JSON only. "
		"User requested branch change: [%s]. "
		"Original branch, including status/progress: [%s]. "
		"Deep-search context used by the generator: [%s]. "
		"Candidate replacement branch: [%s]. "
		"Previous failed candidate feedback: [%s]. "
		"Pass if the candidate reasonably addresses the user's requested change, remains compatible with the old branch's parent/sibling role, and uses the deep-search context enough to be personalized. "
		"Pass if the candidate preserves completed progress as foundation and does not obviously force the user to redo completed old work. "
		"Pass only if the candidate defines an actual concrete goal/loop rather than mostly restating repair instructions, branch structure, handoff order, or abstract constraints. "
		"Do not be overly restrictive: this repair flow is expensive and the candidate only needs to be directionally correct, coherent, and safe to decompose further. "
		"Fail for major drift, ignoring the user request, losing or contradicting important progress, incoherent scope, clear mismatch with parent/sibling constraints, or outputs that are mostly meta-commentary instead of the actual repaired branch content. "
		"When failing, feedback must be one concise actionable correction under 40 words. "
		"When passing, feedback must be an empty string.",
		reason && reason->p ? reason->p : "",
		old_goals_data && old_goals_data->p ? old_goals_data->p : "",
		ds_out && ds_out->p ? ds_out->p : "",
		new_branch_ser && new_branch_ser->p ? new_branch_ser->p : "",
		failure_reason_history && failure_reason_history->p ? failure_reason_history->p : ""
	);
}

static _Bool parse_goal_payload_json(String *payload, String *title, String *extra_info, time_t *estimated_time, size_t *priority, String *feedback)
{
	_Bool got_title = 0;
	_Bool got_extra_info = 0;
	_Bool got_estimated_time = 0;

	InitString(title, 256);
	InitString(extra_info, 1024);
	*estimated_time = 0;
	if (priority)
		*priority = 0;

	json_value *doc = json_parse(payload->p, payload->len);
	if (!doc || doc->type != json_object) {
		if (feedback)
			CatFixed(feedback, "Goal payload was not a JSON object.");
		if (doc) json_value_free(doc);
		return 0;
	}

	for (size_t i = 0; i < doc->u.object.length; i++) {
		json_object_entry entry = doc->u.object.values[i];

		if (strcmp(entry.name, "title") == 0) {
			if (entry.value->type != json_string) {
				if (feedback)
					CatFixed(feedback, "title must be a string.");
				json_value_free(doc);
				return 0;
			}
			CatString(title, entry.value->u.string.ptr, entry.value->u.string.length);
			got_title = 1;
		} else if (strcmp(entry.name, "extrainfo") == 0) {
			if (entry.value->type != json_string) {
				if (feedback)
					CatFixed(feedback, "extrainfo must be a string.");
				json_value_free(doc);
				return 0;
			}
			CatString(extra_info, entry.value->u.string.ptr, entry.value->u.string.length);
			got_extra_info = 1;
		} else if (strcmp(entry.name, "estimated_time") == 0) {
			if (entry.value->type != json_integer) {
				if (feedback)
					CatFixed(feedback, "estimated_time must be an integer.");
				json_value_free(doc);
				return 0;
			}
			*estimated_time = (time_t)entry.value->u.integer;
			got_estimated_time = 1;
		} else if (strcmp(entry.name, "priority") == 0) {
			if (entry.value->type == json_null) {
				if (priority)
					*priority = 0;
			} else if (entry.value->type == json_integer) {
				if (priority)
					*priority = (size_t)CLAMP(0, 5, entry.value->u.integer);
			} else {
				if (feedback)
					CatFixed(feedback, "priority must be an integer from 0 to 5.");
				json_value_free(doc);
				return 0;
			}
		}
	}

	json_value_free(doc);

	if (!got_title || title->len < 3) {
		if (feedback)
			CatFixed(feedback, "title is missing or too short.");
		return 0;
	}

	if (!got_extra_info || extra_info->len < 10) {
		if (feedback)
			CatFixed(feedback, "extrainfo is missing or too short.");
		return 0;
	}

	if (!got_estimated_time || *estimated_time <= 0) {
		if (feedback)
			CatFixed(feedback, "estimated_time is missing, zero, or negative.");
		return 0;
	}

	return 1;
}

static Goal *create_goal_raw(goalIDType goalId, String *title, String *extra_info, time_t estimated_time, size_t priority, const char *journey_id)
{
	GoalSystemLazyLoad(&goal_emit);

	goal_emit(goalId, "title", title->p, title->len);
	goal_emit(goalId, "extra-info", extra_info->p, extra_info->len);

	char total_time_buff[32] = {0};
	size_t len = snprintf(total_time_buff, sizeof(total_time_buff), "%ld", (long)estimated_time);
	change_assert(len < sizeof(total_time_buff), "time buffer too small\n");
	goal_emit(goalId, "time", total_time_buff, len);

	Goal *created = CreateGoal(goalId, title, extra_info, estimated_time, 0, 1, journey_id);
	created->priority = CLAMP(0, 5, priority);
	char priority_buff[16] = {0};
	len = snprintf(priority_buff, sizeof(priority_buff), "%zu", created->priority);
	change_assert(len < sizeof(priority_buff), "priority buffer too small\n");
	goal_emit(goalId, "priority", priority_buff, len);

	return created;
}

static _Bool request_goal_payload_from_prompt(String *prompt, String *title, String *extra_info, time_t *estimated_time, size_t *priority, String *feedback)
{
	ai_gpt_request req = {0};
	req.prompt = *prompt;
	req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
	req.schema_name = "goal_repair_payload";
	InitString(&req.schema, sizeof(OPENAI_GOAL_EXTRACT_SCHEMA_JSON) + 1);
	CatString(&req.schema, FSTRING_SIZE_PARAMS(OPENAI_GOAL_EXTRACT_SCHEMA_JSON));

	String *result = ai_openai_call_gpt_request(&req);
	change_assert(result, "OpenAI goal repair payload call failed.\n");

	_Bool success = parse_goal_payload_json(result, title, extra_info, estimated_time, priority, feedback);

	FreeString(&req.schema);
	FreeString(result);
	free(result);

	return success;
}

static void build_goal_repair_child_creation_prompt(
	Goal *old_child,
	Goal *new_parent,
	String *reason,
	String *ds_out,
	String *generation_feedback,
	size_t child_index,
	size_t child_count,
	String *prompt,
	String *feedback
) {
	String old_child_data;
	String sibling_titles;

	InitString(&old_child_data, 2048);
	InitString(&sibling_titles, 1024);

	print_goal_data(old_child, &old_child_data);

	Goal *old_parent = FindGoalFromIndex(old_child->journey_id, old_child->parent);
	if (old_parent) {
		for (size_t i = 0; i < old_parent->subgoals_len; i++) {
			Goal *sibling = FindGoalFromIndex(old_parent->journey_id, old_parent->subgoals[i]);
			if (!sibling)
				continue;

			CatTemplateString(&sibling_titles, "[%zu/%zu] %s", i + 1, old_parent->subgoals_len, sibling->title.p);
			if (i + 1 < old_parent->subgoals_len)
				CatFixed(&sibling_titles, ", ");
		}
	}

	CatTemplateString(
		prompt,
		"You are creating one child goal payload for a repaired goal branch. "
		"Return JSON only with title, extrainfo, estimated_time, and priority. "
		"User requested repair/change: [%s]. "
		"Deep-search repair context: [%s]. "
		"Previous judge/generation correction feedback: [%s]. "
		"Repaired parent goal title: [%s]. "
		"Repaired parent extra_info: [%s]. "
		"Original child slot to rewrite: [%s]. "
		"Original sibling ordering for this level: [%s]. "
		"This child must remain position %zu of %zu and keep the same role in the sequence, only retargeted to the repaired concept. "
		"The output is user-facing goal content, not an architectural summary. "
		"Do not write meta language such as preserve structure, same branch, handoff order, unchanged architecture, or adapted work. "
		"If this child was already completed or active in the old branch, describe the same responsibility in repaired terms so progress can map onto it; do not invent a different responsibility. "
		"Keep the same abstraction level as the original child. "
		"If the original child had descendants, keep this child broad enough to still own them; if it was a leaf, keep it leaf-level and concrete. "
		"estimated_time must be a positive realistic elapsed-time estimate in seconds for this child only. "
		"priority must be 0 for child goals because only root goal priority is used.",
		reason && reason->p ? reason->p : "",
		ds_out && ds_out->p ? ds_out->p : "",
		generation_feedback && generation_feedback->p ? generation_feedback->p : "",
		new_parent ? new_parent->title.p : "",
		new_parent ? new_parent->extra_info.p : "",
		old_child_data.p,
		sibling_titles.p,
		child_index + 1,
		child_count
	);

	if (feedback && feedback->len > 0)
		CatTemplateString(prompt, " Server retry feedback: [%s].", feedback->p);

	FreeString(&sibling_titles);
	FreeString(&old_child_data);
}

static Goal *create_repaired_goal_subtree_from_template(
	Goal *old_template,
	Goal *new_goal,
	String *reason,
	String *ds_out,
	String *generation_feedback,
	const char *journey_id
) {
	if (!old_template || !new_goal || old_template->subgoals_len == 0)
		return new_goal;

	size_t child_count = old_template->subgoals_len;
	size_t *subgoal_indexes = malloc(sizeof(size_t) * child_count);
	change_assert(subgoal_indexes, "Could not allocate repaired subgoal index array.\n");

	Goal *previous = NULL;

	for (size_t i = 0; i < child_count; i++) {
		Goal *old_child = FindGoalFromIndex(old_template->journey_id, old_template->subgoals[i]);
		change_assert(old_child, "Broken old child while rebuilding repaired branch scaffold.\n");

		goalIDType child_goal_id;
		random_id(child_goal_id, GOAL_ID_SIZE + 1);
		child_goal_id[GOAL_ID_SIZE] = '\0';

		String feedback; InitString(&feedback, 512);
		Goal *new_child = NULL;

		for (size_t depth = 0; depth < 10; depth++) {
			String prompt; InitString(&prompt, ds_out->len + old_child->extra_info.len + new_goal->extra_info.len + (reason ? reason->len : 0) + feedback.len + 4096);
			build_goal_repair_child_creation_prompt(old_child, new_goal, reason, ds_out, generation_feedback, i, child_count, &prompt, &feedback);

			String title;
			String extra_info;
			time_t estimated_time = 0;
			size_t priority = 0;
			EmptyString(&feedback);

			_Bool success = request_goal_payload_from_prompt(&prompt, &title, &extra_info, &estimated_time, &priority, &feedback);
			FreeString(&prompt);

			if (!success) {
				FreeString(&title);
				FreeString(&extra_info);
				continue;
			}

			new_child = create_goal_raw(child_goal_id, &title, &extra_info, estimated_time, 0, journey_id);
			new_child->parent = new_goal->localIndex;
			new_child->depth = new_goal->depth + 1;
			new_child->minPauseToNext = old_child->minPauseToNext;
			new_child->pauseToNext = old_child->pauseToNext;

			FreeString(&title);
			FreeString(&extra_info);
			break;
		}

		change_assert(new_child, "Could not create repaired child payload for [%s].\n", old_child->title.p);

		subgoal_indexes[i] = new_child->localIndex;

		if (previous)
			link_goals(previous, new_child);
		previous = new_child;

		create_repaired_goal_subtree_from_template(old_child, new_child, reason, ds_out, generation_feedback, journey_id);
		FreeString(&feedback);
	}

	new_goal->subgoals = subgoal_indexes;
	new_goal->subgoals_len = child_count;
	CalcGoalRequiredTime(new_goal);

	return new_goal;
}

static Goal *create_goal_from_repair_context(
	Goal *old_branch,
	String *reason,
	String *old_goals_data,
	String *ds_out,
	String *generation_feedback,
	const char *journey_id
) {
	goalIDType goalId;
	random_id(goalId, GOAL_ID_SIZE + 1);
	goalId[GOAL_ID_SIZE] = '\0';

	String feedback; InitString(&feedback, 512);

	for (size_t depth = 0; depth < 10; depth++) {
		String prompt; InitString(&prompt, old_goals_data->len + ds_out->len + (reason ? reason->len : 0) + feedback.len + 2048);
		build_goal_repair_creation_inputs(old_branch, reason, old_goals_data, ds_out, generation_feedback, &prompt, &feedback);

		String title;
		String extra_info;
		time_t estimated_time = 0;
		size_t priority = 0;
		EmptyString(&feedback);

		_Bool success = request_goal_payload_from_prompt(&prompt, &title, &extra_info, &estimated_time, &priority, &feedback);
		FreeString(&prompt);

		if (success) {
			Goal *created = create_goal_raw(goalId, &title, &extra_info, estimated_time, priority, journey_id);
			create_repaired_goal_subtree_from_template(old_branch, created, reason, ds_out, generation_feedback, journey_id);
			FreeString(&title);
			FreeString(&extra_info);
			FreeString(&feedback);
			return created;
		}

		FreeString(&title);
		FreeString(&extra_info);
	}

	change_assert(0, "Could not create repaired goal payload after retries: %s\n", feedback.p);
	FreeString(&feedback);
	return NULL;
}

static Goal *repair_goal_branch(Goal *old_branch, String *reason, start_ds_session_like_func *start_ds_session, User *user){

	if (old_branch->subgoals_len == 0) {
		repair_goal_leaf(old_branch);
		return old_branch;
	}

	Goal *repaired_branch = NULL;
	GoalProgressSnapshot *old_progress = snapshot_goal_progress_tree(old_branch);
	String generation_feedback; InitString(&generation_feedback, 512);
	String last_ds_out; InitString(&last_ds_out, 1024);
	String last_candidate; InitString(&last_candidate, 2048);

	// Save and serialize current goal_data
	String failure_reason_history; InitString(&failure_reason_history, 256);
	
	String old_goals_data; InitString(&old_goals_data, 2048);
	CatFixed(&old_goals_data, "The current goal structure:\n");
	print_goal_data(old_branch, &old_goals_data);

	// START REPAIRING PIPELINE
	size_t depth = 0;
	while (depth < GOAL_REPAIR_MAX_JUDGE_ROUNDS){
		String prompt; InitString(&prompt, 1024);
		build_goal_repair_ds_prompt(old_branch, reason, &old_goals_data, &failure_reason_history, &prompt);

		Task t = {0};
		InitString(&t.name, prompt.len + 1);
		CopyString(&t.name, &prompt);
		t.minDepth = 5;

		String ds_out;

		start_ds_session(&t, "repair-branch-ds-session", &ds_out, user);
		FreeString(&t.name);
		CopyString(&last_ds_out, &ds_out);

		Goal *new_branch = create_goal_from_repair_context(old_branch, reason, &old_goals_data, &ds_out, &generation_feedback, old_branch->journey_id);

		String new_branch_ser; InitString(&new_branch_ser, 2048);
		CatFixed(&new_branch_ser, "New Goal Created: \n");
		print_goal_data(new_branch, &new_branch_ser);
		EmptyString(&last_candidate);
		CopyString(&last_candidate, &new_branch_ser);

		_Bool pass = 0; // map this to judge response
		ai_gpt_request judge_req = {0};
		judge_req.model = AI_OPENAI_MODEL_GPT_5_4_MINI;
		judge_req.schema_name = "goal_repair_branch_judge";
		InitString(&judge_req.schema, sizeof(OPENAI_GOAL_REPAIR_BRANCH_JUDGE_SCHEMA_JSON) + 1);
		CatString(&judge_req.schema, FSTRING_SIZE_PARAMS(OPENAI_GOAL_REPAIR_BRANCH_JUDGE_SCHEMA_JSON));
		InitString(&judge_req.prompt, old_goals_data.len + new_branch_ser.len + ds_out.len + failure_reason_history.len + (reason ? reason->len : 0) + 2048);
		build_goal_repair_judge_prompt(reason, &old_goals_data, &new_branch_ser, &ds_out, &failure_reason_history, &judge_req.prompt);

		String *result = ai_openai_call_gpt_request(&judge_req);
		change_assert(result, "OpenAI goal judge repair branch call failed.\n ");

		// parsing the judge response
		json_value *doc = json_parse(result->p, result->len);
		change_assert(doc, "Judge goal repair branch repsonse is non json");
		change_assert(doc->type == json_object, "Judge goal repair branch response is not json object");

		_Bool received_pass = 0;
		String judge_feedback; InitString(&judge_feedback, 256);

		for (size_t i = 0; i < doc->u.object.length; i++){
			json_object_entry entry = doc->u.object.values[i];

			if (strcmp(entry.name, "feedback") == 0){
				change_assert(entry.value->type == json_string, "goal reason judge repair branch feedback should be a string\n");
				CatString(&judge_feedback, entry.value->u.string.ptr, entry.value->u.string.length);
			}
			if (strcmp(entry.name, "pass") == 0){
				change_assert(entry.value->type == json_boolean, "goal reason judge reapir branch pass should be boolean\n");
				pass = entry.value->u.boolean;
				received_pass = 1;
			}
		}
		change_assert(received_pass, "Goal repair branch judge did not return pass.\n");

		if (!pass) {
			CatTemplateString(&failure_reason_history, "Round %zu, judge denied the new_branch_concept, feedback : [%s]\n", depth, judge_feedback.p);
			EmptyString(&generation_feedback);
			CatString(&generation_feedback, judge_feedback.p, judge_feedback.len);
		}

		json_value_free(doc);
		FreeString(&judge_feedback);

		FreeString(&new_branch_ser);
		FreeString(&judge_req.prompt);
		FreeString(&judge_req.schema);
		FreeString(result);
		free(result);


		if (!pass){
			free_goal_tree_and_clear_container(new_branch);
		}else{
			replace_goal_branch(old_branch, new_branch, old_progress, reason, &old_goals_data, &ds_out, user);
			repaired_branch = new_branch;

			FreeString(&ds_out);
			FreeString(&prompt);

				FreeString(&failure_reason_history);
				FreeString(&generation_feedback);
				FreeString(&last_ds_out);
				FreeString(&last_candidate);
				free_goal_progress_snapshot(old_progress);
				old_progress = NULL;
				break;
		}

		depth++;

		FreeString(&ds_out);
		FreeString(&prompt);
	}

	if (!repaired_branch)
		dump_goal_repair_failure_context(old_branch, depth, reason, &old_goals_data, &failure_reason_history, &generation_feedback, &last_ds_out, &last_candidate);
	FreeString(&old_goals_data);
	FreeString(&generation_feedback);
	FreeString(&last_ds_out);
	FreeString(&last_candidate);
	if (old_progress)
		free_goal_progress_snapshot(old_progress);

	change_assert(
		repaired_branch,
		"Goal repair could not produce an acceptable branch after %zu judge rounds. Check dumps/goal_repair_failure_*.log\n",
		depth
	);

	return repaired_branch;
}

Goal *RepairGoalBranch(Goal *old_branch, String *reason, start_ds_session_like_func *start_ds_session, User *user)
{
	change_assert(old_branch, "Cannot repair a NULL goal branch.\n");
	change_assert(reason && reason->p && reason->len > 0, "Goal repair requires a user change request.\n");
	change_assert(start_ds_session, "Goal repair requires a deep-search session function.\n");
	UserProfileRecordInput(user, "goal_repair_request", reason->p);

	return repair_goal_branch(old_branch, reason, start_ds_session, user);
}

void UpdateGoal(Goal *g, time_t now)
{
	if (!g)
		return;

	for (size_t i = 0; i < g->subgoals_len; i++)
		UpdateGoal(FindGoalFromIndex(g->journey_id, g->subgoals[i]), now);

	enum GOAL_STATUS status = ValidateGoal(g, now);

	if (status == GOAL_VALID)
		return;

	repair_goal_leaf(g);
}

void FreeGoal(Goal *g)
{
	if (!g)
		return;
	if (!g->title.p)
		return;
	for (size_t i = 0; i < g->subgoals_len; i++)
		FreeGoal(FindGoalFromIndex(g->journey_id, g->subgoals[i]));

	if (g->title.p)
		FreeString(&g->title);
	if (g->extra_info.p){
		FreeString(&g->extra_info);
	}
	if (g->subgoals){
		free(g->subgoals);
		g->subgoals = NULL;
	}
	if (g){
		free(g);
	}
}

void FreeGoals()
{
	ClearAllJourneyGoals();
}

// those are mapped to input1 -> title input2 -> extrainfo
Goal* CreateUserGoal(String *input1, String *input2, const char *journey_id, start_ds_session_like_func* start_ds_session, User *user)
{
	change_assert(input1 && input1->p, "CreateUserGoal: input1 is NULL\n");
	change_assert(start_ds_session && *start_ds_session, "CreateUserGoal: start_ds_session is NULL\n");
	change_assert(user, "CreateUserGoal: user is NULL\n");
	GoalSystemLazyLoad(&goal_emit);
	UserProfileRecordInput(user, "goal_create_request_title", input1 ? input1->p : "");
	UserProfileRecordInput(user, "goal_create_request_extrainfo", input2 ? input2->p : "");

	String title, extra_info, deep_search_result;
	time_t estimated_time = 0;
	size_t priority = 0;
	goalIDType goalId;
	random_id(goalId, GOAL_ID_SIZE + 1);
	goalId[32] = '\0';

	InitString(&deep_search_result, 2048);

	_Bool success = 0;
	size_t depth_error = 0;
	String feedback_intervention; InitString(&feedback_intervention, 512);

	while (!success){
		EmptyString(&deep_search_result);

		PersonalizeGoal(input1, input2, &deep_search_result, goalId, &feedback_intervention, start_ds_session, journey_id, user);

		goal_emit(goalId, "deep-search-final-recomandation", deep_search_result.p, deep_search_result.len);

		success = ExtractGoalFromText(&deep_search_result, &title, &extra_info, &estimated_time, &priority, 1, &feedback_intervention);

		if (estimated_time == 0){
			CatTemplateString(&feedback_intervention, "\n\nServer intervention : \"The server detected your previous response (%s) had an invalid estimate_time of 0, please consider estimated time being the total time of the goal, 0 is not allowed. Please Retry.\n\"", title.p);
			success = 0;
		}

		depth_error++;
		change_assert(depth_error < 10, "Depth went way to high");

		if (!success){
			printf("\n\nERROR WHEN EXTRACTING, WARING THIS WILL NOT SAVE : %s, %s, %zu", title.p, extra_info.p, estimated_time);
		}
	}

	FreeString(&feedback_intervention);

	Goal *created = create_goal_raw(goalId, &title, &extra_info, estimated_time, priority, journey_id);

	ComputePartialDecomposition(created, user);
	UserProfileRecordGoalEvent(user, "goal_created", created, created->extra_info.p);

	user->schedule_needs_refresh = 1;
	user->goal_health_needs_refresh = 1;

	FreeString(&title);
	FreeString(&extra_info);
	FreeString(&deep_search_result);

	return created;
}

// AI assisted function
_Bool DecomposeGoal(Goal *g, User *user){
	
	if (g->subgoals_len != 0){
		printf("Goal seems already decomposed.\n");
		return 1;
	}
	if (g->required_time < GOAL_MIN_SECONDS){
		printf("Goal si too short to decompose, shortest is 15 minutes");
		return 0;
	}

	String prompt;
	InitString(&prompt, 2048);

	SetGoalDecompositionPrompt(g, &prompt, change_time_now(), user);

	String *out = CallGoalDecompositionAI(&prompt);
	cassert(out, "Goal decomposition returned NULL.\n");

	json_value *doc = json_parse(c_str(out), out->len);
	change_assert(doc && doc->type == json_object, "Goal decomposition result is not a JSON object:\n%s\n", c_str(out));

	json_value *subgoals_json = json_object_get(doc, "subgoals");
	change_assert(subgoals_json && subgoals_json->type == json_array, "Goal decomposition JSON has no subgoals array.\n");

	size_t subgoal_count = subgoals_json->u.array.length;

	change_assert(subgoal_count >= 2, "Goal decomposition must create at least 2 subgoals.\n");
	change_assert(subgoal_count <= 9, "Goal decomposition created too many subgoals: [%zu].\n", subgoal_count);

	size_t *subgoal_indexes = malloc(sizeof(size_t) * subgoal_count);
	cassert(subgoal_indexes, "Could not allocate subgoal index array.\n");

	Goal *previous = NULL;

	for (size_t i = 0; i < subgoal_count; i++) {
		json_value *item = subgoals_json->u.array.values[i];

		String title;
		String extrainfo;
		size_t estimated_time = 0;
		time_t min_pause_to_next = 0;
		time_t pause_to_next = 0;

		ParseDecompositionSubgoal(item, &title, &extrainfo, &estimated_time, &min_pause_to_next, &pause_to_next);

		char child_goal_id[33];
		CreateSubgoalId(g, i, child_goal_id);

		Goal *child = CreateGoal(
			child_goal_id,
			&title,
			&extrainfo,
			estimated_time,
			g->localIndex,
			g->depth + 1,
			g->journey_id
		);
		child->minPauseToNext = min_pause_to_next;
		child->pauseToNext = pause_to_next;

		subgoal_indexes[i] = child->localIndex;

		if (previous)
			link_goals(previous, child);

		previous = child;

		FreeString(&title);
		FreeString(&extrainfo);
	}

	g->subgoals = subgoal_indexes;
	g->subgoals_len = subgoal_count;
	g->required_time = CalcGoalRequiredTime(g);

	json_value_free(doc);
	FreeString(&prompt);
	FreeString(out);

	printf("Goal decomposed into [%zu] subgoals.\n", subgoal_count);

	return 1;
}

// goes on the first layer deep untill the goals are less than 1 hour
Goal* ComputePartialDecomposition(Goal *goal, User *user){
	Goal* g = goal;
	while (g){
		if (g->required_time < 60 * 60) break;

		_Bool decomposition_result = DecomposeGoal(g, user);
		change_assert(decomposition_result, "Couldn't decompose goal : [%s]\n\n", g->title.p);

		// 20 min cap
		if (g->required_time < 60 * 20) break;
		size_t nextGoalIndex = g->subgoals[0]; // pick first one

		g = FindGoalFromIndex(g->journey_id, nextGoalIndex);
		change_assert(g, "Coudln't find first born after decomposition\n\n");
	}

	return g;
}


Goal* DecomposeToLeaf(Goal *g, User *user) {
	while (g->subgoals_len > 0 || g->required_time >= GOAL_MIN_SECONDS * 2) {
		if (g->subgoals_len > 0) {
			Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[0]);
			change_assert(child, "Broken subgoals[0] in DecomposeToLeaf. %s\n", child->title.p);
			g = child;
		} else {
			if (!DecomposeGoal(g, user)) break;
		}
	}
	return g;
}

static _Bool goal_is_unstarted(Goal *g) {
	return g && !g->start_date && !g->end_date;
}

static Goal* last_leaf(Goal *g) {
	if (!g) return NULL;

	while (g->subgoals_len > 0) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[g->subgoals_len - 1]);
		change_assert(child, "Broken last subgoal reference in last_leaf.\n");
		g = child;
	}

	return g;
}

static Goal* previous_timeline_leaf(Goal *g) {
	Goal *current = g;

	while (current) {
		if (current->prev) {
			Goal *prev = FindGoalFromIndex(current->journey_id, current->prev);
			change_assert(prev, "Broken prev reference in previous_timeline_leaf.\n");
			return last_leaf(prev);
		}

		if (!current->parent) return NULL;

		current = FindGoalFromIndex(current->journey_id, current->parent);
		change_assert(current, "Broken parent reference in previous_timeline_leaf.\n");
	}

	return NULL;
}

static Goal* first_unstarted_leaf(Goal *g, User *user) {
	if (!g) return NULL;

	while (g->subgoals_len == 0 &&
	       g->required_time >= GOAL_MIN_SECONDS * 2 &&
	       goal_is_unstarted(g)) {
		if (!DecomposeGoal(g, user)) break;
	}

	if (g->subgoals_len == 0)
		return goal_is_unstarted(g) ? g : NULL;

	for (size_t i = 0; i < g->subgoals_len; i++) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[i]);
		change_assert(child, "Broken subgoal reference in first_unstarted_leaf.\n");

		Goal *leaf = first_unstarted_leaf(child, user);
		if (leaf) return leaf;
	}

	return NULL;
}

static _Bool can_start_leaf(Goal *g) {
	Goal *previous;

	if (!goal_is_unstarted(g) || g->subgoals_len != 0) return 0;

	previous = previous_timeline_leaf(g);
	while (previous) {
		if (!previous->end_date) return 0;
		previous = previous_timeline_leaf(previous);
	}

	return 1;
}

static Goal* first_startable_leaf(Goal *g, User *user) {
	g = first_unstarted_leaf(g, user);
	if (!g || !can_start_leaf(g)) return NULL;
	return g;
}

Goal* StartGoalDeepFromGoal(Goal *g, User *user) {
	change_assert(g, "Goal not found in StartGoalDeepFromGoal.\n");
	g = first_startable_leaf(g, user);
	if (!g) return NULL;
	g->start_date = change_time_now();
	UserProfileRecordGoalEvent(user, "goal_started_deep", g, "deep-startable leaf selected");
	return g;
}

Goal* StartGoalDeep(goalIDType goalID, User *user) {
	Goal* g = FindGoalByID(goalID, user->journeys[0]);
	change_assert(g, "Goal not found in StartGoalDeep: %s", goalID);
	return StartGoalDeepFromGoal(g, user);
}

Goal** GetSessionGoals(size_t *out_len, User *user) {
	*out_len = 0;
	size_t goals_len = 0;
	Goal **goals = GetGoalsSorted(&goals_len, user->journeys[0]);

	Goal *seen[1024] = {0};
	size_t count = 0;
	for (size_t i = 0; i < goals_len; i++) {
		Goal *g = goals[i];
		if (!g || g->parent != 0) continue;

		g = first_startable_leaf(g, user);
		if (g) seen[count++] = g;
	}
	free(goals);

	if (count > 0) {
		Goal **out = malloc(count * sizeof(Goal*));
		change_assert(out, "GetSessionGoals: malloc failed.\n");
		for (size_t i = 0; i < count; i++)
			out[i] = seen[i];
		*out_len = count;
		return out;
	}

	return NULL;
}

time_t StartGoal(goalIDType goalID, User *user){
	Goal* g = FindGoalByID(goalID, user->journeys[0]);
	change_assert(g, "Goal not found, target goal id %s, serialized goals.", goalID);

	time_t now = change_time_now();

	g->start_date = now;
	UserProfileRecordGoalEvent(user, "goal_started", g, "manual start");

	user->schedule_needs_refresh = 1;
	user->goal_health_needs_refresh = 1;

	Journey *j = FindJourneyByID(g->journey_id);
	if (j && j->is_shared) PushJourneyToCentral(j);

	return now;
}

time_t EndGoalFromGoal(Goal *g, User *user){
	change_assert(g, "Goal not found in EndGoalFromGoal.\n");
	time_t now = change_time_now();

	if (g->subgoals_len > 0)
		change_assert(all_goal_children_finished(g), "Cannot end parent goal before all subgoals are finished.\n");

	Goal *previous = previous_timeline_leaf(g);
	while (previous) {
		change_assert(previous->end_date, "Cannot end goal before previous timeline goals are finished.\n");
		previous = previous_timeline_leaf(previous);
	}

	if (!g->start_date)
		g->start_date = now;
	g->end_date = now;
	refresh_goal_completion_from_children_upwards(g, now);
	UserProfileRecordGoalEvent(user, "goal_ended", g, "goal marked complete");

	user->schedule_needs_refresh = 1;
	user->goal_health_needs_refresh = 1;

	Journey *j = FindJourneyByID(g->journey_id);
	if (j && j->is_shared) PushJourneyToCentral(j);

	return now;
}

time_t EndGoal(goalIDType goalID, User *user){
	Goal* g = FindGoalByID(goalID, user->journeys[0]);
	change_assert(g, "Goal not found, target goal id %s, serialized goals.", goalID);

	return EndGoalFromGoal(g, user);
}

void DropGoalTree(Goal *root, User *user)
{
	change_assert(root, "DropGoalTree: root is NULL.\n");

	size_t total = 0;
	Goal **goals = GetGoalsSorted(&total, user->journeys[0]);
	time_t now = change_time_now();

	for (size_t i = 0; i < total; i++) {
		Goal *g = goals[i];
		if (!g || g->end_date != 0) continue;
		if (CalcGoalRoot(g) != root) continue;
		if (!g->start_date) g->start_date = now;
		g->end_date = now;
		UserProfileRecordGoalEvent(user, "goal_dropped", g, "goal dropped by user");
	}

	user->schedule_needs_refresh = 1;
	user->goal_health_needs_refresh = 1;
	free(goals);
}
