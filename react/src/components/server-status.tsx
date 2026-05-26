import { useEffect, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS, SERVER_ENDPOINTS, getClientBaseUrl } from '../config/server'

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

      const url = getClientBaseUrl()
        ? SERVER_ENDPOINTS.goalList
        : CENTRAL_ENDPOINTS.users

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

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-[#0a0a0a]/85 backdrop-blur-sm server-status-in">
      <div className="flex flex-col items-center gap-5">
        <div className="relative size-10">
          <span className="absolute inset-0 rounded-full border border-[#2a2a2a]" />
          <span className="absolute inset-0 rounded-full border border-dashed border-[#444] loading-orbit" style={{ animationDuration: '3s' }} />
          <span className="absolute inset-[30%] rounded-full bg-white/20 loading-bob" />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="size-1 rounded-full bg-white/30"
                style={{ animation: 'aiDot 1.4s ease-in-out infinite', animationDelay: `${i * 0.18}s` }}
              />
            ))}
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/25">
            please wait
          </p>
        </div>
      </div>
    </div>
  )
}
