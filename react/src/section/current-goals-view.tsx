import { useEffect, useRef, useState } from 'react'
import {
  findGoalByGlobalIndex,
  formatGoalDuration,
  getRootGoals,
  Goal,
  inferGoalState,
  isLeafGoal,
} from '../goal'
import { PathCanvas } from '../components/path-canvas'
import type { PathNodeData, NodeState } from '../components/path-canvas'

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

function flattenLeavesInOrder(goals: Goal[]): Goal[] {
  const out: Goal[] = []
  const visit = (g: Goal) => {
    if (g.subgoals.length === 0) { out.push(g); return }
    for (const idx of g.subgoals) {
      const child = findGoalByGlobalIndex(goals, idx)
      if (child) visit(child)
    }
  }
  for (const root of getRootGoals(goals)) visit(root)
  return out
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

function NodeDetail({
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
  const [repairOpen, setRepairOpen] = useState(false)
  const isPending = pendingGoalIndex === node.goal.localIndex
  const { goal, nodeState, isMystery } = node

  const statusLabel =
    nodeState === 'active' ? 'Running' :
    nodeState === 'done'   ? 'Done' :
    isMystery              ? 'Will be broken down' :
    'Next'

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-end justify-center">
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
        <div className="relative w-full max-w-lg rounded-t-3xl border-t border-[#2a2a2a] bg-[#111] px-6 py-6 pb-10">
          <div className="mb-1 flex items-center gap-2">
            {nodeState === 'active' && <span className="size-1.5 animate-pulse rounded-full bg-green-500" />}
            {isMystery && <span className="size-1.5 rounded-full bg-violet-400" />}
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">{statusLabel}</p>
          </div>
          <p className="mb-1 text-base font-semibold text-white">{goal.title}</p>
          {goal.extraInfo && <p className="mb-3 text-sm leading-relaxed text-white/55">{goal.extraInfo}</p>}
          {goal.requiredTime > 0 && (
            <p className="mb-4 text-xs text-white/40">{formatGoalDuration(goal.requiredTime)} estimated</p>
          )}
          {isMystery && (
            <p className="mb-4 text-xs italic text-violet-300/60">
              Too long to do in one go — it'll split into smaller steps when you reach it.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-xl border border-[#333] px-4 py-2 text-sm text-white/55 hover:bg-[#1a1a1a]"
              onClick={() => { onNavigate(goal.id); onClose() }}>Open</button>
            {nodeState === 'idle' && node.canStart && !isMystery && (
              <button type="button" disabled={isPending}
                className="rounded-xl border border-green-800 bg-green-950/30 px-4 py-2 text-sm text-green-400 hover:bg-green-900/30 disabled:opacity-40"
                onClick={() => { onStartGoal(goal); onClose() }}>Start</button>
            )}
            {nodeState === 'active' && (
              <button type="button" disabled={isPending}
                className="rounded-xl border border-[#333] px-4 py-2 text-sm text-white/70 hover:bg-[#1a1a1a] disabled:opacity-40"
                onClick={() => { onEndGoal(goal); onClose() }}>End</button>
            )}
            {nodeState !== 'done' && (
              <button type="button" disabled={isPending}
                className="rounded-xl border border-amber-800 bg-amber-950/30 px-4 py-2 text-sm text-amber-400 hover:bg-amber-900/30 disabled:opacity-40"
                onClick={() => setRepairOpen(true)}>Repair</button>
            )}
          </div>
        </div>
      </div>
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

  const allLeaves = flattenLeavesInOrder(goals)

  const pathNodes: PathNode[] = []
  let num = 1
  let firstStartableAssigned = false
  let mysteryCount = 0
  let prevParentIndex: number | null | undefined = undefined

  for (const g of allLeaves) {
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

  const doneCount  = pathNodes.filter((nd) => nd.nodeState === 'done').length
  const knownCount = pathNodes.filter((nd) => !nd.isMystery).length

  return (
    <div className="flex h-full flex-col pt-12 pb-24">
      {pathNodes.length > 0 && !statusMessage && (
        <header className="mb-1 shrink-0 flex items-center justify-end px-5 pt-1">
          <p className="text-[10px] text-white/25">
            {doneCount}/{knownCount} done
            {mysteryCount > 0 && <span className="text-violet-300/30"> · beyond the fog</span>}
          </p>
        </header>
      )}

      <div ref={wrapperRef} className="relative w-full flex-1">
        {dim.w > 0 && dim.h > 0 && (
          <PathCanvas
            nodes={pathNodes}
            width={dim.w}
            height={dim.h}
            hasMysteryZone={mysteryCount > 0}
            initialFocusIdx={focusIdx}
            onSelect={(idx) => setSelected(pathNodes[idx] ?? null)}
          />
        )}
      </div>

      {selected && (
        <NodeDetail
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
