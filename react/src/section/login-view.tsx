import { useEffect, useState } from 'react'
import { CENTRAL_ENDPOINTS } from '../config/server'

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
  onLogin: (user: LocalUser, clientBaseUrl: string) => void
}

export default function LoginView({ onLogin }: LoginViewProps) {
  const [users, setUsers] = useState<ServerUser[]>([])
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  async function select(id: string) {
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
      onLogin({ id: payload.id, name: payload.name }, `http://127.0.0.1:${payload.port}`)
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
      await select(created.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <main className="min-h-full bg-white px-4 py-8 text-black sm:px-6">
      <section className="mx-auto w-full max-w-md p-2">
        <h1 className="mb-4 text-lg font-semibold">Sign in</h1>

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        <ul className="mb-6 divide-y divide-neutral-200 rounded border border-neutral-200">
          {users.length === 0 && (
            <li className="px-3 py-3 text-sm text-neutral-500">No users yet.</li>
          )}
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-3 py-2">
              <div>
                <p className="text-sm font-medium">{u.name}</p>
                <p className="text-[10px] text-neutral-400">{u.id}</p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void select(u.id)}
                className="rounded bg-black px-3 py-1 text-xs text-white disabled:bg-neutral-300"
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
            className="flex-1 rounded border border-neutral-200 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={busy || !newName.trim()}
            onClick={() => void createAndSelect()}
            className="rounded bg-black px-3 py-1 text-xs text-white disabled:bg-neutral-300"
          >
            Create
          </button>
        </div>
      </section>
    </main>
  )
}
