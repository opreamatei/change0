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
export const CENTRAL_BASE_URL = `http://${DEFAULT_SERVER_HOST}:${CENTRAL_SERVER_PORT}`

const STORAGE_KEY = 'change.clientBaseUrl'

let clientBaseUrl: string | null =
  (typeof window !== 'undefined' && window.localStorage?.getItem(STORAGE_KEY)) || null

type Listener = (next: string | null) => void
const listeners = new Set<Listener>()

export function getClientBaseUrl(): string | null {
  return clientBaseUrl
}

export function setClientBaseUrl(next: string | null) {
  clientBaseUrl = next
  if (typeof window !== 'undefined') {
    if (next) window.localStorage?.setItem(STORAGE_KEY, next)
    else window.localStorage?.removeItem(STORAGE_KEY)
  }
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
  get goalDrop() { return path('/goal/drop')() },
  get goalCreateSharedRoot() { return path('/goal/create-shared-root')() },
  get goalSharedAction() { return path('/goal/shared-action')() },
  get profile() { return path('/profile')() },
  get profileUpdate() { return path('/profile/update')() },
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
}

export const CENTRAL_ENDPOINTS = {
  users: `${CENTRAL_BASE_URL}/users`,
  usersCreate: `${CENTRAL_BASE_URL}/users/create`,
  usersSelect: `${CENTRAL_BASE_URL}/users/select`,
  connections: (userId: string) => `${CENTRAL_BASE_URL}/connections?user_id=${encodeURIComponent(userId)}`,
  connectionsDiscoverable: `${CENTRAL_BASE_URL}/connections/discoverable`,
  connectionsPrivate: `${CENTRAL_BASE_URL}/connections/private`,
  connectionsDescription: `${CENTRAL_BASE_URL}/connections/description`,
  connectionsApprove: `${CENTRAL_BASE_URL}/connections/approve`,
  connectionsDecline: `${CENTRAL_BASE_URL}/connections/decline`,
  messagesSend: `${CENTRAL_BASE_URL}/messages/send`,
  messages: (connectionId: string) => `${CENTRAL_BASE_URL}/messages?connection_id=${encodeURIComponent(connectionId)}`,
  /*
   * Shared journeys live on the central server (so both participants see
   * the same source of truth without sync). /journey/create takes
   * {name, user_ids:[...]}, /journey/list?user_id=... lists journeys the
   * user participates in, /journey/<id> returns one with goals + users.
   */
  journeyCreate: `${CENTRAL_BASE_URL}/journey/create`,
  journeyList: (userId: string) => `${CENTRAL_BASE_URL}/journey/list?user_id=${encodeURIComponent(userId)}`,
  journey: (journeyId: string) => `${CENTRAL_BASE_URL}/journey/${encodeURIComponent(journeyId)}`,
  journeyProposals:    (journeyId: string) => `${CENTRAL_BASE_URL}/journey/${encodeURIComponent(journeyId)}/proposals`,
  journeyProposeRoot:  (journeyId: string) => `${CENTRAL_BASE_URL}/journey/${encodeURIComponent(journeyId)}/propose-root`,
  journeyApproveRoot:  (journeyId: string) => `${CENTRAL_BASE_URL}/journey/${encodeURIComponent(journeyId)}/approve-root`,
  journeyDeclineRoot:  (journeyId: string) => `${CENTRAL_BASE_URL}/journey/${encodeURIComponent(journeyId)}/decline-root`,
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
