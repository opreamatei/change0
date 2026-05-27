import { useCallback, useEffect, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'

/* ── constants ──────────────────────────────────────────────────────── */

const MOODS = ['😊','😌','🏃','📚','🎯','😔','🔥','😴','🤔','❤️','🎉','💪']

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DOW_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

const MOOD_TAG_PREFIX = 'mood:'

/* mood stored as "mood:<index>" in tags — avoids multi-byte emoji in C strings */
function moodToTag(mood: string | null): string | null {
  if (!mood) return null
  const i = MOODS.indexOf(mood)
  return i >= 0 ? `${MOOD_TAG_PREFIX}${i}` : null
}

function tagToMood(tag: string): string | null {
  if (!tag.startsWith(MOOD_TAG_PREFIX)) return null
  const i = parseInt(tag.slice(MOOD_TAG_PREFIX.length), 10)
  return Number.isFinite(i) && i >= 0 && i < MOODS.length ? MOODS[i] : null
}

/* ── icons ──────────────────────────────────────────────────────────── */
/* 12-slot palette. iconIndex stored in C JournalMeta.icon_index */

const ICONS: { path: string; label: string; color: string }[] = [
  { label: 'Journal',  color: '#8b5cf6', path: 'M4 4h16v2H4zm0 5h10v2H4zm0 5h7v2H4zm14-1v8l-3-2-3 2v-8h6z' },
  { label: 'Star',     color: '#f59e0b', path: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' },
  { label: 'Zap',      color: '#eab308', path: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
  { label: 'Sun',      color: '#f97316', path: 'M12 7a5 5 0 1 0 0 10A5 5 0 0 0 12 7zm0-5v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42' },
  { label: 'Moon',     color: '#6366f1', path: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' },
  { label: 'Heart',    color: '#ef4444', path: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z' },
  { label: 'Target',   color: '#10b981', path: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z' },
  { label: 'Compass',  color: '#14b8a6', path: 'M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm2.5 6.5-4 8-2-4-4-2 8-4 2 2zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z' },
  { label: 'Flame',    color: '#f43f5e', path: 'M12 2c0 6-6 6-6 12a6 6 0 0 0 12 0c0-4-2-6-2-6s-1 3-3 3c0-4 2-6 2-6s-2 0-3-3z' },
  { label: 'Leaf',     color: '#22c55e', path: 'M17 8C8 10 5.9 16.17 3.82 22c2.73-1 5.5-1 8.18-4C14 15 15 9 22 7c-1 1-2 3-5 1z' },
  { label: 'Globe',    color: '#3b82f6', path: 'M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z' },
  { label: 'Key',      color: '#a78bfa', path: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4' },
]

function JournalIcon({ idx, size = 18 }: { idx: number; size?: number }) {
  const icon = ICONS[idx % ICONS.length]
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={icon.color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={icon.path} />
    </svg>
  )
}

/* ── types ──────────────────────────────────────────────────────────── */

interface JournalMeta {
  id: string
  title: string
  tags: string
  last_updated: number
  icon_index: number
}

interface JournalEntryResponse {
  ok: boolean
  meta: JournalMeta
  text: string
  files: string[]
  embeds: EmbedItem[]
}

interface EmbedItem {
  type: 'goal' | 'journal' | 'image'
  ref: string
  snapshot: Record<string, unknown>
  snapped_at: number
}

interface GoalOption { id: string; title: string }

/* ── helpers ────────────────────────────────────────────────────────── */

function parseTags(raw: string): string[] {
  return raw.split(',').map(t => t.trim()).filter(Boolean)
}

function encodeTags(tags: string[], mood: string | null): string {
  const nonMood = tags.filter(t => !t.startsWith(MOOD_TAG_PREFIX))
  const moodTag = moodToTag(mood)
  if (moodTag) nonMood.unshift(moodTag)
  return nonMood.join(',')
}

function extractMood(tags: string[]): string | null {
  const m = tags.find(t => t.startsWith(MOOD_TAG_PREFIX))
  return m ? tagToMood(m) : null
}

function displayTags(tags: string[]): string[] {
  return tags.filter(t => !t.startsWith(MOOD_TAG_PREFIX))
}

function monthKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth()}`
}

function monthLabel(ts: number): string {
  return MONTHS[new Date(ts * 1000).getMonth()]
}

function buildJournalEntryUrl(entryId: string): string {
  const params = new URLSearchParams({ id: entryId })
  return `${SERVER_ENDPOINTS.journalEntry}?${params.toString()}`
}

/* deterministic icon index from entry id — no user choice needed */
function idToIconIndex(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0
  return Math.abs(h) % ICONS.length
}

function groupByMonth(entries: JournalMeta[]): { label: string; items: JournalMeta[] }[] {
  const sorted = [...entries].sort((a, b) => b.last_updated - a.last_updated)
  const map = new Map<string, { label: string; items: JournalMeta[] }>()
  for (const e of sorted) {
    const key = monthKey(e.last_updated)
    if (!map.has(key)) map.set(key, { label: monthLabel(e.last_updated), items: [] })
    map.get(key)!.items.push(e)
  }
  return Array.from(map.values())
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

/* ── EmbedSheet ─────────────────────────────────────────────────────── */

interface EmbedSheetProps {
  open: boolean
  entryId: string
  journalEntries: JournalMeta[]
  onClose: () => void
  onAdded: () => void
}

function EmbedSheet({ open, entryId, journalEntries, onClose, onAdded }: EmbedSheetProps) {
  const [step, setStep]         = useState<'type' | 'input'>('type')
  const [embedType, setEmbedType] = useState<'goal' | 'journal' | 'image' | null>(null)
  const [ref, setRef]           = useState('')
  const [caption, setCaption]   = useState('')
  const [goals, setGoals]       = useState<GoalOption[]>([])
  const [adding, setAdding]     = useState(false)
  const [query, setQuery]       = useState('')

  /* reset when closed */
  useEffect(() => {
    if (!open) { setStep('type'); setEmbedType(null); setRef(''); setCaption(''); setQuery('') }
  }, [open])

  /* load goals when goal type selected */
  useEffect(() => {
    if (embedType !== 'goal') return
    fetch(SERVER_ENDPOINTS.goalList, { cache: 'no-store' })
      .then(r => r.json() as Promise<{ goals?: { id: string; title: string }[] }>)
      .then(d => setGoals((d.goals ?? []).map(g => ({ id: g.id, title: g.title }))))
      .catch(() => {})
  }, [embedType])

  async function submit() {
    const finalRef = embedType === 'image' ? caption : ref
    if (!finalRef.trim()) return
    setAdding(true)
    try {
      await fetch(SERVER_ENDPOINTS.journalEmbed, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: entryId,
          type: embedType,
          ref: finalRef.trim(),
          caption: caption.trim(),
        }),
      })
      onAdded()
      onClose()
    } finally {
      setAdding(false)
    }
  }

  const filteredGoals = goals.filter(g =>
    !query || g.title.toLowerCase().includes(query.toLowerCase())
  )

  const filteredEntries = journalEntries
    .filter(e => e.id !== entryId)
    .filter(e => !query || e.title.toLowerCase().includes(query.toLowerCase()))

  return (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 transition-opacity duration-200"
        style={{
          background: 'rgba(0,0,0,.5)',
          zIndex: 204,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
        onClick={onClose}
      />

      {/* sheet */}
      <div
        className="fixed inset-x-0 bottom-0 rounded-t-3xl transition-transform duration-300"
        style={{
          background: '#1a1a1a',
          zIndex: 205,
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          maxHeight: '72%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-9 h-1 rounded-full" style={{ background: 'rgba(255,255,255,.18)' }} />
        </div>

        {/* header */}
        <div className="flex items-center justify-between px-5 pt-1 pb-3 flex-shrink-0">
          {step === 'input' ? (
            <button
              type="button"
              onClick={() => { setStep('type'); setRef(''); setQuery('') }}
              className="flex items-center gap-1 text-[14px]"
              style={{ color: 'rgba(255,255,255,.5)' }}
            >
              <ChevronLeft /> Back
            </button>
          ) : (
            <span className="text-[17px] font-bold text-white">Link to…</span>
          )}
          {step === 'input' && (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={adding || !(embedType === 'image' ? caption.trim() : ref.trim())}
              className="px-4 py-1.5 rounded-full text-[13px] font-bold"
              style={{
                background: '#34c759',
                color: '#fff',
                opacity: adding || !(embedType === 'image' ? caption.trim() : ref.trim()) ? 0.4 : 1,
              }}
            >
              {adding ? '…' : 'Add'}
            </button>
          )}
        </div>

        {/* step 1: type selection */}
        {step === 'type' && (
          <div className="px-5 pb-8 flex gap-3">
            {([
              { type: 'goal'    as const, label: 'Goal',  icon: '🎯', desc: 'Link a goal' },
              { type: 'journal' as const, label: 'Entry', icon: '📝', desc: 'Link an entry' },
              { type: 'image'   as const, label: 'Image', icon: '🖼️', desc: 'Add a caption' },
            ]).map(({ type, label, icon, desc }) => (
              <button
                key={type}
                type="button"
                onClick={() => { setEmbedType(type); setStep('input') }}
                className="flex-1 flex flex-col items-center gap-2 rounded-2xl py-4 transition-colors active:scale-95"
                style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)' }}
              >
                <span className="text-[26px] leading-none">{icon}</span>
                <span className="text-[13px] font-semibold text-white">{label}</span>
                <span className="text-[11px]" style={{ color: 'rgba(255,255,255,.35)' }}>{desc}</span>
              </button>
            ))}
          </div>
        )}

        {/* step 2: input */}
        {step === 'input' && embedType && (
          <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8">
            {/* goal: searchable list */}
            {embedType === 'goal' && (
              <>
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search goals…"
                  className="w-full bg-transparent text-[14px] outline-none mb-3 px-3 py-2 rounded-xl"
                  style={{ background: 'rgba(255,255,255,.07)', color: '#fff', caretColor: '#fff' }}
                  autoFocus
                />
                <div className="flex flex-col gap-1.5">
                  {filteredGoals.slice(0, 12).map(g => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => setRef(g.id)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors"
                      style={{
                        background: ref === g.id ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.05)',
                        border: `1px solid ${ref === g.id ? 'rgba(255,255,255,.25)' : 'transparent'}`,
                      }}
                    >
                      <span className="text-[17px]">🎯</span>
                      <span className="text-[13px] font-medium text-white truncate">{g.title}</span>
                    </button>
                  ))}
                  {filteredGoals.length === 0 && (
                    <p className="text-[13px] text-center py-6" style={{ color: 'rgba(255,255,255,.3)' }}>
                      No goals found
                    </p>
                  )}
                </div>
              </>
            )}

            {/* journal: list of entries */}
            {embedType === 'journal' && (
              <>
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search entries…"
                  className="w-full bg-transparent text-[14px] outline-none mb-3 px-3 py-2 rounded-xl"
                  style={{ background: 'rgba(255,255,255,.07)', color: '#fff', caretColor: '#fff' }}
                  autoFocus
                />
                <div className="flex flex-col gap-1.5">
                  {filteredEntries.slice(0, 12).map(e => {
                    const tags  = parseTags(e.tags)
                    const mood  = extractMood(tags)
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => setRef(e.id)}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors"
                        style={{
                          background: ref === e.id ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.05)',
                          border: `1px solid ${ref === e.id ? 'rgba(255,255,255,.25)' : 'transparent'}`,
                        }}
                      >
                        <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                          {mood
                            ? <span className="text-[18px]">{mood}</span>
                            : <JournalIcon idx={e.icon_index} size={16} />
                          }
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-white truncate">{e.title || 'Untitled'}</div>
                          <div className="text-[11px]" style={{ color: 'rgba(255,255,255,.3)' }}>
                            {new Date(e.last_updated * 1000).getDate()} {MONTHS_SHORT[new Date(e.last_updated * 1000).getMonth()]}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                  {filteredEntries.length === 0 && (
                    <p className="text-[13px] text-center py-6" style={{ color: 'rgba(255,255,255,.3)' }}>
                      No other entries
                    </p>
                  )}
                </div>
              </>
            )}

            {/* image: caption input */}
            {embedType === 'image' && (
              <div>
                <p className="text-[12px] mb-2" style={{ color: 'rgba(255,255,255,.35)' }}>Caption</p>
                <input
                  value={caption}
                  onChange={e => setCaption(e.target.value)}
                  placeholder="Describe the image…"
                  className="w-full bg-transparent text-[14px] outline-none px-3 py-2.5 rounded-xl"
                  style={{ background: 'rgba(255,255,255,.07)', color: '#fff', caretColor: '#fff' }}
                  autoFocus
                />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

/* ── EmbedChip ──────────────────────────────────────────────────────── */

function EmbedChip({ embed }: { embed: EmbedItem }) {
  const snap = embed.snapshot
  const label =
    embed.type === 'goal'    ? (snap.title as string ?? embed.ref) :
    embed.type === 'journal' ? (snap.title as string ?? 'Entry') :
    /* image */                (snap.caption as string ?? 'Image')

  const icon = embed.type === 'goal' ? '🎯' : embed.type === 'journal' ? '📝' : '🖼️'

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl flex-shrink-0"
      style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.09)' }}
    >
      <span className="text-[14px] leading-none">{icon}</span>
      <span className="text-[12px] font-medium max-w-[120px] truncate" style={{ color: 'rgba(255,255,255,.7)' }}>
        {label}
      </span>
    </div>
  )
}

/* ── ComposeScreen ──────────────────────────────────────────────────── */

interface ComposeProps {
  open: boolean
  editEntry?: { id: string; title: string; text: string; tags: string[]; mood: string | null } | null
  onSave: (data: { title: string; text: string; tags: string; mood: string | null }) => Promise<void>
  onBack: () => void
}

function ComposeScreen({ open, editEntry, onSave, onBack }: ComposeProps) {
  const [mood,     setMood]     = useState<string | null>(null)
  const [title,    setTitle]    = useState('')
  const [text,     setText]     = useState('')
  const [tags,     setTags]     = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [saving,   setSaving]   = useState(false)
  const [saveErr,  setSaveErr]  = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setMood(editEntry?.mood ?? null)
      setTitle(editEntry?.title ?? '')
      setText(editEntry?.text ?? '')
      setTags(editEntry?.tags ? [...editEntry.tags] : [])
      setTagInput('')
      setSaveErr(null)
    }
  }, [open, editEntry?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    const trimT    = title.trim()
    const trimText = text.trim()
    const finalTags = tagInput.trim() ? [...tags, tagInput.trim()] : tags
    if (!trimT && !trimText) { onBack(); return }
    setSaving(true)
    setSaveErr(null)
    try {
      await onSave({ title: trimT || 'Untitled', text: trimText, tags: finalTags.join(','), mood })
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const date      = new Date()
  const dateLabel = `${DOW_FULL[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`

  return (
    <div
      className="fixed inset-0 flex flex-col transition-transform duration-300"
      style={{ background: '#0a0a0a', zIndex: 200, transform: open ? 'translateY(0)' : 'translateY(100%)' }}
    >
      {/* header */}
      <div
        className="px-4 pt-[52px] pb-3 flex items-center justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid #2a2a2a' }}
      >
        <div
          onClick={onBack}
          className="flex items-center gap-1.5 cursor-pointer text-[15px] font-medium"
          style={{ color: 'rgba(255,255,255,.65)' }}
        >
          <ChevronLeft />
          Back
        </div>
        <div className="flex items-center gap-3">
          {saveErr && (
            <span className="text-[12px]" style={{ color: 'rgba(239,68,68,.8)' }}>{saveErr}</span>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="px-5 py-2 text-white rounded-full text-[14px] font-bold"
            style={{ background: '#34c759', opacity: saving ? 0.6 : 1 }}
          >
            {saving ? '…' : 'Save'}
          </button>
        </div>
      </div>

      {/* mood strip */}
      <div className="flex gap-2 px-4 py-3.5 overflow-x-auto flex-shrink-0 no-scrollbar">
        <div
          onClick={() => setMood(null)}
          className="w-11 h-11 rounded-[13px] flex items-center justify-center cursor-pointer flex-shrink-0"
          style={{
            background: mood === null ? 'rgba(255,255,255,.1)' : 'var(--surface)',
            border: `2px solid ${mood === null ? 'rgba(255,255,255,.5)' : 'transparent'}`,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="2.2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </div>
        {MOODS.map(m => (
          <div
            key={m}
            onClick={() => setMood(m)}
            className="w-11 h-11 rounded-[13px] flex items-center justify-center text-2xl cursor-pointer flex-shrink-0"
            style={{
              background: mood === m ? 'rgba(255,255,255,.1)' : 'var(--surface)',
              border: `2px solid ${mood === m ? 'rgba(255,255,255,.5)' : 'transparent'}`,
            }}
          >
            {m}
          </div>
        ))}
      </div>

      {/* date label */}
      <div className="px-4 pt-1 pb-1.5 text-xs flex-shrink-0" style={{ color: 'rgba(255,255,255,.35)' }}>
        {dateLabel}
      </div>

      {/* title */}
      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Title..."
        className="w-full bg-transparent border-none outline-none text-2xl font-bold pt-2.5 pb-1 px-4 text-white"
      />

      {/* body */}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="What's happening today?"
        className="flex-1 w-full bg-transparent border-none outline-none text-base py-1.5 px-4 resize-none leading-[1.65]"
        style={{ color: 'rgba(255,255,255,.8)' }}
      />

      {/* tags bar */}
      <div className="px-4 py-2 pb-5 flex-shrink-0" style={{ borderTop: '1px solid #2a2a2a' }}>
        <div className="flex flex-wrap gap-1.5 items-center">
          {tags.map(t => (
            <div key={t} className="text-[11px] px-2.5 py-1 rounded-lg flex items-center gap-1"
              style={{ background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.5)' }}>
              {t}
              <span className="opacity-50 ml-0.5 cursor-pointer" onClick={() => setTags(tags.filter(x => x !== t))}>×</span>
            </div>
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                const v = tagInput.trim().replace(/,$/, '')
                if (v && !tags.includes(v)) setTags([...tags, v])
                setTagInput('')
              }
            }}
            placeholder="+ Add tag"
            className="bg-transparent outline-none text-[13px] min-w-[90px] text-white"
            style={{ caretColor: 'white' }}
          />
        </div>
      </div>
    </div>
  )
}

/* ── EntryScreen ────────────────────────────────────────────────────── */

interface EntryScreenProps {
  open: boolean
  entryId: string | null
  journalEntries: JournalMeta[]
  onBack: () => void
  onEdit: (data: { id: string; title: string; text: string; tags: string[]; mood: string | null }) => void
}

function EntryScreen({ open, entryId, journalEntries, onBack, onEdit }: EntryScreenProps) {
  const [entry,        setEntry]        = useState<JournalEntryResponse | null>(null)
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [embedOpen,    setEmbedOpen]    = useState(false)
  const [embedVersion, setEmbedVersion] = useState(0) // bump to reload embeds

  useEffect(() => {
    if (!entryId?.trim()) {
      setEntry(null)
      setError('Journal entry is missing an id.')
      setLoading(false)
      return
    }

    setLoading(true)
    setEntry(null)
    setError(null)

    fetch(buildJournalEntryUrl(entryId), { cache: 'no-store' })
      .then(r => r.json() as Promise<JournalEntryResponse>)
      .then(d => { setEntry(d); setLoading(false) })
      .catch(() => {
        setError('Failed to load journal entry.')
        setLoading(false)
      })
  }, [entryId, embedVersion])

  const meta  = entry?.meta ?? null
  const tags  = meta ? parseTags(meta.tags) : []
  const mood  = extractMood(tags)
  const dTags = displayTags(tags)
  const d     = meta ? new Date(meta.last_updated * 1000) : null
  const embeds = entry?.embeds ?? []

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden transition-transform duration-300"
      style={{ background: '#0a0a0a', zIndex: 201, transform: open ? 'translateX(0)' : 'translateX(100%)' }}
    >
      {/* header */}
      <div className="px-4 pt-[52px] pb-3.5 flex items-center justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid #2a2a2a' }}>
        <div onClick={onBack} className="flex items-center gap-1.5 cursor-pointer text-[15px] font-medium"
          style={{ color: 'rgba(255,255,255,.65)' }}>
          <ChevronLeft />Back
        </div>
      </div>

      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <span style={{ color: 'rgba(255,255,255,.25)', fontSize: 13 }}>Loading…</span>
        </div>
      )}

      {!loading && error && (
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <span style={{ color: 'rgba(255,255,255,.4)', fontSize: 13 }}>{error}</span>
        </div>
      )}

      {!loading && !error && meta && d && (
        <div className="flex-1 overflow-y-auto pb-10 no-scrollbar">
          {/* mood / icon + date */}
          <div className="flex items-center gap-3.5 px-5 pt-5">
            {mood
              ? <div className="text-5xl leading-none">{mood}</div>
              : (() => { const i = idToIconIndex(meta.id); return (
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{ background: ICONS[i].color + '22' }}>
                  <JournalIcon idx={i} size={28} />
                </div>
              )})()
            }
            <div className="flex flex-col gap-0.5">
              <div className="text-[22px] font-extrabold leading-tight">{DOW_FULL[d.getDay()]}</div>
              <div className="text-[15px] font-medium" style={{ color: 'rgba(255,255,255,.5)' }}>
                {d.getDate()} {MONTHS[d.getMonth()]}
              </div>
            </div>
          </div>

          {/* title */}
          <div className="text-[26px] font-extrabold px-5 pt-4 pb-2 leading-tight">{meta.title}</div>

          {/* body */}
          <div className="text-base leading-[1.7] px-5 pb-5 whitespace-pre-wrap"
            style={{ color: 'rgba(255,255,255,.75)' }}>
            {entry!.text}
          </div>

          {/* tags */}
          {dTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-5 pt-1 pb-4">
              {dTags.map(t => (
                <span key={t} className="text-[11px] px-2.5 py-1 rounded-lg"
                  style={{ background: 'rgba(255,255,255,.07)', color: 'rgba(255,255,255,.45)' }}>
                  {t}
                </span>
              ))}
            </div>
          )}

          {/* ── embeds strip ─────────────────────────────────────── */}
          <div className="px-5 pb-5">
            <div className="h-px mb-4" style={{ background: 'rgba(255,255,255,.07)' }} />
            <div className="flex items-center gap-2 flex-wrap">
              {embeds.map((em, i) => <EmbedChip key={i} embed={em} />)}

              {/* + link button */}
              <button
                type="button"
                onClick={() => setEmbedOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold transition-colors active:scale-95"
                style={{
                  background: 'rgba(255,255,255,.06)',
                  border: '1px solid rgba(255,255,255,.1)',
                  color: 'rgba(255,255,255,.45)',
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Link
              </button>
            </div>
          </div>
        </div>
      )}

      {/* edit FAB */}
      <div
        onClick={() => meta && onEdit({ id: meta.id, title: meta.title, text: entry!.text, tags: dTags, mood })}
        className="absolute bottom-[100px] right-5 w-[52px] h-[52px] rounded-full bg-white flex items-center justify-center cursor-pointer z-10 active:scale-90 transition-transform"
        style={{ boxShadow: '0 4px 18px rgba(0,0,0,.55),0 1px 4px rgba(0,0,0,.3)' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </div>

      {/* embed sheet */}
      {entryId && (
        <EmbedSheet
          open={embedOpen}
          entryId={entryId}
          journalEntries={journalEntries}
          onClose={() => setEmbedOpen(false)}
          onAdded={() => setEmbedVersion(v => v + 1)}
        />
      )}
    </div>
  )
}

/* ── main view ──────────────────────────────────────────────────────── */

type Screen =
  | { type: 'list' }
  | { type: 'entry'; id: string }
  | { type: 'compose'; editEntry?: { id: string; title: string; text: string; tags: string[]; mood: string | null } }

export default function JournalView() {
  const [entries, setEntries] = useState<JournalMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [screen,  setScreen]  = useState<Screen>({ type: 'list' })

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(SERVER_ENDPOINTS.journalList, { cache: 'no-store' })
      const data = await res.json() as unknown
      setEntries(Array.isArray(data) ? (data as JournalMeta[]) : [])
    } catch { /* swallow */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  async function handleCreate(data: { title: string; text: string; tags: string; mood: string | null }) {
    const tagStr = encodeTags(data.tags.split(',').map(t => t.trim()).filter(Boolean), data.mood)
    const res = await fetch(SERVER_ENDPOINTS.journalCreate, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: data.title, text: data.text, tags: tagStr }),
    })
    if (!res.ok) throw new Error(`Server error ${res.status}`)
    await loadList()
    setScreen({ type: 'list' })
  }

  async function handleUpdate(id: string, data: { title: string; text: string; tags: string; mood: string | null }) {
    const tagStr = encodeTags(data.tags.split(',').map(t => t.trim()).filter(Boolean), data.mood)
    const res = await fetch(SERVER_ENDPOINTS.journalUpdate, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title: data.title, text: data.text, tags: tagStr }),
    })
    if (!res.ok) throw new Error(`Server error ${res.status}`)
    await loadList()
    setScreen({ type: 'entry', id })
  }

  const groups = groupByMonth(entries)
  let idx = 0

  const entryOpen   = screen.type === 'entry'
  const composeOpen = screen.type === 'compose'
  const entryId     = screen.type === 'entry' ? screen.id : null
  const editEntry   = screen.type === 'compose' ? screen.editEntry ?? null : null

  return (
    <div className="overflow-hidden flex flex-col h-full anim-pg-in relative">

      {/* header */}
      <div className="px-5 pt-[52px] pb-1 flex items-center justify-between flex-shrink-0">
        <div className="text-[34px] font-extrabold tracking-tight">Journal</div>
      </div>

      {/* FAB */}
      <div
        onClick={() => setScreen({ type: 'compose' })}
        className="absolute bottom-[100px] right-5 w-[52px] h-[52px] rounded-full bg-white flex items-center justify-center cursor-pointer z-10 active:scale-90 transition-transform"
        style={{ boxShadow: '0 4px 18px rgba(0,0,0,.55),0 1px 4px rgba(0,0,0,.3)' }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </div>

      {/* entries list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar">
        {loading && (
          <div className="px-6 py-10 text-center text-sm" style={{ color: 'rgba(255,255,255,.3)' }}>
            Loading…
          </div>
        )}
        {!loading && entries.length === 0 && (
          <div className="px-6 py-10 text-center text-sm" style={{ color: 'rgba(255,255,255,.3)' }}>
            No entries yet.<br />Tap + to get started.
          </div>
        )}
        {groups.map(({ label, items }) => (
          <div key={label}>
            <div className="text-[13px] font-bold pt-7 px-5 pb-1" style={{ color: 'rgba(255,255,255,.35)' }}>
              {label}
            </div>
            {items.map(entry => {
              const delay = idx++ * 40
              const tags  = parseTags(entry.tags)
              const mood  = extractMood(tags)
              const d     = new Date(entry.last_updated * 1000)
              const dow   = DOW_FULL[d.getDay()]
              return (
                <div
                  key={entry.id}
                  onClick={() => {
                    if (!entry.id?.trim()) {
                      console.error('Journal entry is missing id in list response.', entry)
                      return
                    }
                    setScreen({ type: 'entry', id: entry.id })
                  }}
                  className="relative anim-entry-in cursor-pointer"
                  style={{ animationDelay: `${delay}ms` }}
                >
                  <div className="flex flex-col px-5 py-5 active:opacity-50 active:scale-[.99] transition-all">
                    <div className="flex-1">
                      <div className="flex items-center gap-2.5 mb-2">
                        {/* icon badge */}
                        {(() => { const i = idToIconIndex(entry.id); return (
                          <div
                            className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
                            style={{ background: ICONS[i].color + '20' }}
                          >
                            {mood
                              ? <span className="text-[17px] leading-none">{mood}</span>
                              : <JournalIcon idx={i} size={15} />
                            }
                          </div>
                        )})()}
                        <div className="text-[17px] font-bold leading-tight tracking-tight flex-1">
                          {entry.title || 'Untitled'}
                        </div>
                      </div>
                      <div
                        className="text-[14px] leading-[1.5] overflow-hidden pl-[42px]"
                        style={{
                          color: 'rgba(255,255,255,.38)',
                          display: '-webkit-box',
                          WebkitLineClamp: 1,
                          WebkitBoxOrient: 'vertical' as never,
                        }}
                      >
                        {displayTags(tags).join(' · ')}
                      </div>
                    </div>
                    <div className="flex items-baseline gap-1 mt-4 pl-[42px]">
                      <span className="text-[11px] font-semibold" style={{ color: 'rgba(255,255,255,.28)' }}>{dow}</span>
                      <span className="text-[11px]" style={{ color: 'rgba(255,255,255,.18)' }}>{d.getDate()}</span>
                      <span className="text-[11px]" style={{ color: 'rgba(255,255,255,.18)' }}>{MONTHS_SHORT[d.getMonth()]}</span>
                    </div>
                  </div>
                  <div className="h-px mx-5" style={{ background: 'rgba(255,255,255,.07)' }} />
                </div>
              )
            })}
          </div>
        ))}
        <div style={{ height: 80 }} />
      </div>

      {/* entry view */}
      <EntryScreen
        open={entryOpen}
        entryId={entryId}
        journalEntries={entries}
        onBack={() => setScreen({ type: 'list' })}
        onEdit={d => setScreen({ type: 'compose', editEntry: d })}
      />

      {/* compose */}
      <ComposeScreen
        open={composeOpen}
        editEntry={editEntry}
        onSave={async data => {
          if (editEntry) await handleUpdate(editEntry.id, data)
          else await handleCreate(data)
        }}
        onBack={() => {
          if (editEntry) setScreen({ type: 'entry', id: editEntry.id })
          else setScreen({ type: 'list' })
        }}
      />
    </div>
  )
}
