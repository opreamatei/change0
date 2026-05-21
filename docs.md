# CHANGE Technical Documentation

This document describes the current runtime architecture of the `c/` tree.
The codebase is a local, AI-driven system that turns user input into graph
updates, goal objects, schedule data, profile memory, deep-search sessions,
and HTTP/SSE output.

## Scope

The application has two layers:

- `c/` is the runtime engine, persistence layer, CLI shell, and HTTP server.
- `react/` is the frontend client that consumes the HTTP and SSE APIs.

This document focuses on `c/`, because that is where the actual behavior is
implemented.

## Boot Sequence

The executable starts in [`c/main.c`](c/main.c). `main()` calls `UIStart()`,
enters `UILoop()`, and finally calls `UIKill()`.

`UIStart()` in [`c/cli/ui.c`](c/cli/ui.c) performs the real initialization:

- it loads the user system from `user-data/`
- it initializes the node graph storage
- it creates the five root contexts: `profesie`, `emotie`, `pasiuni`,
  `generalitati`, and `subiectiv`
- it initializes the global pointer map
- it registers the deep-search and goal emit callbacks
- it initializes the goal subsystem

Those root contexts are the top-level parent nodes for the identity graph.
Everything else in the graph is stored under one of those contexts.

## Core Data Model

### Nodes and Connections

The graph lives in [`c/ne/node.h`](c/ne/node.h) and
[`c/ne/node.c`](c/ne/node.c).

Each `Node` stores:

- a label
- a parent context or parent node
- activation and weight
- an array of outgoing connections
- counters such as `times_seen` and `times_used`
- timestamps used by the decay and refresh logic

Each `Connection` stores:

- target node index
- activation and weight
- pending touches
- last touched time

Parenting is important. `read_node_activation()` and `read_node_weight()`
multiply a node by its ancestor chain, so a child node inherits structure from
its parents.

### Graph Refresh

The graph is periodically normalized in
[`c/ne/graph/graph-engine.c`](c/ne/graph/graph-engine.c).

`RefreshGraph()` does three things:

- decays node and connection activation over time
- applies pending touches using a logarithmic boost
- recomputes node weight from connection support and usage signals

The weight update uses the tunable constants in [`c/config.h`](c/config.h):

- `ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT`
- `NCOUNT_PENALTY_TO_NODE_WEIGHT`
- `SUPPORT_MERIT_TO_NODE_WEIGHT`
- `NODE_OLD_WEIGHT_RELEVANCE`
- `ACT_HALFTIME`

In practice, this makes the graph self-stabilizing: old activation fades,
recent touches matter, and the strongest structural neighborhood influences
node weight.

### Graph Import and Export

[`c/ne/input/json-to-graph.c`](c/ne/input/json-to-graph.c) ingests OpenAI
output and merges it into the graph.

The merge behavior is:

- if a node already exists in the target context, it is touched rather than
  duplicated
- otherwise a new node is created
- existing connections are touched
- missing connections are added as bidirectional links

[`c/ne/graph/graph-export.c`](c/ne/graph/graph-export.c) serializes the graph
to JSON for persistence and inspection.

## User, Journey, and Goal Storage

### Users

[`c/srv/user-management.c`](c/srv/user-management.c) loads and persists users
from `user-data/<id>/`.

Each user has:

- a generated id
- a display name
- a bounded list of journey ids

The first user is selected as `LocalUser` on startup unless another user is
chosen later. User metadata is stored in `.meta`, and the system keeps per-user
graph, goal, journey, and profile files under the user directory.

### Journeys

[`c/srv/journey.c`](c/srv/journey.c) is the container for goals.

A journey stores:

- a journey id
- title and extra info
- an array of goal pointers

Journeys matter because goals are not global in a vacuum. A goal is always
anchored to a journey, and cross references such as `parent`, `prev`, `next`,
and `subgoals` are local to that journey.

### Goals

The goal model is defined in [`c/ne/goal/goal-util.h`](c/ne/goal/goal-util.h)
and implemented across `goal.c`, `goal-info.c`, `goal-ai.c`, and
`user-schedule.c`.

Each `Goal` stores:

- title and extra info
- start/end timestamps
- required time
- child goal references
- parent/prev/next links
- depth, retry depth, and priority
- a runtime goal id
- the journey id

The system treats goals as a timeline graph, not just a tree:

- `parent` defines decomposition structure
- `prev` and `next` define execution order
- `subgoals` define the branch expansion

## Message to Graph Flow

The simplest input path is the `/message` route in
[`c/srv/http-server.c`](c/srv/http-server.c), which calls
`DecomposeInputIntoGraph()`.

The flow is:

1. user input is recorded in the user profile
2. a prompt is built for OpenAI using the decomposition schema
3. OpenAI returns a strict JSON document with the five contexts
4. each context is handed to `AddContextNodesFromJSON()`
5. nodes and connections are merged into the existing graph

This same flow is also used by the CLI `u` command and by middleware before it
invokes larger actions.

## Goal Creation Flow

Goal creation is implemented in [`c/ne/goal/goal.c`](c/ne/goal/goal.c).

The high-level flow is:

1. the user gives a title and supporting context
2. the request is recorded in the profile history
3. `CreateUserGoal()` calls `PersonalizeGoal()` to build a deep-search task
4. deep search runs against the current user context
5. the deep-search output is parsed into a goal title, extra info, estimate,
   and priority
6. `create_goal_raw()` creates the root goal
7. `ComputePartialDecomposition()` decomposes the goal until it becomes small
   enough or it reaches a leaf
8. the created goal is recorded in the user profile goal history

The important detail is that goal creation is not a direct OpenAI text-to-goal
mapping. It is a two-stage process:

- deep-search produces context and personalization
- a goal-extraction schema converts that into a concrete goal object

### Goal Decomposition

`DecomposeGoal()` uses `SetGoalDecompositionPrompt()` and the goal decomposition
schema in [`c/ne/goal/goal-ai.h`](c/ne/goal/goal-ai.h).

It creates 2 to 9 subgoals, links them in sequence with `prev`/`next`, stores
their ids, and recalculates the parent required time by summing child duration
plus pauses.

`ComputePartialDecomposition()` keeps decomposing the first branch while the
goal is still large enough to justify it.

### Goal Repair

Goal repair is a separate path in `goal.c`.

When a goal branch is repaired, the code:

- snapshots the old branch progress
- runs a deep-search assisted repair context
- generates a replacement branch
- validates the replacement with a judge prompt
- transfers compatible progress into the new tree
- re-bases parent/child/prev/next references
- updates user profile and schedule state

This is important because repaired goals preserve history rather than starting
from scratch.

## Schedule Flow

[`c/ne/goal/user-schedule.c`](c/ne/goal/user-schedule.c) converts the current
goal forest into a time-ordered schedule.

It works by:

- finding due leaf goals
- walking forward through timeline-linked leaves using `next`
- computing start and end times from `start_date`, `required_time`, and
  `pauseToNext`

The schedule is used by:

- the HTTP `/schedule` endpoint
- deep search command 7
- middleware prompts that need workload and time pressure context

## Profile Memory Flow

[`c/ne/profile/user-profile.c`](c/ne/profile/user-profile.c) maintains a
lightweight user memory file.

The file format has three sections:

- input history
- goal activity history
- derived summary

The derived summary stores operational fields such as:

- latest input source
- latest input
- last goal event
- last goal id
- last goal title
- current focus goal id
- current focus goal title

This profile memory is read back into middleware prompts so the AI can respond
with continuity instead of treating each request as isolated.

## Deep Search Flow

Deep search is implemented in `c/ne/search/`.

The main entrypoint is `start_ds_session()` in
[`c/ne/search/deep-search-session.c`](c/ne/search/deep-search-session.c).

The loop is:

1. build the persistent prompt from `DS_PERSISTENT_PROMPT`
2. refresh the graph before reasoning
3. send the current prompt to OpenAI
4. parse the returned JSON command
5. execute the selected command in `exec_response()`
6. ask the judge model whether the output is good enough
7. if the judge fails, append feedback and repeat
8. stop only when the judge passes and a conclusion is produced

The command executor in
[`c/ne/search/deep-search-execute.c`](c/ne/search/deep-search-execute.c)
routes commands `1` through `9` into the concrete handlers in
[`c/ne/search/ai-action.c`](c/ne/search/ai-action.c).

Those commands are:

- `1` global graph filtering
- `2` local neighbor filtering
- `3` recursive family exploration
- `4` goal overview
- `5` goal tree inspection
- `6` goal relation inspection
- `7` schedule reporting
- `8` profile history section extraction
- `9` derived profile summary extraction

Deep search emits SSE events through the global `ds_emit` pointer so the UI
can stream progress in real time.

## Middleware Flow

[`c/middleware/middleware.c`](c/middleware/middleware.c) is the higher-level
assistant router for chat-like interactions.

It does more than plain decomposition:

- it records the incoming chat turn
- it updates the graph from the input
- it builds a context prompt from profile history, derived profile state, and
  recent goal activity
- it asks OpenAI for one strict JSON object
- it parses actions and applies them

Supported actions are:

- `reply`
- `set_profile`
- `clear_profile`
- `ask_permission`
- `create_goal`
- `set_goal_priority`
- `call_deep_search`

The middleware also maintains two internal state stores:

- a session history buffer for emitted events and conversation history
- a pending permission table for profile fields that require approval

Sensitive profile writes are not committed immediately. They are emitted as a
permission request and later resolved by `ResolveMiddlewarePermission()`.

If middleware chooses `call_deep_search`, it starts a nested deep-search task
and folds the result back into the retry prompt.

## HTTP Server Flow

The per-user HTTP server lives in [`c/srv/http-server.c`](c/srv/http-server.c).
It is started with `start_server(0)`, which binds to an ephemeral local port
and stores the chosen port in `client_server_port()`.

The server exposes:

- graph routes
- goal routes
- schedule routes
- middleware routes
- research/deep-search routes
- dev time control routes
- SSE event streams

### Central Server vs Client Server

The app has two servers:

- the central server on port `8085` manages users
- the client server is per-user and gets an OS-selected port

[`c/srv/central-server.c`](c/srv/central-server.c) exposes:

- `GET /users`
- `POST /users/create`
- `POST /users/select`
- `GET /users/active`

Selecting a user switches `LocalUser` and restarts the client server for that
user.

### Client Server Routes

The client server routes are:

- `GET /graph`
- `POST /graph/export`
- `GET /graph/load`
- `POST /research/start`
- `GET /research/events?id=...`
- `POST /middleware/message`
- `POST /middleware/permission`
- `GET /middleware/events?sessionId=...`
- `GET /middleware/session?sessionId=...`
- `POST /goal/create`
- `POST /goal/repair`
- `POST /goal/start`
- `POST /goal/end`
- `POST /goal/decompose`
- `GET /goal/events?goal-id=...`
- `GET /goal/list`
- `GET /goal/session`
- `POST /goal/export`
- `GET /goal/load`
- `GET /dev/time`
- `POST /dev/time/advance`
- `POST /dev/time/reset`
- `POST /message`
- `GET /schedule`

The server uses SSE for long-running flows:

- `research` streams deep-search progress
- `goal` streams goal lifecycle events
- `middleware` streams middleware status, permission requests, and replies

## Persistence Layout

The on-disk layout is controlled by `c/config.h`.

The important files are:

- `user-data/<id>/.meta`
- `user-data/<id>/graph-copy.json`
- `user-data/<id>/goals-copy.json`
- `user-data/<id>/user-profile.log`
- `user-data/<id>/journey-<journey_id>.json`

Mock graph data lives in:

- `mocks/nodes/`
- `mocks/action-data/`

OpenAI request/response debugging also writes files in the project root and
`dumps/` when failures happen.

## OpenAI Layer

[`c/lib/openai/openai.c`](c/lib/openai/openai.c) is the network layer used by
the whole engine.

It:

- reads `OPENAI_API_KEY`
- connects to `api.openai.com` over TLS
- sends strict JSON-schema requests
- parses the HTTP response body
- extracts the validated output text from the OpenAI response envelope

The project depends heavily on strict JSON schemas. If a model output does not
match the schema, the higher-level code treats it as a failure and retries or
emits feedback.

## Global Pointers and Event Wiring

[`c/globals.c`](c/globals.c) implements a tiny global pointer registry.

This is used to avoid direct circular dependencies between subsystems:

- deep search gets `ds_emit`
- goal code gets `goal_emit`
- journey lookup functions are stored globally for lazy loading

This is not a general-purpose service locator. It is a small glue layer for the
subsystems that need runtime callbacks without hard linking everything together.

## Practical Execution Order

If you want to understand the project in the shortest useful order, read the
files in this sequence:

1. [`c/main.c`](c/main.c)
2. [`c/cli/ui.c`](c/cli/ui.c)
3. [`c/ne/node.c`](c/ne/node.c)
4. [`c/ne/graph/graph-engine.c`](c/ne/graph/graph-engine.c)
5. [`c/ne/input/input-processor.c`](c/ne/input/input-processor.c)
6. [`c/ne/input/json-to-graph.c`](c/ne/input/json-to-graph.c)
7. [`c/ne/goal/goal.c`](c/ne/goal/goal.c)
8. [`c/ne/search/deep-search-session.c`](c/ne/search/deep-search-session.c)
9. [`c/ne/search/deep-search-execute.c`](c/ne/search/deep-search-execute.c)
10. [`c/ne/search/ai-action.c`](c/ne/search/ai-action.c)
11. [`c/middleware/middleware.c`](c/middleware/middleware.c)
12. [`c/srv/http-server.c`](c/srv/http-server.c)
13. [`c/srv/central-server.c`](c/srv/central-server.c)

That order follows the real control flow from startup to user interaction to
graph updates to AI-driven orchestration.

## Notes

- The project is intentionally AI-heavy and uses strict schemas everywhere.
- Most behaviors are local and stateful; graph, goal, and profile mutations are
  persisted per user.
- Deep search and middleware are the two main orchestration layers. Deep
  search investigates the current state. Middleware decides what to do with a
  user message.
- The graph and goal systems are coupled through the profile and schedule
  layers, but they remain separate data models.
