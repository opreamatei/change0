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

// Minimalist tips block. Collapsed it shows only the task (one line) to keep the
// surrounding UI calm; tapping it reveals the ordered stages and the done-when
// criterion. Order is meaningful and each row keeps its matching icon.
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
            className="mt-1 shrink-0 transition-transform"
            style={{ transform: open ? 'rotate(180deg)' : 'none', color: 'rgba(255,255,255,.35)' }}
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {open && hasMore && (
        <div className="mt-3 space-y-2.5 pl-[26px]">
          {parsed.stages.length > 0 && (
            <div className="flex items-start gap-2.5">
              <span className="mt-[3px] shrink-0 text-amber-300/60"><Icon type="stage" /></span>
              <p className="text-[12px] leading-relaxed text-white/55">
                {parsed.stages.map((stage, i) => (
                  <span key={`${stage}-${i}`}>
                    {i > 0 && <span className="text-white/25"> · </span>}
                    {stage}
                  </span>
                ))}
              </p>
            </div>
          )}

          {parsed.success && (
            <div className="flex items-start gap-2.5">
              <span className="mt-[3px] shrink-0 text-emerald-300/70"><Icon type="success" /></span>
              <p className="text-[12px] leading-relaxed text-white/55">
                <span className="text-white/35">Done when </span>
                {parsed.success}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
