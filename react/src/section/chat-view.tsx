import { useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'

type ChatEntryKind = 'user' | 'assistant' | 'action' | 'permission'

interface PermissionData {
  permission_id: string
  key: string
  value: string
  reason: string
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
  permissionResolved?: boolean
  permissionApproved?: boolean
}

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

  return base
}

function applyPermissionResolution(entries: ChatEntry[], resolvedJson: string): ChatEntry[] {
  try {
    const data = JSON.parse(resolvedJson) as { permission_id: string; approved: boolean }
    return entries.map((e) =>
      e.kind === 'permission' && e.permission?.permission_id === data.permission_id
        ? { ...e, permissionResolved: true, permissionApproved: data.approved }
        : e,
    )
  } catch {
    return entries
  }
}

const ACTION_LABEL: Record<string, string> = {
  goal_create_started: 'Creating goal',
  goal_created: 'Goal created',
  goal_priority_changed: 'Priority updated',
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

function UserBubble({ entry }: { entry: ChatEntry }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[72%] rounded-2xl bg-black px-4 py-2.5 text-sm leading-relaxed text-white">
        {entry.content}
      </div>
    </div>
  )
}

function AssistantBubble({ entry }: { entry: ChatEntry }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[72%] rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm leading-relaxed text-black">
        {entry.content}
      </div>
    </div>
  )
}

function ActionBubble({ entry }: { entry: ChatEntry }) {
  const loading = isLoadingAction(entry.eventType)
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-500">
        {loading && <span className="size-1.5 animate-pulse rounded-full bg-neutral-400" />}
        {!loading && <span className="size-1.5 rounded-full bg-neutral-300" />}
        <span>{actionSummary(entry)}</span>
      </div>
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
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-neutral-200 bg-neutral-50 text-neutral-500'
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
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-amber-600">
          Permission request
        </p>
        <p className="mb-0.5 text-sm font-medium text-black">
          Store <span className="rounded bg-amber-100 px-1 font-mono text-xs">{p.key}</span> ={' '}
          <span className="rounded bg-amber-100 px-1 font-mono text-xs">{p.value}</span>
        </p>
        {p.reason && <p className="mb-3 text-xs text-neutral-600">{p.reason}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-green-400 bg-green-50 px-3 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
            onClick={() => onResolve(p.permission_id, true)}
          >
            Approve
          </button>
          <button
            type="button"
            className="rounded border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
            onClick={() => onResolve(p.permission_id, false)}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}

const HIDDEN_EVENT_TYPES = new Set(['sse_connected', 'permission_resolved'])

export default function ChatView() {
  const [sessionId, setSessionId] = useState('default')
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function loadSession(sid: string) {
    try {
      const url = `${SERVER_ENDPOINTS.middlewareSession}?sessionId=${encodeURIComponent(sid)}`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { ok: boolean; events?: ServerSessionEvent[] }
      if (!data.ok || !data.events) return

      let loaded = data.events
        .filter((e) => !HIDDEN_EVENT_TYPES.has(e.type))
        .map((e, i) => parseEntry(`hist-${i}`, e.type, e.content, e.timestamp))

      // apply any permission resolutions that are already in history
      const resolutions = data.events.filter((e) => e.type === 'permission_resolved')
      for (const r of resolutions) {
        loaded = applyPermissionResolution(loaded, r.content)
      }

      setEntries(loaded)
    } catch { /* silent on load failure */ }
  }

  useEffect(() => {
    setEntries([])
    void loadSession(sessionId)
  }, [sessionId])

  useEffect(() => {
    const url = `${SERVER_ENDPOINTS.middlewareEvents}?sessionId=${encodeURIComponent(sessionId)}`
    const source = new EventSource(url)

    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as SSEEnvelope
        const { type, data } = envelope

        if (HIDDEN_EVENT_TYPES.has(type)) return

        if (type === 'permission_resolved') {
          setEntries((prev) => applyPermissionResolution(prev, data))
          return
        }

        const entry = parseEntry(`live-${Date.now()}-${Math.random()}`, type, data, Math.floor(Date.now() / 1000))
        setEntries((prev) => [...prev, entry])
      } catch { /* ignore malformed */ }
    }

    return () => source.close()
  }, [sessionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  async function send() {
    const msg = input.trim()
    if (!msg || sending) return

    setSending(true)
    setInput('')
    setError(null)

    try {
      const res = await fetch(SERVER_ENDPOINTS.middlewareMessage, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: msg }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  async function resolvePermission(permissionId: string, approved: boolean) {
    try {
      await fetch(SERVER_ENDPOINTS.middlewarePermission, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionId, approved }),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col" style={{ height: 'calc(100vh - 9rem)' }}>
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-black">Chat</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">session</span>
          <input
            type="text"
            className="w-32 rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 focus:border-neutral-500 focus:outline-none"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            onBlur={(e) => { if (!e.target.value.trim()) setSessionId('default') }}
          />
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {entries.length === 0 && (
          <p className="mt-12 text-center text-sm text-neutral-400">
            No messages yet. Say something.
          </p>
        )}
        {entries.map((entry) => {
          if (entry.kind === 'user') return <UserBubble key={entry.id} entry={entry} />
          if (entry.kind === 'assistant') return <AssistantBubble key={entry.id} entry={entry} />
          if (entry.kind === 'permission')
            return <PermissionBubble key={entry.id} entry={entry} onResolve={resolvePermission} />
          return <ActionBubble key={entry.id} entry={entry} />
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mb-2 text-xs text-red-500">{error}</p>}

      <div className="flex gap-2 border-t border-neutral-200 pt-3">
        <input
          ref={inputRef}
          type="text"
          className="flex-1 rounded-xl border border-neutral-300 px-4 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-neutral-500 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-400"
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
        <button
          type="button"
          className="rounded-xl bg-black px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
          onClick={() => void send()}
          disabled={!input.trim() || sending}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </section>
  )
}
