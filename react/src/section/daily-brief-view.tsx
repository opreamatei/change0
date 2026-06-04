import { useCallback, useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'

/* ── constants ──────────────────────────────────────────────────────── */

const HOUR_H        = 60    // px per hour
const CAL_START     = 6     // 06:00 — default scroll anchor for empty days
const BL            = 68    // left gutter
const BR            = 16    // right margin
const COL_GAP       = 3     // gap between overlapping blocks
const BLOCK_MIN     = 45    // assumed block duration (minutes)

const DOW   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const EVENT_COLORS = [
  'rgba(59,130,246,0.88)',
  'rgba(168,85,247,0.88)',
  'rgba(34,197,94,0.88)',
  'rgba(234,179,8,0.82)',
  'rgba(239,68,68,0.88)',
  'rgba(20,184,166,0.88)',
  'rgba(251,146,60,0.88)',
  'rgba(236,72,153,0.88)',
]

/* ── types ──────────────────────────────────────────────────────────── */

interface ScheduleEntry {
  time: number
  duration: number   // seconds
  goal_index: number
  title: string
}

interface ScheduleResponse {
  ok: boolean
  count: number
  entries: ScheduleEntry[]
}

interface Block {
  start: number
  end: number        // render height (clipped to next block start)
  layoutEnd: number  // unclipped duration — used only for overlap detection
  kind: 'event' | 'rem'
  entry?: ScheduleEntry
  title?: string
  col?: number
  numCols?: number
}

/* ── reminders (shown as point-in-time markers on the timeline) ─────────── */

interface RawReminder {
  id?: string
  title?: string
  time?: string
  hour?: number
  minute?: number
  days?: number[] | number
  enabled?: boolean | number
}

function reminderMinute(r: RawReminder): number {
  let h = 9, m = 0
  if (typeof r.hour === 'number' && Number.isFinite(r.hour)) h = r.hour
  if (typeof r.minute === 'number' && Number.isFinite(r.minute)) m = r.minute
  if (r.time) {
    const [hh, mm] = r.time.split(':').map((v) => Number.parseInt(v, 10))
    if (Number.isFinite(hh)) h = hh
    if (Number.isFinite(mm)) m = mm
  }
  return h * 60 + m
}
function reminderDays(r: RawReminder): number[] {
  if (Array.isArray(r.days)) return r.days
  const mask = typeof r.days === 'number' ? r.days : 0
  const out: number[] = []
  for (let d = 0; d < 7; d++) if (mask & (1 << d)) out.push(d)
  return out
}
function reminderEnabled(r: RawReminder): boolean {
  return typeof r.enabled === 'number' ? r.enabled !== 0 : r.enabled ?? true
}

/* ── layout ─────────────────────────────────────────────────────────── */

function layoutBlocks(blocks: Block[]) {
  if (!blocks.length) return
  // Sort by start; use layoutEnd as tiebreaker so longer blocks come first
  blocks.sort((a, b) => a.start - b.start || b.layoutEnd - a.layoutEnd)
  const colEnds: number[] = []
  blocks.forEach((b) => {
    // Use layoutEnd to check if a column is free
    let c = colEnds.findIndex((e) => e <= b.start)
    if (c === -1) c = colEnds.length
    colEnds[c] = b.layoutEnd   // occupy column up to the real (unclipped) end
    b.col = c
  })
  const visited = new Set<Block>()
  blocks.forEach((b) => {
    if (visited.has(b)) return
    const group = [b]
    visited.add(b)
    for (let i = 0; i < group.length; i++) {
      blocks.forEach((o) => {
        // Overlap check also uses layoutEnd
        if (!visited.has(o) && o.start < group[i].layoutEnd && o.layoutEnd > group[i].start) {
          group.push(o)
          visited.add(o)
        }
      })
    }
    const n = Math.max(...group.map((x) => x.col!)) + 1
    group.forEach((x) => (x.numCols = n))
  })
}

/* ── helpers ────────────────────────────────────────────────────────── */

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

function getWeek(now: Date): Date[] {
  const mon = new Date(now)
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon)
    d.setDate(mon.getDate() + i)
    return d
  })
}

/* ── component ──────────────────────────────────────────────────────── */

export default function DailyBriefView({ embedded = false }: { embedded?: boolean } = {}) {
  const [selected, setSelected] = useState<number | null>(null)
  const bodyRef      = useRef<HTMLDivElement>(null)
  const scrollTargetRef = useRef(0)
  const [bodyW, setBodyW] = useState(360)
  const now          = useRef(new Date()).current
  const [selDate, setSelDate] = useState<Date>(now)
  const weekDays     = getWeek(now)

  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [reminders, setReminders] = useState<RawReminder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  /* measure container width */
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const update = () => { setBodyW(el.offsetWidth || 360) }
    update()
    const obs = new ResizeObserver(update)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  /* the timeline now spans the full day; jump the scroll to the first task (or a
     sensible morning anchor on empty days) when the day or data changes */
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = scrollTargetRef.current
  }, [selDate, entries])

  /* silent GET — used on mount to load whatever the server has cached */
  const load = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(SERVER_ENDPOINTS.schedule, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ScheduleResponse
      setEntries(data.entries ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /* reminders — recurring time-of-day markers, drawn on the same timeline */
  useEffect(() => {
    let cancelled = false
    fetch(SERVER_ENDPOINTS.reminders, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { ok?: boolean; reminders?: RawReminder[] }) => {
        if (!cancelled && data.ok) setReminders(data.reminders ?? [])
      })
      .catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [])

  /* selected day's tasks — deduped by goal_index (keep earliest), sorted by time */
  const dayEntries = (() => {
    const seen = new Set<number>()
    return entries
      .filter((e) => isSameDay(new Date(e.time * 1000), selDate))
      .sort((a, b) => a.time - b.time)
      .filter((e) => { if (seen.has(e.goal_index)) return false; seen.add(e.goal_index); return true })
  })()

  /* reminders that fire on the selected weekday */
  const dayReminders = reminders
    .filter((r) => reminderEnabled(r) && reminderDays(r).includes(selDate.getDay()))
    .map((r) => ({ title: r.title?.trim() || 'Reminder', minute: reminderMinute(r) }))
    .sort((a, b) => a.minute - b.minute)

  const absStart = (e: ScheduleEntry) => {
    const d = new Date(e.time * 1000)
    return d.getHours() * 60 + d.getMinutes()   // minutes from midnight
  }
  const durOf = (e: ScheduleEntry) => (e.duration > 0 ? e.duration / 60 : BLOCK_MIN)

  /* content span (minutes from midnight); each task clamped to the next start */
  let contentMin = Infinity, contentMax = -Infinity
  dayEntries.forEach((e) => {
    const s = absStart(e)
    const en = s + durOf(e)
    contentMin = Math.min(contentMin, s)
    contentMax = Math.max(contentMax, en)
  })

  /* full-day timeline (00:00–24:00) so the schedule scrolls/drags through every
     hour rather than zooming to the work window */
  const hasContent = dayEntries.length > 0
  const viewStartH = 0
  const viewEndH   = 24
  const spanH = viewEndH - viewStartH
  const viewStartMin = 0

  /* fixed hour height (2× zoom) keeps every hour the same size and the full day
     comfortably scrollable */
  const hourH = HOUR_H * 2

  /* open scrolled to the first task (minus an hour of lead-in), or a morning
     anchor on empty days */
  scrollTargetRef.current = hasContent
    ? Math.max(0, Math.floor(contentMin / 60) - 1) * hourH
    : CAL_START * hourH

  const blocks: Block[] = dayEntries.map((entry) => {
    const start = absStart(entry) - viewStartMin
    const naturalEnd = start + durOf(entry)
    // No pre-clipping — layoutBlocks assigns separate columns for overlapping events
    return { start, end: naturalEnd, layoutEnd: naturalEnd, kind: 'event' as const, entry }
  })
  // reminders share the timeline columns; 45-min footprint for collision only
  dayReminders.forEach((rem) => {
    const start = rem.minute - viewStartMin
    blocks.push({ start, end: start + 45, layoutEnd: start + 45, kind: 'rem', title: rem.title })
  })
  layoutBlocks(blocks)

  const avail = bodyW - BL - BR

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── header ── */}
      <div className={`px-5 pb-2 flex items-end justify-between flex-shrink-0 ${embedded ? 'pt-1' : 'pt-4'}`}>
        <div>
          {!embedded && <h1 className="text-[28px] font-bold tracking-tight text-white leading-none">Schedule</h1>}
          <p className="text-[13px] mt-1" style={{ color: 'rgba(255,255,255,.38)' }}>
            {now.getDate()} {MONTH[now.getMonth()]} {now.getFullYear()}
          </p>
        </div>
      </div>

      {/* ── week strip ── */}
      <div className="flex gap-1 px-3 pt-3 pb-3 flex-shrink-0">
        {weekDays.map((d, i) => {
          const isToday = isSameDay(d, now)
          const isSel   = isSameDay(d, selDate)
          return (
            <button
              key={i}
              type="button"
              onClick={() => setSelDate(d)}
              className="flex-1 min-w-0 flex flex-col items-center gap-0.5 px-1 py-2 rounded-2xl transition-colors"
              style={{
                background: isToday ? '#ffffff' : isSel ? '#1a1a1a' : 'transparent',
              }}
            >
              <span
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: isToday ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.38)' }}
              >
                {DOW[d.getDay()]}
              </span>
              <span
                className="text-[18px] font-bold leading-none"
                style={{ color: isToday ? '#000' : '#fff' }}
              >
                {d.getDate()}
              </span>
            </button>
          )
        })}
      </div>

      <div className="h-px flex-shrink-0" style={{ background: 'rgba(255,255,255,.06)' }} />

      {error && (
        <p className="mx-5 mt-3 rounded-xl px-3 py-2 text-xs flex-shrink-0"
          style={{ background: 'rgba(239,68,68,.1)', color: 'rgba(239,68,68,.8)', border: '1px solid rgba(239,68,68,.2)' }}>
          {error}
        </p>
      )}

      {/* ── timeline ── */}
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto relative no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y', overscrollBehavior: 'contain' }}>
        <div
          className="relative pb-8"
          style={{ paddingLeft: BL, paddingRight: BR, minHeight: spanH * hourH + 32 }}
        >
          {/* hour grid */}
          {Array.from({ length: spanH + 1 }, (_, idx) => {
            const h = viewStartH + idx
            const y = idx * hourH
            return (
              <div key={h}>
                <div
                  className="absolute h-px"
                  style={{ top: y, left: BL, right: BR, background: 'rgba(255,255,255,.05)' }}
                />
                <div
                  className="absolute text-right tabular-nums select-none"
                  style={{
                    top: y,
                    left: 0,
                    width: BL - 10,
                    fontSize: 11,
                    color: 'rgba(255,255,255,.28)',
                    transform: 'translateY(-7px)',
                  }}
                >
                  {String(h).padStart(2, '0')}:00
                </div>
              </div>
            )
          })}

          {/* event blocks */}
          {blocks.map((b, i) => {
            const colW  = (avail - (b.numCols! - 1) * COL_GAP) / b.numCols!
            const left  = BL + b.col! * (colW + COL_GAP)
            const top   = (b.start * hourH) / 60

            if (b.kind === 'rem') {
              return (
                <div
                  key={i}
                  className="absolute flex items-center gap-1.5 overflow-hidden rounded-lg px-2.5"
                  style={{ top, left, width: colW, height: 28, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderLeft: '3px solid rgba(255,255,255,.35)' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <span className="truncate text-xs font-medium" style={{ color: 'rgba(255,255,255,.65)' }}>{b.title}</span>
                </div>
              )
            }

            const entry = b.entry!
            /* Height comes from the (clamped) real duration, but a readable floor
               keeps even 5-minute tasks tall enough to show their title. */
            const h     = Math.max(((b.end - b.start) * hourH) / 60, 30)
            const color = EVENT_COLORS[entry.goal_index % EVENT_COLORS.length]
            const d     = new Date(entry.time * 1000)
            const tStr  = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

            const isSel = selected === i
            return (
              <div
                key={i}
                onClick={() => setSelected((s) => (s === i ? null : i))}
                className="absolute cursor-pointer overflow-hidden transition-all"
                style={{
                  top,
                  height: h,
                  left,
                  width: colW,
                  background: color,
                  borderRadius: 10,
                  border: isSel ? '1px solid rgba(255,255,255,.5)' : '1px solid rgba(255,255,255,.12)',
                  padding: '6px 10px',
                  opacity: selected === null || isSel ? 1 : 0.5,
                  transform: isSel ? 'scale(1.015)' : 'none',
                  boxShadow: isSel ? '0 6px 22px rgba(0,0,0,.55)' : 'none',
                  zIndex: isSel ? 6 : 1,
                }}
              >
                <div
                  className="font-semibold truncate"
                  style={{ fontSize: 13, color: '#fff', lineHeight: '1.3' }}
                >
                  {entry.title}
                </div>
                {h > 40 && (
                  <div style={{ fontSize: 11, marginTop: 2, color: 'rgba(255,255,255,.6)' }}>
                    {tStr}
                  </div>
                )}
              </div>
            )
          })}

          {/* current time indicator */}
          {isSameDay(selDate, now) && (() => {
            const nowMin = (now.getHours() * 60 + now.getMinutes()) - viewStartMin
            if (nowMin < 0 || nowMin > spanH * 60) return null
            const ny = (nowMin * hourH) / 60
            return (
              <>
                <div
                  className="absolute rounded-full"
                  style={{
                    top: ny, left: BL - 5,
                    width: 8, height: 8,
                    background: '#ff453a',
                    transform: 'translateY(-4px)',
                    zIndex: 5,
                  }}
                />
                <div
                  className="absolute"
                  style={{
                    top: ny, left: BL, right: BR,
                    height: 1.5,
                    background: '#ff453a',
                    zIndex: 5,
                  }}
                />
              </>
            )
          })()}

          {/* empty state */}
          {!loading && dayEntries.length === 0 && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ color: 'rgba(255,255,255,.2)', fontSize: 13 }}
            >
              Nothing scheduled
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
