export function buildGoalPath(goalId: string) {
  return `/g/${encodeURIComponent(goalId)}`
}

export type RouteName = 'home' | 'goal'

export const ROOT_GOAL_ID = 'root'

export function getLocationState() {
  const goalPathMatch = window.location.pathname.match(/^\/g\/([^/]+)$/)
  const route: RouteName = goalPathMatch ? 'goal' : 'home'

  if (route !== 'goal') {
    return { route, goalId: null as string | null }
  }

  return {
    route,
    goalId: goalPathMatch?.[1] ? decodeURIComponent(goalPathMatch[1]) : ROOT_GOAL_ID,
  }
}
