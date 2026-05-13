import { useEffect, useMemo, useRef, useState } from 'react'
import GoalViewer from './section/goal-view'
import CurrentGoalsView from './section/current-goals-view'
import ScheduleView from './section/schedule-view'
import {
  applyGoalEvent,
  endGoalOnServer,
  findGoalById,
  getGoalIdFromEvent,
  getGoalChildren,
  getRootGoals,
  type GoalEventEnvelope,
  type GoalEventPayload,
  loadGoalsFromServer,
  startGoalOnServer,
  type Goal,
} from './goal'
import { SERVER_ENDPOINTS } from './config/server'
import { buildGoalPath, getLocationState, ROOT_GOAL_ID, type RouteName } from './config/utils'

interface DevTimeState {
  now: number
  offsetSeconds: number
}

function App() {
  const initialLocation = getLocationState()
  const [route, setRoute] = useState<RouteName>(initialLocation.route)
  const [goalId, setGoalId] = useState<string | null>(initialLocation.goalId)
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('Loading goals from server...')
  const [pendingGoalIndex, setPendingGoalIndex] = useState<number | null>(null)
  const [goalPanel, setGoalPanel] = useState<'structure' | 'current' | 'schedule'>('structure')
  const [devTime, setDevTime] = useState<DevTimeState | null>(null)
  const [devTimeBusy, setDevTimeBusy] = useState(false)
  const pendingActionRef = useRef<{ goalId: string; goalIndex: number } | null>(null)

  const selectedParentGoal = useMemo<Goal | null>(() => {
    if (!goalId || goalId === ROOT_GOAL_ID) {
      return null
    }

    return findGoalById(goals, goalId)
  }, [goalId, goals])

  const visibleGoals = useMemo(() => {
    if (!goalId || goalId === ROOT_GOAL_ID) {
      return getRootGoals(goals)
    }

    if (!selectedParentGoal) {
      return []
    }

    return getGoalChildren(goals, selectedParentGoal.globalIndex)
  }, [goalId, goals, selectedParentGoal])

  useEffect(() => {
    const onPopState = () => {
      const locationState = getLocationState()
      setRoute(locationState.route)
      setGoalId(locationState.goalId)
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  async function refreshGoals(options?: { silent?: boolean }) {
    try {
      if (!options?.silent) {
        setLoading(true)
      }

      const loadedGoals = await loadGoalsFromServer()
      setGoals(loadedGoals)

      if (!options?.silent) {
        setError(null)
        setMessage(`Loaded ${loadedGoals.length} goals from server.`)
      }
    } catch (loadError) {
      if (!options?.silent) {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
        setMessage('Failed to load goals from server.')
      }
    } finally {
      if (!options?.silent) {
        setLoading(false)
      }
    }
  }

  async function refreshDevTime() {
    try {
      const response = await fetch(SERVER_ENDPOINTS.devTime, {
        method: 'GET',
        cache: 'no-store',
      })

      if (!response.ok) {
        throw new Error(`Failed to load dev time: ${response.status}`)
      }

      const payload = (await response.json()) as { now: number; offset_seconds: number }

      setDevTime({
        now: payload.now,
        offsetSeconds: payload.offset_seconds,
      })
    } catch {
      setDevTime(null)
    }
  }

  useEffect(() => {
    let cancelled = false

    async function run() {
      await Promise.all([
        refreshGoals(),
        refreshDevTime(),
      ])

      if (cancelled) {
        return
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const source = new EventSource(SERVER_ENDPOINTS.goalEvents)

    source.onmessage = (event) => {
      let envelope: GoalEventEnvelope

      try {
        envelope = JSON.parse(event.data) as GoalEventEnvelope
      } catch {
        return
      }

      let payload: GoalEventPayload

      try {
        payload = JSON.parse(envelope.data) as GoalEventPayload
      } catch {
        return
      }

      const goalIdFromEvent = getGoalIdFromEvent(envelope, payload)

      if (!goalIdFromEvent && !payload.goal_index) {
        return
      }

      if (envelope.type !== 'goal_started' && envelope.type !== 'goal_ended' && envelope.type !== 'goal_created') {
        return
      }

      if (envelope.type === 'goal_started' || envelope.type === 'goal_ended') {
        setGoals((currentGoals) => applyGoalEvent(currentGoals, goalIdFromEvent, payload))
      }

      const pendingAction = pendingActionRef.current
      const matchesPending = pendingAction
        ? payload.goal_index
          ? pendingAction.goalIndex === payload.goal_index
          : pendingAction.goalId === goalIdFromEvent
        : false

      if (matchesPending) {
        const actionLabel = envelope.type === 'goal_started' ? 'Goal started.' : 'Goal ended.'
        setPendingGoalIndex(null)
        setError(null)
        setMessage(actionLabel)
        pendingActionRef.current = null
      }
    }

    source.onerror = () => {
      setMessage((currentMessage) =>
        currentMessage.startsWith('Failed to load') ? currentMessage : 'Goal event stream disconnected.',
      )
    }

    return () => {
      source.close()
    }
  }, [])

  function navigateToGoal(nextGoalId: string) {
    setGoalId(nextGoalId)
    setRoute('goal')
    window.history.pushState({}, '', buildGoalPath(nextGoalId))
  }

  async function runGoalAction(targetGoal: Goal, action: 'start' | 'end') {
    try {
      pendingActionRef.current = { goalId: targetGoal.id, goalIndex: targetGoal.globalIndex }
      setPendingGoalIndex(targetGoal.globalIndex)
      setError(null)
      setMessage(action === 'start' ? 'Starting goal...' : 'Ending goal...')

      if (action === 'start') {
        await startGoalOnServer(targetGoal)
        await refreshGoals({ silent: true })
        setMessage('Goal started.')
      } else {
        await endGoalOnServer(targetGoal)
        await refreshGoals({ silent: true })
        setMessage('Goal ended.')
      }

      setPendingGoalIndex(null)
      setError(null)
      pendingActionRef.current = null
    } catch (actionError) {
      const nextError = actionError instanceof Error ? actionError.message : String(actionError)
      pendingActionRef.current = null
      setPendingGoalIndex(null)
      setError(nextError)
      setMessage(nextError)
    }
  }

  async function runDevTimeAction(action: 'reset' | number) {
    try {
      setDevTimeBusy(true)

      const isReset = action === 'reset'
      const response = await fetch(
        isReset ? SERVER_ENDPOINTS.devTimeReset : SERVER_ENDPOINTS.devTimeAdvance,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: isReset ? JSON.stringify({}) : JSON.stringify({ seconds: action }),
        },
      )

      if (!response.ok) {
        throw new Error(`Dev time action failed: ${response.status}`)
      }

      const payload = (await response.json()) as { now: number; offset_seconds: number }

      setDevTime({
        now: payload.now,
        offsetSeconds: payload.offset_seconds,
      })

      await refreshGoals({ silent: true })
      setMessage(isReset ? 'Simulated time reset.' : 'Simulated time advanced.')
    } catch (actionError) {
      const nextError = actionError instanceof Error ? actionError.message : String(actionError)
      setError(nextError)
      setMessage(nextError)
    } finally {
      setDevTimeBusy(false)
    }
  }

  const devTimeLabel = devTime
    ? new Date(devTime.now * 1000).toLocaleString()
    : 'Time unavailable'

  function viewRootGoal() {
    navigateToGoal(ROOT_GOAL_ID)
  }

  if (loading) {
    return (
      <main className="min-h-full bg-white px-4 py-8 text-black sm:px-6">
        <section className="mx-auto w-full max-w-5xl p-2">
          <p className="text-sm text-neutral-600">{message}</p>
        </section>
      </main>
    )
  }

  if (route === 'goal') {
    if (goalId !== ROOT_GOAL_ID && !selectedParentGoal) {
      return (
        <main className="min-h-full bg-white px-4 py-8 text-black sm:px-6">
          <section className="mx-auto w-full max-w-5xl p-2">
            <p className="text-sm text-neutral-600">Goal "{goalId}" was not found on the server.</p>
            <button
              type="button"
              className="mt-4 rounded px-3 py-2 text-sm font-medium text-white bg-black"
              onClick={viewRootGoal}
            >
              View root goals
            </button>
          </section>
        </main>
      )
    }

    return (
      <main className="min-h-full bg-white pb-20 px-4 py-8 text-black sm:px-6">
        <aside className="fixed right-3 top-3 z-50 rounded-xl border border-neutral-200 bg-white/95 px-3 py-3 shadow-sm backdrop-blur sm:right-5 sm:top-5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">Dev time</p>
          <p className="mb-0.5 text-sm font-medium text-black">{devTimeLabel}</p>
          {devTime && devTime.offsetSeconds !== 0 && (
            <p className="mb-2 text-xs text-amber-600">+{devTime.offsetSeconds}s offset</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {([
              ['Now', () => void refreshDevTime()],
              ['+10m', () => void runDevTimeAction(600)],
              ['+1h', () => void runDevTimeAction(3600)],
              ['+1d', () => void runDevTimeAction(86400)],
              ['Reset', () => void runDevTimeAction('reset')],
            ] as [string, () => void][]).map(([label, onClick]) => (
              <button
                key={label}
                type="button"
                className="rounded border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:text-neutral-300"
                disabled={devTimeBusy}
                onClick={onClick}
              >
                {label}
              </button>
            ))}
          </div>
        </aside>
        {goalPanel === 'schedule' ? (
          <ScheduleView />
        ) : goalPanel === 'current' ? (
          <CurrentGoalsView
            goals={goals}
            statusMessage={error ?? message}
            pendingGoalIndex={pendingGoalIndex}
            onNavigate={navigateToGoal}
            onStartGoal={(targetGoal) => void runGoalAction(targetGoal, 'start')}
            onEndGoal={(targetGoal) => void runGoalAction(targetGoal, 'end')}
          />
        ) : (
          <GoalViewer
            parentGoal={selectedParentGoal}
            childrenGoals={visibleGoals}
            globalGoals={goals}
            statusMessage={error ?? message}
            pendingGoalIndex={pendingGoalIndex}
            onNavigate={navigateToGoal}
            onStartGoal={(targetGoal) => void runGoalAction(targetGoal, 'start')}
            onEndGoal={(targetGoal) => void runGoalAction(targetGoal, 'end')}
          />
        )}
        <nav className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-neutral-200 bg-white/95 backdrop-blur">
          {([
            ['structure', 'Structure'],
            ['current', 'Session'],
            ['schedule', 'Schedule'],
          ] as [typeof goalPanel, string][]).map(([panel, label]) => (
            <button
              key={panel}
              type="button"
              className={`flex-1 py-4 text-sm transition-colors ${
                goalPanel === panel
                  ? 'border-t-2 border-black font-semibold text-black'
                  : 'border-t-2 border-transparent text-neutral-400'
              }`}
              onClick={() => setGoalPanel(panel)}
            >
              {label}
            </button>
          ))}
        </nav>
      </main>
    )
  }

  return (
    <main className="min-h-full bg-white px-4 py-8 text-black sm:px-6">
      <section className="mx-auto w-full max-w-5xl p-2">
        <p className="text-sm text-neutral-600">{error ?? message}</p>
        <button
          type="button"
          className="mt-4 rounded px-3 py-2 text-sm font-medium text-white bg-black"
          onClick={viewRootGoal}
        >
          View root goals
        </button>
      </section>
    </main>
  )
}

export default App
