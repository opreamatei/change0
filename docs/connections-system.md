# User Connections System

A server-side feature for matching and connecting users who are working toward compatible goals. Opt-in only. All matching logic runs centrally; individual users learn only their match partner's name and a vague reason — never each other's raw descriptions.

---

## Files changed

### New files
| File | Role |
|---|---|
| `c/srv/connections.h` | Public API — types, constants, function declarations |
| `c/srv/connections.c` | Full implementation (~450 lines) |
| `docs/connections-system.md` | This file |
| `react/src/section/connections-view.tsx` | React "People" tab |

### Modified files
| File | What changed |
|---|---|
| `c/srv/user-management.h` | Added `discoverable` (bool) and `description` (String) to `User` struct |
| `c/srv/user-management.c` | Serialize/deserialize those two fields in `.meta` JSON; init/free them |
| `c/srv/central-server.c` | Include connections.h; `InitConnectionSystem` / `FreeConnectionSystem` in start/stop; 8 new HTTP routes |
| `c/srv/http-server.c` | Include connections.h; extended `GET /profile` response; new `POST /profile/update` endpoint |
| `c/middleware/middleware.c` | 3 new action types: `set_discoverable`, `set_private`, `update_match_description` |
| `CMakeLists.txt` | New `connections` shared library target; added as dependency of `central-server`, `http-server`, `middleware` |
| `react/src/App.tsx` | Added "People" tab (`connections` panel) |
| `react/src/config/server.ts` | Added `CENTRAL_ENDPOINTS` for all connection/message routes; `profileUpdate` in `SERVER_ENDPOINTS` |
| `react/src/section/profile-view.tsx` | Editable settings (name, age, schedule, discoverable toggle + description) |

---

## Data model

### `UserConn` (in `connections.h`)
One record per proposed/confirmed/declined pair. Stored as `user-data/connections/<id>.conn` (single-line JSON).

```
id           — 32-char random hex
a, b         — user IDs of the two matched users
a_approved   — bool: user A clicked Accept
b_approved   — bool: user B clicked Accept
state        — 0=PROPOSED, 1=CONFIRMED, 2=DECLINED
proposed_at  — unix timestamp
reason       — human-readable match reason, e.g. "Both have goals around: rust, systems, performance."
```

### `UserConnMessage`
One record per chat message. Stored append-only as ndjson in `user-data/connections/<id>.msgs`.

```
connection_id — back-reference
sender        — user ID of sender
at            — unix timestamp
text          — message body (max 2048 chars)
```

---

## In-memory storage

Both tables live in module-level statics in `connections.c`:

```c
static UserConn        ConnectionTable[MAX_CONNECTIONS];  /* 256 slots */
static size_t          ConnectionCount;
static UserConnMessage MessageTable[MAX_MESSAGES];        /* 1024 slots */
static size_t          MessageCount;
```

`InitConnectionSystem` reads all `.conn` files from `user-data/connections/` on startup, then loads messages for each. `FreeConnectionSystem` just zeroes the counts (the static arrays need no heap free).

---

## Matching algorithm

`RunMatchingPass()` — called automatically on every `SetUserDiscoverable` / `UpdateUserDescription`.

1. Walk all `USER_TABLE` pairs (O(n²), fine for ≤8 users).
2. Skip if either user is not discoverable or has no description.
3. Skip if a connection between this pair already exists (any state).
4. Tokenize both descriptions: lowercase words ≥3 chars, deduplicated, max 128 tokens.
5. Count shared tokens. If ≥ `MIN_OVERLAP` (3), propose a connection.
6. Build a readable reason from the top-3 longest shared words: `"Both have goals around: X, Y, Z."`
7. Persist the new `UserConn` immediately.

The match description is **never shared** with the other user. Users only see the reason string.

---

## Central server endpoints

All on port `CENTRAL_SERVER_PORT` (8085).

| Method | Path | Body / Query | Effect |
|---|---|---|---|
| POST | `/connections/discoverable` | `{user_id, description}` | `SetUserDiscoverable` → `RunMatchingPass` |
| POST | `/connections/private` | `{user_id}` | `SetUserPrivate` |
| POST | `/connections/description` | `{user_id, description}` | `UpdateUserDescription` → `RunMatchingPass` if discoverable |
| GET | `/connections?user_id=...` | query param | Returns all non-declined connections for user with `state`, `reason`, `other_name`, approval flags |
| POST | `/connections/approve` | `{connection_id, user_id}` | Sets approval flag; transitions to CONFIRMED when both approve |
| POST | `/connections/decline` | `{connection_id, user_id}` | Sets state to DECLINED |
| POST | `/messages/send` | `{connection_id, sender_id, text}` | Appends message (only if CONFIRMED) |
| GET | `/messages?connection_id=...` | query param | Returns all messages for connection |

### Query string parsing

The central server's path buffer is 128 chars. `dispatch()` splits on `?` into `clean_path` + `query` before matching routes. `GET` handlers receive `query` and scan for `key=value` manually (no URL-decode needed since IDs are hex).

---

## Per-user server endpoint

On the user's own port (varies).

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/profile` | — | Now also returns `discoverable` (bool) and `description` (string) |
| POST | `/profile/update` | `{key, value}` | Updates one field (see allowed keys below) |

### Allowed keys for `POST /profile/update`

| Key | Handler |
|---|---|
| `name` | Updates `user->name`, calls `SaveUser` |
| `discoverable` | `"true"` → `SetUserDiscoverable`; `"false"` → `SetUserPrivate` |
| `description` | `UpdateUserDescription` |
| `age` | `UserProfileSetDerivedField` |
| `work_day_start` | `UserProfileSetDerivedField` |
| `daily_work_hours` | `UserProfileSetDerivedField` |
| `min_session_duration` | `UserProfileSetDerivedField` |

Any other key returns `400 key_not_editable`.

---

## Middleware actions

Three new action types added to the AI middleware schema and executor:

| Action | Required field | Effect |
|---|---|---|
| `set_discoverable` | `value` (description text) | `SetUserDiscoverable(user, value)` → emits `user_discoverable` SSE event |
| `set_private` | — | `SetUserPrivate(user)` → emits `user_private` SSE event |
| `update_match_description` | `value` (description text) | `UpdateUserDescription(user, value)` → emits `match_description_updated` SSE event |

The AI generates the description from the conversation + graph; the user can review and edit it in the profile settings afterwards.

---

## React "People" tab

`connections-view.tsx` — polls `GET /connections?user_id=` every 5 seconds.

States:
- **Proposed, not yet approved by me** — shows Accept / Decline buttons
- **Proposed, waiting on them** — shows "Waiting for the other person to accept."
- **Confirmed** — tap to open message thread
- **Declined** — collapsed under a `<details>` element

Message thread (`MessageThread`) polls `GET /messages?connection_id=` every 3 seconds. Send on Enter or button. Scrolls to bottom on new messages.

---

## Profile settings (updated `profile-view.tsx`)

New editable settings section at the top of the You tab:

- **Identity**: Name (text), Age (number)
- **Work schedule**: Day start (time input), Daily hours (number), Min session duration (number)
- **Connections**: Toggle for discoverable + textarea for match description (only visible when discoverable is on)

Each field saves immediately on Enter or Save button click. The button label transitions: dirty → `Save`, saving → `…`, saved → `Saved` (1.5s then resets).

---

## Naming notes

The `Connection` name was already taken by `node.h` (graph edge type). The user-connections struct is therefore named `UserConn` and the message struct `UserConnMessage` throughout.
