# CHANGE Project Infrastructure Docs

This document describes the current codebase as it exists in this repository: a C11 backend that owns the data model, persistence, AI orchestration, and HTTP services, plus a React/TypeScript frontend and a legacy browser graph viewer.

The project is not a thin CRUD app. It is a local AI system with three main state machines:

1. A semantic identity graph built from user input.
2. A goal tree system with scheduling, repair, and deep-search-based decomposition.
3. A middleware/chat layer that can mutate profile state, create goals, and trigger investigations.

The system is intentionally stateful. Most files under `user-data/` are the source of truth, and a large part of startup is rebuilding in-memory containers from those files.

## Repository Shape

The important top-level areas are:

- `c/` - the main backend and domain logic.
- `react/` - the current TypeScript frontend.
- `js/` - the older browser graph viewer and lightweight app shell.
- `build.sh` - release-style build and run script.
- `debug.sh` - debug build helper.
- `config.h` - the central runtime and filesystem configuration.
- `docs/user-connections-arch.md` - a separate architecture note for user matching and connections.

## Execution Model

The compiled `change` executable starts a terminal UI in `c/cli/ui.c`. From there you can:

- initialize the user system,
- start the central meta server,
- start the per-user client server,
- create or repair goals,
- decompose user text into graph nodes,
- run deep search sessions,
- export graph and goal state to disk.

There are two HTTP servers, and they are not interchangeable:

- Central server on fixed port `8085`.
- Per-user client server on a user-specific port, initially `9000 + user_index` for new users and then persisted in `.meta`.

The browser/React frontend first talks to the central server to pick or create a user. After login it switches its base URL to the selected user server.

## Build and Link Structure

`CMakeLists.txt` builds the code as many shared libraries plus one executable.

The main layers are:

- low-level utility libraries: `util`, `change-errors`, `timeutil`, `jsonp`, `hd`
- AI transport: `openai`, `mockopenai`
- graph core: `node`, `graphengine`, `graphexport`, `json2graph`, `search`
- goal system: `goal-util`, `goal-info`, `goal-ai`, `goal-health`, `user-schedule`, `goal`
- persistence and storage: `journey`, `user-management`, `userprofile`
- connection subsystem source: `c/srv/connections.c` and `c/srv/connections.h`
- runtime services: `http-server`, `central-server`, `middleware`
- orchestration: `deepsearchsession`, `deepsearchexecute`, `aiaction`, `inputprocessor`
- CLI: `ui`

The executable links these together and enters `main()` in `c/main.c`, which just calls `UIStart()`, `UILoop()`, and `UIKill()`.

## Filesystem Layout

`config.h` defines the durable storage layout.

- `user-data/` - per-user persisted state.
- `user-data/<user_id>/.meta` - user metadata.
- `user-data/<user_id>/graph-copy.json` - serialized graph snapshot.
- `user-data/<user_id>/goals-copy.json` - goal snapshot, when exported.
- `user-data/<user_id>/user-profile.log` - profile history and derived state.
- `user-data/<user_id>/journey-<journey_id>.json` - journey file.
- `user-data/connections/` - user-to-user connection records and message logs.
- `dumps/` - error logs and debug dumps.
- `mocks/` - AI-generated mock graph and action data.
- `shared-journeys/` - central-server shared journey storage.

The code assumes `PROJECT_ROOT` is set correctly in `config.h`. Most hard-coded paths are derived from it.

## Core Utility Layer

The utility layer lives in `c/lib/util/`.

### String type

`util.h` defines a small heap-backed `String` structure:

- `p` - character buffer.
- `len` - used length.
- `cap` - allocated capacity.
- `used` / `init` - internal flags.

The main helpers are:

- `InitString`
- `FreeString`
- `CatString`
- `CatTemplateString`
- `CopyString`
- `EmptyString`
- `ResizeString`

This is the primary string type used throughout the project.

### Generic helpers

Also in `util.c`:

- `random_id()` generates IDs with a fixed leading `g`.
- `readFile()` loads a file into memory.
- `dump_to_file()` writes raw content to disk.
- `lowerAll()` lowercases a buffer in place.
- `trim_newline_inplace()` strips trailing newlines.
- `mygetline()` and `WaitForInput()` support terminal interaction.

### Error handling

`change-errors.c` defines the project-wide assertion style:

- `massert()` - soft failure, returns boolean.
- `cassert()` - fatal failure.
- `change_assert()` - file/line/function aware fatal assertion that also writes a log to `dumps/`.

The system prefers fail-fast behavior over recovery in many internal paths.

### Global pointer registry

`c/globals.c` provides a tiny registry for runtime callbacks or shared function pointers.

This is used to avoid circular dependencies in the AI and journey subsystems:

- `ds_emit` is registered here.
- `goal_emit` is registered here.
- journey title/info lookup functions are also registered here.

The pattern is simple and fragile by design: initialize the map early, store a small number of named pointers, and read them lazily where needed.

## Identity Graph Subsystem

The identity graph is the project’s core data structure. It lives under `c/ne/`.

### Data model

`node.h` defines:

- `Node`
- `Connection`
- `NodeContainer`
- `Task`

Important fields:

- `Node.label` - concept name.
- `Node._activation` - current salience.
- `Node._weight` - long-term importance.
- `Node.neighbours` - adjacency list.
- `Node.parent` / `Node.hasParent` - context tree relationship.
- `Node.childrenIndex` - fast lookup for nested nodes.
- `times_seen` / `times_used` - usage counters used by graph refresh logic.

`NodeContainer` stores:

- the node array,
- total count and capacity,
- a `needsRefresh` flag,
- total connection count,
- the five built-in context roots.

### Context roots

The graph always begins with five built-in context nodes:

- `profesie`
- `emotie`
- `pasiuni`
- `generalitati`
- `subiectiv`

These are created by `SetupContextNodes()` in `node.c`. Many lookups are scoped under one of these roots.

### Node semantics

The project distinguishes two signals:

- activation = current salience or runtime relevance.
- weight = structural importance or long-term relevance.

The exported graph format and the frontend both render those two values separately.

### Graph refresh

`graph-engine.c` recalculates graph state.

The refresh pass:

1. Applies time decay to node and connection activation.
2. Accumulates pending touches.
3. Computes support from neighbors.
4. Normalizes usage counters.
5. Updates node weight using configurable multipliers from `config.h`.

The main tuning constants are:

- `ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT`
- `NCOUNT_PENALTY_TO_NODE_WEIGHT`
- `SUPPORT_MERIT_TO_NODE_WEIGHT`
- `NODE_OLD_WEIGHT_RELEVANCE`
- `ACT_HALFTIME`

The refresh happens before deep search sessions, so graph state is not static across interactions.

### Graph export

`graph-export.c` serializes the container as JSON with two top-level arrays:

- `nodes`
- `connections`

Each node entry includes:

- `name`
- `activation`
- `weight`
- `id`
- `parent` when applicable

Each connection entry includes:

- `nodes` as `[source_id, target_id]`
- `weight`
- `activation`

This format is used by the browser graph viewer and by disk persistence.

### Input to graph

`input/json-to-graph.c` converts AI JSON into graph mutations.

The process is:

1. Parse the JSON object for a context.
2. Create or touch nodes from `nodes`.
3. Create or touch bidirectional connections from `connections`.
4. Respect the target context node as the parent container.

When a node or connection already exists, the code touches it rather than duplicating it.

### User text decomposition

`input/input-processor.c` sends the user’s raw text to OpenAI using a strict JSON schema.

The response is expected to contain one object per context, each with:

- `nodes`
- `connections`

The resulting data is merged into the current user graph through `AddContextNodesFromJSON()`.

This is the main path for converting a thought into graph state.

## Goal and Journey Subsystem

The goal system lives under `c/ne/goal/` and `c/srv/journey.*`.

### Journey model

`Journey` is the container for goals.

Fields:

- `id`
- `title`
- `extra_info`
- `goals[]`
- `goals_count`
- `is_shared`

The journey is effectively a thematic goal tree container. Users can have multiple journeys, and the first one is treated as the default destination for most goal operations.

### Goal model

`goal-util.h` defines `Goal`, which stores:

- `title`
- `extra_info`
- `start_date`
- `end_date`
- `required_time`
- `subgoals[]`
- `parent`, `prev`, `next`
- `minPauseToNext`
- `pauseToNext`
- `localIndex`
- `depth`
- `retry_depth`
- `priority`
- `id`
- `journey_id`

The important distinction is:

- root goals represent larger user objectives,
- subgoals represent the decomposition tree,
- leaf goals are the actual schedulable work units.

### Goal creation

`CreateUserGoal()` in `goal/goal.c` creates a root goal, assigns it to a journey, and then relies on AI-driven personalization and decomposition.

Goal creation is not just inserting a node. It triggers:

- title and extra-info extraction,
- estimated time inference,
- priority assignment,
- later decomposition into leaf tasks.

### Goal decomposition

`goal-ai.c` builds prompts for OpenAI and extracts structured goal data.

There are two major prompt paths:

- extraction of a single goal from raw user text,
- decomposition of a goal into 2-9 sequential subgoals.

The decomposition schema requires each child goal to include:

- `title`
- `extrainfo`
- `estimated_time`
- `min_pause_to_next`
- `pause_to_next`

This makes the decomposition tree operational rather than purely descriptive.

### Goal repair

The repair path exists because goals can drift or become invalid as the user progresses.

`RepairGoalBranch()` and related helpers can:

- extend a leaf goal if retry depth is still low,
- shorten or reframe the goal after repeated failure,
- preserve historical context in extra info.

The repair flow is intentionally recursive and history-aware.

### Goal validation and required time

`CalcGoalRequiredTime()` computes total required time for a tree by summing child required times plus pauses.

`ValidateGoal()` flags leaf goals that have been active too long without completion.

This is the basis for the goal health and scheduling systems.

### Goal health

`goal-health.c` adjusts `pauseToNext` so pending leaves fit into the user’s work block.

The logic:

1. Reads derived profile fields such as `work_day_start` and `daily_work_hours`.
2. Computes the current time offset inside the day.
3. Collects pending leaf goals across all journeys.
4. Sorts them by root priority and age.
5. Assigns dense time slots.
6. Writes the updated pauses back to the user if anything changed.

The important design choice is that pause adjustments only increase spacing; they do not shorten already-required pauses.

### Scheduling

`user-schedule.c` flattens the goal tree into a runtime schedule.

It combines:

- due leaf goals,
- their parent chain,
- calculated pauses,
- current dates.

`SerializeScheduleData()` exports the schedule report, including:

- a summary of near-term work,
- day and week load totals,
- a detailed event list.

### Journey persistence

`journey.c` manages in-memory journey allocation, serialization, and load/save.

Important behavior:

- `NewJourney()` creates a fresh journey with a random ID.
- `AddGoalToJourney()` assigns `localIndex` and stores the goal in a stable slot.
- `SerializeJourney()` writes a JSON representation.
- `LoadJourneyFromBuffer()` reconstructs a journey and remaps cross references.

This is the main durability layer for goal trees.

## User Management and Persistent State

`c/srv/user-management.c` is responsible for user discovery, creation, loading, and saving.

### User model

`User` contains:

- `name`
- `id`
- `port`
- `journeys[]`
- `nodes`
- schedule and health refresh flags
- discoverability state
- profile description

The user object is the primary runtime root for almost everything else.

### Startup sequence

`InitUserSystem()`:

1. Initializes the journey system.
2. Ensures `user-data/` exists.
3. Scans all subdirectories under `user-data/`.
4. Loads each user from its `.meta` file.
5. If no user exists, creates the default user.

### User creation

`NewUser()`:

- allocates a slot in `USER_TABLE`,
- generates a new user ID,
- initializes name, description, graph container, and flags,
- allocates a default journey named `Journey`,
- assigns a port,
- creates the user directory,
- writes `.meta`.

### User persistence

`SaveUser()` writes:

- `.meta`,
- graph export,
- all journey files.

The `.meta` file contains:

- `id`
- `name`
- `port`
- `discoverable`
- `description`
- `journeys[]`

### User discovery and matching

`c/srv/connections.c` adds user-to-user matching on top of user management. In this checkout it exists as source in the tree, but it is not declared as a standalone CMake target.

Users have:

- `discoverable` - opt-in visibility flag,
- `description` - free text used for matching.

The matching pass compares token overlap in descriptions and proposes a connection when the overlap threshold is reached.

## Connection and Matching Subsystem

`c/srv/connections.c` manages user-to-user proposals, confirmations, declines, and messages.

### Connection lifecycle

Connection states:

- `CONN_PROPOSED`
- `CONN_CONFIRMED`
- `CONN_DECLINED`

The stored record includes:

- connection ID,
- both user IDs,
- approvals,
- state,
- proposed timestamp,
- a reason string.

### Matching algorithm

The matching pass is intentionally simple:

1. Tokenize both user descriptions.
2. Lowercase and deduplicate tokens.
3. Compute shared words.
4. If the overlap count is at least `MIN_OVERLAP`, create a proposed connection.

This is not a semantic recommender. It is a coarse overlap matcher.

### Persistence

Connections are stored in `user-data/connections/`.

- `<connection_id>.conn` stores the proposal state.
- `<connection_id>.msgs` stores messages as newline-delimited JSON.

### Approval and chat

When both sides approve:

- state becomes `CONN_CONFIRMED`.
- messages are allowed.

Declined connections remain declined.

## Deep Search Subsystem

Deep search is the project’s multi-round AI investigation engine.

It lives in:

- `c/ne/search/deep-search-session.c`
- `c/ne/search/deep-search-execute.c`
- `c/ne/search/command-parsing.c`
- `c/ne/search/ai-action.c`
- `c/ne/search/search.c`

### Concept

Deep search is not ordinary chat. It is a constrained loop:

1. Build a persistent prompt from the task and current user state.
2. Ask the model for one JSON action.
3. Execute that action against the current graph or goal system.
4. Append the result to dynamic memory.
5. Repeat until the model returns `finished=true` and a conclusion.
6. Run a judge pass to validate the result.

### Session memory

`DS_memory` has two parts:

- `persistent` - the fixed task instruction and identity/system context.
- `dynamic` - the evolving transcript of model outputs and tool results.

The persistent prompt explains the environment and the allowed commands. The dynamic buffer accumulates each round’s evidence.

### Command model

The model is constrained to 9 commands.

The implemented core commands are:

- `1` - global graph filtering by activation or weight.
- `2` - local neighborhood search inside one context.
- `3` - recursive graph exploration.
- `4` - goal evidence inspection.
- `5` - goal family inspection by goal ID and depth.
- `6` - goal structure traversal methods.
- `7` - schedule inspection.
- `8` - profile section inspection.
- `9` - terminal completion object.

`command-parsing.c` validates parameters for each command and produces error text when the JSON is incomplete or invalid.

### Graph search implementation

`search.c` provides the data selection functions used by commands 1 to 3:

- top percentage by activation or weight,
- neighbor filtering,
- recursive family computation.

The family computation traces the graph recursively to a bounded depth and returns a structured textual tree.

### AI execution loop

`deep-search-execute.c` parses the model response and dispatches to the appropriate `runN()` function.

The response must fit a JSON schema. The executor then:

- validates whether the model is finished,
- checks whether it supplied a conclusion,
- otherwise runs the selected command and appends the output.

### Judge pass

After a candidate answer is produced, a judge prompt validates it against the task.

If the judge fails:

- the failure reason is appended to persistent feedback,
- the next round is allowed to correct itself.

This makes the deep search loop a constrained self-correcting process rather than a one-shot LLM call.

## Middleware Layer

`c/middleware/middleware.c` is the highest-level AI orchestration layer available in the client server.

### Role

It is responsible for deciding what to do with a user message:

- answer directly,
- update profile memory,
- ask permission,
- create a goal,
- change goal priority,
- trigger deep search,
- update graph memory,
- delay a goal,
- drop a goal,
- repair a goal branch.

### Middleware state

The module keeps two bounded in-memory registries:

- pending profile permissions,
- session histories.

Session histories track:

- chat history,
- event JSON,
- event count.

### Context building

Before calling the model, `build_middleware_context()` gathers:

- recent profile input history,
- goal activity history,
- derived profile summary,
- active goals,
- schedule snapshot,
- completed goals,
- stalled goals.

This becomes the prompt context for the middleware model.

### Permissions

Some profile keys are sensitive and require explicit approval:

- `age`
- `name`
- `location`
- `profession`

The AI can ask for permission, and the server stores the pending decision until the user resolves it.

### Why this matters

The middleware is the top-level policy engine. It is where the project starts to behave like a managed assistant instead of just a graph editor or goal tracker.

## HTTP Server Layer

There are two servers in `c/srv/`.

### Central server

The central server is meta-only. It does not talk to graph or goal engines directly.

Endpoints:

- `GET /users`
- `POST /users/create`
- `POST /users/select`
- `POST /journey/create`
- `GET /journey/<id>`
- `POST /journey/<id>`

Behavior:

- list users,
- create a user,
- select a user and start that user’s client server,
- create or update shared journeys.

Selecting a user causes the current per-user server to restart on that user’s configured port.

### Client server

The client server owns the actual per-user routes.

Main endpoints:

- `GET /graph`
- `POST /graph/export`
- `GET /graph/load`
- `POST /message`
- `POST /research/start`
- `GET /research/events`
- `POST /middleware/message`
- `POST /middleware/permission`
- `GET /middleware/events`
- `GET /middleware/session`
- `POST /goal/create`
- `POST /goal/repair`
- `POST /goal/drop`
- `GET /profile`
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
- `GET /schedule`

### SSE

The client server implements Server-Sent Events for:

- goal events,
- research events,
- middleware events.

`server_emit_event()` centralizes SSE formatting, escaping, filtering, and client cleanup.

The frontend uses those streams to update the UI live.

## Frontend Layer

The frontend exists in two forms:

- `js/` - older browser-based graph explorer.
- `react/` - current TypeScript app.

### Legacy graph viewer

`js/graph.html` is a self-contained canvas app for visualizing and manipulating the graph.

It provides:

- endpoint selection,
- graph refresh,
- graph export/import,
- SSE-backed timeline views,
- graph and goal panels.

`js/app/shared.js` handles:

- endpoint base resolution,
- central server login helpers,
- canvas drawing helpers,
- storage keys,
- transport error normalization.

`js/app/graph-view.js` parses the graph JSON and renders nodes and edges on a canvas.

### React app

The React app is the current UI path.

Important pieces:

- `react/src/config/server.ts` - endpoint management and central login helpers.
- `react/src/config/utils.ts` - route helpers and goal URL helpers.
- `react/src/App.tsx` - main application shell, route handling, SSE subscriptions, goal state refresh, and login/logout transitions.
- `react/src/section/login-view.tsx` - central-server sign-in and user creation.
- `react/src/section/goal-view.tsx` - goal tree display and actions.
- `react/src/section/chat-view.tsx` - middleware conversation and event timeline.
- `react/src/section/profile-view.tsx` - profile editing.
- `react/src/section/daily-brief-view.tsx` - schedule and daily summary.

### Frontend/server contract

The frontend does not own the domain model. It consumes server JSON and SSE events and turns them into UI state.

That means:

- the backend defines the canonical shape,
- the frontend only renders and triggers actions,
- reloads are the expected way to re-synchronize state.

## Configuration Knobs

The most important configuration file is `c/config.h`.

The critical knobs are:

- `PROJECT_ROOT`
- `USER_DATA_DIRECTORY`
- `DEFAULT_MOCK_DIRECTORY`
- `DEFAULT_DUMP_DIRECTORY`
- `CENTRAL_SERVER_PORT`
- `MAX_INPUT_SIZE`
- `NODE_GUESS_WEIGHT_RELEVANCE`
- `CONNECTION_GUESS_WEIGHT_RELEVANCE`
- `ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT`
- `NCOUNT_PENALTY_TO_NODE_WEIGHT`
- `SUPPORT_MERIT_TO_NODE_WEIGHT`
- `NODE_OLD_WEIGHT_RELEVANCE`
- `ACT_HALFTIME`

Changing these requires a rebuild.

The configuration is not abstracted into environment variables. This project is deliberately code- and macro-driven.

## Mock and Test Support

`c/lib/openai/mockopenai.c` can generate mock graph data and mock action data.

The mock generation schema matches the graph and deep-search command formats closely enough to test the runtime without hand-writing every fixture.

The mock system is also used by the CLI option to regenerate stored mock files.

## Important Technical Constraints

These are worth calling out because they shape the codebase:

- The code assumes local disk persistence and mutable files.
- The code assumes OpenAI connectivity for the real AI flows.
- Many invariants are enforced by `change_assert()` and will terminate the process on violation.
- There is a large amount of manual JSON building and parsing.
- The deep search and middleware loops are schema-driven, not natural-language freeform.
- The graph and goal systems are coupled through shared user state, but they are not the same model.

## Practical Reading Order

If you want to understand the project in code order, read it in this sequence:

1. `c/config.h`
2. `c/lib/util/*`
3. `c/ne/node.*`
4. `c/ne/graph/*`
5. `c/ne/input/*`
6. `c/srv/journey.*`
7. `c/ne/goal/*`
8. `c/ne/search/*`
9. `c/middleware/middleware.c`
10. `c/srv/user-management.c`
11. `c/srv/http-server.c`
12. `c/srv/central-server.c`
13. `react/src/*` and `js/app/*`

That order follows the dependency graph rather than the directory tree.
