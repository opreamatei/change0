import { useEffect, useRef, useState } from 'react'

/**
 * A self-contained, full-screen focus session. Both the solo journey view and
 * the collab view describe the goal they want to work as a `FocusTarget` and
 * hand it to a shared `FocusSession` — the renderer is identical regardless of
 * where the goal lives, only the start/complete callbacks differ.
 */
export interface FocusTarget {
  id: string
  title: string
  extraInfo?: string
  tips?: string
  requiredTimeSeconds: number
  state: 'idle' | 'active' | 'done'
  isMystery?: boolean
  canStart: boolean
  pending?: boolean
  accent?: string
  rootProgressPct?: number
  onStart?: () => void
  onComplete?: () => void
  /** Abandon an in-progress session — resets the goal to idle on the server. */
  onCancel?: () => void
  onExtend?: () => void
  onReshape?: () => void
  onRepair?: (reason: string) => void
  onOpen?: () => void
}

const DOIT_R = 90
const DOIT_CIRC = 2 * Math.PI * DOIT_R
const HOLD_MS = 800

const RUNNING_COLOR = '#ff9f0a'
const DONE_COLOR = '#30d158'

function fmtClock(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

// Pre-computed spark vectors for the completion burst — radial fan with a little
// per-ring variance so it reads organic rather than a rigid starburst.
const SPARKS = Array.from({ length: 16 }, (_, i) => {
  const angle = (i / 16) * Math.PI * 2
  const dist = 96 + (i % 3) * 30
  return {
    dx: Math.round(Math.cos(angle) * dist),
    dy: Math.round(Math.sin(angle) * dist),
    delay: (i % 5) * 18,
    size: i % 4 === 0 ? 7 : 5,
  }
})

function RepairSheet({
  title, onSubmit, onClose,
}: { title: string; onSubmit: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div className="fixed inset-0 z-[260] flex items-end justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-t-3xl border-t border-[#2a2a2a] bg-[#111] px-6 py-6 pb-10">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-white/40">Repair</p>
        <p className="mb-4 text-sm font-semibold text-white">{title}</p>
        <input
          ref={inputRef}
          type="text"
          className="w-full rounded-xl border border-[#333] bg-[#1a1a1a] px-4 py-3 text-sm text-white placeholder-white/30 focus:border-amber-700 focus:outline-none"
          placeholder="What needs to change?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim()) { onSubmit(reason.trim()); onClose() } }}
        />
        <div className="mt-3 flex gap-2">
          <button type="button" className="flex-1 rounded-xl border border-[#333] py-2.5 text-sm text-white/55 hover:bg-[#1a1a1a]" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!reason.trim()}
            className="flex-1 rounded-xl border border-amber-800 bg-amber-950/30 py-2.5 text-sm font-semibold text-amber-400 disabled:opacity-40"
            onClick={() => { if (reason.trim()) { onSubmit(reason.trim()); onClose() } }}>Submit</button>
        </div>
      </div>
    </div>
  )
}

type Phase = 'enter' | 'active' | 'celebrate' | 'exit'

export default function FocusSession({
  target, onClose,
}: {
  target: FocusTarget
  onClose: () => void
}) {
  const { title, tips, state: nodeState, isMystery, canStart, pending, rootProgressPct } = target
  const accent = target.accent

  // Session length comes from the goal's estimate, clamped to a sane focus window.
  const sessionLen = target.requiredTimeSeconds > 0
    ? Math.min(Math.max(target.requiredTimeSeconds, 60), 90 * 60)
    : 25 * 60

  const [remaining, setRemaining] = useState(sessionLen)
  const [elapsed, setElapsed] = useState(0) // total seconds the timer has run, across extensions
  const [running, setRunning] = useState(false)
  const [localStarted, setLocalStarted] = useState(false)
  const [repairOpen, setRepairOpen] = useState(false)
  const [giveUp, setGiveUp] = useState(false)
  const [phase, setPhase] = useState<Phase>('enter')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedRef = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Goal is "active" once it was already running, or once we kick it off locally
  // this session (props only refresh after the server round-trips).
  const effectiveState: 'idle' | 'active' | 'done' =
    nodeState === 'idle' && localStarted ? 'active' : nodeState
  const effectiveStateRef = useRef(effectiveState)
  useEffect(() => { effectiveStateRef.current = effectiveState }, [effectiveState])

  // entrance — flip to interactive on the next frame so the in-animation plays
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase((p) => (p === 'enter' ? 'active' : p)))
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  // countdown
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (!running) return
    timerRef.current = setInterval(() => {
      setRemaining((r) => { if (r <= 1) { setRunning(false); return 0 } return r - 1 })
      setElapsed((e) => e + 1)
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [running])

  const isComplete = remaining === 0
  // Reshape is the "really stuck" escape hatch — only offer it once the user has
  // spent at least 50% more than the goal's allotted time (i.e. deep in overtime).
  const canReshape = elapsed >= sessionLen * 1.5
  const isCelebrating = phase === 'celebrate'
  // An already-completed goal shows a full green circle (not an empty ring).
  const progress = (isCelebrating || effectiveState === 'done') ? 1 : (sessionLen - remaining) / sessionLen
  const color =
    effectiveState === 'done' || isCelebrating || isComplete ? DONE_COLOR :
    running ? (accent ?? RUNNING_COLOR) : 'rgba(255,255,255,0.55)'
  const dashOffset = DOIT_CIRC * (1 - progress)
  const dotAngle = progress * 2 * Math.PI
  const dotX = 115 + DOIT_R * Math.cos(dotAngle)
  const dotY = 115 + DOIT_R * Math.sin(dotAngle)

  const closeOut = () => {
    if (phase === 'exit') return
    setRunning(false)
    setPhase('exit')
    closeTimer.current = setTimeout(onClose, 340)
  }

  // Completion: register on the server, play the burst, then sail back to the map.
  const celebrate = () => {
    if (phase === 'celebrate' || phase === 'exit') return
    setRunning(false)
    setPhase('celebrate')
    target.onComplete?.()
    closeTimer.current = setTimeout(() => {
      setPhase('exit')
      closeTimer.current = setTimeout(onClose, 360)
    }, 1150)
  }

  const startSession = () => {
    if (startedRef.current) return
    startedRef.current = true
    setLocalStarted(true)
    target.onStart?.()
    setRunning(true)
  }

  // A goal only starts and ends — there is no pause. Tapping starts an idle
  // goal or closes a finished one; while running, a tap does nothing (hold to
  // complete). When the timer runs out the user extends or reshapes below.
  const toggle = () => {
    if (phase !== 'active') return
    if (effectiveState === 'done') { closeOut(); return }
    if (!startedRef.current && effectiveState === 'idle' && canStart && !isMystery) {
      startSession()
      return
    }
  }

  // hold gesture — start when idle, complete when active
  const [holdProgress, setHoldProgress] = useState(0)
  const holdingRef = useRef(false)
  const holdInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const holdDelay = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdStart = useRef(0)

  const cancelHold = () => {
    if (holdDelay.current) { clearTimeout(holdDelay.current); holdDelay.current = null }
    if (holdInterval.current) { clearInterval(holdInterval.current); holdInterval.current = null }
    holdingRef.current = false
    setHoldProgress(0)
  }
  const onDown = () => {
    if (phase !== 'active') return
    if (effectiveStateRef.current === 'done') return
    holdDelay.current = setTimeout(() => {
      holdingRef.current = true
      holdStart.current = Date.now()
      holdInterval.current = setInterval(() => {
        const p = Math.min((Date.now() - holdStart.current) / HOLD_MS, 1)
        setHoldProgress(p)
        if (p >= 1) {
          cancelHold()
          const st = effectiveStateRef.current
          if (st === 'active') {
            celebrate()
          } else if (st === 'idle' && canStart && !isMystery) {
            startSession()
          }
        }
      }, 30)
    }, 180)
  }
  const onUp = () => {
    const wasHolding = holdingRef.current
    cancelHold()
    if (!wasHolding) toggle()
  }
  useEffect(() => () => cancelHold(), [])

  const holdDashOffset = DOIT_CIRC * (1 - holdProgress)
  const isHolding = holdProgress > 0
  const ringLabel = isCelebrating ? 'Complete'
    : isHolding ? (effectiveState === 'active' ? 'Complete…' : 'Starting…')
    : effectiveState === 'done' ? 'Done'
    : isComplete ? "Time's up"
    : running ? 'Focus'
    : effectiveState === 'active' ? 'Focus' : 'Start'

  const hint = isCelebrating ? null
    : effectiveState === 'idle' ? 'Tap or hold to start'
    : isComplete ? 'Extend or reshape below — or hold to complete'
    : 'Hold to complete'

  return (
    <>
      <div
        className={`fixed inset-0 z-[210] flex flex-col items-center justify-center ${phase === 'exit' ? 'focus-page-out' : 'focus-page-in'}`}
        style={{ background: '#000000' }}
      >
        {/* close */}
        <button
          type="button"
          onClick={() => (running || (progress > 0 && !isComplete)) && effectiveState !== 'done' ? setGiveUp(true) : closeOut()}
          className="absolute top-[52px] right-5 flex h-9 w-9 items-center justify-center rounded-full"
          style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.1)', color: 'rgba(255,255,255,.6)', opacity: isCelebrating ? 0 : 1, transition: 'opacity .3s ease' }}
          aria-label="Close"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="flex w-full max-w-[360px] flex-col items-center px-8">
          <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-[.7px]" style={{ color: 'rgba(255,255,255,.3)' }}>
            {title}
          </div>
          {rootProgressPct !== undefined && !isCelebrating && (
            <div className="mb-5 flex w-full items-center gap-2.5">
              <div className="h-[3px] flex-1 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,.08)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${rootProgressPct}%`, background: 'rgba(255,255,255,.35)' }}
                />
              </div>
              <span className="shrink-0 tabular-nums text-[10px]" style={{ color: 'rgba(255,255,255,.3)' }}>
                {rootProgressPct}%
              </span>
            </div>
          )}
          {tips && !isCelebrating && (
            <div className="mb-7 max-w-[290px] text-center text-[13px] leading-[1.55]" style={{ color: 'rgba(255,255,255,.5)' }}>
              {tips}
            </div>
          )}

          {isMystery ? (
            <p className="mb-8 max-w-[280px] text-center text-sm italic text-violet-300/60">
              Too long to do in one go — it'll split into smaller steps when you reach it.
            </p>
          ) : (
            <div
              onPointerDown={onDown}
              onPointerUp={onUp}
              onPointerLeave={cancelHold}
              onPointerCancel={cancelHold}
              className="relative mb-10 flex-shrink-0 select-none"
              style={{ width: 230, height: 230, cursor: isCelebrating ? 'default' : 'pointer', touchAction: 'none' }}
            >
              {/* completion burst */}
              {isCelebrating && (
                <>
                  <span className="focus-shock pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ width: 180, height: 180, border: `2px solid ${DONE_COLOR}` }} />
                  <span className="focus-shock2 pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ width: 180, height: 180, background: `radial-gradient(circle, ${DONE_COLOR}55 0%, transparent 70%)` }} />
                  {SPARKS.map((s, i) => (
                    <span key={i} className="focus-spark pointer-events-none absolute left-1/2 top-1/2 rounded-full"
                      style={{
                        width: s.size, height: s.size, marginLeft: -s.size / 2, marginTop: -s.size / 2,
                        background: DONE_COLOR, animationDelay: `${s.delay}ms`,
                        ['--dx' as string]: `${s.dx}px`, ['--dy' as string]: `${s.dy}px`,
                      }} />
                  ))}
                </>
              )}

              <svg viewBox="0 0 230 230" className="absolute inset-0 h-full w-full" style={{ transform: 'rotate(-90deg)' }}>
                <circle cx="115" cy="115" r={DOIT_R} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="11" />
                <circle cx="115" cy="115" r={DOIT_R} fill="none" stroke={color} strokeWidth="11" strokeLinecap="round"
                  strokeDasharray={DOIT_CIRC} strokeDashoffset={dashOffset}
                  style={{ transition: isCelebrating ? 'stroke-dashoffset .45s cubic-bezier(.16,1,.3,1), stroke .3s ease' : 'stroke-dashoffset .8s linear, stroke .3s ease' }} />
                {!isCelebrating && effectiveState !== 'done' && (
                  <circle cx={dotX} cy={dotY} r="6" fill={color} style={{ transition: 'cx .8s linear, cy .8s linear, fill .3s ease' }} />
                )}
                {/* White hold ring last → always paints above the orange ring/dot (grey track stays underneath). */}
                {holdProgress > 0 && (
                  <circle cx="115" cy="115" r={DOIT_R} fill="none" stroke="rgba(255,255,255,.92)" strokeWidth="11"
                    strokeLinecap="round" strokeDasharray={DOIT_CIRC} strokeDashoffset={holdDashOffset} />
                )}
              </svg>

              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
                {isCelebrating || effectiveState === 'done' ? (
                  <div className="focus-pop flex flex-col items-center gap-2">
                    <svg width="74" height="74" viewBox="0 0 24 24" fill="none">
                      <path className="focus-check" d="M5 12.5l4.2 4.3L19 7.2" stroke={DONE_COLOR} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                ) : (
                  <div className="text-[44px] font-bold leading-none" style={{ letterSpacing: '-2px', color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtClock(remaining)}
                  </div>
                )}
                <div className="text-[11px] font-bold uppercase tracking-[.12em]" style={{ color: isHolding ? 'rgba(255,255,255,.9)' : color }}>
                  {ringLabel}
                </div>
              </div>
            </div>
          )}

          {!isMystery && !isCelebrating && effectiveState !== 'done' && hint && (
            <p className="mb-4 text-center text-[11px] text-white/30">{hint}</p>
          )}

          {!isCelebrating && (
            <div className="flex items-center gap-4 text-[13px]">
              {isComplete && effectiveState !== 'done' && target.onExtend && (
                <button type="button" disabled={pending} onClick={() => { target.onExtend?.(); setRemaining((r) => r + 5 * 60); setRunning(true) }} className="text-sky-400/70 hover:text-sky-400 disabled:opacity-40">+5 min</button>
              )}
              {effectiveState !== 'done' && canReshape && target.onReshape && (
                <button type="button" disabled={pending} onClick={() => target.onReshape?.()} className="text-amber-400/70 hover:text-amber-400 disabled:opacity-40">Reshape</button>
              )}
              {effectiveState !== 'done' && canReshape && !target.onReshape && target.onRepair && (
                <button type="button" disabled={pending} onClick={() => setRepairOpen(true)} className="text-amber-400/70 hover:text-amber-400 disabled:opacity-40">Repair</button>
              )}
            </div>
          )}
        </div>
      </div>

      {giveUp && (
        <div className="fixed inset-0 z-[255] flex items-end" style={{ background: 'rgba(0,0,0,.7)' }} onClick={() => setGiveUp(false)}>
          <div className="w-full px-5 pt-7 pb-11" style={{ background: '#1a1a1a', borderRadius: '20px 20px 0 0' }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-center text-[17px] font-bold text-white">Stop this session?</div>
            <div className="mb-7 text-center text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,.4)' }}>
              Your timer progress for this session will be lost.
            </div>
            <button type="button" onClick={() => { setGiveUp(false); target.onCancel?.(); closeOut() }}
              className="mb-2.5 w-full rounded-2xl p-4 text-[15px] font-bold text-white" style={{ background: '#c0392b' }}>
              Stop
            </button>
            <button type="button" onClick={() => setGiveUp(false)}
              className="w-full rounded-2xl p-4 text-[15px] font-semibold" style={{ background: 'rgba(255,255,255,.07)', color: 'rgba(255,255,255,.7)' }}>
              Keep going
            </button>
          </div>
        </div>
      )}

      {repairOpen && target.onRepair && (
        <RepairSheet title={title} onSubmit={(r) => target.onRepair?.(r)} onClose={() => setRepairOpen(false)} />
      )}
    </>
  )
}
