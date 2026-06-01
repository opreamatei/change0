import { useCallback, useEffect, useMemo, useRef } from 'react'

export type NodeState = 'done' | 'active' | 'idle'

export interface PathNodeData {
  key: number
  title: string
  nodeState: NodeState
  num: number
  isMystery: boolean
  isJournal?: boolean
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
// Scroll headroom reserved above the final node when a mystery zone exists, so
// the fade has room to breathe and the path visibly extends as goals decompose.
const MYSTERY_HEADROOM = PATH_SY * 2.5

// The journey visibly "opens up" toward its end: the last few leaves grow
// progressively larger (each +0.1 of additional scale), and the very last leaf
// of a solo (untinted) journey is drawn in green to mark the finish line.
const SCALE_TAIL_COUNT = 5
const SCALE_TAIL_STEP = 0.1
const SOLO_FINAL_GREEN = '#34d399'
// Manual −15% trim of the base goal-node size (the tail growth scales from this).
const GOAL_BASE_SCALE = 0.85

function tailScale(i: number, n: number): number {
  const fromEnd = n - 1 - i
  if (fromEnd < 0 || fromEnd >= SCALE_TAIL_COUNT) return 1
  // fromEnd 0 (last) → 1.5, … fromEnd 4 (5th-from-last) → 1.1
  return 1 + (SCALE_TAIL_COUNT - fromEnd) * SCALE_TAIL_STEP
}

/* ── colour helpers ──────────────────────────────────────────────────────── */
// Append an alpha to a #rrggbb hex (canvas accepts #rrggbbaa). White strings
// fall through to an rgba() form so non-hex accents still work.
function withAlpha(color: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0')
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color + a
  return color
}

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(color)
  if (!m) return null
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

// Midpoint blend of two hex colours — used to ease one strand's colour into the next.
function mixHex(a: string, b: string): string {
  const ca = parseHex(a), cb = parseHex(b)
  if (!ca || !cb) return a
  const m = ca.map((v, i) => Math.round((v + cb[i]) / 2))
  return `#${m.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export function nodeXAt(i: number, vw: number): number {
  return vw / 2 + Math.min(vw * 0.27, 96) * Math.sin((i * Math.PI) / 2)
}

function nodeXForNode(i: number, node: PathNodeData, vw: number): number {
  if (node.sideOverride !== undefined) {
    // Deterministic horizontal wiggle so the two collab lanes feel organic rather
    // than a rigid two-column grid — a little closer to the solo path's weave.
    const base = vw / 2 + Math.min(vw * 0.27, 96) * node.sideOverride
    const jitter = Math.sin(i * 53.17) * Math.min(vw * 0.06, 22)
    return base + jitter
  }
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

// Open-book glyph used in place of the step number for journal-type goals.
function drawBookPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: string) {
  const w = s, h = s * 0.8
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1.6, s * 0.18)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  // centre spine
  ctx.beginPath(); ctx.moveTo(cx, cy - h); ctx.lineTo(cx, cy + h * 0.95); ctx.stroke()
  // left page
  ctx.beginPath()
  ctx.moveTo(cx, cy - h)
  ctx.quadraticCurveTo(cx - w * 0.55, cy - h * 1.15, cx - w, cy - h * 0.55)
  ctx.lineTo(cx - w, cy + h * 0.85)
  ctx.quadraticCurveTo(cx - w * 0.55, cy + h * 0.45, cx, cy + h * 0.95)
  ctx.stroke()
  // right page
  ctx.beginPath()
  ctx.moveTo(cx, cy - h)
  ctx.quadraticCurveTo(cx + w * 0.55, cy - h * 1.15, cx + w, cy - h * 0.55)
  ctx.lineTo(cx + w, cy + h * 0.85)
  ctx.quadraticCurveTo(cx + w * 0.55, cy + h * 0.45, cx, cy + h * 0.95)
  ctx.stroke()
  ctx.restore()
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
  nodes, width, height, hasMysteryZone, initialFocusIdx, onSelect, onLongPress, userOverlay,
}: {
  nodes: PathNodeData[]
  width: number
  height: number
  hasMysteryZone: boolean
  initialFocusIdx: number
  onSelect: (idx: number) => void
  onLongPress?: (idx: number) => void
  userOverlay?: { nodeIdx: number; label: string; color: string }
}) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const chapterDivsRef = useRef<(HTMLDivElement | null)[]>([])
  const offsetRef   = useRef(0)
  const dragRef     = useRef<{ startX: number; startY: number; startOffset: number; moved: boolean; pointerId: number } | null>(null)
  const rafRef      = useRef<number | null>(null)
  const mountedRef  = useRef(false)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)

  const n = nodes.length

  // Scaled radius for the growing tail, and the effective tint (solo journeys
  // turn their final leaf green; tinted/collab journeys keep their assignee hue).
  const radiusOf = useCallback((i: number) => PATH_NR * GOAL_BASE_SCALE * tailScale(i, n), [n])
  const tintOf = useCallback(
    (i: number): string | undefined => {
      const t = nodes[i]?.tintColor
      if (t !== undefined) return t
      // Only the genuine final leaf of a solo journey turns green. If a mystery
      // zone follows, the server hasn't generated the later nodes yet, so the
      // last *rendered* node isn't actually the finish — keep it the normal hue.
      return i === n - 1 && !hasMysteryZone ? SOLO_FINAL_GREEN : undefined
    },
    [nodes, n, hasMysteryZone],
  )

  const contentH = useMemo(() => {
    const base = calcContentH(nodes, height)
    // Reserve headroom above the final node so the mystery fade never clips the
    // topmost real node and the y-map grows as new (decomposed) nodes appear.
    return hasMysteryZone && nodes.length > 0 ? base + MYSTERY_HEADROOM : base
  }, [nodes, height, hasMysteryZone])
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
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)

    const offset = offsetRef.current
    const now    = performance.now()
    const posOf  = (i: number) => ({ x: nodeXForNode(i, nodes[i]!, width), y: nodeYsBase[i] - offset })

    /* ── colour washes beneath completed paths ──
       Large, soft radial glows in the relevant colour (the assignee's colour in
       multiuser journeys). Additive blend; only the few visible done nodes are
       drawn, so this is effectively free off-screen. */
    const WASH_R = 560
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < n; i++) {
      if (nodes[i].nodeState !== 'done') continue
      const { x, y } = posOf(i)
      if (y < -WASH_R || y > height + WASH_R) continue
      const col = tintOf(i) ?? '#ffffff'
      const isTinted = tintOf(i) !== undefined
      // Solo (white) washes read brighter on black, so keep them softer than
      // participant-coloured journey/together paths.
      const peak = isTinted ? 0.20 : 0.035
      const g = ctx.createRadialGradient(x, y, 0, x, y, WASH_R)
      g.addColorStop(0, withAlpha(col, peak))
      g.addColorStop(0.42, withAlpha(col, peak * (isTinted ? 0.56 : 0.30)))
      g.addColorStop(0.72, withAlpha(col, peak * (isTinted ? 0.20 : 0.08)))
      g.addColorStop(1, withAlpha(col, 0))
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(x, y, WASH_R, 0, Math.PI * 2); ctx.fill()
    }
    ctx.restore()

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
      const colA    = tintOf(i)
      const colB    = tintOf(i + 1)
      const hasTint = colA !== undefined || colB !== undefined

      const c1x = a.x, c1y = a.y - PATH_SY * 0.42
      const c2x = b.x, c2y = b.y + PATH_SY * 0.42

      ctx.lineWidth = 4
      if (hasTint) {
        // Ease one assignee's colour into the next along the segment. The plateaus
        // (0.28 / 0.72) hold each colour before a smooth centred crossover.
        const ca = colA ?? colB ?? '#ffffff'
        const cb = colB ?? colA ?? '#ffffff'
        const alpha = bright ? 0.85 : 0.30
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
        grad.addColorStop(0, withAlpha(ca, alpha))
        grad.addColorStop(0.28, withAlpha(ca, alpha))
        grad.addColorStop(0.5, withAlpha(mixHex(ca, cb), alpha))
        grad.addColorStop(0.72, withAlpha(cb, alpha))
        grad.addColorStop(1, withAlpha(cb, alpha))
        ctx.strokeStyle = grad
      } else if (bright) {
        ctx.strokeStyle = 'rgba(255,255,255,0.82)'
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.13)'
      }

      ctx.beginPath()
      ctx.moveTo(a.x, a.y - radiusOf(i))
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, b.x, b.y + radiusOf(i + 1))
      ctx.stroke()
    }
    ctx.setLineDash([])

    /* ── NODES ── */
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      const { x, y } = posOf(i)
      const r = radiusOf(i)
      const tint = tintOf(i)
      const gscale = r / PATH_NR
      if (y < -90 - r || y > height + 90 + r) continue

      /* active pulse ring */
      if (node.nodeState === 'active') {
        const pulse = 0.5 + 0.5 * Math.sin(now / 700)
        const ac = tint ?? '#ffffff'
        ctx.beginPath(); ctx.arc(x, y, r + 7 + pulse * 4, 0, Math.PI * 2)
        ctx.strokeStyle = (tint ? ac : 'rgba(255,255,255,') +
          (tint ? `${Math.round((0.18 + pulse * 0.14) * 255).toString(16).padStart(2,'0')}` : `${0.18 + pulse * 0.14})`)
        ctx.lineWidth = 2; ctx.stroke()
        // second outer ring
        ctx.beginPath(); ctx.arc(x, y, r + 16 + pulse * 5, 0, Math.PI * 2)
        ctx.strokeStyle = tint
          ? ac + Math.round((0.07 + pulse * 0.05) * 255).toString(16).padStart(2,'0')
          : `rgba(255,255,255,${0.07 + pulse * 0.05})`
        ctx.lineWidth = 1.5; ctx.stroke()
      }

      /* mystery ring */
      if (node.isMystery) {
        const t = (now / 3200) % 1
        ctx.beginPath(); ctx.arc(x, y, r + 6 + Math.sin(t * Math.PI * 2) * 2, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(167,139,250,0.22)'; ctx.lineWidth = 1.5; ctx.stroke()
      }

      /* circle fill */
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      if (node.nodeState === 'done') {
        ctx.fillStyle = tint ?? '#ffffff'
        ctx.fill()
        // subtle halo for done
        ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2)
        ctx.strokeStyle = tint ? tint + '33' : 'rgba(255,255,255,0.10)'
        ctx.lineWidth = 3; ctx.stroke()
      } else if (node.nodeState === 'active') {
        ctx.fillStyle = tint ?? '#ffffff'
        ctx.fill()
      } else if (node.isMystery) {
        ctx.fillStyle = '#1a1325'; ctx.fill()
        ctx.setLineDash([4,4])
        ctx.strokeStyle = 'rgba(167,139,250,0.45)'; ctx.lineWidth = 2; ctx.stroke()
        ctx.setLineDash([])
      } else {
        // idle
        ctx.fillStyle = '#1a1a1a'; ctx.fill()
        ctx.strokeStyle = tint ? tint + '66' : 'rgba(255,255,255,0.22)'
        ctx.lineWidth = 2.5; ctx.stroke()
      }

      /* glyph / star — drawn directly on the disc, no shadow */
      if (node.nodeState === 'done') {
        const sc = (tint && tint !== '#ffffff') ? '#ffffff' : '#000000'
        drawStarPath(ctx, x, y, 12 * gscale, 5 * gscale)
        ctx.fillStyle = sc; ctx.fill()
        ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.lineWidth = 3; ctx.strokeStyle = sc; ctx.stroke()
        ctx.lineJoin = 'miter'; ctx.lineCap = 'butt'
      } else if (node.nodeState === 'active') {
        const ac = (tint && tint !== '#ffffff') ? '#ffffff' : '#000000'
        if (node.isJournal) {
          drawBookPath(ctx, x, y, 10 * gscale, ac)
        } else {
          ctx.font = `bold ${Math.round(22 * gscale)}px ui-sans-serif,system-ui,-apple-system,sans-serif`
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillStyle = ac
          ctx.fillText(String(node.num), x, y + 1)
        }
      } else {
        const gColor = node.isMystery ? 'rgba(196,181,253,0.70)'
          : tint ? tint + 'bb'
          : 'rgba(255,255,255,0.38)'
        if (node.isJournal && !node.isMystery) {
          drawBookPath(ctx, x, y, 10 * gscale, gColor)
        } else {
          ctx.font = `bold ${Math.round(22 * gscale)}px ui-sans-serif,system-ui,-apple-system,sans-serif`
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          const glyph = node.isMystery ? '?' : String(node.num)
          ctx.fillStyle = gColor; ctx.fillText(glyph, x, y + 1)
        }
      }

      /* label */
      const lCol = node.isMystery ? 'rgba(196,181,253,0.85)'
        : node.nodeState === 'done'
          ? (tint ? tint + 'ff' : 'rgba(255,255,255,0.85)')
        : node.nodeState === 'active'
          ? (tint ? tint + 'ff' : '#ffffff')
        : tint ? tint + 'dd'
        : 'rgba(255,255,255,0.72)'

      const lText = node.isMystery ? '• • •' : node.title
      ctx.font = node.isMystery
        ? '500 13px ui-sans-serif,system-ui,-apple-system,sans-serif'
        : '600 12px ui-sans-serif,system-ui,-apple-system,sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
      const lines = wrapText(ctx, lText, LABEL_MAX_W, LABEL_LINES)
      // subtle black shadow on the label text only (legibility over the path)
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.7)'
      ctx.shadowBlur = 4
      ctx.shadowOffsetY = 1
      for (let li = 0; li < lines.length; li++) {
        const lx = x, ly = y + r + LABEL_GAP + li * LABEL_LH
        ctx.fillStyle = lCol
        ctx.fillText(lines[li], lx, ly)
      }
      ctx.restore()
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
        const sY = s === 0 ? aym - radiusOf(n - 1) : aym
        ctx.beginPath(); ctx.moveTo(axm, sY)
        ctx.bezierCurveTo(axm, aym - PATH_SY * 0.42, bxm, bym + PATH_SY * 0.42, bxm, bym)
        ctx.stroke()
      }
      ctx.setLineDash([])

      // Begin the fade just above the topmost real node so the node and its label
      // stay fully lit — only the empty space beyond it dims into the unknown.
      const fadeFrom = topY - radiusOf(n - 1) - 18
      const fadeTo   = Math.max(0, fadeFrom - PATH_SY * 2.5)
      if (fadeFrom > fadeTo) {
        const grad = ctx.createLinearGradient(0, fadeFrom, 0, fadeTo)
        grad.addColorStop(0,    'rgba(0,0,0,0)')
        grad.addColorStop(0.45, 'rgba(0,0,0,0.80)')
        grad.addColorStop(1,    'rgba(0,0,0,1)')
        ctx.fillStyle = grad; ctx.fillRect(0, fadeTo, width, fadeFrom - fadeTo)
      }
      if (fadeTo > 0) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, width, fadeTo) }
    }
  }, [nodes, width, height, n, contentH, nodeYsBase, hasMysteryZone, userOverlay, radiusOf, tintOf])

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

  // Map a viewport point to the node index under it (disc or its label), or -1.
  function hitTestAt(clientX: number, clientY: number): number {
    const canvas = canvasRef.current; if (!canvas) return -1
    const rect = canvas.getBoundingClientRect()
    const px = clientX - rect.left, py = clientY - rect.top
    for (let i = 0; i < n; i++) {
      const nx = nodeXForNode(i, nodes[i]!, width)
      const ny = (nodeYsBase[i] ?? nodeYAt(i, contentH)) - offsetRef.current
      const dx = px - nx, dh = py - ny
      const r = radiusOf(i)
      if (dx*dx + dh*dh <= (r + HIT_PAD)**2) return i
      const lt = ny + r + LABEL_GAP - HIT_PAD
      const lb = ny + r + LABEL_GAP + LABEL_LH * LABEL_LINES + HIT_PAD
      if (px >= nx - LABEL_MAX_W/2 - HIT_PAD && px <= nx + LABEL_MAX_W/2 + HIT_PAD && py >= lt && py <= lb) return i
    }
    return -1
  }
  function clearLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffset: offsetRef.current, moved: false, pointerId: e.pointerId }
    longPressFired.current = false
    if (onLongPress) {
      const cx = e.clientX, cy = e.clientY
      clearLongPress()
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null
        if (dragRef.current?.moved) return
        const idx = hitTestAt(cx, cy)
        if (idx >= 0) { longPressFired.current = true; onLongPress(idx) }
      }, 500)
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current; if (!d || d.pointerId !== e.pointerId) return
    const dy = e.clientY - d.startY
    const dx = e.clientX - d.startX
    // Horizontal motion counts as movement too, so a sideways page-swipe is never
    // mistaken for a node tap.
    if (Math.abs(dy) > 4 || Math.abs(dx) > 4) { d.moved = true; clearLongPress() }
    offsetRef.current = clamp(d.startOffset - dy); draw()
  }
  function endDrag(e: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) {
    const d = dragRef.current; dragRef.current = null
    clearLongPress()
    try { canvasRef.current?.releasePointerCapture(e.pointerId) } catch { /**/ }
    if (longPressFired.current) { longPressFired.current = false; return }
    if (!d || cancelled || d.moved) return
    const idx = hitTestAt(e.clientX, e.clientY)
    if (idx >= 0) onSelect(idx)
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
