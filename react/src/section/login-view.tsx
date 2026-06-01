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

export default function LoginView({ onLogin }: LoginViewProps) {
  const [users, setUsers] = useState<ServerUser[]>([])
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [protocol, setProtocol] = useState<'http' | 'https'>(getServerProtocol())
  const [host, setHost] = useState(getServerHost())

  function applyProtocol(p: 'http' | 'https') {
    setProtocol(p)
    setServerProtocol(p)
    void refresh()
  }

  function applyHost() {
    setServerHost(host)
    setHost(getServerHost())
    void refresh()
  }

  async function refresh() {
    try {
      setError(null)
      const res = await fetch(CENTRAL_ENDPOINTS.users, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Central server returned ${res.status}`)
      const payload = (await res.json()) as UserListResponse
      setUsers(payload.users ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function select(id: string, isNew = false) {
    try {
      setBusy(true)
      setError(null)
      const res = await fetch(CENTRAL_ENDPOINTS.usersSelect, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`Select failed: ${res.status}`)
      const payload = (await res.json()) as SelectResponse
      onLogin({ id: payload.id, name: payload.name }, buildClientBaseUrl(payload.port), isNew)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
      const res = await fetch(CENTRAL_ENDPOINTS.usersCreate, {
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
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            className="text-xs text-white/45 hover:text-white/80"
          >
            {protocol.toUpperCase()} · {host} ⚙
          </button>
        </div>

        {showSettings && (
          <div className="mb-4 rounded border border-[#2a2a2a] p-3">
            <p className="mb-2 text-[11px] uppercase tracking-wider text-white/35">Server</p>
            <div className="mb-2 flex gap-1.5">
              {(['http', 'https'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyProtocol(p)}
                  className="flex-1 rounded px-3 py-1.5 text-xs font-medium"
                  style={{
                    background: protocol === p ? '#fff' : 'rgba(255,255,255,.06)',
                    color: protocol === p ? '#000' : 'rgba(255,255,255,.7)',
                    border: '1px solid #2a2a2a',
                  }}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onBlur={applyHost}
              onKeyDown={(e) => { if (e.key === 'Enter') applyHost() }}
              placeholder="127.0.0.1"
              spellCheck={false}
              autoCapitalize="off"
              className="w-full rounded border border-[#2a2a2a] bg-transparent px-2 py-1 text-sm"
            />
            <p className="mt-1.5 text-[10px] text-white/30">
              Central port {CENTRAL_SERVER_PORT} · changing these reloads the user list.
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
