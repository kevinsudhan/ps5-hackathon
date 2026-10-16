import { useCallback, useEffect, useRef, useState } from 'react'
import { createRun, errorText, getStory, type Loaded } from '../api/client'
import type { AskGraph, Run, Story } from '../api/types'
import { firstSentence, monthYear, num, plain } from '../lib/format'

/** What the stage should show while the story plays. */
export interface StoryView {
  phase: number                 // 0 closes, 1 spreads, 2 breaks, 3 persona, 4 agents, 5 memory
  graph: AskGraph
  reveal: number | null
  focus: string[] | null
  flyKey: number
  caption: string
  count: { to: number } | null  // count-up inside the caption (orders break)
  lines: string[]
}

const PHASES = 6

/**
 * The ~30 second guided story. Every step can be skipped (button or Esc); skipping or finishing
 * always returns the stage to the current answer. The agents step really calls POST /runs.
 */
export function useStoryPlayer(tenant: string, eventId: string | null, onRun: (run: Loaded<Run>) => void) {
  const [view, setView] = useState<StoryView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const token = useRef(0)

  const stop = useCallback(() => { token.current++; setView(null); setLoading(false) }, [])
  useEffect(() => stop, [tenant, stop])

  const play = useCallback(async () => {
    if (!eventId) return
    const my = ++token.current
    const alive = () => my === token.current
    const wait = (ms: number) => new Promise<boolean>(r => setTimeout(() => r(alive()), ms))
    setError(null); setLoading(true)
    let story: Story
    try {
      story = (await getStory(tenant, eventId)).data
    } catch (e) {
      if (alive()) { setError(errorText(e)); setLoading(false) }
      return
    }
    if (!alive()) return
    setLoading(false)
    const g = story.graph
    const steps = g.nodes.map(n => n.step).filter((s): s is number => s != null)
    const maxStep = steps.length ? Math.max(...steps) : 0
    let flyKey = 0
    const show = (v: Partial<StoryView> & { phase: number; caption: string }) =>
      setView({ graph: g, reveal: null, focus: null, flyKey, count: null, lines: [], ...v })

    // 1. the port closes
    show({ phase: 0, caption: story.captions.closes, reveal: 0 })
    if (!(await wait(3800))) return
    // 2. red spreads along the connections, in order of step
    const tick = Math.min(850, 6000 / Math.max(1, maxStep))
    for (let r = 1; r <= maxStep; r++) {
      show({ phase: 1, caption: story.captions.spreads, reveal: r })
      if (!(await wait(tick))) return
    }
    if (!(await wait(500))) return
    // 3. orders break (count up the number in the caption)
    const m = story.captions.breaks.match(/\d[\d,]*/)
    show({ phase: 2, caption: story.captions.breaks, count: m ? { to: Number(m[0].replace(/,/g, '')) } : null })
    if (!(await wait(3600))) return
    // 4. fly to the persona's order; start the agents meanwhile
    const runP = createRun(tenant, story.event.id, 'Story').then(r => { onRun(r); return r }, e => { throw e })
    runP.catch(() => { /* reported in step 5 */ })
    flyKey++
    show({ phase: 3, caption: story.persona.caption, focus: story.persona.path, flyKey })
    if (!(await wait(story.persona.path.length * 950 + 1700))) return
    // 5. the agents fix it: plain captions from the real run
    show({ phase: 4, caption: story.captions.agents })
    let lines: string[]
    let run: Run | null = null
    try {
      run = (await Promise.race([runP, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), 12000))])).data
      const pick = ['sentinel:alert', 'impact_analyst', 'finance', 'verifier']
      lines = pick.map(k => run!.decisions.find(d => (k.includes(':') ? `${d.agent}:${d.kind}` === k : d.agent === k)))
        .filter(Boolean).map(d => plain(firstSentence(d!.summary)))
    } catch {
      lines = ['The agents could not be reached just now; the rest of the story still holds.']
    }
    if (!alive()) return
    for (let i = 1; i <= lines.length; i++) {
      show({ phase: 4, caption: story.captions.agents, lines: lines.slice(0, i) })
      if (!(await wait(1500))) return
    }
    if (!(await wait(900))) return
    // 6. memory: seen this before
    const rec = run?.recall[0]
    show({
      phase: 5, caption: story.captions.memory,
      lines: rec ? [plain(`${rec.event_name}, ${monthYear(rec.when)}: ${rec.action}.`), plain(`${rec.outcome}.`)] : [],
    })
    if (!(await wait(5200))) return
    stop()
  }, [tenant, eventId, onRun, stop])

  useEffect(() => {
    if (!view) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stop() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, stop])

  return { view, loading, error, play, stop }
}

export function StoryCaption({ view, onSkip }: { view: StoryView; onSkip: () => void }) {
  return (
    <div className="story-caption" role="status" aria-live="polite">
      <div className="story-text" key={`${view.phase}:${view.caption}`}>
        {view.count ? <CountCaption text={view.caption} to={view.count.to} /> : view.caption}
      </div>
      {view.lines.length > 0 && (
        <div className="story-sub">{view.lines.map((l, i) => <div key={i}>{l}</div>)}</div>
      )}
      <div className="story-foot">
        <div className="story-dots" aria-label={`Step ${view.phase + 1} of ${PHASES}`}>
          {Array.from({ length: PHASES }, (_, i) => <i key={i} className={i <= view.phase ? 'on' : ''} />)}
        </div>
        <span className="notice" style={{ fontSize: 13 }}>Step {view.phase + 1} of {PHASES}</span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onSkip}>Skip story</button>
      </div>
    </div>
  )
}

/** The caption with its first number counting up from zero (display only; the number is the API's). */
function CountCaption({ text, to }: { text: string; to: number }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    // A timer, not requestAnimationFrame: it must reach the real number even if the window is
    // not painting (backgrounded, screen recorder quirks).
    const t0 = Date.now()
    const id = window.setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / 1300)
      setN(Math.round(to * (1 - Math.pow(1 - k, 3))))
      if (k >= 1) window.clearInterval(id)
    }, 40)
    return () => window.clearInterval(id)
  }, [to])
  const m = text.match(/\d[\d,]*/)
  if (!m || m.index == null) return <>{text}</>
  return (
    <>
      {text.slice(0, m.index)}
      <span className="story-count">{num(n)}</span>
      {text.slice(m.index + m[0].length)}
    </>
  )
}
