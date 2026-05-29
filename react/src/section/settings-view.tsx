import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'
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
  return { done, total: leaves.length, pct: leaves.length ? done / leaves.length : 0 }
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
  const [discoverable, setDiscoverable] = useState(false)
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [goals, setGoals] = useState<Goal[]>([])
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [activeMemoryIdx, setActiveMemoryIdx] = useState(0)

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
      setMemories(Array.isArray(data.memories) ? data.memories : [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const fieldVal = (key: string) => fields.find((f) => f.key === key)?.value ?? ({ work_day_start: '09:00', daily_work_hours: '8' }[key] ?? '')
  const profileFields = fields.filter((f) => !DS_KEYS.has(f.key) && !SCHEDULE_KEYS.includes(f.key))
  const dsTask = fields.find((f) => f.key === 'last_ds_task')
  const dsSummary = fields.find((f) => f.key === 'last_ds_summary')
  const rootGoals = goals.filter((g) => g.parent === null)
  const activeRoots = rootGoals.filter((g) => calcRootProgress(g, goals).total > 0)
  const achievements = rootGoals
    .filter((g) => {
      const prog = calcRootProgress(g, goals)
      return prog.total > 0 && prog.done === prog.total
    })
    .map((g) => ({ name: g.title, total: calcRootProgress(g, goals).total }))

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
          className="w-[52px] h-[52px] rounded-full flex items-center justify-center text-xl font-bold flex-shrink-0"
          style={{ background: 'var(--surface2)', border: '2px solid var(--border-light)' }}
        >
          {initial}
        </div>
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

      <div className="flex-1 overflow-y-auto overflow-x-hidden pb-4 no-scrollbar">
        {activeRoots.length > 0 && (
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
              {achievements.map((a) => (
                <div
                  key={a.name}
                  className="flex items-center gap-4 p-3.5 rounded-2xl"
                  style={{ background: 'var(--surface2)', border: '1px solid rgba(255,255,255,.1)' }}
                >
                  <div className="w-11 h-11 rounded-[13px] flex items-center justify-center flex-shrink-0" style={{ background: '#fff' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9H4a2 2 0 0 1-2-2V5h4" /><path d="M18 9h2a2 2 0 0 0 2-2V5h-4" />
                      <path d="M12 17v4" /><path d="M8 21h8" /><path d="M6 2h12v7a6 6 0 0 1-12 0V2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-bold truncate">{a.name}</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--white-dim)' }}>
                      100% · {a.total} goals completed
                    </div>
                  </div>
                </div>
              ))}
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
    </div>
  )
}
