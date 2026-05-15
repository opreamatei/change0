import { useState } from 'react'
import { ROOT_GOAL_ID } from '../config/utils'
import {
  findGoalByGlobalIndex,
  formatGoalDate,
  formatGoalDuration,
  inferGoalState,
  type Goal,
} from '../goal'

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
    started: 'bg-green-50 text-green-700 border-green-200',
    finished: 'bg-neutral-100 text-neutral-400 border-neutral-200',
    idle: 'bg-neutral-50 text-neutral-500 border-neutral-200',
  }

  const labels: Record<string, string> = {
    started: 'In progress',
    finished: 'Done',
    idle: 'Idle',
  }

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles[state] ?? 'bg-neutral-100 text-neutral-500'}`}>
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
  const isPending = pendingGoalIndex === goal.globalIndex
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
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          onClick={() => onNavigate(goal.id)}
        >
          Open
        </button>
        <button
          type="button"
          className="rounded border border-green-300 bg-green-50 px-3 py-1.5 text-sm text-green-700 hover:bg-green-100 disabled:border-neutral-200 disabled:bg-transparent disabled:text-neutral-300"
          onClick={() => onStartGoal(goal)}
          disabled={isPending || state !== 'idle' || !canStart}
        >
          Start
        </button>
        <button
          type="button"
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:border-neutral-200 disabled:text-neutral-300"
          onClick={() => onEndGoal(goal)}
          disabled={isPending || state !== 'started'}
        >
          End
        </button>
        <button
          type="button"
          className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-100 disabled:border-neutral-200 disabled:bg-transparent disabled:text-neutral-300"
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
            className="flex-1 rounded border border-neutral-300 px-3 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-amber-400 focus:outline-none"
            placeholder="Describe what needs to change..."
            value={repairReason}
            onChange={(e) => setRepairReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitRepair() }}
            autoFocus
          />
          <button
            type="button"
            className="rounded border border-amber-400 bg-amber-50 px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-100 disabled:opacity-50"
            onClick={submitRepair}
            disabled={!repairReason.trim()}
          >
            Confirm
          </button>
          <button
            type="button"
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
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
    <article className={`rounded-xl border px-5 py-4 ${highlight ? 'border-neutral-300 bg-neutral-50' : 'border-neutral-200 bg-white'}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium uppercase tracking-widest text-neutral-400">{label}</p>
          <h3 className="text-base font-semibold leading-snug text-black">{goal.title}</h3>
        </div>
        <StateBadge goal={goal} />
      </div>

      {goal.extraInfo && (
        <p className="mb-3 text-sm leading-relaxed text-neutral-600">{goal.extraInfo}</p>
      )}

      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
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

  return (
    <section className="mx-auto w-full max-w-3xl space-y-6">
      <header>
        <button
          type="button"
          className="mb-2 flex items-center gap-1 text-sm text-neutral-400 hover:text-neutral-700"
          onClick={() => onNavigate(outerParentGoal ? outerParentGoal.id : ROOT_GOAL_ID)}
        >
          ← {parentGoal ? 'Parent' : 'Root'}
        </button>
        <h1 className="text-2xl font-bold text-black">
          {parentGoal ? parentGoal.title : 'All goals'}
        </h1>
        {statusMessage && (
          <p className="mt-1 text-sm text-neutral-500">{statusMessage}</p>
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
          <h2 className="text-lg font-semibold text-black">
            {parentGoal ? 'Subgoals' : 'Goals'}
          </h2>
          <span className="text-sm text-neutral-400">{childrenGoals.length}</span>
        </div>

        {childrenGoals.length === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-200 px-5 py-8 text-center text-sm text-neutral-400">
            No subgoals.
          </p>
        ) : (
          <div className="space-y-3">
            {childrenGoals.map((goal, index) => (
              <GoalCard
                key={goal.globalIndex}
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
