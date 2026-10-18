import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AskGraph, NodeKind, Tone } from '../api/types'
import { placeAnswer, type Placed } from '../lib/answerLayout'
import { kindWord, num, toneWord } from '../lib/format'
import { usePrefersReducedMotion } from '../lib/motion'
import { simplify, MAX_VISIBLE } from '../lib/simplify'
import AnswerGraph, { KindIcon, type Pick } from './AnswerGraph'

// The 3D view is its own chunk; if it or WebGL fails, the 2D diagram still works.
const Graph3D = lazy(() => import('./Graph3D'))

interface Props {
  graph: AskGraph | null
  animKey: string
  loading: boolean
  title?: string
  reveal?: number | null
  focus?: string[] | null
  flyKey?: number
  story: boolean
  view: '2d' | '3d'
  onView: (v: '2d' | '3d') => void
  children?: ReactNode
}

const TONE_VAR: Record<Tone, string> = { danger: 'var(--danger)', warning: 'var(--delayed)', good: 'var(--ok)', neutral: 'var(--other)', muted: 'var(--mauve)' }
const TONE_TEXT: Record<Tone, string> = { danger: 'var(--danger-text)', warning: 'var(--delayed)', good: 'var(--ok)', neutral: 'var(--text-2)', muted: 'var(--text-2)' }
const TONE_LEGEND: Record<Tone, string> = { danger: 'closed or late', warning: 'delayed', good: 'on track', neutral: 'other', muted: 'context' }

export function GraphStage({ graph, animKey, loading, title, reveal, focus, flyKey, story, view, onView, children }: Props) {
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
    <section className="stage" aria-label="The answer as a graph">
      {placed && view === '2d' && (
        <div className="stage-layer" key={`in-${animKey}`}>
          <AnswerGraph placed={placed.placed} animKey={animKey} reduced={reduced} reveal={reveal} focus={focus} flyKey={flyKey}
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
      {!graph && loading && <div className="stage-skeleton" aria-label="Loading the answer"><i /><i /><i /><i /><i /></div>}
      {graph && loading && <div className="stage-busy"><span className="spinner" /> Updating the answer…</div>}

      <div className="stage-top">
        {!story && title && <div className="stage-title">{title}{placed && placed.folded > 0 && <span> · {num(placed.folded)} folded into “more” nodes, click to expand</span>}</div>}
        <span className="spacer" />
        {graph && !story && view === '2d' && <span className="stage-hint">Hover to trace a path · click for why</span>}
        {graph && (
          <div className="segmented small" role="radiogroup" aria-label="View">
            <button role="radio" aria-checked={view === '2d'} className={view === '2d' ? 'on' : ''} onClick={() => onView('2d')}>2D</button>
            <button role="radio" aria-checked={view === '3d'} className={view === '3d' ? 'on' : ''} onClick={() => onView('3d')}>3D</button>
          </div>
        )}
      </div>

      {graph && !story && (
        <div className="legend" aria-label="Legend">
          {kinds.map(k => (
            <span key={k}><svg width="16" height="16" aria-hidden><KindIcon kind={k} x={8} y={8} color="var(--text-2)" small /></svg>{kindWord(k)}</span>
          ))}
          <span className="legend-sep" aria-hidden />
          {tones.map(t => <span key={t}><i className="dot" style={{ background: TONE_VAR[t] }} />{TONE_LEGEND[t]}</span>)}
        </div>
      )}

      {pick && <WhyPanel pick={pick.p} onClose={() => setPick(null)} />}
      {children}
    </section>
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
    if (this.state.failed) return <div className="stage-empty">The 3D view could not start on this machine; switching back to 2D.</div>
    return this.props.children
  }
}
