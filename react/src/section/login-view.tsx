import { useEffect, useState } from 'react'
import {
  CENTRAL_ENDPOINTS,
  CENTRAL_SERVER_PORT,
  buildClientBaseUrl,
  getServerProtocol,
  setServerProtocol,
  getServerHost,
  setServerHost,
} from '../config/server'

export interface LocalUser {
  id: string
  name: string
}

interface ServerUser {
  id: string
  name: string
}

interface UserListResponse {
  ok: boolean
  users: ServerUser[]
}

interface SelectResponse {
  ok: boolean
  id: string
  name: string
  port: number
}

interface LoginViewProps {
  onLogin: (user: LocalUser, clientBaseUrl: string, isNew?: boolean) => void
}

/* Fetch with a hard timeout so an unreachable server (very common on a real
   device, where the default 127.0.0.1 points at the phone) fails fast with a
   clear error instead of hanging and leaving the buttons stuck on "busy". */
async function fetchTimeout(url: string, opts: RequestInit = {}, ms = 6000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

export default function LoginView({ onLogin }: LoginViewProps) {
  const [users, setUsers] = useState<ServerUser[]>([])
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [protocol, setProtocol] = useState<'http' | 'https'>(getServerProtocol())
  const [host, setHost] = useState(getServerHost())
  const [urlInput, setUrlInput] = useState(`${getServerProtocol()}://${getServerHost()}`)

  /* Paste any link — protocol (http/https) and host are detected from it.
     A bare host like "192.168.0.4" defaults to http. */
  function applyUrl() {
    let s = urlInput.trim()
    if (!s) return
    if (!/^https?:\/\//i.test(s)) s = `http://${s}`
    let proto: 'http' | 'https' = 'http'
    let h = ''
    try {
      const u = new URL(s)
      proto = u.protocol === 'https:' ? 'https' : 'http'
      h = u.hostname
    } catch {
      setError('Invalid server URL')
      return
    }
    if (!h) { setError('Invalid server URL'); return }
    setServerProtocol(proto)
    setServerHost(h)
    setProtocol(proto)
    setHost(h)
    setUrlInput(`${proto}://${h}`)
    void refresh()
  }

  async function refresh() {
    try {
      setError(null)
      const res = await fetchTimeout(CENTRAL_ENDPOINTS.users, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Central server returned ${res.status}`)
      const payload = (await res.json()) as UserListResponse
      setUsers(payload.users ?? [])
    } catch {
      setUsers([])
      setError(`Couldn't reach the server at ${protocol}://${host}. Check the Server URL.`)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function select(id: string, isNew = false) {
    try {
      setBusy(true)
      setError(null)
      const res = await fetchTimeout(CENTRAL_ENDPOINTS.usersSelect, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`Select failed: ${res.status}`)
      const payload = (await res.json()) as SelectResponse
      onLogin({ id: payload.id, name: payload.name }, buildClientBaseUrl(payload.port), isNew)
    } catch {
      setError(`Couldn't reach the server at ${protocol}://${host}. Check the Server URL.`)
    } finally {
      setBusy(false)
    }
  }

  async function createAndSelect() {
    const name = newName.trim()
    if (!name) return
    try {
      setBusy(true)
      setError(null)
      const res = await fetchTimeout(CENTRAL_ENDPOINTS.usersCreate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(`Create failed: ${res.status}`)
      const created = (await res.json()) as { id: string }
      setNewName('')
      await refresh()
      await select(created.id, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <main className="min-h-full px-4 py-8 text-white sm:px-6">
      <section className="mx-auto w-full max-w-md p-2">
        <h1 className="mb-3 text-lg font-semibold">Sign in</h1>

        <button
          type="button"
          onClick={() => setShowSettings((s) => !s)}
          className="mb-4 flex w-full items-center justify-between rounded-lg px-3 py-2.5"
          style={{ background: 'rgba(255,255,255,.06)', border: '1px solid #2a2a2a' }}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-white/85">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Server
          </span>
          <span className="text-xs text-white/45">{protocol}://{host} ▾</span>
        </button>

        {showSettings && (
          <div className="mb-4 rounded-lg border border-[#2a2a2a] p-3">
            <p className="mb-2 text-[11px] uppercase tracking-wider text-white/35">Server URL</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onBlur={applyUrl}
                onKeyDown={(e) => { if (e.key === 'Enter') applyUrl() }}
                placeholder="http://127.0.0.1 or https://my-server.com"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="flex-1 rounded border border-[#2a2a2a] bg-transparent px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                onClick={applyUrl}
                className="rounded bg-white px-3 py-1.5 text-xs font-bold text-black"
              >
                Use
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-white/30">
              Paste a link — http/https is detected automatically. Central port {CENTRAL_SERVER_PORT}.
            </p>
          </div>
        )}

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <ul className="mb-6 divide-y divide-[#2a2a2a] rounded border border-[#2a2a2a]">
          {users.length === 0 && (
            <li className="px-3 py-3 text-sm text-white/55">No users yet.</li>
          )}
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-3 py-2">
              <div>
                <p className="text-sm font-medium">{u.name}</p>
                <p className="text-[10px] text-white/40">{u.id}</p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void select(u.id)}
                className="rounded bg-[#111] px-3 py-1 text-xs text-white disabled:bg-[#333]"
              >
                Sign in
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New user name"
            disabled={busy}
            className="flex-1 rounded border border-[#2a2a2a] px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={busy || !newName.trim()}
            onClick={() => void createAndSelect()}
            className="rounded bg-[#111] px-3 py-1 text-xs text-white disabled:bg-[#333]"
          >
            Create
          </button>
        </div>
      </section>
    </main>
  )
}
