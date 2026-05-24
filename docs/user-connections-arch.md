# User Connections — Architecture Notes

## Core Idea

Each user has a **bandwidth** setting — not just "available yes/no" but a signal of how much
cognitive/time space they have for collaboration. The algorithm finds compatible users and proposes
a connection. Later, a connection becomes the anchor for a shared journey.

---

## Bandwidth Model

Two components combined:

**Explicit** — user-set mode:
- `open` — actively looking for a connection
- `selective` — open but only if the match is strong
- `focused` — not available, excluded from matching entirely

**Implicit** — computed from goal health:
```
free_ratio = (weekly_work_hours - scheduled_hours) / weekly_work_hours
```
A user with `free_ratio < 0.15` is treated as effectively full even if they say `open`.

Both must clear their threshold before a user enters the matching pool.

---

## Compatibility Score

Five signals, all derivable from existing data:

| Signal | Source | Weight |
|---|---|---|
| Topic overlap | goal titles + extra_info (keyword or embedding) | high |
| Schedule overlap | free slots from goal health | medium |
| Commitment level | average goal priority | medium |
| Velocity match | completed goals / elapsed time | low |
| Goal stage | both starting vs both mid-execution | low |

The score is a weighted sum → 0.0–1.0. Only users above a threshold are proposed.

---

## Connection Entity

```
Connection {
  user_a_id       string
  user_b_id       string
  state           proposed | active | ended
  proposed_at     timestamp
  accepted_at     timestamp (nullable)
  score_snapshot  float      -- score at proposal time
  shared_journey_id string   -- NULL for now, filled later
}
```

Stored separately from User/Journey — its own file per connection under `user-data/connections/`.

---

## Proposal Flow

No "friend request" UI. The **middleware AI proposes it** when it has enough context:

1. User is in pool (bandwidth OK)
2. Matching runs → finds candidates above threshold
3. AI surfaces it conversationally: *"Someone's working on similar goals and has bandwidth —
   want me to introduce you?"*
4. User says yes → state moves to `active`
5. User ignores or says no → state stays `proposed`, not re-proposed for N days

This fits naturally in the existing middleware loop — no new UI pages needed initially.

---

## Matching Algorithm Location

Server-side, a new endpoint: `GET /connections/candidates?userId=X`

Returns ranked list of compatible users. Can be called:
- By the middleware AI when it decides to propose
- By the frontend later if we want an explicit "explore" tab

---

## Privacy Layer (Important)

Define explicitly what's visible for matching vs. private:

**Public for matching:**
- bandwidth mode (explicit)
- free_ratio (derived, not raw schedule)
- goal topic tags (coarse — "software", "fitness", "learning", not the full title)
- velocity tier (fast/medium/slow — not raw numbers)

**Never exposed:**
- goal titles/descriptions
- exact schedule
- profile fields
- goal IDs

The matching algorithm uses the public data only. Full goal content stays private.

---

## Shared Journey (Future)

When both users accept:

1. A new `Journey` is created — owned by neither user alone
2. Both users' `journeys[]` arrays reference it
3. Goal health runs per-user but the journey is shared
4. Permissions: both can read/write, either can propose goals, dropping requires both

The `Connection.shared_journey_id` field already slots this in — no schema change needed later.

---

## Risks

**Stale connections** — user goes `focused` after accepting. Need a periodic check:
if both users haven't interacted with the shared journey in N days, surface a "still active?" nudge.

**Privacy trust** — even coarse topic tags can reveal sensitive goals. The opt-in for `open` mode
should be explicit and shown clearly in the profile UI.

**Matching fairness** — users with many goals and high velocity will always outscore beginners.
Consider a "stage-matched" mode that pairs people at similar points in their journey, not just by
raw compatibility.
