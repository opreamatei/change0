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

export default function GoalTipsCard({
  tips,
  compact = false,
}: {
  tips?: string | null
  compact?: boolean
}) {
  const parsed = parseGoalTips(tips)
  if (!parsed) return null

  return (
    <section
      className={`w-full rounded-2xl border ${compact ? 'p-3.5' : 'p-4'}`}
      style={{
        background: 'linear-gradient(145deg, rgba(12,18,17,.92), rgba(18,15,10,.88))',
        borderColor: 'rgba(255,255,255,.10)',
        boxShadow: compact ? 'none' : '0 18px 50px rgba(0,0,0,.28)',
      }}
    >
      {parsed.task && (
        <div className="flex gap-3">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-300/12 text-cyan-200">
            <Icon type="task" />
          </div>
          <div className="min-w-0 text-left">
            <div className="text-[10px] font-bold uppercase tracking-[.16em] text-cyan-100/45">Task</div>
            <div className={`${compact ? 'text-[13px]' : 'text-[14px]'} mt-0.5 font-semibold leading-snug text-white/88`}>
              {parsed.task}
            </div>
          </div>
        </div>
      )}

      {parsed.success && (
        <div className={`${parsed.task ? 'mt-3' : ''} flex gap-3`}>
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-300/12 text-emerald-200">
            <Icon type="success" />
          </div>
          <div className="min-w-0 text-left">
            <div className="text-[10px] font-bold uppercase tracking-[.16em] text-emerald-100/45">Done when</div>
            <div className={`${compact ? 'text-[12.5px]' : 'text-[13.5px]'} mt-0.5 leading-snug text-white/68`}>
              {parsed.success}
            </div>
          </div>
        </div>
      )}

      {parsed.stages.length > 0 && (
        <div className={`${parsed.task || parsed.success ? 'mt-3' : ''} flex flex-wrap gap-1.5`}>
          {parsed.stages.map((stage, i) => (
            <span
              key={`${stage}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold text-amber-50/74"
              style={{ background: 'rgba(251,191,36,.08)', borderColor: 'rgba(251,191,36,.16)' }}
            >
              {i === 0 && <Icon type="stage" />}
              {stage}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
