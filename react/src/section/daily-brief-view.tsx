import { useCallback, useEffect, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'

interface ScheduleEntry {
  time: number
  goal_index: number
  title: string
}

interface ScheduleResponse {
  ok: boolean
  count: number
  entries: ScheduleEntry[]
}

function fmt(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dayLabel(ts: number) {
  const d = new Date(ts * 1000)
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)

  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  if (same(d, today)) return 'Today'
  if (same(d, tomorrow)) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

function groupByDay(entries: ScheduleEntry[]): { day: string; items: ScheduleEntry[] }[] {
  const groups: { day: string; items: ScheduleEntry[] }[] = []
  const seen = new Set<number>()
  const sorted = [...entries].sort((a, b) => a.time - b.time).filter((e) => {
    if (seen.has(e.goal_index)) return false
    seen.add(e.goal_index)
    return true
  })
  for (const entry of sorted) {
    const label = dayLabel(entry.time)
    const last = groups[groups.length - 1]
    if (last && last.day === label) last.items.push(entry)
    else groups.push({ day: label, items: [entry] })
  }
  return groups
}

function weekStats(entries: ScheduleEntry[]) {
  const now = Date.now() / 1000
  const weekEnd = now + 7 * 86400
  const seen = new Set<number>()
  let count = 0
  for (const e of entries) {
    if (e.time >= now && e.time <= weekEnd && !seen.has(e.goal_index)) {
      seen.add(e.goal_index)
      count++
    }
  }
  return count
}

export default function DailyBriefView() {
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(SERVER_ENDPOINTS.schedule, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Schedule fetch failed: ${res.status}`)
      const data = (await res.json()) as ScheduleResponse
      setEntries(data.entries ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const now = Date.now() / 1000
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)
  const todayEndTs = todayEnd.getTime() / 1000

  const seenToday = new Set<number>()
  const todayEntries: ScheduleEntry[] = []
  for (const e of entries) {
    if (e.time >= now && e.time <= todayEndTs && !seenToday.has(e.goal_index)) {
      seenToday.add(e.goal_index)
      todayEntries.push(e)
    }
  }
  todayEntries.sort((a, b) => a.time - b.time)

  const weekCount = weekStats(entries)
  const groups = groupByDay(entries.filter((e) => e.time >= now))

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-neutral-400">Loading brief…</div>
    )
  }

  if (error) {
    return (
      <div className="py-8 text-center text-sm text-red-500">{error}</div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-6">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-black">Daily Brief</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-neutral-200 px-2.5 py-1 text-xs text-neutral-500 hover:bg-neutral-50"
        >
          Refresh
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-neutral-100 bg-neutral-50 p-4">
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-400">Today</p>
          <p className="mt-1 text-2xl font-bold text-black">{todayEntries.length}</p>
          <p className="text-xs text-neutral-500">{todayEntries.length === 1 ? 'task' : 'tasks'} scheduled</p>
        </div>
        <div className="rounded-2xl border border-neutral-100 bg-neutral-50 p-4">
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-400">This week</p>
          <p className="mt-1 text-2xl font-bold text-black">{weekCount}</p>
          <p className="text-xs text-neutral-500">{weekCount === 1 ? 'task' : 'tasks'} ahead</p>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-neutral-400">No upcoming tasks — you're clear.</p>
      ) : (
        <div className="space-y-6">
          {groups.slice(0, 7).map((group) => (
            <div key={group.day}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-400">{group.day}</p>
              <div className="divide-y divide-neutral-100 rounded-2xl border border-neutral-100 bg-white overflow-hidden">
                {group.items.map((entry) => (
                  <div key={entry.goal_index} className="flex items-center gap-3 px-4 py-3">
                    <span className="w-12 shrink-0 text-right text-xs tabular-nums text-neutral-400">{fmt(entry.time)}</span>
                    <span className="flex-1 text-sm text-black">{entry.title}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
