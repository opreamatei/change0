import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS } from '../config/server'
import { PathCanvas } from '../components/path-canvas'
import type { PathNodeData, NodeState } from '../components/path-canvas'
import ConnectionsView from './connections-view'

const UNASSIGNED = 255

// Per-participant colour palette for the collab canvas
const PARTICIPANT_COLORS = [
  '#8b5cf6', // violet (user 0)
  '#f43f5e', // rose   (user 1)
  '#f59e0b', // amber  (user 2)
  '#14b8a6', // teal   (user 3)
]

interface ParticipantSummary {
  index: number
  id: string
  display_name: string
}

interface JourneyListItem {
  id: string
  title: string
  user_count: number
  goal_count: number
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
  summary, userId, onBack,
}: {
  summary: JourneyListItem
  userId: string
  onBack: () => void
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
        ? PARTICIPANT_COLORS[leaf.assigned_to % PARTICIPANT_COLORS.length]
        : undefined
      // for a 2-user journey: user 0 → left side, user 1 → right side
      const sideOverride: PathNodeData['sideOverride'] =
        leaf.assigned_to === 0 ? -1 :
        leaf.assigned_to === 1 ?  1 :
        undefined
      return { key: leaf.localIndex, title: leaf.title, nodeState, num: num++, isMystery: false, chapterTitle, tintColor, sideOverride }
    })
  }, [orderedLeaves, goalMap])

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
    const color = PARTICIPANT_COLORS[leaf.assigned_to % PARTICIPANT_COLORS.length]
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
          <div className="text-base font-bold tracking-tight truncate">{summary.title}</div>
          <div className="text-[11px] text-white/40">{doneCount}/{collabNodes.length} done</div>
        </div>

        {/* user legend */}
        {detail && detail.users.length >= 2 && (
          <div className="flex items-center gap-2 shrink-0">
            {detail.users.slice(0, 2).map((u, i) => (
              <div key={u.id} className="flex items-center gap-1">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: PARTICIPANT_COLORS[i] }}
                />
                <span className="text-[11px]" style={{ color: 'rgba(255,255,255,.45)' }}>
                  {u.display_name}
                </span>
              </div>
            ))}
          </div>
        )}
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
            onSelect={setSelectedIdx}
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

function JourneysContent({ userId, onSelect }: { userId: string; onSelect: (j: JourneyListItem) => void }) {
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

  if (loading && journeys.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-white/40">
        Loading shared journeys…
      </div>
    )
  }

  if (journeys.length === 0) {
    return (
      <section className="mx-auto w-full max-w-2xl px-4 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-white">Collab</h1>
          <p className="mt-1 text-sm text-white/55">Journeys you're working on with someone else.</p>
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
    <section className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white">Collab</h1>
        <p className="mt-1 text-sm text-white/55">
          {journeys.length} shared journey{journeys.length === 1 ? '' : 's'}
        </p>
      </header>
      <div className="space-y-3">
        {journeys.map((j) => (
          <button
            key={j.id}
            type="button"
            onClick={() => onSelect(j)}
            className="w-full text-left rounded-3xl border border-[#2a2a2a] bg-[#111] px-5 py-4 transition-colors hover:bg-[#1a1a1a]"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-white">{j.title}</p>
                <p className="mt-0.5 text-xs text-white/55">
                  {j.user_count} participant{j.user_count === 1 ? '' : 's'} · {j.goal_count} goal{j.goal_count === 1 ? '' : 's'}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="flex -space-x-2">
                  {j.participants.slice(0, 4).map((p, i) => (
                    <div
                      key={p.id}
                      title={p.display_name}
                      className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-black text-[10px] font-semibold"
                      style={{
                        background: PARTICIPANT_COLORS[i % PARTICIPANT_COLORS.length] + '33',
                        color: PARTICIPANT_COLORS[i % PARTICIPANT_COLORS.length],
                      }}
                    >
                      {(p.display_name || '?').slice(0, 1).toUpperCase()}
                    </div>
                  ))}
                </div>
                <span className="text-white/30">▸</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
    </section>
  )
}

/* ─── main together view ─────────────────────────────────────────────────── */

export default function TogetherView({ userId }: { userId: string }) {
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [selectedJourney, setSelectedJourney] = useState<JourneyListItem | null>(null)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {selectedJourney ? (
        <div className="flex-1 overflow-hidden">
          <CollabJourneyView
            summary={selectedJourney}
            userId={userId}
            onBack={() => setSelectedJourney(null)}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto no-scrollbar">
          <JourneysContent userId={userId} onSelect={setSelectedJourney} />
        </div>
      )}

      {/* People FAB — hidden when journey detail is open */}
      {!selectedJourney && (
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
