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

const QUESTION_LOADING_LINES = [
  'Getting to know you better...',
  'Looking for the part that makes this actually stick...',
  'What am I even saying here?',
  'Checkign where your abilities can shine!',
  'Pushing this as far as possible...',
  'Tuning the question machine. Very scientific. Kind of.',
  'Finding the door that does not look like a door...',
]

function shuffledLoadingLines(): string[] {
  const lines = [...QUESTION_LOADING_LINES]
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = lines[i]
    lines[i] = lines[j]
    lines[j] = tmp
  }
  return lines
}

export default function OnboardingQuestions({ goalTitle, scope, onDone, onSkip }: OnboardingQuestionsProps) {
  const [questions, setQuestions] = useState<Question[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [idx, setIdx] = useState(0)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [loadingLines] = useState(shuffledLoadingLines)
  const [loadingLineIdx, setLoadingLineIdx] = useState(0)

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

  useEffect(() => {
    if (!loading) return
    const id = setInterval(() => {
      setLoadingLineIdx((i) => (i + 1) % loadingLines.length)
    }, 1650)
    return () => clearInterval(id)
  }, [loading, loadingLines.length])

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
        <LoadingQuestionsScreen line={loadingLines[loadingLineIdx] ?? QUESTION_LOADING_LINES[0]} />
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
    <Shell goalTitle={goalTitle} counter={`${idx + 1} / ${questions.length}`}>
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

function LoadingQuestionsScreen({ line }: { line: string }) {
  return (
    <>
      <style>{`
        @keyframes obq-load-core {
          0%, 100% { transform: scale(.92); opacity: .62; }
          50% { transform: scale(1.04); opacity: 1; }
        }
        @keyframes obq-load-ring {
          0% { transform: scale(.72); opacity: .36; }
          100% { transform: scale(1.75); opacity: 0; }
        }
        @keyframes obq-load-dot {
          0%, 100% { transform: translateY(0); opacity: .28; }
          50% { transform: translateY(-7px); opacity: .95; }
        }
        @keyframes obq-load-copy {
          from { opacity: 0; transform: translateY(8px); filter: blur(5px); }
          to { opacity: 1; transform: translateY(0); filter: blur(0); }
        }
      `}</style>
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div className="relative mb-9 flex h-24 w-24 items-center justify-center">
          <span className="absolute h-16 w-16 rounded-full" style={{ border: '1px solid rgba(255,255,255,.16)', animation: 'obq-load-ring 2s ease-out infinite' }} />
          <span className="absolute h-16 w-16 rounded-full" style={{ border: '1px solid rgba(255,255,255,.12)', animation: 'obq-load-ring 2s ease-out .7s infinite' }} />
          <div className="relative flex h-14 w-14 items-center justify-center rounded-full"
            style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.13)', animation: 'obq-load-core 2.2s ease-in-out infinite' }}>
            <div className="flex items-end gap-1.5">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-2 w-2 rounded-full bg-white"
                  style={{ animation: `obq-load-dot .95s ease-in-out ${i * 0.16}s infinite` }} />
              ))}
            </div>
          </div>
        </div>
        <div key={line} className="max-w-[310px] text-[22px] font-extrabold leading-snug tracking-tight text-white"
          style={{ animation: 'obq-load-copy .42s cubic-bezier(.22,1,.36,1)' }}>
          {line}
        </div>
      </div>
    </>
  )
}

/* Shared frame: a centred title, no skip — Continue alone carries the flow. */
function Shell({ goalTitle, counter, children }: { goalTitle: string; counter?: string; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-[310] flex flex-col" style={{ background: '#0a0a0a' }}>
      <div className="flex flex-col items-center px-6 pt-[56px] pb-2 flex-shrink-0 text-center">
        {counter && (
          <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.2em] text-white/35 tabular-nums">{counter}</div>
        )}
        <div className="text-[22px] font-extrabold tracking-tight text-white">A few quick questions</div>
        <div className="truncate max-w-[80%] text-[12px]" style={{ color: 'rgba(255,255,255,.38)' }}>{goalTitle}</div>
      </div>
      {children}
    </div>
  )
}
