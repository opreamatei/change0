import { useEffect, useMemo, useRef, useState } from 'react'
import {
  findGoalByGlobalIndex,
  getRootGoalProgressPct,
  getRootGoals,
  Goal,
  inferGoalState,
  isLeafGoal,
} from '../goal'
import { PathCanvas } from '../components/path-canvas'
import type { PathNodeData, NodeState } from '../components/path-canvas'
import { SwipeDeck } from '../components/swipe-deck'

const LEAF_DECOMP_THRESHOLD_SECONDS = 60 * 16 * 2

// A goal the user tapped on the path. The actual focus session is rendered at
// the app level (see FocusSession) so it can take over the whole screen.
export interface GoalSelection {
  goal: Goal
  nodeState: NodeState
  isMystery: boolean
  canStart: boolean
}

export interface CurrentGoalsViewProps {
  goals: Goal[]
  statusMessage: string
  onSelectGoal: (selection: GoalSelection) => void
  /** Long-press on a goal card — opens an options menu (e.g. exit journey). */
  onGoalOptions?: (selection: GoalSelection) => void
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
  progressPct: number
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
      isJournal: g.goalType === 'journal',
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

  return { root, pathNodes, focusIdx, doneCount, knownCount, mysteryCount, progressPct: getRootGoalProgressPct(goals, root) }
}

export default function CurrentGoalsView({
  goals, statusMessage, onSelectGoal, onGoalOptions,
}: CurrentGoalsViewProps) {
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
                  onSelect={(idx) => {
                    const nd = j.pathNodes[idx]
                    if (nd) onSelectGoal({ goal: nd.goal, nodeState: nd.nodeState, isMystery: nd.isMystery, canStart: nd.canStart })
                  }}
                  onLongPress={onGoalOptions ? (idx) => {
                    const nd = j.pathNodes[idx]
                    if (nd) onGoalOptions({ goal: nd.goal, nodeState: nd.nodeState, isMystery: nd.isMystery, canStart: nd.canStart })
                  } : undefined}
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
          <div className="mt-2 flex items-center gap-2.5">
            <div className="h-[3px] w-36 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,.15)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${activeJourney.progressPct}%`, background: 'rgba(255,255,255,.55)' }}
              />
            </div>
            <span className="text-[11px] tabular-nums" style={{ color: 'rgba(255,255,255,.4)' }}>
              {activeJourney.progressPct}%
            </span>
          </div>
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
    </div>
  )
}
