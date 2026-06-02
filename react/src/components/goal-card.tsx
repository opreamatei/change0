import type { ReactNode } from 'react'

/*
 * GoalCard — a compact, onboarding-style card used to surface a goal inside the
 * chat surfaces (the middleware chat and the shared-journey / connection chat).
 * Mirrors the onboarding proposal card: a white icon disc, a small uppercase
 * label, a bold title, an optional description and an optional footer slot for
 * actions or status. Alignment is handled by the caller.
 */

interface GoalCardProps {
  title: string
  description?: string
  label?: string
  accent?: string
  icon?: ReactNode
  footer?: ReactNode
  onClick?: () => void
}

const SPARKLE = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
  </svg>
)

export default function GoalCard({ title, description, label = 'Goal', accent = '#fff', icon, footer, onClick }: GoalCardProps) {
  return (
    <div
      onClick={onClick}
      className={`w-full max-w-[300px] rounded-[22px] ${onClick ? 'cursor-pointer active:scale-[.99] transition-transform' : ''}`}
      style={{ background: 'linear-gradient(160deg,#1c1c1c,#0f0f0f)', border: '1px solid #2a2a2a' }}
    >
      <div className="p-4">
        <div className="mb-3 flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full" style={{ background: '#fff' }}>
            {icon ?? SPARKLE}
          </div>
          <span className="text-[10px] font-bold uppercase tracking-[1.6px]" style={{ color: accent }}>{label}</span>
        </div>
        <div className="text-[16px] font-extrabold leading-snug tracking-tight text-white">{title}</div>
        {description && <div className="mt-1.5 text-[12.5px] leading-relaxed text-white/55 line-clamp-3">{description}</div>}
        {footer && <div className="mt-3">{footer}</div>}
      </div>
    </div>
  )
}
