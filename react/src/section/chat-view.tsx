import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SERVER_ENDPOINTS, getClientBaseUrl, subscribeClientBaseUrl } from '../config/server'
import GraphUpdateBubble from '../components/graph-update-bubble'
import GoalCard from '../components/goal-card'

type ChatEntryKind = 'user' | 'assistant' | 'action' | 'permission' | 'reminder_permission'

interface PermissionData {
  permission_id: string
  key: string
  value: string
  reason: string
}

interface ReminderPermissionData {
  permission_id: string
  title: string
  hour: number
  minute: number
  days: number
  end_time: number
}

interface GoalCreatedData {
  goal_id: string
  title: string
  priority: number
}

interface ChatEntry {
  id: string
  kind: ChatEntryKind
  eventType: string
  content: string
  timestamp: number
  permission?: PermissionData
  reminderPermission?: ReminderPermissionData
  permissionResolved?: boolean
  permissionApproved?: boolean
  graphUpdateResolved?: boolean
  suggestions?: string[]
  suggestionsHidden?: boolean
  suggestionsExiting?: boolean
  selectedSuggestion?: string
  highlightOnMount?: boolean
  highlightColor?: string
}

const SUGGESTION_EXIT_MS = 500
const SUGGESTION_EXIT_STAGGER_MS = 70
const SUGGESTION_HIGHLIGHT_COLORS = [
  '#4f46e5',
  '#7c3aed',
  '#0284c7',
  '#0f766e',
  '#e11d48',
  '#f59e0b',
]

interface ServerSessionEvent {
  type: string
  content: string
  timestamp: number
}

interface SSEEnvelope {
  id: string
  type: string
  data: string
}

function freshOptimisticId(): string {
  return `optimistic-${Date.now()}-${Math.random()}`
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function parseEntry(id: string, type: string, content: string, timestamp: number): ChatEntry {
  const base: ChatEntry = { id, kind: 'action', eventType: type, content, timestamp }

  if (type === 'message_received') return { ...base, kind: 'user' }
  if (type === 'assistant_message') return { ...base, kind: 'assistant' }

  if (type === 'permission_required') {
    try {
      const data = JSON.parse(content) as PermissionData
      return { ...base, kind: 'permission', permission: data }
    } catch {
      return base
    }
  }

  if (type === 'reminder_permission_required') {
    try {
      const data = JSON.parse(content) as ReminderPermissionData
      return { ...base, kind: 'reminder_permission', reminderPermission: data }
    } catch {
      return base
    }
  }

  if (type === 'graph_update_started') return { ...base, kind: 'action' }

  return base
}

function applyGraphUpdateResolved(entries: ChatEntry[]): ChatEntry[] {
  const copy = [...entries]
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].eventType === 'graph_update_started' && !copy[i].graphUpdateResolved) {
      copy[i] = { ...copy[i], graphUpdateResolved: true }
      break
    }
  }
  return copy
}

function applyPermissionResolution(entries: ChatEntry[], resolvedJson: string): ChatEntry[] {
  try {
    const data = JSON.parse(resolvedJson) as { permission_id: string; approved: boolean }
    return entries.map((e) => {
      if (e.kind === 'permission' && e.permission?.permission_id === data.permission_id)
        return { ...e, permissionResolved: true, permissionApproved: data.approved }
      if (e.kind === 'reminder_permission' && e.reminderPermission?.permission_id === data.permission_id)
        return { ...e, permissionResolved: true, permissionApproved: data.approved }
      return e
    })
  } catch {
    return entries
  }
}

function applySuggestedReplies(entries: ChatEntry[], suggestionsJson: string): ChatEntry[] {
  try {
    const suggestions = JSON.parse(suggestionsJson) as string[]
    const copy = [...entries]
    for (let i = copy.length - 1; i >= 0; i--) {
      if (copy[i].kind === 'assistant') {
        copy[i] = {
          ...copy[i],
          suggestions,
          suggestionsHidden: false,
          suggestionsExiting: false,
          selectedSuggestion: undefined,
        }
        break
      }
    }
    return copy
  } catch {
    return entries
  }
}

function hidePendingSuggestions(entries: ChatEntry[]): ChatEntry[] {
  const copy = [...entries]
  for (let i = copy.length - 1; i >= 0; i--) {
    const entry = copy[i]
    if (entry.kind === 'assistant' && entry.suggestions && entry.suggestions.length > 0 && !entry.suggestionsHidden) {
      copy[i] = { ...entry, suggestionsHidden: true, suggestionsExiting: false }
      break
    }
  }
  return copy
}

function beginHidePendingSuggestions(entries: ChatEntry[]): ChatEntry[] {
  const copy = [...entries]
  for (let i = copy.length - 1; i >= 0; i--) {
    const entry = copy[i]
    if (
      entry.kind === 'assistant' &&
      entry.suggestions &&
      entry.suggestions.length > 0 &&
      !entry.suggestionsHidden &&
      !entry.suggestionsExiting
    ) {
      copy[i] = { ...entry, suggestionsExiting: true }
      break
    }
  }
  return copy
}

function markSuggestionSelected(entries: ChatEntry[], entryId: string, suggestion: string): ChatEntry[] {
  return entries.map((entry) =>
    entry.id === entryId
      ? { ...entry, selectedSuggestion: suggestion, suggestionsHidden: false, suggestionsExiting: false }
      : entry,
  )
}

const ACTION_LABEL: Record<string, string> = {
  goal_create_started: 'Creating goal',
  goal_created: 'Goal created',
  goal_priority_changed: 'Priority updated',
  goal_delayed: 'Goal delayed',
  profile_updated: 'Profile updated',
  deep_search_started: 'Searching',
  deep_search_done: 'Search complete',
  middleware_retry: 'Retrying',
  sse_connected: 'Connected',
}

function actionSummary(entry: ChatEntry): string {
  const label = ACTION_LABEL[entry.eventType] ?? entry.eventType.replace(/_/g, ' ')
  if (!entry.content) return label

  if (entry.eventType === 'goal_created') {
    try {
      const data = JSON.parse(entry.content) as GoalCreatedData
      return `${label}: ${data.title}`
    } catch { /* fall through */ }
  }

  if (entry.eventType === 'goal_delayed') {
    try {
      const data = JSON.parse(entry.content) as { title: string; added_seconds: number }
      const days = Math.round(data.added_seconds / 86400)
      const suffix = days >= 1 ? `+${days}d` : `+${data.added_seconds}s`
      return `${label}: ${data.title} (${suffix})`
    } catch { /* fall through */ }
  }

  if (entry.eventType === 'profile_updated') {
    return `${label}: ${entry.content}`
  }

  if (entry.content.length < 80 && !entry.content.startsWith('{')) {
    return `${label}: ${entry.content}`
  }

  return label
}

function isLoadingAction(eventType: string): boolean {
  return eventType === 'deep_search_started' || eventType === 'goal_create_started' || eventType === 'middleware_retry'
}

type ParsedBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'unordered-list'; items: string[] }
  | { type: 'ordered-list'; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language?: string }

function renderInlineContent(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let index = 0
  let key = 0

  function pushText(value: string) {
    if (!value) return
    nodes.push(<span key={`${keyPrefix}-t-${key++}`}>{value}</span>)
  }

  while (index < text.length) {
    const remaining = text.slice(index)

    if (remaining.startsWith('`')) {
      const end = text.indexOf('`', index + 1)
      if (end > index + 1) {
        nodes.push(
          <code
            key={`${keyPrefix}-c-${key++}`}
            className="rounded bg-[#222] px-1 py-0.5 font-mono text-[0.85em] text-white/80"
          >
            {text.slice(index + 1, end)}
          </code>,
        )
        index = end + 1
        continue
      }
    }

    if (remaining.startsWith('**') || remaining.startsWith('__')) {
      const marker = remaining.startsWith('**') ? '**' : '__'
      const end = text.indexOf(marker, index + 2)
      if (end > index + 2) {
        nodes.push(
          <strong key={`${keyPrefix}-s-${key++}`} className="font-semibold text-white">
            {renderInlineContent(text.slice(index + 2, end), `${keyPrefix}-s${key}`)}
          </strong>,
        )
        index = end + 2
        continue
      }
    }

    if (remaining.startsWith('[')) {
      const closeLabel = text.indexOf('](', index + 1)
      const closeUrl = closeLabel >= 0 ? text.indexOf(')', closeLabel + 2) : -1
      if (closeLabel > index + 1 && closeUrl > closeLabel + 2) {
        const label = text.slice(index + 1, closeLabel)
        const url = text.slice(closeLabel + 2, closeUrl)
        nodes.push(
          <a
            key={`${keyPrefix}-l-${key++}`}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-white underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-600"
          >
            {renderInlineContent(label, `${keyPrefix}-l${key}`)}
          </a>,
        )
        index = closeUrl + 1
        continue
      }
    }

    let nextSpecial = text.length
    const specials = ['`', '**', '__', '[']
    for (const token of specials) {
      const found = text.indexOf(token, index + 1)
      if (found !== -1 && found < nextSpecial) nextSpecial = found
    }

    pushText(text.slice(index, nextSpecial))
    index = nextSpecial
  }

  return nodes
}

function parseAssistantBlocks(content: string): ParsedBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: ParsedBlock[] = []
  let paragraph: string[] = []
  let quote: string[] = []
  let listKind: 'unordered' | 'ordered' | null = null
  let listItems: string[] = []
  let codeLines: string[] | null = null
  let codeLanguage = ''

  function flushParagraph() {
    if (!paragraph.length) return
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
    paragraph = []
  }

  function flushQuote() {
    if (!quote.length) return
    blocks.push({ type: 'quote', text: quote.join('\n').trim() })
    quote = []
  }

  function flushList() {
    if (!listKind || !listItems.length) return
    blocks.push({
      type: listKind === 'ordered' ? 'ordered-list' : 'unordered-list',
      items: [...listItems],
    })
    listKind = null
    listItems = []
  }

  function flushAll() {
    flushParagraph()
    flushQuote()
    flushList()
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    if (codeLines) {
      if (line.startsWith('```')) {
        blocks.push({
          type: 'code',
          text: codeLines.join('\n'),
          language: codeLanguage || undefined,
        })
        codeLines = null
        codeLanguage = ''
      } else {
        codeLines.push(rawLine)
      }
      continue
    }

    if (!line.trim()) {
      flushAll()
      continue
    }

    const codeMatch = line.match(/^```(\w+)?\s*$/)
    if (codeMatch) {
      flushAll()
      codeLanguage = codeMatch[1] ?? ''
      codeLines = []
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      flushAll()
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      })
      continue
    }

    const quoteMatch = line.match(/^>\s?(.*)$/)
    if (quoteMatch) {
      if (listKind) flushList()
      quote.push(quoteMatch[1])
      continue
    }

    const unorderedMatch = line.match(/^\s*[-*•]\s+(.*)$/)
    if (unorderedMatch) {
      flushParagraph()
      flushQuote()
      if (listKind && listKind !== 'unordered') flushList()
      listKind = 'unordered'
      listItems.push(unorderedMatch[1])
      continue
    }

    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (orderedMatch) {
      flushParagraph()
      flushQuote()
      if (listKind && listKind !== 'ordered') flushList()
      listKind = 'ordered'
      listItems.push(orderedMatch[1])
      continue
    }

    if (quote.length) flushQuote()
    if (listKind) flushList()
    paragraph.push(line.trim())
  }

  if (codeLines) {
    blocks.push({
      type: 'code',
      text: codeLines.join('\n'),
      language: codeLanguage || undefined,
    })
  }

  flushAll()
  return blocks
}

function AssistantContent({ content }: { content: string }) {
  const blocks = parseAssistantBlocks(content)

  if (blocks.length === 0) {
    return <span className="whitespace-pre-wrap">{content}</span>
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        if (block.type === 'heading') {
          const sizes: Record<number, string> = {
            1: 'text-lg',
            2: 'text-base',
            3: 'text-sm',
            4: 'text-sm',
            5: 'text-sm',
            6: 'text-sm',
          }

          return (
            <p key={blockIndex} className={`font-semibold ${sizes[block.level] ?? 'text-sm'}`}>
              {renderInlineContent(block.text, `h-${blockIndex}`)}
            </p>
          )
        }

        if (block.type === 'unordered-list' || block.type === 'ordered-list') {
          const isOrdered = block.type === 'ordered-list'
          const ListTag = isOrdered ? 'ol' : 'ul'
          const listClass = isOrdered ? 'list-decimal' : 'list-disc'

          return (
            <ListTag key={blockIndex} className={`ml-5 space-y-1 ${listClass} pl-1`}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="whitespace-pre-wrap">
                  {renderInlineContent(item, `li-${blockIndex}-${itemIndex}`)}
                </li>
              ))}
            </ListTag>
          )
        }

        if (block.type === 'quote') {
          return (
            <blockquote
              key={blockIndex}
              className="border-l-2 border-[#2a2a2a] pl-3 text-white/55"
            >
              <div className="space-y-1">
                {block.text.split('\n').map((line, lineIndex) => (
                  <p key={lineIndex} className="whitespace-pre-wrap">
                    {renderInlineContent(line, `q-${blockIndex}-${lineIndex}`)}
                  </p>
                ))}
              </div>
            </blockquote>
          )
        }

        if (block.type === 'code') {
          return (
            <pre
              key={blockIndex}
              className="overflow-x-auto rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] px-4 py-3 text-xs leading-relaxed text-white/80"
            >
              <code>{block.text}</code>
            </pre>
          )
        }

        return (
          <p key={blockIndex} className="whitespace-pre-wrap">
            {renderInlineContent(block.text, `p-${blockIndex}`)}
          </p>
        )
      })}
    </div>
  )
}

function UserBubble({ entry }: { entry: ChatEntry }) {
  const [highlighted, setHighlighted] = useState(entry.highlightOnMount ?? false)

  useEffect(() => {
    if (!entry.highlightOnMount) return
    const timeoutId = window.setTimeout(() => {
      setHighlighted(false)
    }, 1200)
    return () => window.clearTimeout(timeoutId)
  }, [entry.highlightOnMount])

  return (
    <div className="flex justify-end">
      <div
        className={[
          'max-w-[72%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed transition-colors duration-[1200ms]',
          'bg-white text-black',
        ].join(' ')}
        style={{
          backgroundColor: entry.highlightOnMount && highlighted
            ? (entry.highlightColor ?? '#2563eb')
            : '#ffffff',
        }}
      >
        {entry.content}
      </div>
    </div>
  )
}

const SUGGESTION_COLORS = [
  'bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700',
  'bg-violet-600 hover:bg-violet-500 active:bg-violet-700',
  'bg-sky-600 hover:bg-sky-500 active:bg-sky-700',
  'bg-teal-600 hover:bg-teal-500 active:bg-teal-700',
  'bg-rose-600 hover:bg-rose-500 active:bg-rose-700',
  'bg-amber-500 hover:bg-amber-400 active:bg-amber-600',
]

function AssistantBubble({
  entry,
  onSuggestion,
}: {
  entry: ChatEntry
  onSuggestion: (entryId: string, suggestion: string) => void
}) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="max-w-[72%] rounded-2xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-2.5 text-sm leading-relaxed text-white">
        <AssistantContent content={entry.content} />
      </div>
      {entry.suggestions && entry.suggestions.length > 0 && !entry.suggestionsHidden && (
        <div className="flex max-w-[72%] flex-wrap gap-2">
          {entry.suggestions.map((s, i) => {
            const isSelected = entry.selectedSuggestion === s
            const isDimmed = entry.selectedSuggestion !== undefined && !isSelected
            return (
              <button
                key={i}
                type="button"
                disabled={entry.selectedSuggestion !== undefined}
                onClick={() => {
                  onSuggestion(entry.id, s)
                }}
                className={[
                  'rounded-full px-4 py-2 text-sm text-white transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
                  SUGGESTION_COLORS[i % SUGGESTION_COLORS.length],
                  isSelected ? 'scale-105 ring-2 ring-white ring-offset-1 brightness-110' : '',
                  isDimmed ? 'opacity-10 saturate-50' : '',
                  entry.suggestionsExiting ? 'pointer-events-none -translate-y-2 scale-[0.86] opacity-0 blur-[2px]' : '',
                ].join(' ')}
                style={
                  entry.suggestionsExiting
                    ? { transitionDelay: `${((entry.suggestions?.length ?? 1) - 1 - i) * SUGGESTION_EXIT_STAGGER_MS}ms` }
                    : undefined
                }
              >
                {isSelected ? '✓ ' : ''}{s}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ActionBubble({ entry }: { entry: ChatEntry }) {
  return (
    <div className="flex justify-start max-w-[72%]">
      <PanelActionCard entry={entry} />
    </div>
  )
}

function PermissionBubble({
  entry,
  onResolve,
}: {
  entry: ChatEntry
  onResolve: (permissionId: string, approved: boolean) => void
}) {
  const p = entry.permission
  if (!p) return null

  if (entry.permissionResolved) {
    return (
      <div className="flex justify-start">
        <div
          className={`rounded-xl border px-4 py-2.5 text-sm ${
            entry.permissionApproved
              ? 'border-green-900 bg-green-950/30 text-green-300'
              : 'border-[#2a2a2a] bg-[#1a1a1a] text-white/55'
          }`}
        >
          <span className="font-medium">{entry.permissionApproved ? 'Approved' : 'Denied'}:</span>{' '}
          <span className="font-mono text-xs">{p.key}</span>
          {entry.permissionApproved && (
            <>
              {' '}
              ={' '}
              <span className="font-mono text-xs">{p.value}</span>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="rounded-xl border border-amber-900 bg-amber-950/30 px-4 py-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-amber-400">
          Permission request
        </p>
        <p className="mb-0.5 text-sm font-medium text-white">
          Store <span className="rounded bg-amber-900/30 px-1 font-mono text-xs">{p.key}</span> ={' '}
          <span className="rounded bg-amber-900/30 px-1 font-mono text-xs">{p.value}</span>
        </p>
        {p.reason && <p className="mb-3 text-xs text-white/55">{p.reason}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-green-700 bg-green-950/30 px-3 py-1 text-xs font-medium text-green-400 hover:bg-green-900/30"
            onClick={() => onResolve(p.permission_id, true)}
          >
            Approve
          </button>
          <button
            type="button"
            className="rounded border border-[#333] px-3 py-1 text-xs font-medium text-white/55 hover:bg-[#1a1a1a]"
            onClick={() => onResolve(p.permission_id, false)}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function formatReminderDays(days: number): string {
  const active = DAY_NAMES.filter((_, i) => (days >> i) & 1)
  if (active.length === 7) return 'Every day'
  if (active.length === 0) return 'No days'
  return active.join(', ')
}

function ReminderPermissionBubble({
  entry,
  onResolve,
}: {
  entry: ChatEntry
  onResolve: (id: string, approved: boolean) => void
}) {
  const p = entry.reminderPermission
  if (!p) return null

  const timeStr = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  const isOneShot = p.end_time > 0
  const daysStr = formatReminderDays(p.days)

  if (entry.permissionResolved) {
    return (
      <div className="flex justify-start">
        <div className={`rounded-xl border px-4 py-2.5 text-sm ${
          entry.permissionApproved
            ? 'border-green-900 bg-green-950/30 text-green-300'
            : 'border-[#2a2a2a] bg-[#1a1a1a] text-white/55'
        }`}>
          <span className="font-medium">{entry.permissionApproved ? 'Reminder set' : 'Reminder declined'}:</span>{' '}
          {entry.permissionApproved && <span className="font-mono text-xs">{p.title} · {timeStr}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="rounded-xl border px-4 py-3" style={{ borderColor: 'rgba(167,139,250,.35)', background: 'rgba(124,58,237,.1)' }}>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#a78bfa' }}>
          Reminder request
        </p>
        <p className="mb-0.5 text-sm font-semibold text-white">{p.title}</p>
        <p className="mb-3 text-xs text-white/55">
          {timeStr} · {isOneShot ? 'One-time' : daysStr}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded px-3 py-1 text-xs font-medium text-white"
            style={{ background: 'rgba(167,139,250,.25)', border: '1px solid rgba(167,139,250,.4)' }}
            onClick={() => onResolve(p.permission_id, true)}
          >
            Set reminder
          </button>
          <button
            type="button"
            className="rounded border border-[#333] px-3 py-1 text-xs font-medium text-white/55 hover:bg-[#1a1a1a]"
            onClick={() => onResolve(p.permission_id, false)}
          >
            No thanks
          </button>
        </div>
      </div>
    </div>
  )
}

const THINKING_PHRASES = [
  'Thinking through that…',
  'Let me check your goals…',
  'Looking at your schedule…',
  'Reviewing the context…',
  'Working on a response…',
  'Checking your progress…',
  'Considering your options…',
  'One moment…',
  'Analyzing that…',
  'Let me think about that…',
]

const SKELETON_WIDTHS = [
  ['92%', '78%', '55%'],
  ['85%', '93%', '40%'],
  ['88%', '62%', '70%'],
  ['95%', '80%', '48%'],
]

function ThinkingBubble() {
  const [phraseIdx, setPhraseIdx] = useState(() => Math.floor(Math.random() * THINKING_PHRASES.length))
  const [skeletonSet] = useState(() => Math.floor(Math.random() * SKELETON_WIDTHS.length))
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const id = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length)
        setVisible(true)
      }, 320)
    }, 2800)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex justify-start">
      <div className="max-w-[72%] rounded-2xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-3 min-w-[220px]">
        <p
          className="mb-2.5 text-xs text-white/40 transition-opacity duration-300"
          style={{ opacity: visible ? 1 : 0 }}
        >
          {THINKING_PHRASES[phraseIdx]}
        </p>
        <div className="flex flex-col gap-2">
          {SKELETON_WIDTHS[skeletonSet].map((w, i) => (
            <div
              key={i}
              className="think-skeleton-line"
              style={{
                width: w,
                animationDelay: `${i * 0.18}s`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function PanelActionCard({ entry }: { entry: ChatEntry }) {
  const { eventType, content } = entry

  if (eventType === 'goal_created') {
    let title = ''
    try { title = (JSON.parse(content) as GoalCreatedData).title } catch {}
    return (
      <GoalCard
        label="Goal created"
        accent="#4ade80"
        title={title || 'New goal'}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 12 10 18 20 6" />
          </svg>
        }
      />
    )
  }

  if (eventType === 'goal_create_started') {
    return (
      <div className="px-3 py-2.5 flex items-center gap-2" style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '16px 16px 16px 4px' }}>
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 rounded-full bg-neutral-400 animate-bounce" style={{ animationDelay: `${i * 140}ms` }} />
        ))}
        <span className="text-[13px] text-white/50">Creating goal…</span>
      </div>
    )
  }

  if (eventType === 'profile_updated') {
    return (
      <div className="px-3 py-2.5" style={{ background: 'rgba(14,165,233,.1)', border: '1px solid rgba(14,165,233,.26)', borderRadius: '16px 16px 16px 4px' }}>
        <div className="flex items-center gap-1.5 mb-1">
          <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(14,165,233,.2)' }}>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="#38bdf8" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="5" cy="3.5" r="1.8" />
              <path d="M1 9.5c0-1.9 1.8-3.5 4-3.5s4 1.6 4 3.5" />
            </svg>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-[1.4px]" style={{ color: '#38bdf8' }}>Profile updated</span>
        </div>
        {content && <div className="text-[12px] text-white/60 ml-[22px] font-mono">{content}</div>}
      </div>
    )
  }

  if (eventType === 'goal_delayed') {
    let title = '', suffix = ''
    try {
      const data = JSON.parse(content) as { title: string; added_seconds: number }
      title = data.title
      const days = Math.round(data.added_seconds / 86400)
      suffix = days >= 1 ? `+${days}d` : `+${data.added_seconds}s`
    } catch {}
    return (
      <div className="px-3 py-2.5" style={{ background: 'rgba(234,88,12,.1)', border: '1px solid rgba(234,88,12,.26)', borderRadius: '16px 16px 16px 4px' }}>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(234,88,12,.2)' }}>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="#fb923c" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="5" cy="5" r="4" />
              <path d="M5 3v2.2l1.4 1.4" />
            </svg>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-[1.4px]" style={{ color: '#fb923c' }}>Goal delayed</span>
          {suffix && (
            <span className="ml-auto text-[11px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(234,88,12,.18)', color: '#fb923c' }}>
              {suffix}
            </span>
          )}
        </div>
        {title && <div className="text-[13px] font-medium text-white/80 mt-1 ml-[22px]">{title}</div>}
      </div>
    )
  }

  if (eventType === 'goal_priority_changed') {
    return (
      <div className="px-3 py-2 flex items-center gap-2" style={{ background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.22)', borderRadius: '16px 16px 16px 4px' }}>
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="9" x2="5" y2="1" />
          <polyline points="1 5 5 1 9 5" />
        </svg>
        <span className="text-[12px] text-white/65">Priority updated</span>
        {content && !content.startsWith('{') && <span className="text-[12px] font-mono text-white/40">{content}</span>}
      </div>
    )
  }

  if (eventType === 'deep_search_started') {
    return (
      <div className="px-3 py-2.5" style={{ background: 'rgba(124,58,237,.1)', border: '1px solid rgba(124,58,237,.26)', borderRadius: '16px 16px 16px 4px' }}>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(124,58,237,.22)' }}>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="#a78bfa" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="4.5" cy="4.5" r="3" />
              <line x1="7" y1="7" x2="9.5" y2="9.5" />
            </svg>
          </div>
          <span className="text-[13px]" style={{ color: 'rgba(167,139,250,.85)' }}>Searching…</span>
          <div className="ml-auto flex items-end gap-0.5">
            {[3, 5, 7, 5, 3].map((h, i) => (
              <span key={i} className="w-[3px] rounded-sm animate-pulse" style={{ height: h, background: '#a78bfa', opacity: 0.55, animationDelay: `${i * 110}ms` }} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (eventType === 'deep_search_done') {
    return (
      <div className="px-3 py-2 flex items-center gap-1.5" style={{ background: 'rgba(124,58,237,.07)', border: '1px solid rgba(124,58,237,.18)', borderRadius: '16px 16px 16px 4px' }}>
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1.5 5 4 7.5 8.5 2" />
        </svg>
        <span className="text-[12px]" style={{ color: 'rgba(167,139,250,.7)' }}>Search complete</span>
      </div>
    )
  }

  if (eventType === 'middleware_retry') {
    return (
      <div className="px-3 py-2 flex items-center gap-1.5" style={{ background: 'rgba(245,158,11,.07)', border: '1px solid rgba(245,158,11,.18)', borderRadius: '16px 16px 16px 4px' }}>
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="#fbbf24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8.5 5A3.5 3.5 0 0 1 2 5a3.5 3.5 0 0 1 3.5-3.5 3.47 3.47 0 0 1 2.47 1.03L9.5 4" />
          <polyline points="9.5 1.5 9.5 4 7 4" />
        </svg>
        <span className="text-[12px] text-white/50">Retrying…</span>
      </div>
    )
  }

  const loading = isLoadingAction(eventType)
  return (
    <div className="px-3 py-2 flex items-center gap-2" style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '16px 16px 16px 4px' }}>
      {loading
        ? [0, 1, 2].map((i) => <span key={i} className="size-1.5 rounded-full bg-neutral-400 animate-bounce" style={{ animationDelay: `${i * 140}ms` }} />)
        : <span className="size-1.5 rounded-full bg-neutral-400/60" />}
      <span className="text-[12px] text-white/50">{actionSummary(entry)}</span>
    </div>
  )
}

const HIDDEN_EVENT_TYPES = new Set(['sse_connected', 'permission_resolved', 'suggested_replies', 'graph_updated'])

function formatChatTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function PanelAssistantContent({
  entry,
  sending,
  onSuggestion,
  onResolve,
}: {
  entry: ChatEntry
  sending: boolean
  onResolve: (id: string, approved: boolean) => void
  onSuggestion: (entryId: string, suggestion: string) => void
}) {
  if (entry.kind === 'assistant') {
    return (
      <>
        <div className="text-[10px] font-semibold mb-0.5 px-1" style={{ color: 'var(--white-dim)' }}>Personal</div>
        <div
          className="px-3 py-2 text-[13px] leading-snug"
          style={{
            background: 'var(--surface2)',
            color: '#fff',
            border: '1px solid var(--border)',
            borderRadius: '16px 16px 16px 4px',
          }}
        >
          <AssistantContent content={entry.content} />
        </div>
        <div className="text-[10px] mt-0.5 px-1" style={{ color: 'var(--white-dim)' }}>{formatChatTime(entry.timestamp)}</div>
        {entry.suggestions && entry.suggestions.length > 0 && !entry.suggestionsHidden && (
          <div className="mt-2 flex flex-wrap gap-2">
            {entry.suggestions.map((s, i) => {
              const isSelected = entry.selectedSuggestion === s
              const isDimmed = entry.selectedSuggestion !== undefined && !isSelected
              return (
                <button
                  key={i}
                  type="button"
                  disabled={entry.selectedSuggestion !== undefined || sending}
                  onClick={() => onSuggestion(entry.id, s)}
                  className={[
                    'rounded-full px-4 py-2 text-sm text-white transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
                    SUGGESTION_COLORS[i % SUGGESTION_COLORS.length],
                    isSelected ? 'scale-105 ring-2 ring-white ring-offset-1 brightness-110' : '',
                    isDimmed ? 'opacity-10 saturate-50' : '',
                    entry.suggestionsExiting ? 'pointer-events-none -translate-y-2 scale-[0.86] opacity-0 blur-[2px]' : '',
                  ].join(' ')}
                  style={
                    entry.suggestionsExiting
                      ? { transitionDelay: `${((entry.suggestions?.length ?? 1) - 1 - i) * SUGGESTION_EXIT_STAGGER_MS}ms` }
                      : undefined
                  }
                >
                  {isSelected ? '✓ ' : ''}{s}
                </button>
              )
            })}
          </div>
        )}
      </>
    )
  }

  if (entry.kind === 'permission') {
    const p = entry.permission
    if (!p) return null
    return (
      <>
        <div className="text-[10px] font-semibold mb-0.5 px-1" style={{ color: 'var(--white-dim)' }}>System</div>
        <div
          className="px-3 py-2 text-[13px] leading-snug"
          style={{
            background: entry.permissionResolved && entry.permissionApproved ? 'rgba(20,83,45,.35)' : 'var(--surface2)',
            color: '#fff',
            border: `1px solid ${entry.permissionResolved && entry.permissionApproved ? 'rgba(34,197,94,.28)' : 'var(--border)'}`,
            borderRadius: '16px 16px 16px 4px',
          }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-amber-300/80">Permission</div>
          <div className="mt-1">
            <span className="font-mono text-[12px]">{p.key}</span>
            {' = '}
            <span className="font-mono text-[12px]">{p.value}</span>
          </div>
          {p.reason && <div className="mt-1 text-[12px] text-white/65">{p.reason}</div>}
        </div>
        <div className="text-[10px] mt-0.5 px-1" style={{ color: 'var(--white-dim)' }}>{formatChatTime(entry.timestamp)}</div>
      </>
    )
  }

  if (entry.kind === 'reminder_permission') {
    const p = entry.reminderPermission
    if (!p) return null
    const timeStr = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
    const isOneShot = p.end_time > 0
    return (
      <>
        <div className="text-[10px] font-semibold mb-0.5 px-1" style={{ color: 'var(--white-dim)' }}>System</div>
        <div
          className="px-3 py-2 text-[13px] leading-snug"
          style={{
            background: entry.permissionResolved && entry.permissionApproved ? 'rgba(124,58,237,.2)' : 'var(--surface2)',
            color: '#fff',
            border: `1px solid ${entry.permissionResolved && entry.permissionApproved ? 'rgba(167,139,250,.4)' : 'var(--border)'}`,
            borderRadius: '16px 16px 16px 4px',
          }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[1.5px]" style={{ color: '#a78bfa' }}>Reminder</div>
          <div className="mt-1 font-semibold">{p.title}</div>
          <div className="mt-0.5 text-[12px] text-white/65">{timeStr} · {isOneShot ? 'One-time' : formatReminderDays(p.days)}</div>
          {!entry.permissionResolved && (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="rounded px-2.5 py-1 text-[11px] font-medium text-white"
                style={{ background: 'rgba(167,139,250,.25)', border: '1px solid rgba(167,139,250,.4)' }}
                onClick={() => onResolve(p.permission_id, true)}
              >
                Set reminder
              </button>
              <button
                type="button"
                className="rounded border border-[#333] px-2.5 py-1 text-[11px] text-white/55"
                onClick={() => onResolve(p.permission_id, false)}
              >
                No thanks
              </button>
            </div>
          )}
          {entry.permissionResolved && (
            <div className="mt-1 text-[11px]" style={{ color: entry.permissionApproved ? '#a78bfa' : 'rgba(255,255,255,.4)' }}>
              {entry.permissionApproved ? 'Reminder set' : 'Declined'}
            </div>
          )}
        </div>
        <div className="text-[10px] mt-0.5 px-1" style={{ color: 'var(--white-dim)' }}>{formatChatTime(entry.timestamp)}</div>
      </>
    )
  }

  if (entry.eventType === 'graph_update_started') {
    return (
      <>
        <div className="text-[10px] font-semibold mb-0.5 px-1" style={{ color: 'var(--white-dim)' }}>System</div>
        <GraphUpdateBubble resolved={entry.graphUpdateResolved ?? false} />
      </>
    )
  }

  return (
    <>
      <div className="text-[10px] font-semibold mb-0.5 px-1" style={{ color: 'var(--white-dim)' }}>System</div>
      <PanelActionCard entry={entry} />
      <div className="text-[10px] mt-0.5 px-1" style={{ color: 'var(--white-dim)' }}>{formatChatTime(entry.timestamp)}</div>
    </>
  )
}

export default function ChatView({ mode = 'page', sessionId }: { mode?: 'page' | 'panel'; sessionId: string }) {
  const panelMode = mode === 'panel'
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The per-user client server URL resolves asynchronously after sign-in. The
  // SSE/session effects must rebuild when it lands (or changes), otherwise an
  // EventSource opened against an empty/stale base never recovers.
  const [clientBase, setClientBase] = useState<string | null>(() => getClientBaseUrl())
  const pendingSuggestionHighlightsRef = useRef<Array<{ text: string; color: string }>>([])
  // Texts rendered optimistically that should suppress their own SSE echo so the
  // user's bubble never appears twice during a turn.
  const pendingEchoRef = useRef<string[]>([])
  // Whether the live SSE stream delivered the assistant reply for the in-flight
  // turn. If it did, we skip the end-of-turn reconcile so live action
  // animations (graph forming, searching, goal creation…) are preserved.
  const sawLiveAssistantRef = useRef(false)
  const suggestionHideTimeoutRef = useRef<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleAttach(file: File, kind: 'image' | 'file') {
    const prefix = kind === 'image' ? '📷' : '📎'
    setInput((prev) => (prev ? prev + ' ' : '') + `${prefix} ${file.name}`)
    if (panelMode) textAreaRef.current?.focus()
    else inputRef.current?.focus()
  }

  async function loadSession(sid: string) {
    try {
      setReloading(true)
      const url = `${SERVER_ENDPOINTS.middlewareSession}?sessionId=${encodeURIComponent(sid)}`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { ok: boolean; events?: ServerSessionEvent[] }
      if (!data.ok || !data.events) return

      // Build entries in stream order so each suggested_replies event can be
      // attached to the assistant message from its OWN turn. Attaching to the
      // global last assistant (the old behavior) stamped an earlier turn's
      // chips onto an unrelated later message, which looked random.
      let loaded: ChatEntry[] = []
      let histIndex = 0
      let lastAssistantIdx = -1
      for (const e of data.events) {
        if (e.type === 'suggested_replies') {
          if (lastAssistantIdx >= 0) {
            try {
              const suggestions = JSON.parse(e.content) as string[]
              loaded[lastAssistantIdx] = {
                ...loaded[lastAssistantIdx],
                suggestions,
                suggestionsHidden: false,
                suggestionsExiting: false,
                selectedSuggestion: undefined,
              }
            } catch { /* ignore malformed */ }
          }
          continue
        }
        if (HIDDEN_EVENT_TYPES.has(e.type)) continue
        const entry = parseEntry(`hist-${histIndex++}`, e.type, e.content, e.timestamp)
        loaded.push(entry)
        if (entry.kind === 'assistant') lastAssistantIdx = loaded.length - 1
      }

      // Only the most recent assistant turn keeps active chips; earlier turns
      // were already answered, so hide their (now stale) suggestions.
      loaded = loaded.map((entry, idx) =>
        entry.kind === 'assistant' && idx !== lastAssistantIdx && entry.suggestions?.length
          ? { ...entry, suggestionsHidden: true }
          : entry,
      )

      // apply any permission resolutions that are already in history
      const resolutions = data.events.filter((e) => e.type === 'permission_resolved')
      for (const r of resolutions) {
        loaded = applyPermissionResolution(loaded, r.content)
      }

      const graphUpdates = data.events.filter((e) => e.type === 'graph_updated')
      for (const _ of graphUpdates) {
        loaded = applyGraphUpdateResolved(loaded)
      }

      // History is now authoritative; drop any optimistic echo/highlight state
      // so it can't suppress or decorate a future message by accident.
      pendingEchoRef.current = []
      setEntries(loaded)
      setThinking(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    finally {
      setReloading(false)
    }
  }

  useEffect(() => {
    const unsubscribe = subscribeClientBaseUrl(setClientBase)
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    setEntries([])
    setThinking(false)
    if (!clientBase) return
    void loadSession(sessionId)
  }, [sessionId, clientBase])

  useEffect(() => {
    if (!clientBase) return
    const url = `${SERVER_ENDPOINTS.middlewareEvents}?sessionId=${encodeURIComponent(sessionId)}`
    const source = new EventSource(url)

    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as SSEEnvelope
        const { type, data } = envelope

        if (type === 'suggested_replies') {
          setEntries((prev) => applySuggestedReplies(prev, data))
          return
        }

        if (type === 'permission_resolved') {
          setEntries((prev) => applyPermissionResolution(prev, data))
          return
        }

        if (type === 'graph_updated') {
          setEntries((prev) => applyGraphUpdateResolved(prev))
          return
        }

        if (HIDDEN_EVENT_TYPES.has(type)) return

        if (type === 'message_received') setThinking(true)
        if (type === 'assistant_message') { setThinking(false); sawLiveAssistantRef.current = true }

        const entry = parseEntry(`live-${Date.now()}-${Math.random()}`, type, data, Math.floor(Date.now() / 1000))
        if (type === 'message_received') {
          // We already rendered this message optimistically; consume its echo
          // instead of appending a duplicate bubble.
          const echoIndex = pendingEchoRef.current.indexOf(data)
          if (echoIndex >= 0) {
            pendingEchoRef.current.splice(echoIndex, 1)
            return
          }
          const pendingIndex = pendingSuggestionHighlightsRef.current.findIndex((item) => item.text === data)
          const highlightedEntry = pendingIndex >= 0
            ? {
              ...entry,
              highlightOnMount: true,
              highlightColor: pendingSuggestionHighlightsRef.current[pendingIndex]?.color,
            }
            : entry
          if (pendingIndex >= 0) pendingSuggestionHighlightsRef.current.splice(pendingIndex, 1)
          setEntries((prev) => [...prev, highlightedEntry])
          return
        }

        setEntries((prev) => [...prev, entry])
      } catch { /* ignore malformed */ }
    }

    return () => source.close()
  }, [sessionId, clientBase])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  useEffect(() => {
    if (!panelMode) return
    const el = textAreaRef.current
    if (!el) return
    el.style.height = '40px'
    el.style.height = `${Math.min(el.scrollHeight, 100)}px`
  }, [input, panelMode])

  useEffect(() => {
    return () => {
      if (suggestionHideTimeoutRef.current !== null) {
        window.clearTimeout(suggestionHideTimeoutRef.current)
      }
    }
  }, [])

  async function send(override?: string) {
    const msg = (override ?? input).trim()
    if (!msg || sending) return

    if (override === undefined) {
      if (suggestionHideTimeoutRef.current !== null) {
        window.clearTimeout(suggestionHideTimeoutRef.current)
      }
      setEntries((prev) => beginHidePendingSuggestions(prev))
      suggestionHideTimeoutRef.current = window.setTimeout(() => {
        setEntries((prev) => hidePendingSuggestions(prev))
        suggestionHideTimeoutRef.current = null
      }, SUGGESTION_EXIT_MS + 5 * SUGGESTION_EXIT_STAGGER_MS)
    }

    setSending(true)
    setInput('')
    setError(null)
    // Show the working indicator immediately rather than waiting for the SSE
    // `message_received` echo, so the turn never looks frozen while the model
    // runs. The reconcile / `assistant_message` clears it.
    setThinking(true)
    sawLiveAssistantRef.current = false

    // Render the user's own bubble optimistically so it appears the instant
    // they hit send instead of only after the reply loads. Its SSE echo is
    // suppressed via pendingEchoRef so it never doubles up. If this message
    // came from a suggestion chip, carry its highlight flash here.
    {
      const highlightIndex = pendingSuggestionHighlightsRef.current.findIndex((item) => item.text === msg)
      const highlight = highlightIndex >= 0 ? pendingSuggestionHighlightsRef.current[highlightIndex] : undefined
      if (highlightIndex >= 0) pendingSuggestionHighlightsRef.current.splice(highlightIndex, 1)
      const optimisticEntry: ChatEntry = {
        id: freshOptimisticId(),
        kind: 'user',
        eventType: 'message_received',
        content: msg,
        timestamp: nowSeconds(),
        ...(highlight ? { highlightOnMount: true, highlightColor: highlight.color } : {}),
      }
      pendingEchoRef.current.push(msg)
      setEntries((prev) => [...prev, optimisticEntry])
    }

    try {
      const res = await fetch(SERVER_ENDPOINTS.middlewareMessage, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: msg }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      // The POST only resolves once the middleware has finished and recorded
      // every event to the session. If the live SSE stream already delivered
      // the reply, keep it (its action animations are richer than a reload).
      // Otherwise reconcile from the authoritative history so the reply still
      // lands — no manual refresh required.
      if (!sawLiveAssistantRef.current) await loadSession(sessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  function resolvePermission(permissionId: string, approved: boolean) {
    /* optimistic update — show resolved state immediately */
    setEntries((prev) =>
      prev.map((e) =>
        e.kind === 'permission' && e.permission?.permission_id === permissionId
          ? { ...e, permissionResolved: true, permissionApproved: approved }
          : e,
      ),
    )
    fetch(SERVER_ENDPOINTS.middlewarePermission, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionId, approved }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        // Resolving a permission can continue the middleware turn; reconcile
        // from recorded history so any follow-up reply lands without a refresh.
        return loadSession(sessionId)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  const handleSuggestion = (entry: ChatEntry, suggestion: string) => {
    if (sending) return
    const suggestionIndex = entry.suggestions?.indexOf(suggestion) ?? 0
    pendingSuggestionHighlightsRef.current.push({
      text: suggestion,
      color: SUGGESTION_HIGHLIGHT_COLORS[suggestionIndex % SUGGESTION_HIGHLIGHT_COLORS.length],
    })
    setEntries((prev) => markSuggestionSelected(prev, entry.id, suggestion))
    setInput(suggestion)
    void send(suggestion)
  }

  return (
    <section className={`mx-auto flex w-full flex-col ${panelMode ? 'max-w-none h-full' : 'max-w-3xl'}`} style={panelMode ? undefined : { height: 'calc(100vh - 9rem)' }}>
      {!panelMode && (
        <header className="mb-4">
          <h1 className="text-2xl font-bold text-white">Chat</h1>
        </header>
      )}

      <div className={`flex-1 space-y-3 overflow-y-auto ${panelMode ? 'px-4 pt-4 pb-4' : 'pb-4'}`}>
        {entries.length === 0 && reloading && (
          <div className="mt-16 flex flex-col items-center gap-3 text-white/40">
            <span className="inline-flex items-center gap-1.5">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="size-2 rounded-full bg-neutral-400 animate-bounce"
                  style={{ animationDelay: `${dot * 140}ms` }}
                />
              ))}
            </span>
            <p className="text-sm">Connecting…</p>
          </div>
        )}
        {entries.length === 0 && !reloading && (
          <p className="mt-12 text-center text-sm text-white/40">
            No messages yet. Say something.
          </p>
        )}
        {panelMode ? entries.map((entry) => {
          if (entry.kind === 'user') {
            return (
              <div key={entry.id} className="flex flex-col max-w-[78%] self-end items-end ml-auto">
                <div
                  className="px-3 py-2 text-[13px] leading-snug"
                  style={{
                    background: '#fff',
                    color: '#000',
                    borderRadius: '16px 16px 4px 16px',
                  }}
                >
                  {entry.content}
                </div>
                <div className="text-[10px] mt-0.5 px-1" style={{ color: 'var(--white-dim)' }}>{formatChatTime(entry.timestamp)}</div>
              </div>
            )
          }

          return (
            <div key={entry.id} className="flex flex-col max-w-[78%] self-start items-start">
              <PanelAssistantContent entry={entry} sending={sending} onSuggestion={(_, suggestion) => handleSuggestion(entry, suggestion)} onResolve={resolvePermission} />
            </div>
          )
        }) : entries.map((entry) => {
          if (entry.kind === 'user') return <UserBubble key={entry.id} entry={entry} />
          if (entry.kind === 'assistant') return (
            <AssistantBubble
              key={entry.id}
              entry={entry}
              onSuggestion={(_, suggestion) => handleSuggestion(entry, suggestion)}
            />
          )
          if (entry.kind === 'permission')
            return <PermissionBubble key={entry.id} entry={entry} onResolve={resolvePermission} />
          if (entry.kind === 'reminder_permission')
            return <ReminderPermissionBubble key={entry.id} entry={entry} onResolve={resolvePermission} />
          if (entry.eventType === 'graph_update_started')
            return <GraphUpdateBubble key={entry.id} resolved={entry.graphUpdateResolved ?? false} />
          return <ActionBubble key={entry.id} entry={entry} />
        })}
        {thinking && (panelMode ? (
          <div className="flex flex-col max-w-[78%] self-start items-start">
            <div className="text-[10px] font-semibold mb-0.5 px-1" style={{ color: 'var(--white-dim)' }}>Personal</div>
            <div
              className="px-3 py-2 text-[13px] leading-snug"
              style={{
                background: 'var(--surface2)',
                color: '#fff',
                border: '1px solid var(--border)',
                borderRadius: '16px 16px 16px 4px',
              }}
            >
              <span className="inline-flex items-center gap-1">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="size-1.5 rounded-full bg-neutral-400 animate-bounce"
                    style={{ animationDelay: `${dot * 140}ms` }}
                  />
                ))}
              </span>
            </div>
          </div>
        ) : <ThinkingBubble />)}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      {/* Options menu — slides up above the input bar */}
      <div
        className="overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        style={{ maxHeight: menuOpen ? 220 : 0, opacity: menuOpen ? 1 : 0 }}
      >
        <div className="pb-2 pt-1 grid grid-cols-4 gap-2">
          {/* Propose Goal — green */}
          <button
            type="button"
            className="flex flex-col items-center gap-1.5 rounded-2xl py-3 px-2 text-[11px] font-semibold text-white transition-transform active:scale-95"
            style={{ background: 'rgba(22,163,74,0.18)', border: '1px solid rgba(22,163,74,0.35)' }}
            onClick={() => {
              setInput((prev) => (prev ? prev + ' ' : '') + '/propose ')
              setMenuOpen(false)
              inputRef.current?.focus()
            }}
          >
            <span className="text-2xl leading-none">🎯</span>
            <span style={{ color: '#4ade80' }}>Propose</span>
          </button>

          {/* Photo — blue */}
          <button
            type="button"
            className="flex flex-col items-center gap-1.5 rounded-2xl py-3 px-2 text-[11px] font-semibold text-white transition-transform active:scale-95"
            style={{ background: 'rgba(37,99,235,0.18)', border: '1px solid rgba(37,99,235,0.35)' }}
            onClick={() => { imageInputRef.current?.click(); setMenuOpen(false) }}
          >
            <span className="text-2xl leading-none">📷</span>
            <span style={{ color: '#60a5fa' }}>Photo</span>
          </button>

          {/* File — orange */}
          <button
            type="button"
            className="flex flex-col items-center gap-1.5 rounded-2xl py-3 px-2 text-[11px] font-semibold text-white transition-transform active:scale-95"
            style={{ background: 'rgba(234,88,12,0.18)', border: '1px solid rgba(234,88,12,0.35)' }}
            onClick={() => { fileInputRef.current?.click(); setMenuOpen(false) }}
          >
            <span className="text-2xl leading-none">📎</span>
            <span style={{ color: '#fb923c' }}>File</span>
          </button>

          {/* Reminder — violet */}
          <button
            type="button"
            className="flex flex-col items-center gap-1.5 rounded-2xl py-3 px-2 text-[11px] font-semibold text-white transition-transform active:scale-95"
            style={{ background: 'rgba(124,58,237,0.18)', border: '1px solid rgba(124,58,237,0.35)' }}
            onClick={() => {
              setInput((prev) => (prev ? prev + ' ' : '') + '/remind ')
              setMenuOpen(false)
              inputRef.current?.focus()
            }}
          >
            <span className="text-2xl leading-none">⏰</span>
            <span style={{ color: '#a78bfa' }}>Remind</span>
          </button>
        </div>
      </div>

      {/* hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleAttach(f, 'image')
          e.target.value = ''
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleAttach(f, 'file')
          e.target.value = ''
        }}
      />

      <div className={panelMode ? 'px-3.5 py-3 flex gap-2 items-end flex-shrink-0' : 'flex items-center gap-2 border-t border-[#2a2a2a] pt-3'} style={panelMode ? { borderTop: '1px solid var(--border)' } : undefined}>
        {/* + button */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className={panelMode
            ? 'w-10 h-10 rounded-xl flex items-center justify-center cursor-pointer flex-shrink-0 active:opacity-85'
            : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#333] text-white/55 transition-all hover:bg-[#1a1a1a] hover:text-white/80'}
          style={panelMode
            ? { background: 'var(--surface2)', border: '1px solid var(--border)', color: '#fff' }
            : (menuOpen ? { borderColor: 'rgba(255,255,255,0.3)', color: 'rgba(255,255,255,0.9)', background: '#1a1a1a' } : {})}
        >
          <svg
            width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            style={{
              transition: 'transform 0.25s ease',
              transform: menuOpen ? 'rotate(45deg)' : 'rotate(0deg)',
            }}
          >
            <line x1="8" y1="2" x2="8" y2="14" />
            <line x1="2" y1="8" x2="14" y2="8" />
          </svg>
        </button>

        {panelMode ? (
          <textarea
            ref={textAreaRef}
            rows={1}
            className="flex-1 rounded-xl px-3.5 py-2.5 text-[13px] outline-none resize-none h-10 max-h-[100px]"
            style={{ background: 'var(--surface2)', border: '1px solid var(--border-light)', color: '#fff' }}
            placeholder={sending ? 'Waiting for response...' : 'Write a message...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            disabled={sending}
          />
        ) : (
          <input
            ref={inputRef}
            type="text"
            className="flex-1 rounded-xl border border-[#333] px-4 py-2.5 text-sm text-white placeholder-white/40 focus:border-white/50 focus:outline-none disabled:bg-[#1a1a1a] disabled:text-white/40"
            placeholder={sending ? 'Waiting for response...' : 'Message...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            disabled={sending}
          />
        )}
        <button
          type="button"
          className={panelMode
            ? 'w-10 h-10 bg-white rounded-xl flex items-center justify-center cursor-pointer flex-shrink-0 active:opacity-85 disabled:cursor-not-allowed disabled:bg-[#2a2a2a]'
            : 'rounded-xl bg-[#111] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#e0e0e0] disabled:cursor-not-allowed disabled:bg-[#2a2a2a] disabled:text-white/40'}
          onClick={() => void send()}
          disabled={!input.trim() || sending}
        >
          {sending ? (
            <span className="inline-flex items-center gap-1">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className={`size-1.5 rounded-full animate-bounce ${panelMode ? 'bg-black' : 'bg-[#111]'}`}
                  style={{ animationDelay: `${dot * 140}ms` }}
                />
              ))}
            </span>
          ) : panelMode ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          ) : (
            'Send'
          )}
        </button>
      </div>
    </section>
  )
}
