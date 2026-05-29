import { useEffect, useMemo, useRef, useState } from 'react'
import {
  findGoalByGlobalIndex,
  getRootGoals,
  Goal,
  inferGoalState,
  isLeafGoal,
} from '../goal'
import { PathCanvas } from '../components/path-canvas'
import type { PathNodeData, NodeState } from '../components/path-canvas'
import { SwipeDeck } from '../components/swipe-deck'

const LEAF_DECOMP_THRESHOLD_SECONDS = 60 * 16 * 2

export interface CurrentGoalsViewProps {
  goals: Goal[]
  pendingGoalIndex: number | null
  statusMessage: string
  onNavigate: (goalId: string) => void
  onStartGoal: (goal: Goal) => void
  onEndGoal: (goal: Goal) => void
  onRepairGoal: (goal: Goal, reason: string) => void
}

interface PathNode extends PathNodeData {
  goal: Goal
  canStart: boolean
}

function collectLeavesInOrder(root: Goal, goals: Goal[]): Goal[] {
  const out: Goal[] = []
  const visit = (g: Goal) => {
    if (g.subgoals.length === 0) { out.push(g); return }
    for (const idx of g.subgoals) {
      const child = findGoalByGlobalIndex(goals, idx)
      if (child) visit(child)
    }
  }
  visit(root)
  return out
}

interface JourneyData {
  root: Goal
  pathNodes: PathNode[]
  focusIdx: number
  doneCount: number
  knownCount: number
  mysteryCount: number
}

// Build the path nodes for a single journey (one root goal's subtree).
function buildJourneyData(root: Goal, goals: Goal[]): JourneyData {
  const leaves = collectLeavesInOrder(root, goals)
  const pathNodes: PathNode[] = []
  let num = 1
  let firstStartableAssigned = false
  let mysteryCount = 0
  let prevParentIndex: number | null | undefined = undefined

  for (const g of leaves) {
    if (!isLeafGoal(g)) continue
    const state = inferGoalState(g)
    const nodeState: NodeState =
      state === 'finished' ? 'done' :
      state === 'started'  ? 'active' :
      'idle'
    const isMystery = nodeState === 'idle' && g.requiredTime >= LEAF_DECOMP_THRESHOLD_SECONDS
    if (isMystery) { mysteryCount++; continue }
    const canStart = nodeState === 'idle' && !firstStartableAssigned
    if (canStart) firstStartableAssigned = true

    const chapterTitle = g.parent !== prevParentIndex && g.parent !== null
      ? findGoalByGlobalIndex(goals, g.parent)?.title
      : undefined
    prevParentIndex = g.parent

    pathNodes.push({
      key: g.localIndex,
      title: g.title,
      goal: g,
      nodeState,
      num: num++,
      canStart,
      isMystery: false,
      chapterTitle,
    })
  }

  let focusIdx = pathNodes.findIndex((nd) => nd.nodeState === 'active')
  if (focusIdx < 0) {
    for (let i = pathNodes.length - 1; i >= 0; i--) {
      if (pathNodes[i].nodeState === 'done') { focusIdx = i; break }
    }
  }
  if (focusIdx < 0) focusIdx = pathNodes.findIndex((nd) => nd.nodeState === 'idle')

  const doneCount = pathNodes.filter((nd) => nd.nodeState === 'done').length
  const knownCount = pathNodes.filter((nd) => !nd.isMystery).length

  return { root, pathNodes, focusIdx, doneCount, knownCount, mysteryCount }
}

function RepairSheet({
  goal, onSubmit, onClose,
}: { goal: Goal; onSubmit: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-t-3xl border-t border-[#2a2a2a] bg-[#111] px-6 py-6 pb-10">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-white/40">Repair</p>
        <p className="mb-4 text-sm font-semibold text-white">{goal.title}</p>
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

const DOIT_R = 90
const DOIT_CIRC = 2 * Math.PI * DOIT_R
const HOLD_MS = 800

function fmtClock(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

// Full-screen "do it" timer — tapping a goal drops you straight into a focus
// session. Tap the ring to start/pause, hold it to mark the goal complete.
function DoItScreen({
  node, pendingGoalIndex, onNavigate, onStartGoal, onEndGoal, onRepairGoal, onClose,
}: {
  node: PathNode
  pendingGoalIndex: number | null
  onNavigate: (goalId: string) => void
  onStartGoal: (goal: Goal) => void
  onEndGoal: (goal: Goal) => void
  onRepairGoal: (goal: Goal, reason: string) => void
  onClose: () => void
}) {
  const { goal, nodeState, isMystery, canStart } = node
  const isPending = pendingGoalIndex === goal.localIndex

  // Session length comes from the goal's estimate, clamped to a sane focus window.
  const sessionLen = goal.requiredTime > 0 ? Math.min(Math.max(goal.requiredTime, 60), 90 * 60) : 25 * 60

  const [remaining, setRemaining] = useState(sessionLen)
  const [running, setRunning] = useState(false)
  const [repairOpen, setRepairOpen] = useState(false)
  const [giveUp, setGiveUp] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (!running) return
    timerRef.current = setInterval(() => {
      setRemaining((r) => { if (r <= 1) { setRunning(false); return 0 } return r - 1 })
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [running])

  const isComplete = remaining === 0
  const progress = (sessionLen - remaining) / sessionLen
  const color = nodeState === 'done' ? '#30d158' : isComplete ? '#30d158' : running ? '#ff9f0a' : 'rgba(255,255,255,0.55)'
  const dashOffset = DOIT_CIRC * (1 - progress)
  const dotAngle = progress * 2 * Math.PI
  const dotX = 115 + DOIT_R * Math.cos(dotAngle)
  const dotY = 115 + DOIT_R * Math.sin(dotAngle)

  const toggle = () => {
    if (nodeState === 'done') { onClose(); return }
    if (!startedRef.current && nodeState === 'idle' && canStart && !isMystery) {
      startedRef.current = true
      onStartGoal(goal)
    }
    if (isComplete) { setRemaining(sessionLen); setRunning(true); return }
    setRunning((r) => !r)
  }

  // hold-to-complete
  const [holdProgress, setHoldProgress] = useState(0)
  const [holding, setHolding] = useState(false)
  const holdInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const holdDelay = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdStart = useRef(0)

  const cancelHold = () => {
    if (holdDelay.current) { clearTimeout(holdDelay.current); holdDelay.current = null }
    if (holdInterval.current) { clearInterval(holdInterval.current); holdInterval.current = null }
    setHolding(false); setHoldProgress(0)
  }
  const onDown = () => {
    if (nodeState === 'done') return
    holdDelay.current = setTimeout(() => {
      setHolding(true)
      holdStart.current = Date.now()
      holdInterval.current = setInterval(() => {
        const p = Math.min((Date.now() - holdStart.current) / HOLD_MS, 1)
        setHoldProgress(p)
        if (p >= 1) {
          cancelHold()
          onEndGoal(goal)
          onClose()
        }
      }, 30)
    }, 180)
  }
  const onUp = () => {
    const wasHolding = holding
    cancelHold()
    if (!wasHolding) toggle()
  }
  useEffect(() => () => cancelHold(), [])

  const holdDashOffset = DOIT_CIRC * (1 - holdProgress)
  const ringLabel = holding ? 'Hold…'
    : nodeState === 'done' ? 'Done'
    : isComplete ? 'Restart'
    : running ? 'Pause'
    : nodeState === 'active' ? 'Resume' : 'Start'

  return (
    <>
      <div className="fixed inset-0 z-[210] flex flex-col items-center justify-center" style={{ background: '#000000' }}>
        {/* close */}
        <button
          type="button"
          onClick={() => (running || progress > 0) && nodeState !== 'done' ? setGiveUp(true) : onClose()}
          className="absolute top-[52px] right-5 flex h-9 w-9 items-center justify-center rounded-full"
          style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.1)', color: 'rgba(255,255,255,.6)' }}
          aria-label="Close"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="flex w-full max-w-[360px] flex-col items-center px-8">
          <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-[.7px]" style={{ color: 'rgba(255,255,255,.3)' }}>
            {goal.title}
          </div>
          {goal.extraInfo && (
            <div className="mb-7 max-w-[290px] text-center text-[13px] leading-[1.55]" style={{ color: 'rgba(255,255,255,.5)' }}>
              {goal.extraInfo}
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
              style={{ width: 230, height: 230, cursor: 'pointer', touchAction: 'none' }}
            >
              <svg viewBox="0 0 230 230" className="absolute inset-0 h-full w-full" style={{ transform: 'rotate(-90deg)' }}>
                <circle cx="115" cy="115" r={DOIT_R} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="11" />
                <circle cx="115" cy="115" r={DOIT_R} fill="none" stroke={color} strokeWidth="11" strokeLinecap="round"
                  strokeDasharray={DOIT_CIRC} strokeDashoffset={dashOffset}
                  style={{ transition: 'stroke-dashoffset .8s linear, stroke .3s ease' }} />
                {holdProgress > 0 && (
                  <circle cx="115" cy="115" r={DOIT_R} fill="none" stroke="rgba(255,255,255,.92)" strokeWidth="11"
                    strokeLinecap="round" strokeDasharray={DOIT_CIRC} strokeDashoffset={holdDashOffset} />
                )}
                <circle cx={dotX} cy={dotY} r="6" fill={color} style={{ transition: 'cx .8s linear, cy .8s linear, fill .3s ease' }} />
              </svg>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
                <div className="text-[44px] font-bold leading-none" style={{ letterSpacing: '-2px', color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtClock(remaining)}
                </div>
                <div className="text-[11px] font-bold uppercase tracking-[.12em]" style={{ color: holding ? 'rgba(255,255,255,.9)' : color }}>
                  {ringLabel}
                </div>
              </div>
            </div>
          )}

          {!isMystery && nodeState !== 'done' && (
            <p className="mb-4 text-center text-[11px] text-white/30">Tap to {running ? 'pause' : 'start'} · hold to complete</p>
          )}

          <div className="flex items-center gap-4 text-[13px]">
            <button type="button" onClick={() => { onNavigate(goal.id); onClose() }} className="text-white/45 hover:text-white/70">Open</button>
            {nodeState !== 'done' && (
              <button type="button" disabled={isPending} onClick={() => setRepairOpen(true)} className="text-amber-400/70 hover:text-amber-400 disabled:opacity-40">Repair</button>
            )}
          </div>
        </div>
      </div>

      {giveUp && (
        <div className="fixed inset-0 z-[215] flex items-end" style={{ background: 'rgba(0,0,0,.7)' }} onClick={() => setGiveUp(false)}>
          <div className="w-full px-5 pt-7 pb-11" style={{ background: '#1a1a1a', borderRadius: '20px 20px 0 0' }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-center text-[17px] font-bold text-white">Stop this session?</div>
            <div className="mb-7 text-center text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,.4)' }}>
              Your timer progress for this session will be lost.
            </div>
            <button type="button" onClick={() => { setGiveUp(false); onClose() }}
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

      {repairOpen && (
        <RepairSheet goal={goal} onSubmit={(r) => onRepairGoal(goal, r)} onClose={() => setRepairOpen(false)} />
      )}
    </>
  )
}

export default function CurrentGoalsView({
  goals, pendingGoalIndex, statusMessage,
  onNavigate, onStartGoal, onEndGoal, onRepairGoal,
}: CurrentGoalsViewProps) {
  const [selected, setSelected] = useState<PathNode | null>(null)
  const [current, setCurrent] = useState(0)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [dim, setDim] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    function measure() {
      if (!el) return
      const rect = el.getBoundingClientRect()
      setDim({
        w: Math.max(280, Math.floor(rect.width)),
        h: Math.max(300, Math.floor(rect.height)),
      })
    }
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    window.addEventListener('resize', measure)
    return () => { obs.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  const journeys = useMemo(
    () => getRootGoals(goals).map((root) => buildJourneyData(root, goals)),
    [goals],
  )

  // Keep the active index in range as journeys load / change.
  useEffect(() => {
    if (current > journeys.length - 1) setCurrent(Math.max(0, journeys.length - 1))
  }, [journeys.length, current])

  const activeJourney = journeys[current]

  if (journeys.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 pb-24 text-center">
        <p className="text-sm text-white/30">{statusMessage || 'No journeys yet.'}</p>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      {/* Full-screen path canvas */}
      <div ref={wrapperRef} className="absolute inset-0">
        {dim.w > 0 && dim.h > 0 && (
          <SwipeDeck
            count={journeys.length}
            index={current}
            onIndexChange={setCurrent}
            className="h-full"
            renderSlide={(i) => {
              // Render only the visible slide and its immediate neighbours so we
              // never run more than three PathCanvas instances at once.
              if (Math.abs(i - current) > 1) return null
              const j = journeys[i]
              return (
                <PathCanvas
                  nodes={j.pathNodes}
                  width={dim.w}
                  height={dim.h}
                  hasMysteryZone={j.mysteryCount > 0}
                  initialFocusIdx={j.focusIdx}
                  onSelect={(idx) => setSelected(j.pathNodes[idx] ?? null)}
                />
              )
            }}
          />
        )}
      </div>

      {/* Floating header — overlays the top of the full-screen canvas */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-end justify-between gap-3 px-6 pt-[52px] pb-3"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 100%)' }}>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight tracking-tight text-white line-clamp-2 break-words">{activeJourney.root.title}</h1>
        </div>
        {journeys.length > 1 && (
          <div className="pointer-events-auto flex shrink-0 items-center gap-[5px] pb-1.5">
            {journeys.map((j, i) => (
              <button
                key={j.root.localIndex}
                type="button"
                aria-label={`Go to ${j.root.title}`}
                onClick={() => setCurrent(i)}
                className="h-1.5 rounded-full transition-all"
                style={{
                  width: i === current ? 16 : 6,
                  background: i === current ? '#fff' : 'var(--border-light)',
                }}
              />
            ))}
          </div>
        )}
      </header>

      {selected && (
        <DoItScreen
          node={selected}
          pendingGoalIndex={pendingGoalIndex}
          onNavigate={onNavigate}
          onStartGoal={onStartGoal}
          onEndGoal={onEndGoal}
          onRepairGoal={onRepairGoal}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
