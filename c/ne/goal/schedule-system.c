#include "schedule-system.h"
#include "goal-info.h"
#include "goal-util.h"
#include "profile/user-profile.h"
#include "srv/user/user-management.h"
#include "srv/user/journey.h"
#include "lib/util/time-util.h"
#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/*
 * SCHEDULER
 *
 * The schedule is ONE priority-ordered queue of leaf work-sessions, laid out on
 * the wall clock. Design rules (see the data model in goal-util.h):
 *
 *   1. Dormant until started. While the user has never started ANY task, the
 *      schedule is empty. The act of starting the first task is what anchors the
 *      whole sequence to real time.
 *   2. Re-anchored on reality. The pending tail begins after the furthest-along
 *      real signal: a running task's projected end, or the latest completed
 *      task's end — never earlier than "now".
 *   3. Priority first. Higher-priority roots are scheduled before lower ones;
 *      within a root, leaves keep their fixed sequential (timeline) order.
 *   4. Day-packing is read-time only. Tasks are packed into the user's daily
 *      work window here, in the schedule table. We NEVER mutate pauseToNext to
 *      encode calendar gaps — pauseToNext stays the small intrinsic rest between
 *      sessions, so a goal's required_time (sum of child work + rests) never
 *      balloons with overnight gaps, and recompute is idempotent.
 *
 * Absolute times are recomputed on every refresh from start_date / end_date /
 * required_time / pauseToNext; nothing about placement is persisted.
 */

#define SCHED_DEFAULT_WORK_START (9 * 3600)   /* 09:00 */
#define SCHED_DEFAULT_WORK_DUR   (8 * 3600)   /* 8 hours */
#define SCHED_DAY_SECS           86400
#define SCHED_MAX_STALE_SECS     30           /* recompute at least this often */

/* ---------- work-window configuration ---------- */

static time_t parse_hhmm(const char *s, time_t def)
{
	int h = 0, m = 0;
	if (sscanf(s, "%d:%d", &h, &m) < 1) return def;
	return (time_t)(h * 3600 + m * 60);
}

static void load_work_window(User *user, time_t *work_start, time_t *work_dur)
{
	char buf[64];
	*work_start = SCHED_DEFAULT_WORK_START;
	*work_dur   = SCHED_DEFAULT_WORK_DUR;

	if (UserProfileGetDerivedField(user, "work_day_start", buf, sizeof(buf)))
		*work_start = parse_hhmm(buf, SCHED_DEFAULT_WORK_START);
	if (UserProfileGetDerivedField(user, "daily_work_hours", buf, sizeof(buf))) {
		long v = atol(buf);
		if (v > 0 && v <= 24) *work_dur = (time_t)(v * 3600);
	}
}

/* Absolute timestamp of the work-block start for the day containing `t`.
   Day boundaries use UTC, matching the rest of the codebase's day math. */
static time_t day_work_start(time_t t, time_t work_start)
{
	struct tm tmv = *gmtime(&t);
	time_t secs_into_day = (time_t)(tmv.tm_hour * 3600 + tmv.tm_min * 60 + tmv.tm_sec);
	return t - secs_into_day + work_start;   /* midnight(t) + work_start */
}

/* Place a task of length `req` at or after `cursor`, inside a daily work window.
   Pushes to the next day's work start when it doesn't fit. A task longer than a
   whole work day is placed at the window start and allowed to overflow (so we
   never loop forever on an oversized leaf). */
static time_t fit_into_window(time_t cursor, time_t req, time_t work_start, time_t work_dur)
{
	for (int guard = 0; guard < 4000; guard++) {   /* bounded ~10 years of days */
		time_t ds = day_work_start(cursor, work_start);
		time_t de = ds + work_dur;
		if (cursor < ds) cursor = ds;              /* before today's block — wait for it */
		if (req >= work_dur) return cursor;        /* can't fit any single day — accept overflow */
		if (cursor + req <= de) return cursor;     /* fits in this block */
		cursor = day_work_start(de + SCHED_DAY_SECS, work_start);  /* jump to next day */
	}
	return cursor;
}

/* ---------- collection ---------- */

typedef struct {
	Goal  *leaf;
	size_t priority;     /* root priority */
	int    in_progress;  /* root has any started/done leaf */
	time_t first_start;  /* earliest start among the root's started leaves (tie-break) */
	size_t root_index;   /* root localIndex (stable grouping) */
	size_t seq;          /* global timeline appearance order (intra-root tie-break) */
} SItem;

typedef struct {
	SItem  *pending;
	size_t  pending_n, pending_cap;
	Goal  **active;       /* currently-running leaves, emitted at their real start */
	size_t  active_n, active_cap;
	time_t  cursor0;      /* earliest the pending tail may begin (abs time) */
	int     any_started;  /* did the user ever start a task? (drives dormancy) */
	size_t  seq;          /* running timeline counter */
	int     filter;       /* shared-journey: only count leaves assigned to me */
	size_t  my_index;
} SchedAccum;

static void accum_push_pending(SchedAccum *a, SItem it)
{
	if (a->pending_n >= a->pending_cap) {
		a->pending_cap = a->pending_cap ? a->pending_cap * 2 : 64;
		a->pending = realloc(a->pending, a->pending_cap * sizeof(SItem));
		change_assert(a->pending, "Couldn't grow schedule pending buffer.\n");
	}
	a->pending[a->pending_n++] = it;
}

static void accum_push_active(SchedAccum *a, Goal *g)
{
	if (a->active_n >= a->active_cap) {
		a->active_cap = a->active_cap ? a->active_cap * 2 : 16;
		a->active = realloc(a->active, a->active_cap * sizeof(Goal *));
		change_assert(a->active, "Couldn't grow schedule active buffer.\n");
	}
	a->active[a->active_n++] = g;
}

/* Pass 1: scan a root's leaves to learn whether the root is in progress, its
   earliest real start, and to feed the global reality anchor (cursor0 / active /
   any_started). */
static void agg_root(Goal *g, SchedAccum *a, int *in_progress, time_t *first_start)
{
	if (!g) return;
	if (g->subgoals_len == 0) {
		if (a->filter && g->assigned_to != a->my_index) return;  /* not my leaf */

		if (g->end_date != 0) {
			*in_progress = 1;
			a->any_started = 1;
			if (g->start_date && (*first_start == 0 || g->start_date < *first_start))
				*first_start = g->start_date;
			time_t c = g->end_date + g->pauseToNext;
			if (c > a->cursor0) a->cursor0 = c;
		} else if (g->start_date != 0) {
			*in_progress = 1;
			a->any_started = 1;
			if (*first_start == 0 || g->start_date < *first_start)
				*first_start = g->start_date;
			accum_push_active(a, g);
			time_t c = g->start_date + CalcGoalRequiredTime(g) + g->pauseToNext;
			if (c > a->cursor0) a->cursor0 = c;
		}
		return;
	}
	for (size_t i = 0; i < g->subgoals_len; i++)
		agg_root(FindGoalFromIndex(g->journey_id, g->subgoals[i]), a, in_progress, first_start);
}

/* Pass 2: collect the root's pending (unstarted) leaves in timeline order. */
static void collect_pending(Goal *g, SchedAccum *a, size_t priority,
                            int in_progress, time_t first_start, size_t root_index)
{
	if (!g) return;
	if (g->subgoals_len == 0) {
		if (a->filter && g->assigned_to != a->my_index) return;
		size_t my_seq = a->seq++;
		if (g->start_date != 0 || g->end_date != 0) return;  /* not pending */
		SItem it = {
			.leaf = g, .priority = priority, .in_progress = in_progress,
			.first_start = first_start, .root_index = root_index, .seq = my_seq,
		};
		accum_push_pending(a, it);
		return;
	}
	for (size_t i = 0; i < g->subgoals_len; i++)
		collect_pending(FindGoalFromIndex(g->journey_id, g->subgoals[i]),
		                a, priority, in_progress, first_start, root_index);
}

static int sitem_cmp(const void *x, const void *y)
{
	const SItem *p = x, *q = y;
	if (p->priority != q->priority)
		return p->priority > q->priority ? -1 : 1;          /* higher priority first */
	if (p->in_progress != q->in_progress)
		return p->in_progress > q->in_progress ? -1 : 1;    /* continue in-progress roots first */
	if (p->in_progress && p->first_start != q->first_start)
		return p->first_start < q->first_start ? -1 : 1;    /* older first */
	if (p->root_index != q->root_index)
		return p->root_index < q->root_index ? -1 : 1;      /* stable grouping */
	return p->seq < q->seq ? -1 : (p->seq > q->seq ? 1 : 0); /* timeline order within root */
}

/* ---------- main ---------- */

void RefreshSchedule(User *user)
{
	if (user->schedule_table) {
		free(user->schedule_table);
		user->schedule_table = NULL;
	}
	user->schedule_len = 0;
	user->schedule_needs_refresh = 0;
	/* Placement is computed here now; the old health-check pass is retired. */
	user->goal_health_needs_refresh = 0;

	time_t now = change_time_now();
	user->last_schedule_refresh = now;
	time_t work_start, work_dur;
	load_work_window(user, &work_start, &work_dur);

	SchedAccum a = {0};
	a.cursor0 = now;

	for (size_t ji = 0; ji < user->journey_count; ji++) {
		const char *jid = user->journeys[ji];

		a.filter = 0;
		a.my_index = 0;
		Journey *j = FindJourneyByID(jid);
		if (j && j->is_shared) {
			size_t idx = FindUserIndexInJourney(j, user->id);
			if (idx < MAX_JOURNEY_USERS) { a.filter = 1; a.my_index = idx; }
		}

		size_t n = 0;
		Goal **goals = GetGoalsSorted(&n, jid);
		for (size_t i = 0; i < n; i++) {
			Goal *r = goals[i];
			if (!r || r->parent != 0) continue;   /* roots only */

			int in_progress = 0;
			time_t first_start = 0;
			agg_root(r, &a, &in_progress, &first_start);
			collect_pending(r, &a, r->priority, in_progress, first_start, r->localIndex);
		}
		free(goals);
	}

	/* Dormant: nothing ever started → empty schedule. */
	if (!a.any_started) {
		free(a.pending);
		free(a.active);
		return;
	}

	size_t total = a.active_n + a.pending_n;
	if (total == 0) {
		free(a.pending);
		free(a.active);
		return;
	}

	user->schedule_table = malloc(total * sizeof(struct ScheduleEntry));
	change_assert(user->schedule_table, "Couldn't allocate schedule table.\n");
	size_t w = 0;

	/* Currently-running tasks: shown at their real start time. */
	for (size_t i = 0; i < a.active_n; i++) {
		Goal *g = a.active[i];
		struct ScheduleEntry *e = &user->schedule_table[w++];
		e->time = g->start_date;
		e->duration = CalcGoalRequiredTime(g);
		e->goalIndex = g->localIndex;
		strncpy(e->journey_id, g->journey_id, 32);
		e->journey_id[32] = '\0';
	}

	/* Pending tail: priority-ordered, packed into work windows from the reality
	   anchor (never before now). */
	qsort(a.pending, a.pending_n, sizeof(SItem), sitem_cmp);

	time_t cursor = a.cursor0 < now ? now : a.cursor0;
	for (size_t i = 0; i < a.pending_n; i++) {
		Goal *g = a.pending[i].leaf;
		time_t req = CalcGoalRequiredTime(g);
		time_t start = fit_into_window(cursor, req, work_start, work_dur);

		struct ScheduleEntry *e = &user->schedule_table[w++];
		e->time = start;
		e->duration = req;
		e->goalIndex = g->localIndex;
		strncpy(e->journey_id, g->journey_id, 32);
		e->journey_id[32] = '\0';

		cursor = start + req + g->pauseToNext;   /* intrinsic rest before next session */
	}

	user->schedule_len = w;

	free(a.pending);
	free(a.active);
}

const struct ScheduleEntry* GetSchedule(size_t *out_len, User *user) {
	/* Recompute when something marked it dirty, or when the last compute is
	   older than SCHED_MAX_STALE_SECS — absolute times drift as "now" advances,
	   so a periodic re-anchor keeps the schedule honest even with no mutations. */
	if (user->schedule_needs_refresh ||
	    change_time_now() - user->last_schedule_refresh >= SCHED_MAX_STALE_SECS)
		RefreshSchedule(user);
	*out_len = user->schedule_len;
	return user->schedule_table;
}

// The threshold in second filters goals from x seconds away
void SerializeScheduleData(String *buffer, time_t threshold, User *user){
	time_t absolute_time = change_time_now() + threshold;
	char absolute_time_buf[128];
	format_time_human(absolute_time, absolute_time_buf, sizeof(absolute_time_buf));

	CatTemplateString(buffer, "USER SCHEDULE REPORT, starting at or after %s:\n\n[", absolute_time_buf);

	size_t schedule_len = 0;
	const struct ScheduleEntry *schedule_data = GetSchedule(&schedule_len, user);

	time_t day_work_end = absolute_time + 60 * 60 * 24;
	time_t week_work_end = absolute_time + 60 * 60 * 24 * 7;

	time_t day_work_hours = 0;
	time_t week_work_hours = 0;
	char day_work_end_buf[128];
	char week_work_end_buf[128];

	for (size_t i = 0; i < schedule_len; i++){
		const struct ScheduleEntry event = schedule_data[i];

		if (event.time < absolute_time) continue;

		Goal* goal = FindGoalFromIndex(event.journey_id, event.goalIndex);
		change_assert(goal, "Found event entry with invalid goal.\n");

			if (goal->subgoals_len == 0 && event.time >= absolute_time && event.time < day_work_end)
				day_work_hours += CalcGoalRequiredTime(goal);

			if (goal->subgoals_len == 0 && event.time >= absolute_time && event.time < week_work_end)
				week_work_hours += CalcGoalRequiredTime(goal);
	}

	format_time_human(day_work_end, day_work_end_buf, sizeof(day_work_end_buf));
	format_time_human(week_work_end, week_work_end_buf, sizeof(week_work_end_buf));

	CatTemplateString(buffer, "Total work time relative (finish and unfisnihed included):\n-Work to do untill %s : %zu\n-Work to do untill %s : %zu\n\n Schedule detailed: \n",
					day_work_end_buf, day_work_hours, week_work_end_buf, week_work_hours
				);

	_Bool first = 1;
	for (size_t i = 0; i < schedule_len; i++){
		const struct ScheduleEntry event = schedule_data[i];

		if (event.time < absolute_time) continue;

		Goal* goal = FindGoalFromIndex(event.journey_id, event.goalIndex);
		change_assert(goal, "Found event entry with invalid goal.\n");

			size_t l;
			char* serialized_info = SerializeGoal(goal, &l, "goal-info", 0);
			char* esc_goal_info = json_escape_dup(serialized_info);
			char event_time_buf[128];

			format_time_human(event.time, event_time_buf, sizeof(event_time_buf));

			if (!first) CatFixed(buffer, ",");
			CatTemplateString(buffer, "{\"date\":\"%s\",\"goal_info\":\"%s\"}", event_time_buf, esc_goal_info);
			first = 0;

			free(esc_goal_info);
			free(serialized_info);
	}
	CatFixed(buffer, "]");
}
