import { useEffect, useMemo, useRef, useState } from 'react'
import GoalViewer from './section/goal-view'
import CurrentGoalsView from './section/current-goals-view'
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
  const [pendingGoalId, setPendingGoalId] = useState<string | null>(null)
  const [goalPanel, setGoalPanel] = useState<'structure' | 'current'>('structure')
  const [devTime, setDevTime] = useState<DevTimeState | null>(null)
  const [devTimeBusy, setDevTimeBusy] = useState(false)
  const pendingActionRef = useRef<{ goalId: string } | null>(null)

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
      setError(null)
      setMessage(`Loaded ${loadedGoals.length} goals from server.`)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
      setMessage('Failed to load goals from server.')
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

      if (!goalIdFromEvent) {
        return
      }

      if (envelope.type !== 'goal_started' && envelope.type !== 'goal_ended' && envelope.type !== 'goal_created') {
        return
      }

      if (envelope.type === 'goal_started' || envelope.type === 'goal_ended') {
        setGoals((currentGoals) => applyGoalEvent(currentGoals, goalIdFromEvent, payload))
      }

      const pendingAction = pendingActionRef.current
      if (pendingAction?.goalId === goalIdFromEvent) {
        const actionLabel = envelope.type === 'goal_started' ? 'Goal started.' : 'Goal ended.'
        setPendingGoalId(null)
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

  async function runGoalAction(targetGoalId: string, action: 'start' | 'end') {
    try {
      pendingActionRef.current = { goalId: targetGoalId }
      setPendingGoalId(targetGoalId)
      setError(null)
      setMessage(action === 'start' ? 'Starting goal...' : 'Ending goal...')

      if (action === 'start') {
        await startGoalOnServer(targetGoalId)
      } else {
        await endGoalOnServer(targetGoalId)
      }
    } catch (actionError) {
      const nextError = actionError instanceof Error ? actionError.message : String(actionError)
      pendingActionRef.current = null
      setPendingGoalId(null)
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
      <main className="min-h-full bg-white px-4 py-8 text-black sm:px-6">
        <aside className="fixed right-4 top-4 z-50 space-y-2 rounded-lg border border-neutral-200 bg-white/95 px-3 py-3 text-right shadow-sm backdrop-blur sm:right-6 sm:top-6">
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-[0.16em] text-neutral-500">Server time</p>
            <p className="text-sm text-black">{devTimeLabel}</p>
            <p className="text-xs text-neutral-500">
              Offset: {devTime ? `${devTime.offsetSeconds}s` : 'n/a'}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2 text-xs">
            <button
              type="button"
              className="border-b border-neutral-400 text-neutral-700 disabled:text-neutral-300"
              disabled={devTimeBusy}
              onClick={() => void refreshDevTime()}
            >
              Now
            </button>
            <button
              type="button"
              className="border-b border-neutral-400 text-neutral-700 disabled:text-neutral-300"
              disabled={devTimeBusy}
              onClick={() => void runDevTimeAction(600)}
            >
              +10m
            </button>
            <button
              type="button"
              className="border-b border-neutral-400 text-neutral-700 disabled:text-neutral-300"
              disabled={devTimeBusy}
              onClick={() => void runDevTimeAction(3600)}
            >
              +1h
            </button>
            <button
              type="button"
              className="border-b border-neutral-400 text-neutral-700 disabled:text-neutral-300"
              disabled={devTimeBusy}
              onClick={() => void runDevTimeAction(86400)}
            >
              +1d
            </button>
            <button
              type="button"
              className="border-b border-neutral-400 text-neutral-700 disabled:text-neutral-300"
              disabled={devTimeBusy}
              onClick={() => void runDevTimeAction('reset')}
            >
              Reset
            </button>
          </div>
        </aside>
        <section className="mx-auto flex w-full max-w-5xl justify-end gap-3 pb-6">
          <button
            type="button"
            className={goalPanel === 'structure' ? 'rounded border border-black px-3 py-2 text-sm' : 'px-3 py-2 text-sm text-neutral-500'}
            onClick={() => setGoalPanel('structure')}
          >
            Structure
          </button>
          <button
            type="button"
            className={goalPanel === 'current' ? 'rounded border border-black px-3 py-2 text-sm' : 'px-3 py-2 text-sm text-neutral-500'}
            onClick={() => setGoalPanel('current')}
          >
            Current Session
          </button>
        </section>
        {goalPanel === 'current' ? (
          <CurrentGoalsView
            goals={goals}
            statusMessage={error ?? message}
            pendingGoalId={pendingGoalId}
            onNavigate={navigateToGoal}
            onStartGoal={(targetGoalId) => void runGoalAction(targetGoalId, 'start')}
            onEndGoal={(targetGoalId) => void runGoalAction(targetGoalId, 'end')}
          />
        ) : (
          <GoalViewer
            parentGoal={selectedParentGoal}
            childrenGoals={visibleGoals}
            globalGoals={goals}
            statusMessage={error ?? message}
            pendingGoalId={pendingGoalId}
            onNavigate={navigateToGoal}
            onStartGoal={(targetGoalId) => void runGoalAction(targetGoalId, 'start')}
            onEndGoal={(targetGoalId) => void runGoalAction(targetGoalId, 'end')}
          />
        )}
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
