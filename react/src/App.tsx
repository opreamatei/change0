import { useEffect, useMemo, useRef, useState } from 'react'
import CurrentGoalsView from './section/current-goals-view'
import DailyBriefView from './section/daily-brief-view'
import ProfileView from './section/profile-view'
import ChatView from './section/chat-view'
import ConnectionsView from './section/connections-view'
import LoginView, { type LocalUser } from './section/login-view'
import LoadingOrb from './components/loading-orb'
import {
  applyGoalEvent,
  endGoalOnServer,
  findGoalById,
  getGoalIdFromEvent,
  type GoalEventEnvelope,
  type GoalEventPayload,
  loadGoalsFromServer,
  repairGoalOnServer,
  startGoalOnServer,
  type Goal,
} from './goal'
import {
  SERVER_ENDPOINTS,
  getClientBaseUrl,
  setClientBaseUrl,
} from './config/server'
import { buildGoalPath, getLocationState, ROOT_GOAL_ID, type RouteName } from './config/utils'

const LOCAL_USER_STORAGE_KEY = 'change.localUser'

function readStoredLocalUser(): LocalUser | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LOCAL_USER_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LocalUser
    if (parsed && parsed.id && parsed.name) return parsed
    return null
  } catch {
    return null
  }
}

function writeStoredLocalUser(user: LocalUser | null) {
  if (typeof window === 'undefined') return
  if (user) window.localStorage.setItem(LOCAL_USER_STORAGE_KEY, JSON.stringify(user))
  else window.localStorage.removeItem(LOCAL_USER_STORAGE_KEY)
}

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
  const [goalPanel, setGoalPanel] = useState<'current' | 'schedule' | 'chat' | 'profile' | 'connections'>('current')
  const [celebration, setCelebration] = useState<{ title: string } | null>(null)
  const [dropConfirm, setDropConfirm] = useState<{ goalId: string; title: string } | null>(null)
  const [devTime, setDevTime] = useState<DevTimeState | null>(null)
  const [devTimeBusy, setDevTimeBusy] = useState(false)
  const [localUser, setLocalUser] = useState<LocalUser | null>(() => readStoredLocalUser())
  const [clientBaseUrl, setClientBaseUrlState] = useState<string | null>(() => getClientBaseUrl())
  const pendingActionRef = useRef<{ goalId: string; goalIndex: number } | null>(null)

  function handleLogin(user: LocalUser, baseUrl: string) {
    setClientBaseUrl(baseUrl)
    setClientBaseUrlState(baseUrl)
    writeStoredLocalUser(user)
    setLocalUser(user)
    setError(null)
    setMessage('Loading goals from server...')
  }

  function handleLogout() {
    setClientBaseUrl(null)
    setClientBaseUrlState(null)
    writeStoredLocalUser(null)
    setLocalUser(null)
    setGoals([])
  }

  const selectedParentGoal = useMemo<Goal | null>(() => {
    if (!goalId || goalId === ROOT_GOAL_ID) {
      return null
    }

    return findGoalById(goals, goalId)
  }, [goalId, goals])


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
    if (!clientBaseUrl) {
      setLoading(false)
      return
    }

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
  }, [clientBaseUrl])

  useEffect(() => {
    if (!clientBaseUrl) return
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

      if (envelope.type === 'goal_drop_requested') {
        try {
          const data = JSON.parse(envelope.data) as { goal_id: string; title: string }
          setDropConfirm({ goalId: data.goal_id, title: data.title })
        } catch { /* ignore */ }
        return
      }

      if (envelope.type === 'goal_tree_completed') {
        try {
          const data = JSON.parse(envelope.data) as { title: string }
          setCelebration({ title: data.title })
        } catch { /* ignore */ }
        void refreshGoals({ silent: true })
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
  }, [clientBaseUrl])

  function navigateToGoal(nextGoalId: string) {
    setGoalId(nextGoalId)
    setRoute('goal')
    window.history.pushState({}, '', buildGoalPath(nextGoalId))
  }

  async function runGoalAction(targetGoal: Goal, action: 'start' | 'end') {
    try {
      pendingActionRef.current = { goalId: targetGoal.id, goalIndex: targetGoal.localIndex }
      setPendingGoalIndex(targetGoal.localIndex)
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

  async function confirmDrop() {
    if (!dropConfirm) return
    const { goalId } = dropConfirm
    setDropConfirm(null)
    try {
      await fetch(SERVER_ENDPOINTS.goalDrop, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'goal-id': goalId }),
      })
      await refreshGoals({ silent: true })
      setMessage('Goal dropped.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function runRepairGoal(targetGoal: Goal, reason: string) {
    try {
      setPendingGoalIndex(targetGoal.localIndex)
      setError(null)
      setMessage('Repairing goal...')

      await repairGoalOnServer(targetGoal, reason)
      await refreshGoals({ silent: true })
      setMessage('Goal repaired.')
    } catch (actionError) {
      const nextError = actionError instanceof Error ? actionError.message : String(actionError)
      setError(nextError)
      setMessage(nextError)
    } finally {
      setPendingGoalIndex(null)
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

  if (!localUser || !clientBaseUrl) {
    return <LoginView onLogin={handleLogin} />
  }

  if (loading) {
    return (
      <main className="relative min-h-full overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(0,0,0,0.05),_transparent_42%),linear-gradient(180deg,_#ffffff_0%,_#f7f7f5_100%)] px-4 py-8 text-black sm:px-6">
        <div className="pointer-events-none absolute inset-0 opacity-70">
          <div className="absolute left-1/2 top-16 h-72 w-72 -translate-x-1/2 rounded-full bg-neutral-200/40 blur-3xl" />
          <div className="absolute bottom-12 right-16 h-56 w-56 rounded-full bg-neutral-300/35 blur-3xl" />
        </div>
        <section className="relative mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center justify-center p-2">
          <div className="w-full max-w-md rounded-3xl border border-neutral-200 bg-white/80 p-8 shadow-[0_20px_70px_rgba(0,0,0,0.08)] backdrop-blur">
            <LoadingOrb label={message} />
            <p className="mt-4 text-center text-sm text-neutral-500">
              Syncing goals, session history, and live events.
            </p>
          </div>
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
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400">{localUser.name}</p>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-50"
            >
              Sign out
            </button>
          </div>
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
        {dropConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="mx-4 w-full max-w-sm rounded-3xl border border-neutral-200 bg-white p-8 text-center shadow-2xl">
              <h2 className="mb-2 text-lg font-bold text-black">Drop this goal?</h2>
              <p className="mb-1 text-sm text-neutral-600">
                <span className="font-medium text-black">{dropConfirm.title}</span>
              </p>
              <p className="mb-6 text-xs text-neutral-400">This will remove the goal and all its tasks. This cannot be undone.</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="flex-1 rounded-xl border border-neutral-200 py-3 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
                  onClick={() => setDropConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white hover:bg-red-700"
                  onClick={() => void confirmDrop()}
                >
                  Drop it
                </button>
              </div>
            </div>
          </div>
        )}
        {celebration && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="mx-4 w-full max-w-sm rounded-3xl border border-neutral-200 bg-white p-8 text-center shadow-2xl">
              <div className="mb-4 text-5xl">🎉</div>
              <h2 className="mb-2 text-xl font-bold text-black">Goal complete!</h2>
              <p className="mb-6 text-sm text-neutral-500">You finished <span className="font-medium text-black">{celebration.title}</span>.</p>
              <button
                type="button"
                className="w-full rounded-xl bg-black py-3 text-sm font-semibold text-white"
                onClick={() => setCelebration(null)}
              >
                Continue
              </button>
            </div>
          </div>
        )}
        {goalPanel === 'schedule' ? (
          <DailyBriefView />
        ) : goalPanel === 'current' ? (
          <CurrentGoalsView
            goals={goals}
            statusMessage={error ?? message}
            pendingGoalIndex={pendingGoalIndex}
            onNavigate={navigateToGoal}
            onStartGoal={(targetGoal) => void runGoalAction(targetGoal, 'start')}
            onEndGoal={(targetGoal) => void runGoalAction(targetGoal, 'end')}
            onRepairGoal={(targetGoal, reason) => void runRepairGoal(targetGoal, reason)}
          />
        ) : goalPanel === 'profile' ? (
          <ProfileView />
        ) : goalPanel === 'connections' ? (
          <ConnectionsView userId={localUser?.id ?? ''} />
        ) : (
          <ChatView key={localUser?.id ?? 'default'} />
        )}
        <nav className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-neutral-200 bg-white/95 backdrop-blur">
          {([
            ['current', 'Session'],
            ['schedule', 'Schedule'],
            ['profile', 'You'],
            ['chat', 'Chat'],
            ['connections', 'People'],
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
