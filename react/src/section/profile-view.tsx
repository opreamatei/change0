import { useCallback, useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'

interface ProfileField {
  key: string
  value: string
}

interface ProfileResponse {
  ok: boolean
  name: string
  user_id: string
  derived: string
  discoverable: boolean
  description: string
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

function parseDerived(raw: string): ProfileField[] {
  const lines = raw.split('\n').filter((l) => l.includes('='))
  return lines.map((line) => {
    const eq = line.indexOf('=')
    const key = line.slice(0, eq).trim()
    const escaped = line.slice(eq + 1).trim()
    let value = escaped
    try { value = JSON.parse('"' + escaped + '"') } catch { /* keep raw */ }
    return { key, value }
  }).filter((f) => f.key && f.value && !HIDDEN_KEYS.has(f.key))
}

function FieldCard({ field }: { field: ProfileField }) {
  const [expanded, setExpanded] = useState(false)
  const label = FIELD_LABELS[field.key] ?? field.key.replace(/_/g, ' ')
  const isLong = field.value.length > 120

  return (
    <div className="rounded-2xl border border-neutral-100 bg-white px-4 py-3">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">{label}</p>
      <p className={`text-sm text-black leading-relaxed ${!expanded && isLong ? 'line-clamp-2' : ''}`}>
        {field.value}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="mt-1 text-[11px] text-neutral-400 hover:text-neutral-600"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/* A single editable row: label + input + save button */
function EditRow({
  label,
  value: initialValue,
  inputType = 'text',
  placeholder,
  onSave,
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
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* sync when parent refreshes */
  useEffect(() => { setValue(initialValue) }, [initialValue])

  async function save() {
    if (value === initialValue) return
    setSaving(true)
    try {
      await onSave(value)
      setSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  const dirty = value !== initialValue

  return (
    <div className="flex items-center gap-3">
      <label className="w-36 shrink-0 text-xs text-neutral-500">{label}</label>
      <input
        className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-black"
        type={inputType}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
      />
      <button
        className={`shrink-0 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
          saved ? 'bg-green-50 text-green-600' :
          dirty ? 'bg-black text-white' :
          'bg-neutral-100 text-neutral-400 cursor-default'
        }`}
        onClick={() => void save()}
        disabled={saving || !dirty}
      >
        {saved ? 'Saved' : saving ? '…' : 'Save'}
      </button>
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

export default function ProfileView() {
  const [fields, setFields] = useState<ProfileField[]>([])
  const [userName, setUserName] = useState('')
  const [discoverable, setDiscoverable] = useState(false)
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(SERVER_ENDPOINTS.profile, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Profile fetch failed: ${res.status}`)
      const data = (await res.json()) as ProfileResponse
      setUserName(data.name ?? '')
      setDiscoverable(data.discoverable ?? false)
      setDescription(data.description ?? '')
      setFields(parseDerived(data.derived ?? ''))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const SCHEDULE_DEFAULTS: Record<string, string> = {
    work_day_start: '09:00',
    daily_work_hours: '8',
  }

  function fieldVal(key: string) {
    return fields.find((f) => f.key === key)?.value ?? SCHEDULE_DEFAULTS[key] ?? ''
  }

  const profileFields = fields.filter(
    (f) => !DS_KEYS.has(f.key) && !SCHEDULE_KEYS.includes(f.key)
  )
  const dsTask    = fields.find((f) => f.key === 'last_ds_task')
  const dsSummary = fields.find((f) => f.key === 'last_ds_summary')

  if (loading) return (
    <div className="flex items-center justify-center py-20 text-sm text-neutral-400">Loading…</div>
  )

  if (error) return (
    <div className="py-8 text-center text-sm text-red-500">{error}</div>
  )

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-6 space-y-6">

      {/* header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-black">{userName || 'You'}</h2>
          <p className="text-xs text-neutral-400">Settings & what the AI knows about you</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-neutral-200 px-2.5 py-1 text-xs text-neutral-500 hover:bg-neutral-50"
        >
          Refresh
        </button>
      </div>

      {/* identity settings */}
      <section className="rounded-2xl border border-neutral-100 bg-white px-5 py-4 space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400">Identity</p>
        <EditRow
          label="Name"
          value={userName}
          placeholder="Your name"
          onSave={async (v) => { await postUpdate('name', v); setUserName(v) }}
        />
        <EditRow
          label="Age"
          value={fieldVal('age')}
          inputType="number"
          placeholder="e.g. 24"
          onSave={(v) => postUpdate('age', v)}
        />
      </section>

      {/* schedule settings */}
      <section className="rounded-2xl border border-neutral-100 bg-white px-5 py-4 space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400">Work schedule</p>
        <EditRow
          label="Day start"
          value={fieldVal('work_day_start')}
          inputType="time"
          onSave={(v) => postUpdate('work_day_start', v)}
        />
        <EditRow
          label="Daily hours"
          value={fieldVal('daily_work_hours')}
          inputType="number"
          placeholder="e.g. 8"
          onSave={(v) => postUpdate('daily_work_hours', v)}
        />
      </section>

      {/* connection discoverability */}
      <section className="rounded-2xl border border-neutral-100 bg-white px-5 py-4 space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400">Connections</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Open to meeting people</p>
            <p className="text-[11px] text-neutral-400 mt-0.5">
              The server looks for compatible people. Who you are stays private — they only see why you might get along.
            </p>
          </div>
          <button
            type="button"
            onClick={async () => {
              const next = !discoverable
              await postUpdate('discoverable', next ? 'true' : 'false')
              setDiscoverable(next)
            }}
            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${
              discoverable ? 'bg-black' : 'bg-neutral-200'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                discoverable ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        {discoverable && (
          <DescriptionEditor
            initial={description}
            onSave={async (v) => { await postUpdate('description', v); setDescription(v) }}
          />
        )}
      </section>

      {/* AI-observed profile fields */}
      {profileFields.length > 0 && (
        <section>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-neutral-400 px-1">
            Observed by AI
          </p>
          <div className="space-y-2">
            {profileFields.map((f) => (
              <FieldCard key={f.key} field={f} />
            ))}
          </div>
        </section>
      )}

      {/* last AI research */}
      {(dsTask || dsSummary) && (
        <section className="rounded-2xl border border-neutral-100 bg-neutral-50 px-4 py-4">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
            Last AI research
          </p>
          {dsTask && (
            <p className="mb-2 text-xs font-medium text-neutral-500">Q: {dsTask.value}</p>
          )}
          {dsSummary && <FieldCard field={{ key: 'last_ds_summary', value: dsSummary.value }} />}
        </section>
      )}
    </div>
  )
}

/* Separate component so textarea state is isolated */
function DescriptionEditor({
  initial,
  onSave,
}: {
  initial: string
  onSave: (v: string) => Promise<void>
}) {
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
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500">
        A short portrait of who you are — how you think, what you care about, what draws you.
        Only the server sees this text. The other person only ever sees a reason you might get along.
      </p>
      <textarea
        className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-black resize-none"
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. Quietly curious, drawn to building things from scratch, tends to think in systems, values depth over speed."
      />
      <button
        className={`rounded-xl px-4 py-2 text-xs font-medium transition-colors ${
          saved ? 'bg-green-50 text-green-600' :
          dirty ? 'bg-black text-white' :
          'bg-neutral-100 text-neutral-400 cursor-default'
        }`}
        onClick={() => void save()}
        disabled={saving || !dirty}
      >
        {saved ? 'Saved' : saving ? '…' : 'Save description'}
      </button>
    </div>
  )
}
