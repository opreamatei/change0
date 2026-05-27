import { useCallback, useEffect, useMemo, useRef } from 'react'

export type NodeState = 'done' | 'active' | 'idle'

export interface PathNodeData {
  key: number
  title: string
  nodeState: NodeState
  num: number
  isMystery: boolean
  chapterTitle?: string
  tintColor?: string   // custom accent colour for idle/active nodes (collab use)
}

export const PATH_NR = 32
export const PATH_SY = 150
const PT = 80
const PB = 140
const LABEL_GAP = 14
const LABEL_LH = 14
const LABEL_MAX_W = 130
const LABEL_LINES = 2
const HIT_PAD = 14
const CHAPTER_EXTRA = 90   // extra vertical gap when a chapter title is present

export function nodeXAt(i: number, vw: number): number {
  return vw / 2 + Math.min(vw * 0.27, 96) * Math.sin((i * Math.PI) / 2)
}

/** Cumulative extra offset from chapter titles for nodes 0..i */
function chapterExtraUpTo(nodes: PathNodeData[], i: number): number {
  let sum = 0
  for (let j = 1; j <= i; j++) {
    if (nodes[j]?.chapterTitle) sum += CHAPTER_EXTRA
  }
  return sum
}

/** Total extra from all chapter titles */
function totalChapterExtra(nodes: PathNodeData[]): number {
  let sum = 0
  for (let j = 1; j < nodes.length; j++) {
    if (nodes[j].chapterTitle) sum += CHAPTER_EXTRA
  }
  return sum
}

export function nodeYAt(i: number, contentH: number, nodes?: PathNodeData[]): number {
  const extra = nodes ? chapterExtraUpTo(nodes, i) : 0
  return contentH - PB - PATH_NR - i * PATH_SY - extra
}

export function calcContentH(nodes: PathNodeData[] | number, height: number): number {
  if (typeof nodes === 'number') {
    const n = nodes
    return n > 0
      ? PT + (n - 1) * PATH_SY + PATH_NR * 2 + PB + LABEL_GAP + LABEL_LH * LABEL_LINES
      : height
  }
  const n = nodes.length
  return n > 0
    ? PT + (n - 1) * PATH_SY + totalChapterExtra(nodes) + PATH_NR * 2 + PB + LABEL_GAP + LABEL_LH * LABEL_LINES
    : height
}

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

export function PathCanvas({
  nodes,
  width,
  height,
  hasMysteryZone,
  initialFocusIdx,
  onSelect,
  userOverlay,
}: {
  nodes: PathNodeData[]
  width: number
  height: number
  hasMysteryZone: boolean
  initialFocusIdx: number
  onSelect: (idx: number) => void
  userOverlay?: { nodeIdx: number; label: string; color: string }
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chapterDivsRef = useRef<(HTMLDivElement | null)[]>([])
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
  const contentH = useMemo(() => calcContentH(nodes, height), [nodes, height])
  const maxOffset = Math.max(0, contentH - height)
  const clamp = useCallback((v: number) => Math.max(0, Math.min(maxOffset, v)), [maxOffset])

  /** Precomputed absolute Y for each node (no scroll offset). */
  const nodeYsBase = useMemo(() => {
    const ys: number[] = new Array(n)
    let cumExtra = 0
    for (let i = 0; i < n; i++) {
      if (i > 0 && nodes[i].chapterTitle) cumExtra += CHAPTER_EXTRA
      ys[i] = contentH - PB - PATH_NR - i * PATH_SY - cumExtra
    }
    return ys
  }, [nodes, n, contentH])

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
      y: nodeYsBase[i] - offset,
    })

    // chapter divider labels — update HTML overlay positions imperatively
    let chapterIdx = 0
    for (let i = 0; i < n; i++) {
      if (!nodes[i].chapterTitle) continue
      const el = chapterDivsRef.current[chapterIdx++]
      if (!el) continue
      const nodeY = positionOf(i).y
      // chapter title sits in the middle of the CHAPTER_EXTRA gap below this node
      const gapCenter = nodeY + (PATH_SY + CHAPTER_EXTRA) / 2
      const visible = gapCenter > -40 && gapCenter < height + 40
      el.style.opacity = visible ? '1' : '0'
      el.style.transform = `translateY(${Math.round(gapCenter)}px) translateY(-50%)`
    }

    // dashed bezier edges between consecutive nodes
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
      ctx.moveTo(a.x, a.y - PATH_NR)
      ctx.bezierCurveTo(a.x, a.y - PATH_SY * 0.42, b.x, b.y + PATH_SY * 0.42, b.x, b.y + PATH_NR)
      ctx.stroke()
    }
    ctx.setLineDash([])

    // nodes
    const now = performance.now()
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      const { x, y } = positionOf(i)
      if (y < -90 || y > height + 90) continue

      if (node.nodeState === 'active') {
        const t = (now / 1400) % 1
        const r1 = PATH_NR + 6 + Math.sin(t * Math.PI * 2) * 3
        const activeColor = node.tintColor ?? 'rgb(74,222,128)'
        ctx.beginPath()
        ctx.arc(x, y, r1, 0, Math.PI * 2)
        ctx.strokeStyle = activeColor.replace('rgb', 'rgba').replace(')', ',0.35)')
        ctx.lineWidth = 3
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(x, y, r1 + 8, 0, Math.PI * 2)
        ctx.strokeStyle = activeColor.replace('rgb', 'rgba').replace(')', ',0.12)')
        ctx.lineWidth = 2
        ctx.stroke()
      }

      if (node.isMystery) {
        const t = (now / 3200) % 1
        const r1 = PATH_NR + 5 + Math.sin(t * Math.PI * 2) * 2.5
        ctx.beginPath()
        ctx.arc(x, y, r1, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.18)'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(x, y, PATH_NR, 0, Math.PI * 2)
      if (node.nodeState === 'done') {
        ctx.fillStyle = '#ffffff'
        ctx.fill()
      } else if (node.nodeState === 'active') {
        ctx.fillStyle = node.tintColor ?? '#22c55e'
        ctx.fill()
      } else if (node.isMystery) {
        ctx.fillStyle = '#1a1325'
        ctx.fill()
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.5)'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        // idle
        if (node.tintColor) {
          // collab: tinted dark fill with coloured border
          ctx.fillStyle = node.tintColor + '22'
          ctx.fill()
          ctx.strokeStyle = node.tintColor + '88'
          ctx.lineWidth = 2
          ctx.stroke()
        } else {
          ctx.fillStyle = '#161616'
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,255,255,0.18)'
          ctx.lineWidth = 2
          ctx.stroke()
        }
      }

      ctx.font = 'bold 22px ui-sans-serif, system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      let glyph: string
      let glyphColor: string
      if (node.nodeState === 'done') { glyph = '✓'; glyphColor = '#0a0a0a' }
      else if (node.nodeState === 'active') { glyph = String(node.num); glyphColor = '#ffffff' }
      else if (node.isMystery) { glyph = '?'; glyphColor = 'rgba(196, 181, 253, 0.85)' }
      else {
        glyph = String(node.num)
        glyphColor = node.tintColor ? node.tintColor + 'cc' : 'rgba(255,255,255,0.45)'
      }
      ctx.fillStyle = glyphColor
      ctx.fillText(glyph, x, y + 1)

      const labelColor =
        node.isMystery           ? 'rgba(196, 181, 253, 0.55)' :
        node.nodeState === 'done' ? '#ffffff' :
        node.tintColor            ? node.tintColor + 'dd' :
        'rgba(255,255,255,0.55)'
      ctx.fillStyle = labelColor
      const labelText = node.isMystery ? '• • •' : node.title
      ctx.font = node.isMystery
        ? '500 13px ui-sans-serif, system-ui, -apple-system, sans-serif'
        : '600 12px ui-sans-serif, system-ui, -apple-system, sans-serif'
      const lines = wrapText(ctx, labelText, LABEL_MAX_W, LABEL_LINES)
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], x, y + PATH_NR + LABEL_GAP + li * LABEL_LH)
      }
    }

    // user overlay avatar (e.g. current collab participant)
    if (userOverlay && userOverlay.nodeIdx >= 0 && userOverlay.nodeIdx < n) {
      const { x, y } = positionOf(userOverlay.nodeIdx)
      if (y >= -90 && y <= height + 90) {
        const ar = 13
        const ax = x + PATH_NR * 0.72
        const ay = y - PATH_NR * 0.72
        // shadow ring
        ctx.beginPath()
        ctx.arc(ax, ay, ar + 2, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(0,0,0,0.7)'
        ctx.fill()
        // filled circle
        ctx.beginPath()
        ctx.arc(ax, ay, ar, 0, Math.PI * 2)
        ctx.fillStyle = userOverlay.color
        ctx.fill()
        // initials
        ctx.font = 'bold 11px ui-sans-serif, system-ui, -apple-system, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#ffffff'
        ctx.fillText(userOverlay.label, ax, ay + 0.5)
      }
    }

    // mystery zone: path continues and dissolves into black
    if (hasMysteryZone && n > 0) {
      const topNodeY = nodeYsBase[n - 1]
      const topY = topNodeY - offset
      ctx.lineCap = 'round'
      for (let s = 0; s < 5; s++) {
        const ai = n - 1 + s
        const bi = n + s
        const ax = nodeXAt(ai, width)
        const ay = topNodeY - s * PATH_SY - offset
        const bx = nodeXAt(bi, width)
        const by = topNodeY - (s + 1) * PATH_SY - offset
        if (ay < -PATH_SY * 2 && by < -PATH_SY * 2) break
        const alpha = 0.30 * Math.pow(0.28, s)
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`
        ctx.lineWidth = 2.5
        ctx.setLineDash([4, 10])
        const startY = s === 0 ? ay - PATH_NR : ay
        ctx.beginPath()
        ctx.moveTo(ax, startY)
        ctx.bezierCurveTo(ax, ay - PATH_SY * 0.42, bx, by + PATH_SY * 0.42, bx, by)
        ctx.stroke()
      }
      ctx.setLineDash([])

      const fadeFrom = topY + PATH_NR
      const fadeTo   = Math.max(0, topY - PATH_SY * 0.75)
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
  }, [nodes, width, height, n, contentH, nodeYsBase, hasMysteryZone, userOverlay])

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

  useEffect(() => {
    if (mountedScrolledRef.current || n === 0) return
    if (initialFocusIdx < 0) { mountedScrolledRef.current = true; return }
    const targetY = nodeYsBase[initialFocusIdx] ?? nodeYAt(initialFocusIdx, contentH)
    offsetRef.current = clamp(targetY - height * 0.45)
    mountedScrolledRef.current = true
    draw()
  }, [n, initialFocusIdx, contentH, height, clamp, draw, nodeYsBase])

  useEffect(() => {
    offsetRef.current = clamp(offsetRef.current)
    draw()
  }, [maxOffset, clamp, draw])

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startOffset: offsetRef.current, moved: false, pointerId: e.pointerId }
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
      const ny = (nodeYsBase[i] ?? nodeYAt(i, contentH)) - offset
      const dx = px - nx
      const dyh = py - ny
      const rHit = PATH_NR + HIT_PAD
      if (dx * dx + dyh * dyh <= rHit * rHit) {
        onSelect(i)
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

  const chapterNodes = nodes.filter((nd) => nd.chapterTitle)

  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
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
      {chapterNodes.map((nd, c) => (
        <div
          key={nd.key}
          ref={(el) => { chapterDivsRef.current[c] = el }}
          style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            pointerEvents: 'none', opacity: 0,
            transition: 'opacity 0.35s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px' }}>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.10)' }} />
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '.12em',
              textTransform: 'uppercase', color: 'rgba(255,255,255,.42)',
              fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
              maxWidth: 180, textAlign: 'center', lineHeight: 1.45,
              wordBreak: 'break-word',
            }}>
              {nd.chapterTitle}
            </span>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.10)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
