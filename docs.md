# CHANGE Technical Documentation

This document is the deep technical reference for the current repository.
It is written from the implementation, not the product pitch. The goal is to
describe the actual data model, file roles, runtime rules, fallback behavior,
and the mechanisms that keep the system coherent.

## System Shape

The application is a local monolith with three visible surfaces:

- a CLI operator shell
- a per-user client server
- a central server for users, shared journeys, and matching

The servers are not isolated services. They share the same user registry,
journey model, goal code, and disk layout under `user-data/`.

## Directory Roles

### `c/cli`

`c/cli/ui.c` is the human control plane. It can:

- load or create users
- start/stop the central server
- start/stop a per-user server
- feed text into the graph
- run deep search
- create goals
- export graph/goal state

### `c/srv/user`

This directory owns user persistence and user-scoped journey data.

- `user-management.c` manages the user table, file paths, and save/load
- `user-io.c` serializes `.meta` and loads/saves user journeys
- `journey.c` manages the journey table, shared journey helpers, and journey
  serialization

### `c/ne`

This is the neuroengine.

- `node.c` and `node.h` implement graph nodes and connections
- `graph/graph-engine.c` updates activation and weight
- `graph/graph-export.c` writes graph JSON
- `input/input-processor.c` turns user text into graph updates
- `input/json-to-graph.c` merges AI graph output into the graph
- `search/` implements deep search
- `goal/` implements goal creation, decomposition, repair, schedule derivation,
  and goal serialization
- `profile/user-profile.c` stores profile memory and derived summaries

### `c/srv/http-server`

Per-user HTTP server:

- route dispatch
- SSE client pool
- graph, goal, profile, middleware, research, and dev routes

### `c/srv/central-server`

Central server:

- `/users`
- shared journeys
- matching and messages
- selection flow that starts the client server for the selected user

### `c/srv/match-system`

Connection proposal and messaging system:

- proposal persistence
- message persistence
- opt-in matching
- AI ranking and reasons

### `c/lib`

Low-level building blocks:

- JSON parser
- OpenAI client
- string helpers
- time-offset helpers
- small hash dictionary

### `react/src`

Frontend tabs for:

- session / goal work
- profile
- connections
- shared journeys

## Boot Sequence

`main()` just calls the CLI lifecycle.

The bootstrap path is:

1. `UIStart()`
2. `UILoop()`
3. `UIKill()`

`UIStart()` does the real setup:

- `InitUserSystem()`
- choose the active user
- `SetupContextNodes()` for the active graph
- `InitGlobalPointerMap()`
- register `ds_emit` and `goal_emit`
- `InitGoalSystem()`

If no user exists on disk, the system creates a default user automatically.

## Data Model

### String

The code uses a custom heap-backed `String` type:

- `p` pointer
- `len` used bytes
- `cap` allocated bytes
- `used` and `init` lifecycle flags

Strings are mutable buffers, not immutable values. Nearly every serializer and
prompt builder writes into these buffers directly.

### User

`User` is the main tenant object.

Important fields:

- `id` stable storage key
- `name` display name
- `port` client-server port
- `journeys[]` owned journey IDs
- `nodes` identity graph
- `schedule_table` derived schedule cache
- `discoverable` matching opt-in
- `description` private matching description

### Graph Node

The graph is in `c/ne/node.h`.

`Node` stores:

- label
- activation
- weight
- parent
- children index dictionary
- adjacency list of `Connection`
- last touch time
- pending touch count
- seen/used counters

`Connection` stores:

- activation
- weight
- target index
- last touch time
- pending touch count

The five fixed context roots are:

- `profesie`
- `emotie`
- `pasiuni`
- `generalitati`
- `subiectiv`

Those are always created at graph initialization time.

### Journey

`Journey` is the container for goals.

It supports two modes:

- solo journey
- shared journey

Shared journeys carry a participant table:

- `JourneyUser.id`
- `JourneyUser.display_name`
- `JourneyUser.context_summary`

The participant index is critical. Shared leaf assignment uses the journey-local
participant index, not the raw user ID.

### Goal

`Goal` is the scheduling and decomposition unit.

Important fields:

- `title`, `extra_info`
- `start_date`, `end_date`
- `required_time`
- `subgoals[]`, `subgoals_len`
- `parent`, `prev`, `next`
- `priority`
- `journey_id`
- `assigned_to`

`assigned_to` rules:

- `255` means unassigned
- `0..MAX_JOURNEY_USERS-1` means a participant index
- solo journeys leave leaves unassigned

### Schedule Entry

The schedule system stores:

- `time`
- `goalIndex`
- `journey_id`

This is a derived view, rebuilt from goals and work-time policy.

## On-Disk Layout

### Per-user files

Under `user-data/<user_id>/`:

- `.meta` user metadata
- `graph-copy.json` graph export
- `goals-copy.json` journey export
- `user-profile.log` profile memory
- `journey-<journey_id>.json` journey snapshot

### Shared journeys

Shared journeys are stored centrally under:

- `shared-journeys/<journey_id>.json`

### Connections

Connections are stored under:

- `user-data/connections/<connection_id>.conn`
- `user-data/connections/<connection_id>.msgs`

## File Responsibilities

### `user-management.c`

Owns:

- `USER_TABLE`
- `USER_COUNT`
- user creation
- user directory path helpers
- save orchestration

### `user-io.c`

Owns:

- `.meta` file format
- loading/saving journey IDs from `.meta`
- loading user descriptions and discoverability

### `journey.c`

Owns:

- `JourneyTable`
- `AddGoalToJourney()`
- `AddUserToJourney()`
- journey serialization
- journey load/save
- fetch/push of shared journeys to central

### `graph-engine.c`

Owns graph refresh math:

- decay
- pending-touch boosts
- support-based weight recomputation

### `graph-export.c`

Owns graph JSON export.

### `json-to-graph.c`

Owns graph ingestion from parsed JSON.

### `goal.c`

Owns:

- goal creation
- decomposition
- repair
- start/end/drop
- derived state propagation

### `goal-info.c`

Owns the serializations used by:

- middleware context
- deep search context
- schedule reporting
- shared journey attribution views

### `schedule-system.c`

Owns the derived user schedule.

### `deep-search-session.c`

Owns deep search session orchestration and OpenAI call/judge loops.

### `connections.c`

Owns connection proposals, approvals, declines, and message storage.

## Graph Engine Deep Dive

The graph engine is a salience and structural-weight system, not just a node
store.

### Core rule

Every node and connection has two signals:

- activation = current salience
- weight = persistent importance

The engine periodically refreshes these values using time decay and usage
history.

### Touching

`touch_node()` and `touch_connection()` do not immediately rewrite the graph
state into a final weight. They only record pending touches.

At refresh time:

- pending touches are folded into activation using `log1p()`
- time decay is applied
- node weight is recomputed from support, seen count, and used count

This means short-term interaction affects activation quickly, while weight
changes slower.

### Refresh mechanics

`RefreshGraph()`:

1. gets current time
2. refreshes each connection
3. computes support for each node
4. normalizes support / seen / used counts
5. recomputes node weight
6. applies activation decay and touch boost

The weights are intentionally damped:

- old weight dominates new weight
- support matters more than raw usage
- activation matters but is not the sole driver

### Context roots

`SetupContextNodes()` creates the five context roots. Node lookup in the input
loader is always scoped through a context root first, which prevents accidental
cross-context merges.

### Import/export behavior

The graph exporter writes:

- node array
- connection array

The loader reconstructs nodes and links from that export. If a node or link
already exists in the right context, it is touched instead of duplicated.

### Graph fallbacks

- If a graph file is missing, user load still proceeds with a fresh graph and
  context roots.
- If a node lookup fails inside a context, the loader skips that entry instead
  of corrupting the graph.
- If a connection references missing nodes, it is ignored.

## Input Decomposition

`DecomposeInputIntoGraph()` is the graph ingestion path for user text.

Flow:

1. record input in profile history
2. build a prompt for graph decomposition
3. call OpenAI
4. extract the JSON text from the Responses API envelope
5. parse the five-context graph payload
6. apply nodes and connections

The schema requires each context to contain:

- `nodes`
- `connections`

Each node and connection has `name`, `weight`, and `activation`.

### Input fallback rules

- invalid model output is rejected by the JSON parser
- missing or malformed context payloads fail loudly
- existing nodes/links are touched, not duplicated
- all node insertion is lowercased to normalize matching

## Deep Search Engine

Deep search is an iterative action loop. It is not a single prompt.

### Session model

`start_ds_session()` builds:

- persistent prompt = task framing and context
- dynamic prompt = evolving action trace

Then it loops:

1. ask OpenAI for the next action
2. parse the action JSON
3. execute the action
4. judge the result
5. if not done, append feedback and continue

### Core commands

Command 1: global filtering

- input: `percentage`, `criteria`
- output: top global nodes by activation or weight

Command 2: local neighbor search

- input: `percentage`, `node`, `context`, `criteria`
- output: top neighbors inside one context

Command 3: recursive family search

- input: `node`, `context`, `percA`, `percW`, `depth`
- output: filtered recursive family tree

Command 4: goal overview

- input: `mode` = `roots`, `due`, or `history`
- output: root goals, due goals, or goal history

Command 5: goal tree expansion

- input: `goal_id`, `depth`
- output: recursive goal tree view

Command 6: goal relations

- input: `goal_id`, `method`
- output: history, siblings, parents, linked siblings, or uncles

Command 7: schedule view

- input: time offset in seconds
- output: derived schedule report from that point onward

Command 8: profile history section

- input: section name and max entries
- output: profile section snapshot

Command 9: derived profile summary

- input: none beyond the command object
- output: derived profile summary

### Deep-search fallbacks

- if the model tries to finish early, the judge can reject it
- if the model emits invalid JSON, the dynamic feedback is updated and the
  session retries
- if the model selects an unsupported command, the dynamic memory records the
  error and the loop continues
- if the minimum round depth is not met, termination is rejected

### Deep-search outputs

The deep search runtime emits SSE events for:

- round start
- model response
- judge start
- judge pass/fail
- session end

## Goal System Deep Dive

The goal system is layered on top of journeys.

### Creation

`CreateUserGoal()`:

1. records the request in profile memory
2. builds a goal adaptation prompt
3. uses deep search / AI personalization
4. extracts `title`, `extra_info`, `estimated_time`, `priority`
5. creates the goal
6. partially decomposes it if needed
7. records the creation in profile memory

### Decomposition

`DecomposeGoal()`:

- refuses to decompose if the goal already has children
- refuses if the goal is too short
- builds a prompt
- dispatches to solo or shared AI decomposition
- parses the returned `subgoals`
- creates child goals
- links `prev` / `next`
- recomputes total required time

#### Solo decomposition

Solo journeys use the original decomposition prompt and schema.

#### Shared decomposition

Shared journeys use the shared prompt and shared schema.

Shared decomposition rules:

- the prompt includes participant summaries
- the prompt includes journey completion and delay attribution
- the prompt includes parent/sibling/uncle context
- every child can carry `assigned_to`
- if estimated time is above `SHARED_LEAF_MAX_SECONDS`, the child is forced
  to remain unassigned

### Goal repair

`RepairGoalBranch()` uses the previous branch as evidence and attempts to
rebuild the branch while preserving valid progress.

Fallback behavior:

- old completed work is treated as retained foundation
- unfinished progress is carried forward when the new structure matches
- invalid progress is cleared if the new branch no longer supports it

### Start/end/drop

`StartGoalDeepFromGoal()` finds the first startable leaf.

`EndGoalFromGoal()`:

- requires children to be finished if the goal has children
- requires timeline predecessors to be complete
- propagates completion upwards

`DropGoalTree()`:

- marks unfinished goals in the tree as ended
- records drop events
- updates schedule and health state

### Goal fallback rules

- if a goal cannot be found, the handlers fail with `goal_not_found`
- if a goal is already completed, start/end paths return conflict
- if a parent is ended before its children, the code asserts
- if a shared journey cannot be resolved, shared decomposition asserts

## Schedule and Goal Health

`RunGoalHealthCheck()` and `RefreshSchedule()` derive the practical work plan.

### Inputs

- daily work start
- daily work hours
- current goal tree
- goal priorities
- completion state
- timing between leaves

### Behavior

- collect due leaves across all journeys
- for shared journeys, filter leaves by participant when appropriate
- sort by root priority and age
- pack leaves into work blocks
- write `pauseToNext`
- persist if the schedule changed

### Fallbacks

- if a due leaf does not fit in the current day block, the system moves to the
  next work block
- if a leaf is longer than the available block, it is still scheduled instead
  of being discarded
- if the schedule table is stale, it is regenerated lazily

## Profile Memory

The profile file is a structured operational log, not a generic JSON blob.

It stores:

- input history
- goal activity history
- derived summary

The derived section tracks:

- latest input source
- latest input
- last goal event
- last goal id
- last goal title
- current focus goal id
- current focus goal title

Fallback behavior:

- if the profile file is missing, it is created with marker sections
- custom lines in the derived section are preserved across writes
- fixed keys are rewritten by the profile system

## Shared Journeys

Shared journeys are the new multi-user coordination layer.

### Creation

The central server creates them with:

- `name`
- `user_ids[]`

The participants are copied into the journey’s user table:

- user ID
- display name snapshot
- context summary snapshot

### Listing and fetching

- `/journey/list?user_id=...` returns a compact list
- `/journey/<id>` returns the full journey with users and goals

### Update model

`PushJourneyToCentral()` sends the current shared journey state back to the
central server. `FetchSharedJourney()` retrieves the current copy.

### Shared journey rules

- participant count is capped by `MAX_JOURNEY_USERS`
- the journey must contain at least one participant
- shared decomposition only runs when the journey is shared and has participants
- only participants may own assigned leaves

## Connection System

The matching system is deliberately separate from the graph and goal systems.

### Data

`UserConn` stores:

- connection ID
- user A / user B IDs
- approval flags
- state
- proposed timestamp
- reason text

`UserConnMessage` stores:

- connection ID
- sender ID
- timestamp
- message text

### Lifecycle

1. users opt in by calling discoverable
2. the central server runs a matching pass
3. the matcher proposes candidate connections
4. users approve or decline
5. confirmed connections can send messages

### Matching pipeline

`FindMatchForUser()`:

- filters candidates to discoverable users with descriptions
- skips existing pairings
- calls OpenAI on the candidate set
- deduplicates matches
- ranks final matches
- persists proposals immediately

### Connection fallback rules

- no description means no matching
- existing pair means no duplicate proposal
- declined connections remain declined
- messages require confirmed state
- if a message is invalid or the connection is unconfirmed, sending fails

### Privacy rules

- raw descriptions are private
- only the reason and partner name are exposed
- the matching model sees descriptions, but the UI does not expose them to the
  other party

## HTTP and SSE

### Per-user server

The per-user server handles all goal, graph, profile, and middleware routes.

It uses SSE for:

- research events
- middleware events
- goal events

### Central server

The central server exposes:

- users
- shared journeys
- connection endpoints
- connection messages

### Request parsing

Both servers parse raw HTTP manually.

Fallback behavior:

- malformed requests return `400`
- missing routes return `404`
- CORS preflight gets `204`
- closed SSE clients are removed from the client pool

## OpenAI Integration

The code uses the OpenAI Responses API directly.

Main usages:

- graph decomposition
- deep search actions
- goal adaptation
- goal decomposition
- shared goal adaptation
- shared goal decomposition
- connection matching
- mock generation

Fallback behavior:

- network/API transport failures are retried
- invalid JSON is rejected
- schema mismatches are rejected
- non-2xx responses are captured for debugging

## Current Configuration Constants

Important constants in `c/config.h`:

- `MAX_USERS`
- `MAX_JOURNEYS`
- `MAX_JOURNEY_USERS`
- `SHARED_LEAF_MAX_SECONDS`
- `NODE_GUESS_WEIGHT_RELEVANCE`
- `CONNECTION_GUESS_WEIGHT_RELEVANCE`
- `ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT`
- `NCOUNT_PENALTY_TO_NODE_WEIGHT`
- `SUPPORT_MERIT_TO_NODE_WEIGHT`
- `NODE_OLD_WEIGHT_RELEVANCE`
- `ACT_HALFTIME`

These constants are not decorative. They affect prompt semantics, graph
physics, and the shared-journey leaf ownership rules.

## Fallback and Safety Summary

- Missing files are usually tolerated by creating fresh structures.
- Malformed JSON from AI is rejected immediately.
- Shared journeys fail loudly when participant data is inconsistent.
- Goal actions fail when prerequisites are not met.
- Matching never duplicates existing pairs.
- Connection messages require confirmed state.
- Schedule refresh is lazy and derived, not stored as user-authored data.

## Practical Reading Order

If you want to understand the codebase in the shortest path, read in this
order:

1. `c/main.c`
2. `c/cli/ui.c`
3. `c/srv/user/user-management.c`
4. `c/srv/user/journey.c`
5. `c/ne/node.c`
6. `c/ne/graph/graph-engine.c`
7. `c/ne/input/input-processor.c`
8. `c/ne/search/deep-search-session.c`
9. `c/ne/goal/goal.c`
10. `c/srv/match-system/connections.c`
11. `c/srv/central-server/central-server.c`
12. `react/src/section/together-view.tsx`

