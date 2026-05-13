import { useEffect, useState, useCallback } from 'react'
import {
  formatGoalDate,
  formatGoalDuration,
  getCurrentLeafGoals,
  getLeafGoals,
  Goal,
  type GoalListResponseItem,
  inferGoalState,
} from '../goal'
import { SERVER_ENDPOINTS } from '../config/server'

export interface CurrentGoalsViewProps {
  goals: Goal[]
  pendingGoalIndex: number | null
  statusMessage: string
  onNavigate: (goalId: string) => void
  onStartGoal: (goal: Goal) => void
  onEndGoal: (goal: Goal) => void
}

function ActionButtons({
  goal,
  pendingGoalIndex,
  canStart,
  onNavigate,
  onStartGoal,
  onEndGoal,
}: {
  goal: Goal
  pendingGoalIndex: number | null
  canStart: boolean
  onNavigate: (goalId: string) => void
  onStartGoal: (goal: Goal) => void
  onEndGoal: (goal: Goal) => void
}) {
  const state = inferGoalState(goal)
  const isPending = pendingGoalIndex === goal.globalIndex

  return (
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
    </div>
  )
}

function RunningGoalCard({
  goal, pendingGoalIndex, onNavigate, onStartGoal, onEndGoal,
}: { goal: Goal; pendingGoalIndex: number | null; onNavigate: (id: string) => void; onStartGoal: (goal: Goal) => void; onEndGoal: (goal: Goal) => void }) {
  return (
    <article className="rounded-xl border border-green-200 bg-green-50 px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="size-2 animate-pulse rounded-full bg-green-500" />
        <span className="text-xs font-semibold uppercase tracking-widest text-green-700">Running</span>
      </div>
      <h3 className="mb-1 text-base font-semibold text-black">{goal.title}</h3>
      {goal.extraInfo && <p className="mb-3 text-sm leading-relaxed text-neutral-700">{goal.extraInfo}</p>}
      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
        <span>{formatGoalDuration(goal.requiredTime)} estimated</span>
        {goal.startDate ? <span>Started {formatGoalDate(goal.startDate)}</span> : null}
      </div>
      <ActionButtons goal={goal} pendingGoalIndex={pendingGoalIndex} canStart={false} onNavigate={onNavigate} onStartGoal={onStartGoal} onEndGoal={onEndGoal} />
    </article>
  )
}

function DoneGoalCard({ goal }: { goal: Goal }) {
  const duration = goal.startDate && goal.endDate ? goal.endDate - goal.startDate : null
  return (
    <article className="rounded-xl border border-neutral-100 bg-neutral-50 px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="size-2 rounded-full bg-neutral-300" />
        <span className="text-xs font-semibold uppercase tracking-widest text-neutral-400">Done</span>
      </div>
      <h3 className="mb-1 text-base font-semibold text-neutral-400 line-through">{goal.title}</h3>
      <div className="flex flex-wrap gap-x-4 text-xs text-neutral-400">
        {duration !== null && <span>Took {formatGoalDuration(duration)}</span>}
        {goal.endDate && <span>Ended {formatGoalDate(goal.endDate)}</span>}
      </div>
    </article>
  )
}

function NextGoalCard({
  goal, pendingGoalIndex, onNavigate, onStartGoal, onEndGoal,
}: { goal: Goal; pendingGoalIndex: number | null; onNavigate: (id: string) => void; onStartGoal: (goal: Goal) => void; onEndGoal: (goal: Goal) => void }) {
  return (
    <article className="rounded-xl border border-neutral-200 bg-white px-5 py-4">
      <h3 className="mb-1 text-base font-semibold text-black">{goal.title}</h3>
      {goal.extraInfo && <p className="mb-3 text-sm leading-relaxed text-neutral-600">{goal.extraInfo}</p>}
      <div className="mb-4 text-xs text-neutral-500">
        <span>{formatGoalDuration(goal.requiredTime)} estimated</span>
      </div>
      <ActionButtons goal={goal} pendingGoalIndex={pendingGoalIndex} canStart={true} onNavigate={onNavigate} onStartGoal={onStartGoal} onEndGoal={onEndGoal} />
    </article>
  )
}

export default function CurrentGoalsView({
  goals, pendingGoalIndex, statusMessage, onNavigate, onStartGoal, onEndGoal,
}: CurrentGoalsViewProps) {
  const [nextGoals, setNextGoals] = useState<Goal[]>([])
  const [nextError, setNextError] = useState<string | null>(null)

  const fetchNext = useCallback(async () => {
    try {
      const res = await fetch(SERVER_ENDPOINTS.sessionGoals, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { ok: boolean; goals: GoalListResponseItem[] }
      if (!data.ok) throw new Error('Server error')
      setNextGoals((data.goals ?? []).map(Goal.fromServer))
      setNextError(null)
    } catch (err) {
      setNextError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const running = getCurrentLeafGoals(goals)
  const done = getLeafGoals(goals).filter((g) => inferGoalState(g) === 'finished')

  useEffect(() => { void fetchNext() }, [fetchNext, done.length, running.length])

  const resolvedNextGoals = nextGoals.filter((g) => inferGoalState(g) !== 'finished')

  return (
    <section className="mx-auto w-full max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-black">Session</h1>
        {statusMessage && <p className="mt-1 text-sm text-neutral-500">{statusMessage}</p>}
      </header>

      <div className="space-y-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold text-black">Running</h2>
          <span className="text-sm text-neutral-400">{running.length}</span>
        </div>
        {running.length === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-200 px-5 py-8 text-center text-sm text-neutral-400">
            Nothing running right now.
          </p>
        ) : (
          <div className="space-y-3">
            {running.map((g) => (
              <RunningGoalCard key={g.globalIndex} goal={g} pendingGoalIndex={pendingGoalIndex} onNavigate={onNavigate} onStartGoal={onStartGoal} onEndGoal={onEndGoal} />
            ))}
          </div>
        )}
      </div>

      {done.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-semibold text-black">Done</h2>
            <span className="text-sm text-neutral-400">{done.length}</span>
          </div>
          <div className="space-y-2">
            {done.map((g) => (
              <DoneGoalCard key={g.globalIndex} goal={g} />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-semibold text-black">Next</h2>
            <span className="text-sm text-neutral-400">{resolvedNextGoals.length}</span>
          </div>
          <button
            type="button"
            className="text-xs text-neutral-400 underline underline-offset-2 hover:text-neutral-700"
            onClick={() => void fetchNext()}
          >
            Refresh
          </button>
        </div>
        {nextError && <p className="text-sm text-red-600">{nextError}</p>}
        {resolvedNextGoals.length === 0 && !nextError ? (
          <p className="text-sm text-neutral-400">No next goals found.</p>
        ) : (
          <div className="space-y-3">
            {resolvedNextGoals.map((g) => (
              <NextGoalCard key={g.globalIndex} goal={g} pendingGoalIndex={pendingGoalIndex} onNavigate={onNavigate} onStartGoal={onStartGoal} onEndGoal={onEndGoal} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
