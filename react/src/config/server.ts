/*
 * Two servers live behind this module:
 *
 *   Central server (fixed port): meta-only. /users, /users/create,
 *     /users/select. Used only by the login flow.
 *
 *   Client server (random port): per-user routes. The base URL becomes
 *     known after the user signs in via the central server, which is
 *     why endpoint resolution must be lazy.
 */

export const DEFAULT_SERVER_HOST = '127.0.0.1'
export const CENTRAL_SERVER_PORT = 8085

/*
 * Server protocol + host are configurable from the sign-in screen and persist
 * in localStorage, so the same build can talk to a local http server or a
 * remote https one. Everything that targets the central or per-user server
 * derives its base URL from these at access time.
 */
const PROTOCOL_KEY = 'change.serverProtocol'
const HOST_KEY     = 'change.serverHost'

export function getServerProtocol(): 'http' | 'https' {
  if (typeof window === 'undefined') return 'http'
  return window.localStorage?.getItem(PROTOCOL_KEY) === 'https' ? 'https' : 'http'
}
export function setServerProtocol(p: 'http' | 'https') {
  if (typeof window !== 'undefined') window.localStorage?.setItem(PROTOCOL_KEY, p)
}
export function getServerHost(): string {
  if (typeof window === 'undefined') return DEFAULT_SERVER_HOST
  return window.localStorage?.getItem(HOST_KEY) || DEFAULT_SERVER_HOST
}
export function setServerHost(h: string) {
  if (typeof window !== 'undefined')
    window.localStorage?.setItem(HOST_KEY, h.trim() || DEFAULT_SERVER_HOST)
}

function centralBase(): string {
  return `${getServerProtocol()}://${getServerHost()}:${CENTRAL_SERVER_PORT}`
}

/** Build a per-user client base URL from the configured protocol/host. */
export function buildClientBaseUrl(port: number): string {
  return `${getServerProtocol()}://${getServerHost()}:${port}`
}

const STORAGE_KEY = 'change.clientBaseUrl'

let clientBaseUrl: string | null = null
if (typeof window !== 'undefined') window.localStorage?.removeItem(STORAGE_KEY)

type Listener = (next: string | null) => void
const listeners = new Set<Listener>()

export function getClientBaseUrl(): string | null {
  return clientBaseUrl
}

export function setClientBaseUrl(next: string | null) {
  clientBaseUrl = next
  for (const l of listeners) l(next)
}

export function subscribeClientBaseUrl(l: Listener) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/*
 * Used by code that still wants a base URL for relative paths. Throws if
 * there is no active client server — callers must guard against this case.
 */
export function requireClientBaseUrl(): string {
  if (!clientBaseUrl) throw new Error('No active client server. Sign in first.')
  return clientBaseUrl
}

/*
 * Back-compat name. Components used to import SERVER_BASE_URL as a
 * constant; they now get the live value at access time via this getter.
 */
export const SERVER_BASE_URL = new Proxy(
  { toString: () => clientBaseUrl ?? '' },
  {
    get(_t, prop) {
      if (prop === 'toString' || prop === Symbol.toPrimitive) {
        return () => clientBaseUrl ?? ''
      }
      return undefined
    },
  },
) as unknown as string

const path = (suffix: string) => () => `${clientBaseUrl ?? ''}${suffix}`

export const SERVER_ENDPOINTS = {
  get goalCreate() { return path('/goal/create')() },
  get goalEvents() { return path('/goal/events')() },
  get goalList() { return path('/goal/list')() },
  get goalStart() { return path('/goal/start')() },
  get goalEnd() { return path('/goal/end')() },
  get goalDecompose() { return path('/goal/decompose')() },
  get devTime() { return path('/dev/time')() },
  get devTimeAdvance() { return path('/dev/time/advance')() },
  get devTimeReset() { return path('/dev/time/reset')() },
  get schedule() { return path('/schedule')() },
  get scheduleRefresh() { return path('/schedule/refresh')() },
  get sessionGoals() { return path('/goal/session')() },
  get goalRepair() { return path('/goal/repair')() },
  get goalExtend() { return path('/goal/extend')() },
  get goalReshape() { return path('/goal/reshape')() },
  get goalDrop() { return path('/goal/drop')() },
  get goalCreateSharedRoot() { return path('/goal/create-shared-root')() },
  get goalSharedAction() { return path('/goal/shared-action')() },
  get profile() { return path('/profile')() },
  get profileUpdate() { return path('/profile/update')() },
  get profileAvatar() { return path('/profile/avatar')() },
  get middlewareMessage() { return path('/middleware/message')() },
  get middlewareSession() { return path('/middleware/session')() },
  get middlewareEvents() { return path('/middleware/events')() },
  get middlewarePermission() { return path('/middleware/permission')() },
  get chatSessions() { return path('/chat/sessions')() },

  get journalCreate()  { return path('/journal/create')() },
  get journalList()    { return path('/journal/list')() },
  get journalEntry()   { return path('/journal/entry')() },
  get journalUpdate()  { return path('/journal/update')() },
  get journalDelete()  { return path('/journal/delete')() },
  get journalAttach()  { return path('/journal/attach')() },
  get journalFile()    { return path('/journal/file')() },
  get journalEmbed()         { return path('/journal/embed')() },
  get journalEmbedDelete()   { return path('/journal/embed/delete')() },

  get reminders()        { return path('/reminders')() },
  get remindersSave()    { return path('/reminders/save')() },
  get remindersDelete()  { return path('/reminders/delete')() },

  get submissionsCreate() { return path('/submissions/create')() },
  get submissionsFile()   { return path('/submissions/file')() },
}

export const CENTRAL_ENDPOINTS = {
  get users() { return `${centralBase()}/users` },
  get usersCreate() { return `${centralBase()}/users/create` },
  get usersSelect() { return `${centralBase()}/users/select` },
  userAvatar: (userId: string) => `${centralBase()}/users/avatar?id=${encodeURIComponent(userId)}`,
  connections: (userId: string) => `${centralBase()}/connections?user_id=${encodeURIComponent(userId)}`,
  get connectionsDiscoverable() { return `${centralBase()}/connections/discoverable` },
  get connectionsPrivate() { return `${centralBase()}/connections/private` },
  get connectionsDescription() { return `${centralBase()}/connections/description` },
  get connectionsApprove() { return `${centralBase()}/connections/approve` },
  get connectionsDecline() { return `${centralBase()}/connections/decline` },
  get messagesSend() { return `${centralBase()}/messages/send` },
  messages: (connectionId: string) => `${centralBase()}/messages?connection_id=${encodeURIComponent(connectionId)}`,
  /*
   * Shared journeys live on the central server (so both participants see
   * the same source of truth without sync). /journey/create takes
   * {name, user_ids:[...]}, /journey/list?user_id=... lists journeys the
   * user participates in, /journey/<id> returns one with goals + users.
   */
  get journeyCreate() { return `${centralBase()}/journey/create` },
  journeyList: (userId: string) => `${centralBase()}/journey/list?user_id=${encodeURIComponent(userId)}`,
  journey: (journeyId: string) => `${centralBase()}/journey/${encodeURIComponent(journeyId)}`,
  journeyProposals:    (journeyId: string) => `${centralBase()}/journey/${encodeURIComponent(journeyId)}/proposals`,
  journeyProposeRoot:  (journeyId: string) => `${centralBase()}/journey/${encodeURIComponent(journeyId)}/propose-root`,
  journeyApproveRoot:  (journeyId: string) => `${centralBase()}/journey/${encodeURIComponent(journeyId)}/approve-root`,
  journeyDeclineRoot:  (journeyId: string) => `${centralBase()}/journey/${encodeURIComponent(journeyId)}/decline-root`,

  submissionsPending: (userId: string, label: string) =>
    `${centralBase()}/submissions/pending?user_id=${encodeURIComponent(userId)}&label=${encodeURIComponent(label)}`,
  submissionReview: (subId: string) => `${centralBase()}/submissions/${encodeURIComponent(subId)}/review`,
  submissionFile: (subId: string, fname: string) =>
    `${centralBase()}/submissions/file?id=${encodeURIComponent(subId)}&f=${encodeURIComponent(fname)}`,
  submissionStatus: (subId: string) => `${centralBase()}/submissions/${encodeURIComponent(subId)}/status`,
}

export function buildGoalDecomposeUrl(baseUrl = clientBaseUrl ?? '') {
  return `${baseUrl}/goal/decompose`
}

export function buildGoalListUrl(baseUrl = clientBaseUrl ?? '') {
  return `${baseUrl}/goal/list`
}

export function buildGoalStartUrl(baseUrl = clientBaseUrl ?? '') {
  return `${baseUrl}/goal/start`
}

export function buildGoalEndUrl(baseUrl = clientBaseUrl ?? '') {
  return `${baseUrl}/goal/end`
}
