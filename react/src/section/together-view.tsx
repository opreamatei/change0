import { useCallback, useEffect, useState } from 'react'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS } from '../config/server'

/*
 * "Together" — the shared-journey companion to the solo Session tab.
 *
 * The data source is the central server, not the local client server, so
 * both participants always see the same source of truth without sync. The
 * Goal shape mirrors the C-side journey JSON: subgoals are sibling
 * localIndex references inside the same journey, and assigned_to is a byte
 * (255 = unassigned, otherwise a participant index in this journey's
 * users[] table).
 *
 * Non-leaf goals are intentionally left visible but greyed; only leaves
 * carry a real owner.
 */

const UNASSIGNED = 255

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

function isLeaf(g: JourneyGoal): boolean {
  return g.subgoals_len === 0
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
  if (!isLeaf(g) || g.start_date !== 0) return false
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

function SharedLeafCard({
  entry,
  owner,
  allUsers,
  myUserId,
  onAction,
  onReassign,
  actionBusy,
}: {
  entry: LeafEntry
  owner: JourneyUser | undefined
  allUsers: JourneyUser[]
  myUserId: string
  onAction: (goalId: string, action: 'start' | 'end') => Promise<void>
  onReassign: (goalId: string, targetUserId: string) => Promise<void>
  actionBusy: boolean
}) {
  const [passingTo, setPassing] = useState<string | null>(null)
  const mine = owner?.id === myUserId
  const { goal, state, canStart } = entry
  const others = allUsers.filter((u) => u.id !== owner?.id)

  const ownerBadge = (
    <span className={[
      'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
      mine ? 'bg-black text-white' : 'bg-neutral-200 text-neutral-600',
    ].join(' ')}>
      {owner?.display_name ?? '?'}{mine && ' (you)'}
    </span>
  )

  if (state === 'finished') {
    return (
      <article className="rounded-xl border border-neutral-100 bg-neutral-50 px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="size-2 rounded-full bg-neutral-300" />
          <span className="text-xs font-semibold uppercase tracking-widest text-neutral-400">Done</span>
          {ownerBadge}
        </div>
        <h3 className="text-base font-semibold text-neutral-400 line-through">{goal.title}</h3>
        <p className="mt-1 text-xs text-neutral-400">{formatDuration(goal.required_time)} estimated</p>
      </article>
    )
  }

  if (state === 'started') {
    return (
      <article className="rounded-xl border border-green-200 bg-green-50 px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="size-2 animate-pulse rounded-full bg-green-500" />
          <span className="text-xs font-semibold uppercase tracking-widest text-green-700">Running</span>
          {ownerBadge}
        </div>
        <h3 className="mb-1 text-base font-semibold text-black">{goal.title}</h3>
        {goal.extra_info && <p className="mb-3 text-sm leading-relaxed text-neutral-700">{goal.extra_info}</p>}
        <p className="mb-3 text-xs text-neutral-500">{formatDuration(goal.required_time)} estimated</p>
        {mine && (
          <button
            disabled={actionBusy}
            onClick={() => void onAction(goal.id, 'end')}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
          >End</button>
        )}
      </article>
    )
  }

  const passControls = mine && state === 'idle' && others.length > 0 && (
    <div className="mt-2">
      {passingTo === null ? (
        <button
          disabled={actionBusy}
          onClick={() => setPassing(others[0]!.id)}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-40"
        >Pass</button>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={passingTo}
            onChange={(e) => setPassing(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm text-black outline-none"
          >
            {others.map((u) => (
              <option key={u.id} value={u.id}>{u.display_name}</option>
            ))}
          </select>
          <button
            disabled={actionBusy}
            onClick={() => { void onReassign(goal.id, passingTo); setPassing(null) }}
            className="rounded border border-neutral-300 bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
          >Confirm</button>
          <button
            onClick={() => setPassing(null)}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
          >Cancel</button>
        </div>
      )}
    </div>
  )

  if (canStart) {
    return (
      <article className="rounded-xl border border-neutral-200 bg-white px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          {ownerBadge}
        </div>
        <h3 className="mb-1 text-base font-semibold text-black">{goal.title}</h3>
        {goal.extra_info && <p className="mb-3 text-sm leading-relaxed text-neutral-600">{goal.extra_info}</p>}
        <p className="mb-3 text-xs text-neutral-500">{formatDuration(goal.required_time)} estimated</p>
        <div className="flex flex-wrap gap-2">
          {mine && (
            <button
              disabled={actionBusy}
              onClick={() => void onAction(goal.id, 'start')}
              className="rounded border border-green-300 bg-green-50 px-3 py-1.5 text-sm text-green-700 hover:bg-green-100 disabled:opacity-40"
            >Start</button>
          )}
          {!mine && (
            <p className="text-xs text-neutral-400 italic self-center">Waiting for {owner?.display_name ?? 'partner'}</p>
          )}
        </div>
        {passControls}
      </article>
    )
  }

  /* Future — not yet reachable */
  return (
    <article className="rounded-xl border border-neutral-100 bg-neutral-50 px-5 py-4">
      <div className="mb-1 flex items-center gap-2 opacity-50">{ownerBadge}</div>
      <h3 className="text-base font-semibold text-neutral-400">{goal.title}</h3>
      <p className="mt-1 text-xs text-neutral-400">{formatDuration(goal.required_time)} estimated</p>
      {passControls}
    </article>
  )
}

function JourneyCard({ summary, userId }: { summary: JourneyListItem; userId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<JourneyDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposals, setProposals] = useState<RootProposal[]>([])
  const [proposalBusy, setProposalBusy] = useState(false)
  const [leafBusy, setLeafBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const [detailRes, propsRes] = await Promise.all([
        fetch(CENTRAL_ENDPOINTS.journey(summary.id), { cache: 'no-store' }),
        fetch(CENTRAL_ENDPOINTS.journeyProposals(summary.id), { cache: 'no-store' }),
      ])
      if (!detailRes.ok) throw new Error(`journey fetch failed (${detailRes.status})`)
      const data = (await detailRes.json()) as JourneyDetail
      setDetail(data)
      if (propsRes.ok) {
        const pd = (await propsRes.json()) as { ok: boolean; proposals: RootProposal[] }
        if (pd.ok) setProposals(pd.proposals)
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [summary.id])

  useEffect(() => {
    if (!expanded) return
    void load()
    const id = setInterval(load, 6000)
    return () => clearInterval(id)
  }, [expanded, load])

  async function approveProposal(p: RootProposal) {
    setProposalBusy(true)
    try {
      const res = await fetch(CENTRAL_ENDPOINTS.journeyApproveRoot(summary.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, proposal_id: p.id }),
      })
      const data = (await res.json()) as { ok: boolean; both_approved?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'approve failed')

      if (data.both_approved) {
        /* Both approved — materialize the goal locally then push to central */
        const cr = await fetch(SERVER_ENDPOINTS.goalCreateSharedRoot, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ journey_id: summary.id, proposal_id: p.id, title: p.title, extra_info: p.extra_info }),
        })
        if (!cr.ok) console.error('[together] create-shared-root failed', await cr.text())
      }

      await load()
    } catch (err) {
      console.error('[together] approve proposal:', err)
    } finally {
      setProposalBusy(false)
    }
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
    } catch (err) {
      console.error('[together] decline proposal:', err)
    } finally {
      setProposalBusy(false)
    }
  }

  const goalMap = detail
    ? new Map<number, JourneyGoal>(detail.goals.map((g) => [g.localIndex, g]))
    : new Map<number, JourneyGoal>()

  const orderedLeaves: LeafEntry[] = []
  if (detail) {
    for (const g of detail.goals) {
      if (g.parent !== 0) continue
      for (const leaf of collectLeavesInOrder(g, goalMap)) {
        orderedLeaves.push({ goal: leaf, state: classifyLeaf(leaf), canStart: canStartLeaf(leaf, goalMap) })
      }
    }
  }

  async function onLeafAction(goalId: string, action: 'start' | 'end') {
    setLeafBusy(true)
    try {
      const res = await fetch(SERVER_ENDPOINTS.goalSharedAction, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journey_id: summary.id, goal_id: goalId, action }),
      })
      if (!res.ok) console.error('[together] leaf action failed', await res.text())
      await load()
    } catch (err) {
      console.error('[together] leaf action:', err)
    } finally {
      setLeafBusy(false)
    }
  }

  async function onReassign(goalId: string, targetUserId: string) {
    setLeafBusy(true)
    try {
      const res = await fetch(SERVER_ENDPOINTS.goalSharedAction, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journey_id: summary.id, goal_id: goalId, action: 'reassign', target_user_id: targetUserId }),
      })
      if (!res.ok) console.error('[together] reassign failed', await res.text())
      await load()
    } catch (err) {
      console.error('[together] reassign:', err)
    } finally {
      setLeafBusy(false)
    }
  }

  /* Map userId → participant index (0 or 1) for proposal display */
  const myParticipantIndex = summary.participants.findIndex((p) => p.id === userId)

  return (
    <section className="rounded-3xl border border-neutral-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-black">{summary.title}</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {summary.user_count} participant{summary.user_count === 1 ? '' : 's'} · {summary.goal_count} goal{summary.goal_count === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex -space-x-2">
            {summary.participants.slice(0, 4).map((p) => (
              <div
                key={p.id}
                title={p.display_name}
                className={[
                  'flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold',
                  p.id === userId ? 'bg-black text-white' : 'bg-neutral-200 text-neutral-700',
                ].join(' ')}
              >
                {(p.display_name || '?').slice(0, 1).toUpperCase()}
              </div>
            ))}
          </div>
          <span className="text-neutral-300">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-neutral-100 px-5 py-4">
          {loading && !detail && (
            <p className="py-6 text-center text-xs text-neutral-400">Loading journey…</p>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}

          {detail && (
            <>
              {detail.extra_info && (
                <p className="mb-4 text-xs leading-relaxed text-neutral-600">{detail.extra_info}</p>
              )}

              {/* Proposals */}
              {proposals.length > 0 && (
                <div className="mb-4 space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
                    Root goal proposals
                  </p>
                  {proposals.map((p) => {
                    const myApproved  = myParticipantIndex === 0 ? p.a_approved : p.b_approved
                    const bothApproved = p.a_approved && p.b_approved
                    const isMine = p.proposed_by === userId

                    return (
                      <div key={p.id} className="rounded-xl border border-neutral-200 px-4 py-3 bg-neutral-50">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-black">{p.title}</p>
                            {p.extra_info && <p className="mt-0.5 text-xs text-neutral-500 line-clamp-2">{p.extra_info}</p>}
                            <p className="mt-1 text-[10px] text-neutral-400">
                              {isMine ? 'You proposed' : 'Partner proposed'} ·{' '}
                              {p.finalized ? <span className="text-emerald-700">finalized</span>
                                : bothApproved ? <span className="text-emerald-700">both approved</span>
                                : myApproved  ? <span className="text-amber-700">waiting for partner</span>
                                :               <span className="text-neutral-500">awaiting your vote</span>}
                            </p>
                          </div>
                          {!p.finalized && !myApproved && (
                            <div className="flex gap-2 shrink-0">
                              <button
                                disabled={proposalBusy}
                                onClick={() => void declineProposal(p)}
                                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-500
                                  hover:border-red-300 hover:text-red-500 disabled:opacity-40"
                              >Decline</button>
                              <button
                                disabled={proposalBusy}
                                onClick={() => void approveProposal(p)}
                                className="rounded-lg bg-black px-3 py-1.5 text-xs text-white
                                  hover:bg-neutral-800 disabled:opacity-40"
                              >Approve</button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {orderedLeaves.length === 0 && (
                <p className="py-6 text-center text-xs text-neutral-400">No tasks yet — propose a goal to get started.</p>
              )}
              <div className="space-y-3">
                {orderedLeaves.map((entry) => (
                  <SharedLeafCard
                    key={entry.goal.id}
                    entry={entry}
                    owner={entry.goal.assigned_to === UNASSIGNED ? undefined : detail!.users[entry.goal.assigned_to]}
                    allUsers={detail!.users}
                    myUserId={userId}
                    onAction={onLeafAction}
                    onReassign={onReassign}
                    actionBusy={leafBusy}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

export default function TogetherView({ userId }: { userId: string }) {
  const [journeys, setJourneys] = useState<JourneyListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) return
    try {
      const r = await fetch(CENTRAL_ENDPOINTS.journeyList(userId), { cache: 'no-store' })
      if (!r.ok) throw new Error(`journey list failed (${r.status})`)
      const data = (await r.json()) as JourneyListResponse
      if (data.ok) {
        setJourneys(data.journeys)
        setError(null)
      } else {
        throw new Error('server returned ok=false')
      }
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
      <div className="flex items-center justify-center py-20 text-sm text-neutral-400">
        Loading shared journeys…
      </div>
    )
  }

  if (journeys.length === 0) {
    return (
      <section className="mx-auto w-full max-w-2xl px-4 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-black">Together</h1>
          <p className="mt-1 text-sm text-neutral-500">Journeys you're working on with someone else.</p>
        </header>

        <div className="rounded-3xl border border-dashed border-neutral-200 bg-neutral-50 px-6 py-10 text-center">
          <p className="text-3xl">🤝</p>
          <p className="mt-3 text-sm font-semibold text-black">No shared journeys yet</p>
          <p className="mt-2 text-xs text-neutral-500">
            Connect with someone, then open the chat and tap <span className="font-semibold">+ Propose goal</span> to start a shared journey.
          </p>
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        </div>
      </section>
    )
  }

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-black">Together</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {journeys.length} shared journey{journeys.length === 1 ? '' : 's'} · each leaf is owned by one person.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50"
        >
          Refresh
        </button>
      </header>

      <div className="space-y-4">
        {journeys.map((j) => (
          <JourneyCard key={j.id} summary={j} userId={userId} />
        ))}
      </div>

      {error && <p className="mt-4 text-xs text-red-500">{error}</p>}
    </section>
  )
}
