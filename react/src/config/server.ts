export const DEFAULT_SERVER_HOST = '127.0.0.1'
export const DEFAULT_SERVER_PORT = 8085
export const SERVER_BASE_URL = `http://${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT}`

export const SERVER_ENDPOINTS = {
  goalCreate: `${SERVER_BASE_URL}/goal/create`,
  goalEvents: `${SERVER_BASE_URL}/goal/events`,
  goalList: `${SERVER_BASE_URL}/goal/list`,
  goalStart: `${SERVER_BASE_URL}/goal/start`,
  goalEnd: `${SERVER_BASE_URL}/goal/end`,
  goalDecompose: `${SERVER_BASE_URL}/goal/decompose`,
  devTime: `${SERVER_BASE_URL}/dev/time`,
  devTimeAdvance: `${SERVER_BASE_URL}/dev/time/advance`,
  devTimeReset: `${SERVER_BASE_URL}/dev/time/reset`,
  schedule: `${SERVER_BASE_URL}/schedule`,
  sessionGoals: `${SERVER_BASE_URL}/goal/session`,
  goalRepair: `${SERVER_BASE_URL}/goal/repair`,
} as const

export function buildGoalDecomposeUrl(baseUrl = SERVER_BASE_URL) {
  return `${baseUrl}/goal/decompose`
}

export function buildGoalListUrl(baseUrl = SERVER_BASE_URL) {
  return `${baseUrl}/goal/list`
}

export function buildGoalStartUrl(baseUrl = SERVER_BASE_URL) {
  return `${baseUrl}/goal/start`
}

export function buildGoalEndUrl(baseUrl = SERVER_BASE_URL) {
  return `${baseUrl}/goal/end`
}
