import { useEffect, useRef, useState } from 'react'

const BASE = [
  { x: 14, y: 37 },
  { x: 42, y: 11 },
  { x: 82, y: 11 },
  { x: 96, y: 44 },
  { x: 54, y: 62 },
]

const EDGES: [number, number][] = [[0,1],[1,2],[2,3],[3,4],[4,0],[1,3]]

// Per-node oscillation: unique frequency + phase so each floats independently
const OSC = [
  { ax: 6,  ay: 5,  fx: 0.38, fy: 0.29, px: 0.0,  py: 1.1  },
  { ax: 5,  ay: 7,  fx: 0.51, fy: 0.41, px: 2.1,  py: 0.3  },
  { ax: 7,  ay: 4,  fx: 0.44, fy: 0.55, px: 1.0,  py: 2.6  },
  { ax: 4,  ay: 6,  fx: 0.33, fy: 0.48, px: 3.4,  py: 0.8  },
  { ax: 6,  ay: 5,  fx: 0.57, fy: 0.36, px: 0.7,  py: 1.9  },
]

// Per-edge dash flow speed (varying makes it feel alive)
const FLOW_SPEED = [0.12, 0.09, 0.14, 0.10, 0.11, 0.08]

const SCAN_CX = 55, SCAN_CY = 37

type Phase = 'generating' | 'assembled' | 'done'

// Small icon for the pill
const ICON_N = [{ x:2,y:5 },{ x:5,y:1 },{ x:9,y:3 },{ x:8,y:8 },{ x:4,y:9 }]
const ICON_E: [number,number][] = [[0,1],[1,2],[2,3],[3,4],[4,0]]

export default function GraphUpdateBubble({ resolved }: { resolved: boolean }) {
  const [phase, setPhase] = useState<Phase>(() => resolved ? 'done' : 'generating')
  const svgRef   = useRef<SVGSVGElement>(null)
  const rafRef   = useRef(0)
  const startRef = useRef(0)
  const dashRef  = useRef(EDGES.map(() => 0))

  // Drive the floating animation via rAF + direct DOM writes (no React re-render per frame)
  useEffect(() => {
    if (phase !== 'generating') {
      cancelAnimationFrame(rafRef.current)
      return
    }

    function tick(now: number) {
      if (!startRef.current) startRef.current = now
      const t = (now - startRef.current) / 1000
      const svg = svgRef.current
      if (!svg) return

      const pos = BASE.map((b, i) => {
        const o = OSC[i]
        return {
          x: b.x + o.ax * Math.sin(t * o.fx * Math.PI * 2 + o.px),
          y: b.y + o.ay * Math.sin(t * o.fy * Math.PI * 2 + o.py),
        }
      })

      svg.querySelectorAll<SVGCircleElement>('.gn').forEach((el, i) => {
        el.setAttribute('cx', pos[i].x.toFixed(1))
        el.setAttribute('cy', pos[i].y.toFixed(1))
      })

      svg.querySelectorAll<SVGLineElement>('.ge').forEach((el, i) => {
        const [ai, bi] = EDGES[i]
        el.setAttribute('x1', pos[ai].x.toFixed(1))
        el.setAttribute('y1', pos[ai].y.toFixed(1))
        el.setAttribute('x2', pos[bi].x.toFixed(1))
        el.setAttribute('y2', pos[bi].y.toFixed(1))
        dashRef.current[i] = (dashRef.current[i] - FLOW_SPEED[i]) % 16
        el.setAttribute('stroke-dashoffset', dashRef.current[i].toFixed(2))
      })

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [phase])

  // Transition on resolve
  useEffect(() => {
    if (!resolved || phase !== 'generating') return
    setPhase('assembled')
  }, [resolved, phase])

  if (phase === 'done') {
    return (
      <div className="flex justify-start" style={{ animation: 'gu-pill-in 0.2s ease-out both' }}>
        <div className="flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-500">
          <svg viewBox="0 0 10 10" className="size-2.5 shrink-0">
            {ICON_E.map(([a,b],i) => (
              <line key={i} x1={ICON_N[a].x} y1={ICON_N[a].y} x2={ICON_N[b].x} y2={ICON_N[b].y}
                stroke="#737373" strokeWidth="1" />
            ))}
            {ICON_N.map((n,i) => (
              <circle key={i} cx={n.x} cy={n.y} r="1.5" fill="#404040" />
            ))}
          </svg>
          <span>Graph updated</span>
        </div>
      </div>
    )
  }

  const assembled = phase === 'assembled'

  return (
    <div className="flex justify-start">
      <div
        className="rounded-xl border border-neutral-200 bg-white px-4 py-3"
        style={assembled ? { animation: 'gu-bubble-exit 0.7s ease-in both' } : undefined}
        onAnimationEnd={assembled ? (e) => { if (e.animationName === 'gu-bubble-exit') setPhase('done') } : undefined}
      >
        <svg ref={svgRef} viewBox="0 0 110 74" className="block w-28 h-[4.5rem]" style={{ overflow: 'visible' }}>

          {/* scan pulse ring — CSS animated, only during generating */}
          {!assembled && (
            <circle
              cx={SCAN_CX} cy={SCAN_CY} r="5"
              fill="none" stroke="#e5e5e5" strokeWidth="1"
              style={{
                transformOrigin: `${SCAN_CX}px ${SCAN_CY}px`,
                animation: 'gu-scan 2.4s ease-out 0.8s infinite',
              }}
            />
          )}

          {/* edges */}
          {EDGES.map(([ai, bi], i) => {
            const a = BASE[ai], b = BASE[bi]
            if (assembled) {
              return (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke="#171717" strokeWidth="1.2"
                  style={{ animation: 'gu-edge-solid 0.3s ease-out both' }}
                />
              )
            }
            return (
              <line key={i} className="ge"
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="#d4d4d4" strokeWidth="1"
                strokeDasharray="3 5" strokeDashoffset="0"
                style={{
                  opacity: 0,
                  animation: `gu-edge-appear 0.3s ease-out ${0.05 + i * 0.1}s forwards`,
                }}
              />
            )
          })}

          {/* nodes */}
          {BASE.map((n, i) => {
            if (assembled) {
              return (
                <circle key={i} cx={n.x} cy={n.y} r="4"
                  fill="#171717" stroke="#171717" strokeWidth="1.5"
                  style={{
                    transformOrigin: `${n.x}px ${n.y}px`,
                    animation: `gu-node-flash 0.5s ease-out ${i * 0.04}s both`,
                  }}
                />
              )
            }
            return (
              <circle key={i} className="gn"
                cx={n.x} cy={n.y} r="4"
                fill="#fff" stroke="#525252" strokeWidth="1.5"
                style={{
                  opacity: 0,
                  transformOrigin: `${n.x}px ${n.y}px`,
                  animation: `gu-node-appear 0.25s ease-out ${i * 0.13}s both`,
                }}
              />
            )
          })}
        </svg>

        <p className="mt-1 text-center text-[10px] tracking-widest text-neutral-400">
          {assembled ? 'assembled' : 'updating graph'}
        </p>
      </div>
    </div>
  )
}
