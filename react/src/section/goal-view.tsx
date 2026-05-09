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

function GoalStateText({ goal }: { goal: Goal }) {
  const state = inferGoalState(goal)

  return (
    <span className="text-sm text-neutral-500">
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
    <div className="mt-3 flex flex-wrap gap-2 text-sm">
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => onNavigate(goal.id)}
      >
        Open
      </button>
      <button
        type="button"
        className="disabled:text-neutral-400"
        onClick={() => onStartGoal(goal.id)}
        disabled={isPending || state !== 'idle'}
      >
        Start
      </button>
      <button
        type="button"
        className="disabled:text-neutral-400"
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
  label,
  pendingGoalId,
  onNavigate,
  onStartGoal,
  onEndGoal,
}: {
  goal: Goal
  label: string
  pendingGoalId: string | null
  onNavigate: (goalId: string) => void
  onStartGoal: (goalId: string) => void
  onEndGoal: (goalId: string) => void
}) {
  return (
    <article className="space-y-2">
      <p className="text-sm text-neutral-500">{label}</p>
      <h3 className="text-lg">{goal.title}</h3>
      <GoalStateText goal={goal} />
      <p className="text-sm text-neutral-600">{goal.extraInfo || 'No extra info.'}</p>
      <p className="text-sm text-neutral-600">Required: {formatGoalDuration(goal.requiredTime)}</p>
      <p className="text-sm text-neutral-600">Start: {formatGoalDate(goal.startDate)}</p>
      <p className="text-sm text-neutral-600">End: {formatGoalDate(goal.endDate)}</p>
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
    <section className="mx-auto w-full max-w-3xl space-y-6">
      <header className="space-y-2">
        <div>
          <p className="text-sm text-neutral-500">Server goals</p>
          <h1 className="text-2xl">{parentGoal ? parentGoal.title : 'Root goals'}</h1>
        </div>
        <button
          type="button"
          className="text-sm underline underline-offset-2"
          onClick={() => onNavigate(outerParentGoal ? outerParentGoal.id : ROOT_GOAL_ID)}
        >
          {parentGoal ? 'Go to parent' : 'Back to root'}
        </button>
      </header>

      <p className="text-sm text-neutral-600">{statusMessage}</p>

      {parentGoal ? (
        <GoalCard
          goal={parentGoal}
          label="Current goal"
          pendingGoalId={pendingGoalId}
          onNavigate={onNavigate}
          onStartGoal={onStartGoal}
          onEndGoal={onEndGoal}
        />
      ) : null}

      <div className="space-y-1">
        <h2 className="text-xl">{parentGoal ? 'Child goals' : 'Top-level goals'}</h2>
        <p className="text-sm text-neutral-500">{childrenGoals.length} visible</p>
      </div>

      {childrenGoals.length === 0 ? (
        <p className="text-sm text-neutral-500">No child goals available for this node.</p>
      ) : (
        <div className="space-y-6">
          {childrenGoals.map((goal, index) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              label={`Child ${index + 1}`}
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
