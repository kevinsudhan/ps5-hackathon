import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AskGraph, AskNode, NodeKind, Tone } from '../api/types'
import { layoutGraph, type LCard, type Layout } from '../lib/layout'
import { kindWord, TONE_COLOR, toneWord } from '../lib/format'
import { useSize } from '../lib/useSize'
import type { Pick } from './Graph3D'

interface Props {
  graph: AskGraph
  reveal?: number | null
  focus?: string[] | null
  flyKey?: number
  selectedId?: string | null
  onPick: (pick: Pick | null, at: { x: number; y: number }) => void
}

const QUIET = '#c9ccd2'
const RGB: Record<Tone, string> = {
  danger: '208, 59, 59', warning: '232, 160, 28', good: '31, 157, 92', neutral: '107, 122, 144', muted: '150, 150, 150',
}

interface View { k: number; x: number; y: number }

export default function Diagram2D({ graph, reveal = null, focus = null, flyKey = 0, selectedId = null, onPick }: Props) {
  const [wrapRef, size] = useSize<HTMLDivElement>()
  const box = useRef<HTMLDivElement | null>(null)
  const setBox = useCallback((el: HTMLDivElement | null) => { box.current = el; wrapRef(el) }, [wrapRef])
  const L = useMemo(() => layoutGraph(graph), [graph])
  const byId = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph])
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 })
  const [animate, setAnimate] = useState(false)
  const [hover, setHover] = useState<string | null>(null)

  const quiet = useCallback((n: AskNode | undefined) => !!n && reveal != null && n.step != null && n.step > reveal, [reveal])
  const focusSet = useMemo(() => new Set(focus ?? []), [focus])
  const focusPairs = useMemo(() => {
    const s = new Set<string>()
    focus?.forEach((id, i) => { if (i) { s.add(`${focus[i - 1]}>${id}`); s.add(`${id}>${focus[i - 1]}`) } })
    return s
  }, [focus])

  // ---- camera: fit, fly, wheel zoom, drag pan --------------------------------------------------
  const fitTo = useCallback((b: Layout['bounds'], maxK = 1.25, pad = 36, minK = 0.68) => {
    if (!size.width || !size.height) return
    const bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2
    // never shrink text below a readable size; if it does not all fit, show the left (start of
    // the story) and let people drag for the rest
    const k = Math.max(minK, Math.min(maxK, size.width / bw, size.height / bh))
    const fitsW = bw * k <= size.width, fitsH = bh * k <= size.height
    setAnimate(true)
    setView({
      k,
      x: fitsW ? size.width / 2 - ((b.x0 + b.x1) / 2) * k : pad - b.x0 * k,
      y: fitsH ? size.height / 2 - ((b.y0 + b.y1) / 2) * k : pad + 40 - b.y0 * k,
    })
  }, [size.width, size.height])
  // first glance shows the whole answer; on short screens that means zooming out a little more
  const minK = reveal != null ? 0.4 : size.height < 450 ? 0.5 : 0.68
  const fit = useCallback(() => fitTo(L.bounds, 1.25, 36, minK), [fitTo, L, minK])
  useEffect(() => { if (!focus?.length) fit() }, [fit, focus])

  const timers = useRef<number[]>([])
  useEffect(() => {
    timers.current.forEach(clearTimeout); timers.current = []
    if (!flyKey || !focus?.length || !size.width) return
    const pts = focus.map(id => L.pos.get(id)).filter((p): p is { x: number; y: number } => !!p)
    if (!pts.length) return
    const STEP = 950
    pts.forEach((p, i) => timers.current.push(window.setTimeout(() => {
      const k = 1.35
      setAnimate(true)
      setView({ k, x: size.width / 2 - p.x * k, y: size.height * 0.42 - p.y * k })
    }, i * STEP)))
    timers.current.push(window.setTimeout(() => {
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      fitTo({ x0: Math.min(...xs) - 120, y0: Math.min(...ys) - 60, x1: Math.max(...xs) + 120, y1: Math.max(...ys) + 60 }, 1.3, 40)
    }, pts.length * STEP + 300))
    return () => timers.current.forEach(clearTimeout)
  }, [flyKey, focus, L, size.width, size.height, fitTo])

  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect()
    const px = e.clientX - r.left, py = e.clientY - r.top
    const k = Math.min(3, Math.max(0.25, view.k * Math.exp(-e.deltaY * 0.0015)))
    setAnimate(false)
    setView({ k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k })
  }
  const at = (e: React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // ---- geometry -----------------------------------------------------------------------------
  const cardOf = useMemo(() => new Map(L.cards.map(c => [c.node.id, c])), [L])
  const bundleOf = useMemo(() => {
    const m = new Map(L.dots.map(d => [d.node.id, L.bundles.find(b => b.id === d.bundle)!]))
    L.bundles.forEach(b => { if (b.more) m.set(b.more.node.id, b) })
    return m
  }, [L])
  const boxOf = (id: string) => {
    const c = cardOf.get(id)
    if (c) return { x: c.x, y: c.y, w: c.w, h: c.h, col: c.col, row: c.row }
    const b = bundleOf.get(id)
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h, col: b.col, row: 0 } : null
  }
  // one drawn link per pair of boxes (a bundle of 15 orders gets one link, not 15)
  const drawn = useMemo(() => {
    const seen = new Set<string>()
    const out: { key: string; d: string; tone: Tone; source: string; target: string; link: (typeof L.edges)[number] | null }[] = []
    for (const e of L.edges) {
      const a = boxOf(e.source), b = boxOf(e.target)
      if (!a || !b) continue
      const ka = cardOf.has(e.source) ? e.source : bundleOf.get(e.source)!.id
      const kb = cardOf.has(e.target) ? e.target : bundleOf.get(e.target)!.id
      const key = L.mode === 'radial' ? [ka, kb].sort().join('~') : `${ka}>${kb}`
      if (seen.has(key)) continue
      seen.add(key)
      let d: string
      if (L.mode === 'layered' && b.row > a.row) {
        // wrapped chain: from under the end of one line to above the start of the next
        const y1 = a.y + a.h / 2, y2 = b.y - b.h / 2
        d = `M${a.x},${y1} C${a.x},${y1 + 70} ${b.x},${y2 - 70} ${b.x},${y2}`
      } else if (L.mode === 'layered' && b.col > a.col) {
        const x1 = a.x + a.w / 2, x2 = b.x - b.w / 2, dx = Math.max(40, (x2 - x1) * 0.5)
        d = `M${x1},${a.y} C${x1 + dx},${a.y} ${x2 - dx},${b.y} ${x2},${b.y}`
      } else {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
        const nx = -(b.y - a.y) * 0.12, ny = (b.x - a.x) * 0.12
        d = `M${a.x},${a.y} Q${mx + nx},${my + ny} ${b.x},${b.y}`
      }
      out.push({ key, d, tone: e.tone, source: e.source, target: e.target, link: e.bundled ? null : e })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, cardOf, bundleOf])

  const faded = (id: string) => focusSet.size > 0 && !focusSet.has(id)
  const toneFor = (n: AskNode | undefined): Tone | 'quiet' => (n ? (quiet(n) ? 'quiet' : n.tone) : 'muted')
  const color = (t: Tone | 'quiet') => (t === 'quiet' ? QUIET : TONE_COLOR[t])

  return (
    <div
      ref={setBox}
      className="diagram"
      style={{ position: 'absolute', inset: 0, cursor: drag.current?.moved ? 'grabbing' : 'grab' }}
      onWheel={onWheel}
      onMouseDown={e => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false } }}
      onMouseMove={e => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.x, dy = e.clientY - d.y
        if (!d.moved && Math.hypot(dx, dy) < 4) return
        d.moved = true
        setAnimate(false)
        setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
      }}
      onMouseUp={() => { setTimeout(() => { drag.current = null }, 0) }}
      onMouseLeave={() => { drag.current = null; setHover(null) }}
      onClick={e => { if (!drag.current?.moved && e.target === e.currentTarget.querySelector('svg')) onPick(null, at(e)) }}
    >
      <svg width={size.width} height={size.height} role="img" aria-label="Diagram of the answer">
        <g style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: '0 0', transition: animate ? 'transform 0.75s cubic-bezier(.3,.7,.2,1)' : 'none' }}>
          {/* bundles: a soft frame around each block of orders */}
          {L.bundles.map(b => {
            const t = b.members.every(m => quiet(byId.get(m))) ? 'quiet' : b.tone
            const fade = focusSet.size > 0 && !b.members.some(m => focusSet.has(m))
            return (
              <g key={b.id} opacity={fade ? 0.25 : 1}>
                <rect x={b.x - b.w / 2} y={b.y - b.h / 2} width={b.w} height={b.h} rx={10}
                  fill={t === 'quiet' ? '#f4f4f2' : `rgba(${RGB[t]}, 0.06)`} stroke={t === 'quiet' ? '#e3e3e0' : `rgba(${RGB[t]}, 0.28)`} />
                {b.more && (
                  <text x={b.x - b.w / 2 + 10} y={b.more.y + 4} fontSize={12} fontWeight={600} fill="#52514e" style={{ cursor: 'pointer' }}
                    onClick={ev => { ev.stopPropagation(); if (!drag.current?.moved) onPick({ type: 'node', node: b.more!.node }, at(ev)) }}>
                    {b.more.node.label}
                  </text>
                )}
              </g>
            )
          })}

          {/* links */}
          {drawn.map(e => {
            const inFocus = focusPairs.has(`${e.source}>${e.target}`)
            const target = byId.get(e.target)
            const t: Tone | 'quiet' = quiet(target) ? 'quiet' : e.tone
            const fade = focusSet.size > 0 && !inFocus
            const stroke = inFocus ? '#1b1b1a' : t === 'quiet' ? QUIET : `rgba(${RGB[t]}, ${t === 'muted' ? 0.45 : 0.6})`
            return (
              <g key={e.key} opacity={fade ? 0.18 : 1}>
                <path d={e.d} fill="none" stroke={stroke} strokeWidth={inFocus ? 2.6 : e.link ? 1.6 : 1.4}
                  strokeDasharray={t === 'muted' ? '4 4' : undefined} strokeLinecap="round" />
                {e.link && (
                  <path d={e.d} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: 'pointer' }}
                    onClick={ev => { ev.stopPropagation(); if (!drag.current?.moved) onPick({ type: 'link', link: { ...e.link!, why: e.link!.why } }, at(ev)) }}>
                    <title>{e.link.label ?? ''}</title>
                  </path>
                )}
              </g>
            )
          })}

          {/* cards */}
          {L.cards.filter(c => c.compact).map(c => (
            <Mark key={c.node.id} c={c} t={toneFor(c.node)} selected={c.node.id === selectedId}
              faded={faded(c.node.id)} focused={focusSet.has(c.node.id)} tagBelow={(focus?.indexOf(c.node.id) ?? 0) % 2 === 1}
              onClick={ev => { ev.stopPropagation(); if (!drag.current?.moved) onPick({ type: 'node', node: c.node }, at(ev)) }} />
          ))}
          {L.cards.filter(c => !c.compact).map(c => (
            <Card key={c.node.id} c={c} t={toneFor(c.node)} selected={c.node.id === selectedId}
              faded={faded(c.node.id)} focused={focusSet.has(c.node.id)} hovered={hover === c.node.id}
              onEnter={() => setHover(c.node.id)} onLeave={() => setHover(h => (h === c.node.id ? null : h))}
              onClick={ev => { ev.stopPropagation(); if (!drag.current?.moved) onPick({ type: 'node', node: c.node }, at(ev)) }} />
          ))}

          {/* order dots */}
          {L.dots.map(d => {
            const t = toneFor(d.node)
            const sel = d.node.id === selectedId || focusSet.has(d.node.id)
            return (
              <circle key={d.node.id} cx={d.x} cy={d.y} r={sel ? d.r + 1.5 : d.r} fill={color(t)}
                stroke={sel ? '#1b1b1a' : '#fff'} strokeWidth={sel ? 2 : 1} opacity={faded(d.node.id) ? 0.2 : 1}
                style={{ cursor: 'pointer' }}
                onClick={ev => { ev.stopPropagation(); if (!drag.current?.moved) onPick({ type: 'node', node: d.node }, at(ev)) }}>
                <title>{d.node.label}</title>
              </circle>
            )
          })}

          {/* a name tag for a focused order inside a block (e.g. the story's persona) */}
          {focus && L.dots.filter(d => focusSet.has(d.node.id)).map(d => (
            <g key={`tag-${d.node.id}`} pointerEvents="none">
              <rect x={d.x + 10} y={d.y - 13} width={d.node.label.length * 7 + 18} height={26} rx={8} fill="#1b1b1a" />
              <text x={d.x + 19} y={d.y + 4.5} fill="#fff" fontSize={13} fontWeight={600}>{d.node.label}</text>
            </g>
          ))}
        </g>
      </svg>
      <button className="btn btn-sm recentre" onClick={e => { e.stopPropagation(); fit() }} title="Fit the whole answer in view">Re-centre</button>
    </div>
  )
}

function Mark({ c, t, selected, faded, focused, tagBelow, onClick }: {
  c: LCard; t: Tone | 'quiet'; selected: boolean; faded: boolean; focused: boolean; tagBelow: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  const ty = tagBelow ? c.y + 22 : c.y - 22   // alternate so neighbouring tags never touch
  const col = t === 'quiet' ? QUIET : TONE_COLOR[t]
  return (
    <g opacity={faded ? 0.22 : 1} style={{ cursor: 'pointer' }} onClick={onClick}>
      <circle cx={c.x} cy={c.y} r={c.w / 2} fill="#fff" stroke={selected || focused ? '#1b1b1a' : '#e2dfd8'} strokeWidth={selected || focused ? 2 : 1} />
      <KindIcon kind={c.node.kind} x={c.x} y={c.y} color={col} />
      <title>{c.node.label}</title>
      {focused && (
        <g pointerEvents="none">
          <rect x={c.x - 6} y={ty - 13} width={c.node.label.length * 7 + 18} height={26} rx={8} fill="#1b1b1a" />
          <text x={c.x + 3} y={ty + 4.5} fill="#fff" fontSize={13} fontWeight={600}>{c.node.label}</text>
        </g>
      )}
    </g>
  )
}

function Card({ c, t, selected, faded, focused, hovered, onEnter, onLeave, onClick }: {
  c: LCard; t: Tone | 'quiet'; selected: boolean; faded: boolean; focused: boolean; hovered: boolean
  onEnter: () => void; onLeave: () => void; onClick: (e: React.MouseEvent) => void
}) {
  const n = c.node
  const x0 = c.x - c.w / 2, y0 = c.y - c.h / 2
  const col = t === 'quiet' ? QUIET : TONE_COLOR[t]
  const state = t === 'quiet' ? null : toneWord(t, n.kind)
  const accent = t !== 'quiet' && t !== 'neutral' && t !== 'muted'
  return (
    <g opacity={faded ? 0.22 : 1} style={{ cursor: 'pointer' }} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={onClick}>
      <rect x={x0} y={y0} width={c.w} height={c.h} rx={12}
        fill={t === 'quiet' ? '#f7f7f5' : '#fff'}
        stroke={selected || focused ? '#1b1b1a' : hovered ? '#b9b5ac' : '#e2dfd8'}
        strokeWidth={selected || focused ? 1.8 : 1}
        style={{ filter: hovered || selected ? 'drop-shadow(0 4px 10px rgba(27,27,26,0.10))' : 'drop-shadow(0 1px 1.5px rgba(27,27,26,0.06))' }} />
      {accent && <rect x={x0} y={y0 + 10} width={3} height={c.h - 20} rx={1.5} fill={col} />}
      <KindIcon kind={n.kind} x={x0 + 20} y={y0 + 17} color={col} />
      {c.lines.map((l, i) => (
        <text key={i} x={x0 + 36} y={y0 + 21 + i * 17} fontSize={13} fontWeight={600} fill={t === 'quiet' ? '#8a8883' : '#1b1b1a'}>{l}</text>
      ))}
      <text x={x0 + 36} y={y0 + 21 + c.lines.length * 17 + 1} fontSize={11.5} fill="#8a8883">
        {kindWord(n.kind)}
        {state && <tspan fill={col} fontWeight={600}>{`  ·  ${state}`}</tspan>}
      </text>
    </g>
  )
}

/** Small shape per kind, the same vocabulary as the 3D view. */
function KindIcon({ kind, x, y, color }: { kind: NodeKind; x: number; y: number; color: string }) {
  const s = 6.5
  switch (kind) {
    case 'event': return <path d={`M${x},${y - s - 1} L${x + s + 1},${y} L${x},${y + s + 1} L${x - s - 1},${y} Z`} fill={color} />
    case 'airport': return <path d={`M${x},${y - s} L${x + s},${y + s * 0.8} L${x - s},${y + s * 0.8} Z`} fill={color} />
    case 'warehouse': return <rect x={x - s + 0.5} y={y - s + 0.5} width={2 * s - 1} height={2 * s - 1} rx={2} fill={color} />
    case 'factory': return <path d={Array.from({ length: 6 }, (_, i) => `${i ? 'L' : 'M'}${x + s * Math.cos(i * Math.PI / 3)},${y + s * Math.sin(i * Math.PI / 3)}`).join(' ') + 'Z'} fill={color} />
    case 'shipment': return <rect x={x - s - 1} y={y - s * 0.55} width={2 * s + 2} height={s * 1.1} rx={s * 0.55} fill={color} />
    case 'place': return <circle cx={x} cy={y} r={s - 1} fill="none" stroke={color} strokeWidth={2.5} />
    case 'group': return <g fill={color}><circle cx={x - 2.5} cy={y + 1} r={4} /><circle cx={x + 3} cy={y - 2} r={4} opacity={0.7} /></g>
    case 'order': return <circle cx={x} cy={y} r={4.5} fill={color} />
    default: return <circle cx={x} cy={y} r={s} fill={color} />
  }
}
