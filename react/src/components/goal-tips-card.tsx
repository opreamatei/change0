import { useState } from 'react'

export interface ParsedGoalTips {
  task: string
  success: string
  stages: string[]
  structured: boolean
}

function cleanText(value: unknown, max = 180) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : ''
}

export function parseGoalTips(tips?: string | null): ParsedGoalTips | null {
  const raw = cleanText(tips, 900)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as { task?: unknown; success?: unknown; stages?: unknown }
    const task = cleanText(parsed.task)
    const success = cleanText(parsed.success)
    const stages = Array.isArray(parsed.stages)
      ? parsed.stages.map((x) => cleanText(x, 64)).filter(Boolean).slice(0, 4)
      : []

    if (task || success || stages.length > 0) {
      return { task, success, stages, structured: true }
    }
  } catch {
    // Legacy goals stored tips as plain text.
  }

  return { task: raw, success: '', stages: [], structured: false }
}

function Icon({ type }: { type: 'task' | 'success' | 'stage' }) {
  if (type === 'success') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 12.5l4.2 4.2L19 7.3" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (type === 'stage') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 5h10M7 12h10M7 19h6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Minimalist tips block. Collapsed it shows only the task; tapping it smoothly
// expands the ordered stages (one per line) and the done-when criterion, each
// row easing in with a small stagger.
export default function GoalTipsCard({
  tips,
  compact = false,
}: {
  tips?: string | null
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const parsed = parseGoalTips(tips)
  if (!parsed) return null

  const hasMore = parsed.stages.length > 0 || parsed.success.length > 0

  return (
    <div className="w-full text-left">
      <style>{`@keyframes tips-row-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }`}</style>

      <button
        type="button"
        onClick={() => hasMore && setOpen((o) => !o)}
        className={`flex w-full items-start gap-2.5 text-left ${hasMore ? '' : 'cursor-default'}`}
      >
        <span className="mt-[3px] shrink-0 text-cyan-300/70"><Icon type="task" /></span>
        <p className={`flex-1 ${compact ? 'text-[13px]' : 'text-[14px]'} font-medium leading-snug text-white/85`}>
          {parsed.task}
        </p>
        {hasMore && (
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"
            className="mt-1 shrink-0"
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .3s cubic-bezier(.22,1,.36,1)', color: 'rgba(255,255,255,.35)' }}
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {hasMore && (
        <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows .32s cubic-bezier(.22,1,.36,1)' }}>
          <div className="overflow-hidden">
            <div className="space-y-2 pl-[26px] pt-3">
              {parsed.stages.map((stage, i) => (
                <div
                  key={`stage-${i}`}
                  className="flex items-start gap-2.5"
                  style={{ animation: open ? `tips-row-in .34s cubic-bezier(.22,1,.36,1) ${i * 70}ms both` : 'none' }}
                >
                  <span className="mt-[3px] shrink-0 text-amber-300/60"><Icon type="stage" /></span>
                  <p className="text-[12px] leading-snug text-white/55">{stage}</p>
                </div>
              ))}

              {parsed.success && (
                <div
                  className="flex items-start gap-2.5"
                  style={{ animation: open ? `tips-row-in .34s cubic-bezier(.22,1,.36,1) ${parsed.stages.length * 70}ms both` : 'none' }}
                >
                  <span className="mt-[3px] shrink-0 text-emerald-300/70"><Icon type="success" /></span>
                  <p className="text-[12px] leading-snug text-white/55">
                    <span className="text-white/35">Done when </span>
                    {parsed.success}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
