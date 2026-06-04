import { useState, useCallback, useEffect } from 'react'
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

function formatScheduleTime(ts: number): { day: string; time: string } {
  const d = new Date(ts * 1000)
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)

  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()

  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()

  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (isToday) return { day: 'Today', time: timeStr }
  if (isTomorrow) return { day: 'Tomorrow', time: timeStr }

  return {
    day: d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    time: timeStr,
  }
}

function groupByDay(entries: ScheduleEntry[]): { dayLabel: string; items: ScheduleEntry[] }[] {
  const seen = new Set<number>()
  const unique = entries
    .slice()
    .sort((a, b) => a.time - b.time)
    .filter((e) => {
      if (seen.has(e.goal_index)) return false
      seen.add(e.goal_index)
      return true
    })

  const groups: Map<string, ScheduleEntry[]> = new Map()
  for (const entry of unique) {
    const { day } = formatScheduleTime(entry.time)
    const group = groups.get(day) ?? []
    group.push(entry)
    groups.set(day, group)
  }

  return Array.from(groups.entries()).map(([dayLabel, items]) => ({ dayLabel, items }))
}

export default function ScheduleView() {
  const [entries, setEntries] = useState<ScheduleEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(SERVER_ENDPOINTS.schedule, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = (await res.json()) as ScheduleResponse
      if (!data.ok) throw new Error('Server returned ok=false')

      setEntries(data.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const groups = entries ? groupByDay(entries) : []

  return (
    <section className="mx-auto w-full max-w-3xl">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Schedule</h1>
        <button
          type="button"
          className="rounded border border-[#333] px-3 py-1.5 text-sm text-white/70 hover:bg-[#1a1a1a] disabled:text-white/30"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-red-900 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}

      {loading && entries === null && (
        <p className="text-sm text-white/40">Loading schedule…</p>
      )}

      {!loading && entries !== null && entries.length === 0 && (
        <p className="rounded-xl border border-dashed border-[#2a2a2a] px-5 py-10 text-center text-sm text-white/40">
          No scheduled entries.
        </p>
      )}

      {groups.length > 0 && (
        <div className="space-y-8">
          {groups.map(({ dayLabel, items }) => (
            <div key={dayLabel}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-white/40">
                {dayLabel}
              </h2>
              <ul className="divide-y divide-white/10 rounded-xl border border-[#2a2a2a] bg-[#111]">
                {items.map((entry, i) => {
                  const { time } = formatScheduleTime(entry.time)
                  const isFirst = i === 0 && dayLabel === groups[0].dayLabel

                  return (
                    <li key={entry.goal_index} className="flex items-start gap-4 px-5 py-3">
                      <span className={`mt-0.5 w-12 shrink-0 text-right text-sm tabular-nums ${isFirst ? 'font-semibold text-white' : 'text-white/55'}`}>
                        {time}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-sm ${isFirst ? 'font-semibold text-white' : 'text-white/70'}`}>
                          {entry.title || '(no title)'}
                        </p>
                        <p className="mt-0.5 text-xs text-white/40">#{entry.goal_index}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
