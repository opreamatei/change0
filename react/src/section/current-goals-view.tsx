import {
  formatGoalDate,
  formatGoalDuration,
  getCurrentLeafGoals,
  getGoalStartGate,
  getLeafGoals,
  inferGoalState,
  type Goal,
} from '../goal'

export interface CurrentGoalsViewProps {
  goals: Goal[]
  pendingGoalId: string | null
  statusMessage: string
  onNavigate: (goalId: string) => void
  onStartGoal: (goalId: string) => void
  onEndGoal: (goalId: string) => void
}

function GoalButtonRow({
  goal,
  pendingGoalId,
  canStart,
  onNavigate,
  onStartGoal,
  onEndGoal,
}: {
  goal: Goal
  pendingGoalId: string | null
  canStart: boolean
  onNavigate: (goalId: string) => void
  onStartGoal: (goalId: string) => void
  onEndGoal: (goalId: string) => void
}) {
  const state = inferGoalState(goal)
  const isPending = pendingGoalId === goal.id

  return (
    <div className="flex flex-wrap gap-3 text-sm">
      <button type="button" className="underline underline-offset-2" onClick={() => onNavigate(goal.id)}>
        Open
      </button>
      <button
        type="button"
        className="disabled:text-neutral-400"
        onClick={() => onStartGoal(goal.id)}
        disabled={isPending || state !== 'idle' || !canStart}
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

function CurrentGoalCard({
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
    <article className="space-y-3 rounded-xl border border-neutral-200 px-4 py-4">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-[0.16em] text-neutral-500">Current leaf goal</p>
        <h2 className="text-lg">{goal.title}</h2>
      </div>
      <p className="text-sm leading-6 text-neutral-700">{goal.extraInfo || 'No extra info.'}</p>
      <div className="space-y-1 text-sm text-neutral-600">
        <p>Current session: {goal.extraInfo || goal.title}</p>
        <p>Estimated total elapsed time: {formatGoalDuration(goal.requiredTime)}</p>
        <p>Started: {formatGoalDate(goal.startDate)}</p>
      </div>
      <GoalButtonRow
        goal={goal}
        pendingGoalId={pendingGoalId}
        canStart={false}
        onNavigate={onNavigate}
        onStartGoal={onStartGoal}
        onEndGoal={onEndGoal}
      />
    </article>
  )
}

function UpcomingGoalCard({
  goal,
  pendingGoalId,
  gate,
  onNavigate,
  onStartGoal,
  onEndGoal,
}: {
  goal: Goal
  pendingGoalId: string | null
  gate: ReturnType<typeof getGoalStartGate>
  onNavigate: (goalId: string) => void
  onStartGoal: (goalId: string) => void
  onEndGoal: (goalId: string) => void
}) {
  const minPauseText = gate.minPauseUntil
    ? formatGoalDate(gate.minPauseUntil)
    : 'n/a'
  const normalPauseText = gate.normalPauseUntil
    ? formatGoalDate(gate.normalPauseUntil)
    : 'n/a'

  return (
    <article className="space-y-2 border-l border-neutral-300 pl-4">
      <p className="text-sm text-neutral-500">{gate.ready ? 'Ready next leaf goal' : 'Blocked next leaf goal'}</p>
      <h3 className="text-base">{goal.title}</h3>
      <p className="text-sm text-neutral-600">{goal.extraInfo || 'No extra info.'}</p>
      <div className="space-y-1 text-sm text-neutral-500">
        <p>Estimated total elapsed time: {formatGoalDuration(goal.requiredTime)}</p>
        {gate.previousGoal ? <p>Previous leaf goal: {gate.previousGoal.title}</p> : <p>No previous leaf goal.</p>}
        {gate.previousGoal && !gate.previousGoal.endDate ? <p>Previous leaf goal is not finished yet.</p> : null}
        {gate.previousGoal?.endDate ? <p>Minimum pause clears at: {minPauseText}</p> : null}
        {gate.previousGoal?.endDate ? <p>Normal pause reference: {normalPauseText}</p> : null}
        {!gate.ready && Number.isFinite(gate.remainingMinPause)
          ? <p>Still blocked for: {formatGoalDuration(gate.remainingMinPause)}</p>
          : null}
      </div>
      <GoalButtonRow
        goal={goal}
        pendingGoalId={pendingGoalId}
        canStart={gate.ready}
        onNavigate={onNavigate}
        onStartGoal={onStartGoal}
        onEndGoal={onEndGoal}
      />
    </article>
  )
}

export default function CurrentGoalsView({
  goals,
  pendingGoalId,
  statusMessage,
  onNavigate,
  onStartGoal,
  onEndGoal,
}: CurrentGoalsViewProps) {
  const now = Math.floor(Date.now() / 1000)
  const currentLeafGoals = getCurrentLeafGoals(goals)
  const idleLeafGoals = getLeafGoals(goals).filter((goal) => inferGoalState(goal) === 'idle')
  const readyGoals = idleLeafGoals
    .map((goal) => ({ goal, gate: getGoalStartGate(goals, goal, now) }))
    .filter((entry) => entry.gate.ready)
  const blockedGoals = idleLeafGoals
    .map((goal) => ({ goal, gate: getGoalStartGate(goals, goal, now) }))
    .filter((entry) => !entry.gate.ready)

  return (
    <section className="mx-auto w-full max-w-3xl space-y-6">
      <header className="space-y-2">
        <div>
          <p className="text-sm text-neutral-500">Current session</p>
          <h1 className="text-2xl">Leaf goals in progress</h1>
        </div>
        <p className="text-sm text-neutral-600">{statusMessage}</p>
      </header>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl">Current goals</h2>
          <p className="text-sm text-neutral-500">
            A current goal is any leaf goal with start set and end unset.
          </p>
        </div>
        {currentLeafGoals.length === 0 ? (
          <p className="text-sm text-neutral-500">No current leaf goals are running.</p>
        ) : (
          <div className="space-y-4">
            {currentLeafGoals.map((goal) => (
              <CurrentGoalCard
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

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl">Ready after minimum pause</h2>
          <p className="text-sm text-neutral-500">
            You can start these leaf goals now. Normal pause is shown only as reference.
          </p>
        </div>
        {readyGoals.length === 0 ? (
          <p className="text-sm text-neutral-500">No idle leaf goals are ready to start yet.</p>
        ) : (
          <div className="space-y-4">
            {readyGoals.map(({ goal, gate }) => (
              <UpcomingGoalCard
                key={goal.id}
                goal={goal}
                gate={gate}
                pendingGoalId={pendingGoalId}
                onNavigate={onNavigate}
                onStartGoal={onStartGoal}
                onEndGoal={onEndGoal}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl">Blocked by minimum pause</h2>
          <p className="text-sm text-neutral-500">
            These leaf goals still need the previous leaf goal to finish or wait out its minimum pause.
          </p>
        </div>
        {blockedGoals.length === 0 ? (
          <p className="text-sm text-neutral-500">No leaf goals are currently blocked by minimum pause.</p>
        ) : (
          <div className="space-y-4">
            {blockedGoals.map(({ goal, gate }) => (
              <UpcomingGoalCard
                key={goal.id}
                goal={goal}
                gate={gate}
                pendingGoalId={pendingGoalId}
                onNavigate={onNavigate}
                onStartGoal={onStartGoal}
                onEndGoal={onEndGoal}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  )
}
