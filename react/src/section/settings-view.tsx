import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS } from '../config/server'
import {
  findGoalByGlobalIndex,
  goalsFromContainer,
  inferGoalState,
  isLeafGoal,
  loadGoalsFromServer,
  type Goal,
  type GoalListResponse,
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
  share_profile: boolean
  description: string
  color?: string
  memories: MemoryItem[]
}

/* A person the user has interacted with — drawn from shared journeys (ongoing
 * and finished) and from confirmed connections. */
interface SharedPerson {
  id: string
  display_name: string
  color?: string
}

interface SharedJourneyListResponse {
  ok: boolean
  journeys: { id: string; participants: SharedPerson[] }[]
}

interface ConnectionsListResponse {
  ok: boolean
  connections: { state: number; other_id: string; other_name: string }[]
}

/* Gather everyone the user shares a journey with (any state — ongoing or
 * completed) plus everyone they have a confirmed connection with. Deduped by id,
 * self excluded. Failures on either source are non-fatal. */
async function loadSharedPeople(userId: string): Promise<SharedPerson[]> {
  const people = new Map<string, SharedPerson>()

  const [journeysResult, connectionsResult] = await Promise.allSettled([
    fetch(CENTRAL_ENDPOINTS.journeyList(userId), { cache: 'no-store' }),
    fetch(CENTRAL_ENDPOINTS.connections(userId), { cache: 'no-store' }),
  ])

  if (journeysResult.status === 'fulfilled' && journeysResult.value.ok) {
    const data = (await journeysResult.value.json()) as SharedJourneyListResponse
    if (data.ok) {
      for (const journey of data.journeys ?? []) {
        for (const participant of journey.participants ?? []) {
          if (participant.id && participant.id !== userId) {
            people.set(participant.id, participant)
          }
        }
      }
    }
  }

  if (connectionsResult.status === 'fulfilled' && connectionsResult.value.ok) {
    const data = (await connectionsResult.value.json()) as ConnectionsListResponse
    if (data.ok) {
      for (const conn of data.connections ?? []) {
        /* state 1 = confirmed */
        if (conn.state === 1 && conn.other_id && !people.has(conn.other_id)) {
          people.set(conn.other_id, {
            id: conn.other_id,
            display_name: conn.other_name || 'Connection',
          })
        }
      }
    }
  }

  return [...people.values()]
}

/* A connected person's public goal portfolio, served by the central server from
 * the snapshot file their own client wrote. `goals` is the /goal/list container. */
interface ProfileSnapshot {
  ok: boolean
  user_id: string
  name: string
  color?: string
  share_profile: boolean
  goals: GoalListResponse
}

/* Cache snapshots in localStorage so a profile opens instantly and remains
 * viewable offline / when the owner's server is down. */
const SNAPSHOT_CACHE_PREFIX = 'change.profileSnapshot.'

function readSnapshotCache(userId: string): ProfileSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_CACHE_PREFIX + userId)
    return raw ? (JSON.parse(raw) as ProfileSnapshot) : null
  } catch {
    return null
  }
}

function writeSnapshotCache(userId: string, snap: ProfileSnapshot) {
  try {
    localStorage.setItem(SNAPSHOT_CACHE_PREFIX + userId, JSON.stringify(snap))
  } catch {
    /* quota / serialization issues are non-fatal */
  }
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

/* Profile picture for a connected person. Served from the central server's
 * shared avatar layout; falls back to the coloured initial on error. */
function PersonAvatar({ person, onClick }: { person: SharedPerson; onClick?: (p: SharedPerson) => void }) {
  const [failed, setFailed] = useState(false)
  const initial = (person.display_name || '?').charAt(0).toUpperCase()
  return (
    <div
      onClick={onClick ? () => onClick(person) : undefined}
      className={`w-[54px] h-[54px] rounded-full flex-shrink-0 flex items-center justify-center overflow-hidden text-lg font-bold ${onClick ? 'cursor-pointer active:opacity-70' : ''}`}
      style={{
        background: person.color || 'var(--surface2)',
        color: person.color ? '#0a0a0a' : 'var(--white-dim)',
        border: '2px solid var(--border-light)',
      }}
      title={person.display_name}
      aria-label={person.display_name}
    >
      {!failed ? (
        <img
          src={CENTRAL_ENDPOINTS.userAvatar(person.id)}
          onError={() => setFailed(true)}
          className="w-full h-full object-cover"
          alt=""
        />
      ) : (
        <span>{initial}</span>
      )}
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

/* Read-only view of another person's goal portfolio. Renders from the cached
 * snapshot first, then refreshes from the central server. Reuses RingCard and
 * calcRootProgress, the same primitives the owner's own profile uses. */
function ViewedProfilePanel({ person, onClose }: { person: SharedPerson; onClose: () => void }) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [name, setName] = useState(person.display_name)
  const [color, setColor] = useState<string | undefined>(person.color)
  const [authenticIds, setAuthenticIds] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<'loading' | 'ready' | 'not_shared' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false

    const applySnapshot = (snap: ProfileSnapshot) => {
      setGoals(goalsFromContainer(snap.goals))
      if (snap.name) setName(snap.name)
      if (snap.color) setColor(snap.color)
      setStatus('ready')
    }

    const cached = readSnapshotCache(person.id)
    if (cached) applySnapshot(cached)

    fetch(CENTRAL_ENDPOINTS.userProfile(person.id), { cache: 'no-store' })
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) { if (!cached) setStatus('not_shared'); return }
        if (!res.ok) throw new Error(`profile fetch failed (${res.status})`)
        const data = (await res.json()) as ProfileSnapshot
        if (cancelled) return
        writeSnapshotCache(person.id, data)
        applySnapshot(data)
      })
      .catch(() => { if (!cancelled && !cached) setStatus('error') })

    /* Which of their goals are peer-verified — fetched live so it reflects
     * reviews that completed after their snapshot was last written. */
    fetch(CENTRAL_ENDPOINTS.userAuthenticGoals(person.id), { cache: 'no-store' })
      .then(async (res) => {
        if (cancelled || !res.ok) return
        const data = (await res.json()) as { ok: boolean; goal_ids?: string[] }
        if (!cancelled && data.ok) setAuthenticIds(new Set(data.goal_ids ?? []))
      })
      .catch(() => { /* non-fatal: just no verified badges */ })

    return () => { cancelled = true }
  }, [person.id])

  const rootGoals = goals.filter((g) => g.parent === null)
  const activeRoots = rootGoals.filter((g) => calcRootProgress(g, goals).total > 0)
  const achievements = rootGoals
    .filter((g) => { const p = calcRootProgress(g, goals); return p.total > 0 && p.done === p.total })
    .map((g) => ({ id: g.id, name: g.title, total: calcRootProgress(g, goals).total }))

  return (
    <div className="fixed inset-0 z-[205] flex flex-col anim-pg-in" style={{ background: 'var(--bg)' }}>
      <div className="px-5 pt-12 pb-4 flex items-center gap-3.5 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        <button
          type="button"
          onClick={onClose}
          className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <PersonAvatar person={{ id: person.id, display_name: name, color }} />
        <div className="text-lg font-bold tracking-tight truncate">{name || 'Profile'}</div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden pb-6 no-scrollbar">
        {status === 'loading' && (
          <div className="flex items-center justify-center py-20 text-sm text-white/40">Loading…</div>
        )}
        {status === 'not_shared' && (
          <div className="px-6 py-20 text-center text-[13px]" style={{ color: 'var(--white-dim)' }}>
            {name || 'This person'} hasn't shared their profile.
          </div>
        )}
        {status === 'error' && (
          <div className="px-6 py-20 text-center text-[13px]" style={{ color: 'var(--white-dim)' }}>
            Couldn't load this profile right now.
          </div>
        )}

        {status === 'ready' && (
          <>
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

            <div className="mb-8">
              <div className="flex items-center gap-2 px-6 mb-4">
                <span className="text-[11px] font-bold tracking-[2px] uppercase" style={{ color: 'var(--white-dim)' }}>Achievements</span>
              </div>
              {achievements.length === 0 ? (
                <div className="px-6 py-4 text-center text-[13px]" style={{ color: 'var(--white-dim)' }}>
                  No completed journeys yet
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 px-6">
                  {achievements.map((a) => {
                    const isAuthentic = authenticIds.has(a.id)
                    return (
                      <div
                        key={a.id}
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
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {activeRoots.length === 0 && achievements.length === 0 && (
              <div className="px-6 py-20 text-center text-[13px]" style={{ color: 'var(--white-dim)' }}>
                {name || 'This person'} has no goals to show yet.
              </div>
            )}
          </>
        )}
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
              <div className="text-[11px] font-bold uppercase tracking-wider mb-1" style={{ color: 'rgba(255,200,50,.7)' }}>
                {result.aiLabel.trim() ? 'Reviewers will see you as' : 'Shared goal'}
              </div>
              {result.aiLabel.trim() && <div className="text-[15px] font-bold text-white mb-1">{result.aiLabel}</div>}
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

/* Derive a representative #rrggbb from an image: downscale, drop near-white /
 * near-black / desaturated pixels (usually background), then take the most
 * common remaining colour bucket. Returns null if nothing usable is found. */
async function dominantColorFromFile(file: File): Promise<string | null> {
  try {
    const url = URL.createObjectURL(file)
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = reject
      im.src = url
    })
    const S = 48
    const canvas = document.createElement('canvas')
    canvas.width = S
    canvas.height = S
    const ctx = canvas.getContext('2d')
    URL.revokeObjectURL(url)
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, S, S)
    const { data } = ctx.getImageData(0, 0, S, S)

    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      if (max < 28 || min > 224 || max - min < 14) continue // skip black/white/gray
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
      e.n++; e.r += r; e.g += g; e.b += b
      buckets.set(key, e)
    }
    let best: { n: number; r: number; g: number; b: number } | null = null
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e
    if (!best) return null
    const to = (v: number) => Math.round(v / best!.n).toString(16).padStart(2, '0')
    return `#${to(best.r)}${to(best.g)}${to(best.b)}`
  } catch {
    return null
  }
}

export default function SettingsView({
  viewPerson = null,
  onViewPersonConsumed,
}: {
  viewPerson?: SharedPerson | null
  onViewPersonConsumed?: () => void
} = {}) {
  const [fields, setFields] = useState<ProfileField[]>([])
  const [userName, setUserName] = useState('')
  const [userId, setUserId] = useState('')
  const [userColor, setUserColor] = useState('')
  const [avatarVersion, setAvatarVersion] = useState(0)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [discoverable, setDiscoverable] = useState(false)
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [goals, setGoals] = useState<Goal[]>([])
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [sharedPeople, setSharedPeople] = useState<SharedPerson[]>([])
  const [viewingPerson, setViewingPerson] = useState<SharedPerson | null>(null)
  const [shareProfile, setShareProfile] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [activeMemoryIdx, setActiveMemoryIdx] = useState(0)
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
      setUserColor(data.color ?? '')
      setDiscoverable(data.discoverable ?? false)
      setShareProfile(data.share_profile ?? true)
      setDescription(data.description ?? '')
      setFields(parseDerived(data.derived ?? ''))
      setGoals(loadedGoals)
      setMemories(Array.isArray(data.memories) ? data.memories : [])
      if (data.user_id) {
        loadSharedPeople(data.user_id)
          .then(setSharedPeople)
          .catch(() => setSharedPeople([]))
      } else {
        setSharedPeople([])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /* Opening another person's profile from elsewhere in the app (App routes the
   * tap here via the open-user-profile event). */
  useEffect(() => {
    if (viewPerson) {
      setViewingPerson(viewPerson)
      onViewPersonConsumed?.()
    }
  }, [viewPerson, onViewPersonConsumed])

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
          // Re-derive the identity colour from the new picture.
          const color = await dominantColorFromFile(file)
          if (color) { setUserColor(color); try { await postUpdate('color', color) } catch { /* non-fatal */ } }
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

  /* A single privacy switch now drives both discoverability (matchmaking) and
   * goal-profile sharing; treat the user as public if either is currently on. */
  const isPublic = discoverable || shareProfile
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
          style={{ background: userColor || 'var(--surface2)', color: userColor ? '#0a0a0a' : undefined, border: '2px solid var(--border-light)' }}
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

        {sharedPeople.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center gap-2 px-6 mb-4">
              <span className="text-[11px] font-bold tracking-[2px] uppercase" style={{ color: 'var(--white-dim)' }}>People</span>
            </div>
            <div className="flex gap-3 px-6 overflow-x-auto no-scrollbar">
              {sharedPeople.map((person) => (
                <PersonAvatar key={person.id} person={person} onClick={setViewingPerson} />
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

      {viewingPerson && (
        <ViewedProfilePanel person={viewingPerson} onClose={() => setViewingPerson(null)} />
      )}

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

            <Group label="Privacy">
              <div className="px-4 py-3.5 border-b border-white/[0.06]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">Open to others</p>
                    <p className="text-[11px] mt-0.5 leading-snug" style={{ color: 'rgba(255,255,255,.35)' }}>
                      The server matches you with compatible people, and those you connect with can open your profile to see your goals and achievements. Off keeps everything private.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const next = !isPublic
                      await Promise.all([
                        postUpdate('discoverable', next ? 'true' : 'false'),
                        postUpdate('share_profile', next ? 'true' : 'false'),
                      ])
                      setDiscoverable(next)
                      setShareProfile(next)
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${isPublic ? 'bg-[#34c759]' : 'bg-[#333]'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${isPublic ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>
              {isPublic && (
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
