import {
  SERVER_BASE_URL,
  buildGoalDecomposeUrl,
  buildGoalListUrl,
} from './config/server'

export type GoalRelation = 'parent' | 'next' | 'prev'

export interface GoalInit {
  id: string
  title: string
  extraInfo: string
  startDate: number | null
  endDate: number | null
  requiredTime: number
  subgoals: number[]
  parent: number | null
  prev: number | null
  next: number | null
  globalIndex: number
  depth: number
  retryDepth: number
  priority: number
}

export interface GoalDecomposePayload {
  goalIndex: number
}

export interface GoalListResponseItem {
  id: string
  globalIndex: number
  title: string
  extra_info: string
  start_date: number
  end_date: number
  required_time: number
  subgoals: number[]
  parent: number
  prev: number
  next: number
  depth: number
  retry_depth: number
  priority: number
}

export interface GoalListResponse {
  ok: boolean
  count: number
  container_len: number
  goals: GoalListResponseItem[]
}

export class Goal implements GoalInit {
  static readonly fields: ReadonlyArray<keyof GoalInit> = [
    'id',
    'title',
    'extraInfo',
    'startDate',
    'endDate',
    'requiredTime',
    'subgoals',
    'parent',
    'prev',
    'next',
    'globalIndex',
    'depth',
    'retryDepth',
    'priority',
  ]

  id: string
  title: string
  extraInfo: string
  startDate: number | null
  endDate: number | null
  requiredTime: number
  subgoals: number[]
  parent: number | null
  prev: number | null
  next: number | null
  globalIndex: number
  depth: number
  retryDepth: number
  priority: number

  constructor(init: GoalInit) {
    this.id = init.id
    this.title = init.title
    this.extraInfo = init.extraInfo
    this.startDate = init.startDate
    this.endDate = init.endDate
    this.requiredTime = init.requiredTime
    this.subgoals = [...init.subgoals]
    this.parent = init.parent
    this.prev = init.prev
    this.next = init.next
    this.globalIndex = init.globalIndex
    this.depth = init.depth
    this.retryDepth = init.retryDepth
    this.priority = init.priority
  }

  static from(init: GoalInit | Goal) {
    return init instanceof Goal ? init : new Goal(init)
  }

  static fromServer(item: GoalListResponseItem) {
    return new Goal({
      id: item.id,
      title: item.title,
      extraInfo: item.extra_info,
      startDate: item.start_date > 0 ? item.start_date : null,
      endDate: item.end_date > 0 ? item.end_date : null,
      requiredTime: item.required_time,
      subgoals: [...item.subgoals],
      parent: item.parent > 0 ? item.parent : null,
      prev: item.prev > 0 ? item.prev : null,
      next: item.next > 0 ? item.next : null,
      globalIndex: item.globalIndex,
      depth: item.depth,
      retryDepth: item.retry_depth,
      priority: item.priority,
    })
  }

  toDecomposePayload(): GoalDecomposePayload {
    return { goalIndex: this.globalIndex }
  }

  static decomposeUrl(baseUrl = SERVER_BASE_URL) {
    return buildGoalDecomposeUrl(baseUrl)
  }

  formatRequiredTime() {
    return formatGoalDuration(this.requiredTime)
  }

  formatStartDate() {
    return formatGoalDate(this.startDate)
  }

  formatEndDate() {
    return formatGoalDate(this.endDate)
  }
}

export interface GoalEdge {
  from: number
  to: number
  relation: GoalRelation
}

export function findGoalByGlobalIndex(goals: Goal[], globalIndex: number) {
  return goals.find((goal) => goal.globalIndex === globalIndex) ?? null
}

export function findGoalById(goals: Goal[], id: string) {
  return goals.find((goal) => goal.id === id) ?? null
}

export function getGoalChildren(goals: Goal[], goalIndex: number) {
  return goals.filter((goal) => goal.parent === goalIndex)
}

export function getRootGoals(goals: Goal[]) {
  return goals.filter((goal) => goal.parent === null)
}

export function formatGoalDuration(seconds: number) {
  const total = Math.max(0, Math.trunc(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainingSeconds = total % 60

  if (hours === 0 && minutes === 0) return `${remainingSeconds}s`
  if (hours === 0) return `${minutes}m ${remainingSeconds}s`
  if (minutes === 0 && remainingSeconds === 0) return `${hours}h`
  if (remainingSeconds === 0) return `${hours}h ${minutes}m`

  return `${hours}h ${minutes}m ${remainingSeconds}s`
}

export function formatGoalDate(value: number | null) {
  if (!value) return 'not set'

  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return 'invalid date'

  return date.toLocaleString()
}

export async function loadGoalsFromServer(baseUrl = SERVER_BASE_URL) {
  const response = await fetch(buildGoalListUrl(baseUrl), {
    method: 'GET',
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Failed to load goals: ${response.status}`)
  }

  const payload = (await response.json()) as GoalListResponse
  const items = Array.isArray(payload.goals) ? payload.goals : []

  return items.map(Goal.fromServer)
}

/* -------------------------------------------------------------------------- */
/* Mock goals                                                                  */
/* -------------------------------------------------------------------------- */

export interface MockGoalTemplate {
  title: string
  extraInfo?: string
  requiredTime: number
  priority?: number
  startDate?: number | null
  endDate?: number | null
  children?: MockGoalTemplate[]
}

export function createMockGoalListFromTemplate(
  rootTitle = 'Build a production-quality MMO RPG',
): Goal[] {
  const hour = 3600
  const minute = 60
  const now = Math.floor(Date.now() / 1000)

  const template: MockGoalTemplate = {
    title: rootTitle,
    extraInfo: 'Root production goal. Total time is elapsed/total time, not focused work time.',
    requiredTime: 50 * hour,
    priority: 100,
    startDate: now - 2 * hour,
    endDate: null,
    children: [
      {
        title: 'Define the vertical slice scope and constraints',
        extraInfo: 'Current scheduled branch. Decompose this first before moving right.',
        requiredTime: 12 * hour,
        priority: 100,
        startDate: now - 2 * hour,
        endDate: null,
        children: [
          {
            title: 'Pin down the minimum viable MMO slice',
            extraInfo: 'Choose the smallest complete playable loop.',
            requiredTime: 3 * hour,
            priority: 100,
            startDate: now - 2 * hour,
            endDate: null,
            children: [
              {
                title: 'Write the core player loop',
                extraInfo: 'Combat, reward, progression, return-to-hub loop.',
                requiredTime: 55 * minute,
                priority: 100,
                startDate: now - 90 * minute,
                endDate: now - 35 * minute,
              },
              {
                title: 'List must-have multiplayer behaviors',
                extraInfo: 'Party visibility, shared enemies, state sync, persistence.',
                requiredTime: 45 * minute,
                priority: 95,
                startDate: now - 30 * minute,
                endDate: null,
              },
            ],
          },
          {
            title: 'Specify class, role, and party assumptions',
            extraInfo: 'Define combat roles before architecture work.',
            requiredTime: 2 * hour,
            priority: 90,
            startDate: null,
            endDate: null,
            children: [
              {
                title: 'Draft the initial class matrix',
                extraInfo: 'Tank, damage, support, healer assumptions.',
                requiredTime: 50 * minute,
                priority: 90,
              },
              {
                title: 'Define party size and matchmaking rules',
                extraInfo: 'Minimum assumptions for multiplayer encounters.',
                requiredTime: 40 * minute,
                priority: 85,
              },
            ],
          },
          {
            title: 'Define the progression cadence',
            extraInfo: 'Decide how fast players unlock power.',
            requiredTime: 2 * hour,
            priority: 80,
            children: [
              {
                title: 'Sketch level and loot pacing',
                extraInfo: 'Early-game reward cadence.',
                requiredTime: 45 * minute,
                priority: 80,
              },
            ],
          },
          {
            title: 'Write the explicit out-of-scope bounds',
            extraInfo: 'Prevent scope creep.',
            requiredTime: 90 * minute,
            priority: 70,
            children: [
              {
                title: 'Create the not-now list',
                extraInfo: 'Raids, guild economy, crafting depth, large world streaming.',
                requiredTime: 35 * minute,
                priority: 70,
              },
            ],
          },
          {
            title: 'Validate the slice definition against time budget',
            extraInfo: 'Check whether the current slice fits the 50h total-time envelope.',
            requiredTime: 90 * minute,
            priority: 65,
            children: [
              {
                title: 'Review decomposition and trim scope',
                extraInfo: 'Remove or defer anything exceeding budget.',
                requiredTime: 30 * minute,
                priority: 65,
              },
            ],
          },
        ],
      },
      {
        title: 'Design the multiplayer architecture',
        extraInfo: 'Generated after the current branch has enough confidence.',
        requiredTime: 10 * hour,
        priority: 80,
        children: [
          {
            title: 'Choose authoritative server model',
            extraInfo: 'Decide what state is owned by server versus client.',
            requiredTime: 55 * minute,
            priority: 80,
          },
          {
            title: 'Define world/session topology',
            extraInfo: 'Instances, shards, zones, rooms, or hybrid.',
            requiredTime: 50 * minute,
            priority: 75,
          },
        ],
      },
      {
        title: 'Implement player combat, movement, and interaction',
        extraInfo: 'Core gameplay implementation branch.',
        requiredTime: 12 * hour,
        priority: 75,
        children: [
          {
            title: 'Implement movement sync prototype',
            extraInfo: 'Client prediction or simple authoritative sync.',
            requiredTime: 60 * minute,
            priority: 75,
          },
          {
            title: 'Implement basic combat exchange',
            extraInfo: 'Targeting, damage, cooldowns, server validation.',
            requiredTime: 55 * minute,
            priority: 72,
          },
        ],
      },
      {
        title: 'Add progression, loot, and persistence',
        extraInfo: 'State that survives sessions.',
        requiredTime: 9 * hour,
        priority: 65,
        children: [],
      },
      {
        title: 'Package and test the playable vertical slice',
        extraInfo: 'Final validation branch.',
        requiredTime: 7 * hour,
        priority: 55,
        children: [],
      },
    ],
  }

  return createMockGoals(template)
}

export function createMockGoals(template: MockGoalTemplate): Goal[] {
  const goals: Goal[] = []
  let nextGlobalIndex = 1

  function visit(
    node: MockGoalTemplate,
    depth: number,
    parent: number | null,
    siblingPosition: number,
  ): number {
    const globalIndex = nextGlobalIndex++
    const childIndexes: number[] = []

    const goal = new Goal({
      id: `mock-goal-${globalIndex}`,
      title: node.title,
      extraInfo: node.extraInfo ?? '',
      startDate: node.startDate ?? null,
      endDate: node.endDate ?? null,
      requiredTime: node.requiredTime,
      subgoals: childIndexes,
      parent,
      prev: null,
      next: null,
      globalIndex,
      depth,
      retryDepth: 0,
      priority: node.priority ?? Math.max(1, 100 - depth * 10 - siblingPosition),
    })

    goals.push(goal)

    const children = node.children ?? []

    for (let i = 0; i < children.length; i += 1) {
      const childIndex = visit(children[i], depth + 1, globalIndex, i)
      childIndexes.push(childIndex)
    }

    for (let i = 0; i < childIndexes.length; i += 1) {
      const child = findGoalByGlobalIndex(goals, childIndexes[i])
      if (!child) continue

      child.prev = i > 0 ? childIndexes[i - 1] : null
      child.next = i < childIndexes.length - 1 ? childIndexes[i + 1] : null
    }

    goal.subgoals = childIndexes

    return globalIndex
  }

  visit(template, 0, null, 0)

  return goals
}

/* -------------------------------------------------------------------------- */
/* Goal map preparation for GLSL                                                */
/* -------------------------------------------------------------------------- */

export type InferredGoalState = 'idle' | 'started' | 'finished'

export interface PreparedGoalNode {
  id: string
  parentId: number | null
  depthAbsolute: number
  depthRelative: number
  x: number
  y: number
  radius: number
  height: number
  stateValue: number
  progress: number
  parentIndex: number
  groupId: number
  globalIndex: number
}

export interface InteractionNode {
  id: string
  title: string
  x: number
  y: number
  radius: number
  state: InferredGoalState
  progress: number
  parentId: number | null
  parentIndex: number
  globalIndex: number
}

export interface PrepareGoalMapOptions {
  maxDepthRelative?: number
  rootRadius?: number
  containmentFactor?: number
  siblingPadding?: number
  minRadius?: number
  maxVisibleGoals?: number
  heightBase?: number
  heightDepthFalloff?: number
  now?: number
}

export interface PreparedGoalMapData {
  visibleGoals: PreparedGoalNode[]
  shaderData: Float32Array
  textureWidth: number
  textureHeight: number
  interactionNodes: InteractionNode[]
}

export function inferGoalState(goal: Goal): InferredGoalState {
  if (goal.startDate && goal.endDate) return 'finished'
  if (goal.startDate && !goal.endDate) return 'started'
  return 'idle'
}

export function getGoalPrev(goals: Goal[], goal: Goal | number) {
  const goalIndex = typeof goal === 'number'
    ? goal
    : goal.prev

  if (goalIndex === null) {
    return null
  }

  return findGoalByGlobalIndex(goals, goalIndex)
}

export function getGoalNext(goals: Goal[], goal: Goal | number) {
  const goalIndex = typeof goal === 'number'
    ? goal
    : goal.next

  if (goalIndex === null) {
    return null
  }

  return findGoalByGlobalIndex(goals, goalIndex)
}

export function getGoalSiblingChain(goals: Goal[], startGoal: Goal) {
  const chain: Goal[] = []

  let current: Goal | null = startGoal

  while (current?.prev !== null) {
    current = getGoalPrev(goals, current as Goal)
  }

  while (current) {
    chain.push(current)
    current = getGoalNext(goals, current)
  }

  return chain
}

export function getGoalSiblings(goals: Goal[], goal: Goal) {
  if (goal.parent === null) {
    return [goal]
  }

  return getGoalChildren(goals, goal.parent)
}
