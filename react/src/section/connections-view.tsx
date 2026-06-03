import { useCallback, useEffect, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS } from '../config/server'
import GoalCard from '../components/goal-card'

/* ─── Types ────────────────────────────────────────────────────── */

interface Connection {
  id: string
  state: number  /* 0=proposed, 1=confirmed, 2=declined */
  my_approved: boolean
  their_approved: boolean
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

interface ProfileResponse {
  ok: boolean
  derived?: string
  discoverable?: boolean
  description?: string
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

/* ─── Color helpers ────────────────────────────────────────────── */

const PALETTE_HUES = [252, 338, 198, 152, 28, 286, 175, 55]

function colorFromString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  const hue = PALETTE_HUES[Math.abs(h) % PALETTE_HUES.length]
  return `hsl(${hue}, 72%, 58%)`
}

function hexOrHslToRgba(color: string, alpha: number): string {
  // For hsl colors, just put alpha in
  if (color.startsWith('hsl(')) {
    return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`)
  }
  return color
}

/* ─── Proposal bubble ──────────────────────────────────────────── */

function ProposalBubble({
  proposal, sender, at, userId, conn, onRefresh,
}: {
  proposal: ProposalMessage; sender: string; at: number
  userId: string; conn: Connection; onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const mine = sender === userId

  async function approve() {
    setBusy(true)
    try {
      const res = await fetch(CENTRAL_ENDPOINTS.journeyApproveRoot(proposal.journey_id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, proposal_id: proposal.proposal_id }),
      })
      const data = (await res.json()) as { ok: boolean; both_approved?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'approve failed')
      if (data.both_approved) {
        await fetch(SERVER_ENDPOINTS.goalCreateSharedRoot, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            journey_id: proposal.journey_id, proposal_id: proposal.proposal_id,
            title: proposal.title, extra_info: proposal.extra_info,
          }),
        })
      }
      setDone(true); await onRefresh()
    } catch (err) { console.error('[proposal] approve:', err) }
    finally { setBusy(false) }
  }

  async function decline() {
    setBusy(true)
    try {
      await fetch(CENTRAL_ENDPOINTS.journeyDeclineRoot(proposal.journey_id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, proposal_id: proposal.proposal_id }),
      })
      setDone(true); await onRefresh()
    } catch (err) { console.error('[proposal] decline:', err) }
    finally { setBusy(false) }
  }

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <GoalCard
        label="Goal proposal"
        accent="#a78bfa"
        title={proposal.title}
        description={proposal.extra_info || undefined}
        footer={
          <>
            {!mine && !done && (
              <div className="flex gap-2">
                <button disabled={busy} onClick={() => void decline()}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:border-red-700 hover:text-red-400 disabled:opacity-40">
                  Decline
                </button>
                <button disabled={busy} onClick={() => void approve()}
                  className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20 disabled:opacity-40">
                  Approve
                </button>
              </div>
            )}
            {mine && !done && <p className="text-[10px] italic text-white/40">Waiting for {conn.other_name}…</p>}
            {done && <p className="text-[10px] text-emerald-400">Done ✓</p>}
            <p className="mt-1.5 text-[10px] text-white/30">{formatTime(at)}</p>
          </>
        }
      />
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
  const myColor = colorFromString(userId)
  const theirColor = colorFromString(conn.other_id || conn.other_name)

  async function proposeRootGoal() {
    const title = proposeTitle.trim()
    if (!title) { setProposeError('Enter a goal title.'); return }
    if (!conn.other_id) { setProposeError('Partner id is missing.'); return }
    setProposeBusy(true); setProposeError(null)
    try {
      const listRes = await fetch(CENTRAL_ENDPOINTS.journeyList(userId), { cache: 'no-store' })
      const listData = (await listRes.json()) as { ok: boolean; journeys: JourneyListItem[] }
      const journey = listData.journeys?.find((j) => j.participants.some((p) => p.id === conn.other_id))
      if (!journey) { setProposeError('Shared journey not found yet.'); return }
      const res = await fetch(CENTRAL_ENDPOINTS.journeyProposeRoot(journey.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, title, extra_info: proposeExtraInfo.trim() }),
      })
      const data = (await res.json()) as { ok: boolean; id?: string; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? `propose failed (${res.status})`)
      setProposeOpen(false); setProposeTitle(''); setProposeExtraInfo('')
      await load()
    } catch (err) { setProposeError(err instanceof Error ? err.message : String(err)) }
    finally { setProposeBusy(false) }
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

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function send() {
    const t = text.trim(); if (!t) return
    setSending(true); setText('')
    try {
      await fetch(CENTRAL_ENDPOINTS.messagesSend, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: conn.id, sender_id: userId, text: t }),
      })
      await load()
    } finally { setSending(false) }
  }

  return (
    <div className="flex flex-col h-full" style={{ background: '#000' }}>
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,.08)' }}>
        <button onClick={onBack} className="flex items-center justify-center w-8 h-8 rounded-full text-white/50 hover:text-white hover:bg-white/8 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        {/* fused avatar */}
        <div className="relative w-9 h-9 shrink-0">
          <div className="absolute left-0 top-0 w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-bold text-white"
            style={{ background: myColor, borderColor: '#000' }}>
            {userId.charAt(0).toUpperCase()}
          </div>
          <div className="absolute right-0 bottom-0 w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-bold text-white"
            style={{ background: theirColor, borderColor: '#000' }}>
            {conn.other_name.charAt(0).toUpperCase()}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm leading-tight">{conn.other_name}</p>
          <p className="text-[10px] text-white/40">Connected {formatTime(conn.proposed_at)}</p>
        </div>
        <button
          className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium text-white/60 hover:text-white hover:bg-white/8 transition-colors"
          style={{ border: '1px solid rgba(255,255,255,.12)' }}
          onClick={() => { setProposeOpen((v) => !v); setProposeError(null) }}>
          {proposeOpen ? 'Cancel' : '+ Propose goal'}
        </button>
      </div>

      {/* propose drawer */}
      {proposeOpen && (
        <div className="shrink-0 px-4 py-3 space-y-2" style={{ borderBottom: '1px solid rgba(255,255,255,.08)', background: 'rgba(255,255,255,.03)' }}>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
            Propose a shared goal with {conn.other_name}
          </p>
          <input className="w-full rounded-xl px-3 py-2 text-sm outline-none bg-white/5 text-white placeholder-white/30 focus:bg-white/8"
            style={{ border: '1px solid rgba(255,255,255,.1)' }}
            placeholder="Goal title…" value={proposeTitle}
            onChange={(e) => setProposeTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !proposeBusy) { e.preventDefault(); void proposeRootGoal() } }}
            disabled={proposeBusy} autoFocus />
          <input className="w-full rounded-xl px-3 py-2 text-sm outline-none bg-white/5 text-white placeholder-white/30 focus:bg-white/8"
            style={{ border: '1px solid rgba(255,255,255,.1)' }}
            placeholder="Extra info (optional)…" value={proposeExtraInfo}
            onChange={(e) => setProposeExtraInfo(e.target.value)} disabled={proposeBusy} />
          <button className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40 transition-opacity"
            style={{ background: 'rgba(255,255,255,.1)' }}
            onClick={() => void proposeRootGoal()} disabled={proposeBusy || !proposeTitle.trim()}>
            {proposeBusy ? 'Proposing…' : 'Propose'}
          </button>
          {proposeError && <p className="text-xs text-red-400">{proposeError}</p>}
        </div>
      )}

      {/* messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {messages.length === 0 && (
          <p className="text-xs text-white/30 text-center mt-16">No messages yet. Say hi 👋</p>
        )}
        {messages.map((m, i) => {
          const proposal = parseProposal(m.text)
          if (proposal) return (
            <ProposalBubble key={i} proposal={proposal} sender={m.sender} at={m.at}
              userId={userId} conn={conn} onRefresh={load} />
          )
          const mine = m.sender === userId
          return (
            <div key={i} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
                ${mine ? 'rounded-br-sm' : 'rounded-bl-sm'}`}
                style={{ background: mine ? hexOrHslToRgba(myColor, 0.18) : 'rgba(255,255,255,.07)', border: mine ? `1px solid ${hexOrHslToRgba(myColor, 0.3)}` : '1px solid rgba(255,255,255,.08)' }}>
                <p className="text-white">{m.text}</p>
                <p className="text-[10px] mt-1 text-white/35">{formatTime(m.at)}</p>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <div className="shrink-0 px-4 py-3 flex gap-2" style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}>
        <input
          className="flex-1 rounded-full px-4 py-2.5 text-sm outline-none text-white placeholder-white/30"
          style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)' }}
          placeholder="Message…" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          disabled={sending} />
        <button
          className="rounded-full px-5 py-2.5 text-sm font-medium text-white shrink-0 disabled:opacity-30 transition-opacity"
          style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.15)' }}
          onClick={send} disabled={sending || !text.trim()}>Send</button>
      </div>
    </div>
  )
}

/* ─── Profile permission modal ─────────────────────────────────── */

function ProfilePermissionModal({
  onAllow, onDismiss, busy,
}: { onAllow: () => void; onDismiss: () => void; busy: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center pb-6 px-4"
      style={{ background: 'rgba(0,0,0,.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
      <div className="w-full max-w-sm rounded-3xl overflow-hidden"
        style={{ background: 'linear-gradient(160deg, #1a1a1a 0%, #111 100%)', border: '1px solid rgba(255,255,255,.12)' }}>
        {/* top glow accent */}
        <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg, #8b5cf6, #f43f5e)' }} />
        <div className="px-7 pt-7 pb-8">
          {/* icon */}
          <div className="mb-5 w-14 h-14 rounded-2xl flex items-center justify-center mx-auto"
            style={{ background: 'linear-gradient(135deg, rgba(139,92,246,.25), rgba(244,63,94,.2))' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="url(#pg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#8b5cf6"/><stop offset="100%" stopColor="#f43f5e"/></linearGradient></defs>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold text-white text-center mb-2">Build your match profile</h2>
          <p className="text-sm text-white/55 text-center leading-relaxed mb-1">
            To find collaborators, we'll create a brief profile from your goals and activity.
          </p>
          <p className="text-xs text-white/35 text-center leading-relaxed mb-7">
            This stays private and is only used to suggest people with aligned goals.
          </p>
          <button
            onClick={onAllow} disabled={busy}
            className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white mb-3 disabled:opacity-50 transition-opacity"
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #f43f5e)' }}>
            {busy ? 'Setting up…' : 'Allow & find matches'}
          </button>
          <button
            onClick={onDismiss} disabled={busy}
            className="w-full rounded-2xl py-3 text-sm font-medium text-white/45 hover:text-white/70 transition-colors">
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── Find-match pulse widget ───────────────────────────────────── */

function FindMatchWidget({
  matchState,
  onFind,
  onCancel,
}: {
  matchState: MatchState
  onFind: () => void
  onCancel: () => void
}) {
  if (matchState === 'searching' || matchState === 'checking') {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
        <div className="relative flex items-center justify-center mb-6">
          <div className="absolute rounded-full anim-find-3" style={{ width: 164, height: 164, border: '1px solid rgba(99,102,241,.28)' }} />
          <div className="absolute rounded-full anim-find-2" style={{ width: 120, height: 120, border: '1.5px solid rgba(99,102,241,.45)' }} />
          <div className="anim-find-1 rounded-full flex items-center justify-center" style={{ width: 76, height: 76, background: 'rgba(99,102,241,.12)', border: '2px solid rgba(99,102,241,.55)' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(165,149,255,.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
        </div>
        <p className="text-[11px] text-white/30">Looking for people with aligned goals</p>
        <button type="button" onClick={onCancel} className="mt-4 text-[11px] text-white/30 active:opacity-60 transition-opacity">
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="px-5 pt-6 pb-4">
      <button
        type="button"
        onClick={onFind}
        disabled={matchState === 'checking'}
        className="w-full rounded-2xl py-4 flex items-center justify-center gap-3 text-sm font-semibold text-white transition-all active:scale-[.98] disabled:opacity-60"
        style={{
          background: matchState === 'found' ? 'rgba(34,197,94,.18)' : 'linear-gradient(135deg, rgba(139,92,246,.22), rgba(244,63,94,.18))',
          border: matchState === 'found' ? '1px solid rgba(34,197,94,.4)' : '1px solid rgba(139,92,246,.3)',
        }}
      >
        {matchState === 'found' ? (
          <><span className="text-base">✓</span><span className="text-green-400">Refreshed!</span></>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <span>Find a match</span>
            <span className="text-white/35 text-xs font-normal">→</span>
          </>
        )}
      </button>
    </div>
  )
}

/* ─── Collab card (confirmed) ──────────────────────────────────── */

function CollabCard({ conn, userId, onOpen }: { conn: Connection; userId: string; onOpen: () => void }) {
  const myColor = colorFromString(userId)
  const theirColor = colorFromString(conn.other_id || conn.other_name)

  return (
    <button onClick={onOpen} className="w-full text-left rounded-3xl overflow-hidden transition-transform active:scale-[.98]"
      style={{ border: '1px solid rgba(255,255,255,.1)', background: '#111' }}>
      {/* gradient banner */}
      <div className="relative h-14 overflow-hidden">
        <div className="absolute inset-0"
          style={{ background: `linear-gradient(135deg, ${hexOrHslToRgba(myColor, 0.35)} 0%, transparent 45%, ${hexOrHslToRgba(theirColor, 0.35)} 100%)` }} />
        {/* shine line */}
        <div className="absolute inset-x-0 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, ${hexOrHslToRgba(myColor, 0.6)}, ${hexOrHslToRgba(theirColor, 0.6)}, transparent)` }} />
      </div>

      {/* overlapping avatars */}
      <div className="px-5 -mt-5 flex items-end gap-3">
        <div className="relative flex shrink-0">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white z-10"
            style={{ background: myColor, border: '2.5px solid #111', boxShadow: `0 0 12px ${hexOrHslToRgba(myColor, 0.4)}` }}>
            {userId.charAt(0).toUpperCase()}
          </div>
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white -ml-2"
            style={{ background: theirColor, border: '2.5px solid #111', boxShadow: `0 0 12px ${hexOrHslToRgba(theirColor, 0.4)}` }}>
            {conn.other_name.charAt(0).toUpperCase()}
          </div>
        </div>
        <div className="pb-1 min-w-0">
          <p className="font-semibold text-sm text-white leading-tight truncate">{conn.other_name}</p>
        </div>
        <div className="ml-auto pb-1 shrink-0">
          <span className="text-white/30">›</span>
        </div>
      </div>

      {/* reason */}
      <div className="px-5 pt-2.5 pb-5">
        <p className="text-[11px] text-white/45 leading-relaxed line-clamp-2">{conn.reason}</p>
        <p className="text-[10px] text-white/25 mt-1.5">{formatTime(conn.proposed_at)}</p>
      </div>
    </button>
  )
}

/* ─── Proposal card ─────────────────────────────────────────────── */

function ProposalCard({ conn, userId, onApprove, onDecline }: {
  conn: Connection; userId: string
  onApprove: () => Promise<void>; onDecline: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const theirColor = colorFromString(conn.other_id || conn.other_name)
  const myColor = colorFromString(userId)
  const waitingForThem = conn.my_approved && conn.state === STATE_PROPOSED

  async function approve() { setBusy(true); try { await onApprove() } finally { setBusy(false) } }
  async function decline() { setBusy(true); try { await onDecline() } finally { setBusy(false) } }

  return (
    <div className="w-full rounded-3xl overflow-hidden"
      style={{ border: '1px solid rgba(255,255,255,.12)', background: '#111' }}>
      {/* gradient banner */}
      <div className="relative h-20 overflow-hidden">
        <div className="absolute inset-0"
          style={{ background: `radial-gradient(ellipse at 30% 60%, ${hexOrHslToRgba(theirColor, 0.4)} 0%, transparent 65%), radial-gradient(ellipse at 70% 40%, ${hexOrHslToRgba(myColor, 0.25)} 0%, transparent 55%)` }} />
        <div className="absolute inset-x-0 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, ${hexOrHslToRgba(theirColor, 0.8)}, transparent)` }} />
      </div>

      {/* avatar */}
      <div className="px-6 -mt-6">
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-base font-bold text-white"
          style={{ background: theirColor, border: '3px solid #111', boxShadow: `0 0 20px ${hexOrHslToRgba(theirColor, 0.5)}` }}>
          {conn.other_name.charAt(0).toUpperCase()}
        </div>
      </div>

      {/* info */}
      <div className="px-6 pt-3 pb-2">
        <p className="text-xl font-bold tracking-tight text-white">{conn.other_name}</p>
        <p className="text-xs text-white/40 mt-0.5">{formatTime(conn.proposed_at)}</p>
      </div>

      {/* reason */}
      <div className="px-6 pb-5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-white/30 mb-2">Why you might click</p>
        <p className="text-sm text-white/65 leading-relaxed">{conn.reason}</p>
      </div>

      {/* divider */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,.07)' }} />

      {/* actions */}
      <div className="px-6 py-5">
        {waitingForThem ? (
          <div className="text-center py-1.5 space-y-1">
            <p className="text-sm font-semibold text-white">Request sent ✓</p>
            <p className="text-xs text-white/40">Waiting for {conn.other_name} to respond.</p>
          </div>
        ) : (
          <div className="flex gap-3">
            <button onClick={() => { void decline() }} disabled={busy}
              className="flex-1 rounded-2xl py-3.5 text-sm font-semibold text-white/45 hover:text-red-400 transition-colors disabled:opacity-40"
              style={{ border: '1.5px solid rgba(255,255,255,.1)' }}>Pass</button>
            <button onClick={() => { void approve() }} disabled={busy}
              className="flex-1 rounded-2xl py-3.5 text-sm font-semibold text-white disabled:opacity-40 transition-all hover:opacity-90"
              style={{ background: `linear-gradient(135deg, ${theirColor}, ${hexOrHslToRgba(myColor, 0.8)})` }}>Connect</button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Find match button ────────────────────────────────────────── */

type MatchState = 'idle' | 'checking' | 'searching' | 'found'

/* ─── Main view ────────────────────────────────────────────────── */

export default function ConnectionsView({ userId }: { userId: string }) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading]         = useState(true)
  const [thread, setThread]           = useState<Connection | null>(null)
  const [matchState, setMatchState]   = useState<MatchState>('idle')
  const [showPermModal, setShowPermModal] = useState(false)
  const [permBusy, setPermBusy]       = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  /* ── Match trigger ── */
  async function triggerFindMatch() {
    setMatchState('checking')
    try {
      const r = await fetch(SERVER_ENDPOINTS.profile, { cache: 'no-store' })
      const profile = (await r.json()) as ProfileResponse

      const hasProfile = profile.ok && profile.derived && profile.derived.trim().length > 0
      if (!hasProfile) {
        setMatchState('idle')
        setShowPermModal(true)
        return
      }

      await doSearch()
    } catch {
      setMatchState('idle')
    }
  }

  async function doSearch() {
    setMatchState('searching')
    try {
      await fetch(CENTRAL_ENDPOINTS.connectionsDiscoverable, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, discoverable: true }),
      })
    } catch { /* best-effort */ }

    // keep searching state for a few seconds then refresh
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      await load()
      setMatchState('found')
      setTimeout(() => setMatchState('idle'), 1200)
    }, 3500)
  }

  async function handlePermAllow() {
    setPermBusy(true)
    try {
      // Enable discovery – the backend will generate a profile if needed
      await fetch(CENTRAL_ENDPOINTS.connectionsDiscoverable, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, discoverable: true }),
      })
      setShowPermModal(false)
      await doSearch()
    } catch { /* ignore */ }
    finally { setPermBusy(false) }
  }

  if (thread) {
    return <MessageThread conn={thread} userId={userId} onBack={() => setThread(null)} />
  }

  const proposals = connections.filter((c) => c.state === STATE_PROPOSED)
  const confirmed = connections.filter((c) => c.state === STATE_CONFIRMED)
  const declined  = connections.filter((c) => c.state === STATE_DECLINED)

  if (loading) {
    return <div className="flex items-center justify-center h-full text-sm text-white/30">Loading…</div>
  }

  const empty = proposals.length === 0 && declined.length === 0

  return (
    <>
      {showPermModal && (
        <ProfilePermissionModal
          onAllow={() => void handlePermAllow()}
          onDismiss={() => setShowPermModal(false)}
          busy={permBusy} />
      )}

      {(matchState === 'searching' || matchState === 'checking') && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: '#000' }}>
          <FindMatchWidget
            matchState={matchState}
            onFind={() => { void triggerFindMatch() }}
            onCancel={() => {
              if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
              setMatchState('idle')
            }}
          />
        </div>
      )}

      <div className="overflow-y-auto h-full" style={{ background: '#000' }}>
        {/* ── Find match widget (idle/found only) ── */}
        {matchState !== 'searching' && matchState !== 'checking' && (
          <FindMatchWidget
            matchState={matchState}
            onFind={() => { void triggerFindMatch() }}
            onCancel={() => {
              if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
              setMatchState('idle')
            }}
          />
        )}

        {/* ── Empty state ── */}
        {empty && matchState !== 'searching' && (
          <div className="flex flex-col items-center justify-center py-12 px-8 text-center space-y-3">
            <div className="relative w-16 h-16 mb-2">
              <div className="absolute inset-0 rounded-full opacity-30"
                style={{ background: 'linear-gradient(135deg, #8b5cf6, #f43f5e)', filter: 'blur(10px)' }} />
              <div className="relative w-16 h-16 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.6)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
              </div>
            </div>
            <p className="text-sm font-semibold text-white/80">No connections yet</p>
            <p className="text-xs text-white/35 max-w-[220px] leading-relaxed">
              Tap "Find a match" to discover people with aligned goals.
            </p>
          </div>
        )}

        <div className="px-5 pb-10 space-y-8">
          {/* ── Proposals ── */}
          {proposals.length > 0 && (() => {
            const current = proposals[0]
            const rest = proposals.slice(1)

            async function handleApprove() {
              await fetch(CENTRAL_ENDPOINTS.connectionsApprove, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connection_id: current.id, user_id: userId }),
              })
              await Promise.all(rest.map((p) =>
                fetch(CENTRAL_ENDPOINTS.connectionsDecline, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ connection_id: p.id, user_id: userId }),
                })
              ))
              await load()
            }

            async function handleDecline() {
              await fetch(CENTRAL_ENDPOINTS.connectionsDecline, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connection_id: current.id, user_id: userId }),
              })
              await load()
            }

            return (
              <section className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-white/35">
                    {proposals.length === 1 ? '1 match found' : `${proposals.length} matches found`}
                  </p>
                  {proposals.length > 1 && (
                    <p className="text-[10px] text-white/25">{proposals.length - 1} more</p>
                  )}
                </div>
                <ProposalCard key={current.id} conn={current} userId={userId}
                  onApprove={handleApprove} onDecline={handleDecline} />
              </section>
            )
          })()}

          {/* ── Past collaborators (declined / ended) ── */}
          {declined.length > 0 && (
            <section className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-white/35 px-1">
                Past collaborators
              </p>
              {declined.map((c) => (
                <div key={c.id} className="px-4 py-3 rounded-2xl"
                  style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)' }}>
                  <p className="text-sm font-semibold text-white/55">{c.other_name}</p>
                  {c.reason && <p className="text-xs text-white/25 mt-0.5 line-clamp-2">{c.reason}</p>}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </>
  )
}
