import { useCallback, useEffect, useMemo, useRef } from 'react'

export type NodeState = 'done' | 'active' | 'idle'

export interface PathNodeData {
  key: number
  title: string
  nodeState: NodeState
  num: number
  isMystery: boolean
  chapterTitle?: string
  tintColor?: string
  sideOverride?: -1 | 1
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
const CHAPTER_EXTRA = 90

export function nodeXAt(i: number, vw: number): number {
  return vw / 2 + Math.min(vw * 0.27, 96) * Math.sin((i * Math.PI) / 2)
}

function nodeXForNode(i: number, node: PathNodeData, vw: number): number {
  if (node.sideOverride !== undefined)
    return vw / 2 + Math.min(vw * 0.27, 96) * node.sideOverride
  return nodeXAt(i, vw)
}

function chapterExtraUpTo(nodes: PathNodeData[], i: number): number {
  let s = 0
  for (let j = 1; j <= i; j++) if (nodes[j]?.chapterTitle) s += CHAPTER_EXTRA
  return s
}

function totalChapterExtra(nodes: PathNodeData[]): number {
  let s = 0
  for (let j = 1; j < nodes.length; j++) if (nodes[j].chapterTitle) s += CHAPTER_EXTRA
  return s
}

export function nodeYAt(i: number, contentH: number, nodes?: PathNodeData[]): number {
  return contentH - PB - PATH_NR - i * PATH_SY - (nodes ? chapterExtraUpTo(nodes, i) : 0)
}

export function calcContentH(nodes: PathNodeData[] | number, height: number): number {
  if (typeof nodes === 'number') {
    const n = nodes
    return n > 0 ? PT + (n-1)*PATH_SY + PATH_NR*2 + PB + LABEL_GAP + LABEL_LH*LABEL_LINES : height
  }
  const n = nodes.length
  return n > 0
    ? PT + (n-1)*PATH_SY + totalChapterExtra(nodes) + PATH_NR*2 + PB + LABEL_GAP + LABEL_LH*LABEL_LINES
    : height
}

function drawStarPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outerR: number, innerR: number) {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2
    const r = i % 2 === 0 ? outerR : innerR
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
  }
  ctx.closePath()
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = '', i = 0
  while (i < words.length && lines.length < maxLines) {
    const test = cur ? cur + ' ' + words[i] : words[i]
    if (ctx.measureText(test).width <= maxW) { cur = test; i++ }
    else if (cur) { lines.push(cur); cur = '' }
    else { lines.push(words[i]); i++ }
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  if (i < words.length && lines.length > 0) {
    let last = lines[lines.length - 1]
    while (last.length > 0 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1)
    lines[lines.length - 1] = last + '…'
  }
  return lines
}

export function PathCanvas({
  nodes, width, height, hasMysteryZone, initialFocusIdx, onSelect, userOverlay,
}: {
  nodes: PathNodeData[]
  width: number
  height: number
  hasMysteryZone: boolean
  initialFocusIdx: number
  onSelect: (idx: number) => void
  userOverlay?: { nodeIdx: number; label: string; color: string }
}) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const chapterDivsRef = useRef<(HTMLDivElement | null)[]>([])
  const offsetRef   = useRef(0)
  const dragRef     = useRef<{ startY: number; startOffset: number; moved: boolean; pointerId: number } | null>(null)
  const rafRef      = useRef<number | null>(null)
  const mountedRef  = useRef(false)

  const n = nodes.length
  const contentH = useMemo(() => calcContentH(nodes, height), [nodes, height])
  const maxOffset = Math.max(0, contentH - height)
  const clamp = useCallback((v: number) => Math.max(0, Math.min(maxOffset, v)), [maxOffset])

  const nodeYsBase = useMemo(() => {
    const ys = new Array<number>(n)
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
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, width, height)

    const offset = offsetRef.current
    const now    = performance.now()
    const posOf  = (i: number) => ({ x: nodeXForNode(i, nodes[i]!, width), y: nodeYsBase[i] - offset })

    /* chapter divider positions */
    let ci = 0
    for (let i = 0; i < n; i++) {
      if (!nodes[i].chapterTitle) continue
      const el = chapterDivsRef.current[ci++]
      if (!el) continue
      const gc = posOf(i).y + (PATH_SY + CHAPTER_EXTRA) / 2
      el.style.opacity = (gc > -40 && gc < height + 40) ? '1' : '0'
      el.style.transform = `translateY(${Math.round(gc)}px) translateY(-50%)`
    }

    /* ── PATH EDGES ── simple dashed bezier, ui-2 style ── */
    ctx.lineCap = 'round'
    ctx.setLineDash([6, 9])

    for (let i = 0; i < n - 1; i++) {
      const a = posOf(i), b = posOf(i + 1)
      if ((a.y < -80 && b.y < -80) || (a.y > height + 80 && b.y > height + 80)) continue

      const isDone  = nodes[i].nodeState === 'done'
      const nxt     = nodes[i + 1].nodeState
      const bright  = isDone && (nxt === 'done' || nxt === 'active')
      const tint    = nodes[i].tintColor ?? nodes[i + 1].tintColor

      const c1x = a.x, c1y = a.y - PATH_SY * 0.42
      const c2x = b.x, c2y = b.y + PATH_SY * 0.42

      ctx.lineWidth = 4
      if (tint && bright) {
        ctx.strokeStyle = tint + 'cc'
      } else if (bright) {
        ctx.strokeStyle = 'rgba(255,255,255,0.82)'
      } else if (tint) {
        ctx.strokeStyle = tint + '44'
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.13)'
      }

      ctx.beginPath()
      ctx.moveTo(a.x, a.y - PATH_NR)
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, b.x, b.y + PATH_NR)
      ctx.stroke()
    }
    ctx.setLineDash([])

    /* ── NODES ── */
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      const { x, y } = posOf(i)
      if (y < -90 || y > height + 90) continue

      /* active pulse ring */
      if (node.nodeState === 'active') {
        const pulse = 0.5 + 0.5 * Math.sin(now / 700)
        const ac = node.tintColor ?? '#ffffff'
        ctx.beginPath(); ctx.arc(x, y, PATH_NR + 7 + pulse * 4, 0, Math.PI * 2)
        ctx.strokeStyle = (node.tintColor ? ac : 'rgba(255,255,255,') +
          (node.tintColor ? `${Math.round((0.18 + pulse * 0.14) * 255).toString(16).padStart(2,'0')}` : `${0.18 + pulse * 0.14})`)
        ctx.lineWidth = 2; ctx.stroke()
        // second outer ring
        ctx.beginPath(); ctx.arc(x, y, PATH_NR + 16 + pulse * 5, 0, Math.PI * 2)
        ctx.strokeStyle = node.tintColor
          ? ac + Math.round((0.07 + pulse * 0.05) * 255).toString(16).padStart(2,'0')
          : `rgba(255,255,255,${0.07 + pulse * 0.05})`
        ctx.lineWidth = 1.5; ctx.stroke()
      }

      /* mystery ring */
      if (node.isMystery) {
        const t = (now / 3200) % 1
        ctx.beginPath(); ctx.arc(x, y, PATH_NR + 6 + Math.sin(t * Math.PI * 2) * 2, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(167,139,250,0.22)'; ctx.lineWidth = 1.5; ctx.stroke()
      }

      /* circle fill */
      ctx.beginPath(); ctx.arc(x, y, PATH_NR, 0, Math.PI * 2)
      if (node.nodeState === 'done') {
        ctx.fillStyle = node.tintColor ?? '#ffffff'
        ctx.fill()
        // subtle halo for done
        ctx.beginPath(); ctx.arc(x, y, PATH_NR + 3, 0, Math.PI * 2)
        ctx.strokeStyle = node.tintColor ? node.tintColor + '33' : 'rgba(255,255,255,0.10)'
        ctx.lineWidth = 3; ctx.stroke()
      } else if (node.nodeState === 'active') {
        ctx.fillStyle = node.tintColor ?? '#ffffff'
        ctx.fill()
      } else if (node.isMystery) {
        ctx.fillStyle = '#1a1325'; ctx.fill()
        ctx.setLineDash([4,4])
        ctx.strokeStyle = 'rgba(167,139,250,0.45)'; ctx.lineWidth = 2; ctx.stroke()
        ctx.setLineDash([])
      } else {
        // idle
        ctx.fillStyle = '#1a1a1a'; ctx.fill()
        ctx.strokeStyle = node.tintColor ? node.tintColor + '66' : 'rgba(255,255,255,0.22)'
        ctx.lineWidth = 2.5; ctx.stroke()
      }

      /* glyph / star */
      if (node.nodeState === 'done') {
        const sc = (node.tintColor && node.tintColor !== '#ffffff') ? '#ffffff' : '#0a0a0a'
        drawStarPath(ctx, x, y, 12, 5)
        ctx.fillStyle = sc; ctx.fill()
        ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.lineWidth = 3; ctx.strokeStyle = sc; ctx.stroke()
        ctx.lineJoin = 'miter'; ctx.lineCap = 'butt'
      } else if (node.nodeState === 'active') {
        ctx.font = 'bold 22px ui-sans-serif,system-ui,-apple-system,sans-serif'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillStyle = (node.tintColor && node.tintColor !== '#ffffff') ? '#ffffff' : '#0a0a0a'
        ctx.fillText(String(node.num), x, y + 1)
      } else {
        ctx.font = 'bold 22px ui-sans-serif,system-ui,-apple-system,sans-serif'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        const glyph  = node.isMystery ? '?' : String(node.num)
        const gColor = node.isMystery ? 'rgba(196,181,253,0.70)'
          : node.tintColor ? node.tintColor + 'bb'
          : 'rgba(255,255,255,0.38)'
        ctx.fillStyle = gColor; ctx.fillText(glyph, x, y + 1)
      }

      /* label */
      const lCol = node.isMystery ? 'rgba(196,181,253,0.85)'
        : node.nodeState === 'done'
          ? (node.tintColor ? node.tintColor + 'ff' : 'rgba(255,255,255,0.85)')
        : node.nodeState === 'active'
          ? (node.tintColor ? node.tintColor + 'ff' : '#ffffff')
        : node.tintColor ? node.tintColor + 'dd'
        : 'rgba(255,255,255,0.72)'

      const lText = node.isMystery ? '• • •' : node.title
      ctx.font = node.isMystery
        ? '500 13px ui-sans-serif,system-ui,-apple-system,sans-serif'
        : '600 12px ui-sans-serif,system-ui,-apple-system,sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
      const lines = wrapText(ctx, lText, LABEL_MAX_W, LABEL_LINES)
      for (let li = 0; li < lines.length; li++) {
        const lx = x, ly = y + PATH_NR + LABEL_GAP + li * LABEL_LH
        // subtle shadow
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.fillText(lines[li], lx + 1, ly + 1)
        ctx.fillStyle = lCol
        ctx.fillText(lines[li], lx, ly)
      }
    }

    /* user overlay avatar */
    if (userOverlay && userOverlay.nodeIdx >= 0 && userOverlay.nodeIdx < n) {
      const { x, y } = posOf(userOverlay.nodeIdx)
      if (y >= -90 && y <= height + 90) {
        const ar = 13, ax = x + PATH_NR * 0.72, ay = y - PATH_NR * 0.72
        ctx.beginPath(); ctx.arc(ax, ay, ar + 2, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fill()
        ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2)
        ctx.fillStyle = userOverlay.color; ctx.fill()
        ctx.font = 'bold 11px ui-sans-serif,system-ui,-apple-system,sans-serif'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillStyle = '#fff'; ctx.fillText(userOverlay.label, ax, ay + 0.5)
      }
    }

    /* mystery zone fade */
    if (hasMysteryZone && n > 0) {
      const topNodeY = nodeYsBase[n - 1]
      const topY = topNodeY - offset

      // Continue the dashed path upward for a few more steps before fade
      ctx.lineCap = 'round'; ctx.setLineDash([6, 9])
      for (let s = 0; s < 5; s++) {
        const ai = n - 1 + s, bi = n + s
        const axm = nodeXForNode(ai, nodes[ai] ?? nodes[n-1]!, width)
        const aym = topNodeY - s * PATH_SY - offset
        const bxm = nodeXForNode(bi, nodes[bi] ?? nodes[n-1]!, width)
        const bym = topNodeY - (s + 1) * PATH_SY - offset
        if (aym < -PATH_SY * 3 && bym < -PATH_SY * 3) break
        const alpha = 0.38 * Math.pow(0.55, s)
        ctx.lineWidth = 4
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`
        const sY = s === 0 ? aym - PATH_NR : aym
        ctx.beginPath(); ctx.moveTo(axm, sY)
        ctx.bezierCurveTo(axm, aym - PATH_SY * 0.42, bxm, bym + PATH_SY * 0.42, bxm, bym)
        ctx.stroke()
      }
      ctx.setLineDash([])

      const fadeFrom = topY + PATH_NR
      const fadeTo   = Math.max(0, topY - PATH_SY * 2.5)
      if (fadeFrom > fadeTo) {
        const grad = ctx.createLinearGradient(0, fadeFrom, 0, fadeTo)
        grad.addColorStop(0,    'rgba(10,10,10,0)')
        grad.addColorStop(0.45, 'rgba(10,10,10,0.80)')
        grad.addColorStop(1,    'rgba(10,10,10,1)')
        ctx.fillStyle = grad; ctx.fillRect(0, fadeTo, width, fadeFrom - fadeTo)
      }
      if (fadeTo > 0) { ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, width, fadeTo) }
    }
  }, [nodes, width, height, n, contentH, nodeYsBase, hasMysteryZone, userOverlay])

  /* RAF — only animate while active/mystery nodes exist */
  useEffect(() => {
    const needsAnim = nodes.some(nd => nd.nodeState === 'active' || nd.isMystery)
    draw()
    if (!needsAnim) return
    let alive = true
    const tick = () => { if (!alive) return; draw(); rafRef.current = requestAnimationFrame(tick) }
    rafRef.current = requestAnimationFrame(tick)
    return () => { alive = false; if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [draw, nodes])

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width  = Math.max(1, Math.floor(width  * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px'
    draw()
  }, [width, height, draw])

  useEffect(() => {
    if (mountedRef.current || n === 0) return
    if (initialFocusIdx < 0) { mountedRef.current = true; return }
    const targetY = nodeYsBase[initialFocusIdx] ?? nodeYAt(initialFocusIdx, contentH)
    offsetRef.current = clamp(targetY - height * 0.45)
    mountedRef.current = true; draw()
  }, [n, initialFocusIdx, contentH, height, clamp, draw, nodeYsBase])

  useEffect(() => { offsetRef.current = clamp(offsetRef.current); draw() }, [maxOffset, clamp, draw])

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startOffset: offsetRef.current, moved: false, pointerId: e.pointerId }
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current; if (!d || d.pointerId !== e.pointerId) return
    const dy = e.clientY - d.startY
    if (Math.abs(dy) > 4) d.moved = true
    offsetRef.current = clamp(d.startOffset - dy); draw()
  }
  function endDrag(e: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) {
    const d = dragRef.current; dragRef.current = null
    try { canvasRef.current?.releasePointerCapture(e.pointerId) } catch { /**/ }
    if (!d || cancelled || d.moved) return
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    for (let i = 0; i < n; i++) {
      const nx = nodeXForNode(i, nodes[i]!, width)
      const ny = (nodeYsBase[i] ?? nodeYAt(i, contentH)) - offsetRef.current
      const dx = px - nx, dh = py - ny
      if (dx*dx + dh*dh <= (PATH_NR + HIT_PAD)**2) { onSelect(i); return }
      const lt = ny + PATH_NR + LABEL_GAP - HIT_PAD
      const lb = ny + PATH_NR + LABEL_GAP + LABEL_LH * LABEL_LINES + HIT_PAD
      if (px >= nx - LABEL_MAX_W/2 - HIT_PAD && px <= nx + LABEL_MAX_W/2 + HIT_PAD && py >= lt && py <= lb)
        { onSelect(i); return }
    }
  }
  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) { offsetRef.current = clamp(offsetRef.current + e.deltaY); draw() }

  if (n === 0) return (
    <div className="flex items-center justify-center" style={{ height }}>
      <p className="text-sm text-white/30">No goals yet.</p>
    </div>
  )

  const chapterNodes = nodes.filter(nd => nd.chapterTitle)

  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      <canvas ref={canvasRef} className="block cursor-grab select-none active:cursor-grabbing"
        style={{ width, height, touchAction: 'none' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={e => endDrag(e, false)} onPointerCancel={e => endDrag(e, true)}
        onWheel={onWheel} />
      {chapterNodes.map((nd, c) => (
        <div key={nd.key} ref={el => { chapterDivsRef.current[c] = el }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, pointerEvents: 'none', opacity: 0, transition: 'opacity 0.3s ease' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 24px' }}>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.12)' }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.10em', textTransform: 'uppercase', color: 'rgba(255,255,255,.40)', fontFamily: 'ui-sans-serif,system-ui,-apple-system,sans-serif', maxWidth: 180, textAlign: 'center', lineHeight: 1.4 }}>
              {nd.chapterTitle}
            </span>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.12)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
