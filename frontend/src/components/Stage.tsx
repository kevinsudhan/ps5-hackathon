import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import type { AskGraph } from '../api/types'
import { kindWord, TONE_COLOR, toneWord } from '../lib/format'
import type { Pick } from './Graph3D'
import Diagram2D from './Diagram2D'

// The 3D view is its own chunk; if it or WebGL fails, the 2D diagram, answer and tabs still work.
const Graph3D = lazy(() => import('./Graph3D'))

interface Props {
  graph: AskGraph | null
  loading: boolean
  title?: string
  note?: string
  reveal?: number | null
  focus?: string[] | null
  flyKey?: number
  story: boolean
  view: '2d' | '3d'
  onView: (v: '2d' | '3d') => void
  children?: ReactNode          // overlays (story captions, buttons)
}

export function Stage({ graph, loading, title, note, reveal, focus, flyKey, story, view, onView, children }: Props) {
  const [pick, setPick] = useState<{ p: Pick; x: number; y: number } | null>(null)
  useEffect(() => { setPick(null) }, [graph, story, view])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPick(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <section className="stage" aria-label="Graph of the answer">
      {graph && view === '2d' && (
        <Diagram2D
          graph={graph} reveal={reveal} focus={focus} flyKey={flyKey}
          selectedId={pick?.p.type === 'node' ? pick.p.node.id : null}
          onPick={(p, at) => setPick(p ? { p, ...at } : null)}
        />
      )}
      {graph && view === '3d' && (
        <ThreeBoundary onFail={() => onView('2d')}>
          <Suspense fallback={<div className="stage-empty"><span className="spinner" /></div>}>
            <Graph3D
              graph={graph} reveal={reveal} focus={focus} flyKey={flyKey}
              selectedId={pick?.p.type === 'node' ? pick.p.node.id : null}
              onPick={(p, at) => setPick(p ? { p, ...at } : null)}
            />
          </Suspense>
        </ThreeBoundary>
      )}
      {!graph && (
        <div className="stage-empty">{loading ? <span className="spinner" /> : 'Ask a question to see its answer as a graph.'}</div>
      )}

      <div className="stage-top">
        {!story && (title || note) && (
          <div className="stage-title">
            {title && <b>{title}</b>}
            {note}
          </div>
        )}
        <span className="spacer" />
        {graph && (
          <div className="engine-switch view-switch" role="radiogroup" aria-label="View">
            <button role="radio" aria-checked={view === '2d'} className={view === '2d' ? 'on' : ''} onClick={() => onView('2d')}>2D</button>
            <button role="radio" aria-checked={view === '3d'} className={view === '3d' ? 'on' : ''} onClick={() => onView('3d')}>3D</button>
          </div>
        )}
      </div>

      {graph && !story && (
        <div className="legend" aria-hidden>
          <span><i className="dot" style={{ background: TONE_COLOR.danger }} />closed or late</span>
          <span><i className="dot" style={{ background: TONE_COLOR.warning }} />delayed</span>
          <span><i className="dot" style={{ background: TONE_COLOR.good }} />on track</span>
          <span><i className="dot" style={{ background: TONE_COLOR.neutral }} />other</span>
          <span style={{ color: 'var(--ink-3)' }}>Click anything to see why · drag to turn</span>
        </div>
      )}

      {pick && <WhyCard pick={pick.p} x={pick.x} y={pick.y} onClose={() => setPick(null)} />}
      {children}
    </section>
  )
}

function WhyCard({ pick, x, y, onClose }: { pick: Pick; x: number; y: number; onClose: () => void }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const isNode = pick.type === 'node'
  const tone = isNode ? pick.node.tone : pick.link.tone
  const word = isNode ? toneWord(pick.node.tone, pick.node.kind) : toneWord(pick.link.tone)
  const lines = (isNode ? pick.node.why : pick.link.why).slice(0, 3)
  const title = isNode ? pick.node.label : pick.link.label ?? 'Connection'
  // keep the card inside the stage
  const left = box ? Math.min(Math.max(12, x + 14), box.w - 312) : x + 14
  const top = box ? Math.min(Math.max(12, y - 20), box.h - 190) : y - 20
  return (
    <div
      className="why-card" style={{ left, top }} role="dialog" aria-label={title}
      ref={el => {
        const s = el?.parentElement
        if (s && (!box || box.w !== s.clientWidth || box.h !== s.clientHeight)) setBox({ w: s.clientWidth, h: s.clientHeight })
      }}
    >
      <button className="close-x" onClick={onClose} aria-label="Close">×</button>
      <div className="why-kind">
        <span>{isNode ? kindWord(pick.node.kind) : 'Connection'}</span>
        {word && <span className="tone-tag" style={{ color: TONE_COLOR[tone] }}><i className="dot" style={{ background: TONE_COLOR[tone] }} />{word}</span>}
      </div>
      <div className="why-title">{title}</div>
      {lines.length > 0 && <ul>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </div>
  )
}

class ThreeBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { setTimeout(this.props.onFail, 2500) }
  render() {
    if (this.state.failed) {
      return <div className="stage-empty">The 3D view could not start on this machine; switching back to 2D.</div>
    }
    return this.props.children
  }
}
