import { useRef, useState } from 'react'

/**
 * Peer-to-peer review surface, ported from ui-2's CollabPage ReviewsPanel.
 * Visual only for now — swipe through pending reviews, open one, leave a
 * rating + note. Submitting is stubbed (marks the item done locally).
 */

interface ReviewItem {
  id: string
  user: string
  avatarBg: string
  gradient: string
  journey: string
  desc: string
  time: string
  photos: string[]
}

const MOCK_REVIEWS: ReviewItem[] = [
  {
    id: 'mock-1',
    user: 'Jordan K.',
    avatarBg: '#10b981',
    gradient: 'linear-gradient(160deg,#052e16 0%,#064e3b 60%,#0a3a2a 100%)',
    journey: 'TypeScript Mastery',
    desc: 'Pushed through advanced generics, conditional types, and mapped types. Rebuilt a legacy codebase from scratch using strict TypeScript, removing all `any` types. Contributed two PRs to an open-source project with 4k+ stars.',
    time: '6 weeks',
    photos: ['linear-gradient(135deg,#064e3b,#0ea5e9)', 'linear-gradient(135deg,#065f46,#14b8a6)', 'linear-gradient(135deg,#047857,#6ee7b7)'],
  },
  {
    id: 'mock-2',
    user: 'Chris L.',
    avatarBg: '#f59e0b',
    gradient: 'linear-gradient(160deg,#1c0a00 0%,#431407 60%,#7c2d12 100%)',
    journey: 'Senior Developer',
    desc: 'Led the first project sprint end-to-end: daily standups, sprint planning, and code reviews for a team of 4. Introduced pair programming sessions and a PR review checklist that cut bug rate by 30%. Great communication throughout.',
    time: '2 months',
    photos: ['linear-gradient(135deg,#78350f,#f59e0b)', 'linear-gradient(135deg,#92400e,#fbbf24)', 'linear-gradient(135deg,#451a03,#d97706)'],
  },
  {
    id: 'mock-3',
    user: 'Maria C.',
    avatarBg: '#8b5cf6',
    gradient: 'linear-gradient(160deg,#1e1b4b 0%,#312e81 60%,#1e1b4b 100%)',
    journey: 'Marathon 42km',
    desc: 'Followed an 18-week build plan, logged 600+ km, and finished the full marathon under 4 hours. Stayed consistent through winter with early-morning runs and a strict recovery routine.',
    time: '18 weeks',
    photos: ['linear-gradient(135deg,#4c1d95,#7c3aed)', 'linear-gradient(135deg,#5b21b6,#a78bfa)', 'linear-gradient(135deg,#3730a3,#818cf8)'],
  },
]

export default function ReviewsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [idx, setIdx] = useState(0)
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [reviewTexts, setReviewTexts] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({})
  const [localStars, setLocalStars] = useState(0)
  const swipeStartX = useRef(0)

  const items = MOCK_REVIEWS
  const total = items.length
  const reviewingItem = reviewingId ? items.find((x) => x.id === reviewingId) : null

  const goTo = (i: number) => {
    if (reviewingId) return
    setIdx(Math.max(0, Math.min(total - 1, i)))
  }
  const handleSwipe = (e: React.TouchEvent) => {
    if (reviewingId) return
    const dx = e.changedTouches[0].clientX - swipeStartX.current
    if (Math.abs(dx) > 50) goTo(idx + (dx < 0 ? 1 : -1))
  }

  const startReview = (id: string) => { setReviewingId(id); setLocalStars(0) }
  const confirmReview = () => {
    if (localStars === 0 || !reviewingItem) return
    setSubmitted((s) => ({ ...s, [reviewingItem.id]: true }))
    setReviewingId(null)
    setLocalStars(0)
    if (idx < total - 1) setTimeout(() => setIdx((i) => i + 1), 300)
  }

  if (!open) return null

  // ── review detail ──
  if (reviewingItem) {
    const text = reviewTexts[reviewingItem.id] ?? ''
    const done = submitted[reviewingItem.id] ?? false
    return (
      <div className="fixed inset-0 z-[230] flex flex-col" style={{ background: '#000000' }}>
        <div className="flex flex-shrink-0 items-center gap-3 px-5 pt-[52px] pb-4" style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
          <button type="button" onClick={() => setReviewingId(null)}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-bold text-white">{reviewingItem.user}</div>
            <div className="truncate text-[11px]" style={{ color: 'rgba(255,255,255,.4)' }}>{reviewingItem.journey}</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar">
          <div className="relative mx-4 mt-3 overflow-hidden rounded-3xl" style={{ height: 200, background: reviewingItem.gradient }}>
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to top,rgba(0,0,0,.55) 0%,transparent 60%)' }} />
            <div className="absolute bottom-4 left-5 right-5">
              <div className="text-[22px] font-extrabold tracking-tight text-white">{reviewingItem.journey}</div>
              <div className="mt-1 text-[12px]" style={{ color: 'rgba(255,255,255,.55)' }}>{reviewingItem.time}</div>
            </div>
          </div>

          <div className="px-5 pt-5 pb-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.3)' }}>Description</div>
            <div className="text-[14px] leading-[1.65]" style={{ color: 'rgba(255,255,255,.7)' }}>{reviewingItem.desc}</div>
          </div>

          <div className="px-5 pb-5">
            <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.3)' }}>Proof</div>
            <div className="flex gap-2.5">
              {reviewingItem.photos.map((g, pi) => (
                <div key={pi} className="relative flex-1 overflow-hidden rounded-2xl" style={{ height: 90, background: g }}>
                  <div className="absolute inset-0 flex items-center justify-center" style={{ color: 'rgba(255,255,255,.35)' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="px-5 pb-5">
            <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.3)' }}>Your review</div>
            {done ? (
              <div className="rounded-2xl p-4 text-[14px] font-medium" style={{ background: 'rgba(52,199,89,.08)', border: '1px solid rgba(52,199,89,.2)', color: 'rgba(52,199,89,.9)' }}>
                ✓ Review submitted
              </div>
            ) : (
              <textarea
                value={text}
                onChange={(e) => setReviewTexts((t) => ({ ...t, [reviewingItem.id]: e.target.value }))}
                placeholder="Share your thoughts on their progress, effort, and achievement…"
                rows={4}
                className="w-full resize-none rounded-2xl px-4 py-3.5 text-[14px] leading-[1.6] outline-none"
                style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'rgba(255,255,255,.85)', caretColor: 'white' }}
              />
            )}
          </div>

          {!done && (
            <div className="px-5 pb-7">
              <div className="mb-3 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.3)' }}>Rating</div>
              <div className="flex gap-3">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n} onClick={() => setLocalStars(n)}
                    className="cursor-pointer select-none text-[36px] transition-all active:scale-90"
                    style={{ filter: n <= localStars ? 'grayscale(0) brightness(1)' : 'grayscale(1) brightness(.38)' }}>
                    ⭐
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {!done && (
          <div className="flex-shrink-0 px-5 pt-3 pb-10" style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}>
            <button type="button" onClick={confirmReview}
              className="w-full rounded-2xl py-[18px] text-[16px] font-bold tracking-tight transition-opacity active:opacity-80"
              style={{ background: '#fff', color: '#000', opacity: localStars > 0 ? 1 : 0.35 }}>
              Submit review →
            </button>
          </div>
        )}
      </div>
    )
  }

  // ── preview ──
  return (
    <div className="fixed inset-0 z-[230] flex flex-col" style={{ background: '#000000' }}>
      <div className="flex flex-shrink-0 items-center justify-between px-5 pt-[52px] pb-4">
        <button type="button" onClick={onClose}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="text-center">
          <div className="text-[17px] font-bold tracking-tight text-white">Reviews</div>
          <div className="text-[11px]" style={{ color: 'rgba(255,255,255,.35)' }}>
            {total === 0 ? 'No reviews' : `${idx + 1} of ${total}`}
          </div>
        </div>
        <div className="flex min-w-[52px] items-center justify-end gap-1.5">
          {items.map((_, i) => (
            <div key={i} onClick={() => goTo(i)} className="cursor-pointer rounded-full transition-all"
              style={{ width: i === idx ? 16 : 6, height: 6, background: i === idx ? '#fff' : 'rgba(255,255,255,.25)' }} />
          ))}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden"
        onTouchStart={(e) => { swipeStartX.current = e.touches[0].clientX }}
        onTouchEnd={handleSwipe}>
        {items.map((item, i) => (
          <div key={item.id} className="absolute inset-0 flex flex-col px-4 pt-2 pb-6"
            style={{ transform: `translateX(${(i - idx) * 100}%)`, transition: 'transform .32s cubic-bezier(.32,1,.54,1)' }}>
            <div className="relative flex-shrink-0 overflow-hidden rounded-3xl" style={{ height: '52%', background: item.gradient }}>
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to top,rgba(0,0,0,.6) 0%,transparent 55%)' }} />
              <div className="absolute bottom-5 left-5 right-5">
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[11px] font-bold"
                  style={{ background: 'rgba(255,200,50,.15)', color: 'rgba(255,200,50,.9)', border: '1px solid rgba(255,200,50,.25)' }}>
                  Awaiting your review
                </div>
                <div className="text-[26px] font-extrabold leading-tight tracking-tight text-white">{item.journey}</div>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-5 pb-3">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white" style={{ background: item.avatarBg }}>
                {item.user[0]}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[16px] font-bold text-white">{item.user}</div>
                <div className="text-[12px]" style={{ color: 'rgba(255,255,255,.4)' }}>{item.time}</div>
              </div>
            </div>

            <div className="mb-auto text-[14px] leading-[1.6]"
              style={{ color: 'rgba(255,255,255,.55)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as never, overflow: 'hidden' }}>
              {item.desc}
            </div>

            <button type="button" onClick={() => startReview(item.id)}
              className="mt-6 w-full rounded-2xl bg-white py-[18px] text-[16px] font-bold tracking-tight text-black active:opacity-85">
              Review →
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
