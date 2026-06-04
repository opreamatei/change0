import { useEffect, useState } from 'react'
import {
  CENTRAL_ENDPOINTS,
  CENTRAL_SERVER_PORT,
  buildClientBaseUrl,
  getCentralBaseUrl,
  setCentralBaseUrl,
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
  const [serverUrl, setServerUrl] = useState(getCentralBaseUrl())
  const [urlInput, setUrlInput] = useState(getCentralBaseUrl())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  /* Paste any link. Local bare hosts default to http and the central port. */
  function applyUrl() {
    try {
      const next = setCentralBaseUrl(urlInput)
      setServerUrl(next)
      setUrlInput(next)
      void refresh(next)
    } catch {
      setError('Invalid server URL')
    }
  }

  async function refresh(displayUrl = serverUrl) {
    try {
      setError(null)
      const res = await fetchTimeout(CENTRAL_ENDPOINTS.users, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Central server returned ${res.status}`)
      const payload = (await res.json()) as UserListResponse
      setUsers(payload.users ?? [])
    } catch {
      setUsers([])
      setError(`Couldn't reach the server at ${displayUrl}. Check the Server URL.`)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function select(id: string, isNew = false) {
    const MAX_PORT_RETRIES = 6   // up to ~9 seconds waiting for client process
    try {
      setBusy(true)
      setError(null)
      let payload: SelectResponse | null = null
      for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
        const res = await fetchTimeout(CENTRAL_ENDPOINTS.usersSelect, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        if (!res.ok) throw new Error(`Select failed: ${res.status}`)
        const p = (await res.json()) as SelectResponse
        // For brand-new users the client process may not have started yet —
        // the server returns port=0. Retry until we get a real port.
        if (isNew && !p.port && attempt < MAX_PORT_RETRIES) {
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
        payload = p
        break
      }
      if (!payload) throw new Error('Client server did not start in time')
      onLogin({ id: payload.id, name: payload.name }, buildClientBaseUrl(payload.port), isNew)
    } catch {
      setError(`Couldn't reach the server at ${serverUrl}. Check the Server URL.`)
    } finally {
      setBusy(false)
    }
  }

  async function deleteUser(id: string) {
    try {
      setBusy(true)
      setError(null)
      const res = await fetchTimeout(CENTRAL_ENDPOINTS.usersDelete, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
      setConfirmDeleteId(null)
      await refresh()
    } catch {
      setError(`Couldn't reach the server at ${serverUrl}. Check the Server URL.`)
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
          <span className="text-xs text-white/45">{serverUrl} ▾</span>
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
              Paste a link — local http servers use port {CENTRAL_SERVER_PORT}; Cloudflare URLs should stay without an explicit port.
            </p>
          </div>
        )}

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <ul className="mb-6 divide-y divide-[#2a2a2a] rounded border border-[#2a2a2a]">
          {users.length === 0 && (
            <li className="px-3 py-3 text-sm text-white/55">No users yet.</li>
          )}
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{u.name}</p>
                <p className="truncate text-[10px] text-white/40">{u.id}</p>
              </div>
              {confirmDeleteId === u.id ? (
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <span className="text-[10px] text-white/45">Delete user &amp; journeys?</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteUser(u.id)}
                    className="rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDeleteId(null)}
                    className="rounded bg-[#222] px-2.5 py-1 text-xs text-white/70 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void select(u.id)}
                    className="rounded bg-[#111] px-3 py-1 text-xs text-white disabled:bg-[#333]"
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setError(null); setConfirmDeleteId(u.id) }}
                    aria-label={`Delete ${u.name}`}
                    className="flex h-7 w-7 items-center justify-center rounded text-white/40 hover:text-red-400 disabled:opacity-40"
                    style={{ border: '1px solid #2a2a2a' }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
                    </svg>
                  </button>
                </div>
              )}
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
