import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS } from '../config/server'
import {
  findGoalByGlobalIndex,
  inferGoalState,
  isLeafGoal,
  loadGoalsFromServer,
  type Goal,
} from '../goal'

const RING_R = 80
const RING_CIRC = 2 * Math.PI * RING_R
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface ProfileField {
  key: string
  value: string
}

interface MemoryItem {
  entry_id: string
  entry_title: string
  file: string
  caption: string
  snapped_at: number
  uploaded_at: number
}

interface ProfileResponse {
  ok: boolean
  name: string
  user_id: string
  derived: string
  discoverable: boolean
  description: string
  memories: MemoryItem[]
}

const FIELD_LABELS: Record<string, string> = {
  age: 'Age',
  name: 'Name',
  location: 'Location',
  profession: 'Profession',
  current_focus: 'Current focus',
  recent_interest: 'Recent interest',
  stated_constraint: 'Stated constraint',
  learning_preference: 'Learning style',
  active_project_type: 'Project type',
  goal_style_preference: 'Goal style',
  daily_work_hours: 'Daily work hours',
  work_day_start: 'Work day start',
  current_intent: 'Session intent',
  last_ds_task: 'Last AI research — question',
  last_ds_summary: 'Last AI research — summary',
  last_goal_event: 'Last goal event',
  last_goal_title: 'Last goal worked on',
  current_focus_goal_title: 'Current focus goal',
}

const HIDDEN_KEYS = new Set([
  'last_repair_reason',
  'latest_input_theme',
  'updated_at',
  'profile_kind',
  'profile_note',
  'latest_input_source',
  'latest_input',
  'last_goal_id',
  'current_focus_goal_id',
])

const DS_KEYS = new Set(['last_ds_task', 'last_ds_summary'])
const SCHEDULE_KEYS = ['work_day_start', 'daily_work_hours']

function buildJournalFileUrl(entryId: string, filename: string): string {
  const params = new URLSearchParams({ id: entryId, f: filename })
  return `${SERVER_ENDPOINTS.journalFile}?${params.toString()}`
}

function memoryTitle(memory: MemoryItem): string {
  return memory.caption || memory.entry_title || 'Untitled note'
}

function openJournalEntry(entryId: string) {
  window.dispatchEvent(new CustomEvent('open-journal-entry', { detail: { entryId } }))
}

function parseDerived(raw: string): ProfileField[] {
  return raw.split('\n')
    .filter((l) => l.includes('='))
    .map((line) => {
      const eq = line.indexOf('=')
      const key = line.slice(0, eq).trim()
      const escaped = line.slice(eq + 1).trim()
      let value = escaped
      try { value = JSON.parse('"' + escaped + '"') } catch { /* keep raw */ }
      return { key, value }
    })
    .filter((f) => f.key && f.value && !HIDDEN_KEYS.has(f.key))
}

function calcRootProgress(root: Goal, allGoals: Goal[]) {
  const queue = [root]
  const subtree: Goal[] = []
  while (queue.length) {
    const g = queue.shift()!
    subtree.push(g)
    for (const idx of g.subgoals) {
      const child = findGoalByGlobalIndex(allGoals, idx)
      if (child) queue.push(child)
    }
  }
  const leaves = subtree.filter(isLeafGoal)
  const done = leaves.filter((g) => inferGoalState(g) === 'finished').length
  const totalSeconds = leaves.reduce((acc, g) => acc + (g.requiredTime || 0), 0)
  return {
    done,
    total: leaves.length,
    pct: leaves.length ? done / leaves.length : 0,
    weeks: totalSeconds / (7 * 24 * 3600),
  }
}

function formatMonthYear(ts: number): string {
  const d = new Date(ts * 1000)
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function timeAgo(ts: number): string {
  const now = Date.now() / 1000
  const diffDays = Math.max(0, Math.floor((now - ts) / 86400))
  if (diffDays < 30) return `${Math.max(1, diffDays)} days ago`
  const months = Math.floor(diffDays / 30)
  if (months < 12) return `${months} months ago`
  const years = Math.floor(months / 12)
  return `${years} years ago`
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <div className="px-1 mb-2 text-[11px] font-bold tracking-widest uppercase" style={{ color: 'var(--white-dim)' }}>
        {label}
      </div>
      <div className="overflow-hidden rounded-[18px] border border-white/[0.07]" style={{ background: '#111' }}>
        {children}
      </div>
    </div>
  )
}

function FieldRow({ field }: { field: ProfileField }) {
  const [expanded, setExpanded] = useState(false)
  const label = FIELD_LABELS[field.key] ?? field.key.replace(/_/g, ' ')
  const isLong = field.value.length > 100
  return (
    <div className="px-4 py-3 border-b border-white/[0.06] last:border-b-0">
      <p className="text-[11px] mb-0.5" style={{ color: 'rgba(255,255,255,.4)' }}>{label}</p>
      <p className={`text-sm text-white leading-relaxed ${!expanded && isLong ? 'line-clamp-2' : ''}`}>
        {field.value}
      </p>
      {isLong && (
        <button type="button" onClick={() => setExpanded((x) => !x)} className="mt-1 text-[11px] text-white/35">
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </div>
  )
}

function EditRow({
  label, value: initialValue, inputType = 'text', placeholder, onSave,
}: {
  label: string
  value: string
  inputType?: string
  placeholder?: string
  onSave: (v: string) => Promise<void>
}) {
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setValue(initialValue) }, [initialValue])

  async function save() {
    if (value === initialValue) return
    setSaving(true)
    try {
      await onSave(value)
      setSaved(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  const dirty = value !== initialValue

  return (
    <div className="px-4 py-3 border-b border-white/[0.06] last:border-b-0">
      <p className="text-[11px] mb-1.5" style={{ color: 'rgba(255,255,255,.4)' }}>{label}</p>
      <div className="flex items-center gap-2">
        <input
          className="flex-1 min-w-0 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-white outline-none focus:border-white/30"
          type={inputType}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
        />
        <button
          className={`shrink-0 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
            saved ? 'bg-green-950/30 text-green-400' :
            dirty ? 'bg-white/10 text-white' :
            'text-white/25 cursor-default'
          }`}
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {saved ? 'Saved' : saving ? '…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function DescriptionEditor({ initial, onSave }: { initial: string; onSave: (v: string) => Promise<void> }) {
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setValue(initial) }, [initial])

  const dirty = value !== initial

  async function save() {
    if (!dirty) return
    setSaving(true)
    try {
      await onSave(value)
      setSaved(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-snug" style={{ color: 'rgba(255,255,255,.35)' }}>
        The server uses this privately to match you with compatible people.
      </p>
      <textarea
        className="w-full rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-white outline-none focus:border-white/30 resize-none"
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        className={`rounded-xl px-4 py-2 text-xs font-medium transition-colors ${
          saved ? 'bg-green-950/30 text-green-400' :
          dirty ? 'bg-white/10 text-white' :
          'text-white/25 cursor-default'
        }`}
        onClick={() => void save()}
        disabled={saving || !dirty}
      >
        {saved ? 'Saved' : saving ? '…' : 'Save description'}
      </button>
    </div>
  )
}

function RingCard({ name, prog }: { name: string; prog: { done: number; total: number; pct: number } }) {
  const offset = (RING_CIRC * (1 - prog.pct)).toFixed(2)
  const [shown, setShown] = useState(false)
  useEffect(() => { requestAnimationFrame(() => requestAnimationFrame(() => setShown(true))) }, [])

  return (
    <div className="snap-start flex-shrink-0 w-[216px] flex flex-col items-center">
      <div className="relative w-[196px] h-[196px] flex items-center justify-center">
        <svg className="absolute top-0 left-0 w-[196px] h-[196px]" viewBox="0 0 196 196">
          <circle cx="98" cy="98" r={RING_R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="10" />
          <circle
            cx="98" cy="98" r={RING_R} fill="none"
            stroke="rgba(255,255,255,0.92)" strokeWidth="10" strokeLinecap="round"
            strokeDasharray={RING_CIRC.toFixed(2)}
            strokeDashoffset={shown ? offset : RING_CIRC.toFixed(2)}
            transform="rotate(-90 98 98)"
            className="ring-arc"
          />
        </svg>
        <div className="relative z-[1] flex flex-col items-center justify-center w-[132px] text-center">
          <div
            className="text-[17px] font-extrabold leading-tight tracking-tight overflow-hidden"
            style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as never }}
          >
            {name}
          </div>
        </div>
      </div>
      <div className="text-[11px] mt-2 font-semibold" style={{ color: 'var(--white-dim)' }}>
        {prog.done}/{prog.total} goals
      </div>
    </div>
  )
}

interface SpiralStrand {
  name: string
  color: string
  pct: number
  weeks: number
}

const SPIRAL_COLORS = ['#48bfe3', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#facc15', '#60a5fa', '#f87171']

// ─── Spiral Map ───────────────────────────────────────────────────────────────
// A 3-D helix of the user's journeys. Each root goal is one strand; its position
// along the helix reflects real progress (done leaves) and its length reflects
// total estimated time. Tap a strand (or legend item) to focus it; others dim.
const SPIRAL_ZOOM = 1.85

function SpiralMap({ strands: strandSrc }: { strands: SpiralStrand[] }) {
  const [activeStrand, setActiveStrand] = useState<number | null>(null)
  const [hoverStrand, setHoverStrand] = useState<number | null>(null)
  const [panY, setPanY] = useState(0)
  const [svgH, setSvgH] = useState(0)
  const [dragging, setDragging] = useState(false)
  const svgElRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef({ active: false, startY: 0, startPan: 0, moved: false })

  const VW = 360, CX = 182, R_BASE = 100, TAPER = 18, TILT = 0.28
  const N_LOOPS = 3, T_MAX = N_LOOPS * 2 * Math.PI
  const LOOP_H = 160, HEIGHT = N_LOOPS * LOOP_H
  const START_Y = HEIGHT + 290 - 110
  const SVG_H = HEIGHT + 290
  const T_NOW_LOOPS = 1.5, T_NOW = T_NOW_LOOPS * 2 * Math.PI

  const N_STRANDS = Math.max(strandSrc.length, 1)
  const DANGLE_STEP = 0.22
  const DANGLE_BASE = -((N_STRANDS - 1) / 2) * DANGLE_STEP
  const DR_STEP = 22
  const DR_BASE = -((N_STRANDS - 1) / 2) * DR_STEP
  const DY_STEP = 10
  const DY_BASE = -((N_STRANDS - 1) / 2) * DY_STEP

  // Time scale is normalised to the data: the visible "future" portion of the
  // helix spans the longest root goal × 1.25 (with a floor), and the "past"
  // portion is capped at ~6 months. Everything downstream derives from this.
  const FRONT_LOOPS = N_LOOPS - T_NOW_LOOPS // 1.5 loops of future
  const maxWeeks = strandSrc.reduce((m, s) => Math.max(m, s.weeks || 0), 0)
  const frontWeeks = Math.max(8, maxWeeks * 1.25)
  const WEEKS_PER_LOOP = frontWeeks / FRONT_LOOPS
  const WEEKS_PER_MONTH = 4.345
  const BEHIND_CAP_WEEKS = 6 * WEEKS_PER_MONTH // never show more than ~6 months of past

  const pt = (t: number, dAngle = 0, dr = 0, dy = 0) => {
    const p = t / T_MAX, R = R_BASE - p * TAPER + dr
    return {
      x: CX + R * Math.sin(t + dAngle),
      y: START_Y - p * HEIGHT - R * TILT * Math.cos(t + dAngle) + dy,
    }
  }

  // tStart/tEnd derived from real progress + estimated duration so each strand's
  // "now" position and length reflect actual data.
  const strands = strandSrc.map((cfg, idx) => {
    const dAngle = DANGLE_BASE + idx * DANGLE_STEP
    const dr = DR_BASE + idx * DR_STEP
    const dy = DY_BASE + idx * DY_STEP
    // Length is proportional to the journey's total estimated time (calcRootProgress
    // weeks → spiral arc), with a small floor so a tiny journey stays tappable and a
    // cap so it never runs off the end of the visible helix.
    const MAX_SPAN = N_LOOPS * WEEKS_PER_LOOP * 0.92
    const span = Math.max(2, Math.min(MAX_SPAN, cfg.weeks || 2))
    const completedW = cfg.pct * span
    const remainingW = Math.max(0.5, span - completedW)
    // Cap how far into the past a strand reaches so it never exceeds ~6 months.
    const behindW = Math.min(completedW, BEHIND_CAP_WEEKS)
    const tStart = Math.max(0.05, T_NOW - (behindW / WEEKS_PER_LOOP) * 2 * Math.PI)
    const tEnd = Math.min(T_MAX * 0.97, T_NOW + (remainingW / WEEKS_PER_LOOP) * 2 * Math.PI)
    return { ...cfg, dAngle, dr, dy, tStart, tEnd, alexFrac: cfg.pct }
  })

  const { strandData, spineFull } = useMemo(() => {
    const lpt = (t: number, dAngle: number, dr: number, dy: number) => {
      const p = t / T_MAX, R = R_BASE - p * TAPER + dr
      return {
        x: CX + R * Math.sin(t + dAngle),
        y: START_Y - p * HEIGHT - R * TILT * Math.cos(t + dAngle) + dy,
      }
    }

    // One continuous, high-resolution path per strand → pixel-smooth at any zoom.
    const buildLine = (t0: number, t1: number, dAngle: number, dr: number, dy: number) => {
      let d = '', pen = false
      for (let i = 0; i <= 260; i++) {
        const t = t0 + (i / 260) * (t1 - t0)
        const { x, y } = lpt(t, dAngle, dr, dy)
        d += pen ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`
        pen = true
      }
      return d
    }

    const buildGlow = (t0: number, t1: number, dAngle: number, dr: number, dy: number) => {
      let d = '', pen = false
      for (let i = 0; i <= 200; i++) {
        const t = t0 + (i / 200) * (t1 - t0)
        if (Math.sin(t + dAngle) < 0.15) { pen = false; continue }
        const { x, y } = lpt(t, dAngle, dr, dy)
        d += pen ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`
        pen = true
      }
      return d
    }

    const buildHit = (t0: number, t1: number, dAngle: number, dr: number, dy: number) => {
      let d = '', pen = false
      for (let i = 0; i <= 80; i++) {
        const t = t0 + (i / 80) * (t1 - t0)
        const { x, y } = lpt(t, dAngle, dr, dy)
        d += pen ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`
        pen = true
      }
      return d
    }

    let spineFull = '', spinePen = false
    for (let i = 0; i <= 300; i++) {
      const t = (i / 300) * T_MAX
      const { x, y } = lpt(t, 0, 0, 0)
      spineFull += spinePen ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`
      spinePen = true
    }

    return {
      strandData: strands.map((s) => {
        const start = lpt(s.tStart, s.dAngle, s.dr, s.dy)
        const end = lpt(s.tEnd, s.dAngle, s.dr, s.dy)
        return {
          color: s.color,
          linePath: buildLine(s.tStart, s.tEnd, s.dAngle, s.dr, s.dy),
          glowPath: buildGlow(s.tStart, s.tEnd, s.dAngle, s.dr, s.dy),
          hitPath: buildHit(s.tStart, s.tEnd, s.dAngle, s.dr, s.dy),
          start,
          end,
        }
      }),
      spineFull,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strands.map((s) => s.tStart.toFixed(2) + s.tEnd.toFixed(2) + s.color).join('')])

  const dotPt = (frac: number, tStart: number, tEnd: number, dAngle: number, dr: number, dy: number) =>
    pt(tStart + frac * (tEnd - tStart), dAngle, dr, dy)

  // Ring labels reflect the dynamic scale (months/years derived from the data).
  const fmtOffset = (loops: number) => {
    const months = loops * (WEEKS_PER_LOOP / WEEKS_PER_MONTH)
    const sign = months >= 0 ? '+' : '-'
    const am = Math.abs(months)
    if (am >= 12) {
      const yr = am / 12
      return `${sign}${yr % 1 < 0.1 ? Math.round(yr) : yr.toFixed(1)} yr`
    }
    return `${sign}${Math.max(1, Math.round(am))} mo`
  }
  const behindLoops = Math.min(T_NOW_LOOPS - 0.05, BEHIND_CAP_WEEKS / WEEKS_PER_LOOP)
  const MILESTONES = [
    { t: T_NOW - behindLoops * 2 * Math.PI, label: fmtOffset(-behindLoops), isNow: false },
    { t: T_NOW, label: 'now', isNow: true },
    { t: T_NOW + FRONT_LOOPS * 0.5 * 2 * Math.PI, label: fmtOffset(FRONT_LOOPS * 0.5), isNow: false },
    { t: T_NOW + (FRONT_LOOPS - 0.05) * 2 * Math.PI, label: fmtOffset(FRONT_LOOPS - 0.05), isNow: false },
  ].filter((m) => m.t >= 0 && m.t <= T_MAX)

  const topPt = pt(T_MAX * 0.95, 0, 0)
  const aAngle = -60 * (Math.PI / 180), aLen = 54
  const tip = { x: topPt.x + Math.cos(aAngle) * aLen, y: topPt.y + Math.sin(aAngle) * aLen }
  const perp = aAngle + Math.PI / 2, hs = 7
  const head = [
    `${tip.x.toFixed(1)},${tip.y.toFixed(1)}`,
    `${(tip.x - Math.cos(aAngle) * hs * 1.5 + Math.cos(perp) * hs * 0.55).toFixed(1)},${(tip.y - Math.sin(aAngle) * hs * 1.5 + Math.sin(perp) * hs * 0.55).toFixed(1)}`,
    `${(tip.x - Math.cos(aAngle) * hs * 1.5 - Math.cos(perp) * hs * 0.55).toFixed(1)},${(tip.y - Math.sin(aAngle) * hs * 1.5 - Math.sin(perp) * hs * 0.55).toFixed(1)}`,
  ].join(' ')

  const focusStrand = hoverStrand ?? activeStrand
  const activeS = activeStrand !== null ? strands[activeStrand] : null
  const focusS = focusStrand !== null ? strands[focusStrand] : null
  const focusData = focusStrand !== null ? strandData[focusStrand] : null

  const dotOp = (base: number, si: number) =>
    focusStrand === null ? base : focusStrand === si ? base : base * 0.08
  const glowOp = (si: number) =>
    focusStrand === null ? 0.12 : focusStrand === si ? 0.34 : 0.006

  // Zoom focus = the active strand's progress dot, expressed as a transform-origin
  // percentage so scaling homes in on the tapped goal.
  const focus = focusS
    ? dotPt(focusS.alexFrac, focusS.tStart, focusS.tEnd, focusS.dAngle, focusS.dr, focusS.dy)
    : { x: CX, y: START_Y - (T_NOW / T_MAX) * HEIGHT }
  const originX = (focus.x / VW) * 100
  const originY = (focus.y / SVG_H) * 100
  const maxPan = (svgH * (SPIRAL_ZOOM - 1)) / 2

  // Measure rendered height so the wrapper can hold a fixed height — zooming the
  // inner SVG then never reflows the page (safe zoom-out).
  useEffect(() => {
    const el = svgElRef.current
    if (!el) return
    const measure = () => setSvgH(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const selectStrand = (i: number) => {
    setPanY(0)
    setActiveStrand((prev) => (prev === i ? null : i))
  }
  const deselect = () => { setActiveStrand(null); setHoverStrand(null); setPanY(0) }
  const previewStrand = (i: number) => {
    if (dragRef.current.active) return
    setPanY(0)
    setHoverStrand(i)
  }
  const clearPreview = () => setHoverStrand(null)

  const beginDrag = (clientY: number) => {
    // Always reset `moved` so the next tap registers; only arm panning when zoomed.
    dragRef.current = { active: activeStrand !== null, startY: clientY, startPan: panY, moved: false }
  }
  const moveDrag = (clientY: number) => {
    const d = dragRef.current
    if (!d.active) return
    const dy = clientY - d.startY
    if (Math.abs(dy) > 4 && !d.moved) { d.moved = true; setDragging(true) }
    if (d.moved) setPanY(Math.max(-maxPan, Math.min(maxPan, d.startPan + dy)))
  }
  const endDrag = () => {
    dragRef.current.active = false
    setDragging(false)
  }
  // A click only counts as a tap (select/deselect) when the pointer didn't pan.
  const tap = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!dragRef.current.moved) fn()
  }

  return (
    <div
      className="relative overflow-hidden"
      style={{ height: svgH || undefined, touchAction: focusStrand !== null ? 'none' : 'auto' }}
      onPointerLeave={clearPreview}
      onTouchStart={(e) => beginDrag(e.touches[0].clientY)}
      onTouchMove={(e) => moveDrag(e.touches[0].clientY)}
      onTouchEnd={endDrag}
      onPointerDown={(e) => { if (e.pointerType === 'mouse') beginDrag(e.clientY) }}
      onPointerMove={(e) => { if (e.pointerType === 'mouse') moveDrag(e.clientY) }}
      onPointerUp={(e) => { if (e.pointerType === 'mouse') endDrag() }}
    >
      {activeS && (
        <div className="anim-pg-in pointer-events-none fixed inset-x-0 bottom-[110px] z-[120] flex flex-col items-center gap-1 px-6 text-center">
          <span className="text-xl font-bold tracking-tight text-white">{activeS.name}</span>
          <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--white-dim)' }}>
            <span className="h-2 w-2 rounded-full" style={{ background: activeS.color }} />
            {Math.round(activeS.alexFrac * 100)}% complete
          </span>
        </div>
      )}
      <svg
        ref={svgElRef}
        viewBox={`0 0 ${VW} ${SVG_H}`}
        width="100%"
        style={{
          display: 'block',
          transform: focusStrand !== null ? `translateY(${panY}px) scale(${SPIRAL_ZOOM})` : 'none',
          transformOrigin: `${originX}% ${originY}%`,
          transition: dragging ? 'none' : 'transform 860ms cubic-bezier(.18,.92,.22,1)',
        }}
        onClick={tap(deselect)}
      >
      <defs>
        <filter id="gl-xs" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="1.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="gl-sm" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="gl-md" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="10" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="gl-beam" x="-160%" y="-160%" width="420%" height="420%">
          <feGaussianBlur stdDeviation="11" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        {strandData.map(({ color, start, end }, si) => {
          const focused = focusStrand === si
          return (
            <linearGradient
              key={`grad-${si}`}
              id={`strand-grad-${si}`}
              gradientUnits="userSpaceOnUse"
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
            >
              <stop offset="0%" stopColor={color} stopOpacity={focused ? 0.90 : 0.62} />
              <stop offset="58%" stopColor={color} stopOpacity={focused ? 1 : 0.86} />
              <stop offset="78%" stopColor={color} stopOpacity={focused ? 0.62 : 0.40} />
              <stop offset="100%" stopColor={color} stopOpacity={focused ? 0.14 : 0.06} />
            </linearGradient>
          )
        })}
        {strandData.map(({ color, start, end }, si) => {
          const focused = focusStrand === si
          return (
            <linearGradient
              key={`glow-grad-${si}`}
              id={`strand-glow-grad-${si}`}
              gradientUnits="userSpaceOnUse"
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
            >
              <stop offset="0%" stopColor={color} stopOpacity={focused ? 0.22 : 0.12} />
              <stop offset="65%" stopColor={color} stopOpacity={focused ? 0.85 : 0.42} />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          )
        })}
      </defs>

      <rect x="0" y="0" width={VW} height={SVG_H} fill="#000000" />

      <path d={spineFull} fill="none" stroke="white"
        strokeWidth="1.6" strokeOpacity="0.16" strokeLinecap="round" />

      {strandData.map(({ linePath }, si) => {
        const focused = focusStrand === si
        const op = focusStrand === null ? 0.92 : focused ? 1 : 0.11
        return (
          <path
            key={`strand${si}`}
            className="spiral-strand-in"
            style={{
              animationDelay: `${si * 150}ms`,
              transition: 'stroke-opacity 700ms cubic-bezier(.2,.8,.18,1), stroke-width 620ms cubic-bezier(.22,1,.36,1)',
            }}
            d={linePath} fill="none" stroke={`url(#strand-grad-${si})`}
            strokeWidth={focused ? 4.4 : 3.4} strokeOpacity={op}
            strokeLinecap="round" strokeLinejoin="round"
          />
        )
      })}

      {MILESTONES.map(({ t, label, isNow }) => {
        const p = t / T_MAX
        const yR = START_Y - p * HEIGHT
        const rR = R_BASE - p * TAPER + 22
        const ryR = rR * TILT * 0.8
        return (
          <g key={`ml${Math.round(t * 10)}`}>
            {isNow && (
              <ellipse cx={CX} cy={yR} rx={rR + 4} ry={ryR + 2.5}
                fill="none" stroke="white" strokeWidth="9" strokeOpacity="0.06"
                filter="url(#gl-xs)" />
            )}
            <ellipse cx={CX} cy={yR} rx={rR} ry={ryR} fill="none"
              stroke={isNow ? 'rgba(255,255,255,0.40)' : 'rgba(255,255,255,0.10)'}
              strokeWidth={isNow ? 2.0 : 1.2}
              strokeDasharray={isNow ? undefined : '4 4'} />
            {isNow && (
              <rect x={CX + rR + 5} y={yR - 9} width="46" height="20" rx="10"
                fill="rgba(255,255,255,0.10)" />
            )}
            <text x={CX + rR + 8} y={yR + 4}
              fill={isNow ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.32)'}
              fontSize={isNow ? '12' : '10'} fontWeight={isNow ? '700' : '400'}
              letterSpacing="0.5" fontFamily="-apple-system,system-ui,sans-serif">
              {label}
            </text>
            {isNow && (
              <text x={CX + rR + 8} y={yR + 19}
                fill="rgba(255,255,255,0.30)" fontSize="10" letterSpacing="0.8"
                fontFamily="-apple-system,system-ui,sans-serif">Milestone</text>
            )}
          </g>
        )
      })}

      {strandData.map(({ glowPath }, si) => (
        <path key={`gw${si}`} d={glowPath} fill="none"
          stroke={`url(#strand-glow-grad-${si})`} strokeWidth={focusStrand === si ? 15 : 9} strokeOpacity={glowOp(si)}
          strokeLinecap="round" filter="url(#gl-sm)"
          style={{
            transition: 'stroke-opacity 1500ms cubic-bezier(.16,1,.3,1) 380ms, stroke-width 1200ms cubic-bezier(.22,1,.36,1) 260ms',
          }}
        />
      ))}

      {focusData && focusS && (
        <g key={`beam-${focusStrand}`} className="spiral-beam" style={{ pointerEvents: 'none' }}>
          <path d={focusData.glowPath} fill="none"
            stroke={focusS.color} strokeWidth="30" strokeOpacity="0.20"
            strokeLinecap="round" filter="url(#gl-beam)" />
          <path d={focusData.linePath} fill="none"
            stroke="rgba(255,255,255,.82)" strokeWidth="5.8" strokeOpacity="0.56"
            strokeLinecap="round" strokeLinejoin="round" filter="url(#gl-xs)" />
          <path d={focusData.linePath} fill="none"
            stroke={focusS.color} strokeWidth="9" strokeOpacity="0.46"
            strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}

      {strands.map((s, si) => {
        const sp = pt(s.tStart, s.dAngle, s.dr, s.dy)
        const op = focusStrand === null ? 0.55 : focusStrand === si ? 0.95 : 0.10
        return (
          <g key={`sd${si}`}>
            <circle cx={sp.x} cy={sp.y} r="4.5" fill={s.color} fillOpacity={op}
              stroke="rgba(255,255,255,0.25)" strokeWidth="1.1"
              style={{ transition: 'fill-opacity 520ms cubic-bezier(.22,1,.36,1)' }} />
          </g>
        )
      })}

      <text x={CX} y={START_Y + 50} textAnchor="middle"
        fill="rgba(255,255,255,0.18)" fontSize="10" letterSpacing="2.8"
        fontFamily="-apple-system,system-ui,sans-serif">
        THE JOURNEY BEGINS
      </text>

      {strands.map((s, si) => {
        const pos = dotPt(s.alexFrac, s.tStart, s.tEnd, s.dAngle, s.dr, s.dy)
        const t = s.tStart + s.alexFrac * (s.tEnd - s.tStart)
        const base = 0.35 + ((Math.sin(t + s.dAngle) + 1) / 2) * 0.55
        const eff = dotOp(base, si)
        return (
          <g key={`pd${si}`}>
            <circle cx={pos.x} cy={pos.y} r={focusStrand === si ? 8.5 : 7} fill={s.color} fillOpacity={eff}
              stroke="rgba(255,255,255,0.65)" strokeWidth="1.5"
              style={{ transition: 'r 560ms cubic-bezier(.34,1.56,.64,1), fill-opacity 620ms cubic-bezier(.22,1,.36,1)' }} />
          </g>
        )
      })}

      {/* minimalist select ping — a single ring that expands and fades once */}
      {focusS && (
        <circle key={`ping-${focusStrand}`} className="spiral-ping"
          cx={focus.x} cy={focus.y} fill="none"
          stroke={focusS.color} strokeWidth="2" />
      )}

      <line x1={topPt.x} y1={topPt.y} x2={tip.x} y2={tip.y}
        stroke="white" strokeWidth="8" strokeOpacity="0.04" strokeLinecap="round" filter="url(#gl-sm)" />
      <line x1={topPt.x} y1={topPt.y} x2={tip.x} y2={tip.y}
        stroke="rgba(255,255,255,0.55)" strokeWidth="1.0" strokeLinecap="round" />
      <polygon points={head} fill="rgba(255,255,255,0.68)" />

      <circle cx={tip.x} cy={tip.y} r={5.5} fill="white" fillOpacity="0.10" />
      <circle cx={tip.x} cy={tip.y} r={3} fill="white" fillOpacity="0.80" />
      <text x={tip.x + 13} y={tip.y - 1}
        fill="rgba(255,255,255,0.72)" fontSize="11" fontWeight="600"
        letterSpacing="0.8" fontFamily="-apple-system,system-ui,sans-serif">Open horizon</text>
      <text x={tip.x + 13} y={tip.y + 13}
        fill="rgba(255,255,255,0.28)" fontSize="10" letterSpacing="0.3"
        fontFamily="-apple-system,system-ui,sans-serif">Endless possibilities</text>

      <text x="13" y="18" fill="rgba(255,255,255,0.18)" fontSize="8" fontWeight="600"
        letterSpacing="2" fontFamily="-apple-system,system-ui,sans-serif">JOURNEYS</text>
      {strands.map((s, i) => {
        const isFocused = focusStrand === i
        const textOp = activeStrand === null ? 'rgba(255,255,255,0.45)'
          : isFocused ? 'rgba(255,255,255,0.88)'
            : 'rgba(255,255,255,0.14)'
        const dotFill = focusStrand === null ? 0.82 : isFocused ? 1.0 : 0.20
        return (
          <g key={`lg${i}`} onClick={tap(() => selectStrand(i))}
            onPointerEnter={() => previewStrand(i)}
            style={{ cursor: 'pointer' }}>
            <rect x="11" y={22 + i * 16} width="160" height="15" rx="4" fill="transparent" />
            <circle cx="17" cy={31 + i * 16} r="3.5" fill={s.color} fillOpacity={dotFill} />
            <text x="26" y={35 + i * 16} fill={textOp} fontSize="10.5"
              fontFamily="-apple-system,system-ui,sans-serif">{s.name}</text>
          </g>
        )
      })}

      {strandData.map(({ hitPath }, si) => (
        <path key={`hit${si}`} d={hitPath} fill="none"
          stroke="transparent" strokeWidth="30"
          onClick={tap(() => selectStrand(si))}
          onPointerEnter={() => previewStrand(si)}
          style={{ cursor: 'pointer' }} />
      ))}
      </svg>
    </div>
  )
}

function MemoryPanel({
  open, memories, activeIdx, onClose, onSelect,
}: {
  open: boolean
  memories: MemoryItem[]
  activeIdx: number
  onClose: () => void
  onSelect: (idx: number) => void
}) {
  const active = memories[activeIdx] ?? null
  return (
    <div
      className="fixed inset-0 z-[203] flex flex-col overflow-hidden transition-transform"
      style={{ background: 'var(--bg)', transform: open ? 'translateY(0)' : 'translateY(100%)' }}
    >
      {active && (
        <>
          <div className="relative flex-shrink-0 h-[52vh] overflow-hidden">
            <img
              src={buildJournalFileUrl(active.entry_id, active.file)}
              alt={active.caption}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,.75), rgba(0,0,0,.05))' }} />
            <div
              onClick={onClose}
              className="absolute top-[52px] left-5 w-[34px] h-[34px] rounded-full flex items-center justify-center cursor-pointer z-[2] backdrop-blur-12"
              style={{ background: 'rgba(0,0,0,.45)', border: '1px solid rgba(255,255,255,.15)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
            <div className="absolute bottom-0 left-0 right-0 px-5 pb-5 z-[1]">
              <div className="text-[11px] font-bold tracking-wider uppercase mb-1" style={{ color: 'rgba(255,255,255,.5)' }}>
                {formatMonthYear(active.snapped_at)}
              </div>
              <div className="text-[28px] font-extrabold tracking-tight leading-[1.15]">
                {memoryTitle(active)}
              </div>
              <div className="text-[13px] font-medium mt-1" style={{ color: 'rgba(255,255,255,.4)' }}>
                {timeAgo(active.uploaded_at || active.snapped_at)}
              </div>
              <button
                type="button"
                onClick={() => openJournalEntry(active.entry_id)}
                className="mt-3 inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
                style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.14)', color: 'rgba(255,255,255,.82)' }}
              >
                Open note
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 no-scrollbar">
            <div className="grid grid-cols-3 gap-1">
              {memories.map((memory, i) => (
                <div
                  key={`${memory.entry_id}-${memory.file}`}
                  onClick={() => onSelect(i)}
                  className="relative overflow-hidden aspect-square cursor-pointer active:opacity-70"
                  style={{
                    gridColumn: i === activeIdx ? 'span 2' : undefined,
                    gridRow: i === activeIdx ? 'span 2' : undefined,
                    borderRadius: i === activeIdx ? 14 : 10,
                  }}
                >
                  <img
                    src={buildJournalFileUrl(memory.entry_id, memory.file)}
                    alt={memory.caption}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  {i === activeIdx && (
                    <div className="absolute inset-0 pointer-events-none z-[3]" style={{ borderRadius: 'inherit', border: '2.5px solid rgba(255,255,255,.75)' }} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const SUBMITTED_GOALS_KEY = 'change.submittedGoals'

function loadSubmittedGoals(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SUBMITTED_GOALS_KEY) ?? '{}') } catch { return {} }
}

function saveSubmittedGoals(m: Record<string, string>) {
  localStorage.setItem(SUBMITTED_GOALS_KEY, JSON.stringify(m))
}

function VerifyGoalModal({
  goalId, goalName, onClose, onDone,
}: {
  goalId: string
  goalName: string
  onClose: () => void
  onDone: (submissionId: string) => void
}) {
  const [files, setFiles] = useState<File[]>([])
  const [desc, setDesc] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ aiLabel: string; aiDesc: string } | null>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const canSubmit = files.length > 0 || desc.trim().length > 0

  async function submit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const createRes = await fetch(SERVER_ENDPOINTS.submissionsCreate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal_id: goalId, user_description: desc.trim() || undefined }),
      })
      const createData = await createRes.json() as { ok: boolean; id?: string; ai_label?: string; ai_description?: string; error?: string }
      if (!createData.ok || !createData.id) {
        setError(createData.error ?? 'Submission failed')
        return
      }
      const subId = createData.id
      for (const file of files) {
        const buf = await file.arrayBuffer()
        const params = new URLSearchParams({ id: subId, f: file.name })
        await fetch(`${SERVER_ENDPOINTS.submissionsFile}?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        })
      }
      setResult({ aiLabel: createData.ai_label ?? '', aiDesc: createData.ai_description ?? '' })
      onDone(subId)
    } catch (e) {
      setError('Network error — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[210] flex flex-col" style={{ background: '#000' }}>
      <div className="flex flex-shrink-0 items-center gap-3 px-5 pt-[52px] pb-4" style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        <button type="button" onClick={onClose}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-bold text-white">Verify Goal</div>
          <div className="truncate text-[11px]" style={{ color: 'rgba(255,255,255,.4)' }}>{goalName}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pt-5 pb-8">
        {result ? (
          <div className="flex flex-col items-center text-center pt-6 gap-4">
            <div className="text-[48px]">✨</div>
            <div className="text-[20px] font-bold text-white">Submitted for review</div>
            <div className="rounded-2xl px-4 py-3 text-[13px] text-left w-full" style={{ background: 'rgba(255,200,50,.07)', border: '1px solid rgba(255,200,50,.18)' }}>
              <div className="text-[11px] font-bold uppercase tracking-wider mb-1" style={{ color: 'rgba(255,200,50,.7)' }}>Reviewers will see you as</div>
              <div className="text-[15px] font-bold text-white mb-1">{result.aiLabel}</div>
              <div className="text-[13px] leading-[1.6]" style={{ color: 'rgba(255,255,255,.6)' }}>{result.aiDesc}</div>
            </div>
            <div className="text-[12px]" style={{ color: 'rgba(255,255,255,.3)' }}>
              A peer reviewer will rate your work. A score of 4+ marks it as authentic.
            </div>
            <button type="button" onClick={onClose}
              className="mt-2 w-full rounded-2xl py-4 text-[15px] font-bold text-black bg-white">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="mb-4 text-[13px] leading-[1.6]" style={{ color: 'rgba(255,255,255,.45)' }}>
              Add proof of your work — images, PDFs, 3D models, or audio — along with an optional note. At least one is required.
            </div>

            <input ref={fileRef} type="file" multiple accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.glb,.mp3"
              className="hidden" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />

            <div onClick={() => fileRef.current?.click()}
              className="mb-4 flex flex-col items-center justify-center rounded-2xl cursor-pointer py-8 gap-2"
              style={{ border: '1.5px dashed rgba(255,255,255,.18)', background: 'rgba(255,255,255,.03)' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-[13px]" style={{ color: 'rgba(255,255,255,.35)' }}>
                {files.length === 0 ? 'Tap to add files' : `${files.length} file${files.length > 1 ? 's' : ''} selected`}
              </span>
            </div>

            {files.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[12px]"
                    style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.1)', color: 'rgba(255,255,255,.7)' }}>
                    {f.name}
                    <span onClick={(e) => { e.stopPropagation(); setFiles((fs) => fs.filter((_, j) => j !== i)) }}
                      className="cursor-pointer text-[11px]" style={{ color: 'rgba(255,255,255,.3)' }}>✕</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.3)' }}>Optional note</div>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Describe what you accomplished…"
              rows={4}
              className="w-full resize-none rounded-2xl px-4 py-3.5 text-[14px] leading-[1.6] outline-none mb-5"
              style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'rgba(255,255,255,.85)', caretColor: 'white' }}
            />

            {error && <div className="mb-3 text-[13px]" style={{ color: '#f87171' }}>{error}</div>}

            <button type="button" onClick={() => void submit()}
              disabled={!canSubmit || submitting}
              className="w-full rounded-2xl py-[18px] text-[16px] font-bold tracking-tight transition-opacity active:opacity-80"
              style={{ background: '#fff', color: '#000', opacity: canSubmit && !submitting ? 1 : 0.35 }}>
              {submitting ? 'Submitting…' : 'Submit for review →'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

async function postUpdate(key: string, value: string, extra?: Record<string, string>) {
  const res = await fetch(SERVER_ENDPOINTS.profileUpdate, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value, ...extra }),
  })
  if (!res.ok) throw new Error(`Update failed: ${res.status}`)
}

export default function SettingsView() {
  const [fields, setFields] = useState<ProfileField[]>([])
  const [userName, setUserName] = useState('')
  const [userId, setUserId] = useState('')
  const [avatarVersion, setAvatarVersion] = useState(0)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [discoverable, setDiscoverable] = useState(false)
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [goals, setGoals] = useState<Goal[]>([])
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [activeMemoryIdx, setActiveMemoryIdx] = useState(0)
  const [view, setView] = useState<'spiral' | 'goals'>('spiral')
  const [submittedGoals, setSubmittedGoals] = useState<Record<string, string>>(loadSubmittedGoals)
  const [authenticGoals, setAuthenticGoals] = useState<Set<string>>(new Set())
  const [verifyingGoalId, setVerifyingGoalId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const [profileRes, loadedGoals] = await Promise.all([
        fetch(SERVER_ENDPOINTS.profile, { cache: 'no-store' }),
        loadGoalsFromServer().catch(() => [] as Goal[]),
      ])
      if (!profileRes.ok) throw new Error(`Profile fetch failed: ${profileRes.status}`)
      const data = (await profileRes.json()) as ProfileResponse
      setUserName(data.name ?? '')
      setUserId(data.user_id ?? '')
      setDiscoverable(data.discoverable ?? false)
      setDescription(data.description ?? '')
      setFields(parseDerived(data.derived ?? ''))
      setGoals(loadedGoals)
      setMemories(Array.isArray(data.memories) ? data.memories : [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const avatarUrl = `${SERVER_ENDPOINTS.profileAvatar}?id=${encodeURIComponent(userId)}&v=${avatarVersion}`

  async function onPickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      const rawExt = (file.type.split('/')[1] || file.name.split('.').pop() || '').toLowerCase()
      const ext = rawExt === 'jpeg' ? 'jpg' : rawExt
      try {
        const buf = await file.arrayBuffer()
        const res = await fetch(`${SERVER_ENDPOINTS.profileAvatar}?ext=${encodeURIComponent(ext)}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: buf,
        })
        if (res.ok) {
          setAvatarFailed(false)
          setAvatarVersion((v) => v + 1)
        }
      } catch { /* ignore */ }
    }
    if (avatarInputRef.current) avatarInputRef.current.value = ''
  }

  useEffect(() => {
    const subIds = Object.values(submittedGoals)
    if (subIds.length === 0) return
    let cancelled = false
    async function checkStatus() {
      const next = new Set<string>()
      for (const [goalId, subId] of Object.entries(submittedGoals)) {
        try {
          const r = await fetch(CENTRAL_ENDPOINTS.submissionStatus(subId), { cache: 'no-store' })
          const d = await r.json() as { ok: boolean; authentic?: boolean }
          if (d.ok && d.authentic) next.add(goalId)
        } catch { /* ignore */ }
      }
      if (!cancelled) setAuthenticGoals(next)
    }
    void checkStatus()
    const id = setInterval(() => void checkStatus(), 30000)
    return () => { cancelled = true; clearInterval(id) }
  }, [submittedGoals])

  const fieldVal = (key: string) => fields.find((f) => f.key === key)?.value ?? ({ work_day_start: '09:00', daily_work_hours: '8' }[key] ?? '')
  const profileFields = fields.filter((f) => !DS_KEYS.has(f.key) && !SCHEDULE_KEYS.includes(f.key))
  const dsTask = fields.find((f) => f.key === 'last_ds_task')
  const dsSummary = fields.find((f) => f.key === 'last_ds_summary')
  const rootGoals = goals.filter((g) => g.parent === null)
  const activeRoots = rootGoals.filter((g) => calcRootProgress(g, goals).total > 0)
  const spiralStrands: SpiralStrand[] = activeRoots.map((g, i) => {
    const prog = calcRootProgress(g, goals)
    return { name: g.title, color: SPIRAL_COLORS[i % SPIRAL_COLORS.length], pct: prog.pct, weeks: prog.weeks }
  })
  const achievements = rootGoals
    .filter((g) => {
      const prog = calcRootProgress(g, goals)
      return prog.total > 0 && prog.done === prog.total
    })
    .map((g) => ({ id: g.id, name: g.title, total: calcRootProgress(g, goals).total }))

  const featuredMemory = memories[0] ?? null
  const sameMonthMemories = useMemo(() => {
    if (!featuredMemory) return [] as MemoryItem[]
    const key = formatMonthYear(featuredMemory.snapped_at)
    return memories.filter((m) => formatMonthYear(m.snapped_at) === key)
  }, [featuredMemory, memories])
  const memoryThumbs = memories.slice(0, 5)
  const initial = userName ? userName.charAt(0).toUpperCase() : '?'

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-sm text-white/40">Loading…</div>
  }

  return (
    <div className="overflow-hidden flex flex-col h-full anim-pg-in">
      <div className="px-6 pt-[52px] pb-6 flex items-center gap-4 flex-shrink-0">
        <div
          onClick={() => avatarInputRef.current?.click()}
          className="group relative w-[52px] h-[52px] rounded-full flex items-center justify-center text-xl font-bold flex-shrink-0 overflow-hidden cursor-pointer"
          style={{ background: 'var(--surface2)', border: '2px solid var(--border-light)' }}
          title="Change profile picture"
        >
          {!avatarFailed ? (
            <img
              src={avatarUrl}
              onError={() => setAvatarFailed(true)}
              className="w-full h-full object-cover"
              alt=""
            />
          ) : (
            <span>{initial}</span>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/45 text-[9px] font-semibold uppercase tracking-wide opacity-0 group-hover:opacity-100 transition-opacity">
            Edit
          </div>
        </div>
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={onPickAvatar}
          className="hidden"
        />
        <div>
          <div className="text-[22px] font-bold tracking-tight">{userName || 'You'}</div>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <div
            onClick={() => setShowSettings(true)}
            className="w-9 h-9 rounded-xl flex items-center justify-center cursor-pointer"
            style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
        </div>
      </div>

      {activeRoots.length > 0 && (
        <div className="px-6 pb-4 flex-shrink-0">
          <div
            className="flex p-[3px] gap-[2px]"
            style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 14 }}
          >
            {(['spiral', 'goals'] as const).map((v) => (
              <div
                key={v}
                onClick={() => setView(v)}
                className="flex-1 py-2 rounded-[11px] text-center text-xs font-semibold cursor-pointer transition-all"
                style={{ background: view === v ? '#fff' : 'transparent', color: view === v ? '#000' : 'var(--white-dim)' }}
              >
                {v === 'spiral' ? 'Spiral' : 'Goals'}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overflow-x-hidden pb-4 no-scrollbar">
        {activeRoots.length > 0 && view === 'spiral' && (
          <div className="mb-4 mt-1">
            <SpiralMap strands={spiralStrands} />
          </div>
        )}

        {activeRoots.length > 0 && view === 'goals' && (
          <div className="mb-8 mt-2">
            <div className="flex items-center gap-2 px-6 mb-4">
              <span className="text-[11px] font-bold tracking-[2px] uppercase" style={{ color: 'var(--white-dim)' }}>Personal</span>
            </div>
            <div className="flex gap-3.5 px-6 overflow-x-auto no-scrollbar snap-x-m">
              {activeRoots.map((g) => (
                <RingCard key={g.localIndex} name={g.title} prog={calcRootProgress(g, goals)} />
              ))}
            </div>
          </div>
        )}

        {featuredMemory && (
          <div className="mb-8">
            <div className="flex items-center gap-2 px-6 mb-4">
              <span className="text-[11px] font-bold tracking-[2px] uppercase" style={{ color: 'var(--white-dim)' }}>Memories</span>
            </div>
            <div className="px-5 pb-1">
              <div
                onClick={() => { setActiveMemoryIdx(0); setMemoryOpen(true) }}
                className="relative rounded-[22px] overflow-hidden h-[200px] cursor-pointer mb-3 active:opacity-80"
              >
                <img
                  src={buildJournalFileUrl(featuredMemory.entry_id, featuredMemory.file)}
                  alt={featuredMemory.caption}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,.72), rgba(0,0,0,.08))' }} />
                <div
                  className="absolute top-3.5 right-3.5 rounded-full px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1.5 backdrop-blur-8"
                  style={{ background: 'rgba(255,255,255,.14)', border: '1px solid rgba(255,255,255,.18)', color: 'rgba(255,255,255,.8)' }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  {timeAgo(featuredMemory.uploaded_at || featuredMemory.snapped_at)}
                </div>
                <div className="absolute bottom-0 left-0 right-0 px-4 pb-4 pt-4 z-[1]">
                  <div className="text-[11px] font-bold tracking-wider uppercase mb-1" style={{ color: 'rgba(255,255,255,.55)' }}>
                    {formatMonthYear(featuredMemory.snapped_at)}
                  </div>
                  <div className="text-[20px] font-extrabold tracking-tight leading-tight">
                    {memoryTitle(featuredMemory)}
                  </div>
                  <div className="text-xs font-medium mt-1" style={{ color: 'rgba(255,255,255,.45)' }}>
                    {sameMonthMemories.length} moments
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); openJournalEntry(featuredMemory.entry_id) }}
                    className="mt-3 inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
                    style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.14)', color: 'rgba(255,255,255,.82)' }}
                  >
                    Open note
                  </button>
                </div>
              </div>
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                {memoryThumbs.map((memory, i) => (
                  <div
                    key={`${memory.entry_id}-${memory.file}`}
                    onClick={() => { setActiveMemoryIdx(i); setMemoryOpen(true) }}
                    className="flex-shrink-0 w-[72px] h-[72px] rounded-[13px] overflow-hidden relative cursor-pointer"
                  >
                    <img
                      src={buildJournalFileUrl(memory.entry_id, memory.file)}
                      alt={memory.caption}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,.12)' }} />
                  </div>
                ))}
                {memories.length > memoryThumbs.length && (
                  <div
                    onClick={() => { setActiveMemoryIdx(0); setMemoryOpen(true) }}
                    className="flex-shrink-0 w-[72px] h-[72px] rounded-[13px] flex items-center justify-center cursor-pointer"
                    style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)' }}
                  >
                    <span className="text-[11px] font-semibold" style={{ color: 'rgba(255,255,255,.3)' }}>
                      +{memories.length - memoryThumbs.length}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="mb-8">
          <div className="flex items-center gap-2 px-6 mb-4">
            <span className="text-[11px] font-bold tracking-[2px] uppercase" style={{ color: 'var(--white-dim)' }}>Achievements</span>
          </div>
          {achievements.length === 0 ? (
            <div className="px-6 py-4 text-center text-[13px]" style={{ color: 'var(--white-dim)' }}>
              Complete a journey for your first achievement
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 px-6">
              {achievements.map((a) => {
                const isAuthentic = authenticGoals.has(a.id)
                const isSubmitted = !!submittedGoals[a.id]
                return (
                  <div
                    key={a.name}
                    className="flex items-center gap-4 p-3.5 rounded-2xl"
                    style={{ background: 'var(--surface2)', border: `1px solid ${isAuthentic ? 'rgba(255,200,50,.35)' : 'rgba(255,255,255,.1)'}` }}
                  >
                    <div className="w-11 h-11 rounded-[13px] flex items-center justify-center flex-shrink-0"
                      style={{ background: isAuthentic ? 'rgba(255,200,50,.15)' : '#fff' }}>
                      {isAuthentic ? (
                        <span className="text-[22px]">⭐</span>
                      ) : (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M6 9H4a2 2 0 0 1-2-2V5h4" /><path d="M18 9h2a2 2 0 0 0 2-2V5h-4" />
                          <path d="M12 17v4" /><path d="M8 21h8" /><path d="M6 2h12v7a6 6 0 0 1-12 0V2z" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-bold truncate">{a.name}</div>
                      <div className="text-xs mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--white-dim)' }}>
                        <span>100% · {a.total} goals completed</span>
                        {isAuthentic && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(255,200,50,.15)', color: 'rgba(255,200,50,.9)' }}>Authentic</span>}
                        {!isAuthentic && isSubmitted && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.4)' }}>In review</span>}
                      </div>
                    </div>
                    {!isSubmitted && !isAuthentic && (
                      <button type="button"
                        onClick={() => setVerifyingGoalId(a.id)}
                        className="flex-shrink-0 rounded-xl px-3 py-1.5 text-[12px] font-bold"
                        style={{ background: 'rgba(255,200,50,.12)', color: 'rgba(255,200,50,.9)', border: '1px solid rgba(255,200,50,.25)' }}>
                        Verify
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <MemoryPanel
        open={memoryOpen}
        memories={memories}
        activeIdx={activeMemoryIdx}
        onClose={() => setMemoryOpen(false)}
        onSelect={setActiveMemoryIdx}
      />

      <div
        className="fixed inset-0 z-[200] flex flex-col"
        style={{
          background: 'var(--bg)',
          transform: showSettings ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 300ms ease',
        }}
      >
        <div className="px-5 pt-12 pb-4 flex items-center gap-3.5 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
          <button
            type="button"
            onClick={() => setShowSettings(false)}
            className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="text-lg font-bold tracking-tight">Settings</div>
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar">
          <div className="px-4 pb-10">
            <Group label="Identity">
              <EditRow label="Name" value={userName} placeholder="Your name" onSave={async (v) => { await postUpdate('name', v); setUserName(v) }} />
              <EditRow label="Age" value={fieldVal('age')} inputType="number" placeholder="e.g. 24" onSave={(v) => postUpdate('age', v)} />
            </Group>

            <Group label="Work schedule">
              <EditRow label="Day start" value={fieldVal('work_day_start')} inputType="time" onSave={(v) => postUpdate('work_day_start', v)} />
              <EditRow label="Daily hours" value={fieldVal('daily_work_hours')} inputType="number" placeholder="e.g. 8" onSave={(v) => postUpdate('daily_work_hours', v)} />
            </Group>

            <Group label="Connections">
              <div className="px-4 py-3.5 border-b border-white/[0.06]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">Open to meeting people</p>
                    <p className="text-[11px] mt-0.5 leading-snug" style={{ color: 'rgba(255,255,255,.35)' }}>
                      The server finds compatible people. Your private description stays server-side.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const next = !discoverable
                      await postUpdate('discoverable', next ? 'true' : 'false')
                      setDiscoverable(next)
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${discoverable ? 'bg-[#34c759]' : 'bg-[#333]'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${discoverable ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>
              {discoverable && (
                <div className="px-4 py-3">
                  <DescriptionEditor initial={description} onSave={async (v) => { await postUpdate('description', v); setDescription(v) }} />
                </div>
              )}
            </Group>

            {profileFields.length > 0 && (
              <Group label="Observed by AI">
                {profileFields.map((f) => <FieldRow key={f.key} field={f} />)}
              </Group>
            )}

            {(dsTask ?? dsSummary) && (
              <Group label="Last AI research">
                {dsTask && <FieldRow field={dsTask} />}
                {dsSummary && <FieldRow field={dsSummary} />}
              </Group>
            )}
          </div>
        </div>
      </div>

      {verifyingGoalId && (() => {
        const goal = achievements.find((a) => a.id === verifyingGoalId)
        return (
          <VerifyGoalModal
            goalId={verifyingGoalId}
            goalName={goal?.name ?? ''}
            onClose={() => setVerifyingGoalId(null)}
            onDone={(subId) => {
              const next = { ...submittedGoals, [verifyingGoalId]: subId }
              setSubmittedGoals(next)
              saveSubmittedGoals(next)
            }}
          />
        )
      })()}
    </div>
  )
}
