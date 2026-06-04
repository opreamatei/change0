import { useEffect, useRef } from 'react'

/**
 * Horizontal paging deck — swipe (touch) or drag (mouse) left/right between
 * full-width slides, with edge rubber-banding and a threshold-based commit.
 * Mirrors the journey-paging interaction from ui-2's JourneyPage.
 *
 * The deck owns only the horizontal axis; slide content (e.g. PathCanvas) keeps
 * its own vertical interaction. Axis-locking ensures vertical gestures inside a
 * slide are never hijacked into a page change.
 */
export function SwipeDeck({
  count,
  index,
  onIndexChange,
  renderSlide,
  className,
}: {
  count: number
  index: number
  onIndexChange: (idx: number) => void
  renderSlide: (i: number) => React.ReactNode
  className?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(false)
  const swipe = useRef({ sx: 0, sy: 0, delta: 0, axis: '' as '' | 'x' | 'y', active: false, md: false })

  const clampIdx = (i: number) => Math.max(0, Math.min(count - 1, i))

  const applyTransform = (px: number, animate: boolean) => {
    const el = trackRef.current
    if (!el) return
    el.style.transition = animate ? 'transform .38s cubic-bezier(.4,0,.2,1)' : 'none'
    el.style.transform = `translateX(calc(${-index * 100}% + ${px}px))`
  }

  const goTo = (i: number) => {
    const n = clampIdx(i)
    const el = trackRef.current
    if (el) {
      el.style.transition = 'transform .38s cubic-bezier(.4,0,.2,1)'
      el.style.transform = `translateX(${-n * 100}%)`
    }
    if (n !== index) onIndexChange(n)
  }

  // Keep the track aligned when index changes externally (e.g. dots / programmatic).
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    el.style.transition = mountedRef.current ? 'transform .38s cubic-bezier(.4,0,.2,1)' : 'none'
    el.style.transform = `translateX(${-index * 100}%)`
    mountedRef.current = true
  }, [index])

  const dragFollow = (dx: number) => {
    const atEdge = (index === 0 && dx > 0) || (index === count - 1 && dx < 0)
    applyTransform(dx * (atEdge ? 0.22 : 1), false)
  }

  const commit = (delta: number, thrRatio: number) => {
    const thr = window.innerWidth * thrRatio
    if (delta < -thr) goTo(index + 1)
    else if (delta > thr) goTo(index - 1)
    else goTo(index)
  }

  const onTouchStart = (e: React.TouchEvent) => {
    const s = swipe.current
    s.sx = e.touches[0].clientX
    s.sy = e.touches[0].clientY
    s.delta = 0
    s.axis = ''
    s.active = true
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current
    if (!s.active) return
    const dx = e.touches[0].clientX - s.sx
    const dy = e.touches[0].clientY - s.sy
    if (!s.axis) {
      if (Math.abs(dx) > Math.abs(dy) + 6) s.axis = 'x'
      else if (Math.abs(dy) > Math.abs(dx) + 6) s.axis = 'y'
    }
    if (s.axis === 'x') {
      s.delta = dx
      dragFollow(dx)
    }
  }
  const onTouchEnd = () => {
    const s = swipe.current
    const wasX = s.active && s.axis === 'x'
    s.active = false
    s.axis = ''
    if (!wasX) { s.delta = 0; return }
    commit(s.delta, 0.2)
    s.delta = 0
  }

  const onMouseDown = (e: React.MouseEvent) => {
    const s = swipe.current
    s.md = true
    s.sx = e.clientX
    s.delta = 0
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const s = swipe.current
      if (!s.md) return
      s.delta = e.clientX - s.sx
      dragFollow(s.delta)
    }
    const onUp = () => {
      const s = swipe.current
      if (!s.md) return
      s.md = false
      commit(s.delta, 0.18)
      s.delta = 0
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, count])

  return (
    <div
      className={`relative flex-1 overflow-hidden select-none ${className ?? ''}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onMouseDown={onMouseDown}
    >
      <div ref={trackRef} className="flex h-full" style={{ willChange: 'transform' }}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="min-w-full h-full overflow-hidden">
            {renderSlide(i)}
          </div>
        ))}
      </div>
    </div>
  )
}
