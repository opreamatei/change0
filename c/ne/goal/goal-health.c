#include "goal-health.h"
#include "goal-util.h"
#include "profile/user-profile.h"
#include "srv/user-management.h"
#include "lib/util/time-util.h"

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <limits.h>

#define DEFAULT_WORK_START_SECS   (9 * 3600)   /* 09:00 */
#define DEFAULT_WORK_DURATION     (8 * 3600)   /* 8 hours */
#define DAY_SECS                  86400

static time_t parse_hhmm(const char *s, time_t def)
{
	int h = 0, m = 0;
	if (sscanf(s, "%d:%d", &h, &m) < 1) return def;
	return (time_t)(h * 3600 + m * 60);
}

/* All time math in this file uses "offset from now" in seconds.
 * end_offset values may be negative (the event is in the past). */

typedef struct {
	Goal *leaf;
	Goal *prev;            /* the goal whose pauseToNext we will write; NULL = first in chain */
	time_t prev_end_offset;/* offset-from-now when prev finishes; INT64_MIN if unknown */
	size_t root_priority;
	time_t root_start_date;/* for tie-breaking older-first */
	size_t root_id;        /* identifies the chain for in-chain minPause floor */
} Pending;

static Goal *walk_first_leaf(Goal *g)
{
	while (g && g->subgoals_len > 0) {
		Goal *child = FindGoalFromIndex(g->journey_id, g->subgoals[0]);
		if (!child) break;
		g = child;
	}
	return g;
}

static Goal *walk_next_leaf(Goal *g)
{
	while (g) {
		if (g->next != 0) {
			Goal *sib = FindGoalFromIndex(g->journey_id, g->next);
			if (!sib) return NULL;
			return walk_first_leaf(sib);
		}
		if (g->parent == 0) return NULL;
		g = FindGoalFromIndex(g->journey_id, g->parent);
	}
	return NULL;
}

static int pending_cmp(const void *a, const void *b)
{
	const Pending *pa = (const Pending *)a;
	const Pending *pb = (const Pending *)b;
	if (pa->root_priority != pb->root_priority)
		return (pb->root_priority > pa->root_priority) ? 1 : -1;
	if (pa->root_start_date != pb->root_start_date)
		return (pa->root_start_date < pb->root_start_date) ? -1 : 1;
	return 0;
}

void RunGoalHealthCheck(User *user)
{
	if (!user) return;
	if (!user->goal_health_needs_refresh) return;
	user->goal_health_needs_refresh = 0;

	/* --- load work block parameters --- */
	char buf[64];
	time_t work_start = DEFAULT_WORK_START_SECS;
	time_t work_dur   = DEFAULT_WORK_DURATION;

	if (UserProfileGetDerivedField(user, "work_day_start", buf, sizeof(buf)))
		work_start = parse_hhmm(buf, DEFAULT_WORK_START_SECS);
	if (UserProfileGetDerivedField(user, "daily_work_hours", buf, sizeof(buf))) {
		long v = atol(buf);
		if (v > 0 && v <= 24) work_dur = (time_t)(v * 3600);
	}

	/* --- compute "now" position inside today's work-block (all in seconds-from-now) --- */
	time_t now = change_time_now();
	struct tm *lt = gmtime(&now);
	time_t secs_into_day = (time_t)(lt->tm_hour * 3600 + lt->tm_min * 60 + lt->tm_sec);

	/* Offset from now to today's work_start (negative = already past it). */
	time_t today_start = work_start - secs_into_day;
	time_t today_end   = today_start + work_dur;

	time_t cursor;     /* next free moment (offset-from-now) */
	time_t day_end;    /* end of cursor's current work block */

	if (today_end <= 0) {
		/* past today's block — start tomorrow */
		cursor  = today_start + DAY_SECS;
		day_end = cursor + work_dur;
	} else if (today_start <= 0) {
		/* inside today's block — start now */
		cursor  = 0;
		day_end = today_end;
	} else {
		/* before today's block — start at today's work_start */
		cursor  = today_start;
		day_end = today_end;
	}

	/* --- collect all pending leaves across all roots, with their chain anchors --- */
	size_t cap = 64, n = 0;
	Pending *list = malloc(cap * sizeof(Pending));
	if (!list) return;

	for (size_t ji = 0; ji < user->journey_count; ji++) {
		const char *jid = user->journeys[ji];
		size_t total = 0;
		Goal **all = GetGoalsSorted(&total, jid);

		for (size_t i = 0; i < total; i++) {
			Goal *root = all[i];
			if (!root) continue;
			if (root->parent != 0) continue;
			if (root->end_date != 0) continue;

			Goal *leaf = walk_first_leaf(root);
			time_t chain_prev_end = LONG_MIN;  /* end-offset of last seen leaf in chain */
			Goal *chain_prev_goal = NULL;

			while (leaf) {
				if (leaf->end_date != 0) {
					chain_prev_end = (time_t)(leaf->end_date - now);
					chain_prev_goal = leaf;
					leaf = walk_next_leaf(leaf);
					continue;
				}
				if (leaf->start_date != 0) {
					chain_prev_end = (time_t)(leaf->start_date - now) + leaf->required_time;
					chain_prev_goal = leaf;
					leaf = walk_next_leaf(leaf);
					continue;
				}

				/* pending leaf — record it */
				if (n >= cap) {
					cap *= 2;
					Pending *tmp = realloc(list, cap * sizeof(Pending));
					if (!tmp) { free(list); free(all); return; }
					list = tmp;
				}

				Goal *prev_anchor = NULL;
				time_t prev_end = LONG_MIN;
				if (chain_prev_goal) {
					prev_anchor = chain_prev_goal;
					prev_end    = chain_prev_end;
				} else if (leaf->prev != 0) {
					/* Defensive: chain_prev_goal should already cover this case. */
					prev_anchor = FindGoalFromIndex(leaf->journey_id, leaf->prev);
					if (prev_anchor && prev_anchor->end_date != 0)
						prev_end = (time_t)(prev_anchor->end_date - now);
				}

				list[n].leaf            = leaf;
				list[n].prev            = prev_anchor;
				list[n].prev_end_offset = prev_end;
				list[n].root_priority   = root->priority;
				list[n].root_start_date = root->start_date;
				list[n].root_id         = root->localIndex;
				n++;

				/* For subsequent pending leaves in same chain, we don't know
				 * where this one lands yet — we'll patch chain_prev_end after
				 * the global allocation pass below. For now, mark "after this leaf"
				 * with a placeholder so chain ordering is preserved. */
				chain_prev_goal = leaf;
				chain_prev_end  = LONG_MIN;  /* unknown — patched in pass 2 */

				leaf = walk_next_leaf(leaf);
			}
		}
		free(all);
	}

	if (n == 0) { free(list); return; }

	/* --- sort by root priority (high first), then older root first --- */
	qsort(list, n, sizeof(Pending), pending_cmp);

	/* --- allocate each leaf into a day, packing densely --- */
	_Bool changed = 0;

	/* end-offset of each leaf after scheduling (indexed by position in `list`). */
	time_t *scheduled_end = malloc(n * sizeof(time_t));
	if (!scheduled_end) { free(list); return; }

	for (size_t i = 0; i < n; i++) {
		Pending *p = &list[i];
		time_t req = p->leaf->required_time;

		/* The leaf's earliest possible start = max(cursor, prev_end_in_chain).
		 * If prev was a previously-scheduled pending leaf in this same root chain,
		 * fix it up here from scheduled_end[]. */
		time_t earliest = cursor;
		if (p->prev_end_offset != LONG_MIN && p->prev_end_offset > earliest)
			earliest = p->prev_end_offset;
		else if (p->prev_end_offset == LONG_MIN && p->prev != NULL) {
			/* find prior Pending entry whose leaf == p->prev */
			for (size_t k = 0; k < i; k++) {
				if (list[k].leaf == p->prev) {
					if (scheduled_end[k] > earliest) earliest = scheduled_end[k];
					p->prev_end_offset = scheduled_end[k];
					break;
				}
			}
		}

		/* If goal doesn't fit in this day, push to next day's work_start. */
		if (earliest + req > day_end) {
			cursor  = day_end + (DAY_SECS - work_dur);  /* next day's work_start */
			day_end = cursor + work_dur;
			if (earliest < cursor) earliest = cursor;
			/* still doesn't fit (a single leaf > work_dur)? schedule anyway and accept overflow */
		}

		/* Final scheduled start */
		time_t start = earliest;
		time_t end   = start + req;
		scheduled_end[i] = end;

		/* Set pauseToNext on the prev anchor (write only if it changed). */
		if (p->prev) {
			time_t new_pause = start - p->prev_end_offset;
			if (new_pause < 0) new_pause = 0;
			/* In-chain min-pause floor only when prev is in same root */
			if (p->prev->minPauseToNext > new_pause)
				new_pause = p->prev->minPauseToNext;
			if (p->prev->pauseToNext != new_pause) {
				p->prev->pauseToNext = new_pause;
				changed = 1;
			}
		}

		/* Advance global cursor; pack densely (no extra gap between adjacent slots). */
		if (end > cursor) cursor = end;
	}

	free(scheduled_end);
	free(list);

	user->schedule_needs_refresh = 1;
	if (changed) SaveUser(user);
}
