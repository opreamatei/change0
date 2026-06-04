export function buildUserPath(userId: string) {
  return `/u/${encodeURIComponent(userId)}`
}

export function buildGoalPath(userId: string, goalId: string) {
  return `/u/${encodeURIComponent(userId)}/g/${encodeURIComponent(goalId)}`
}

export type RouteName = 'home' | 'goal' | 'user'

export const ROOT_GOAL_ID = 'root'

export interface LocationState {
  route: RouteName
  userId: string | null
  goalId: string | null
}

export function getLocationState(): LocationState {
  // /u/<userId>/g/<goalId> — a focused goal inside a user's session
  const userGoalMatch = window.location.pathname.match(/^\/u\/([^/]+)\/g\/([^/]+)$/)
  if (userGoalMatch) {
    return {
      route: 'goal',
      userId: decodeURIComponent(userGoalMatch[1]),
      goalId: userGoalMatch[2] ? decodeURIComponent(userGoalMatch[2]) : ROOT_GOAL_ID,
    }
  }

  // /u/<userId> — a user's session at the journey root
  const userMatch = window.location.pathname.match(/^\/u\/([^/]+)$/)
  if (userMatch) {
    return { route: 'user', userId: decodeURIComponent(userMatch[1]), goalId: ROOT_GOAL_ID }
  }

  return { route: 'home', userId: null, goalId: null }
}
