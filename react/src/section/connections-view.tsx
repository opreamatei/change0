import { useCallback, useEffect, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS } from '../config/server'

interface Connection {
  id: string
  state: number  /* 0=proposed, 1=confirmed, 2=declined */
  my_approved: boolean
  their_approved: boolean
  /* The partner's central user id. Required to attribute shared journeys
   * to both participants; the matching system already knows it server-side
   * and exposes it here. */
  other_id: string
  other_name: string
  reason: string
  proposed_at: number
}

interface Message {
  sender: string
  at: number
  text: string
}

interface ProposalMessage {
  _type: 'proposal'
  proposal_id: string
  journey_id: string
  title: string
  extra_info: string
}

function parseProposal(text: string): ProposalMessage | null {
  if (!text.startsWith('{')) return null
  try {
    const obj = JSON.parse(text) as Record<string, unknown>
    if (obj._type === 'proposal') return obj as unknown as ProposalMessage
  } catch { /* not JSON */ }
  return null
}

const STATE_PROPOSED  = 0
const STATE_CONFIRMED = 1
const STATE_DECLINED  = 2

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/* ─── Inline proposal bubble ──────────────────────────────────── */

function ProposalBubble({
  proposal,
  sender,
  at,
  userId,
  conn,
  onRefresh,
}: {
  proposal: ProposalMessage
  sender: string
  at: number
  userId: string
  conn: Connection
  onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const mine = sender === userId

  async function approve() {
    setBusy(true)
    try {
      const res = await fetch(CENTRAL_ENDPOINTS.journeyApproveRoot(proposal.journey_id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, proposal_id: proposal.proposal_id }),
      })
      const data = (await res.json()) as { ok: boolean; both_approved?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'approve failed')

      if (data.both_approved) {
        await fetch(SERVER_ENDPOINTS.goalCreateSharedRoot, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            journey_id: proposal.journey_id,
            proposal_id: proposal.proposal_id,
            title: proposal.title,
            extra_info: proposal.extra_info,
          }),
        })
      }
      setDone(true)
      await onRefresh()
    } catch (err) {
      console.error('[proposal] approve:', err)
    } finally {
      setBusy(false)
    }
  }

  async function decline() {
    setBusy(true)
    try {
      await fetch(CENTRAL_ENDPOINTS.journeyDeclineRoot(proposal.journey_id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, proposal_id: proposal.proposal_id }),
      })
      setDone(true)
      await onRefresh()
    } catch (err) {
      console.error('[proposal] decline:', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[82%] rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400 mb-1">
          Goal proposal
        </p>
        <p className="text-sm font-semibold text-black">{proposal.title}</p>
        {proposal.extra_info && (
          <p className="mt-0.5 text-xs text-neutral-500 line-clamp-3">{proposal.extra_info}</p>
        )}
        <p className="text-[10px] text-neutral-400 mt-1">{formatTime(at)}</p>
        {!mine && !done && (
          <div className="mt-2 flex gap-2">
            <button
              disabled={busy}
              onClick={() => void decline()}
              className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 hover:border-red-300 hover:text-red-500 disabled:opacity-40"
            >Decline</button>
            <button
              disabled={busy}
              onClick={() => void approve()}
              className="rounded-lg bg-black px-3 py-1.5 text-xs text-white hover:bg-neutral-800 disabled:opacity-40"
            >Approve</button>
          </div>
        )}
        {mine && !done && (
          <p className="mt-1.5 text-[10px] italic text-neutral-400">Waiting for {conn.other_name} to respond…</p>
        )}
        {done && (
          <p className="mt-1.5 text-[10px] text-emerald-700">Done</p>
        )}
      </div>
    </div>
  )
}

/* ─── Message thread ───────────────────────────────────────────── */

interface JourneyListItem { id: string; participants: { id: string }[] }

function MessageThread({ conn, userId, onBack }: { conn: Connection; userId: string; onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [proposeOpen, setProposeOpen] = useState(false)
  const [proposeTitle, setProposeTitle] = useState('')
  const [proposeExtraInfo, setProposeExtraInfo] = useState('')
  const [proposeBusy, setProposeBusy] = useState(false)
  const [proposeError, setProposeError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null)

  async function proposeRootGoal() {
    const title = proposeTitle.trim()
    if (!title) { setProposeError('Enter a goal title.'); return }
    if (!conn.other_id) { setProposeError('Partner id is missing.'); return }

    setProposeBusy(true)
    setProposeError(null)
    try {
      const listRes = await fetch(CENTRAL_ENDPOINTS.journeyList(userId), { cache: 'no-store' })
      const listData = (await listRes.json()) as { ok: boolean; journeys: JourneyListItem[] }
      const journey = listData.journeys?.find((j) => j.participants.some((p) => p.id === conn.other_id))
      if (!journey) {
        setProposeError('Shared journey not found yet — it may still be setting up.')
        return
      }

      const res = await fetch(CENTRAL_ENDPOINTS.journeyProposeRoot(journey.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, title, extra_info: proposeExtraInfo.trim() }),
      })
      const data = (await res.json()) as { ok: boolean; id?: string; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? `propose failed (${res.status})`)

      setProposeOpen(false)
      setProposeTitle('')
      setProposeExtraInfo('')
      await load()
    } catch (err) {
      setProposeError(err instanceof Error ? err.message : String(err))
    } finally {
      setProposeBusy(false)
    }
  }

  const load = useCallback(async () => {
    try {
      const r = await fetch(CENTRAL_ENDPOINTS.messages(conn.id), { cache: 'no-store' })
      if (!r.ok) return
      const data = (await r.json()) as { ok: boolean; messages: Message[] }
      if (data.ok) setMessages(data.messages)
    } catch { /* ignore */ }
  }, [conn.id])

  useEffect(() => {
    load()
    pollRef.current = setInterval(load, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [load])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const t = text.trim()
    if (!t) return
    setSending(true)
    setText('')
    try {
      await fetch(CENTRAL_ENDPOINTS.messagesSend, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: conn.id, sender_id: userId, text: t }),
      })
      await load()
    } finally { setSending(false) }
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-100 shrink-0">
        <button onClick={onBack} className="text-xl leading-none text-neutral-400 hover:text-black">←</button>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">{conn.other_name}</p>
          <p className="text-[10px] text-neutral-400">Connected {formatTime(conn.proposed_at)}</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          onClick={() => { setProposeOpen((v) => !v); setProposeError(null) }}
        >
          {proposeOpen ? 'Cancel' : '+ Propose goal'}
        </button>
      </div>

      {/* root-goal proposal drawer */}
      {proposeOpen && (
        <div className="border-b border-neutral-100 bg-neutral-50 px-4 py-3 shrink-0 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
            Propose a shared root goal with {conn.other_name}
          </p>
          <input
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-black bg-white"
            placeholder="Goal title…"
            value={proposeTitle}
            onChange={(e) => setProposeTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !proposeBusy) { e.preventDefault(); void proposeRootGoal() } }}
            disabled={proposeBusy}
            autoFocus
          />
          <input
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-black bg-white"
            placeholder="Extra info (optional)…"
            value={proposeExtraInfo}
            onChange={(e) => setProposeExtraInfo(e.target.value)}
            disabled={proposeBusy}
          />
          <button
            className="rounded-lg bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
            onClick={() => void proposeRootGoal()}
            disabled={proposeBusy || !proposeTitle.trim()}
          >
            {proposeBusy ? 'Proposing…' : 'Propose'}
          </button>
          {proposeError && <p className="text-xs text-red-500">{proposeError}</p>}
        </div>
      )}

      {/* messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {messages.length === 0 && (
          <p className="text-xs text-neutral-400 text-center mt-12">No messages yet. Say hi.</p>
        )}
        {messages.map((m, i) => {
          const proposal = parseProposal(m.text)
          if (proposal) {
            return (
              <ProposalBubble
                key={i}
                proposal={proposal}
                sender={m.sender}
                at={m.at}
                userId={userId}
                conn={conn}
                onRefresh={load}
              />
            )
          }
          const mine = m.sender === userId
          return (
            <div key={i} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
                ${mine ? 'bg-black text-white rounded-br-sm' : 'bg-neutral-100 text-black rounded-bl-sm'}`}>
                <p>{m.text}</p>
                <p className="text-[10px] mt-1 text-neutral-400">{formatTime(m.at)}</p>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <div className="shrink-0 border-t border-neutral-100 px-4 py-3 flex gap-2 bg-white">
        <input
          className="flex-1 rounded-full border border-neutral-200 px-4 py-2.5 text-sm outline-none focus:border-black bg-neutral-50"
          placeholder="Message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          disabled={sending}
        />
        <button
          className="rounded-full bg-black text-white text-sm px-5 py-2.5 disabled:opacity-40 shrink-0"
          onClick={send}
          disabled={sending || !text.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}

/* ─── Proposal card (Tinder-style) ────────────────────────────── */

function ProposalCard({
  conn,
  onApprove,
  onDecline,
}: {
  conn: Connection
  onApprove: () => Promise<void>
  onDecline: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  async function approve() {
    setBusy(true)
    try { await onApprove() } finally { setBusy(false) }
  }

  async function decline() {
    setBusy(true)
    try { await onDecline() } finally { setBusy(false) }
  }

  const waitingForThem = conn.my_approved && conn.state === STATE_PROPOSED

  return (
    <div className="mx-auto w-full max-w-sm">
      {/* card */}
      <div className="rounded-3xl bg-white border border-neutral-100 shadow-sm overflow-hidden">
        {/* name bar */}
        <div className="px-6 pt-6 pb-4">
          <p className="text-xl font-semibold tracking-tight">{conn.other_name}</p>
          <p className="text-xs text-neutral-400 mt-0.5">{formatTime(conn.proposed_at)}</p>
        </div>

        {/* reason */}
        <div className="px-6 pb-6">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400 mb-2">Why you might click</p>
          <p className="text-sm text-neutral-700 leading-relaxed">{conn.reason}</p>
        </div>

        {/* divider */}
        <div className="border-t border-neutral-100" />

        {/* actions */}
        <div className="px-6 py-5">
          {waitingForThem ? (
            <div className="text-center py-2">
              <p className="text-sm font-medium text-black">Request sent</p>
              <p className="text-xs text-neutral-400 mt-1">Waiting for {conn.other_name} to respond.</p>
            </div>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => { void decline() }}
                disabled={busy}
                className="flex-1 rounded-2xl border-2 border-neutral-200 text-sm font-semibold py-3.5 text-neutral-500
                  hover:border-red-300 hover:text-red-500 transition-colors disabled:opacity-40"
              >
                Pass
              </button>
              <button
                onClick={() => { void approve() }}
                disabled={busy}
                className="flex-1 rounded-2xl bg-black text-white text-sm font-semibold py-3.5
                  hover:bg-neutral-800 transition-colors disabled:opacity-40"
              >
                Connect
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Confirmed connection row ─────────────────────────────────── */

function ConnectedRow({
  conn,
  onOpen,
}: {
  conn: Connection
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl bg-white border border-neutral-100
        hover:border-neutral-300 transition-colors text-left"
    >
      {/* avatar placeholder */}
      <div className="w-10 h-10 rounded-full bg-neutral-900 text-white flex items-center justify-center
        text-sm font-semibold shrink-0">
        {conn.other_name.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm">{conn.other_name}</p>
        <p className="text-xs text-neutral-400 truncate">{conn.reason}</p>
      </div>
      <span className="text-neutral-300 text-lg">›</span>
    </button>
  )
}

/* ─── Main view ────────────────────────────────────────────────── */

export default function ConnectionsView({ userId }: { userId: string }) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading]         = useState(true)
  const [thread, setThread]           = useState<Connection | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(CENTRAL_ENDPOINTS.connections(userId), { cache: 'no-store' })
      if (!r.ok) return
      const data = (await r.json()) as { ok: boolean; connections: Connection[] }
      if (data.ok) {
        setConnections(data.connections)
        setThread((prev) => {
          if (!prev) return null
          return data.connections.find((c) => c.id === prev.id) ?? null
        })
      }
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [userId])

  useEffect(() => {
    load()
    pollRef.current = setInterval(load, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [load])

  if (thread) {
    return <MessageThread conn={thread} userId={userId} onBack={() => setThread(null)} />
  }

  const proposals  = connections.filter((c) => c.state === STATE_PROPOSED)
  const confirmed  = connections.filter((c) => c.state === STATE_CONFIRMED)
  const declined   = connections.filter((c) => c.state === STATE_DECLINED)

  if (loading) {
    return <div className="flex items-center justify-center h-full text-sm text-neutral-400">Loading…</div>
  }

  const empty = proposals.length === 0 && confirmed.length === 0

  return (
    <div className="overflow-y-auto h-full px-4 py-6 space-y-8">

      {empty && (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
          <p className="text-2xl">👋</p>
          <p className="text-sm font-semibold">No connections yet</p>
          <p className="text-xs text-neutral-400 max-w-xs leading-relaxed">
            Tell the assistant you're open to meeting people — it will build a short profile and search for a match.
          </p>
        </div>
      )}

      {/* pending proposals — one at a time */}
      {proposals.length > 0 && (() => {
        const current = proposals[0]
        const rest = proposals.slice(1)

        async function handleApprove() {
          await fetch(CENTRAL_ENDPOINTS.connectionsApprove, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connection_id: current.id, user_id: userId }),
          })
          await Promise.all(rest.map((p) =>
            fetch(CENTRAL_ENDPOINTS.connectionsDecline, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ connection_id: p.id, user_id: userId }),
            })
          ))
          await load()
        }

        async function handleDecline() {
          await fetch(CENTRAL_ENDPOINTS.connectionsDecline, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connection_id: current.id, user_id: userId }),
          })
          await load()
        }

        return (
          <section className="space-y-4">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400 px-1">
              {proposals.length === 1 ? '1 proposal' : `1 of ${proposals.length} proposals`}
            </p>
            <ProposalCard
              key={current.id}
              conn={current}
              onApprove={handleApprove}
              onDecline={handleDecline}
            />
          </section>
        )
      })()}

      {/* confirmed */}
      {confirmed.length > 0 && (
        <section className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400 px-1">Connected</p>
          {confirmed.map((c) => (
            <ConnectedRow key={c.id} conn={c} onOpen={() => setThread(c)} />
          ))}
        </section>
      )}

      {/* declined — collapsed */}
      {declined.length > 0 && (
        <details className="px-1">
          <summary className="text-[11px] text-neutral-400 cursor-pointer select-none list-none flex items-center gap-1">
            <span className="text-neutral-300">▸</span>
            {declined.length} passed
          </summary>
          <div className="mt-3 space-y-2">
            {declined.map((c) => (
              <div key={c.id} className="px-4 py-3 rounded-2xl border border-neutral-100 bg-neutral-50">
                <p className="text-sm font-medium text-neutral-400">{c.other_name}</p>
                <p className="text-xs text-neutral-300 mt-0.5">{c.reason}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
