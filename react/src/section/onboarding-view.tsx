import { useEffect, useRef, useState } from 'react'
import { SERVER_ENDPOINTS } from '../config/server'
import {
  findGoalByGlobalIndex,
  findGoalById,
  formatGoalDuration,
  loadGoalsFromServer,
  type Goal,
} from '../goal'
import type { LocalUser } from './login-view'

/*
 * Onboarding intro shown once, right after a brand-new account is created.
 * This is a faithful port of the ui-3 demo, but wired to real backend data:
 *
 *   - the three answers (age, daily work duration, work-day start) are written
 *     to the user profile via /profile/update — the exact keys the goal
 *     scheduler already understands (age, daily_work_hours, work_day_start);
 *   - the chosen goal (a predefined proposal or a custom one) is sent to
 *     /goal/create, which runs the same personalization + decomposition
 *     pipeline the middleware's create_goal chat action uses;
 *   - the journey screen is then rendered from the real decomposed goal tree.
 *
 * It is, in other words, the middleware chat flow expressed as a predefined,
 * tappable section instead of free-form conversation.
 */

/* ─── ICONS (ported from the demo) ─────────────────────────────────────────── */
const ICONS: Record<string, string> = {
  sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`,
  ballet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="m9 20 3-6 3 6"/><path d="m6.5 9 5.5 2 5.5-2"/><path d="M12 11v3"/></svg>`,
  guitar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m11.9 12.1 4.514-4.514"/><path d="M20.1 2.3a1 1 0 0 0-1.4 0l-1.45 1.45a2 2 0 0 0 0 2.828l.168.168a2 2 0 0 0 2.829 0l1.45-1.45a1 1 0 0 0 0-1.414Z"/><path d="m13.5 6.5 1 1"/><path d="M3 21c1.875-1.875 2.815-2.815 3.5-3.5L10 14c.67-.67 1.58-1 2.5-1a3.5 3.5 0 1 0-3.5-3.5c0 .92-.33 1.83-1 2.5Z"/></svg>`,
  cooking: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
  stretch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M5 22v-5l7-5 7 5v5"/><path d="m5 13 7-5 7 5"/></svg>`,
  foot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5c0 1.1-.17 1.98-.5 2.72A4.5 4.5 0 0 0 9 10v2"/><path d="M8 16v4"/><path d="M12 16v4"/><path d="M20 20v-7.5a3.5 3.5 0 0 0-7 0V16"/><rect x="4" y="16" width="16" height="4" rx="2"/></svg>`,
  hands: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`,
  plie: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M12 6v5"/><path d="m8 14 4-3 4 3"/><path d="m6 20 2-3h8l2 3"/></svg>`,
  dance: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M9 20l1-5-3-3 3-4 5-1 4 1 2 5-3 2 1 5"/><path d="M6 12l-2 4M18 13l2 3"/></svg>`,
  musicnote: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>`,
  mic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
  cart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>`,
  flame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
  egg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c6.23-.05 7.87-5.57 7.5-10-.36-4.34-3.95-9.96-7.5-10C8.45 2 4.8 7.66 4.5 12c-.36 4.43 1.27 9.95 7.5 10z"/></svg>`,
  pasta: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18M3 12c0 4.97 4.03 9 9 9s9-4.03 9-9"/><path d="M5.12 12V8c0-2.21 3.13-4 6.88-4s6.88 1.79 6.88 4v4"/></svg>`,
  stars: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
}

const STEP_ICON_CYCLE = ['stretch', 'hands', 'refresh', 'musicnote', 'foot', 'plie', 'dance', 'mic', 'flame', 'stars']

const INTRO_PHRASES = [
  "We're not here to collect achievements,\nbut stories and perspectives.",
  "Titles and diplomas don't matter here.\nThe person does.",
  'Welcome to the zone\nof real people.',
  'What you are matters to us,\nnot who you are: Human.',
]

interface Proposal {
  icon: string
  title: string
  desc: string
  btnLabel: string
  /* what gets sent to /goal/create */
  goalTitle: string
  cat: string
  /* extra scope context blended into goal_input2 */
  scope: string
}

const PROPOSALS: Proposal[] = [
  {
    icon: 'ballet',
    title: 'Would you like to take your first ballet steps?',
    desc: 'A guided journey, from zero to your first basic choreography. No experience needed.',
    btnLabel: 'Yes, I want to try!',
    goalTitle: 'Take my first ballet steps',
    cat: 'ARTS & DANCE',
    scope:
      'Complete beginner with no prior dance experience. Wants to go from zero to a first basic choreography: warm-up and stretching, the basic foot positions, port de bras, the first plié, and a short combination. Interleave a little theory with hands-on practice from the very first session.',
  },
  {
    icon: 'guitar',
    title: 'Would you like to learn guitar from scratch?',
    desc: 'From how to hold the guitar to your first chords. A few lessons to your first song.',
    btnLabel: "Yes, I'll try guitar!",
    goalTitle: 'Learn to play guitar from scratch',
    cat: 'MUSIC',
    scope:
      'Absolute beginner, assume they own or can borrow an acoustic guitar but have never played. Wants to reach the point of playing one simple song end to end: holding the guitar, the open G and C chords, a basic 4/4 down-strum, smooth chord transitions, then a first full song. Confidence-building first sessions.',
  },
  {
    icon: 'cooking',
    title: 'Would you like to cook your first Italian recipe?',
    desc: 'Authentic carbonara in a few simple steps. The original Roman version, no cream.',
    btnLabel: 'Into the kitchen!',
    goalTitle: 'Cook an authentic carbonara from scratch',
    cat: 'COOKING',
    scope:
      'Home-cook beginner. Wants to make an authentic Roman carbonara (guanciale, Pecorino Romano, eggs, black pepper, spaghetti — no cream): sourcing the right ingredients, rendering the guanciale, making the egg-and-cheese emulsion, cooking the pasta al dente, and the final off-heat assembly for perfect creaminess.',
  },
]

type Screen = 'intro' | 'age' | 'dur' | 'start' | 'loading' | 'proposal' | 'custom' | 'journey'

const DUR_OPTIONS: { id: string; label: string; hours: string }[] = [
  { id: '30min', label: '30 min', hours: '0.5' },
  { id: '1ora', label: '1 hour', hours: '1' },
  { id: '2ore', label: '2 hours', hours: '2' },
  { id: '3plus', label: '3+ hours', hours: '3' },
]

interface JourneyStep {
  icon: string
  title: string
  desc: string
  dur: string
  state: 'done' | 'active' | 'locked'
}

function Icon({ name, className }: { name: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: ICONS[name] ?? ICONS.sparkle }} />
}

interface OnboardingViewProps {
  user: LocalUser
  onComplete: () => void
}

export default function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [screen, setScreen] = useState<Screen>('intro')
  const [introIdx, setIntroIdx] = useState(() => Math.floor(Math.random() * INTRO_PHRASES.length))
  const [age, setAge] = useState(25)
  const [dur, setDur] = useState<string | null>(null)
  const [startTime, setStartTime] = useState('09:00')
  const [carouselIdx, setCarouselIdx] = useState(0)
  const [customGoal, setCustomGoal] = useState('')
  const [journeySteps, setJourneySteps] = useState<JourneyStep[]>([])
  const [journeyMeta, setJourneyMeta] = useState<{ name: string; cat: string }>({ name: '', cat: 'JOURNEY' })
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const creationDoneRef = useRef(false)
  const dragRef = useRef<{ startX: number; dx: number; dragging: boolean }>({ startX: 0, dx: 0, dragging: false })

  /* Mark the account as mid-onboarding so a refresh resumes the flow rather
   * than dropping into an empty app. Best-effort. */
  useEffect(() => {
    void postProfile('onboarded', '0').catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Cycle the intro phrases while the intro screen is showing. */
  useEffect(() => {
    if (screen !== 'intro') return
    const id = setInterval(() => setIntroIdx((i) => (i + 1) % INTRO_PHRASES.length), 10000)
    return () => clearInterval(id)
  }, [screen])

  async function postProfile(key: string, value: string) {
    const res = await fetch(SERVER_ENDPOINTS.profileUpdate, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    if (!res.ok) throw new Error(`profile/update ${key} failed: ${res.status}`)
  }

  function durHours(): string {
    return DUR_OPTIONS.find((d) => d.id === dur)?.hours ?? '1'
  }

  function durLabel(): string {
    return DUR_OPTIONS.find((d) => d.id === dur)?.label ?? 'about an hour'
  }

  function buildExtraInfo(scope: string): string {
    return (
      `${scope} ` +
      `The person is ${age} years old, plans to work about ${durLabel()} per day, ` +
      `typically starting around ${startTime}. They are just starting out — never assume prior ` +
      `materials or experience. Keep the first sessions short, orienting and confidence-building, ` +
      `and interleave a little theory with hands-on practice throughout.`
    )
  }

  function buildJourneySteps(goals: Goal[], goalId: string | undefined): JourneyStep[] {
    const root = goalId ? findGoalById(goals, goalId) : null
    const children = root
      ? root.subgoals
          .map((idx) => findGoalByGlobalIndex(goals, idx))
          .filter((g): g is Goal => g != null)
      : []

    if (children.length === 0) {
      // Decomposition produced no children yet — surface the root as a single
      // first step so the screen is never empty.
      const only = root
      return [
        {
          icon: STEP_ICON_CYCLE[0],
          title: only?.title ?? 'Your first step',
          desc: only?.extraInfo ?? 'Your personalized journey is ready.',
          dur: only ? formatGoalDuration(only.requiredTime) : '',
          state: 'active',
        },
      ]
    }

    return children.map((child, i) => ({
      icon: STEP_ICON_CYCLE[i % STEP_ICON_CYCLE.length],
      title: child.title,
      desc: child.extraInfo || 'A focused step on your journey.',
      dur: formatGoalDuration(child.requiredTime),
      state: i === 0 ? 'active' : 'locked',
    }))
  }

  async function runCreation(goalTitle: string, scope: string, meta: { name: string; cat: string }) {
    setError(null)
    creationDoneRef.current = false
    setScreen('loading')

    try {
      // 1) Persist the three onboarding answers straight into the user profile.
      await Promise.allSettled([
        postProfile('age', String(age)),
        postProfile('daily_work_hours', durHours()),
        postProfile('work_day_start', startTime),
      ])

      // 2) Create the real goal — same pipeline the middleware create_goal uses.
      const res = await fetch(SERVER_ENDPOINTS.goalCreate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: goalTitle, extraInfo: buildExtraInfo(scope) }),
      })
      if (!res.ok) throw new Error(`Goal create failed: ${res.status}`)
      const data = (await res.json()) as { ok: boolean; 'goal-id'?: string }

      // 3) Onboarding is complete — flip the flag so it never shows again.
      await postProfile('onboarded', '1').catch(() => {})

      // 4) Build the journey screen from the freshly decomposed goal tree.
      const goals = await loadGoalsFromServer()
      setJourneyMeta(meta)
      setJourneySteps(buildJourneySteps(goals, data['goal-id']))
      creationDoneRef.current = true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* Loading screen: an endlessly looping "building your journey" animation.
   * It only hands off to the journey screen once the real goal creation has
   * resolved on the server (creationDoneRef) — so the loop runs for exactly as
   * long as the server takes to process the journey, however long that is. */
  useEffect(() => {
    if (screen !== 'loading') return
    let cancelled = false
    let raf = 0

    const canvas = document.getElementById('ob-loading-canvas') as HTMLCanvasElement | null
    const nodesLayer = document.getElementById('ob-loading-nodes')
    const blur = document.getElementById('ob-loading-blur')
    const msgEl = document.getElementById('ob-loading-msg')

    const N = 5
    const SW = window.innerWidth
    const SH = window.innerHeight
    const CX = SW / 2
    // Vertically centred: the 5-node span is symmetric around the screen middle.
    const topY = SH * 0.28
    const botY = SH * 0.72
    const positions = Array.from({ length: N }, (_, i) => ({
      x: CX,
      y: topY + ((botY - topY) * i) / (N - 1),
      icon: STEP_ICON_CYCLE[i % STEP_ICON_CYCLE.length],
    }))

    if (blur) {
      const hue = 210
      blur.style.background =
        `radial-gradient(circle at 35% 40%, hsla(${hue},85%,62%,1) 0%, transparent 55%),` +
        `radial-gradient(circle at 68% 68%, hsla(${(hue + 55) % 360},80%,55%,0.9) 0%, transparent 50%)`
    }

    const nodeEls: HTMLDivElement[] = []
    if (nodesLayer) {
      nodesLayer.innerHTML = ''
      positions.forEach((pos) => {
        const el = document.createElement('div')
        el.className = 'ob-loading-node'
        el.style.left = pos.x + 'px'
        el.style.top = pos.y + 'px'
        el.style.transition = 'none' // driven per-frame below
        el.innerHTML = ICONS[pos.icon] ?? ''
        nodesLayer.appendChild(el)
        nodeEls.push(el)
      })
    }

    let ctx: CanvasRenderingContext2D | null = null
    let W = 0
    let H = 0
    if (canvas) {
      ctx = canvas.getContext('2d')
      const dpr = window.devicePixelRatio || 1
      canvas.width = canvas.offsetWidth * dpr
      canvas.height = canvas.offsetHeight * dpr
      ctx?.scale(dpr, dpr)
      W = canvas.offsetWidth
      H = canvas.offsetHeight
    }

    const CYCLE = 2200
    const stepT = 1 / N
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)
    // easeOutBack — exaggerated overshoot as each node pops in
    const C1 = 1.70158
    const C3 = C1 + 1
    const popEase = (x: number) =>
      x <= 0 ? 0 : x >= 1 ? 1 : 1 + C3 * Math.pow(x - 1, 3) + C1 * Math.pow(x - 1, 2)

    const msgs = ['Preparing…', 'Analyzing…', 'Personalizing…', 'Shaping your journey…', 'Almost there…']
    let cycleStart = performance.now()

    function frame(now: number) {
      if (cancelled) return
      let t = (now - cycleStart) / CYCLE
      if (t >= 1) {
        // One build cycle finished. If the server is done, advance; else loop.
        if (creationDoneRef.current) { navTo('journey'); return }
        cycleStart = now
        t = 0
      }

      // nodes pop in one after another
      for (let i = 0; i < N; i++) {
        const local = Math.max(0, Math.min(1, (t - i * stepT) / (stepT * 0.9)))
        const el = nodeEls[i]
        if (!el) continue
        el.style.transform = `translate(-50%, -50%) scale(${popEase(local).toFixed(3)})`
        el.style.opacity = String(0.7 * Math.min(1, local * 2.2))
      }

      // dotted connectors grow between nodes
      if (ctx) {
        ctx.clearRect(0, 0, W, H)
        for (let i = 0; i < positions.length - 1; i++) {
          const ls = (i + 0.6) * stepT
          const le = ls + stepT * 0.5
          if (t < ls) continue
          const lt = ease(Math.min((t - ls) / (le - ls), 1))
          const p1 = positions[i]
          const p2 = positions[i + 1]
          ctx.save()
          ctx.setLineDash([4, 7])
          ctx.beginPath()
          ctx.moveTo(p1.x, p1.y)
          ctx.lineTo(p1.x + (p2.x - p1.x) * lt, p1.y + (p2.y - p1.y) * lt)
          ctx.strokeStyle = 'rgba(255,255,255,0.32)'
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.restore()
        }
      }

      if (msgEl) {
        const want = error ? 'Something went wrong' : msgs[Math.min(msgs.length - 1, Math.floor(t * msgs.length))]
        if (msgEl.textContent !== want) msgEl.textContent = want
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (nodesLayer) nodesLayer.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, error])

  /* ─── navigation helper with a soft fade ─── */
  const [leaving, setLeaving] = useState(false)
  function navTo(next: Screen) {
    if (next === screen) return
    setLeaving(true)
    setTimeout(() => {
      setScreen(next)
      setLeaving(false)
    }, 200)
  }

  function acceptProposal(p: Proposal) {
    void runCreation(p.goalTitle, p.scope, { name: p.goalTitle, cat: p.cat })
  }

  function acceptCustomGoal() {
    const goal = customGoal.trim()
    if (goal.length < 2) return
    const scope =
      `The person's own goal, in their words: "${goal}". Treat them as a motivated beginner unless ` +
      `the wording clearly says otherwise. Build a realistic path from where they likely are today ` +
      `toward a first concrete, satisfying result.`
    void runCreation(goal, scope, { name: goal, cat: 'PERSONAL GOAL' })
  }

  function completeJourneyView() {
    void postProfile('onboarded', '1').catch(() => {})
    onComplete()
  }

  /* ─── progress bar ─── */
  const PROGRESS: Partial<Record<Screen, number>> = { age: 33, dur: 66, start: 100 }
  const progressPct = PROGRESS[screen]

  const ageFill = (((age - 10) / (80 - 10)) * 100).toFixed(1) + '%'

  /* ─── carousel drag ─── */
  function onDragStart(clientX: number, target: EventTarget) {
    if ((target as HTMLElement).closest('button')) return
    dragRef.current = { startX: clientX, dx: 0, dragging: true }
    const track = document.getElementById('ob-carousel-track')
    if (track) track.style.transition = 'none'
  }
  function onDragMove(clientX: number) {
    const d = dragRef.current
    if (!d.dragging) return
    d.dx = clientX - d.startX
    const track = document.getElementById('ob-carousel-track')
    if (track) track.style.transform = `translateX(calc(${-carouselIdx * 100}% + ${d.dx}px))`
  }
  function onDragEnd() {
    const d = dragRef.current
    if (!d.dragging) return
    d.dragging = false
    const outer = document.getElementById('ob-carousel-outer')
    const threshold = (outer?.offsetWidth ?? 300) * 0.22
    let next = carouselIdx
    if (d.dx < -threshold && carouselIdx < PROPOSALS.length - 1) next = carouselIdx + 1
    else if (d.dx > threshold && carouselIdx > 0) next = carouselIdx - 1
    setCarouselIdx(next)
    const track = document.getElementById('ob-carousel-track')
    if (track) {
      track.style.transition = 'transform 0.32s cubic-bezier(0.4,0,0.2,1)'
      track.style.transform = `translateX(${-next * 100}%)`
    }
  }

  const stepCount = journeySteps.length
  const doneCount = journeySteps.filter((s) => s.state === 'done').length
  const journeyPct = stepCount ? Math.round((doneCount / stepCount) * 100) : 0

  return (
    <div className="ob-root">
      <style>{OB_CSS}</style>

      <div className="ob-progress" style={{ visibility: progressPct !== undefined ? 'visible' : 'hidden' }}>
        <div className="ob-progress-fill" style={{ width: `${progressPct ?? 0}%` }} />
      </div>

      <div className={`ob-screens ${leaving ? 'ob-leaving' : 'ob-entering'}`}>
        {/* INTRO */}
        {screen === 'intro' && (
          <div className="ob-screen">
            <div className="ob-step-label">Change</div>
            <div
              className="ob-step-title ob-phrase"
              key={introIdx}
              dangerouslySetInnerHTML={{ __html: INTRO_PHRASES[introIdx].replace(/\n/g, '<br>') }}
            />
            <button className="ob-cta" onClick={() => navTo('age')}>
              Let&apos;s begin →
            </button>
          </div>
        )}

        {/* Q1 — AGE */}
        {screen === 'age' && (
          <div className="ob-screen">
            <div className="ob-step-label">Question 1 of 3</div>
            <div className="ob-step-title">How old are you?</div>
            <div className="ob-slider-wrap">
              <div className="ob-slider-val">{age}</div>
              <input
                type="range"
                min={10}
                max={80}
                value={age}
                style={{ ['--fill' as string]: ageFill }}
                onChange={(e) => setAge(Number(e.target.value))}
              />
              <div className="ob-slider-ends">
                <span>10</span>
                <span>80</span>
              </div>
            </div>
            <button className="ob-cta" onClick={() => navTo('dur')}>
              Continue →
            </button>
          </div>
        )}

        {/* Q2 — DURATION */}
        {screen === 'dur' && (
          <div className="ob-screen">
            <div className="ob-step-label">Question 2 of 3</div>
            <div className="ob-step-title">How long do you plan to work each day?</div>
            <div className="ob-dur-grid">
              {DUR_OPTIONS.map((o) => (
                <div
                  key={o.id}
                  className={`ob-dur-opt ${dur === o.id ? 'ob-sel' : ''}`}
                  onClick={() => setDur(o.id)}
                >
                  {o.label}
                </div>
              ))}
            </div>
            <button className={`ob-cta ${dur ? '' : 'ob-hidden'}`} onClick={() => navTo('start')}>
              Continue →
            </button>
          </div>
        )}

        {/* Q3 — START TIME */}
        {screen === 'start' && (
          <div className="ob-screen">
            <div className="ob-step-label">Question 3 of 3</div>
            <div className="ob-step-title">When will you start working?</div>
            <div className="ob-clock-wrap">
              <input
                type="time"
                className="ob-time-input"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
              <div className="ob-clock-hint">Tap to change</div>
            </div>
            <button className="ob-cta" onClick={() => navTo('proposal')}>
              Discover →
            </button>
          </div>
        )}

        {/* LOADING */}
        {screen === 'loading' && (
          <div className="ob-screen ob-screen-loading">
            <div className="ob-loading-blur" id="ob-loading-blur" />
            <canvas id="ob-loading-canvas" className="ob-loading-canvas" />
            <div id="ob-loading-nodes" className="ob-loading-nodes" />
            <div className="ob-loading-text">
              <div className="ob-loading-msg" id="ob-loading-msg">
                Preparing…
              </div>
              <div className="ob-loading-sub">{error ? 'tap below to go back' : 'personalized journey'}</div>
            </div>
            {error && (
              <button
                className="ob-cta"
                style={{ position: 'absolute', bottom: 48 }}
                onClick={() => navTo('proposal')}
              >
                Something went wrong — go back
              </button>
            )}
          </div>
        )}

        {/* PROPOSALS */}
        {screen === 'proposal' && (
          <div className="ob-screen ob-screen-proposal">
            <div className="ob-prop-header">
              <div className="ob-prop-header-label">change</div>
            </div>
            <div
              className="ob-carousel-outer"
              id="ob-carousel-outer"
              onMouseDown={(e) => onDragStart(e.clientX, e.target)}
              onMouseMove={(e) => onDragMove(e.clientX)}
              onMouseUp={onDragEnd}
              onMouseLeave={onDragEnd}
              onTouchStart={(e) => onDragStart(e.touches[0].clientX, e.target)}
              onTouchMove={(e) => onDragMove(e.touches[0].clientX)}
              onTouchEnd={onDragEnd}
            >
              <div
                className="ob-carousel-track"
                id="ob-carousel-track"
                style={{ transform: `translateX(${-carouselIdx * 100}%)` }}
              >
                {PROPOSALS.map((p, i) => (
                  <div className="ob-prop-slide" key={i}>
                    <div className="ob-prop-card">
                      <Icon name={p.icon} className="ob-prop-emoji" />
                      <div className="ob-prop-title">{p.title}</div>
                      <div className="ob-prop-desc">{p.desc}</div>
                      <div className="ob-prop-actions">
                        <button className="ob-prop-yes" onClick={() => acceptProposal(p)}>
                          {p.btnLabel}
                        </button>
                        {i < PROPOSALS.length - 1 && (
                          <button
                            className="ob-prop-no"
                            onClick={() => {
                              const next = Math.min(PROPOSALS.length - 1, carouselIdx + 1)
                              setCarouselIdx(next)
                            }}
                          >
                            No, keep looking →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="ob-carousel-dots">
              {PROPOSALS.map((_, i) => (
                <div key={i} className={`ob-dot ${i === carouselIdx ? 'ob-on' : ''}`} />
              ))}
            </div>
            <button className="ob-custom-link" onClick={() => navTo('custom')}>
              Have your own idea?
            </button>
          </div>
        )}

        {/* CUSTOM GOAL */}
        {screen === 'custom' && (
          <div className="ob-screen ob-screen-custom">
            <div className="ob-jback ob-custom-back" onClick={() => navTo('proposal')}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </div>
            <div className="ob-step-label ob-custom-brand">Change</div>
            <div className="ob-prop-card ob-custom-card">
              <Icon name="stars" className="ob-prop-emoji" />
              <div className="ob-prop-title">Your personal goal</div>
              <div className="ob-prop-desc">
                Describe what you want to achieve and we&apos;ll create a personalized journey for you.
              </div>
              <div className="ob-prop-actions">
                <input
                  type="text"
                  className="ob-custom-input"
                  placeholder="E.g.: I want to play piano…"
                  maxLength={60}
                  value={customGoal}
                  onChange={(e) => setCustomGoal(e.target.value)}
                />
                <button
                  className="ob-prop-yes"
                  style={{
                    opacity: customGoal.trim().length >= 2 ? 1 : 0.35,
                    pointerEvents: customGoal.trim().length >= 2 ? 'auto' : 'none',
                  }}
                  onClick={acceptCustomGoal}
                >
                  Create my journey →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* JOURNEY */}
        {screen === 'journey' && (
          <div className="ob-screen ob-screen-journey">
            <div className="ob-journey-topbar">
              <div className="ob-jmeta">
                <div className="ob-jcat">{journeyMeta.cat}</div>
                <div className="ob-jname">{journeyMeta.name || '—'}</div>
              </div>
              <div className="ob-jprog">
                <div className="ob-jprog-pct">{journeyPct}%</div>
                <div className="ob-jprog-lbl">progress</div>
              </div>
            </div>
            <div className="ob-journey-path">
              {journeySteps.map((step, i) => (
                <div key={i} style={{ width: '100%' }}>
                  {i > 0 && <div className={`ob-connector ${step.state === 'done' ? 'ob-done' : ''}`} />}
                  <div
                    className={`ob-jnode ob-${step.state}`}
                    onClick={() => step.state !== 'locked' && setOpenStep(i)}
                  >
                    <div className="ob-jnode-circle-wrap">
                      <div className="ob-jnode-circle">
                        <Icon name={step.state === 'locked' ? 'lock' : step.icon} />
                      </div>
                      <div className="ob-jnode-check">✓</div>
                    </div>
                    <div className="ob-jnode-info">
                      <div className="ob-jnode-title">{step.title}</div>
                      <div className="ob-jnode-dur">{step.dur}</div>
                      {step.state === 'active' && <div className="ob-jnode-badge">NOW</div>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button className="ob-journey-cta" onClick={completeJourneyView}>
              Start my journey →
            </button>
          </div>
        )}
      </div>

      {/* STEP SHEET */}
      <div
        className={`ob-sheet-overlay ${openStep !== null ? 'ob-open' : ''}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenStep(null)
        }}
      >
        <div className="ob-sheet">
          <div className="ob-sheet-handle" />
          <div className="ob-sheet-close" onClick={() => setOpenStep(null)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>
          {openStep !== null && journeySteps[openStep] && (
            <>
              <Icon name={journeySteps[openStep].icon} className="ob-sheet-emoji" />
              <div className="ob-sheet-title">{journeySteps[openStep].title}</div>
              <div className="ob-sheet-desc">{journeySteps[openStep].desc}</div>
              <div className="ob-sheet-meta">
                <div className="ob-sheet-chip">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span>{journeySteps[openStep].dur}</span>
                </div>
              </div>
              <button className="ob-sheet-btn" onClick={completeJourneyView}>
                Start my journey →
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const OB_CSS = `
.ob-root {
  position: fixed; inset: 0; z-index: 300;
  background: #0a0a0a; color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  display: flex; flex-direction: column; overflow: hidden;
  --ob-bg:#0a0a0a; --ob-surface:#111; --ob-surface2:#1a1a1a;
  --ob-border:#2a2a2a; --ob-border2:#333; --ob-dim:rgba(255,255,255,0.5);
}
.ob-root *, .ob-root *::before, .ob-root *::after { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

.ob-progress { height: 2px; background: var(--ob-border); flex-shrink: 0; }
.ob-progress-fill { height: 100%; background: #fff; transition: width 0.4s ease; }

.ob-screens { flex: 1; position: relative; overflow: hidden; transition: opacity .2s ease, transform .2s ease; }
.ob-entering { opacity: 1; transform: translateY(0); }
.ob-leaving { opacity: 0; transform: translateY(-12px); }

.ob-screen {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; padding: 32px 24px;
  animation: ob-fade-in .3s ease;
}
@keyframes ob-fade-in { from { opacity: 0; transform: translateY(16px);} to {opacity:1; transform:none;} }

.ob-step-label { font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--ob-dim); margin-bottom: 16px; text-align: center; }
.ob-step-title { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; line-height: 1.25; text-align: center; margin-bottom: 36px; max-width: 300px; }
/* Simple opacity crossfade, exactly like the ui-3 demo. */
.ob-phrase { animation: ob-phrase-in .6s ease; }
@keyframes ob-phrase-in { from { opacity: 0; } to { opacity: 1; } }

.ob-cta {
  width: 100%; max-width: 300px; margin-top: 28px; padding: 17px;
  background: #fff; color: #000; border: none; border-radius: 16px;
  font-size: 15px; font-weight: 700; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  transition: opacity .15s, transform .1s; font-family: inherit;
}
.ob-cta:active { transform: scale(0.97); }
.ob-cta.ob-hidden { opacity: 0; pointer-events: none; }

.ob-slider-wrap { width: 100%; max-width: 300px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
.ob-slider-val { font-size: 68px; font-weight: 900; letter-spacing: -3px; line-height: 1; }
.ob-slider-wrap input[type=range] {
  -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 2px;
  outline: none; cursor: pointer;
  background: linear-gradient(to right, #fff var(--fill, 21%), var(--ob-border2) var(--fill, 21%));
}
.ob-slider-wrap input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 26px; height: 26px; border-radius: 50%;
  background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.5); transition: transform .1s;
}
.ob-slider-wrap input[type=range]:active::-webkit-slider-thumb { transform: scale(1.2); }
.ob-slider-ends { display: flex; justify-content: space-between; width: 100%; font-size: 11px; font-weight: 600; color: var(--ob-dim); }

.ob-dur-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; max-width: 300px; }
.ob-dur-opt {
  padding: 26px 12px; background: var(--ob-surface); border: 1.5px solid var(--ob-border2);
  border-radius: 20px; cursor: pointer; text-align: center; font-size: 17px; font-weight: 700;
  transition: background .15s, border-color .15s, transform .1s;
}
.ob-dur-opt:active { transform: scale(0.95); }
.ob-dur-opt.ob-sel { background: #fff; color: #000; border-color: #fff; }

.ob-clock-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.ob-time-input {
  font-size: 46px; font-weight: 900; letter-spacing: -1px; line-height: 1.1;
  background: transparent; border: none; color: #fff; outline: none; text-align: center;
  cursor: pointer; font-family: inherit; width: auto; max-width: 92vw; padding: 4px 8px;
  -webkit-appearance: none; appearance: none;
}
.ob-time-input::-webkit-calendar-picker-indicator { opacity: 0.35; filter: invert(1); width: 22px; height: 22px; cursor: pointer; margin-left: 6px; }
.ob-clock-hint { font-size: 11px; color: var(--ob-dim); font-weight: 700; letter-spacing: 2px; text-transform: uppercase; }

/* LOADING */
.ob-screen-loading { padding: 0; justify-content: center; align-items: center; }
.ob-loading-blur { position: absolute; inset: 0; filter: blur(70px); opacity: 0.45; z-index: 0; transition: background .5s ease; }
.ob-loading-canvas { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; }
.ob-loading-nodes { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.ob-loading-node {
  position: absolute; width: 56px; height: 56px; border-radius: 50%;
  background: rgba(255,255,255,0.95); display: flex; align-items: center; justify-content: center;
  transform: translate(-50%, -50%) scale(0); opacity: 0;
  transition: transform .42s cubic-bezier(0.34,1.56,0.64,1), opacity .25s ease;
  box-shadow: 0 0 0 7px rgba(255,255,255,0.12), 0 0 24px rgba(255,255,255,0.18);
}
.ob-loading-node svg { width: 26px; height: 26px; display: block; stroke: #000; color: #000; }
.ob-loading-text { position: absolute; top: 50%; left: 0; right: 0; transform: translateY(-50%); display: flex; flex-direction: column; align-items: center; z-index: 20; gap: 6px; pointer-events: none; }
.ob-loading-msg { font-size: 18px; font-weight: 800; letter-spacing: -0.4px; transition: opacity .35s ease; }
.ob-loading-sub { font-size: 11px; color: var(--ob-dim); letter-spacing: 2px; text-transform: uppercase; font-weight: 600; }

/* PROPOSALS */
.ob-screen-proposal { padding: 0; justify-content: flex-start; }
.ob-prop-header { width: 100%; padding: 52px 24px 0; display: flex; flex-direction: column; align-items: center; }
.ob-prop-header-label { font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--ob-dim); margin-bottom: 6px; }
.ob-carousel-outer { width: 100%; flex: 1; overflow: hidden; position: relative; }
.ob-carousel-track { display: flex; height: 100%; align-items: center; will-change: transform; }
.ob-prop-slide { min-width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding: 20px 24px; }
.ob-prop-card { width: 100%; max-width: 340px; background: var(--ob-surface); border: 1px solid var(--ob-border2); border-radius: 26px; padding: 28px 24px 24px; display: flex; flex-direction: column; align-items: center; }
.ob-prop-emoji { display: flex; margin-bottom: 16px; animation: ob-bob 3s ease-in-out infinite; }
.ob-prop-emoji svg { width: 52px; height: 52px; display: block; }
@keyframes ob-bob { 0%,100% { transform: translateY(0);} 50% { transform: translateY(-7px);} }
.ob-prop-title { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; text-align: center; line-height: 1.3; margin-bottom: 8px; }
.ob-prop-desc { font-size: 13px; color: var(--ob-dim); text-align: center; line-height: 1.6; margin-bottom: 24px; }
.ob-prop-actions { width: 100%; display: flex; flex-direction: column; gap: 10px; }
.ob-prop-yes { width: 100%; padding: 16px; background: #fff; color: #000; border: none; border-radius: 14px; font-size: 15px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: opacity .15s, transform .1s; font-family: inherit; }
.ob-prop-yes:active { transform: scale(0.97); }
.ob-prop-no { width: 100%; padding: 13px; background: transparent; color: var(--ob-dim); border: 1.5px solid var(--ob-border2); border-radius: 14px; font-size: 13px; font-weight: 600; cursor: pointer; transition: border-color .15s, color .15s; font-family: inherit; }
.ob-prop-no:hover { border-color: rgba(255,255,255,0.3); color: #fff; }
.ob-carousel-dots { display: flex; gap: 6px; padding: 16px 0 18px; justify-content: center; flex-shrink: 0; }
.ob-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ob-border2); transition: all .22s ease; }
.ob-dot.ob-on { width: 18px; border-radius: 3px; background: #fff; }
.ob-custom-link { background: none; border: none; color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; padding: 4px 24px 28px; text-decoration: underline; text-underline-offset: 4px; text-decoration-color: rgba(255,255,255,0.45); transition: text-decoration-color .15s; flex-shrink: 0; }
.ob-custom-link:hover { text-decoration-color: rgba(255,255,255,0.9); }

/* CUSTOM */
.ob-screen-custom { padding: 0 24px; }
.ob-custom-back { position: absolute; top: 52px; left: 20px; }
.ob-custom-brand { position: absolute; top: 58px; left: 0; right: 0; text-align: center; pointer-events: none; }
.ob-custom-card { max-width: 340px; }
.ob-custom-input { width: 100%; padding: 14px 16px; margin-bottom: 2px; background: var(--ob-surface2); border: 1.5px solid var(--ob-border2); border-radius: 14px; color: #fff; font-size: 14px; font-weight: 600; font-family: inherit; outline: none; transition: border-color .2s; }
.ob-custom-input:focus { border-color: rgba(255,255,255,0.45); }
.ob-custom-input::placeholder { color: var(--ob-dim); font-weight: 500; }
.ob-jback { width: 38px; height: 38px; background: var(--ob-surface2); border: 1px solid var(--ob-border2); border-radius: 11px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background .15s; }
.ob-jback:hover { background: var(--ob-border2); }

/* JOURNEY */
.ob-screen-journey { padding: 0; justify-content: flex-start; align-items: stretch; overflow-y: auto; }
.ob-journey-topbar { position: sticky; top: 0; z-index: 5; padding: 52px 20px 16px; background: linear-gradient(to bottom, var(--ob-bg) 75%, transparent); display: flex; align-items: flex-start; gap: 14px; flex-shrink: 0; }
.ob-jmeta { flex: 1; }
.ob-jcat { font-size: 10px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--ob-dim); margin-bottom: 3px; }
.ob-jname { font-size: 20px; font-weight: 800; letter-spacing: -0.4px; }
.ob-jprog { text-align: right; flex-shrink: 0; }
.ob-jprog-pct { font-size: 22px; font-weight: 800; }
.ob-jprog-lbl { font-size: 10px; color: var(--ob-dim); font-weight: 600; }
.ob-journey-path { display: flex; flex-direction: column; align-items: center; padding: 8px 0 120px; width: 100%; }
.ob-connector { width: 2px; height: 52px; margin: 0 auto; background: linear-gradient(to bottom, var(--ob-border2), var(--ob-border)); }
.ob-connector.ob-done { background: linear-gradient(to bottom, rgba(255,255,255,0.4), rgba(255,255,255,0.15)); }
.ob-jnode { display: flex; flex-direction: column; align-items: center; width: 100%; padding: 0 24px; cursor: pointer; }
.ob-jnode-circle-wrap { position: relative; margin-bottom: 10px; }
.ob-jnode-circle { width: 68px; height: 68px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: transform .15s; }
.ob-jnode-circle svg { width: 30px; height: 30px; display: block; }
.ob-jnode-circle:active { transform: scale(0.92); }
.ob-jnode.ob-done .ob-jnode-circle { background: #fff; box-shadow: 0 0 0 5px rgba(255,255,255,0.1); }
.ob-jnode.ob-active .ob-jnode-circle { background: #fff; box-shadow: 0 0 0 6px rgba(255,255,255,0.18), 0 0 0 12px rgba(255,255,255,0.06); animation: ob-pulse 2.2s ease-in-out infinite; }
.ob-jnode.ob-locked .ob-jnode-circle { background: var(--ob-surface2); border: 2px solid var(--ob-border2); }
.ob-jnode.ob-done .ob-jnode-circle svg, .ob-jnode.ob-active .ob-jnode-circle svg { stroke: #000; color: #000; }
.ob-jnode.ob-locked .ob-jnode-circle svg { stroke: rgba(255,255,255,0.25); color: rgba(255,255,255,0.25); }
@keyframes ob-pulse { 0%,100% { box-shadow: 0 0 0 6px rgba(255,255,255,0.18), 0 0 0 12px rgba(255,255,255,0.06);} 50% { box-shadow: 0 0 0 9px rgba(255,255,255,0.22), 0 0 0 20px rgba(255,255,255,0.03);} }
.ob-jnode-check { position: absolute; top: -3px; right: -3px; width: 20px; height: 20px; border-radius: 50%; background: var(--ob-bg); border: 2px solid #fff; display: none; align-items: center; justify-content: center; font-size: 9px; }
.ob-jnode.ob-done .ob-jnode-check { display: flex; }
.ob-jnode-info { text-align: center; max-width: 200px; }
.ob-jnode-title { font-size: 14px; font-weight: 700; line-height: 1.3; }
.ob-jnode.ob-locked .ob-jnode-title { color: rgba(255,255,255,0.3); }
.ob-jnode-dur { font-size: 11px; color: var(--ob-dim); margin-top: 3px; font-weight: 600; }
.ob-jnode-badge { display: inline-flex; margin-top: 7px; padding: 3px 10px; background: #fff; color: #000; border-radius: 20px; font-size: 10px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; animation: ob-pop .4s cubic-bezier(0.34,1.56,0.64,1); }
@keyframes ob-pop { from { transform: scale(0.7); opacity: 0;} to {transform: scale(1); opacity:1;} }
.ob-journey-cta { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); width: calc(100% - 48px); max-width: 320px; padding: 17px; background: #fff; color: #000; border: none; border-radius: 16px; font-size: 15px; font-weight: 700; cursor: pointer; z-index: 10; }
.ob-journey-cta:active { transform: translateX(-50%) scale(0.97); }

/* STEP SHEET */
.ob-sheet-overlay { position: fixed; inset: 0; z-index: 400; background: rgba(0,0,0,0.75); backdrop-filter: blur(8px); opacity: 0; pointer-events: none; transition: opacity .25s; display: flex; align-items: flex-end; }
.ob-sheet-overlay.ob-open { opacity: 1; pointer-events: all; }
.ob-sheet { width: 100%; background: var(--ob-surface); border: 1px solid var(--ob-border2); border-radius: 24px 24px 0 0; padding: 24px 22px 44px; transform: translateY(100%); transition: transform .32s cubic-bezier(0.32,1.2,0.54,1); position: relative; }
.ob-sheet-overlay.ob-open .ob-sheet { transform: translateY(0); }
.ob-sheet-handle { width: 34px; height: 4px; border-radius: 2px; background: var(--ob-border2); margin: 0 auto 22px; }
.ob-sheet-close { position: absolute; top: 18px; right: 18px; width: 30px; height: 30px; border-radius: 50%; background: var(--ob-surface2); border: 1px solid var(--ob-border); display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--ob-dim); }
.ob-sheet-emoji { display: flex; margin-bottom: 14px; }
.ob-sheet-emoji svg { width: 44px; height: 44px; display: block; }
.ob-sheet-title { font-size: 21px; font-weight: 800; letter-spacing: -0.4px; margin-bottom: 7px; }
.ob-sheet-desc { font-size: 14px; color: var(--ob-dim); line-height: 1.6; margin-bottom: 20px; }
.ob-sheet-meta { display: flex; gap: 10px; margin-bottom: 22px; }
.ob-sheet-chip { display: flex; align-items: center; gap: 5px; padding: 6px 12px; background: var(--ob-surface2); border: 1px solid var(--ob-border); border-radius: 20px; font-size: 12px; font-weight: 600; color: var(--ob-dim); }
.ob-sheet-btn { width: 100%; padding: 17px; background: #fff; color: #000; border: none; border-radius: 16px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; }
.ob-sheet-btn:active { transform: scale(0.97); }
`
