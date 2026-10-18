import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AskNode, NodeKind, Tone } from '../api/types'
import { toneWord } from '../lib/format'
import { pathThrough, type PEdge, type Placed, type PNode } from '../lib/answerLayout'
import { useSize } from '../lib/useSize'
import type { DNode } from '../lib/simplify'

export type Pick = { type: 'node'; node: AskNode } | { type: 'link'; link: PEdge['link'] }

interface Props {
  placed: Placed
  animKey: string                 // a new answer replays the reveal
  reduced: boolean                // prefers-reduced-motion: fades only
  reveal?: number | null          // the story: steps beyond this are quiet
  focus?: string[] | null         // the story: a path to follow
  flyKey?: number
  selectedId?: string | null
  onPick: (p: Pick | null, at: { x: number; y: number }) => void
  onExpand: (parentId: string) => void
}

// Colours come from the design tokens (src/styles/tokens.css), never hard-coded here.
const TONE_VAR: Record<Tone, string> = { danger: 'var(--danger)', warning: 'var(--delayed)', good: 'var(--ok)', neutral: 'var(--other)', muted: 'var(--mauve)' }
const TONE_TEXT: Record<Tone, string> = { danger: 'var(--danger-text)', warning: 'var(--delayed)', good: 'var(--ok)', neutral: 'var(--text-2)', muted: 'var(--text-2)' }
const STAGGER = 150          // ms between columns of the reveal
const DRAW = 620             // ms an edge takes to draw itself

interface View { k: number; x: number; y: number }

export default function AnswerGraph({ placed: P, animKey, reduced, reveal = null, focus = null, flyKey = 0, selectedId = null, onPick, onExpand }: Props) {
  const [wrapRef, size] = useSize<HTMLDivElement>()
  const box = useRef<HTMLDivElement | null>(null)
  const setBox = useCallback((el: HTMLDivElement | null) => { box.current = el; wrapRef(el) }, [wrapRef])
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 })
  const [glide, setGlide] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const [flowing, setFlowing] = useState(false)
  const story = reveal != null

  // ---- reveal timing: cause -> effect, then the flow starts -----------------------------------
  const delayOf = useCallback((depth: number) => (reduced ? 0 : Math.round(depth * STAGGER)), [reduced])
  const revealMs = reduced ? 0 : delayOf(P.maxDepth) + DRAW + 200
  useEffect(() => {
    setFlowing(false)
    if (reduced) return
    const t = window.setTimeout(() => setFlowing(true), revealMs)
    return () => clearTimeout(t)
  }, [animKey, revealMs, reduced])

  // ---- camera: fit, fly to the story's focus, wheel zoom, drag pan -----------------------------
  // the stage's title row sits on top and its legend at the bottom: fit the answer between them
  const fitTo = useCallback((b: Placed['bounds'], maxK = 1.15, pad = story ? { t: 40, r: 30, b: 30, l: 30 } : { t: 56, r: 28, b: 62, l: 28 }) => {
    if (!size.width || !size.height) return
    const aw = Math.max(80, size.width - pad.l - pad.r), ah = Math.max(80, size.height - pad.t - pad.b)
    const k = Math.max(0.2, Math.min(maxK, aw / Math.max(1, b.x1 - b.x0), ah / Math.max(1, b.y1 - b.y0)))
    setGlide(true)
    setView({ k, x: pad.l + aw / 2 - ((b.x0 + b.x1) / 2) * k, y: pad.t + ah / 2 - ((b.y0 + b.y1) / 2) * k })
  }, [size.width, size.height, story])
  const fit = useCallback(() => fitTo(P.bounds), [fitTo, P])
  useEffect(() => { if (!focus?.length) fit() }, [fit, focus])
  useEffect(() => {
    if (!flyKey || !focus?.length) return
    const pts = focus.map(id => P.byId.get(id)).filter((p): p is PNode => !!p)
    if (!pts.length) return
    fitTo({ x0: Math.min(...pts.map(p => p.x - p.w / 2)), y0: Math.min(...pts.map(p => p.y - p.h / 2)),
            x1: Math.max(...pts.map(p => p.x + p.w / 2)), y1: Math.max(...pts.map(p => p.y + p.h / 2)) }, 1.25, { t: 90, r: 90, b: 90, l: 90 })
  }, [flyKey, focus, P, fitTo])

  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      setGlide(false)
      setView(v => {
        const k = Math.max(0.3, Math.min(2.6, v.k * Math.exp(-e.deltaY * 0.0015)))
        return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const at = (e: { clientX: number; clientY: number }) => {
    const r = box.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  // ---- what is highlighted ---------------------------------------------------------------------
  const lit = useMemo(() => (hover ? pathThrough(P, hover) : null), [P, hover])
  const focusSet = useMemo(() => new Set(focus ?? []), [focus])
  const focusPairs = useMemo(() => new Set((focus ?? []).flatMap((id, i, a) => (i ? [`${a[i - 1]}>${id}`, `${id}>${a[i - 1]}`] : []))), [focus])
  const quiet = (n: DNode) => story && n.step != null && n.step > (reveal ?? 0)
  const dimNode = (id: string) => (lit ? !lit.has(id) : focusSet.size > 0 && !focusSet.has(id))
  const dimEdge = (e: PEdge) => (lit ? !(lit.has(e.s.id) && lit.has(e.t.id)) : focusSet.size > 0 && !focusPairs.has(e.key))
  const maxMetric = useMemo(() => {
    const m = new Map<string, number>()
    P.nodes.forEach(p => { const u = `${p.node.kind}:${p.node.metric?.unit}`; if (p.node.metric) m.set(u, Math.max(m.get(u) ?? 0, p.node.metric.value)) })
    return m
  }, [P])
  const showLabels = (e: PEdge) => !!e.link.label && (hoverEdge === e.key || (!e.bus && (P.edges.length <= 12 || (lit != null && !dimEdge(e)))))
  const particles = useMemo(() => {
    if (!flowing || reduced || story) return []
    const out: { e: PEdge; i: number; n: number }[] = []
    P.edges.filter(e => !e.link.blocked).forEach(e => {
      const n = (e.link.weight ?? 0.3) > 0.5 ? 2 : 1
      for (let i = 0; i < n; i++) out.push({ e, i, n })
    })
    return out.slice(0, 56)
  }, [P, flowing, reduced, story])

  return (
    <div
      ref={setBox} className={`answer-graph${reduced ? ' reduced' : ''}`}
      onMouseDown={e => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false } }}
      onMouseMove={e => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.x, dy = e.clientY - d.y
        if (!d.moved && Math.hypot(dx, dy) < 4) return
        d.moved = true
        setGlide(false)
        setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
      }}
      onMouseUp={() => { window.setTimeout(() => { drag.current = null }, 0) }}
      onMouseLeave={() => { drag.current = null; setHover(null) }}
      onClick={e => { if (!drag.current?.moved && (e.target as Element).tagName === 'svg') onPick(null, at(e)) }}
    >
      <svg width={size.width} height={size.height} role="img" aria-label="The answer drawn as a graph" key={animKey}>
        <defs>
          <filter id="glow-danger" x="-20%" y="-50%" width="140%" height="200%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
          {P.edges.map(e => (
            <linearGradient key={e.key} id={`flow-${cssId(e.key)}`} gradientUnits="userSpaceOnUse" x1={e.s.x} y1={e.s.y} x2={e.t.x} y2={e.t.y}>
              <stop offset="0%" stopColor="var(--periwinkle)" />
              <stop offset="100%" stopColor="var(--mauve)" />
            </linearGradient>
          ))}
        </defs>
        <g style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: '0 0',
                    transition: glide ? 'transform 0.7s cubic-bezier(.22,.8,.24,1)' : 'none' }}>
          {/* edges: glow underlay for critical paths, then the line, which draws itself */}
          {P.edges.map(e => {
            const w = 1.3 + 3.4 * Math.min(1, e.link.weight ?? 0.25)
            const danger = e.link.tone === 'danger' && !e.link.blocked
            const stroke = e.link.blocked ? 'var(--danger)' : danger ? 'var(--danger)' : e.link.tone === 'good' ? 'var(--ok)' : `url(#flow-${cssId(e.key)})`
            const q = quiet(e.t.node)
            return (
              <g key={e.key} className={`edge${dimEdge(e) ? ' dim' : ''}${q ? ' quiet' : ''}`}
                 onMouseEnter={() => setHoverEdge(e.key)} onMouseLeave={() => setHoverEdge(h => (h === e.key ? null : h))}>
                {danger && !q && !e.bus && <path d={e.d} fill="none" stroke="var(--danger)" strokeWidth={w + 6} opacity={0.32} filter="url(#glow-danger)"
                  className="draw" pathLength={1} style={{ animationDelay: `${delayOf(e.depth)}ms` }} />}
                <path d={e.d} fill="none" stroke={stroke} strokeWidth={w} strokeLinecap="round"
                  strokeDasharray={e.link.blocked ? '6 7' : undefined}
                  className={e.link.blocked ? 'fade' : 'draw'} pathLength={e.link.blocked ? undefined : 1}
                  style={{ animationDelay: `${delayOf(e.depth)}ms` }} />
                <path d={e.d} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: 'pointer' }}
                  onClick={ev => { ev.stopPropagation(); if (!drag.current?.moved) onPick({ type: 'link', link: e.link }, at(ev)) }}>
                  <title>{e.link.label ?? ''}</title>
                </path>
              </g>
            )
          })}

          {/* flow: soft pulses travelling with the delay */}
          {particles.map(({ e, i, n }) => {
            const dur = 2.6 + (1 - Math.min(1, e.link.weight ?? 0.3)) * 1.6
            return (
              <circle key={`${e.key}-${i}`} r={e.link.tone === 'danger' ? 2.8 : 2.4} className={`particle${dimEdge(e) ? ' dim' : ''}`}
                fill={e.link.tone === 'danger' ? 'var(--danger-text)' : 'var(--periwinkle)'}>
                <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${-(i / n) * dur - (e.depth % 1) * dur}s`} path={e.d} />
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur={`${dur}s`} repeatCount="indefinite"
                  begin={`${-(i / n) * dur - (e.depth % 1) * dur}s`} />
              </circle>
            )
          })}

          {/* edge labels */}
          {P.edges.filter(showLabels).map(e => {
            const text = e.link.label!
            const w = text.length * 6.4 + 14
            return (
              <g key={`l-${e.key}`} className={`edge-label${dimEdge(e) ? ' dim' : ''}`} pointerEvents="none"
                 style={{ animationDelay: `${delayOf(e.depth) + DRAW * 0.6}ms` }}>
                <rect x={e.mid.x - w / 2} y={e.mid.y - 10} width={w} height={20} rx={10} />
                <text x={e.mid.x} y={e.mid.y + 4} textAnchor="middle">{text}</text>
              </g>
            )
          })}

          {/* nodes */}
          {P.nodes.map(p => p.compact
            ? <Mark key={p.id} p={p} delay={delayOf(p.depth)} dim={dimNode(p.id)} quiet={quiet(p.node)} selected={p.id === selectedId}
                focused={focusSet.has(p.id)} onEnter={() => setHover(p.id)} onLeave={() => setHover(h => (h === p.id ? null : h))}
                onClick={ev => { ev.stopPropagation(); if (!drag.current?.moved) onPick({ type: 'node', node: p.node }, at(ev)) }} />
            : <Card key={p.id} p={p} delay={delayOf(p.depth)} dim={dimNode(p.id)} quiet={quiet(p.node)} selected={p.id === selectedId}
                focused={focusSet.has(p.id)} max={maxMetric.get(`${p.node.kind}:${p.node.metric?.unit}`) ?? 0}
                onEnter={() => setHover(p.id)} onLeave={() => setHover(h => (h === p.id ? null : h))}
                onClick={ev => {
                  ev.stopPropagation()
                  if (drag.current?.moved) return
                  if (p.node.members?.length && p.node.parent) onExpand(p.node.parent)
                  else onPick({ type: 'node', node: p.node }, at(ev))
                }} />)}
        </g>
      </svg>
      <button className="btn btn-sm stage-recentre" onClick={e => { e.stopPropagation(); fit() }} title="Fit the whole answer in view">Re-centre</button>
    </div>
  )
}

const cssId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')

function Card({ p, delay, dim, quiet, selected, focused, max, onEnter, onLeave, onClick }: {
  p: PNode; delay: number; dim: boolean; quiet: boolean; selected: boolean; focused: boolean; max: number
  onEnter: () => void; onLeave: () => void; onClick: (e: React.MouseEvent) => void
}) {
  const n = p.node
  const x0 = p.x - p.w / 2, y0 = p.y - p.h / 2
  const tone = TONE_VAR[n.tone]
  const state = n.blocked ? 'Closed' : toneWord(n.tone, n.kind)
  const expandable = !!n.members?.length && !!n.parent
  const badge = n.rank ?? null      // rank in a ranked answer, step number in a chain, route option in a reroute
  const sub = expandable || !state ? p.sub : p.sub.slice(0, p.sub.length - state.length)
  const frac = n.metric && max > 0 ? Math.max(0.04, n.metric.value / max) : 0
  return (
    <g className={`node${dim ? ' dim' : ''}${quiet ? ' quiet' : ''}${selected || focused ? ' selected' : ''}${n.blocked ? ' blocked' : ''}${expandable ? ' expandable' : ''}`}
       style={{ animationDelay: `${delay}ms` }} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={onClick}>
      <title>{n.label}{n.metric ? ` · ${n.metric.label}` : ''}</title>
      <rect className="card" x={x0} y={y0} width={p.w} height={p.h} rx={13}
        style={{ stroke: selected || focused ? 'var(--text)' : n.blocked ? 'var(--danger)' : undefined }}
        strokeDasharray={expandable || n.blocked ? '5 5' : undefined} />
      <rect x={x0 + 1} y={y0 + 12} width={3} height={p.h - 24} rx={1.5} style={{ fill: tone }} />
      <KindIcon kind={n.kind} x={x0 + 22} y={y0 + 22} color={tone} />
      {p.lines.map((l, i) => <text key={i} className="card-title" x={x0 + 40} y={y0 + 26 + i * 17}>{l}</text>)}
      <text className="card-sub" x={x0 + 40} y={y0 + 26 + p.lines.length * 17 + 1}>
        {sub}{!expandable && state && <tspan style={{ fill: TONE_TEXT[n.tone] }} fontWeight={650}>{state}</tspan>}
      </text>
      {p.metricLines.map((l, i) => (
        <text key={`m${i}`} className="card-metric" x={x0 + 40} y={y0 + 26 + p.lines.length * 17 + 19 + i * 17}>{l}</text>
      ))}
      {frac > 0 && <rect x={x0 + 40} y={y0 + p.h - 8} width={(p.w - 54) * frac} height={3} rx={1.5} style={{ fill: tone }} opacity={0.75} />}
      {badge != null && (
        <g className="rank-badge">
          <circle cx={x0 + 2} cy={y0 + 2} r={11} />
          <text x={x0 + 2} y={y0 + 6} textAnchor="middle">{badge}</text>
        </g>
      )}
    </g>
  )
}

function Mark({ p, delay, dim, quiet, selected, focused, onEnter, onLeave, onClick }: {
  p: PNode; delay: number; dim: boolean; quiet: boolean; selected: boolean; focused: boolean
  onEnter: () => void; onLeave: () => void; onClick: (e: React.MouseEvent) => void
}) {
  const tone = TONE_VAR[p.node.tone]
  return (
    <g className={`node mark${dim ? ' dim' : ''}${quiet ? ' quiet' : ''}${selected || focused ? ' selected' : ''}`}
       style={{ animationDelay: `${delay}ms` }} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={onClick}>
      <title>{p.node.label}</title>
      <circle className="card" cx={p.x} cy={p.y} r={p.w / 2} />
      <KindIcon kind={p.node.kind} x={p.x} y={p.y} color={tone} small />
      {focused && (
        <g pointerEvents="none" className="focus-tag">
          <rect x={p.x + 14} y={p.y - 13} width={p.node.label.length * 7 + 18} height={26} rx={9} />
          <text x={p.x + 23} y={p.y + 4.5}>{p.node.label}</text>
        </g>
      )}
    </g>
  )
}

/** One shape per kind, the same vocabulary as the legend and the 3D view. */
export function KindIcon({ kind, x, y, color, small }: { kind: NodeKind; x: number; y: number; color: string; small?: boolean }) {
  const s = small ? 5 : 7
  const fill = { fill: color }
  switch (kind) {
    case 'event': return <path d={`M${x},${y - s - 1} L${x + s + 1},${y} L${x},${y + s + 1} L${x - s - 1},${y} Z`} style={fill} />
    case 'port': return <circle cx={x} cy={y} r={s} style={fill} />
    case 'airport': return <path d={`M${x},${y - s} L${x + s},${y + s * 0.8} L${x - s},${y + s * 0.8} Z`} style={fill} />
    case 'warehouse': return <rect x={x - s + 0.5} y={y - s + 0.5} width={2 * s - 1} height={2 * s - 1} rx={2} style={fill} />
    case 'factory': return <path d={Array.from({ length: 6 }, (_, i) => `${i ? 'L' : 'M'}${x + s * Math.cos(i * Math.PI / 3)},${y + s * Math.sin(i * Math.PI / 3)}`).join(' ') + 'Z'} style={fill} />
    case 'shipment': return <rect x={x - s - 1} y={y - s * 0.55} width={2 * s + 2} height={s * 1.1} rx={s * 0.55} style={fill} />
    case 'place': return <circle cx={x} cy={y} r={s - 1} fill="none" style={{ stroke: color }} strokeWidth={2.5} />
    case 'group': return <g style={fill}><circle cx={x - 2.5} cy={y + 1} r={s * 0.6} /><circle cx={x + 3} cy={y - 2} r={s * 0.6} opacity={0.7} /></g>
    case 'order': return <circle cx={x} cy={y} r={s * 0.62} style={fill} />
    default: return <circle cx={x} cy={y} r={s} style={fill} />
  }
}
