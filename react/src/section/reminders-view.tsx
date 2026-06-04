import { useCallback, useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'

interface Reminder {
  id: string
  title: string
  time: string
  days: number[]
  enabled: boolean
}

interface ApiReminder {
  id?: string
  title?: string
  time?: string
  hour?: number
  minute?: number
  days?: number[] | number
  enabled?: boolean | number
  end_time?: number
}

const DAY_LABELS = ['D', 'L', 'M', 'M', 'J', 'V', 'S']
const DAY_ORDER  = [1, 2, 3, 4, 5, 6, 0]
const DAY_SHORT  = ['L', 'M', 'M', 'J', 'V', 'S', 'D']

const ITEM_H = 38

function daysMaskToArray(mask: number): number[] {
  const days: number[] = []
  for (let d = 0; d < 7; d++) {
    if (mask & (1 << d)) days.push(d)
  }
  return days
}

function daysArrayToMask(days: number[]): number {
  return days.reduce((mask, d) => mask | (1 << d), 0)
}

function formatTime(hour = 9, minute = 0): string {
  return `${String(Math.max(0, Math.min(23, hour))).padStart(2, '0')}:${String(Math.max(0, Math.min(59, minute))).padStart(2, '0')}`
}

function normalizeReminder(raw: ApiReminder): Reminder {
  const [timeHour, timeMinute] = (raw.time ?? '').split(':').map((v) => Number.parseInt(v, 10))
  const hour = Number.isFinite(raw.hour) ? raw.hour : timeHour
  const minute = Number.isFinite(raw.minute) ? raw.minute : timeMinute

  return {
    id: raw.id ?? '',
    title: raw.title?.trim() || 'Reminder',
    time: formatTime(hour, minute),
    days: Array.isArray(raw.days) ? raw.days : daysMaskToArray(raw.days ?? 0),
    enabled: typeof raw.enabled === 'number' ? raw.enabled !== 0 : raw.enabled ?? true,
  }
}

function reminderSavePayload(r: Omit<Reminder, 'id'> & { id?: string }) {
  const [hourRaw, minuteRaw] = r.time.split(':')
  const hour = Number.parseInt(hourRaw ?? '', 10)
  const minute = Number.parseInt(minuteRaw ?? '', 10)

  return {
    id: r.id,
    title: r.title,
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0,
    days: daysArrayToMask(r.days),
    enabled: r.enabled ? 1 : 0,
  }
}

function PickerCol({
  values,
  initialVal,
  onChange,
}: {
  values: string[]
  initialVal: string
  onChange: (v: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) {
      const idx = Math.max(0, values.indexOf(initialVal))
      ref.current.scrollTop = idx * ITEM_H
    }
  }, [])

  return (
    <div
      ref={ref}
      className="relative z-[1] overflow-y-scroll snap-y"
      style={{ height: 176, width: 72, paddingTop: 69, paddingBottom: 69, scrollbarWidth: 'none' }}
      onScroll={(e) => {
        const idx = Math.round(e.currentTarget.scrollTop / ITEM_H)
        const v = values[Math.min(Math.max(idx, 0), values.length - 1)]
        onChange(v)
      }}
    >
      {values.map((v) => (
        <div
          key={v}
          className="flex items-center justify-center snap-center"
          style={{ height: ITEM_H, fontSize: 22, fontWeight: 300, color: 'rgba(255,255,255,.35)' }}
        >
          {v}
        </div>
      ))}
    </div>
  )
}

function ReminderModal({
  open,
  editReminder,
  onClose,
  onSave,
}: {
  open: boolean
  editReminder: Reminder | null
  onClose: () => void
  onSave: (r: Omit<Reminder, 'id'> & { id?: string }) => void
}) {
  const [title, setTitle]   = useState('')
  const [hour, setHour]     = useState('09')
  const [minute, setMinute] = useState('00')
  const [days, setDays]     = useState<number[]>([1, 2, 3, 4, 5])

  useEffect(() => {
    if (!open) return
    if (editReminder) {
      setTitle(editReminder.title)
      const [h, m] = editReminder.time.split(':')
      setHour(h ?? '09')
      setMinute(m ?? '00')
      setDays([...editReminder.days])
    } else {
      setTitle('')
      setHour('09')
      setMinute('00')
      setDays([1, 2, 3, 4, 5])
    }
  }, [open, editReminder])

  const hours   = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
  const minutes = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))

  const handleSave = () => {
    onSave({
      id: editReminder?.id,
      title: title.trim() || 'Reminder',
      time: `${hour}:${minute}`,
      days: [...days],
      enabled: editReminder?.enabled ?? true,
    })
  }

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-[300] transition-opacity"
        style={{
          background: 'rgba(0,0,0,.6)',
          backdropFilter: 'blur(8px)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'all' : 'none',
        }}
      />
      <div
        className="fixed inset-0 z-[301] flex items-center justify-center p-6"
        style={{ pointerEvents: open ? 'all' : 'none' }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[360px] overflow-hidden transition-all"
          style={{
            background: '#111',
            border: '1px solid rgba(255,255,255,.12)',
            borderRadius: 22,
            transform: open ? 'scale(1)' : 'scale(.92)',
            opacity: open ? 1 : 0,
          }}
        >
          {/* header */}
          <div
            className="flex items-center justify-between gap-3 px-4 pt-4 pb-3.5"
            style={{ borderBottom: '1px solid rgba(255,255,255,.08)' }}
          >
            <button
              onClick={onClose}
              className="cursor-pointer border-none bg-transparent py-1 text-[14px] font-medium text-white/55"
            >
              Cancel
            </button>
            <span className="text-[15px] font-bold">{editReminder ? 'Edit reminder' : 'New reminder'}</span>
            <button
              onClick={handleSave}
              className="cursor-pointer border-none bg-transparent py-1 text-[14px] font-bold text-white"
            >
              {editReminder ? 'Save' : 'Add'}
            </button>
          </div>

          {/* title input */}
          <div className="px-4 py-3.5">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-transparent outline-none text-base text-white"
              placeholder="Reminder title…"
              style={{ caretColor: '#fff' }}
            />
          </div>
          <div style={{ height: 1, background: 'rgba(255,255,255,.08)' }} />

          {/* time picker */}
          <div
            className="text-[11px] font-semibold tracking-wide uppercase px-4 pt-3 pb-1"
            style={{ color: 'rgba(255,255,255,.3)' }}
          >
            Time
          </div>
          <div className="relative flex items-center justify-center overflow-hidden" style={{ height: 176 }}>
            <div
              className="absolute pointer-events-none z-0"
              style={{
                left: '50%',
                transform: 'translateX(-50%)',
                width: 148,
                height: ITEM_H,
                borderRadius: 10,
                background: 'rgba(255,255,255,.06)',
                border: '1px solid rgba(255,255,255,.1)',
              }}
            />
            <PickerCol values={hours}   initialVal={hour}   onChange={setHour}   />
            <div className="z-[2] pb-0.5" style={{ fontSize: 26, fontWeight: 300, color: 'rgba(255,255,255,.4)', flexShrink: 0 }}>:</div>
            <PickerCol values={minutes} initialVal={minute} onChange={setMinute} />
          </div>
          <div style={{ height: 1, background: 'rgba(255,255,255,.08)' }} />

          {/* day picker */}
          <div
            className="text-[11px] font-semibold tracking-wide uppercase px-4 pt-3 pb-1"
            style={{ color: 'rgba(255,255,255,.3)' }}
          >
            Repeat
          </div>
          <div className="flex gap-1.5 px-4 pt-2 pb-4">
            {DAY_ORDER.map((d, i) => {
              const on = days.includes(d)
              return (
                <div
                  key={i}
                  onClick={() => toggleDay(d)}
                  className="flex-1 flex items-center justify-center rounded-full text-xs font-semibold cursor-pointer"
                  style={{
                    height: 38,
                    background: on ? '#fff' : 'rgba(255,255,255,.06)',
                    border: `1px solid ${on ? '#fff' : 'rgba(255,255,255,.1)'}`,
                    color: on ? '#000' : 'rgba(255,255,255,.4)',
                  }}
                >
                  {DAY_SHORT[i]}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}

export default function RemindersView({ embedded = false }: { embedded?: boolean } = {}) {
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [loading, setLoading]     = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Reminder | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(SERVER_ENDPOINTS.reminders, { cache: 'no-store' })
      const data = (await res.json()) as { ok: boolean; reminders: ApiReminder[] }
      if (data.ok) setReminders(data.reminders.map(normalizeReminder))
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const openNew  = () => { setEditTarget(null); setModalOpen(true) }
  const openEdit = (r: Reminder) => { setEditTarget(r); setModalOpen(true) }

  const handleSave = async (r: Omit<Reminder, 'id'> & { id?: string }) => {
    setModalOpen(false)
    try {
      await fetch(SERVER_ENDPOINTS.remindersSave, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reminderSavePayload(r)),
      })
      void load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (id: string) => {
    try {
      await fetch(SERVER_ENDPOINTS.remindersDelete, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      setReminders((prev) => prev.filter((r) => r.id !== id))
    } catch { /* ignore */ }
  }

  const handleToggle = async (r: Reminder, enabled: boolean) => {
    setReminders((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled } : x)))
    try {
      await fetch(SERVER_ENDPOINTS.remindersSave, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reminderSavePayload({ ...r, enabled })),
      })
    } catch { /* ignore */ }
  }

  return (
    <section className="mx-auto w-full max-w-3xl">
      {!embedded && (
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">Reminders</h1>
          {loading && <span className="text-xs text-white/40">Loading…</span>}
        </header>
      )}

      <div className="space-y-2.5">
        {reminders.map((r) => {
          const activeDays = DAY_ORDER.filter((d) => r.days.includes(d))
          const daysLabel  = activeDays.length === 0
            ? 'No days'
            : activeDays.map((d) => DAY_LABELS[d]).join(' ')

          return (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-2xl px-4 py-3.5 cursor-pointer"
              style={{ border: '1px solid rgba(255,255,255,.08)', background: '#111' }}
              onClick={() => openEdit(r)}
            >
              <div
                className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl"
                style={{ background: 'rgba(255,255,255,.06)' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold truncate">{r.title}</p>
                <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,.4)' }}>
                  {r.time} · {daysLabel}
                </p>
              </div>

              {/* toggle */}
              <label
                className="relative flex-shrink-0"
                style={{ width: 44, height: 26 }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => void handleToggle(r, e.target.checked)}
                  className="sr-only"
                />
                <div
                  className="absolute inset-0 rounded-full transition-colors"
                  style={{ background: r.enabled ? '#fff' : 'rgba(255,255,255,.12)' }}
                />
                <div
                  className="absolute top-[3px] rounded-full transition-transform"
                  style={{
                    width: 20,
                    height: 20,
                    background: r.enabled ? '#000' : 'rgba(255,255,255,.4)',
                    left: 3,
                    transform: r.enabled ? 'translateX(18px)' : 'translateX(0)',
                  }}
                />
              </label>

              {/* delete */}
              <button
                onClick={(e) => { e.stopPropagation(); void handleDelete(r.id) }}
                className="flex-shrink-0 flex items-center justify-center rounded-lg"
                style={{ width: 32, height: 32, color: 'rgba(255,255,255,.3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4h6v2" />
                </svg>
              </button>
            </div>
          )
        })}

        {!loading && reminders.length === 0 && (
          <p
            className="rounded-xl px-5 py-10 text-center text-sm"
            style={{ border: '1.5px dashed rgba(255,255,255,.1)', color: 'rgba(255,255,255,.35)' }}
          >
            No reminders yet.
          </p>
        )}

        <div
          onClick={openNew}
          className="flex items-center justify-center gap-2 rounded-2xl p-4 cursor-pointer text-[14px] font-semibold"
          style={{ border: '1.5px dashed rgba(255,255,255,.15)', color: 'rgba(255,255,255,.4)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add reminder
        </div>
      </div>

      <ReminderModal
        open={modalOpen}
        editReminder={editTarget}
        onClose={() => setModalOpen(false)}
        onSave={(r) => void handleSave(r)}
      />
    </section>
  )
}
