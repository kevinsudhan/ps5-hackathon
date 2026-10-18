import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Answer, AskGraph, NodeKind, Run, Tone } from '../api/types'
import { placeAnswer, type Placed } from '../lib/answerLayout'
import { kindWord, num, toneWord } from '../lib/format'
import { usePrefersReducedMotion } from '../lib/motion'
import { simplify, MAX_VISIBLE } from '../lib/simplify'
import AnswerGraph, { KindIcon, type Pick } from './AnswerGraph'
import type { TraceHighlight } from './AgentTrace'

// The globe and 3D views are their own chunks; if one or WebGL fails, the 2D diagram still works.
const Graph3D = lazy(() => import('./Graph3D'))
const WorldMap = lazy(() => import('./WorldMap'))
const OrderTimeline = lazy(() => import('./OrderTimeline'))
const AgentRunGraph = lazy(() => import('./AgentRunGraph'))
const AgentTrace = lazy(() => import('./AgentTrace'))

/** Diagram, globe, the order timeline (why-late answers) and how the agents worked (once a run exists). */
export type StageView = '2d' | '3d' | 'map' | 'timeline' | 'agents'
const VIEW_LABEL: Record<StageView, string> = { '2d': 'Diagram', '3d': '3D', map: 'Globe', timeline: 'Timeline', agents: 'Agents' }

interface Props {
  graph: AskGraph | null
  animKey: string
  loading: boolean
  title?: string
  reveal?: number | null
  focus?: string[] | null
  flyKey?: number
  story: boolean
  view: StageView
  onView: (v: StageView) => void
  tenant: string
  eventId: string | null
  answer: Answer | null
  run: Run | null
  children?: ReactNode
}

const TONE_VAR: Record<Tone, string> = { danger: 'var(--danger)', warning: 'var(--delayed)', good: 'var(--ok)', neutral: 'var(--other)', muted: 'var(--mauve)' }
const TONE_TEXT: Record<Tone, string> = { danger: 'var(--danger-text)', warning: 'var(--delayed)', good: 'var(--ok)', neutral: 'var(--text-2)', muted: 'var(--text-2)' }
const TONE_LEGEND: Record<Tone, string> = { danger: 'closed or late', warning: 'delayed', good: 'on track', neutral: 'other', muted: 'context' }

export function GraphStage({ graph, animKey, loading, title, reveal, focus, flyKey, story, view: wanted, onView, tenant, eventId, answer, run, children }: Props) {
  // Which views make sense right now; anything else falls back to the diagram.
  const offered: StageView[] = story ? ['2d', 'map']
    : ['2d', 'map', ...(answer?.template === 'why_late' ? ['timeline' as const] : []), ...(run ? ['agents' as const] : [])]
  const view: StageView = offered.includes(wanted) ? wanted : '2d'
  // Split view: the diagram or globe on the left, "Step by step" on the right. A picked step lights
  // up the graph ids it touched (2D: the diagram's focus; globe: its highlight).
  const [splitOn, setSplitOn] = useState(false)
  const split = splitOn && !story && !!answer && (view === '2d' || view === 'map')
  const [hl, setHl] = useState<TraceHighlight | null>(null)
  const [hlFly, setHlFly] = useState(0)
  useEffect(() => { setHl(null) }, [animKey, split])
  const onHighlight = (h: TraceHighlight | null) => { setHl(h); if (h) setHlFly(k => k + 1) }
  const focus2d = hl?.ids.length ? hl.ids : focus
  const fly2d = hl?.ids.length ? hlFly : flyKey
  const reduced = usePrefersReducedMotion()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pick, setPick] = useState<{ p: Pick; x: number; y: number } | null>(null)
  useEffect(() => { setExpanded(new Set()); setPick(null) }, [animKey])
  useEffect(() => { setPick(null) }, [view, story])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPick(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const placed = useMemo(() => {
    if (!graph) return null
    const d = simplify(graph, new Set(focus ?? []), expanded, story ? 60 : MAX_VISIBLE)
    return { placed: placeAnswer(d), folded: d.folded }
  }, [graph, focus, expanded, story])

  // a new answer crossfades over the old one instead of a hard reset (2D)
  const [leaving, setLeaving] = useState<{ placed: Placed; key: string } | null>(null)
  const last = useRef<{ placed: Placed; key: string } | null>(null)
  useEffect(() => {
    const prev = last.current
    if (placed && prev && prev.key !== animKey && !reduced && view === '2d') {
      setLeaving(prev)
      const t = window.setTimeout(() => setLeaving(null), 420)
      last.current = { placed: placed.placed, key: animKey }
      return () => clearTimeout(t)
    }
    if (placed) last.current = { placed: placed.placed, key: animKey }
  }, [placed, animKey, reduced, view])

  const kinds = useMemo(() => [...new Set(placed?.placed.nodes.map(p => p.node.kind) ?? [])] as NodeKind[], [placed])
  const tones = useMemo(() => {
    const t = new Set(placed?.placed.nodes.map(p => p.node.tone) ?? [])
    return (['danger', 'warning', 'good', 'neutral'] as Tone[]).filter(x => t.has(x))
  }, [placed])
  const onExpand = (parent: string) => setExpanded(s => new Set(s).add(parent))
  const onPick = (p: Pick | null, at: { x: number; y: number }) => setPick(p ? { p, ...at } : null)

  return (
    <div className={`stage-wrap${split ? ' split' : ''}`}>
    <section className="stage" aria-label="The answer as a graph">
      {placed && view === '2d' && (
        <div className="stage-layer" key={`in-${animKey}`}>
          <AnswerGraph placed={placed.placed} animKey={animKey} reduced={reduced} reveal={reveal} focus={focus2d} flyKey={fly2d}
            selectedId={pick?.p.type === 'node' ? pick.p.node.id : null} onPick={onPick} onExpand={onExpand} />
        </div>
      )}
      {leaving && view === '2d' && (
        <div className="stage-layer leaving" key={`out-${leaving.key}`} aria-hidden>
          <AnswerGraph placed={leaving.placed} animKey={leaving.key} reduced onPick={() => {}} onExpand={() => {}} />
        </div>
      )}
      {placed && view === '3d' && (
        <ThreeBoundary onFail={() => onView('2d')}>
          <Suspense fallback={<div className="stage-empty"><span className="spinner" /></div>}>
            <Graph3D placed={placed.placed} animKey={animKey} reduced={reduced} reveal={reveal} focus={focus} flyKey={flyKey}
              selectedId={pick?.p.type === 'node' ? pick.p.node.id : null} onPick={onPick} onExpand={onExpand} />
          </Suspense>
        </ThreeBoundary>
      )}
      {graph && view === 'map' && (
        <ThreeBoundary onFail={() => onView('2d')}>
          <Suspense fallback={<div className="stage-empty"><span className="spinner" /></div>}>
            <WorldMap tenant={tenant} graph={graph} animKey={animKey} template={answer?.template} reduced={reduced} story={story}
              reveal={reveal} focus={focus} flyKey={flyKey} onPick={onPick} highlight={split ? hl : null} />
          </Suspense>
        </ThreeBoundary>
      )}
      {answer && view === 'timeline' && (
        <Suspense fallback={<div className="stage-empty"><span className="spinner" /></div>}>
          <OrderTimeline tenant={tenant} eventId={eventId} answer={answer} reduced={reduced} />
        </Suspense>
      )}
      {run && view === 'agents' && (
        <Suspense fallback={<div className="stage-empty"><span className="spinner" /></div>}>
          <AgentRunGraph tenant={tenant} run={run} reduced={reduced} />
        </Suspense>
      )}
      {!graph && loading && <div className="stage-skeleton" aria-label="Loading the answer"><i /><i /><i /><i /><i /></div>}
      {graph && loading && <div className="stage-busy"><span className="spinner" /> Updating the answer…</div>}

      <div className="stage-top">
        {!story && title && <div className="stage-title">{title}{placed && placed.folded > 0 && <span> · {num(placed.folded)} folded into “more” nodes, click to expand</span>}</div>}
        <span className="spacer" />
        {graph && !story && view === '2d' && <span className="stage-hint">Hover to trace a path · click for why</span>}
        {graph && !story && answer && (view === '2d' || view === 'map') && (
          <button className={`btn btn-sm split-toggle${split ? ' on' : ''}`} aria-pressed={split} onClick={() => setSplitOn(v => !v)}
            title="Show, step by step, how the answer was worked out in FalkorDB">Step by step</button>
        )}
        {graph && (
          <div className="segmented small" role="radiogroup" aria-label="View">
            {offered.map(v => (
              <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => onView(v)}>{VIEW_LABEL[v]}</button>
            ))}
          </div>
        )}
      </div>

      {graph && !story && view === '2d' && (
        <div className="legend" aria-label="Legend">
          {kinds.map(k => (
            <span key={k}><svg width="16" height="16" aria-hidden><KindIcon kind={k} x={8} y={8} color="var(--text-2)" small /></svg>{kindWord(k)}</span>
          ))}
          <span className="legend-sep" aria-hidden />
          {tones.map(t => <span key={t}><i className="dot" style={{ background: TONE_VAR[t] }} />{TONE_LEGEND[t]}</span>)}
        </div>
      )}

      {pick && <WhyPanel pick={pick.p} onClose={() => setPick(null)} />}
      {hl?.label && <div className="stage-highlight" role="status">{hl.label}</div>}
      {children}
    </section>
    {split && (
      <aside className="trace-pane" aria-label="Step by step: how it was worked out">
        <Suspense fallback={<div className="stage-empty"><span className="spinner" /></div>}>
          <AgentTrace tenant={tenant} eventId={eventId} answer={answer} run={run} reduced={reduced}
            highlightKey={hl?.key ?? null} onHighlight={onHighlight} />
        </Suspense>
      </aside>
    )}
    </div>
  )
}

function WhyPanel({ pick, onClose }: { pick: Pick; onClose: () => void }) {
  const isNode = pick.type === 'node'
  const tone = isNode ? pick.node.tone : pick.link.tone
  const word = isNode ? (pick.node.blocked ? 'Closed' : toneWord(pick.node.tone, pick.node.kind)) : toneWord(pick.link.tone)
  const lines = (isNode ? pick.node.why : pick.link.why).slice(0, 3)
  const title = isNode ? pick.node.label : pick.link.label ?? 'Connection'
  return (
    <aside className="why-panel" role="dialog" aria-label={`Why: ${title}`}>
      <button className="close-x" onClick={onClose} aria-label="Close">×</button>
      <div className="why-kind">
        <span>{isNode ? kindWord(pick.node.kind) : 'Connection'}</span>
        {word && <span className="tone-tag" style={{ color: TONE_TEXT[tone] }}><i className="dot" style={{ background: TONE_VAR[tone] }} />{word}</span>}
      </div>
      <div className="why-title">{title}</div>
      {isNode && pick.node.metric && <div className="why-metric">{pick.node.metric.label}</div>}
      {lines.length > 0 && <ul>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </aside>
  )
}

class ThreeBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { setTimeout(this.props.onFail, 2500) }
  render() {
    if (this.state.failed) return <div className="stage-empty">This view could not start on this machine; switching back to the diagram.</div>
    return this.props.children
  }
}
