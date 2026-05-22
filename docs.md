# CHANGE Technical Documentation

This document focuses on the `c/` tree, because that is where the actual runtime, persistence, and AI orchestration live. The React and `js/` directories are mostly clients over the C HTTP APIs.

## 1. System Overview

The project is split into three layers:

1. `c/` implements the backend runtime, domain model, AI prompts, HTTP servers, and persistence.
2. `react/` and `js/` render browser UIs and call the C HTTP endpoints.
3. `user-data/`, `mocks/`, and `dumps/` hold runtime state and debug artifacts.

The main conceptual model is:

- A user owns a semantic graph of nodes.
- A user also owns a goal system, which is a separate timeline-like structure.
- Inputs are decomposed into graph nodes.
- Goals are created, decomposed, started, ended, repaired, and scheduled.
- Deep search is a multi-step AI agent that inspects graph, goal, schedule, and profile evidence.

## 2. Startup and Shutdown

The executable entry point is [`c/main.c`](c/main.c). It does only three things:

1. `UIStart()`
2. `UILoop()`
3. `UIKill()`

The CLI layer is in [`c/cli/ui.c`](c/cli/ui.c).

### Startup path

`UIStart()` performs the important runtime initialization:

- Loads or creates users with `InitUserSystem()`.
- Chooses the first user as the CLI active user.
- Seeds the five identity graph contexts in that user’s node container.
- Initializes the global pointer registry.
- Registers global callbacks:
  - `ds_emit`
  - `goal_emit`
- Initializes the goal system.

The graph contexts are fixed and defined by `context_labels` in [`c/ne/node.c`](c/ne/node.c):

- `profesie`
- `emotie`
- `pasiuni`
- `generalitati`
- `subiectiv`

### Shutdown path

`UIKill()` stops both HTTP servers, frees the global pointer registry, frees goals, and finally frees all users.

## 3. Build and Configuration

The build is driven by [`CMakeLists.txt`](CMakeLists.txt). The main runtime libraries are built from the `c/lib`, `c/ne`, `c/srv`, `c/middleware`, and `c/cli` trees.

Important configuration lives in [`c/config.h`](c/config.h):

- `PROJECT_ROOT` must match the local checkout path.
- `CENTRAL_SERVER_PORT` is fixed at `8085`.
- `MAX_INPUT_SIZE` limits user text input.
- Several graph and goal heuristics are compile-time macros.

The most important tunables are:

- `NODE_GUESS_WEIGHT_RELEVANCE`
- `CONNECTION_GUESS_WEIGHT_RELEVANCE`
- `ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT`
- `NCOUNT_PENALTY_TO_NODE_WEIGHT`
- `SUPPORT_MERIT_TO_NODE_WEIGHT`
- `NODE_OLD_WEIGHT_RELEVANCE`
- `ACT_HALFTIME`

Those values control how fast graph salience decays and how aggressively newly inferred structure changes the stored graph.

## 4. Core Data Model

### Users

The user system is implemented in [`c/srv/user-management.c`](c/srv/user-management.c).

Each user owns:

- an ID
- a display name
- one or more journeys
- a `NodeContainer`

Users are loaded from `user-data/<user-id>/.meta` plus journey files on disk.

If no users exist, the system creates a default one.

### Node graph

The semantic graph model is defined in [`c/ne/node.h`](c/ne/node.h) and implemented in [`c/ne/node.c`](c/ne/node.c).

Important types:

- `NodeContainer`
- `Node`
- `Connection`
- `Task`

The graph has:

- nodes
- directed or bidirectional connections
- per-node activation
- per-node weight
- per-connection activation
- per-connection weight
- parent/child context hierarchy

The container also stores the indexes of the five root context nodes.

### Goals

The goal system is defined across:

- [`c/ne/goal/goal.h`](c/ne/goal/goal.h)
- [`c/ne/goal/goal.c`](c/ne/goal/goal.c)
- [`c/ne/goal/goal-util.c`](c/ne/goal/goal-util.c)
- [`c/ne/goal/goal-info.c`](c/ne/goal/goal-info.c)
- [`c/ne/goal/user-schedule.c`](c/ne/goal/user-schedule.c)
- [`c/ne/goal/goal-ai.c`](c/ne/goal/goal-ai.c)

A `Goal` is not just a title. It is a timeline object with:

- title
- extra info
- required time
- start and end timestamps
- parent/child goal relations
- previous/next timeline links
- priority
- retry depth
- journey membership

### User profile

Persistent user profile state is handled in [`c/ne/profile/user-profile.c`](c/ne/profile/user-profile.c).

The profile file is split into three logical sections:

- input history
- goal activity history
- derived profile summary

That file is the system’s lightweight long-term memory.

## 5. Graph Flow

### 5.1 Input to graph

User text enters the graph through [`DecomposeInputIntoGraph()`](c/ne/input/input-processor.c).

Flow:

1. The raw input is recorded in the user profile.
2. A decomposition prompt is built using the input text.
3. The request is sent to OpenAI with a strict JSON schema.
4. The response is parsed into a graph bundle.
5. Each context in the bundle is applied to the user graph:
   - nodes are added if missing
   - existing nodes are touched if already present
   - links are added or refreshed

The AI output is expected to map into a JSON object keyed by context name.

### 5.2 Node insertion rules

[`c/ne/input/json-to-graph.c`](c/ne/input/json-to-graph.c) performs the actual graph mutation.

For each node entry:

- `name` is required.
- `activation` and `weight` are optional.
- if a matching node already exists in the context, it is touched rather than duplicated.
- otherwise a new node is added with blended weight inference.

For each connection entry:

- `nodes` must be a two-element array.
- the code resolves both endpoints inside the same context.
- existing links are touched.
- missing links are created bidirectionally.

### 5.3 Graph refresh

[`c/ne/graph/graph-engine.c`](c/ne/graph/graph-engine.c) recomputes salience and weight.

The refresh step:

- decays old node and connection activation over time
- folds in pending touches
- calculates structural support from neighbour weights and activations
- normalizes support, seen count, and used count
- updates each node weight with a moving-average style update

This means:

- activation represents current salience
- weight represents longer-term structural importance

### 5.4 Graph export

[`c/ne/graph/graph-export.c`](c/ne/graph/graph-export.c) serializes the graph to JSON with:

- `nodes`
- `connections`

That JSON is what the graph viewer consumes.

## 6. Deep Search Flow

Deep search is the most important AI orchestration flow in the project.

The runtime lives in:

- [`c/ne/search/deep-search-session.c`](c/ne/search/deep-search-session.c)
- [`c/ne/search/deep-search-execute.c`](c/ne/search/deep-search-execute.c)
- [`c/ne/search/command-parsing.c`](c/ne/search/command-parsing.c)
- [`c/ne/search/ai-action.c`](c/ne/search/ai-action.c)

### 6.1 Session setup

`start_ds_session()` does the following:

1. Lazily loads the `ds_emit` callback from the global pointer registry.
2. Builds a persistent prompt from `DS_PERSISTENT_PROMPT`.
3. Refreshes the user graph before the search starts.
4. Emits the initial SSE event stream state.
5. Enters iterative search loops.

The session keeps two buffers:

- `persistent` memory: stable task framing
- `dynamic` memory: round-by-round evidence and model outputs

### 6.2 Search loop

Each iteration:

1. `call_gpt_deepsearch()` sends the current prompt plus dynamic memory to OpenAI.
2. The response is extracted from the OpenAI wrapper.
3. The response JSON is parsed.
4. `exec_response()` interprets the response:
   - if `finished` is true, it may produce a conclusion
   - otherwise it dispatches one of the numbered commands
5. After internal iterations, the judge step validates the result with `call_gpt_judge()`.
6. If the judge fails, server feedback is appended and the loop continues.

The search is not a single prompt/response call. It is a controlled multi-round agent with validation.

### 6.3 Deep search commands

The deep-search schema allows commands 1 through 9.

Command summary:

1. Global node filtering by activation or weight.
2. Local neighbour search inside one context.
3. Recursive family inspection around a node and context.
4. Goal overview modes:
   - `roots`
   - `due`
   - `history`
5. Render a goal subtree to a specified depth.
6. Inspect goal relations:
   - history
   - siblings
   - parents
   - linked siblings
   - uncles
7. Produce a schedule report with a threshold offset.
8. Inspect user profile history sections.
9. Produce the derived user profile summary.

These commands are implemented in [`c/ne/search/ai-action.c`](c/ne/search/ai-action.c) and parameter parsing is centralized in [`c/ne/search/command-parsing.c`](c/ne/search/command-parsing.c).

### 6.4 Global emitters

The deep-search runtime emits SSE events through a function pointer stored in the global pointer map.

That indirection is what lets the CLI and HTTP server share the same deep-search machinery.

## 7. Goal Flow

The goal system is a separate domain from the identity graph.

### 7.1 Goal creation

`CreateUserGoal()` in [`c/ne/goal/goal.c`](c/ne/goal/goal.c):

1. Records the user’s goal request in the profile.
2. Runs personalization with deep search.
3. Extracts a goal title, extra info, estimated time, and priority from the AI output.
4. Creates the goal in the active journey.
5. Optionally performs partial decomposition.
6. Records a goal-created event in the profile.

So goal creation is AI-assisted, but the system still validates the extracted structure.

### 7.2 Goal decomposition

`DecomposeGoal()`:

- refuses to decompose already decomposed goals
- refuses goals that are too short
- builds a decomposition prompt with:
  - the goal text
  - the user’s prior goal history
  - sibling goals
  - parent chain
  - linked siblings
  - uncle relations
  - a personalized deep-search summary
- calls the goal decomposition AI
- parses the returned subgoals
- creates child goals
- links them in sequence
- recalculates required time

The helper `ComputePartialDecomposition()` decomposes down the first branch until it reaches a smaller leaf-like goal.

### 7.3 Starting and ending goals

There are two start modes:

- `StartGoal()` starts a goal manually.
- `StartGoalDeep()` starts the first valid leaf goal in the subtree, respecting ordering constraints.

Ending is handled by:

- `EndGoal()`
- `EndGoalFromGoal()`

Ending a goal:

- requires all child goals to be complete if the goal is a parent
- respects timeline ordering through `prev` links
- sets end time
- marks schedule refresh as needed
- records a profile event

### 7.4 Repairing goals

Goal repair is based on a failure reason and may either:

- extend the goal time budget, or
- shorten/regenerate the goal through another AI pass

That logic is in [`c/ne/goal/goal.c`](c/ne/goal/goal.c) and [`c/ne/goal/goal-ai.c`](c/ne/goal/goal-ai.c).

### 7.5 Schedule generation

[`c/ne/goal/user-schedule.c`](c/ne/goal/user-schedule.c) builds a schedule table from due leaf goals.

The schedule logic:

- walks the goal timeline
- expands goals into scheduled leaf entries
- computes workload estimates
- exposes a serializable report

This schedule is used both by the HTTP API and by deep-search command 7.

## 8. User Profile Flow

[`c/ne/profile/user-profile.c`](c/ne/profile/user-profile.c) maintains an append-only log plus a derived summary.

### Input recording

Every meaningful input can be recorded with:

- source
- raw text
- timestamp

### Goal event recording

Every goal lifecycle event can be recorded with:

- event type
- goal ID
- goal title
- depth
- details

The derived profile state tracks:

- latest input source
- latest input text
- last goal event
- last goal ID
- last goal title
- current focus goal ID
- current focus goal title

That makes the profile an operational memory layer for the AI flows.

## 9. HTTP Servers

The project uses two HTTP servers.

### 9.1 Central server

[`c/srv/central-server.c`](c/srv/central-server.c) is the meta server on port `8085`.

Routes:

- `GET /users`
- `POST /users/create`
- `POST /users/select`

Behavior:

- lists existing users
- creates a new user
- selects a user and starts the client server for that user

This server is only for user selection and onboarding.

### 9.2 Client server

[`c/srv/http-server.c`](c/srv/http-server.c) is the per-user runtime server.

It serves:

- graph data
- goal data
- schedule data
- middleware chat
- deep search sessions
- SSE streams for live updates
- dev time controls

Key routes:

- `GET /graph`
- `POST /graph/export`
- `GET /graph/load`
- `POST /research/start`
- `GET /research/events`
- `POST /middleware/message`
- `POST /middleware/permission`
- `GET /middleware/events`
- `GET /middleware/session`
- `POST /goal/create`
- `POST /goal/repair`
- `GET /goal/events`
- `GET /goal/list`
- `GET /goal/session`
- `POST /goal/export`
- `GET /goal/load`
- `GET /dev/time`
- `POST /dev/time/advance`
- `POST /dev/time/reset`
- `POST /goal/start`
- `POST /goal/end`
- `POST /goal/decompose`
- `POST /message`
- `GET /schedule`

The server uses SSE for live updates on research and goal activity.

## 10. Middleware Flow

The middleware layer is in [`c/middleware/middleware.c`](c/middleware/middleware.c).

It is a chat-oriented orchestrator that can:

- reply to the user
- set profile fields
- clear profile fields
- request permission
- create goals
- change goal priority
- trigger deep search

The middleware is permission-aware for sensitive profile fields and keeps session history in memory.

This layer is what the React chat view talks to.

## 11. Persistence Layout

The disk layout is controlled by `c/config.h`.

Main directories:

- `user-data/`
- `mocks/`
- `dumps/`

Per-user files:

- `graph-copy.json`
- `goals-copy.json`
- `user-profile.log`
- `.meta`

The `.meta` file stores the user ID, name, and journey list.

The user profile file stores the operational history sections and the derived summary.

## 12. Frontend Integration

The React app and the legacy `js/` graph viewer are clients over the C backend.

They consume:

- the central user selection API
- the per-user client server
- SSE streams for goals and deep search
- graph export/load endpoints
- schedule and goal list endpoints

The graph viewer in [`js/graph.html`](js/graph.html) defaults to `http://127.0.0.1:8085`.

The React app follows the same split:

- login against the central server
- receive a per-user client base URL
- call the client routes directly afterward

## 13. Practical Runtime Flow

If you want the shortest end-to-end mental model, it is this:

1. Start the app.
2. Select or create a user.
3. The user’s graph, goals, and profile are loaded from disk.
4. Inputs are decomposed into graph structure.
5. Goals are created through AI-assisted extraction and decomposition.
6. Deep search uses the graph, goals, schedule, and profile as evidence.
7. HTTP and SSE keep the browser in sync with backend state.

## 14. Notes and Constraints

- This is a demo-grade system, not a hardened production backend.
- Most core flows depend on OpenAI responses and strict JSON parsing.
- `PROJECT_ROOT` must be correct or disk paths will be wrong.
- The graph and goal heuristics are compile-time, not runtime, settings.
- The codebase uses a lot of explicit assertions, so malformed AI output can abort the current flow.

