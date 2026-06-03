import { useMemo, useState } from 'react'
import { ROOT_GOAL_ID } from '../config/utils'
import GoalTipsCard from '../components/goal-tips-card'
import {
  findGoalByGlobalIndex,
  formatGoalDate,
  formatGoalDuration,
  inferGoalState,
  type Goal,
} from '../goal'

function getRootGoalProgress(globalGoals: Goal[], start: Goal): { pct: number; rootTitle: string } {
  let root = start
  while (root.parent !== null) {
    const parent = findGoalByGlobalIndex(globalGoals, root.parent)
    if (!parent) break
    root = parent
  }

  let totalTime = 0
  let doneTime = 0

  function walk(g: Goal) {
    if (g.subgoals.length === 0) {
      totalTime += g.requiredTime
      if (g.endDate !== null) doneTime += g.requiredTime
      return
    }
    for (const idx of g.subgoals) {
      const child = findGoalByGlobalIndex(globalGoals, idx)
      if (child) walk(child)
    }
  }
  walk(root)

  return {
    pct: totalTime > 0 ? Math.round((doneTime / totalTime) * 100) : 0,
    rootTitle: root.title,
  }
}

export interface GoalViewerProps {
  childrenGoals: Goal[]
  globalGoals: Goal[]
  parentGoal: Goal | null
  statusMessage: string
  pendingGoalIndex: number | null
  onNavigate: (goalId: string) => void
  onStartGoal: (goal: Goal) => void
  onEndGoal: (goal: Goal) => void
  onRepairGoal: (goal: Goal, reason: string) => void
}

function StateBadge({ goal }: { goal: Goal }) {
  const state = inferGoalState(goal)

  const styles: Record<string, string> = {
    started: 'bg-green-950/30 text-green-400 border-green-900',
    finished: 'bg-[#222] text-white/40 border-[#2a2a2a]',
    idle: 'bg-[#1a1a1a] text-white/55 border-[#2a2a2a]',
  }

  const labels: Record<string, string> = {
    started: 'In progress',
    finished: 'Done',
    idle: 'Idle',
  }

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles[state] ?? 'bg-[#222] text-white/55'}`}>
      {state === 'started' && <span className="size-1.5 rounded-full bg-green-500" />}
      {labels[state] ?? state}
    </span>
  )
}

function ActionButtons({
  goal,
  pendingGoalIndex,
  canStart = true,
  onNavigate,
  onStartGoal,
  onEndGoal,
  onRepairGoal,
}: {
  goal: Goal
  pendingGoalIndex: number | null
  canStart?: boolean
  onNavigate: (goalId: string) => void
  onStartGoal: (goal: Goal) => void
  onEndGoal: (goal: Goal) => void
  onRepairGoal: (goal: Goal, reason: string) => void
}) {
  const state = inferGoalState(goal)
  const isPending = pendingGoalIndex === goal.localIndex
  const [repairOpen, setRepairOpen] = useState(false)
  const [repairReason, setRepairReason] = useState('')

  function submitRepair() {
    if (!repairReason.trim()) return
    onRepairGoal(goal, repairReason.trim())
    setRepairOpen(false)
    setRepairReason('')
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border border-[#333] px-3 py-1.5 text-sm text-white/70 hover:bg-[#1a1a1a]"
          onClick={() => onNavigate(goal.id)}
        >
          Open
        </button>
        <button
          type="button"
          className="rounded border border-green-800 bg-green-950/30 px-3 py-1.5 text-sm text-green-400 hover:bg-green-900/30 disabled:border-[#2a2a2a] disabled:bg-transparent disabled:text-white/30"
          onClick={() => onStartGoal(goal)}
          disabled={isPending || state !== 'idle' || !canStart}
        >
          Start
        </button>
        <button
          type="button"
          className="rounded border border-[#333] px-3 py-1.5 text-sm text-white/70 hover:bg-[#1a1a1a] disabled:border-[#2a2a2a] disabled:text-white/30"
          onClick={() => onEndGoal(goal)}
          disabled={isPending || state !== 'started'}
        >
          End
        </button>
        <button
          type="button"
          className="rounded border border-amber-800 bg-amber-950/30 px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-900/30 disabled:border-[#2a2a2a] disabled:bg-transparent disabled:text-white/30"
          onClick={() => setRepairOpen((v) => !v)}
          disabled={isPending}
        >
          Repair
        </button>
      </div>
      {repairOpen && (
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 rounded border border-[#333] px-3 py-1.5 text-sm text-white placeholder-white/40 focus:border-amber-700 focus:outline-none"
            placeholder="Describe what needs to change..."
            value={repairReason}
            onChange={(e) => setRepairReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitRepair() }}
            autoFocus
          />
          <button
            type="button"
            className="rounded border border-amber-700 bg-amber-950/30 px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-900/30 disabled:opacity-50"
            onClick={submitRepair}
            disabled={!repairReason.trim()}
          >
            Confirm
          </button>
          <button
            type="button"
            className="rounded border border-[#333] px-3 py-1.5 text-sm text-white/55 hover:bg-[#1a1a1a]"
            onClick={() => { setRepairOpen(false); setRepairReason('') }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

function GoalCard({
  goal,
  label,
  highlight = false,
  pendingGoalIndex,
  onNavigate,
  onStartGoal,
  onEndGoal,
  onRepairGoal,
}: {
  goal: Goal
  label: string
  highlight?: boolean
  pendingGoalIndex: number | null
  onNavigate: (goalId: string) => void
  onStartGoal: (goal: Goal) => void
  onEndGoal: (goal: Goal) => void
  onRepairGoal: (goal: Goal, reason: string) => void
}) {
  const state = inferGoalState(goal)

  return (
    <article className={`rounded-xl border px-5 py-4 ${highlight ? 'border-[#333] bg-[#1a1a1a]' : 'border-[#2a2a2a] bg-[#111]'}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium uppercase tracking-widest text-white/40">{label}</p>
          <h3 className="text-base font-semibold leading-snug text-white">{goal.title}</h3>
        </div>
        <StateBadge goal={goal} />
      </div>

      {goal.tips ? (
        <div className="mb-3">
          <GoalTipsCard tips={goal.tips} compact />
        </div>
      ) : goal.extraInfo && (
        <p className="mb-3 text-sm leading-relaxed text-white/55">{goal.extraInfo}</p>
      )}

      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
        <span>Duration: {formatGoalDuration(goal.requiredTime)}</span>
        {state === 'started' && goal.startDate
          ? <span>Started: {formatGoalDate(goal.startDate)}</span>
          : null}
        {state === 'finished' && goal.endDate
          ? <span>Ended: {formatGoalDate(goal.endDate)}</span>
          : null}
      </div>

      <ActionButtons
        goal={goal}
        pendingGoalIndex={pendingGoalIndex}
        onNavigate={onNavigate}
        onStartGoal={onStartGoal}
        onEndGoal={onEndGoal}
        onRepairGoal={onRepairGoal}
      />
    </article>
  )
}

export default function GoalViewer(props: GoalViewerProps) {
  const {
    globalGoals,
    childrenGoals,
    parentGoal,
    statusMessage,
    pendingGoalIndex,
    onNavigate,
    onStartGoal,
    onEndGoal,
    onRepairGoal,
  } = props

  const outerParentGoal = parentGoal?.parent
    ? findGoalByGlobalIndex(globalGoals, parentGoal.parent)
    : null

  const rootProgress = useMemo(
    () => parentGoal ? getRootGoalProgress(globalGoals, parentGoal) : null,
    [globalGoals, parentGoal],
  )

  return (
    <section className="mx-auto w-full max-w-3xl space-y-6">
      <header>
        <button
          type="button"
          className="mb-2 flex items-center gap-1 text-sm text-white/40 hover:text-white/70"
          onClick={() => onNavigate(outerParentGoal ? outerParentGoal.id : ROOT_GOAL_ID)}
        >
          ← {parentGoal ? 'Parent' : 'Root'}
        </button>
        <h1 className="text-2xl font-bold text-white">
          {parentGoal ? parentGoal.title : 'All goals'}
        </h1>
        {rootProgress !== null && (
          <div className="mt-2 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-white/40 transition-all"
                style={{ width: `${rootProgress.pct}%` }}
              />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-white/40">
              {rootProgress.pct}%
            </span>
          </div>
        )}
        {statusMessage && (
          <p className="mt-1 text-sm text-white/55">{statusMessage}</p>
        )}
      </header>

      {parentGoal && (
        <GoalCard
          goal={parentGoal}
          label="Current goal"
          highlight
          pendingGoalIndex={pendingGoalIndex}
          onNavigate={onNavigate}
          onStartGoal={onStartGoal}
          onEndGoal={onEndGoal}
          onRepairGoal={onRepairGoal}
        />
      )}

      <div>
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-lg font-semibold text-white">
            {parentGoal ? 'Subgoals' : 'Goals'}
          </h2>
          <span className="text-sm text-white/40">{childrenGoals.length}</span>
        </div>

        {childrenGoals.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#2a2a2a] px-5 py-8 text-center text-sm text-white/40">
            No subgoals.
          </p>
        ) : (
          <div className="space-y-3">
            {childrenGoals.map((goal, index) => (
              <GoalCard
                key={goal.localIndex}
                goal={goal}
                label={`#${index + 1}`}
                pendingGoalIndex={pendingGoalIndex}
                onNavigate={onNavigate}
                onStartGoal={onStartGoal}
                onEndGoal={onEndGoal}
                onRepairGoal={onRepairGoal}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
