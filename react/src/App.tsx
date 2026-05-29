import { useEffect, useMemo, useRef, useState } from 'react'
import CurrentGoalsView from './section/current-goals-view'
import DailyBriefView from './section/daily-brief-view'
import SettingsView from './section/settings-view'
import TogetherView from './section/together-view'
import JournalView from './section/journal-view'
import RemindersView from './section/reminders-view'
import ChatView from './section/chat-view'
import LoginView, { type LocalUser } from './section/login-view'
import LoadingOrb from './components/loading-orb'
import NavBar, { type NavPanel } from './components/nav-bar'
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
  const [goalPanel, setGoalPanel] = useState<NavPanel>('journey')
  const [celebration, setCelebration] = useState<{ title: string } | null>(null)
  const [dropConfirm, setDropConfirm] = useState<{ goalId: string; title: string } | null>(null)
  const [devTime, setDevTime] = useState<DevTimeState | null>(null)
  const [devTimeBusy, setDevTimeBusy] = useState(false)
  const [localUser, setLocalUser] = useState<LocalUser | null>(() => readStoredLocalUser())
  const [clientBaseUrl, setClientBaseUrlState] = useState<string | null>(() => getClientBaseUrl())
  const [devPanelOpen, setDevPanelOpen] = useState(false)
  const [journalOpenEntryId, setJournalOpenEntryId] = useState<string | null>(null)
  const [journeyChatOpen, setJourneyChatOpen] = useState(false)
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

  useEffect(() => {
    function onOpenJournalEntry(event: Event) {
      const custom = event as CustomEvent<{ entryId?: string }>
      const entryId = custom.detail?.entryId?.trim()
      if (!entryId) return
      setGoalPanel('journal')
      setJournalOpenEntryId(entryId)
    }

    window.addEventListener('open-journal-entry', onOpenJournalEntry as EventListener)
    return () => window.removeEventListener('open-journal-entry', onOpenJournalEntry as EventListener)
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
      fetch(SERVER_ENDPOINTS.sessionGoals, { cache: 'no-store' }).catch(() => {})

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

      if (envelope.type === 'goal_created') {
        void refreshGoals({ silent: true })
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
        fetch(SERVER_ENDPOINTS.sessionGoals, { cache: 'no-store' }).catch(() => {})
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
      <main className="relative min-h-full overflow-hidden bg-[#0a0a0a] px-4 py-8 text-white sm:px-6">
        <div className="pointer-events-none absolute inset-0 opacity-70">
          <div className="absolute left-1/2 top-16 h-72 w-72 -translate-x-1/2 rounded-full bg-white/5 blur-3xl" />
          <div className="absolute bottom-12 right-16 h-56 w-56 rounded-full bg-white/5 blur-3xl" />
        </div>
        <section className="relative mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center justify-center p-2">
          <div className="w-full max-w-md rounded-3xl border border-[#2a2a2a] bg-[#111]/80 p-8 shadow-[0_20px_70px_rgba(0,0,0,0.08)] backdrop-blur">
            <LoadingOrb label={message} />
            <p className="mt-4 text-center text-sm text-white/55">
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
        <main className="min-h-full px-4 py-8 text-white sm:px-6">
          <section className="mx-auto w-full max-w-5xl p-2">
            <p className="text-sm text-white/55">Goal "{goalId}" was not found on the server.</p>
            <button
              type="button"
              className="mt-4 rounded px-3 py-2 text-sm font-medium text-black bg-white"
              onClick={viewRootGoal}
            >
              View root goals
            </button>
          </section>
        </main>
      )
    }

    return (
      <main className="fixed inset-0 flex flex-col text-white overflow-hidden">
        {devPanelOpen ? (
          <aside className="fixed right-3 top-3 z-50 rounded-xl border border-[#2a2a2a] bg-[#111]/95 px-3 py-3 shadow-sm backdrop-blur sm:right-5 sm:top-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">{localUser.name}</p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-white/55 hover:bg-[#1a1a1a]"
                >
                  Sign out
                </button>
                <button
                  type="button"
                  onClick={() => setDevPanelOpen(false)}
                  className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-white/55 hover:bg-[#1a1a1a]"
                  aria-label="Close dev panel"
                  title="Close"
                >
                  ✕
                </button>
              </div>
            </div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/40">Dev time</p>
            <p className="mb-0.5 text-sm font-medium text-white">{devTimeLabel}</p>
            {devTime && devTime.offsetSeconds !== 0 && (
              <p className="mb-2 text-xs text-amber-400">+{devTime.offsetSeconds}s offset</p>
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
                  className="rounded border border-[#2a2a2a] px-2 py-0.5 text-xs text-white/55 hover:bg-[#1a1a1a] disabled:text-white/30"
                  disabled={devTimeBusy}
                  onClick={onClick}
                >
                  {label}
                </button>
              ))}
            </div>
          </aside>
        ) : (
          <button
            type="button"
            onClick={() => setDevPanelOpen(true)}
            className="fixed right-3 top-3 z-50 flex h-8 w-8 items-center justify-center rounded-full border border-[#2a2a2a] bg-[#111]/95 text-xs font-semibold text-white/55 shadow-sm backdrop-blur hover:bg-[#1a1a1a] sm:right-5 sm:top-5"
            aria-label="Open dev panel"
            title="Dev panel"
          >
            ⚙
          </button>
        )}
        {dropConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="mx-4 w-full max-w-sm rounded-3xl border border-[#2a2a2a] bg-[#111] p-8 text-center shadow-2xl">
              <h2 className="mb-2 text-lg font-bold text-white">Drop this goal?</h2>
              <p className="mb-1 text-sm text-white/55">
                <span className="font-medium text-white">{dropConfirm.title}</span>
              </p>
              <p className="mb-6 text-xs text-white/40">This will remove the goal and all its tasks. This cannot be undone.</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="flex-1 rounded-xl border border-[#2a2a2a] py-3 text-sm font-medium text-white/55 hover:bg-[#1a1a1a]"
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
            <div className="mx-4 w-full max-w-sm rounded-3xl border border-[#2a2a2a] bg-[#111] p-8 text-center shadow-2xl">
              <div className="mb-4 text-5xl">🎉</div>
              <h2 className="mb-2 text-xl font-bold text-white">Goal complete!</h2>
              <p className="mb-6 text-sm text-white/55">You finished <span className="font-medium text-white">{celebration.title}</span>.</p>
              <button
                type="button"
                className="w-full rounded-xl bg-[#111] py-3 text-sm font-semibold text-white"
                onClick={() => setCelebration(null)}
              >
                Continue
              </button>
            </div>
          </div>
        )}
        <div className="absolute inset-0 overflow-hidden">
          {goalPanel === 'journey' ? (
            <CurrentGoalsView
              goals={goals}
              statusMessage={error ?? message}
              pendingGoalIndex={pendingGoalIndex}
              onNavigate={navigateToGoal}
              onStartGoal={(targetGoal) => void runGoalAction(targetGoal, 'start')}
              onEndGoal={(targetGoal) => void runGoalAction(targetGoal, 'end')}
              onRepairGoal={(targetGoal, reason) => void runRepairGoal(targetGoal, reason)}
            />
          ) : goalPanel === 'collab' ? (
            <TogetherView userId={localUser?.id ?? ''} />
          ) : goalPanel === 'schedule' ? (
            <DailyBriefView />
          ) : goalPanel === 'reminders' ? (
            <RemindersView />
          ) : goalPanel === 'profile' ? (
            <SettingsView />
          ) : (
            <JournalView openEntryId={journalOpenEntryId} />
          )}
        </div>
        {goalPanel === 'journey' && (
          <button
            type="button"
            onClick={() => setJourneyChatOpen(true)}
            className="fixed z-[99] flex items-center justify-center"
            style={{
              bottom: 112,
              right: 20,
              width: 52,
              height: 52,
              borderRadius: '50%',
              border: '1px solid rgba(255,255,255,.18)',
              background: 'rgba(20,20,20,.92)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              boxShadow: '0 4px 16px rgba(0,0,0,.5)',
              color: 'rgba(255,255,255,.85)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}
        <NavBar panel={goalPanel} onSetPanel={setGoalPanel} />
        <div
          className="fixed inset-0 z-[201] flex flex-col transition-transform"
          style={{ background: 'var(--bg)', transform: journeyChatOpen ? 'translateX(0)' : 'translateX(100%)' }}
        >
          <div className="px-6 pt-[52px] pb-4 flex items-center gap-3.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <div
              onClick={() => setJourneyChatOpen(false)}
              className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center cursor-pointer flex-shrink-0"
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </div>
            <div>
              <div className="text-lg font-bold tracking-tight">Personal</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--white-dim)' }}>Private chat</div>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            {journeyChatOpen && <ChatView mode="panel" />}
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-full px-4 py-8 text-white sm:px-6">
      <section className="mx-auto w-full max-w-5xl p-2">
        <p className="text-sm text-white/55">{error ?? message}</p>
        <button
          type="button"
          className="mt-4 rounded px-3 py-2 text-sm font-medium text-black bg-white"
          onClick={viewRootGoal}
        >
          View root goals
        </button>
      </section>
    </main>
  )
}

export default App
