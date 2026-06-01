import { useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS, getClientBaseUrl } from '../config/server'

const POLL_MS     = 3000
const TIMEOUT_MS  = 2500
const FAIL_AFTER  = 2   // show overlay after this many consecutive fails

export default function ServerStatus() {
  const [down, setDown]   = useState(false)
  const failsRef          = useRef(0)
  const timerRef          = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true

    async function probe() {
      if (!alive) return

      // Only monitor the per-user client server (i.e. after sign-in). While in
      // the login/sign-in menu there is no client server yet, so never show the
      // "please wait" overlay there.
      const base = getClientBaseUrl()
      if (!base) {
        failsRef.current = 0
        if (alive) setDown(false)
        if (alive) timerRef.current = setTimeout(probe, POLL_MS)
        return
      }
      const url = SERVER_ENDPOINTS.goalList

      const ctrl = new AbortController()
      const deadline = setTimeout(() => ctrl.abort(), TIMEOUT_MS)

      try {
        const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal })
        if (!res.ok) throw new Error()
        clearTimeout(deadline)
        failsRef.current = 0
        if (alive) setDown(false)
      } catch {
        clearTimeout(deadline)
        failsRef.current++
        if (alive && failsRef.current >= FAIL_AFTER) setDown(true)
      }

      if (alive) timerRef.current = setTimeout(probe, POLL_MS)
    }

    timerRef.current = setTimeout(probe, POLL_MS)
    return () => {
      alive = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  if (!down) return null

  // A quiet badge in the bottom-left corner — it signals the server is
  // unreachable without blocking or covering the app.
  return (
    <div
      className="fixed bottom-3 left-3 z-[300] flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3 server-status-in"
      style={{ background: 'rgba(10,10,10,.85)', border: '1px solid #2a2a2a', backdropFilter: 'blur(4px)' }}
    >
      <div className="relative size-5 flex-shrink-0">
        <span className="absolute inset-0 rounded-full border border-[#2a2a2a]" />
        <span className="absolute inset-0 rounded-full border border-dashed border-[#555] loading-orbit" style={{ animationDuration: '3s' }} />
        <span className="absolute inset-[32%] rounded-full bg-white/30 loading-bob" />
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
        reconnecting
      </span>
    </div>
  )
}
