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
  pendingGoalId: string | null
  onNavigate: (goalId: string) => void
  onStartGoal: (goalId: string) => void
  onEndGoal: (goalId: string) => void
}

function GoalStateBadge({ goal }: { goal: Goal }) {
  const state = inferGoalState(goal)
  const className = state === 'finished'
    ? 'bg-emerald-100 text-emerald-700'
    : state === 'started'
      ? 'bg-sky-100 text-sky-700'
      : 'bg-neutral-100 text-neutral-700'

  return (
    <span className={`rounded-md px-2 py-1 text-xs uppercase tracking-wide ${className}`}>
      {state}
    </span>
  )
}

function GoalActionRow({
  goal,
  pendingGoalId,
  onNavigate,
  onStartGoal,
  onEndGoal,
}: {
  goal: Goal
  pendingGoalId: string | null
  onNavigate: (goalId: string) => void
  onStartGoal: (goalId: string) => void
  onEndGoal: (goalId: string) => void
}) {
  const state = inferGoalState(goal)
  const isPending = pendingGoalId === goal.id

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <button
        type="button"
        className="rounded px-3 py-2 text-sm text-black underline underline-offset-2"
        onClick={() => onNavigate(goal.id)}
      >
        Open
      </button>
      <button
        type="button"
        className="rounded bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        onClick={() => onStartGoal(goal.id)}
        disabled={isPending || state !== 'idle'}
      >
        Start
      </button>
      <button
        type="button"
        className="rounded bg-neutral-100 px-3 py-2 text-sm text-black disabled:opacity-40"
        onClick={() => onEndGoal(goal.id)}
        disabled={isPending || state !== 'started'}
      >
        End
      </button>
    </div>
  )
}

function GoalCard({
  goal,
  pendingGoalId,
  onNavigate,
  onStartGoal,
  onEndGoal,
}: {
  goal: Goal
  pendingGoalId: string | null
  onNavigate: (goalId: string) => void
  onStartGoal: (goalId: string) => void
  onEndGoal: (goalId: string) => void
}) {
  return (
    <article className="py-4">
      <div className="flex items-start justify-between gap-3">
        <h3>{goal.title}</h3>
        <GoalStateBadge goal={goal} />
      </div>
      <p className="mt-2 text-sm text-neutral-600">{goal.extraInfo || 'No extra info.'}</p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="px-3 py-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-400">ID</dt>
          <dd>{goal.id}</dd>
        </div>
        <div className="px-3 py-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Required</dt>
          <dd>{formatGoalDuration(goal.requiredTime)}</dd>
        </div>
        <div className="px-3 py-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Start</dt>
          <dd>{formatGoalDate(goal.startDate)}</dd>
        </div>
        <div className="px-3 py-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-400">End</dt>
          <dd>{formatGoalDate(goal.endDate)}</dd>
        </div>
      </dl>
      <GoalActionRow
        goal={goal}
        pendingGoalId={pendingGoalId}
        onNavigate={onNavigate}
        onStartGoal={onStartGoal}
        onEndGoal={onEndGoal}
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
    pendingGoalId,
    onNavigate,
    onStartGoal,
    onEndGoal,
  } = props

  const outerParentGoal = parentGoal?.parent
    ? findGoalByGlobalIndex(globalGoals, parentGoal.parent)
    : null

  return (
    <section className="mx-auto w-full max-w-5xl">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-neutral-400">Server goals</p>
          <h1>{parentGoal ? parentGoal.title : 'Root goals'}</h1>
        </div>
        <button
          type="button"
          className="rounded px-3 py-2 text-sm text-black underline underline-offset-2"
          onClick={() => onNavigate(outerParentGoal ? outerParentGoal.id : ROOT_GOAL_ID)}
        >
          {parentGoal ? 'Go to parent' : 'Back to root'}
        </button>
      </header>

      <p className="mb-6 text-sm text-neutral-600">{statusMessage}</p>

      {parentGoal ? (
        <div className="mb-8 py-2">
          <div className="flex items-start justify-between gap-3">
            <h2>Current goal</h2>
            <GoalStateBadge goal={parentGoal} />
          </div>
          <p className="mt-2 text-sm text-neutral-600">{parentGoal.extraInfo || 'No extra info.'}</p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-400">ID</dt>
              <dd>{parentGoal.id}</dd>
            </div>
            <div className="px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-400">Required</dt>
              <dd>{formatGoalDuration(parentGoal.requiredTime)}</dd>
            </div>
            <div className="px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-400">Start</dt>
              <dd>{formatGoalDate(parentGoal.startDate)}</dd>
            </div>
            <div className="px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-400">End</dt>
              <dd>{formatGoalDate(parentGoal.endDate)}</dd>
            </div>
          </dl>
          <GoalActionRow
            goal={parentGoal}
            pendingGoalId={pendingGoalId}
            onNavigate={onNavigate}
            onStartGoal={onStartGoal}
            onEndGoal={onEndGoal}
          />
        </div>
      ) : null}

      <div className="mb-4 flex items-center justify-between gap-3">
        <h2>{parentGoal ? 'Child goals' : 'Top-level goals'}</h2>
        <p className="text-sm text-neutral-500">{childrenGoals.length} visible</p>
      </div>

      {childrenGoals.length === 0 ? (
        <p className="text-sm text-neutral-500">No child goals available for this node.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {childrenGoals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              pendingGoalId={pendingGoalId}
              onNavigate={onNavigate}
              onStartGoal={onStartGoal}
              onEndGoal={onEndGoal}
            />
          ))}
        </div>
      )}
    </section>
  )
}
