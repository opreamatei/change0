import { useCallback, useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'
import {
  findGoalByGlobalIndex,
  inferGoalState,
  isLeafGoal,
  loadGoalsFromServer,
  type Goal,
} from '../goal'

/* ── ring constants ─────────────────────────────────────────────────── */

const RING_R    = 72
const RING_CIRC = 2 * Math.PI * RING_R

/* ── progress helpers ───────────────────────────────────────────────── */

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
  const done   = leaves.filter((g) => inferGoalState(g) === 'finished').length
  return { done, total: leaves.length, pct: leaves.length ? done / leaves.length : 0 }
}

/* ── ring card ──────────────────────────────────────────────────────── */

function RingCard({ name, prog }: { name: string; prog: { done: number; total: number; pct: number } }) {
  const offset = (RING_CIRC * (1 - prog.pct)).toFixed(2)
  const [shown, setShown] = useState(false)
  useEffect(() => { requestAnimationFrame(() => requestAnimationFrame(() => setShown(true))) }, [])

  const SIZE = 176
  const CX   = SIZE / 2

  return (
    <div className="snap-start flex-shrink-0 flex flex-col items-center" style={{ width: SIZE }}>
      <div className="relative flex items-center justify-center" style={{ width: SIZE, height: SIZE }}>
        <svg
          className="absolute inset-0"
          width={SIZE} height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
        >
          <circle cx={CX} cy={CX} r={RING_R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="9" />
          <circle
            cx={CX} cy={CX} r={RING_R} fill="none"
            stroke="rgba(255,255,255,0.90)" strokeWidth="9" strokeLinecap="round"
            strokeDasharray={RING_CIRC.toFixed(2)}
            strokeDashoffset={shown ? offset : RING_CIRC.toFixed(2)}
            transform={`rotate(-90 ${CX} ${CX})`}
            className="ring-arc"
          />
        </svg>
        <div className="relative z-[1] flex flex-col items-center justify-center text-center px-3" style={{ width: 116 }}>
          <div
            className="text-[14px] font-extrabold leading-snug tracking-tight overflow-hidden"
            style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as never }}
          >
            {name}
          </div>
          <div className="mt-1 text-[12px] font-bold" style={{ color: 'rgba(255,255,255,.45)' }}>
            {Math.round(prog.pct * 100)}%
          </div>
        </div>
      </div>
      <div className="text-[11px] mt-1 font-semibold" style={{ color: 'var(--white-dim)' }}>
        {prog.done}/{prog.total} done
      </div>
    </div>
  )
}

/* ── profile types ──────────────────────────────────────────────────── */

interface ProfileField { key: string; value: string }

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
  'last_repair_reason', 'latest_input_theme', 'updated_at', 'profile_kind',
  'profile_note', 'latest_input_source', 'latest_input', 'last_goal_id',
  'current_focus_goal_id',
])
const DS_KEYS      = new Set(['last_ds_task', 'last_ds_summary'])
const SCHEDULE_KEYS = ['work_day_start', 'daily_work_hours']

function parseDerived(raw: string): ProfileField[] {
  return raw.split('\n')
    .filter((l) => l.includes('='))
    .map((line) => {
      const eq  = line.indexOf('=')
      const key = line.slice(0, eq).trim()
      const esc = line.slice(eq + 1).trim()
      let value = esc
      try { value = JSON.parse('"' + esc + '"') } catch { /* raw */ }
      return { key, value }
    })
    .filter((f) => f.key && f.value && !HIDDEN_KEYS.has(f.key))
}

/* ── group / row components ─────────────────────────────────────────── */

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

function EditRow({
  label, value: init, inputType = 'text', placeholder, onSave,
}: { label: string; value: string; inputType?: string; placeholder?: string; onSave: (v: string) => Promise<void> }) {
  const [value, setValue]   = useState(init)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setValue(init) }, [init])

  async function save() {
    if (value === init) return
    setSaving(true)
    try {
      await onSave(value)
      setSaved(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setSaved(false), 1500)
    } finally { setSaving(false) }
  }

  const dirty = value !== init
  return (
    <div className="px-4 py-3 border-b border-white/[0.06] last:border-b-0">
      <p className="text-[11px] mb-1.5" style={{ color: 'rgba(255,255,255,.4)' }}>{label}</p>
      <div className="flex items-center gap-2">
        <input
          className="flex-1 min-w-0 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-white outline-none focus:border-white/30"
          type={inputType} value={value} placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
        />
        <button
          className={`shrink-0 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
            saved  ? 'bg-green-950/30 text-green-400' :
            dirty  ? 'bg-white/10 text-white' :
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

function FieldRow({ field }: { field: ProfileField }) {
  const [expanded, setExpanded] = useState(false)
  const label  = FIELD_LABELS[field.key] ?? field.key.replace(/_/g, ' ')
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

async function postUpdate(key: string, value: string, extra?: Record<string, string>) {
  const res = await fetch(SERVER_ENDPOINTS.profileUpdate, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value, ...extra }),
  })
  if (!res.ok) throw new Error(`Update failed: ${res.status}`)
}

/* ── main component ─────────────────────────────────────────────────── */

export default function SettingsView() {
  const [fields, setFields]           = useState<ProfileField[]>([])
  const [userName, setUserName]       = useState('')
  const [discoverable, setDiscoverable] = useState(false)
  const [description, setDescription] = useState('')
  const [loading, setLoading]         = useState(true)
  const [goals, setGoals]             = useState<Goal[]>([])

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
      setDiscoverable(data.discoverable ?? false)
      setDescription(data.description ?? '')
      setFields(parseDerived(data.derived ?? ''))
      setGoals(loadedGoals)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const SCHED_DEFAULTS: Record<string, string> = { work_day_start: '09:00', daily_work_hours: '8' }
  const fieldVal = (key: string) => fields.find((f) => f.key === key)?.value ?? SCHED_DEFAULTS[key] ?? ''

  const profileFields = fields.filter((f) => !DS_KEYS.has(f.key) && !SCHEDULE_KEYS.includes(f.key))
  const dsTask        = fields.find((f) => f.key === 'last_ds_task')
  const dsSummary     = fields.find((f) => f.key === 'last_ds_summary')

  const rootGoals = goals.filter((g) => g.parent === null)

  const initial = userName ? userName.charAt(0).toUpperCase() : '?'

  if (loading) return (
    <div className="flex items-center justify-center py-20 text-sm text-white/40">Loading…</div>
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* header */}
      <div className="px-5 pt-12 pb-5 flex items-center gap-4 flex-shrink-0">
        <div
          className="w-[52px] h-[52px] rounded-full flex items-center justify-center text-xl font-bold flex-shrink-0"
          style={{ background: 'var(--surface2)', border: '2px solid var(--border-light)' }}
        >
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[22px] font-bold tracking-tight truncate">{userName || 'You'}</div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}
          title="Refresh"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar">

        {/* progress rings */}
        {rootGoals.length > 0 && (
          <div className="mb-6">
            <div className="px-5 mb-3">
              <span className="text-[11px] font-bold tracking-[2px] uppercase" style={{ color: 'var(--white-dim)' }}>Progress</span>
            </div>
            <div className="flex gap-3 px-5 overflow-x-auto no-scrollbar snap-x">
              {rootGoals.map((g) => (
                <RingCard key={g.localIndex} name={g.title} prog={calcRootProgress(g, goals)} />
              ))}
            </div>
          </div>
        )}

        <div className="px-4 pb-10">

          {/* Identity */}
          <Group label="Identity">
            <EditRow label="Name" value={userName} placeholder="Your name"
              onSave={async (v) => { await postUpdate('name', v); setUserName(v) }} />
            <EditRow label="Age" value={fieldVal('age')} inputType="number" placeholder="e.g. 24"
              onSave={(v) => postUpdate('age', v)} />
          </Group>

          {/* Work schedule */}
          <Group label="Work schedule">
            <EditRow label="Day start" value={fieldVal('work_day_start')} inputType="time"
              onSave={(v) => postUpdate('work_day_start', v)} />
            <EditRow label="Daily hours" value={fieldVal('daily_work_hours')} inputType="number" placeholder="e.g. 8"
              onSave={(v) => postUpdate('daily_work_hours', v)} />
          </Group>

          {/* Connections */}
          <Group label="Connections">
            <div className="px-4 py-3.5 border-b border-white/[0.06]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">Open to meeting people</p>
                  <p className="text-[11px] mt-0.5 leading-snug" style={{ color: 'rgba(255,255,255,.35)' }}>
                    The server finds compatible people. Who you are stays private.
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
                    discoverable ? 'bg-[#34c759]' : 'bg-[#333]'
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    discoverable ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </div>
            </div>
            {discoverable && (
              <div className="px-4 py-3">
                <DescriptionEditor
                  initial={description}
                  onSave={async (v) => { await postUpdate('description', v); setDescription(v) }}
                />
              </div>
            )}
          </Group>

          {/* AI-observed */}
          {profileFields.length > 0 && (
            <Group label="Observed by AI">
              {profileFields.map((f) => <FieldRow key={f.key} field={f} />)}
            </Group>
          )}

          {/* Last AI research */}
          {(dsTask ?? dsSummary) && (
            <Group label="Last AI research">
              {dsTask    && <FieldRow field={{ key: 'last_ds_task',    value: dsTask.value }}    />}
              {dsSummary && <FieldRow field={{ key: 'last_ds_summary', value: dsSummary.value }} />}
            </Group>
          )}

        </div>
      </div>
    </div>
  )
}

function DescriptionEditor({ initial, onSave }: { initial: string; onSave: (v: string) => Promise<void> }) {
  const [value, setValue]   = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
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
      <p className="text-[11px] leading-snug" style={{ color: 'rgba(255,255,255,.35)' }}>
        A short portrait of who you are. Only the server sees this — the other person only sees why you might get along.
      </p>
      <textarea
        className="w-full rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-white outline-none focus:border-white/30 resize-none"
        rows={3} value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. Quietly curious, drawn to building things from scratch…"
      />
      <button
        className={`rounded-xl px-4 py-2 text-xs font-medium transition-colors ${
          saved  ? 'bg-green-950/30 text-green-400' :
          dirty  ? 'bg-white/10 text-white' :
          'text-white/25 cursor-default'
        }`}
        onClick={() => void save()} disabled={saving || !dirty}
      >
        {saved ? 'Saved' : saving ? '…' : 'Save description'}
      </button>
    </div>
  )
}
