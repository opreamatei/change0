import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS } from '../config/server'
import { openUserProfile } from '../profile-nav'
import { PathCanvas } from '../components/path-canvas'
import type { PathNodeData, NodeState } from '../components/path-canvas'
import { SwipeDeck } from '../components/swipe-deck'
import ConnectionsView from './connections-view'
import ReviewsPanel from './reviews-panel'
import type { FocusTarget } from './focus-session'
import type { JournalFocusActions } from './journal-focus-session'

const UNASSIGNED = 255

// Per-participant colour palette for the collab canvas
const PARTICIPANT_COLORS = [
  '#8b5cf6', // violet (user 0)
  '#f43f5e', // rose   (user 1)
  '#f59e0b', // amber  (user 2)
  '#14b8a6', // teal   (user 3)
]

/* Profile avatar for a participant, served from the central server's shared
 * disk layout. Falls back to the colored initial when the user has no picture. */
function ParticipantAvatar({
  id,
  name,
  color,
  className,
  style,
}: {
  id: string
  name: string
  color: string
  className?: string
  style?: React.CSSProperties
}) {
  const [failed, setFailed] = useState(false)
  const initial = (name || '?').slice(0, 1).toUpperCase()
  return (
    <div
      onClick={(e) => { e.stopPropagation(); openUserProfile({ id, display_name: name, color }) }}
      className={`cursor-pointer overflow-hidden flex items-center justify-center ${className ?? ''}`}
      style={{ background: color, color: '#0a0a0a', ...style }}
    >
      {!failed ? (
        <img
          src={CENTRAL_ENDPOINTS.userAvatar(id)}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
          alt=""
        />
      ) : (
        initial
      )}
    </div>
  )
}

interface ParticipantSummary {
  index: number
  id: string
  display_name: string
  color?: string
}

interface JourneyListItem {
  id: string
  title: string
  user_count: number
  goal_count: number
  root_count?: number
  participants: ParticipantSummary[]
}

interface JourneyListResponse {
  ok: boolean
  journeys: JourneyListItem[]
}

interface JourneyUser {
  id: string
  display_name: string
  context_summary: string
  color?: string
}

interface JourneyGoal {
  id: string
  title: string
  extra_info: string
  start_date: number
  end_date: number
  required_time: number
  min_pause_to_next: number
  pause_to_next: number
  subgoals_len: number
  parent: number
  prev: number
  next: number
  localIndex: number
  depth: number
  retry_depth: number
  priority: number
  assigned_to: number
  goal_type: number
  attach_id: string
  tips?: string
  subgoals: number[]
}

interface JourneyDetail {
  id: string
  title: string
  extra_info: string
  is_shared: boolean
  users: JourneyUser[]
  goals: JourneyGoal[]
}

interface LeafEntry {
  goal: JourneyGoal
  state: 'idle' | 'started' | 'finished'
  canStart: boolean
}

interface RootProposal {
  id: string
  proposed_by: string
  title: string
  extra_info: string
  a_approved: boolean
  b_approved: boolean
  finalized: boolean
  finalized_goal_id: string
  proposed_at: number
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours === 0 && minutes === 0) return `${total}s`
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

function classifyLeaf(g: JourneyGoal): LeafEntry['state'] {
  if (g.start_date && g.end_date) return 'finished'
  if (g.start_date && !g.end_date) return 'started'
  return 'idle'
}

function lastLeaf(g: JourneyGoal, goalMap: Map<number, JourneyGoal>): JourneyGoal {
  if (g.subgoals_len === 0) return g
  const lastIdx = g.subgoals[g.subgoals_len - 1]
  const last = goalMap.get(lastIdx)
  return last ? lastLeaf(last, goalMap) : g
}

function previousTimelineLeaf(g: JourneyGoal, goalMap: Map<number, JourneyGoal>): JourneyGoal | null {
  let cur: JourneyGoal | null = g
  while (cur) {
    if (cur.prev) {
      const prev = goalMap.get(cur.prev)
      return prev ? lastLeaf(prev, goalMap) : null
    }
    if (!cur.parent) return null
    cur = goalMap.get(cur.parent) ?? null
  }
  return null
}

function canStartLeaf(g: JourneyGoal, goalMap: Map<number, JourneyGoal>): boolean {
  if (g.subgoals_len !== 0 || g.start_date !== 0) return false
  let prev = previousTimelineLeaf(g, goalMap)
  while (prev) {
    if (!prev.end_date) return false
    prev = previousTimelineLeaf(prev, goalMap)
  }
  return true
}

function collectLeavesInOrder(g: JourneyGoal, goalMap: Map<number, JourneyGoal>): JourneyGoal[] {
  if (g.subgoals_len === 0) return [g]
  const out: JourneyGoal[] = []
  for (const idx of g.subgoals) {
    const child = goalMap.get(idx)
    if (child) out.push(...collectLeavesInOrder(child, goalMap))
  }
  return out
}

/* ─── collab node detail sheet ──────────────────────────────────────────── */

function CollabNodeDetail({
  leaf, detail, goalMap, userId, actionBusy, onAction, onReassign, onClose,
}: {
  leaf: JourneyGoal
  detail: JourneyDetail
  goalMap: Map<number, JourneyGoal>
  userId: string
  actionBusy: boolean
  onAction: (goalId: string, action: 'start' | 'end') => Promise<void>
  onReassign: (goalId: string, targetUserId: string) => Promise<void>
  onClose: () => void
}) {
  const [passingTo, setPassing] = useState<string | null>(null)
  const state = classifyLeaf(leaf)
  const owner = leaf.assigned_to === UNASSIGNED ? undefined : detail.users[leaf.assigned_to]
  const mine = owner?.id === userId
  const canStart = canStartLeaf(leaf, goalMap)
  const others = detail.users.filter((u) => u.id !== owner?.id)

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-t-3xl border-t border-[#2a2a2a] bg-[#111] px-6 py-6 pb-10">
        <div className="mb-2 flex items-center gap-2">
          {state === 'started' && <span className="size-1.5 animate-pulse rounded-full bg-green-500" />}
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
            {state === 'finished' ? 'Done' : state === 'started' ? 'Running' : 'Next'}
          </p>
          {owner && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-[#2a2a2a] text-white/70">
              {owner.display_name}{mine && ' (you)'}
            </span>
          )}
          {!owner && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-[#2a2a2a] text-white/40">
              Unassigned
            </span>
          )}
        </div>
        <p className="mb-1 text-base font-semibold text-white">{leaf.title}</p>
        {leaf.extra_info && <p className="mb-3 text-sm leading-relaxed text-white/55">{leaf.extra_info}</p>}
        <p className="mb-4 text-xs text-white/40">{formatDuration(leaf.required_time)} estimated</p>
        <div className="flex flex-wrap gap-2">
          {state !== 'finished' && mine && canStart && (
            <button disabled={actionBusy} onClick={() => void onAction(leaf.id, 'start')}
              className="rounded-xl border border-green-800 bg-green-950/30 px-4 py-2 text-sm text-green-400 disabled:opacity-40">
              Start
            </button>
          )}
          {state === 'started' && mine && (
            <button disabled={actionBusy} onClick={() => void onAction(leaf.id, 'end')}
              className="rounded-xl border border-[#333] px-4 py-2 text-sm text-white/70 disabled:opacity-40">
              End
            </button>
          )}
          {!mine && state !== 'finished' && canStart && (
            <p className="text-xs text-white/40 italic self-center">
              Waiting for {owner?.display_name ?? 'partner'}
            </p>
          )}
          {mine && others.length > 0 && state !== 'finished' && (
            passingTo === null ? (
              <button disabled={actionBusy} onClick={() => setPassing(others[0]!.id)}
                className="rounded-xl border border-[#333] px-4 py-2 text-sm text-white/55 disabled:opacity-40">
                Pass
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <select value={passingTo} onChange={(e) => setPassing(e.target.value)}
                  className="rounded border border-[#333] px-2 py-1.5 text-sm text-white outline-none bg-[#1a1a1a]">
                  {others.map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name}</option>
                  ))}
                </select>
                <button disabled={actionBusy}
                  onClick={() => { void onReassign(leaf.id, passingTo); setPassing(null) }}
                  className="rounded border border-[#333] bg-white px-3 py-1.5 text-sm text-black disabled:opacity-40">
                  Confirm
                </button>
                <button onClick={() => setPassing(null)}
                  className="rounded border border-[#333] px-3 py-1.5 text-sm text-white/55">
                  Cancel
                </button>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── collab journey detail view ─────────────────────────────────────────── */

function CollabJourneyView({
  summary, userId, onBack, onOpenFocus, onOpenJournal, journeyCount = 1, journeyIndex = 0, onSelectJourney,
}: {
  summary: JourneyListItem
  userId: string
  onBack: () => void
  onOpenFocus: (target: FocusTarget) => void
  onOpenJournal: (props: JournalFocusActions) => void
  journeyCount?: number
  journeyIndex?: number
  onSelectJourney?: (idx: number) => void
}) {
  const [detail, setDetail] = useState<JourneyDetail | null>(null)
  const [proposals, setProposals] = useState<RootProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [leafBusy, setLeafBusy] = useState(false)
  const [proposalBusy, setProposalBusy] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [dim, setDim] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    function measure() {
      if (!el) return
      const r = el.getBoundingClientRect()
      setDim({ w: Math.max(280, Math.floor(r.width)), h: Math.max(360, Math.floor(r.height)) })
    }
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const load = useCallback(async () => {
    try {
      const [dr, pr] = await Promise.all([
        fetch(CENTRAL_ENDPOINTS.journey(summary.id), { cache: 'no-store' }),
        fetch(CENTRAL_ENDPOINTS.journeyProposals(summary.id), { cache: 'no-store' }),
      ])
      if (!dr.ok) throw new Error(`journey fetch failed (${dr.status})`)
      const data = (await dr.json()) as JourneyDetail
      setDetail(data)
      if (pr.ok) {
        const pd = (await pr.json()) as { ok: boolean; proposals: RootProposal[] }
        if (pd.ok) setProposals(pd.proposals)
      }
    } finally {
      setLoading(false)
    }
  }, [summary.id])

  useEffect(() => {
    void load()
    const id = setInterval(load, 6000)
    return () => clearInterval(id)
  }, [load])

  const goalMap = useMemo(
    () => detail ? new Map<number, JourneyGoal>(detail.goals.map((g) => [g.localIndex, g])) : new Map<number, JourneyGoal>(),
    [detail],
  )

  const orderedLeaves = useMemo(() => {
    if (!detail) return []
    const leaves: JourneyGoal[] = []
    for (const g of detail.goals) {
      if (g.parent !== 0) continue
      leaves.push(...collectLeavesInOrder(g, goalMap))
    }
    return leaves
  }, [detail, goalMap])

  const collabNodes = useMemo((): PathNodeData[] => {
    let num = 1
    let prevParentIdx: number | null | undefined = undefined
    return orderedLeaves.map((leaf) => {
      const nodeState: NodeState =
        leaf.start_date && leaf.end_date ? 'done' :
        leaf.start_date ? 'active' : 'idle'
      const chapterTitle = leaf.parent !== prevParentIdx && leaf.parent !== 0
        ? goalMap.get(leaf.parent)?.title
        : undefined
      prevParentIdx = leaf.parent
      const tintColor = (leaf.assigned_to !== UNASSIGNED && leaf.assigned_to >= 0)
        ? (detail?.users[leaf.assigned_to]?.color || PARTICIPANT_COLORS[leaf.assigned_to % PARTICIPANT_COLORS.length])
        : undefined
      // for a 2-user journey: user 0 → left side, user 1 → right side
      const sideOverride: PathNodeData['sideOverride'] =
        leaf.assigned_to === 0 ? -1 :
        leaf.assigned_to === 1 ?  1 :
        undefined
      return { key: leaf.localIndex, title: leaf.title, nodeState, num: num++, isMystery: false, isJournal: leaf.goal_type === 1, chapterTitle, tintColor, sideOverride }
    })
  }, [orderedLeaves, goalMap, detail])

  const focusIdx = useMemo(() => {
    let idx = collabNodes.findIndex((n) => n.nodeState === 'active')
    if (idx < 0) {
      for (let i = collabNodes.length - 1; i >= 0; i--) {
        if (collabNodes[i].nodeState === 'done') { idx = i; break }
      }
    }
    if (idx < 0) idx = collabNodes.findIndex((n) => n.nodeState === 'idle')
    return idx
  }, [collabNodes])

  const userOverlay = useMemo(() => {
    if (!detail) return undefined
    let frontIdx = collabNodes.findIndex((n) => n.nodeState === 'active')
    if (frontIdx < 0) frontIdx = collabNodes.findIndex((n) => n.nodeState === 'idle')
    if (frontIdx < 0) return undefined
    const leaf = orderedLeaves[frontIdx]
    if (!leaf) return undefined
    const assignedUser = leaf.assigned_to !== UNASSIGNED ? detail.users[leaf.assigned_to] : undefined
    if (!assignedUser) return undefined
    const color = assignedUser.color || PARTICIPANT_COLORS[leaf.assigned_to % PARTICIPANT_COLORS.length]
    const label = (assignedUser.display_name || '?').slice(0, 2).toUpperCase()
    return { nodeIdx: frontIdx, label, color }
  }, [collabNodes, orderedLeaves, detail])

  const myParticipantIndex = summary.participants.findIndex((p) => p.id === userId)

  async function onLeafAction(goalId: string, action: 'start' | 'end') {
    setLeafBusy(true)
    try {
      await fetch(SERVER_ENDPOINTS.goalSharedAction, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journey_id: summary.id, goal_id: goalId, action }),
      })
      setSelectedIdx(null)
      await load()
    } finally { setLeafBusy(false) }
  }

  async function onReassign(goalId: string, targetUserId: string) {
    setLeafBusy(true)
    try {
      await fetch(SERVER_ENDPOINTS.goalSharedAction, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journey_id: summary.id, goal_id: goalId, action: 'reassign', target_user_id: targetUserId }),
      })
      setSelectedIdx(null)
      await load()
    } finally { setLeafBusy(false) }
  }

  async function approveProposal(p: RootProposal) {
    setProposalBusy(true)
    try {
      const res = await fetch(CENTRAL_ENDPOINTS.journeyApproveRoot(summary.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, proposal_id: p.id }),
      })
      const data = (await res.json()) as { ok: boolean; both_approved?: boolean; error?: string }
      if (data.both_approved) {
        await fetch(SERVER_ENDPOINTS.goalCreateSharedRoot, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ journey_id: summary.id, proposal_id: p.id, title: p.title, extra_info: p.extra_info }),
        })
      }
      await load()
    } finally { setProposalBusy(false) }
  }

  async function declineProposal(p: RootProposal) {
    setProposalBusy(true)
    try {
      await fetch(CENTRAL_ENDPOINTS.journeyDeclineRoot(summary.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, proposal_id: p.id }),
      })
      await load()
    } finally { setProposalBusy(false) }
  }

  // Fire a shared-journey action and return the parsed JSON (no side effects);
  // used by the journal editor to start (get the draft attach_id) and end.
  async function sharedAction(goalId: string, action: 'start' | 'end'): Promise<{ ok?: boolean; attach_id?: string }> {
    try {
      const res = await fetch(SERVER_ENDPOINTS.goalSharedAction, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journey_id: summary.id, goal_id: goalId, action }),
      })
      return (await res.json()) as { ok?: boolean; attach_id?: string }
    } catch { return {} }
  }

  // Tapping any leaf opens the SAME focus UI the solo journey uses — timer ring
  // or journal editor. My own actionable step is fully interactive; anything
  // else (a partner's step, a not-yet-unlocked or finished one) opens the same
  // shell read-only with a note about whose step it is. Long-press still opens
  // the detail sheet for reassigning.
  function handleSelect(idx: number) {
    const leaf = orderedLeaves[idx]
    if (!leaf || !detail) { setSelectedIdx(idx); return }
    const state = classifyLeaf(leaf)
    const owner = leaf.assigned_to === UNASSIGNED ? undefined : detail.users[leaf.assigned_to]
    const mine = owner?.id === userId
    const startable = canStartLeaf(leaf, goalMap)
    const isJournal = leaf.goal_type === 1
    const accent = (leaf.assigned_to !== UNASSIGNED && leaf.assigned_to >= 0)
      ? PARTICIPANT_COLORS[leaf.assigned_to % PARTICIPANT_COLORS.length]
      : undefined

    // A not-yet-started step can be passed to another participant (the server
    // only allows reassigning unstarted goals). This is the legacy "reassign",
    // surfaced inside the focus session.
    const passOptions = leaf.start_date === 0 && detail.users.length > 1
      ? detail.users.filter((u) => u.id !== owner?.id).map((u) => ({ id: u.id, name: u.display_name || 'Partner' }))
      : undefined
    const onPass = passOptions && passOptions.length > 0
      ? (uid: string) => { void onReassign(leaf.id, uid) }
      : undefined

    if (mine && (state === 'started' || (state === 'idle' && startable))) {
      if (isJournal) {
        onOpenJournal({
          title: leaf.title,
          requiredTimeSeconds: leaf.required_time,
          startedAlready: leaf.start_date > 0,
          initialAttachId: leaf.attach_id || '',
          ensureStarted: async () => { const r = await sharedAction(leaf.id, 'start'); return r.attach_id || '' },
          endGoal: async () => { await sharedAction(leaf.id, 'end') },
          cancelGoal: async () => { await load() },
          onCompleted: () => { void load() },
        })
      } else {
        onOpenFocus({
          id: leaf.id,
          title: leaf.title,
          extraInfo: leaf.extra_info || undefined,
          tips: leaf.tips || undefined,
          requiredTimeSeconds: leaf.required_time,
          state: state === 'started' ? 'active' : 'idle',
          canStart: startable,
          accent,
          passOptions,
          onPass,
          onStart: () => { void onLeafAction(leaf.id, 'start') },
          onComplete: () => { void onLeafAction(leaf.id, 'end') },
        })
      }
      return
    }

    // Read-only focus for everything else, with a note about whose step it is.
    const note = !mine
      ? `${owner?.display_name || 'A partner'}'s step — view only`
      : (state === 'idle' && !startable ? 'Earlier steps come first' : undefined)
    onOpenFocus({
      id: leaf.id,
      title: leaf.title,
      extraInfo: leaf.extra_info || undefined,
      tips: leaf.tips || undefined,
      requiredTimeSeconds: leaf.required_time,
      state: state === 'finished' ? 'done' : state === 'started' ? 'active' : 'idle',
      canStart: false,
      accent,
      lockedNote: note,
      partnerStep: !mine && state !== 'finished',
      passOptions,
      onPass,
    })
  }

  const doneCount = collabNodes.filter((n) => n.nodeState === 'done').length
  const selectedLeaf = selectedIdx !== null ? orderedLeaves[selectedIdx] : null

  return (
    <div className="flex flex-col h-full">
      {/* header */}
      <div
        className="px-5 pt-12 pb-4 flex items-center gap-3.5 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}
      >
        <button
          type="button"
          onClick={onBack}
          className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-base font-bold tracking-tight leading-tight line-clamp-2 break-words">{summary.title}</div>
          <div className="text-[11px] text-white/40">{doneCount}/{collabNodes.length} done</div>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {/* journey pager dots */}
          {journeyCount > 1 && (
            <div className="flex items-center gap-[5px]">
              {Array.from({ length: journeyCount }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`Go to journey ${i + 1}`}
                  onClick={() => onSelectJourney?.(i)}
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: i === journeyIndex ? 16 : 6,
                    background: i === journeyIndex ? '#fff' : 'var(--border-light)',
                  }}
                />
              ))}
            </div>
          )}

          {/* user legend */}
          {detail && detail.users.length >= 2 && (
            <div className="flex items-center gap-2">
              {detail.users.slice(0, 2).map((u, i) => (
                <ParticipantAvatar
                  key={u.id}
                  id={u.id}
                  name={u.display_name}
                  color={u.color || PARTICIPANT_COLORS[i]}
                  className="h-6 w-6 rounded-full text-[10px] font-bold ring-1 ring-white/15"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* proposals */}
      {proposals.length > 0 && (
        <div
          className="flex-shrink-0 px-4 py-3 space-y-2"
          style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}
        >
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
            {proposals.length} pending proposal{proposals.length > 1 ? 's' : ''}
          </p>
          {proposals.map((p) => {
            const myApproved = myParticipantIndex === 0 ? p.a_approved : p.b_approved
            return (
              <div key={p.id} className="flex items-center gap-3">
                <p className="flex-1 min-w-0 text-sm font-semibold text-white truncate">{p.title}</p>
                {!p.finalized && !myApproved && (
                  <div className="flex gap-2 shrink-0">
                    <button disabled={proposalBusy} onClick={() => void declineProposal(p)}
                      className="rounded-lg border border-[#2a2a2a] px-3 py-1 text-xs text-white/55 disabled:opacity-40">
                      Decline
                    </button>
                    <button disabled={proposalBusy} onClick={() => void approveProposal(p)}
                      className="rounded-lg bg-[#111] border border-[#2a2a2a] px-3 py-1 text-xs text-white disabled:opacity-40">
                      Approve
                    </button>
                  </div>
                )}
                {myApproved && !p.finalized && (
                  <span className="text-[10px] text-amber-400 shrink-0">Waiting for partner</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* path canvas */}
      <div ref={wrapperRef} className="flex-1 relative overflow-hidden">
        {loading && !detail && (
          <div className="flex items-center justify-center h-full text-sm text-white/40">Loading…</div>
        )}
        {!loading && collabNodes.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-white/30 text-center px-8">
              No tasks yet — approve a goal proposal to get started.
            </p>
          </div>
        )}
        {dim.w > 0 && dim.h > 0 && collabNodes.length > 0 && (
          <PathCanvas
            nodes={collabNodes}
            width={dim.w}
            height={dim.h}
            hasMysteryZone={false}
            initialFocusIdx={focusIdx}
            onSelect={handleSelect}
            onLongPress={(i) => setSelectedIdx(i)}
            userOverlay={userOverlay}
          />
        )}
      </div>

      {selectedLeaf && detail && selectedIdx !== null && (
        <CollabNodeDetail
          leaf={selectedLeaf}
          detail={detail}
          goalMap={goalMap}
          userId={userId}
          actionBusy={leafBusy}
          onAction={onLeafAction}
          onReassign={onReassign}
          onClose={() => setSelectedIdx(null)}
        />
      )}
    </div>
  )
}

/* ─── journey list ───────────────────────────────────────────────────────── */

// Deterministic dark gradient per journey so each "portal" card feels distinct
// but stable across reloads. Matches the hero-card aesthetic used elsewhere.
const JOURNEY_GRADIENTS = [
  'linear-gradient(155deg,#1e1b4b 0%,#312e81 55%,#1e1b4b 100%)', // indigo
  'linear-gradient(155deg,#052e16 0%,#064e3b 60%,#0a3a2a 100%)', // emerald
  'linear-gradient(155deg,#1c0a00 0%,#431407 60%,#7c2d12 100%)', // amber
  'linear-gradient(155deg,#2a0a2e 0%,#581c87 60%,#3b0764 100%)', // violet
  'linear-gradient(155deg,#0a1a2e 0%,#0c4a6e 60%,#082f49 100%)', // ocean
  'linear-gradient(155deg,#2e0a14 0%,#831843 60%,#500724 100%)', // rose
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function journeyGradient(id: string): string {
  return JOURNEY_GRADIENTS[hashString(id) % JOURNEY_GRADIENTS.length]
}

function JourneyPortalCard({
  journey, index, onSelect,
}: {
  journey: JourneyListItem
  index: number
  onSelect: (idx: number) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(index)}
      className="anim-entry-in group relative w-full overflow-hidden rounded-[26px] border border-white/10 text-left active:scale-[0.985] transition-transform"
      style={{ height: 168, animationDelay: `${index * 60}ms` }}
    >
      <div className="absolute inset-0" style={{ background: journeyGradient(journey.id) }} />
      {/* soft glow blobs for depth */}
      <div
        className="absolute -top-12 -right-10 h-52 w-52 rounded-full opacity-70 blur-2xl"
        style={{ background: PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length] }}
      />
      <div
        className="absolute -bottom-16 -left-10 h-48 w-48 rounded-full opacity-45 blur-2xl"
        style={{ background: PARTICIPANT_COLORS[(index + 1) % PARTICIPANT_COLORS.length] }}
      />
      <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,.78) 0%, rgba(0,0,0,.15) 55%, rgba(0,0,0,.05) 100%)' }} />

      {/* top: chevron affordance */}
      <div className="absolute top-4 right-5">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full transition-transform group-hover:translate-x-0.5"
          style={{ background: 'rgba(255,255,255,.92)', color: '#000' }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </div>

      {/* bottom: title + meta + avatars */}
      <div className="absolute bottom-0 left-0 right-0 px-5 pb-4">
        <div className="text-[22px] font-extrabold tracking-tight leading-[1.12] line-clamp-2">{journey.title}</div>
        <div className="mt-2 flex items-center gap-3">
          <div className="flex -space-x-2">
            {journey.participants.slice(0, 4).map((p, i) => (
              <ParticipantAvatar
                key={p.id}
                id={p.id}
                name={p.display_name}
                color={p.color || PARTICIPANT_COLORS[i % PARTICIPANT_COLORS.length]}
                className="h-7 w-7 rounded-full border-2 text-[11px] font-bold"
                style={{ borderColor: 'rgba(0,0,0,.55)' }}
              />
            ))}
          </div>
          <span className="text-[12px] font-medium" style={{ color: 'rgba(255,255,255,.6)' }}>
            {(journey.root_count ?? journey.goal_count)} goal{(journey.root_count ?? journey.goal_count) === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </button>
  )
}

function ReviewsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3.5 py-2 text-[13px] font-semibold text-black shadow-sm transition-transform active:scale-95"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z" />
      </svg>
      Reviews
    </button>
  )
}

function JourneysContent({
  journeys, loading, error, onSelect, onOpenReviews,
}: {
  journeys: JourneyListItem[]
  loading: boolean
  error: string | null
  onSelect: (idx: number) => void
  onOpenReviews: () => void
}) {
  if (loading && journeys.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-white/40">
        Loading shared journeys…
      </div>
    )
  }

  if (journeys.length === 0) {
    return (
      <section className="mx-auto w-full max-w-2xl px-4 pt-[52px] pb-10">
        <header className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Collab</h1>
            <p className="mt-1 text-sm text-white/55">Journeys you're working on with someone else.</p>
          </div>
          <div className="pt-1"><ReviewsButton onClick={onOpenReviews} /></div>
        </header>
        <div className="rounded-3xl border border-dashed border-[#2a2a2a] bg-[#1a1a1a] px-6 py-10 text-center">
          <p className="text-3xl">🤝</p>
          <p className="mt-3 text-sm font-semibold text-white">No shared journeys yet</p>
          <p className="mt-2 text-xs text-white/55">
            Connect with someone, then open the chat and tap{' '}
            <span className="font-semibold">+ Propose goal</span> to start a shared journey.
          </p>
          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        </div>
      </section>
    )
  }

  return (
    <section className="mx-auto w-full max-w-2xl px-4 pt-[52px] pb-8">
      <header className="mb-6 flex items-start justify-between gap-3 px-1">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-white">Collab</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--white-dim)' }}>
            {journeys.length} shared journey{journeys.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="pt-1.5"><ReviewsButton onClick={onOpenReviews} /></div>
      </header>
      <div className="flex flex-col gap-3.5">
        {journeys.map((j, i) => (
          <JourneyPortalCard key={j.id} journey={j} index={i} onSelect={onSelect} />
        ))}
      </div>
      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
    </section>
  )
}

/* ─── main together view ─────────────────────────────────────────────────── */

export default function TogetherView({ userId, onOpenFocus, onOpenJournal }: { userId: string; onOpenFocus: (target: FocusTarget) => void; onOpenJournal: (props: JournalFocusActions) => void }) {
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [reviewsOpen, setReviewsOpen] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [journeys, setJourneys] = useState<JourneyListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) return
    try {
      const r = await fetch(CENTRAL_ENDPOINTS.journeyList(userId), { cache: 'no-store' })
      if (!r.ok) throw new Error(`journey list failed (${r.status})`)
      const data = (await r.json()) as JourneyListResponse
      if (data.ok) { setJourneys(data.journeys); setError(null) }
      else throw new Error('server returned ok=false')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void load()
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
  }, [load])

  // Keep the open journey index valid if the list shrinks underneath us.
  useEffect(() => {
    if (selectedIdx !== null && selectedIdx > journeys.length - 1) {
      setSelectedIdx(journeys.length > 0 ? journeys.length - 1 : null)
    }
  }, [journeys.length, selectedIdx])

  const journeyOpen = selectedIdx !== null && journeys[selectedIdx] !== undefined

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {journeyOpen ? (
        <SwipeDeck
          count={journeys.length}
          index={selectedIdx as number}
          onIndexChange={setSelectedIdx}
          className="h-full"
          renderSlide={(i) => {
            // Render the open journey and its neighbours only — bounds the number
            // of live CollabJourneyView fetch/poll loops to three.
            if (Math.abs(i - (selectedIdx as number)) > 1) return null
            return (
              <CollabJourneyView
                summary={journeys[i]}
                userId={userId}
                onBack={() => setSelectedIdx(null)}
                onOpenFocus={onOpenFocus}
                onOpenJournal={onOpenJournal}
                journeyCount={journeys.length}
                journeyIndex={i}
                onSelectJourney={setSelectedIdx}
              />
            )
          }}
        />
      ) : (
        <div className="flex-1 overflow-y-auto no-scrollbar">
          <JourneysContent
            journeys={journeys}
            loading={loading}
            error={error}
            onSelect={setSelectedIdx}
            onOpenReviews={() => setReviewsOpen(true)}
          />
        </div>
      )}

      {/* People FAB — hidden when journey detail is open */}
      {!journeyOpen && (
        <button
          type="button"
          onClick={() => setPeopleOpen(true)}
          className="fixed z-[99] flex items-center justify-center"
          style={{
            bottom: 96, right: 20,
            width: 52, height: 52,
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
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </button>
      )}

      <ReviewsPanel open={reviewsOpen} onClose={() => setReviewsOpen(false)} userId={userId} />

      {/* People overlay — slides in from right */}
      <div
        className="fixed inset-0 z-[200] flex flex-col transition-transform duration-300"
        style={{
          background: 'var(--bg)',
          transform: peopleOpen ? 'translateX(0)' : 'translateX(100%)',
        }}
      >
        <div
          className="px-5 pt-12 pb-4 flex items-center gap-3.5 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}
        >
          <button
            type="button"
            onClick={() => setPeopleOpen(false)}
            className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="text-lg font-bold tracking-tight">People</div>
        </div>
        <div className="flex-1 overflow-hidden">
          {peopleOpen && <ConnectionsView userId={userId} />}
        </div>
      </div>
    </div>
  )
}
