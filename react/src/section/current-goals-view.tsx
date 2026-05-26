import { useCallback, useEffect, useRef, useState } from 'react'
import {
  findGoalByGlobalIndex,
  formatGoalDuration,
  getRootGoals,
  Goal,
  inferGoalState,
  isLeafGoal,
} from '../goal'

/* ─── threshold mirrored from C: GOAL_MIN_SECONDS * 2 in goal-util.h / goal.c
 *    A leaf whose required time is at or above this gets decomposed further
 *    by DecomposeToLeaf, so until that happens it's a "mystery" placeholder. */
const LEAF_DECOMP_THRESHOLD_SECONDS = 60 * 16 * 2

/* ─── types & layout constants ──────────────────────────────────────────── */

export interface CurrentGoalsViewProps {
  goals: Goal[]
  pendingGoalIndex: number | null
  statusMessage: string
  onNavigate: (goalId: string) => void
  onStartGoal: (goal: Goal) => void
  onEndGoal: (goal: Goal) => void
  onRepairGoal: (goal: Goal, reason: string) => void
}

type NodeState = 'done' | 'active' | 'idle'

interface PathNode {
  goal: Goal
  nodeState: NodeState
  num: number
  canStart: boolean
  isMystery: boolean
  chapterTitle?: string
}

const NR = 32           // node radius
const SY = 150          // vertical spacing between nodes
const PT = 80
const PB = 140
const LABEL_GAP = 14
const LABEL_LH = 14
const LABEL_MAX_W = 130
const LABEL_LINES = 2
const HIT_PAD = 14

function nodeXAt(i: number, vw: number): number {
  return vw / 2 + Math.min(vw * 0.27, 96) * Math.sin((i * Math.PI) / 2)
}

function nodeYAt(i: number, contentH: number): number {
  return contentH - PB - NR - i * SY
}

/* ─── tree flattening ───────────────────────────────────────────────────── */

function flattenLeavesInOrder(goals: Goal[]): Goal[] {
  const out: Goal[] = []
  const visit = (g: Goal) => {
    if (g.subgoals.length === 0) {
      out.push(g)
      return
    }
    for (const idx of g.subgoals) {
      const child = findGoalByGlobalIndex(goals, idx)
      if (child) visit(child)
    }
  }
  for (const root of getRootGoals(goals)) visit(root)
  return out
}

/* ─── bottom sheets ─────────────────────────────────────────────────────── */

function RepairSheet({
  goal,
  onSubmit,
  onClose,
}: {
  goal: Goal
  onSubmit: (reason: string) => void
  onClose: () => void
}) {
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
          onKeyDown={(e) => {
            if (e.key === 'Enter' && reason.trim()) { onSubmit(reason.trim()); onClose() }
          }}
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-xl border border-[#333] py-2.5 text-sm text-white/55 hover:bg-[#1a1a1a]"
            onClick={onClose}
          >Cancel</button>
          <button
            type="button"
            disabled={!reason.trim()}
            className="flex-1 rounded-xl border border-amber-800 bg-amber-950/30 py-2.5 text-sm font-semibold text-amber-400 disabled:opacity-40"
            onClick={() => { if (reason.trim()) { onSubmit(reason.trim()); onClose() } }}
          >Submit</button>
        </div>
      </div>
    </div>
  )
}

function NodeDetail({
  node,
  pendingGoalIndex,
  onNavigate,
  onStartGoal,
  onEndGoal,
  onRepairGoal,
  onClose,
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
            <button
              type="button"
              className="rounded-xl border border-[#333] px-4 py-2 text-sm text-white/55 hover:bg-[#1a1a1a]"
              onClick={() => { onNavigate(goal.id); onClose() }}
            >Open</button>
            {nodeState === 'idle' && node.canStart && !isMystery && (
              <button
                type="button"
                disabled={isPending}
                className="rounded-xl border border-green-800 bg-green-950/30 px-4 py-2 text-sm text-green-400 hover:bg-green-900/30 disabled:opacity-40"
                onClick={() => { onStartGoal(goal); onClose() }}
              >Start</button>
            )}
            {nodeState === 'active' && (
              <button
                type="button"
                disabled={isPending}
                className="rounded-xl border border-[#333] px-4 py-2 text-sm text-white/70 hover:bg-[#1a1a1a] disabled:opacity-40"
                onClick={() => { onEndGoal(goal); onClose() }}
              >End</button>
            )}
            {nodeState !== 'done' && (
              <button
                type="button"
                disabled={isPending}
                className="rounded-xl border border-amber-800 bg-amber-950/30 px-4 py-2 text-sm text-amber-400 hover:bg-amber-900/30 disabled:opacity-40"
                onClick={() => setRepairOpen(true)}
              >Repair</button>
            )}
          </div>
        </div>
      </div>
      {repairOpen && (
        <RepairSheet
          goal={goal}
          onSubmit={(r) => onRepairGoal(goal, r)}
          onClose={() => setRepairOpen(false)}
        />
      )}
    </>
  )
}

/* ─── canvas helpers ────────────────────────────────────────────────────── */

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  let i = 0

  while (i < words.length && lines.length < maxLines) {
    const word = words[i]
    const test = current ? current + ' ' + word : word
    if (ctx.measureText(test).width <= maxW) {
      current = test
      i++
    } else if (current) {
      lines.push(current)
      current = ''
    } else {
      lines.push(word)
      i++
    }
  }
  if (current && lines.length < maxLines) lines.push(current)

  if (i < words.length && lines.length > 0) {
    let last = lines[lines.length - 1]
    while (last.length > 0 && ctx.measureText(last + '…').width > maxW) {
      last = last.slice(0, -1)
    }
    lines[lines.length - 1] = last + '…'
  }
  return lines
}

/* ─── canvas component ──────────────────────────────────────────────────── */

function PathCanvas({
  nodes,
  width,
  height,
  hasMysteryZone,
  initialFocusIdx,
  onSelect,
}: {
  nodes: PathNode[]
  width: number
  height: number
  hasMysteryZone: boolean
  initialFocusIdx: number
  onSelect: (n: PathNode) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offsetRef = useRef(0)
  const dragRef = useRef<{
    startY: number
    startOffset: number
    moved: boolean
    pointerId: number
  } | null>(null)
  const rafRef = useRef<number | null>(null)
  const mountedScrolledRef = useRef(false)

  const n = nodes.length
  const contentH = n > 0
    ? PT + (n - 1) * SY + NR * 2 + PB + LABEL_GAP + LABEL_LH * LABEL_LINES
    : height
  const maxOffset = Math.max(0, contentH - height)
  const clamp = useCallback((v: number) => Math.max(0, Math.min(maxOffset, v)), [maxOffset])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)

    const offset = offsetRef.current
    const positionOf = (i: number) => ({
      x: nodeXAt(i, width),
      y: nodeYAt(i, contentH) - offset,
    })

    // ── chapter territory labels (map layer, drawn first / behind path) ──
    const chapterStarts: Array<{ idx: number; title: string }> = []
    for (let i = 0; i < n; i++) {
      if (nodes[i].chapterTitle) chapterStarts.push({ idx: i, title: nodes[i].chapterTitle! })
    }
    for (let c = 0; c < chapterStarts.length; c++) {
      const { idx: si, title } = chapterStarts[c]
      const ei = c + 1 < chapterStarts.length ? chapterStarts[c + 1].idx - 1 : n - 1
      const { x: nx, y: sy } = positionOf(si)
      const ey = positionOf(ei).y
      const zoneY = (sy + ey) / 2

      // zone watermark — large, very faint, centered in the chapter's Y range
      if (zoneY > -60 && zoneY < height + 60) {
        ctx.save()
        ctx.font = 'bold 17px ui-sans-serif, system-ui, -apple-system, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = 'rgba(255,255,255,0.055)'
        ctx.fillText(title.toUpperCase(), width / 2, zoneY)
        ctx.restore()
      }

      // side margin label — small, on the side opposite the chapter-start node
      if (sy > -20 && sy < height + 20) {
        const onRight = nx >= width / 2
        ctx.save()
        ctx.font = '500 8px ui-sans-serif, system-ui, -apple-system, sans-serif'
        ctx.textAlign = onRight ? 'left' : 'right'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = 'rgba(255,255,255,0.28)'
        ctx.fillText(title.toUpperCase(), onRight ? 7 : width - 7, sy)
        ctx.restore()
      }
    }

    // ── dashed bezier edges between consecutive nodes ──
    ctx.lineCap = 'round'
    ctx.lineWidth = 3
    ctx.setLineDash([5, 8])
    for (let i = 0; i < n - 1; i++) {
      const a = positionOf(i)
      const b = positionOf(i + 1)
      if ((a.y < -60 && b.y < -60) || (a.y > height + 60 && b.y > height + 60)) continue
      const bright =
        nodes[i].nodeState === 'done' &&
        (nodes[i + 1].nodeState === 'done' || nodes[i + 1].nodeState === 'active')
      ctx.strokeStyle = bright ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.15)'
      ctx.beginPath()
      ctx.moveTo(a.x, a.y - NR)
      ctx.bezierCurveTo(
        a.x, a.y - SY * 0.42,
        b.x, b.y + SY * 0.42,
        b.x, b.y + NR,
      )
      ctx.stroke()
    }
    ctx.setLineDash([])

    // ── nodes ──
    const now = performance.now()
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      const { x, y } = positionOf(i)
      if (y < -90 || y > height + 90) continue

      // active pulse halo
      if (node.nodeState === 'active') {
        const t = (now / 1400) % 1
        const r1 = NR + 6 + Math.sin(t * Math.PI * 2) * 3
        ctx.beginPath()
        ctx.arc(x, y, r1, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.35)'
        ctx.lineWidth = 3
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(x, y, r1 + 8, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.12)'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // mystery slow drifting halo
      if (node.isMystery) {
        const t = (now / 3200) % 1
        const r1 = NR + 5 + Math.sin(t * Math.PI * 2) * 2.5
        ctx.beginPath()
        ctx.arc(x, y, r1, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.18)'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // circle fill + border
      ctx.beginPath()
      ctx.arc(x, y, NR, 0, Math.PI * 2)
      if (node.nodeState === 'done') {
        ctx.fillStyle = '#ffffff'
        ctx.fill()
      } else if (node.nodeState === 'active') {
        ctx.fillStyle = '#22c55e'
        ctx.fill()
      } else if (node.isMystery) {
        ctx.fillStyle = '#1a1325'  // faint violet-tinged dark
        ctx.fill()
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.5)'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        ctx.fillStyle = '#161616'
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // glyph inside circle
      ctx.font = 'bold 22px ui-sans-serif, system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      let glyph: string
      let glyphColor: string
      if (node.nodeState === 'done') { glyph = '✓'; glyphColor = '#0a0a0a' }
      else if (node.nodeState === 'active') { glyph = String(node.num); glyphColor = '#ffffff' }
      else if (node.isMystery) { glyph = '?'; glyphColor = 'rgba(196, 181, 253, 0.85)' }
      else { glyph = String(node.num); glyphColor = 'rgba(255,255,255,0.45)' }
      ctx.fillStyle = glyphColor
      ctx.fillText(glyph, x, y + 1)

      // label below
      const labelColor =
        node.isMystery       ? 'rgba(196, 181, 253, 0.55)' :
        node.nodeState === 'idle' ? 'rgba(255,255,255,0.55)' :
        '#ffffff'
      ctx.fillStyle = labelColor
      const labelText = node.isMystery ? '• • •' : node.goal.title
      ctx.font = node.isMystery
        ? '500 13px ui-sans-serif, system-ui, -apple-system, sans-serif'
        : '600 12px ui-sans-serif, system-ui, -apple-system, sans-serif'
      const lines = wrapText(ctx, labelText, LABEL_MAX_W, LABEL_LINES)
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], x, y + NR + LABEL_GAP + li * LABEL_LH)
      }

    }

    // ── mystery zone: path continues and dissolves into black ────────────
    if (hasMysteryZone && n > 0) {
      const { y: topY } = positionOf(n - 1)

      // path ghost arcs — continue the winding road upward, fading out
      ctx.lineCap = 'round'
      for (let s = 0; s < 5; s++) {
        const ai = n - 1 + s
        const bi = n + s
        const ax = nodeXAt(ai, width)
        const ay = nodeYAt(ai, contentH) - offset
        const bx = nodeXAt(bi, width)
        const by = nodeYAt(bi, contentH) - offset
        if (ay < -SY * 2 && by < -SY * 2) break
        const alpha = 0.30 * Math.pow(0.28, s)
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`
        ctx.lineWidth = 2.5
        ctx.setLineDash([4, 10])
        const startY = s === 0 ? ay - NR : ay  // first arc starts at circle edge, not center
        ctx.beginPath()
        ctx.moveTo(ax, startY)
        ctx.bezierCurveTo(ax, ay - SY * 0.42, bx, by + SY * 0.42, bx, by)
        ctx.stroke()
      }
      ctx.setLineDash([])

      // gradient overlay: starts transparent at the last node, goes solid black ~1 spacing above
      const fadeFrom = topY + NR          // bottom edge of last node
      const fadeTo   = Math.max(0, topY - SY * 0.75)
      if (fadeFrom > fadeTo) {
        const grad = ctx.createLinearGradient(0, fadeFrom, 0, fadeTo)
        grad.addColorStop(0,    'rgba(0,0,0,0)')
        grad.addColorStop(0.55, 'rgba(0,0,0,0.88)')
        grad.addColorStop(1,    'rgba(0,0,0,1)')
        ctx.fillStyle = grad
        ctx.fillRect(0, fadeTo, width, fadeFrom - fadeTo)
      }
      if (fadeTo > 0) {
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, width, fadeTo)
      }
    }
  }, [nodes, width, height, n, contentH, hasMysteryZone])

  // rAF only while something needs animating
  useEffect(() => {
    const needsAnim = nodes.some((nd) => nd.nodeState === 'active' || nd.isMystery)
    draw()
    if (!needsAnim) return

    let alive = true
    const tick = () => {
      if (!alive) return
      draw()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      alive = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [draw, nodes])

  // configure backing store for DPR
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
    canvas.style.width = width + 'px'
    canvas.style.height = height + 'px'
    draw()
  }, [width, height, draw])

  // initial autoscroll once
  useEffect(() => {
    if (mountedScrolledRef.current || n === 0) return
    if (initialFocusIdx < 0) { mountedScrolledRef.current = true; return }
    const targetY = nodeYAt(initialFocusIdx, contentH)
    offsetRef.current = clamp(targetY - height * 0.45)
    mountedScrolledRef.current = true
    draw()
  }, [n, initialFocusIdx, contentH, height, clamp, draw])

  useEffect(() => {
    offsetRef.current = clamp(offsetRef.current)
    draw()
  }, [maxOffset, clamp, draw])

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = {
      startY: e.clientY,
      startOffset: offsetRef.current,
      moved: false,
      pointerId: e.pointerId,
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dy = e.clientY - d.startY
    if (Math.abs(dy) > 4) d.moved = true
    offsetRef.current = clamp(d.startOffset - dy)
    draw()
  }
  function endDrag(e: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) {
    const d = dragRef.current
    dragRef.current = null
    try { canvasRef.current?.releasePointerCapture(e.pointerId) } catch { /* */ }
    if (!d || cancelled || d.moved) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const offset = offsetRef.current
    for (let i = 0; i < n; i++) {
      const nx = nodeXAt(i, width)
      const ny = nodeYAt(i, contentH) - offset
      const dx = px - nx
      const dyh = py - ny
      const rHit = NR + HIT_PAD
      if (dx * dx + dyh * dyh <= rHit * rHit) {
        onSelect(nodes[i])
        return
      }
    }
  }
  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    offsetRef.current = clamp(offsetRef.current + e.deltaY)
    draw()
  }

  if (n === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <p className="text-sm text-white/30">No goals yet.</p>
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      className="block cursor-grab select-none active:cursor-grabbing"
      style={{ width, height, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      onWheel={onWheel}
    />
  )
}

/* ─── main view ─────────────────────────────────────────────────────────── */

export default function CurrentGoalsView({
  goals,
  pendingGoalIndex,
  statusMessage,
  onNavigate,
  onStartGoal,
  onEndGoal,
  onRepairGoal,
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
      const w = Math.max(280, Math.floor(rect.width))
      const h = Math.max(360, Math.floor(window.innerHeight - rect.top - 110))
      setDim({ w, h })
    }
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      obs.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Flatten the whole journey to its current leaves (DFS in subgoal order).
  // Goals that are atomic now show as themselves; goals that are still
  // pending-decomposition (leaf in the tree but requiredTime ≥ threshold)
  // show as mysterious placeholders.
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
    if (isMystery) {
      mysteryCount++
      continue  // no mystery nodes shown — shadow starts from last known node
    }
    const canStart = nodeState === 'idle' && !firstStartableAssigned
    if (canStart) firstStartableAssigned = true

    const chapterTitle = g.parent !== prevParentIndex && g.parent !== null
      ? findGoalByGlobalIndex(goals, g.parent)?.title
      : undefined
    prevParentIndex = g.parent

    pathNodes.push({ goal: g, nodeState, num: num++, canStart, isMystery: false, chapterTitle })
  }

  // focus: active first, else last done, else first idle
  let focusIdx = pathNodes.findIndex((nd) => nd.nodeState === 'active')
  if (focusIdx < 0) {
    for (let i = pathNodes.length - 1; i >= 0; i--) {
      if (pathNodes[i].nodeState === 'done') { focusIdx = i; break }
    }
  }
  if (focusIdx < 0) focusIdx = pathNodes.findIndex((nd) => nd.nodeState === 'idle')

  const doneCount    = pathNodes.filter((nd) => nd.nodeState === 'done').length
  const knownCount   = pathNodes.filter((nd) => !nd.isMystery).length

  return (
    <div className="flex h-full flex-col">
      <header className="mb-3 flex shrink-0 items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Session</h1>
          {statusMessage
            ? <p className="mt-0.5 text-xs text-white/40">{statusMessage}</p>
            : pathNodes.length > 0 && (
                <p className="mt-0.5 text-xs text-white/40">
                  {doneCount}/{knownCount} done
                  {mysteryCount > 0 && <span className="text-violet-300/50"> · beyond the fog</span>}
                </p>
              )
          }
        </div>
      </header>

      <div ref={wrapperRef} className="relative w-full flex-1">
        {dim.w > 0 && dim.h > 0 && (
          <PathCanvas
            nodes={pathNodes}
            width={dim.w}
            height={dim.h}
            hasMysteryZone={mysteryCount > 0}
            initialFocusIdx={focusIdx}
            onSelect={setSelected}
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
