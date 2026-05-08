import { useEffect, useMemo, useRef, useState } from 'react'
import GoalViewer from './section/goal-view'
import {
  applyGoalEvent,
  endGoalOnServer,
  findGoalById,
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

function App() {
  const initialLocation = getLocationState()
  const [route, setRoute] = useState<RouteName>(initialLocation.route)
  const [goalId, setGoalId] = useState<string | null>(initialLocation.goalId)
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('Loading goals from server...')
  const [pendingGoalId, setPendingGoalId] = useState<string | null>(null)
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

  useEffect(() => {
    let cancelled = false

    async function run() {
      try {
        setLoading(true)
        setError(null)

        const loadedGoals = await loadGoalsFromServer()
        if (cancelled) {
          return
        }

        setGoals(loadedGoals)
        setMessage(`Loaded ${loadedGoals.length} goals from server.`)
      } catch (loadError) {
        if (cancelled) {
          return
        }

        setError(loadError instanceof Error ? loadError.message : String(loadError))
        setMessage('Failed to load goals from server.')
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
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

      if (envelope.type !== 'goal_started' && envelope.type !== 'goal_ended') {
        return
      }

      let payload: GoalEventPayload

      try {
        payload = JSON.parse(envelope.data) as GoalEventPayload
      } catch {
        return
      }

      const goalIdFromEvent = payload['goal-id'] || envelope.id

      setGoals((currentGoals) => applyGoalEvent(currentGoals, goalIdFromEvent, payload))

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
