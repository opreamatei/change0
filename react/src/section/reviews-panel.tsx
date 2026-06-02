import { useCallback, useEffect, useRef, useState } from 'react'
import { CENTRAL_ENDPOINTS } from '../config/server'

interface SubmissionItem {
  id: string
  ai_label: string
  ai_description: string
  user_description: string
  file_count: number
  files: string[]
  submitted_at: number
}

interface ReviewsPanelProps {
  open: boolean
  onClose: () => void
  userId: string
  userLabel?: string
}

export default function ReviewsPanel({ open, onClose, userId, userLabel = '' }: ReviewsPanelProps) {
  const [items, setItems] = useState<SubmissionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [idx, setIdx] = useState(0)
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [localStars, setLocalStars] = useState(0)
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({})
  const [dailyLimitHit, setDailyLimitHit] = useState(false)
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)
  const swipeStartX = useRef(0)

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    try {
      const r = await fetch(CENTRAL_ENDPOINTS.submissionsPending(userId, userLabel), { cache: 'no-store' })
      if (!r.ok) return
      const data = await r.json() as { ok: boolean; submissions: SubmissionItem[] }
      if (data.ok) {
        setItems(data.submissions.filter((s) => !submitted[s.id]))
        setIdx(0)
      }
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [userId, userLabel, submitted])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

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

  const startReview = (id: string) => { setReviewingId(id); setLocalStars(0); setZoomUrl(null) }

  const confirmReview = async () => {
    if (localStars === 0 || !reviewingItem) return
    try {
      const r = await fetch(CENTRAL_ENDPOINTS.submissionReview(reviewingItem.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewer_id: userId, score: localStars }),
      })
      const data = await r.json() as { ok: boolean; error?: string }
      if (!r.ok && data.error === 'daily_limit') {
        setDailyLimitHit(true)
        setReviewingId(null)
        return
      }
      setSubmitted((s) => ({ ...s, [reviewingItem.id]: true }))
      setItems((prev) => prev.filter((x) => x.id !== reviewingItem.id))
      setReviewingId(null)
      setLocalStars(0)
    } catch { /* ignore */ }
  }

  if (!open) return null

  // ── daily limit notice ──
  if (dailyLimitHit) {
    return (
      <div className="fixed inset-0 z-[230] flex flex-col items-center justify-center px-8 text-center" style={{ background: '#000000' }}>
        <div className="text-[48px] mb-4">🕐</div>
        <div className="text-[20px] font-bold text-white mb-2">That's enough for today</div>
        <div className="text-[14px] leading-[1.6]" style={{ color: 'rgba(255,255,255,.45)' }}>
          You've reviewed {3} goals today. Come back tomorrow for more.
        </div>
        <button type="button" onClick={onClose}
          className="mt-8 px-6 py-3 rounded-2xl text-[15px] font-bold text-black bg-white">
          Got it
        </button>
      </div>
    )
  }

  // ── review detail ──
  if (reviewingItem) {
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
            <div className="truncate text-[16px] font-bold text-white">Anonymous Work</div>
            <div className="truncate text-[11px]" style={{ color: 'rgba(255,255,255,.4)' }}>{reviewingItem.ai_label.trim() || 'Shared goal'}</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar">
          <div className="mx-4 mt-3 overflow-hidden rounded-3xl p-5" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)' }}>
            <div className="mb-1 inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[11px] font-bold"
              style={{ background: 'rgba(255,200,50,.1)', color: 'rgba(255,200,50,.9)', border: '1px solid rgba(255,200,50,.2)' }}>
              {reviewingItem.ai_label.trim() || 'Shared goal'}
            </div>
            <div className="mb-1 mt-3 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.3)' }}>AI summary</div>
            <div className="text-[14px] leading-[1.65]" style={{ color: 'rgba(255,255,255,.7)' }}>
              {reviewingItem.ai_description}
            </div>
            {reviewingItem.user_description?.trim() && (
              <>
                <div className="mb-1 mt-4 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,200,50,.55)' }}>In their words</div>
                <div className="text-[14px] leading-[1.65] whitespace-pre-wrap" style={{ color: 'rgba(255,255,255,.82)' }}>
                  {reviewingItem.user_description}
                </div>
              </>
            )}
          </div>

          {reviewingItem.file_count > 0 && (
            <div className="px-5 pt-5 pb-3">
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.3)' }}>Proof — tap an image to zoom</div>
              <div className="grid grid-cols-3 gap-2.5">
                {reviewingItem.files.map((fname, pi) => {
                  const url = CENTRAL_ENDPOINTS.submissionFile(reviewingItem.id, fname)
                  const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(fname)
                  return (
                    <div key={pi} className="relative overflow-hidden rounded-2xl" style={{ height: 90, background: 'rgba(255,255,255,.05)' }}>
                      {isImage ? (
                        <button type="button" onClick={() => setZoomUrl(url)}
                          className="absolute inset-0 h-full w-full cursor-zoom-in active:opacity-80">
                          <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />
                        </button>
                      ) : (
                        <a href={url} target="_blank" rel="noreferrer" className="absolute inset-0 flex items-center justify-center flex-col gap-1" style={{ color: 'rgba(255,255,255,.5)' }}>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span className="text-[9px]">{fname.split('.').pop()?.toUpperCase()}</span>
                        </a>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!done && (
            <div className="px-5 pt-5 pb-7">
              <div className="mb-3 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.3)' }}>Rate authenticity</div>
              <div className="flex gap-3">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n} onClick={() => setLocalStars(n)}
                    className="cursor-pointer select-none text-[36px] transition-all active:scale-90"
                    style={{ filter: n <= localStars ? 'grayscale(0) brightness(1)' : 'grayscale(1) brightness(.38)' }}>
                    ⭐
                  </span>
                ))}
              </div>
              <div className="mt-2 text-[11px]" style={{ color: 'rgba(255,255,255,.3)' }}>
                {localStars >= 4 ? '4–5 stars marks this work as authentic' : 'Below 4 stars — work will not be marked authentic'}
              </div>
            </div>
          )}

          {done && (
            <div className="mx-5 mt-5 rounded-2xl p-4 text-[14px] font-medium" style={{ background: 'rgba(52,199,89,.08)', border: '1px solid rgba(52,199,89,.2)', color: 'rgba(52,199,89,.9)' }}>
              ✓ Review submitted
            </div>
          )}
        </div>

        {!done && (
          <div className="flex-shrink-0 px-5 pt-3 pb-10" style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}>
            <button type="button" onClick={() => void confirmReview()}
              className="w-full rounded-2xl py-[18px] text-[16px] font-bold tracking-tight transition-opacity active:opacity-80"
              style={{ background: '#fff', color: '#000', opacity: localStars > 0 ? 1 : 0.35 }}>
              Submit review →
            </button>
          </div>
        )}

        {zoomUrl && (
          <div className="fixed inset-0 z-[240] flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,.92)' }}
            onClick={() => setZoomUrl(null)}>
            <img src={zoomUrl} alt="" className="max-h-full max-w-full object-contain"
              onClick={(e) => e.stopPropagation()} />
            <button type="button" onClick={() => setZoomUrl(null)}
              className="absolute right-4 top-[52px] flex h-10 w-10 items-center justify-center rounded-full"
              style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.15)', color: '#fff' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
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
            {loading ? 'Loading…' : total === 0 ? 'No pending reviews' : `${idx + 1} of ${total}`}
          </div>
        </div>
        <div className="flex min-w-[52px] items-center justify-end gap-1.5">
          {items.map((_, i) => (
            <div key={i} onClick={() => goTo(i)} className="cursor-pointer rounded-full transition-all"
              style={{ width: i === idx ? 16 : 6, height: 6, background: i === idx ? '#fff' : 'rgba(255,255,255,.25)' }} />
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex-1 flex items-center justify-center text-[14px]" style={{ color: 'rgba(255,255,255,.35)' }}>
          Loading…
        </div>
      )}

      {!loading && total === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center px-8 text-center gap-3">
          <div className="text-[40px]">✨</div>
          <div className="text-[16px] font-bold text-white">All caught up</div>
          <div className="text-[13px] leading-[1.6]" style={{ color: 'rgba(255,255,255,.4)' }}>
            No work awaiting your review right now. Check back later.
          </div>
        </div>
      )}

      {!loading && total > 0 && (
        <div className="relative flex-1 overflow-hidden"
          onTouchStart={(e) => { swipeStartX.current = e.touches[0].clientX }}
          onTouchEnd={handleSwipe}>
          {items.map((item, i) => (
            <div key={item.id} className="absolute inset-0 flex flex-col px-4 pt-2 pb-6"
              style={{ transform: `translateX(${(i - idx) * 100}%)`, transition: 'transform .32s cubic-bezier(.32,1,.54,1)' }}>
              <div className="relative flex-shrink-0 overflow-hidden rounded-3xl flex flex-col justify-end px-5 pb-5"
                style={{ height: '48%', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)' }}>
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[11px] font-bold self-start"
                  style={{ background: 'rgba(255,200,50,.15)', color: 'rgba(255,200,50,.9)', border: '1px solid rgba(255,200,50,.25)' }}>
                  {item.ai_label.trim() || 'Shared goal'}
                </div>
                <div className="text-[13px] leading-[1.55]" style={{ color: 'rgba(255,255,255,.6)', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' as never, overflow: 'hidden' }}>
                  {item.ai_description}
                </div>
              </div>

              <div className="flex items-center gap-2 pt-4 pb-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white"
                  style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.1)' }}>
                  ?
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-bold text-white">Anonymous Work</div>
                  <div className="text-[12px]" style={{ color: 'rgba(255,255,255,.4)' }}>
                    {item.file_count > 0 ? `${item.file_count} attachment${item.file_count > 1 ? 's' : ''}` : 'No attachments'}
                  </div>
                </div>
              </div>

              <button type="button" onClick={() => startReview(item.id)}
                className="mt-auto w-full rounded-2xl bg-white py-[18px] text-[16px] font-bold tracking-tight text-black active:opacity-85">
                Review →
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
