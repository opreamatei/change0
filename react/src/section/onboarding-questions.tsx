import { useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'

/*
 * OnboardingQuestions — a short, tappable form that replaces the clarify chat.
 * The backend (POST /onboarding/questions) writes a few personalized clarifying
 * questions for the chosen goal and extracts them into a structured list; each is
 * either a free-text answer or a small set of choice options (the text field is
 * always there too — options + free).
 *
 * Ultra-minimal: centred title, vibrant option chips, a bare input, and a single
 * Skip/Continue button that changes once the user answers.
 */

interface Question {
  prompt: string
  type: 'free' | 'choice'
  options: string[]
}

interface OnboardingQuestionsProps {
  goalTitle: string
  scope: string
  onDone: (answers: string) => void
  onSkip: () => void
}

export default function OnboardingQuestions({ goalTitle, scope, onDone, onSkip }: OnboardingQuestionsProps) {
  const [questions, setQuestions] = useState<Question[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [idx, setIdx] = useState(0)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchedRef = useRef(false)

  /* Fetch the structured questions once (guard StrictMode's double-invoke). */
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true

    void (async () => {
      try {
        const res = await fetch(SERVER_ENDPOINTS.onboardingQuestions, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goalTitle, scope }),
        })
        if (!res.ok) throw new Error(`questions ${res.status}`)
        const data = (await res.json()) as { questions?: Question[] }
        const list = (data.questions ?? []).filter((q) => q && q.prompt)
        if (list.length === 0) { onSkip(); return }
        setQuestions(list)
        setAnswers(new Array(list.length).fill(''))
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const current = questions[idx]
  const isLast = idx === questions.length - 1
  const hasAnswer = input.trim().length > 0
  const actionLabel = hasAnswer ? (isLast ? 'Create my journey' : 'Continue') : 'Skip'

  /* Continue: record the (possibly empty) answer and advance; empty = skip. */
  function next() {
    const answer = input.trim()
    const updated = [...answers]
    updated[idx] = answer
    setAnswers(updated)

    if (isLast) {
      const block = questions
        .map((q, i) => ({ prompt: q.prompt, ans: updated[i].trim() }))
        .filter((x) => x.ans.length > 0)
        .map((x) => `- ${x.prompt} ${x.ans}`)
        .join(' ')
      onDone(block ? `The user answered a few scoping questions: ${block}` : '')
    } else {
      setIdx(idx + 1)
      setInput('')
    }
  }

  if (loading) {
    return (
      <Shell goalTitle={goalTitle}>
        <div className="flex flex-1 items-center justify-center text-[14px]" style={{ color: 'rgba(255,255,255,.45)' }}>
          Preparing a few questions…
        </div>
      </Shell>
    )
  }

  if (error || !current) {
    return (
      <Shell goalTitle={goalTitle}>
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
          <div className="text-[14px]" style={{ color: 'rgba(255,255,255,.45)' }}>
            Couldn&apos;t load the questions.
          </div>
          <button type="button" onClick={onSkip}
            className="rounded-full px-7 py-3.5 text-[15px] font-bold active:scale-95 transition-transform"
            style={{ background: '#fff', color: '#000' }}>
            Skip
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell goalTitle={goalTitle}>
      <style>{`
        @keyframes obq-in {
          from { opacity: 0; transform: translateY(28px) scale(.94); filter: blur(8px); }
          to   { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
        }
        @keyframes obq-label-in {
          from { opacity: 0; transform: translateY(16px) scale(.96); filter: blur(5px); }
          to   { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
        }
        @keyframes obq-sheen {
          from { transform: translateX(-140%) skewX(-18deg); opacity: 0; }
          25%  { opacity: .55; }
          to   { transform: translateX(160%) skewX(-18deg); opacity: 0; }
        }
      `}</style>
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div key={idx} className="flex w-full flex-col items-center"
          style={{ animation: 'obq-in .55s cubic-bezier(.22,1,.36,1)' }}>
          <div className="text-[24px] font-extrabold leading-snug tracking-tight text-white text-center pb-8 max-w-[320px]">
            {current.prompt}
          </div>

          {current.type === 'choice' && current.options.length > 0 && (
            <div className="flex flex-col gap-3 w-full max-w-[340px] pb-8">
              {current.options.map((opt, i) => {
                const selected = input.trim() === opt
                return (
                  <button key={i} type="button" onClick={() => setInput(opt)}
                    className="w-full rounded-full px-6 py-4 text-[16px] font-bold active:scale-[.98] transition-all"
                    style={selected
                      ? { background: '#fff', color: '#000', border: '1.5px solid #fff' }
                      : { background: 'transparent', color: '#fff', border: '1.5px solid rgba(255,255,255,.4)' }}>
                    {opt}
                  </button>
                )
              })}
            </div>
          )}

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next() } }}
            placeholder="Type your answer…"
            className="w-full max-w-[320px] bg-transparent text-center text-[16px] text-white outline-none pb-2.5"
            style={{ borderBottom: '1px solid rgba(255,255,255,.18)' }}
          />
        </div>
      </div>

      <div className="flex-shrink-0 px-8 pt-4 pb-10 flex justify-center">
        <button type="button" onClick={next}
          className="relative w-full max-w-[340px] overflow-hidden rounded-full py-5 text-[17px] font-bold active:scale-95 transition-all duration-500"
          style={hasAnswer
            ? { background: '#fff', color: '#000', boxShadow: '0 18px 44px rgba(255,255,255,.18)' }
            : { background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.66)', border: '1px solid rgba(255,255,255,.16)' }}>
          {hasAnswer && (
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1/2 bg-white/60"
              style={{ animation: 'obq-sheen .85s cubic-bezier(.22,1,.36,1)' }} />
          )}
          <span key={actionLabel} className="relative block" style={{ animation: 'obq-label-in .34s cubic-bezier(.22,1,.36,1)' }}>
            {actionLabel}
          </span>
        </button>
      </div>
    </Shell>
  )
}

/* Shared frame: a centred title, no skip — Continue alone carries the flow. */
function Shell({ goalTitle, children }: { goalTitle: string; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-[310] flex flex-col" style={{ background: '#0a0a0a' }}>
      <div className="flex flex-col items-center px-6 pt-[56px] pb-2 flex-shrink-0 text-center">
        <div className="text-[22px] font-extrabold tracking-tight text-white">A few quick questions</div>
        <div className="truncate max-w-[80%] text-[12px]" style={{ color: 'rgba(255,255,255,.38)' }}>{goalTitle}</div>
      </div>
      {children}
    </div>
  )
}
