import { useEffect, useMemo, useRef, useState } from 'react'
import CurrentGoalsView from './section/current-goals-view'
import SchedulePanel from './section/schedule-panel'
import SettingsView from './section/settings-view'
import TogetherView from './section/together-view'
import JournalView from './section/journal-view'
import ChatView from './section/chat-view'
import LoginView, { type LocalUser } from './section/login-view'
import OnboardingView from './section/onboarding-view'
import LoadingOrb from './components/loading-orb'
import NavBar, { type NavPanel } from './components/nav-bar'
import FocusSession, { type FocusTarget } from './section/focus-session'
import JournalFocusSession, { type JournalFocusActions } from './section/journal-focus-session'
import type { GoalSelection } from './section/current-goals-view'
import {
  applyGoalEvent,
  endGoalOnServer,
  cancelGoalOnServer,
  findGoalById,
  getGoalIdFromEvent,
  getRootGoalProgressPct,
  type GoalEventEnvelope,
  type GoalEventPayload,
  loadGoalsFromServer,
  extendGoalOnServer,
  reshapeGoalOnServer,
  startGoalOnServer,
  type Goal,
} from './goal'
import {
  CENTRAL_ENDPOINTS,
  SERVER_ENDPOINTS,
  buildClientBaseUrl,
  setClientBaseUrl,
} from './config/server'
import { buildGoalPath, buildUserPath, getLocationState, ROOT_GOAL_ID, type RouteName } from './config/utils'


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
  const [localUser, setLocalUser] = useState<LocalUser | null>(null)
  const [clientBaseUrl, setClientBaseUrlState] = useState<string | null>(null)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [devPanelOpen, setDevPanelOpen] = useState(false)
  const [journalOpenEntryId, setJournalOpenEntryId] = useState<string | null>(null)
  const [journeyChatOpen, setJourneyChatOpen] = useState(false)
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null)
  const [journalFocus, setJournalFocus] = useState<JournalFocusActions | null>(null)
  const [goalOptions, setGoalOptions] = useState<GoalSelection | null>(null)
  const pendingActionRef = useRef<{ goalId: string } | null>(null)
  // Debounce timer for tree-changed refetches: a multi-level decomposition fires
  // several goal_tree_changed events in a row; collapse them into one refresh.
  const treeChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // True only while we are restoring a session from the URL on first load.
  const [restoringSession, setRestoringSession] = useState(initialLocation.userId != null)

  function applySession(user: LocalUser, baseUrl: string) {
    setClientBaseUrl(baseUrl)
    setClientBaseUrlState(baseUrl)
    setLocalUser(user)
    setError(null)
    setMessage('Loading goals from server...')
  }

  function handleLogin(user: LocalUser, baseUrl: string, isNew?: boolean) {
    applySession(user, baseUrl)
    setNeedsOnboarding(!!isNew)
    setRoute('user')
    window.history.pushState({}, '', buildUserPath(user.id))
  }

  function handleLogout() {
    setClientBaseUrl(null)
    setClientBaseUrlState(null)
    setLocalUser(null)
    setGoals([])
    setNeedsOnboarding(false)
    setRoute('home')
    window.history.pushState({}, '', '/')
  }

  function finishOnboarding() {
    // Hand off to the main app at the journey root — never to a specific goal.
    // We deliberately clear goalId and use buildUserPath (no /g/<id> segment) so
    // no goal id is carried over from onboarding into the main flow.
    setNeedsOnboarding(false)
    setGoalId(ROOT_GOAL_ID)
    setGoalPanel('journey')
    setRoute('user')
    if (localUser) window.history.replaceState({}, '', buildUserPath(localUser.id))
    void refreshGoals({ silent: true })
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

  // Restore the session straight from the URL on first load: /u/<id>[/g/<goalId>]
  // re-selects the user on the central server (which yields the client port), so a
  // refresh keeps you where you were instead of bouncing to the login menu.
  useEffect(() => {
    const { userId } = initialLocation
    if (!userId) return

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(CENTRAL_ENDPOINTS.usersSelect, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: userId }),
        })
        if (!res.ok) throw new Error(`Select failed: ${res.status}`)
        const payload = (await res.json()) as { id: string; name: string; port: number }
        if (cancelled) return
        applySession({ id: payload.id, name: payload.name }, buildClientBaseUrl(payload.port))
      } catch {
        if (cancelled) return
        // Unknown/stale user in the URL — fall back to the login menu.
        setRoute('home')
        setGoalId(null)
        window.history.replaceState({}, '', '/')
      } finally {
        if (!cancelled) setRestoringSession(false)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Robust onboarding detection: a genuinely fresh account (server reports
  // onboarded=false) with no goals yet should land on the intro flow even after
  // a refresh. Legacy accounts (flag absent) report onboarded=true and are never
  // pulled in, and any account that already has goals is treated as onboarded.
  useEffect(() => {
    if (!clientBaseUrl || needsOnboarding || goals.length > 0) return

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(SERVER_ENDPOINTS.profile, { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as { onboarded?: boolean }
        if (!cancelled && data.onboarded === false) setNeedsOnboarding(true)
      } catch {
        /* ignore — fall through to the normal app */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [clientBaseUrl, goals.length, needsOnboarding])

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

      // Server-side decomposition (triggered by start/create/repair) added or
      // changed subgoals — refetch the tree. Debounced so a multi-level
      // decomposition's burst of events collapses into a single fetch.
      if (envelope.type === 'goal_tree_changed') {
        if (treeChangedTimerRef.current) clearTimeout(treeChangedTimerRef.current)
        treeChangedTimerRef.current = setTimeout(() => {
          treeChangedTimerRef.current = null
          void refreshGoals({ silent: true })
        }, 280)
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
        ? pendingAction.goalId === goalIdFromEvent
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
      if (treeChangedTimerRef.current) {
        clearTimeout(treeChangedTimerRef.current)
        treeChangedTimerRef.current = null
      }
    }
  }, [clientBaseUrl])

  // While the server is still producing the journey (e.g. right after onboarding
  // the goal tree is being decomposed), the goal list comes back empty. Rather
  // than make the user manually refresh, poll quietly until goals appear. The
  // effect re-runs when goals.length flips to > 0 and the early return tears the
  // interval down; a cap stops genuinely-empty accounts from polling forever.
  useEffect(() => {
    if (!clientBaseUrl || needsOnboarding || goals.length > 0) return
    let attempts = 0
    const MAX_ATTEMPTS = 24 // ~1 min at 2.5s
    const id = setInterval(() => {
      if (attempts++ >= MAX_ATTEMPTS) { clearInterval(id); return }
      void refreshGoals({ silent: true })
    }, 2500)
    return () => clearInterval(id)
  }, [clientBaseUrl, needsOnboarding, goals.length])

  function navigateToGoal(nextGoalId: string) {
    setGoalId(nextGoalId)
    setRoute('goal')
    if (localUser) window.history.pushState({}, '', buildGoalPath(localUser.id, nextGoalId))
  }

  async function runGoalAction(targetGoal: Goal, action: 'start' | 'end') {
    try {
      pendingActionRef.current = { goalId: targetGoal.id }
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

  async function runExtendGoal(targetGoal: Goal) {
    try {
      setError(null)
      await extendGoalOnServer(targetGoal)
      await refreshGoals({ silent: true })
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    }
  }

  async function runReshapeGoal(targetGoal: Goal) {
    try {
      setPendingGoalIndex(targetGoal.localIndex)
      setError(null)
      setMessage('Reshaping this step...')
      await reshapeGoalOnServer(targetGoal)
      await refreshGoals({ silent: true })
      setMessage('Step reshaped.')
    } catch (actionError) {
      const nextError = actionError instanceof Error ? actionError.message : String(actionError)
      setError(nextError)
      setMessage(nextError)
    } finally {
      setPendingGoalIndex(null)
    }
  }

  async function runCancelGoal(targetGoal: Goal) {
    try {
      await cancelGoalOnServer(targetGoal)
      await refreshGoals({ silent: true })
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    }
  }

  async function dismissJourney(targetGoal: Goal) {
    setGoalOptions(null)
    try {
      setMessage('Exiting journey...')
      const res = await fetch(`${clientBaseUrl ?? ''}/journey/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'goal-id': targetGoal.id }),
      })
      if (!res.ok) throw new Error(`Exit journey failed: ${res.status}`)
      await refreshGoals({ silent: true })
      setMessage('Journey removed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Tapping a goal on the journey path opens it as a full-screen focus session.
  // Journal-type leaves use the journal editor session instead of the timer.
  function openGoalFocus(sel: GoalSelection) {
    const g = sel.goal
    if (g.goalType === 'journal' && !sel.isMystery) {
      setJournalFocus({
        title: g.title,
        requiredTimeSeconds: g.requiredTime,
        startedAlready: !!g.startDate,
        initialAttachId: g.attachId || '',
        ensureStarted: async () => {
          const r = await startGoalOnServer(g)
          return r.attach_id || g.attachId || ''
        },
        endGoal: async (aid) => { await endGoalOnServer(g, aid) },
        cancelGoal: async () => { await cancelGoalOnServer(g) },
        onCompleted: () => {
          void refreshGoals({ silent: true })
          fetch(SERVER_ENDPOINTS.sessionGoals, { cache: 'no-store' }).catch(() => {})
        },
      })
      return
    }
    setFocusTarget({
      id: g.id,
      title: g.title,
      extraInfo: g.extraInfo || undefined,
      tips: g.tips || undefined,
      requiredTimeSeconds: g.requiredTime,
      state: sel.nodeState,
      isMystery: sel.isMystery,
      canStart: sel.canStart,
      pending: pendingGoalIndex === g.localIndex,
      rootProgressPct: getRootGoalProgressPct(goals, g),
      onStart: () => void runGoalAction(g, 'start'),
      onComplete: () => void runGoalAction(g, 'end'),
      onCancel: () => void runCancelGoal(g),
      onExtend: () => void runExtendGoal(g),
      onReshape: () => void runReshapeGoal(g),
      onOpen: () => navigateToGoal(g.id),
    })
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
    // Still resolving the user from the URL — don't flash the login menu.
    if (restoringSession) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-black text-white/60">
          <p className="text-sm">Restoring session…</p>
        </div>
      )
    }
    return <LoginView onLogin={handleLogin} />
  }

  if (needsOnboarding) {
    return <OnboardingView user={localUser} onComplete={finishOnboarding} />
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

  if (route === 'goal' || route === 'user') {
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
        {!focusTarget && (devPanelOpen ? (
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
        ))}
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
        {goalOptions && (
          <div className="fixed inset-0 z-[120] flex items-end justify-center" onClick={() => setGoalOptions(null)}>
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div
              className="relative w-full max-w-lg rounded-t-3xl border-t border-[#2a2a2a] bg-[#111] px-5 pb-10 pt-6"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-white/40">Journey options</p>
              <p className="mb-5 truncate text-sm font-semibold text-white">{goalOptions.goal.title}</p>
              <button
                type="button"
                onClick={() => setGoalOptions(null)}
                className="mb-2.5 flex w-full items-center gap-3 rounded-2xl border border-[#2a2a2a] px-4 py-3.5 text-sm font-medium text-white/80 hover:bg-[#1a1a1a]"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Close
              </button>
              <button
                type="button"
                onClick={() => void dismissJourney(goalOptions.goal)}
                className="flex w-full items-center gap-3 rounded-2xl border border-red-900/60 bg-red-950/30 px-4 py-3.5 text-sm font-semibold text-red-400 hover:bg-red-950/50"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Exit journey
              </button>
              <p className="mt-3 text-center text-[11px] text-white/35">Exiting removes the whole journey. For shared journeys this dismisses it for everyone.</p>
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
              onSelectGoal={openGoalFocus}
              onGoalOptions={setGoalOptions}
            />
          ) : goalPanel === 'collab' ? (
            <TogetherView userId={localUser?.id ?? ''} onOpenFocus={setFocusTarget} onOpenJournal={setJournalFocus} />
          ) : goalPanel === 'schedule' ? (
            <SchedulePanel />
          ) : goalPanel === 'profile' ? (
            <SettingsView />
          ) : (
            <JournalView openEntryId={journalOpenEntryId} />
          )}
        </div>
        {goalPanel === 'journey' && !focusTarget && (
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
        {!focusTarget && <NavBar panel={goalPanel} onSetPanel={setGoalPanel} />}
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
            {journeyChatOpen && <ChatView mode="panel" sessionId={localUser.id} />}
          </div>
        </div>
        {focusTarget && (
          <FocusSession target={focusTarget} onClose={() => setFocusTarget(null)} />
        )}
        {journalFocus && (
          <JournalFocusSession
            {...journalFocus}
            onClose={() => setJournalFocus(null)}
          />
        )}
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
