import { useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'
import {
  Goal,
  startGoalOnServer,
  endGoalOnServer,
  cancelGoalOnServer,
} from '../goal'

/**
 * Focus session for a JOURNAL-type goal. Mirrors the timer FocusSession shell
 * (full-screen, dark) but the work surface is a journal editor instead of a
 * countdown ring — a journal step is completed by writing an entry, not by
 * spending time. A small elapsed bar at the bottom keeps the soft time
 * reference the goal carries.
 *
 * Lifecycle:
 *  - On open we ensure the goal is started server-side; starting a journal goal
 *    creates a draft journal entry and returns its id (attach_id). We edit that
 *    exact entry. If the goal was already started (e.g. reopened after leaving),
 *    we reuse the existing attach_id and load its current text.
 *  - Submit saves the entry (dropping the "(draft)" title suffix) and ends the
 *    goal with the entry id as proof of completion.
 *  - Closing without submitting cancels the goal (back to idle) but keeps the
 *    draft entry around to revisit.
 */

const MOODS = ['😊', '😌', '🏃', '📚', '🎯', '😔', '🔥', '😴', '🤔', '❤️', '🎉', '💪']
const DRAFT_SUFFIX = ' (draft)'

function stripDraft(title: string): string {
  return title.endsWith(DRAFT_SUFFIX) ? title.slice(0, -DRAFT_SUFFIX.length) : title
}

function fmtClock(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

interface JournalEntryResponse {
  ok: boolean
  meta: { title: string; mood_index: number }
  text: string
}

function buildJournalEntryUrl(entryId: string): string {
  const params = new URLSearchParams({ id: entryId })
  return `${SERVER_ENDPOINTS.journalEntry}?${params.toString()}`
}

type Phase = 'loading' | 'edit' | 'celebrate' | 'exit'

export default function JournalFocusSession({
  goal,
  onClose,
  onCompleted,
}: {
  goal: Goal
  onClose: () => void
  /** Called after a successful submit or a cancel, so the caller can refresh. */
  onCompleted: () => void
}) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [title, setTitle] = useState(stripDraft(goal.title))
  const [text, setText] = useState('')
  const [mood, setMood] = useState<string | null>(null)
  const [attachId, setAttachId] = useState(goal.attachId || '')
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submittedRef = useRef(false)
  const initRef = useRef(false)

  const softLimit = goal.requiredTime > 0 ? goal.requiredTime : 0

  // Resolve the journal entry to edit: start the goal (creating a draft) when
  // it is not yet underway, otherwise reuse and load the existing draft.
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    let cancelled = false
    ;(async () => {
      try {
        let id = goal.attachId || ''
        if (!goal.startDate || !id) {
          const res = await startGoalOnServer(goal)
          id = res.attach_id || ''
        }
        if (!id) {
          if (!cancelled) { setError('Could not open this journal step.'); setPhase('edit') }
          return
        }
        if (!cancelled) setAttachId(id)

        // Load any text already written into this draft.
        try {
          const r = await fetch(buildJournalEntryUrl(id), { cache: 'no-store' })
          const d = (await r.json()) as JournalEntryResponse
          if (!cancelled && d.ok) {
            if (d.text) setText(d.text)
            if (d.meta?.title) setTitle(stripDraft(d.meta.title))
            if (typeof d.meta?.mood_index === 'number' && d.meta.mood_index >= 0 && d.meta.mood_index < MOODS.length)
              setMood(MOODS[d.meta.mood_index])
          }
        } catch {
          /* a fresh draft has no body yet — fine */
        }
        if (!cancelled) setPhase('edit')
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setPhase('edit') }
      }
    })()

    return () => { cancelled = true }
  }, [goal])

  // Elapsed counter — soft reference only, never blocks submission.
  useEffect(() => {
    if (phase !== 'edit') return
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const exitOut = (after: () => void) => {
    setPhase('exit')
    closeTimer.current = setTimeout(after, 320)
  }

  async function submit() {
    if (busy || !attachId) return
    setBusy(true)
    setError(null)
    try {
      const trimmedTitle = title.trim() || stripDraft(goal.title) || 'Journal'
      await fetch(SERVER_ENDPOINTS.journalUpdate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: attachId,
          title: trimmedTitle,
          text: text.trim(),
          mood_index: mood ? MOODS.indexOf(mood) : -1,
        }),
      })
      await endGoalOnServer(goal, attachId)
      submittedRef.current = true
      setPhase('celebrate')
      closeTimer.current = setTimeout(() => {
        onCompleted()
        exitOut(onClose)
      }, 1000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function abandon() {
    if (busy) return
    setBusy(true)
    try {
      await cancelGoalOnServer(goal)
    } catch {
      /* even if cancel fails, leave the editor — the goal simply stays started */
    }
    onCompleted()
    exitOut(onClose)
  }

  const overLimit = softLimit > 0 && elapsed > softLimit
  const limitLabel = softLimit > 0 ? `${fmtClock(Math.min(elapsed, softLimit))} / ${fmtClock(softLimit)}` : fmtClock(elapsed)

  return (
    <div
      className={`fixed inset-0 z-[210] flex flex-col ${phase === 'exit' ? 'focus-page-out' : 'focus-page-in'}`}
      style={{ background: '#0a0a0a' }}
    >
      {/* header */}
      <div
        className="flex flex-shrink-0 items-center justify-between px-4 pb-3 pt-[52px]"
        style={{ borderBottom: '1px solid #2a2a2a' }}
      >
        <button
          type="button"
          onClick={() => void abandon()}
          disabled={busy}
          className="flex items-center gap-1.5 text-[15px] font-medium disabled:opacity-40"
          style={{ color: 'rgba(255,255,255,.65)' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Leave
        </button>

        <div className="flex items-center gap-3">
          {error && <span className="text-[12px]" style={{ color: 'rgba(239,68,68,.85)' }}>{error}</span>}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || phase !== 'edit' || !attachId}
            className="rounded-full px-5 py-2 text-[14px] font-bold text-white"
            style={{ background: '#34c759', opacity: busy || phase !== 'edit' || !attachId ? 0.5 : 1 }}
          >
            {phase === 'celebrate' ? 'Saved ✓' : busy ? '…' : 'Done'}
          </button>
        </div>
      </div>

      {/* journal label */}
      <div className="flex-shrink-0 px-4 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[.12em]" style={{ color: 'rgba(255,255,255,.3)' }}>
        Journal step
      </div>

      {/* mood strip */}
      <div className="no-scrollbar flex flex-shrink-0 gap-2 overflow-x-auto px-4 py-2.5">
        {MOODS.map((m) => (
          <div
            key={m}
            onClick={() => setMood(mood === m ? null : m)}
            className="flex h-10 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-[12px] text-2xl"
            style={{
              background: mood === m ? 'rgba(255,255,255,.1)' : 'rgba(255,255,255,.04)',
              border: `2px solid ${mood === m ? 'rgba(255,255,255,.5)' : 'transparent'}`,
            }}
          >
            {m}
          </div>
        ))}
      </div>

      {/* title */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title..."
        disabled={phase === 'loading'}
        className="w-full flex-shrink-0 border-none bg-transparent px-4 pb-1 pt-2.5 text-2xl font-bold text-white outline-none"
      />

      {/* body */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={phase === 'loading' ? 'Opening…' : 'Write your reflection…'}
        disabled={phase === 'loading'}
        className="w-full flex-1 resize-none border-none bg-transparent px-4 py-1.5 text-base leading-[1.65] outline-none"
        style={{ color: 'rgba(255,255,255,.8)' }}
      />

      {/* elapsed bar */}
      <div
        className="flex flex-shrink-0 items-center justify-center gap-2 px-4 py-3 text-[12px] tabular-nums"
        style={{ borderTop: '1px solid #1f1f1f', color: overLimit ? 'rgba(255,159,10,.9)' : 'rgba(255,255,255,.35)' }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
        {limitLabel}
        {overLimit && <span className="text-[11px]">· take your time</span>}
      </div>
    </div>
  )
}
