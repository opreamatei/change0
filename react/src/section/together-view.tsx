import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS } from '../config/server'
import { openUserProfile } from '../profile-nav'
import { PathCanvas } from '../components/path-canvas'
import type { PathNodeData, NodeState } from '../components/path-canvas'
import { SwipeDeck } from '../components/swipe-deck'
import GoalTipsCard from '../components/goal-tips-card'
import ConnectionsView from './connections-view'
import ReviewsPanel from './reviews-panel'
import { ViewedProfilePanel } from './settings-view'
import type { FocusTarget } from './focus-session'
import type { JournalFocusActions } from './journal-focus-session'

/* ─── Onboarding ─────────────────────────────────────────────────────────── */

const OB_KEY = 'collab_ob_v1'
type OBPhase = 'question' | 'declined' | 'finding' | 'active'

// Minimal connection shape needed for the match card
interface OBConnection {
  id: string
  state: number
  other_id: string
  other_name: string
  reason: string
  proposed_at: number
  my_approved: boolean
}

const PALETTE_HUES_OB = [252, 338, 198, 152, 28, 286, 175, 55]
function colorFromStringOB(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  const hue = PALETTE_HUES_OB[Math.abs(h) % PALETTE_HUES_OB.length]
  return `hsl(${hue}, 72%, 58%)`
}
function hslToRgba(color: string, alpha: number): string {
  if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`)
  return color
}

/* ─── Screen: Întrebare ──────────────────────────────────────────────────── */

// Kept for an upcoming flow; exported so it isn't flagged as an unused local.
export function CollabReadyScreen({ onReady }: { onReady: () => void }) {
  const [phase, setPhase] = useState<'question' | 'push' | 'bye'>('question')
  const [countdown, setCountdown] = useState(6)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 40)
    return () => clearTimeout(t)
  }, [])

  // (push phase kept for extensibility but no longer used in the flow)

  // Countdown in bye → back to question
  useEffect(() => {
    if (phase !== 'bye') return
    if (countdown <= 0) { setPhase('question'); setCountdown(6); return }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown])

  if (phase === 'push') {
    return (
      <div className="h-full flex flex-col items-center justify-center px-8 text-center relative overflow-hidden" style={{ background: '#0a0a0a' }}>
        <div className="absolute inset-0 pointer-events-none" style={{
          background: 'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(239,68,68,.06) 0%, transparent 70%)',
        }} />
        <div className="relative z-10 flex flex-col items-center max-w-xs">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
            style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <h2 className="text-[26px] font-bold tracking-tight mb-4">Further together</h2>
          <p className="text-[14px] leading-[1.7]" style={{ color: 'rgba(255,255,255,.38)' }}>
            People who collaborate go twice as far. You're closer to this decision than you think.
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'bye') {
    const DURATION = 6
    const pct = (DURATION - countdown) / DURATION
    const r = 26
    const circ = 2 * Math.PI * r
    return (
      <div className="h-full flex flex-col items-center justify-center px-8 text-center" style={{ background: '#0a0a0a' }}>
        <div className="relative mb-8">
          <svg width="64" height="64" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="3" />
            <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="3"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - pct)}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 1s linear' }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-[15px] font-bold" style={{ color: 'rgba(255,255,255,.55)' }}>
            {countdown}
          </div>
        </div>
        <h2 className="text-[24px] font-bold tracking-tight mb-3">All good</h2>
        <p className="text-[14px] leading-[1.65]" style={{ color: 'rgba(255,255,255,.38)' }}>
          Come back when you feel ready.
        </p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col items-center justify-center relative overflow-hidden" style={{ background: '#0a0a0a' }}>
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse 72% 52% at 50% 30%, rgba(99,102,241,.11) 0%, rgba(99,102,241,.03) 55%, transparent 75%)',
        opacity: visible ? 1 : 0, transition: 'opacity 1.1s ease',
      }} />
      <div className="relative z-10 flex flex-col items-center px-8 text-center w-full max-w-xs" style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(16px)',
        transition: 'all .55s cubic-bezier(.32,1,.54,1)',
      }}>
        <div className="text-[10px] font-bold tracking-[0.24em] uppercase mb-9" style={{ color: 'rgba(255,255,255,.25)' }}>
          Collaboration
        </div>
        <h1 className="text-[38px] font-extrabold tracking-tight leading-[1.07] mb-5">
          Are you ready<br />for this?
        </h1>
        <p className="text-[14px] leading-[1.65] mb-11" style={{ color: 'rgba(255,255,255,.36)' }}>
          The right person transforms your goal into a mission. Built on trust and mutual respect.
        </p>
        <div className="flex gap-3 w-full">
          <button onClick={() => setPhase('bye')}
            className="flex-1 py-[16px] rounded-[18px] text-[15px] font-semibold active:opacity-70 transition-opacity"
            style={{ background: 'rgba(255,255,255,.06)', color: 'rgba(255,255,255,.5)', border: '1px solid rgba(255,255,255,.09)' }}>
            Not yet
          </button>
          <button onClick={onReady}
            className="flex-1 py-[16px] rounded-[18px] text-[16px] font-bold tracking-tight active:opacity-80 transition-opacity"
            style={{ background: '#fff', color: '#000' }}>
            I'm ready!
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── Profile sheet: partener potențial ─────────────────────────────────── */

// Superseded by the shared openUserProfile flow; kept (exported) for reference.
export function PartnerProfileSheet({
  conn, color, onClose,
}: {
  conn: OBConnection
  color: string
  onClose: () => void
}) {
  const [journeyCount, setJourneyCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch(CENTRAL_ENDPOINTS.journeyList(conn.other_id), { cache: 'no-store' })
        if (r.ok) {
          const data = (await r.json()) as { ok: boolean; journeys: { id: string }[] }
          if (!cancelled && data.ok) setJourneyCount(data.journeys?.length ?? 0)
        }
      } catch { /* ignore */ }
    }
    void load()
    return () => { cancelled = true }
  }, [conn.other_id])

  const initial = conn.other_name.charAt(0).toUpperCase()

  return (
    <div className="fixed inset-0 z-[400] flex flex-col anim-pg-in" style={{ background: '#0a0a0a' }}>
      {/* back button — absolute, over the banner */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-[52px] left-5 z-10 w-9 h-9 rounded-xl flex items-center justify-center active:opacity-70"
        style={{ background: 'rgba(10,10,10,.55)', border: '1px solid rgba(255,255,255,.14)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      {/* colour banner */}
      <div className="relative flex-shrink-0" style={{ height: 200 }}>
        <div className="absolute inset-0" style={{
          background: `radial-gradient(ellipse at 50% 80%, ${hslToRgba(color, 0.55)} 0%, ${hslToRgba(color, 0.18)} 55%, transparent 80%)`,
        }} />
        <div className="absolute inset-x-0 bottom-0 h-24" style={{
          background: 'linear-gradient(to bottom, transparent, #0a0a0a)',
        }} />
      </div>

      {/* avatar — centered, overlapping banner bottom */}
      <div className="flex flex-col items-center -mt-[56px] flex-shrink-0 px-5 z-10">
        <div
          className="w-28 h-28 rounded-[28px] flex items-center justify-center text-[#0a0a0a] text-[38px] font-bold overflow-hidden flex-shrink-0"
          style={{ background: color, boxShadow: `0 0 0 4px #0a0a0a, 0 8px 32px ${hslToRgba(color, 0.35)}` }}
        >
          <img
            src={CENTRAL_ENDPOINTS.userAvatar(conn.other_id)}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            className="w-full h-full object-cover"
            alt=""
          />
          <span>{initial}</span>
        </div>
        <h2 className="mt-4 text-[24px] font-extrabold tracking-tight">{conn.other_name}</h2>
        <p className="mt-1 text-[13px]" style={{ color: 'rgba(255,255,255,.35)' }}>Potential partner</p>

        {/* stats chips */}
        <div className="mt-5 flex items-center gap-3">
          <div
            className="flex items-center gap-2 px-4 py-2.5 rounded-[14px]"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.09)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span className="text-[13px] font-semibold">
              {journeyCount === null
                ? <span style={{ color: 'rgba(255,255,255,.3)' }}>—</span>
                : <><span className="text-white">{journeyCount}</span><span style={{ color: 'rgba(255,255,255,.4)' }}> {journeyCount === 1 ? 'journey' : 'journeys'}</span></>
              }
            </span>
          </div>
        </div>
      </div>

      {/* reason */}
      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pt-8 pb-10">
        <div
          className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(255,255,255,.28)' }}
        >
          Why we matched you
        </div>
        <p className="text-[15px] leading-[1.75]" style={{ color: 'rgba(255,255,255,.62)' }}>
          {conn.reason}
        </p>
      </div>
    </div>
  )
}

/* ─── Card: Partener găsit ───────────────────────────────────────────────── */

function CollabMatchCard({
  conn, cardIn, busy,
  onConfirm, onNotNow,
}: {
  conn: OBConnection; userId: string; cardIn: boolean; busy: boolean
  onConfirm: () => void; onNotNow: () => void
}) {
  const [profileOpen, setProfileOpen] = useState(false)
  const color = colorFromStringOB(conn.other_id || conn.other_name)

  return (
    <div className="h-full flex flex-col items-center justify-center px-5" style={{ background: '#0a0a0a' }}>

      {/* Card — bannerless, centred, minimal */}
      <div
        className="w-full max-w-[320px] rounded-3xl px-6 pt-8 pb-6 flex flex-col items-center text-center"
        style={{
          background: 'rgba(255,255,255,.04)',
          border: '1px solid rgba(255,255,255,.08)',
          opacity: cardIn ? 1 : 0,
          transform: cardIn ? 'translateY(0) scale(1)' : 'translateY(24px) scale(.97)',
          transition: 'opacity .45s cubic-bezier(.32,1,.54,1), transform .45s cubic-bezier(.32,1,.54,1)',
        }}
      >
        {/* Avatar — centred, tappable */}
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          className="relative active:scale-95 transition-transform"
        >
          <div
            className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-[#0a0a0a] text-[24px] font-bold overflow-hidden"
            style={{ background: color }}
          >
            <img
              src={CENTRAL_ENDPOINTS.userAvatar(conn.other_id)}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
              className="h-full w-full object-cover" alt=""
            />
            <span>{conn.other_name.charAt(0).toUpperCase()}</span>
          </div>
          <div
            className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center"
            style={{ background: '#1a1a1a', border: '1.5px solid rgba(255,255,255,.12)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
            </svg>
          </div>
        </button>

        <div className="mt-4 text-[18px] font-bold tracking-tight">{conn.other_name}</div>
        <div className="mt-0.5 text-[11px]" style={{ color: 'rgba(255,255,255,.3)' }}>Potential partner</div>

        <p
          className="mt-4 text-[13px] leading-[1.6]"
          style={{
            color: 'rgba(255,255,255,.45)',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {conn.reason}
        </p>

        <div className="mt-6 flex w-full gap-2.5">
          <button
            type="button"
            onClick={onNotNow}
            disabled={busy}
            className="flex-1 py-[13px] rounded-[16px] text-[14px] font-semibold active:opacity-70 transition-opacity disabled:opacity-40"
            style={{ background: 'rgba(255,255,255,.06)', color: 'rgba(255,255,255,.55)', border: '1px solid rgba(255,255,255,.08)' }}
          >
            Not now
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-[1.6] py-[13px] rounded-[16px] text-[15px] font-bold active:opacity-80 transition-opacity disabled:opacity-40"
            style={{ background: '#fff', color: '#000' }}
          >
            Connect
          </button>
        </div>
      </div>

      {profileOpen && createPortal(
        <ViewedProfilePanel
          person={{ id: conn.other_id, display_name: conn.other_name, color }}
          onClose={() => setProfileOpen(false)}
        />,
        document.body,
      )}
    </div>
  )
}

/* ─── Screen: Căutare ────────────────────────────────────────────────────── */

function CollabFindingScreen({
  userId, onConfirm, onNotNow, onBack, autoStart,
}: {
  userId: string
  onConfirm: (conn?: OBConnection) => void
  onNotNow: () => void
  onBack: () => void
  autoStart?: boolean
}) {
  const [started, setStarted] = useState(autoStart ?? false)
  const [phase, setPhase] = useState<'searching' | 'found' | 'notfound'>('searching')
  const [foundConn, setFoundConn] = useState<OBConnection | null>(null)
  const [cardIn, setCardIn] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!started) return
    let cancelled = false
    async function search() {
      try {
        await fetch(CENTRAL_ENDPOINTS.connectionsDiscoverable, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, discoverable: true }),
        })
      } catch { /* best-effort */ }

      await new Promise((r) => setTimeout(r, 3500))
      if (cancelled) return

      try {
        const r = await fetch(CENTRAL_ENDPOINTS.connections(userId), { cache: 'no-store' })
        if (r.ok) {
          const data = (await r.json()) as { ok: boolean; connections: OBConnection[] }
          if (data.ok && data.connections) {
            const proposals = data.connections.filter((c) => c.state === 0)
            if (proposals.length > 0 && !cancelled) {
              setFoundConn(proposals[0])
              setPhase('found')
              setTimeout(() => setCardIn(true), 80)
              return
            }
          }
        }
      } catch { /* ignore */ }

      if (!cancelled) setPhase('notfound')
    }
    void search()
    return () => { cancelled = true }
  }, [started, userId])

  async function handleConfirm() {
    if (!foundConn || busy) return
    setBusy(true)
    try {
      await fetch(CENTRAL_ENDPOINTS.connectionsApprove, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: foundConn.id, user_id: userId }),
      })
    } catch { /* advance anyway */ }
    onConfirm(foundConn)
  }

  async function handleNotNow() {
    if (!foundConn || busy) return
    setBusy(true)
    try {
      await fetch(CENTRAL_ENDPOINTS.connectionsDecline, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: foundConn.id, user_id: userId }),
      })
    } catch { /* ignore */ }
    onNotNow()
  }

  if (phase === 'found' && foundConn) {
    return (
      <CollabMatchCard
        conn={foundConn} userId={userId} cardIn={cardIn} busy={busy}
        onConfirm={() => void handleConfirm()}
        onNotNow={() => void handleNotNow()}
      />
    )
  }

  if (phase === 'notfound') {
    return (
      <div className="h-full flex flex-col items-center justify-center relative px-8 text-center" style={{ background: '#0a0a0a' }}>
        <div className="absolute inset-0 pointer-events-none" style={{
          background: 'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(99,102,241,.07) 0%, transparent 70%)',
        }} />
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6 relative z-10"
          style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <h2 className="text-[22px] font-bold mb-3 relative z-10">Still searching</h2>
        <p className="text-[14px] leading-[1.65] mb-10 relative z-10" style={{ color: 'rgba(255,255,255,.35)' }}>
          No match found yet. We'll notify you as soon as someone comes up.
        </p>
        <button onClick={() => onConfirm()}
          className="w-full py-[18px] rounded-[18px] text-[16px] font-bold mb-3 active:opacity-80 transition-opacity relative z-10"
          style={{ background: '#fff', color: '#000' }}>
          Enter anyway
        </button>
        <button onClick={onBack}
          className="text-[13px] active:opacity-40 transition-opacity relative z-10"
          style={{ color: 'rgba(255,255,255,.25)' }}>
          ← Back
        </button>
      </div>
    )
  }

  if (!started) {
    return (
      <div className="h-full flex flex-col items-center justify-center relative overflow-hidden" style={{ background: '#0a0a0a' }}>
        <div className="absolute inset-0 pointer-events-none" style={{
          background: 'radial-gradient(ellipse 60% 44% at 50% 44%, rgba(99,102,241,.10) 0%, transparent 70%)',
        }} />
        <button onClick={onBack} className="absolute cursor-pointer active:opacity-70 transition-opacity flex items-center justify-center"
          style={{ top: 52, left: 20, width: 36, height: 36, borderRadius: 12, background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="relative z-10 flex flex-col items-center px-8 text-center max-w-xs">
          <div className="relative flex items-center justify-center mb-9">
            <div className="absolute rounded-full" style={{ width: 120, height: 120, border: '1px solid rgba(99,102,241,.2)' }} />
            <div className="absolute rounded-full" style={{ width: 84, height: 84, border: '1.5px solid rgba(99,102,241,.32)' }} />
            <div className="w-[52px] h-[52px] rounded-full flex items-center justify-center"
              style={{ background: 'rgba(99,102,241,.12)', border: '2px solid rgba(99,102,241,.55)' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(165,149,255,.85)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
          </div>
          <h2 className="text-[26px] font-extrabold tracking-tight mb-3">Find a partner</h2>
          <p className="text-[14px] leading-[1.65] mb-10" style={{ color: 'rgba(255,255,255,.36)' }}>
            We match on drive, ambitions and passions — people you'll find yourself truly resonating with.
          </p>
          <button onClick={() => setStarted(true)}
            className="w-full py-[18px] rounded-[18px] text-[16px] font-bold tracking-tight active:opacity-80 transition-opacity"
            style={{ background: '#fff', color: '#000' }}>
            Find partner
          </button>
        </div>
      </div>
    )
  }

  // Searching state
  return (
    <div className="h-full flex flex-col items-center justify-center relative" style={{ background: '#0a0a0a' }}>
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(99,102,241,.09) 0%, transparent 70%)',
      }} />
      <button onClick={onBack} className="absolute cursor-pointer active:opacity-70 transition-opacity flex items-center justify-center"
        style={{ top: 52, left: 20, width: 36, height: 36, borderRadius: 12, background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <div className="relative flex items-center justify-center mb-10">
        <div className="absolute rounded-full anim-find-3" style={{ width: 164, height: 164, border: '1px solid rgba(99,102,241,.28)' }} />
        <div className="absolute rounded-full anim-find-2" style={{ width: 120, height: 120, border: '1.5px solid rgba(99,102,241,.45)' }} />
        <div className="w-[76px] h-[76px] rounded-full flex items-center justify-center anim-find-1"
          style={{ background: 'rgba(99,102,241,.12)', border: '2px solid rgba(99,102,241,.6)' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(165,149,255,.85)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </div>
      </div>
      <div className="text-[16px] font-semibold tracking-tight mb-2 text-center px-8 leading-[1.5]" style={{ color: 'rgba(255,255,255,.85)' }}>We're doing our best to find the perfect match for you</div>
    </div>
  )
}

/* ─── Overlay: Inactiv ───────────────────────────────────────────────────── */

function CollabLobbyScreen({
  onFindMatch, onOpenReviews, onResetCollab,
}: {
  onFindMatch: () => void
  onOpenReviews?: () => void
  onResetCollab?: () => void
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { const t = setTimeout(() => setVisible(true), 40); return () => clearTimeout(t) }, [])
  return (
    <div
      className="h-full flex flex-col relative overflow-hidden"
      style={{ background: '#0a0a0a', opacity: visible ? 1 : 0, transition: 'opacity .3s ease' }}
    >
      {/* top bar */}
      <div className="absolute top-0 left-0 right-0 pt-12 pb-4 px-5 flex items-center justify-between z-10">
        <h1 className="text-[28px] font-bold tracking-tight text-white">Collab</h1>
        {(onOpenReviews || onResetCollab) && (
          <div className="flex items-center gap-2">
            {onResetCollab && <ResetCollabButton onClick={onResetCollab} />}
            {onOpenReviews && <ReviewsButton onClick={onOpenReviews} />}
          </div>
        )}
      </div>

      {/* centered content */}
      <div className="flex-1 flex flex-col items-center justify-center">
        {/* pulse rings + button in the middle */}
        <div className="relative flex items-center justify-center">
          {/* outer rings */}
          <div className="absolute rounded-full anim-find-3" style={{ width: 220, height: 220, border: '1px solid rgba(99,102,241,.2)' }} />
          <div className="absolute rounded-full anim-find-2" style={{ width: 160, height: 160, border: '1.5px solid rgba(99,102,241,.32)' }} />
          <div className="absolute rounded-full anim-find-1" style={{ width: 112, height: 112, background: 'rgba(99,102,241,.07)', border: '1.5px solid rgba(99,102,241,.45)' }} />
          {/* button sits on top of the innermost ring */}
          <button
            type="button"
            onClick={onFindMatch}
            className="lobby-find-btn relative z-10 flex flex-col items-center justify-center active:scale-95 transition-transform"
            style={{
              width: 88,
              height: 88,
              borderRadius: '50%',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              border: 'none',
              boxShadow: '0 4px 24px rgba(99,102,241,.55)',
              lineHeight: 1.3,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mb-1.5">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Find
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── Chat sheet (direct message with collab partner) ────────────────────── */

interface CollabMessage { sender: string; at: number; text?: string; content?: string }

interface ChatProposal {
  _type: 'proposal'
  proposal_id: string
  journey_id: string
  title: string
  extra_info: string
}

// Special chat payloads arrive as a JSON string; everything else is plain text.
function parseChatProposal(raw: string | undefined): ChatProposal | null {
  if (!raw || !raw.startsWith('{')) return null
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (obj._type === 'proposal') return obj as unknown as ChatProposal
  } catch { /* not JSON — plain message */ }
  return null
}

function ChatProposalBubble({
  proposal, mine, at, userId, otherName, onRefresh,
}: {
  proposal: ChatProposal
  mine: boolean
  at: number
  userId: string
  otherName: string
  onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

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

  const when = new Date(at * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[82%] rounded-2xl p-4" style={{ background: 'rgba(167,139,250,.10)', border: '1px solid rgba(167,139,250,.3)' }}>
        <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'rgba(167,139,250,.9)' }}>Goal proposal</p>
        <p className="mt-1 text-sm font-semibold text-white">{proposal.title}</p>
        {proposal.extra_info && <p className="mt-0.5 text-xs leading-relaxed text-white/55">{proposal.extra_info}</p>}
        {!mine && !done && (
          <div className="mt-3 flex gap-2">
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
        {mine && !done && <p className="mt-2 text-[10px] italic text-white/40">Waiting for {otherName}…</p>}
        {done && <p className="mt-2 text-[10px] text-emerald-400">Done ✓</p>}
        <p className="mt-1.5 text-[10px] text-white/30">{when}</p>
      </div>
    </div>
  )
}

function CollabChatSheet({
  conn, userId, onClose,
}: {
  conn: OBConnection
  userId: string
  onClose: () => void
}) {
  const [messages, setMessages] = useState<CollabMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadMessages = useCallback(async () => {
    try {
      const r = await fetch(CENTRAL_ENDPOINTS.messages(conn.id), { cache: 'no-store' })
      if (r.ok) {
        const data = (await r.json()) as { ok: boolean; messages: CollabMessage[] }
        if (data.ok) setMessages(data.messages ?? [])
      }
    } catch { /* ignore */ }
  }, [conn.id])

  useEffect(() => {
    void loadMessages()
    const id = setInterval(loadMessages, 3000)
    return () => clearInterval(id)
  }, [loadMessages])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function send() {
    const t = text.trim()
    if (!t || sending) return
    setText('')
    const optimistic: CollabMessage = { sender: userId, at: Date.now() / 1000, content: t, text: t }
    setMessages((prev) => [...prev, optimistic])
    setSending(true)
    try {
      await fetch(CENTRAL_ENDPOINTS.messagesSend, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: conn.id, sender_id: userId, content: t }),
      })
      await loadMessages()
    } catch { /* ignore */ }
    finally { setSending(false) }
  }

  return (
    <div className="fixed inset-0 z-[500] flex flex-col anim-pg-in" style={{ background: 'var(--bg)' }}>
      <div className="px-5 pt-12 pb-4 flex items-center gap-3.5 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        <button onClick={onClose}
          className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center flex-shrink-0 active:opacity-70"
          style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="text-base font-bold tracking-tight">{conn.other_name}</div>
      </div>
      <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 flex flex-col gap-2">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: 'rgba(255,255,255,.3)' }}>No messages yet</div>
        )}
        {messages.map((msg, i) => {
          const isMe = msg.sender === userId
          const proposal = parseChatProposal(msg.content ?? msg.text)
          if (proposal) return (
            <ChatProposalBubble key={i} proposal={proposal} mine={isMe} at={msg.at}
              userId={userId} otherName={conn.other_name} onRefresh={loadMessages} />
          )
          return (
            <div key={i} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[78%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                style={isMe
                  ? { background: '#fff', color: '#000', borderBottomRightRadius: 6 }
                  : { background: 'rgba(255,255,255,.09)', color: '#fff', borderBottomLeftRadius: 6 }}>
                {msg.content ?? msg.text}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
      <div className="flex-shrink-0 px-4 pb-10 pt-3 flex gap-2 items-end"
        style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          rows={1}
          placeholder="Message…"
          className="flex-1 resize-none rounded-2xl px-4 py-3 text-sm outline-none no-scrollbar"
          style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)', color: '#fff', maxHeight: 100 }}
        />
        <button onClick={() => void send()} disabled={!text.trim() || sending}
          className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center disabled:opacity-40 active:opacity-70 transition-opacity"
          style={{ background: '#fff', color: '#000' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

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
        {mine && (leaf.tips ? (
          <div className="mb-3">
            <GoalTipsCard tips={leaf.tips} compact />
          </div>
        ) : leaf.extra_info && <p className="mb-3 text-sm leading-relaxed text-white/55">{leaf.extra_info}</p>)}
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
  const [chatConn, setChatConn] = useState<OBConnection | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatLoading, setChatLoading] = useState(false)
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

  async function openChat() {
    setChatOpen(true)
    if (chatConn) return
    setChatLoading(true)
    try {
      const r = await fetch(CENTRAL_ENDPOINTS.connections(userId), { cache: 'no-store' })
      if (r.ok) {
        const data = (await r.json()) as { ok: boolean; connections: OBConnection[] }
        if (data.ok && data.connections) {
          const partner = summary.participants.find((p) => p.id !== userId)
          const conn = data.connections.find((c) => c.other_id === partner?.id)
          if (conn) setChatConn(conn)
        }
      }
    } catch { /* ignore */ }
    finally { setChatLoading(false) }
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
      extraInfo: mine ? (leaf.extra_info || undefined) : undefined,
      tips: mine ? (leaf.tips || undefined) : undefined,
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
    <>
    <div className="flex flex-col h-full relative">
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

      {/* Chat FAB — bottom right, above nav */}
      <button
        type="button"
        onClick={() => void openChat()}
        className="absolute flex items-center justify-center active:scale-95 transition-transform"
        style={{ bottom: 'calc(var(--nav-h) + 16px)', right: 20, width: 50, height: 50, borderRadius: '50%', background: '#fff', color: '#000', boxShadow: '0 4px 20px rgba(0,0,0,.6)', zIndex: 30 }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>

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
    {chatOpen && createPortal(
      chatConn
        ? <CollabChatSheet conn={chatConn} userId={userId} onClose={() => setChatOpen(false)} />
        : (
          <div className="fixed z-[500] flex flex-col items-center justify-center gap-3"
            style={{
              bottom: 124, right: 16,
              width: 'min(360px, calc(100vw - 32px))',
              height: 120,
              background: '#111',
              border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 24,
              boxShadow: '0 8px 40px rgba(0,0,0,.7)',
            }}>
            <div className="text-sm" style={{ color: 'rgba(255,255,255,.35)' }}>
              {chatLoading ? 'Connecting…' : 'Chat unavailable'}
            </div>
            <button onClick={() => setChatOpen(false)}
              className="text-xs active:opacity-70"
              style={{ color: 'rgba(255,255,255,.25)' }}>
              Close
            </button>
          </div>
        ),
      document.body
    )}
    </>
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

interface PortalNode {
  title: string; state: 'done' | 'active' | 'idle'; isCurrent: boolean
  absIdx: number; tintColor?: string
}

/* Mini canvas that mirrors the exact PathCanvas visual — dashed bezier edges,
 * filled/outlined/pulsing circles, star glyphs for done nodes, labels below. */
function MiniPathPreview({ nodes, cardW }: { nodes: PortalNode[]; cardW: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef<number | null>(null)
  const H = 168

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !cardW || nodes.length === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width  = Math.round(cardW * dpr)
    canvas.height = Math.round(H * dpr)

    const n = nodes.length
    // Match PathCanvas proportions exactly: PATH_NR=32, PATH_SY=150
    // Scale so node + spacing ratio is identical to the full view.
    const R      = 17
    const SY     = R * (150 / 32)   // ≈ 80 — same R:step ratio as PathCanvas
    const spread = Math.min(cardW * 0.27, 96)   // exact PathCanvas formula
    // Anchor the focus node at vertical center; neighbours fall above/below,
    // naturally clipped by the card's overflow-hidden — same as scrolling the
    // full path to focus position.
    const anchor = nodes.findIndex((nd) => nd.isCurrent)
    const fIdx   = anchor >= 0 ? anchor : Math.floor(n / 2)

    // Mirrored vertically: earlier nodes sit at the bottom, later at the top —
    // identical to PathCanvas where you scroll upward as you progress.
    const posOf = (i: number) => ({
      x: cardW / 2 + spread * Math.sin(nodes[i].absIdx * Math.PI / 2),
      y: H / 2 - (i - fIdx) * SY,
    })

    function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, or_: number) {
      const ir = or_ * 0.42
      ctx.beginPath()
      for (let k = 0; k < 10; k++) {
        const a = k * Math.PI / 5 - Math.PI / 2
        ctx.lineTo(cx + Math.cos(a) * (k % 2 === 0 ? or_ : ir), cy + Math.sin(a) * (k % 2 === 0 ? or_ : ir))
      }
      ctx.closePath()
    }

    function ha(hex: string, a: number): string {
      const v = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')
      return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex + v : hex
    }

    function draw() {
      const ctx = canvas!.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cardW, H)
      const now = performance.now()

      /* ── edges ── */
      ctx.lineCap = 'round'
      const gs = R / 32
      ctx.setLineDash([6 * gs, 9 * gs])
      for (let i = 0; i < n - 1; i++) {
        const a = posOf(i), b = posOf(i + 1)
        const dy = b.y - a.y
        const bright = nodes[i].state === 'done' && (nodes[i + 1].state === 'done' || nodes[i + 1].state === 'active')
        const tA = nodes[i].tintColor, tB = nodes[i + 1].tintColor
        ctx.lineWidth = 4 * gs
        if (tA || tB) {
          const ca = tA ?? tB ?? '#fff', cb = tB ?? tA ?? '#fff'
          const al = bright ? 0.80 : 0.28
          const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
          g.addColorStop(0, ha(ca, al)); g.addColorStop(1, ha(cb, al))
          ctx.strokeStyle = g
        } else {
          ctx.strokeStyle = bright ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.13)'
        }
        // a is below b (earlier node at bottom) — mirror of PathCanvas direction
        ctx.beginPath()
        ctx.moveTo(a.x, a.y - R)
        ctx.bezierCurveTo(a.x, a.y + dy * 0.42, b.x, b.y - dy * 0.42, b.x, b.y + R)
        ctx.stroke()
      }
      ctx.setLineDash([])

      /* ── nodes ── */
      for (let i = 0; i < n; i++) {
        const nd = nodes[i]
        const { x, y } = posOf(i)
        const t = nd.tintColor

        if (nd.state === 'active') {
          const p = 0.5 + 0.5 * Math.sin(now / 700)
          ctx.beginPath(); ctx.arc(x, y, R + 5 + p * 3, 0, Math.PI * 2)
          ctx.strokeStyle = t ? ha(t, 0.18 + p * 0.14) : `rgba(255,255,255,${0.18 + p * 0.14})`
          ctx.lineWidth = 2; ctx.stroke()
          ctx.beginPath(); ctx.arc(x, y, R + 14 + p * 5, 0, Math.PI * 2)
          ctx.strokeStyle = t ? ha(t, 0.07 + p * 0.05) : `rgba(255,255,255,${0.07 + p * 0.05})`
          ctx.lineWidth = 1.5; ctx.stroke()
        }

        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2)
        if (nd.state === 'done') {
          ctx.fillStyle = t ?? '#fff'; ctx.fill()
          ctx.beginPath(); ctx.arc(x, y, R + 2.5, 0, Math.PI * 2)
          ctx.strokeStyle = t ? ha(t, 0.20) : 'rgba(255,255,255,0.10)'
          ctx.lineWidth = 2.5; ctx.stroke()
        } else if (nd.state === 'active') {
          ctx.fillStyle = t ?? '#fff'; ctx.fill()
        } else {
          ctx.fillStyle = '#1a1a1a'; ctx.fill()
          ctx.strokeStyle = t ? ha(t, 0.40) : 'rgba(255,255,255,0.22)'
          ctx.lineWidth = 2; ctx.stroke()
        }

        const gs = R / 32   // same gscale as PathCanvas
        if (nd.state === 'done') {
          const sc = t && t !== '#ffffff' ? '#fff' : '#000'
          starPath(ctx, x, y, 12 * gs)
          ctx.fillStyle = sc; ctx.fill()
          ctx.lineJoin = 'round'; ctx.lineCap = 'round'
          ctx.lineWidth = 3 * gs; ctx.strokeStyle = sc; ctx.stroke()
          ctx.lineJoin = 'miter'; ctx.lineCap = 'butt'
        } else {
          ctx.font = `bold ${Math.round(22 * gs)}px ui-sans-serif,system-ui,-apple-system,sans-serif`
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillStyle = nd.state === 'active'
            ? (t && t !== '#ffffff' ? '#fff' : '#000')
            : t ? ha(t, 0.73) : 'rgba(255,255,255,0.38)'
          ctx.fillText(String(nd.absIdx + 1), x, y + 1)
        }

        // no labels in the mini preview — nodes only
      }

      if (nodes.some((nd) => nd.state === 'active')) rafRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  }, [nodes, cardW])

  return <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
}

function JourneyPortalCard({
  journey, index, onSelect,
}: {
  journey: JourneyListItem
  index: number
  onSelect: (idx: number) => void
}) {
  const cardRef = useRef<HTMLButtonElement>(null)
  const [cardW, setCardW] = useState(0)
  const [nodes, setNodes] = useState<PortalNode[]>([])
  const [fetched, setFetched] = useState(false)

  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    function measure() { if (el) setCardW(Math.floor(el.getBoundingClientRect().width)) }
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch(CENTRAL_ENDPOINTS.journey(journey.id), { cache: 'no-store' })
        if (!r.ok || cancelled) return
        const data = (await r.json()) as JourneyDetail
        const gm = new Map<number, JourneyGoal>(data.goals.map((g) => [g.localIndex, g]))
        const leaves: JourneyGoal[] = []
        for (const g of data.goals) {
          if (g.parent !== 0) continue
          leaves.push(...collectLeavesInOrder(g, gm))
        }
        if (cancelled || leaves.length === 0) return
        let fi = leaves.findIndex((l) => l.start_date && !l.end_date)
        if (fi < 0) { for (let i = leaves.length - 1; i >= 0; i--) { if (leaves[i].end_date) { fi = i; break } } }
        if (fi < 0) fi = leaves.findIndex((l) => !l.start_date)
        if (fi < 0) fi = 0
        const start = Math.max(0, fi - 1)
        const slice = leaves.slice(start, start + 3)
        setNodes(slice.map((l, i) => ({
          title: l.title,
          state: (l.start_date && l.end_date ? 'done' : l.start_date ? 'active' : 'idle') as PortalNode['state'],
          isCurrent: start + i === fi,
          absIdx: start + i,
          tintColor: l.assigned_to !== UNASSIGNED && l.assigned_to >= 0 && l.assigned_to < data.users.length
            ? (data.users[l.assigned_to]?.color || PARTICIPANT_COLORS[l.assigned_to % PARTICIPANT_COLORS.length])
            : undefined,
        })))
      } catch { /* ignore */ }
      finally { if (!cancelled) setFetched(true) }
    }
    void load()
    return () => { cancelled = true }
  }, [journey.id])

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={() => onSelect(index)}
      className="anim-entry-in group relative w-full overflow-hidden text-left active:scale-[0.985] transition-transform"
      style={{ height: 168, animationDelay: `${index * 60}ms`, background: '#000' }}
    >
      {/* live path preview */}
      {fetched && nodes.length > 0 && cardW > 0
        ? <>
            <div className="absolute inset-0" style={{ background: journeyGradient(journey.id), opacity: 0.32 }} />
            <MiniPathPreview nodes={nodes} cardW={cardW} />
          </>
        : !fetched
          ? (
            <div className="absolute inset-0 flex flex-col justify-center gap-2.5 px-5" style={{ paddingTop: 44, paddingBottom: 52 }}>
              {[75, 55, 65].map((w, i) => (
                <div key={i} className="h-[18px] rounded-full" style={{ width: `${w}%`, background: 'rgba(255,255,255,.06)' }} />
              ))}
            </div>
          ) : (
            <>
              <div className="absolute inset-0" style={{ background: journeyGradient(journey.id) }} />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,.78) 0%, rgba(0,0,0,.15) 55%, transparent 100%)' }} />
            </>
          )
      }

      {/* edge fades on all sides — blend card into page black */}
      {/* vignette lateral stânga/dreapta */}
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 80% 200% at 50% 50%, transparent 55%, #000 100%)' }} />
      {/* vignette sus/jos */}
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 200% 65% at 50% 50%, transparent 50%, #000 100%)' }} />

      {/* top: chevron affordance */}
      <div className="absolute top-4 right-5 z-10">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full transition-transform group-hover:translate-x-0.5"
          style={{ background: 'rgba(255,255,255,.92)', color: '#000' }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </div>

      {/* bottom: avatars + goal count */}
      <div className="absolute bottom-0 left-0 right-0 px-5 pb-4 z-10">
        <div className="flex items-center gap-3">
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

function ResetCollabButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Restart collab onboarding"
      className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center transition-transform active:scale-95"
      style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)', color: 'rgba(255,255,255,.45)' }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </svg>
    </button>
  )
}

function ReviewsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center rounded-xl bg-white px-3.5 py-2 text-[13px] font-semibold text-black shadow-sm transition-transform active:scale-95"
    >
      Reviews
    </button>
  )
}

function JourneysContent({
  journeys, loading, error, onSelect, onOpenReviews, onFindMatch, onResetCollab,
}: {
  journeys: JourneyListItem[]
  loading: boolean
  error: string | null
  onSelect: (idx: number) => void
  onOpenReviews: () => void
  onFindMatch: () => void
  onResetCollab: () => void
}) {
  if (loading && journeys.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-white/40">
        Loading shared journeys…
      </div>
    )
  }

  if (journeys.length === 0) {
    return <CollabLobbyScreen onFindMatch={onFindMatch} onOpenReviews={onOpenReviews} onResetCollab={onResetCollab} />
  }

  return (
    <section className="w-full pt-[62px] pb-8">
      <header className="mb-6 flex items-start justify-between gap-3 px-5">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-white">Collab</h1>
        </div>
        <div className="pt-1.5 flex items-center gap-2">
          <ResetCollabButton onClick={onResetCollab} />
          <ReviewsButton onClick={onOpenReviews} />
        </div>
      </header>
      <div className="flex flex-col">
        {journeys.map((j, i) => (
          <JourneyPortalCard key={j.id} journey={j} index={i} onSelect={onSelect} />
        ))}
      </div>
      {error && <p className="mt-4 text-xs text-red-400 px-5">{error}</p>}
    </section>
  )
}

/* ─── main together view ─────────────────────────────────────────────────── */

export default function TogetherView({ userId, onOpenFocus, onOpenJournal }: { userId: string; onOpenFocus: (target: FocusTarget) => void; onOpenJournal: (props: JournalFocusActions) => void }) {
  const [ob, setOb] = useState<OBPhase | null>(null)
  const [autoStartFinding, setAutoStartFinding] = useState(false)
  const [postMatchConn, setPostMatchConn] = useState<OBConnection | null>(null)
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
      if (data.ok) {
        setJourneys(data.journeys)
        setError(null)
      }
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

  const obKey = `${OB_KEY}_${userId}`

  useEffect(() => {
    if (!userId) return
    setOb('active')   // show journeys immediately; find-match available via button
  }, [userId])

  const advance = (to: OBPhase) => {
    setOb(to)
    if (to !== 'finding') localStorage.setItem(obKey, to)
  }

  if (ob === null) return <div className="h-full" style={{ background: '#0a0a0a' }} />
  if (ob === 'finding') return (
    <CollabFindingScreen
      userId={userId}
      autoStart={autoStartFinding}
      onConfirm={() => { advance('active') }}
      onNotNow={() => advance('declined')}
      onBack={() => advance('question')}
    />
  )

  return (
    <>
    <div className="flex flex-col h-full overflow-hidden relative">
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
            onFindMatch={() => { setAutoStartFinding(true); advance('finding') }}
            onResetCollab={() => { localStorage.removeItem(obKey); advance('question') }}
          />
        </div>
      )}

      {/* People FAB — hidden when journey detail is open or no journeys yet */}
      {!journeyOpen && journeys.length > 0 && (
        <button
          type="button"
          onClick={() => setPeopleOpen(true)}
          className="fixed z-[99] flex items-center justify-center"
          style={{
            bottom: 124, right: 20,
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
          background: '#000',
          transform: peopleOpen ? 'translateX(0)' : 'translateX(100%)',
        }}
      >
        <div
          className="px-5 pt-[62px] pb-4 flex items-center gap-3.5 flex-shrink-0"
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
        <div className="flex-1 overflow-hidden relative">
          {peopleOpen && <ConnectionsView userId={userId} />}
        </div>
      </div>
    </div>

    <ReviewsPanel open={reviewsOpen} onClose={() => setReviewsOpen(false)} userId={userId} />

    {/* Post-match direct chat — rendered via portal to escape any stacking context */}
    {postMatchConn && createPortal(
      <CollabChatSheet
        conn={postMatchConn}
        userId={userId}
        onClose={() => setPostMatchConn(null)}
      />,
      document.body,
    )}
    </>
  )
}
