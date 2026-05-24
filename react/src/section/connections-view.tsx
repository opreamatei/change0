import { useCallback, useEffect, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS } from '../config/server'

interface Connection {
  id: string
  state: number  /* 0=proposed, 1=confirmed, 2=declined */
  my_approved: boolean
  their_approved: boolean
  other_name: string
  reason: string
  proposed_at: number
}

interface Message {
  sender: string
  at: number
  text: string
}

const STATE_PROPOSED  = 0
const STATE_CONFIRMED = 1
const STATE_DECLINED  = 2

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/* ─── Message thread ───────────────────────────────────────────── */

function MessageThread({ conn, userId, onBack }: { conn: Connection; userId: string; onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null)

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
        <div>
          <p className="font-semibold text-sm">{conn.other_name}</p>
          <p className="text-[10px] text-neutral-400">Connected {formatTime(conn.proposed_at)}</p>
        </div>
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {messages.length === 0 && (
          <p className="text-xs text-neutral-400 text-center mt-12">No messages yet. Say hi.</p>
        )}
        {messages.map((m, i) => {
          const mine = m.sender === userId
          return (
            <div key={i} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
                ${mine ? 'bg-black text-white rounded-br-sm' : 'bg-neutral-100 text-black rounded-bl-sm'}`}>
                <p>{m.text}</p>
                <p className={`text-[10px] mt-1 ${mine ? 'text-neutral-400' : 'text-neutral-400'}`}>{formatTime(m.at)}</p>
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
  userId,
  onApprove,
  onDecline,
}: {
  conn: Connection
  userId: string
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
              userId={userId}
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
