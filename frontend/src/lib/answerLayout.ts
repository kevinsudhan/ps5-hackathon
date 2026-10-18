// Where every node of an answer goes, for the 2D diagram and the 3D view alike. Computed from the
// (simplified) answer graph only; no business numbers.
//
//   flow   cause -> effect, left to right in columns (longest path), ranked columns in rank order,
//          other columns ordered to keep links straight; children sit next to their parents
//   grid   a flow that fans out into separate pieces (one per stuck shipment, one per rescue group):
//          the trunk (disruption -> closed hub) on top, the pieces below in rank order, in as many
//          columns as fit the stage best, fed by one line that branches down the gutters
//   chain  a single path (e.g. "why is this order late"): numbered steps, wrapping onto new rows
//   ring   graphs with loops (lanes between hubs): the top-ranked node in the middle, the rest
//          around it in rank order
//
// Labels are wrapped onto full lines (never cut); a very crowded column (the story) draws markers.

import type { AskLink } from '../api/types'
import { kindWord, toneWord } from './format'
import { adjacency, depths, findBands, hasCycle, sortUnits } from './graphShape'
import type { DGraph, DNode } from './simplify'

export interface PNode {
  id: string; node: DNode; x: number; y: number; w: number; h: number
  lines: string[]; metricLines: string[]; depth: number; compact: boolean; sub: string
}
export interface PEdge {
  key: string; link: AskLink; s: PNode; t: PNode; d: string; mid: { x: number; y: number }; depth: number
  bus?: boolean   // a grid feed line (its label only shows when the line itself is hovered)
}
type Bounds = { x0: number; y0: number; x1: number; y1: number }
export interface Placed {
  mode: 'flow' | 'grid' | 'chain' | 'ring'
  nodes: PNode[]; edges: PEdge[]; byId: Map<string, PNode>
  bounds: Bounds
  maxDepth: number
}

const CHAR = 7.15          // ~13.5px Inter semibold, average glyph
const MCHAR = 6.7          // metric line, 12.5px
const SCHAR = 6.2          // sub line, 11.5px
const LINE = 17
const MINW = 160
const MAXW = 240
const UNIT_MAXW = 290      // grid pieces sit side by side, so their cards may be wider and shorter
const ICON = 46            // left padding for the accent bar and the kind icon
const GAP_X = 96
const GAP_Y = 18
const UNIT_GAP_X = 64
const GRID_GX = 70         // between grid columns
const GRID_GY = 22         // between pieces in a grid column
const GUT = 34             // room left of a grid column for its feed line
const LANE = 54            // between the trunk and the grid
const PER_ROW = 4
const CROWDED = 12
const MARK = 22
// the stage at 1440x900, less its title row and legend: what a layout is scored against
const STAGE_W = 940, STAGE_H = 370

/** Words onto lines of at most `max` characters. Never truncates: a long word keeps its line. */
export function wrapLabel(text: string, max: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w
    else { out.push(cur); cur = w }
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
}

const baseId = (id: string) => id.split('@')[0]   // reroute legs repeat a place per option as "ID@option"

/** The small line under a card's title: what it is (with its id when another card has the same name). */
function subLine(n: DNode, dup: boolean) {
  if (n.members?.length && n.parent) return 'Click to show them'
  const what = n.twins ? `${n.twins} ${kindWord(n.kind).toLowerCase()}s` : dup ? `${kindWord(n.kind)} ${baseId(n.id)}` : kindWord(n.kind)
  const state = n.blocked ? 'Closed' : toneWord(n.tone, n.kind)
  return state ? `${what} · ${state}` : what
}

function measure(n: DNode, compact: boolean, sub: string, maxW = MAXW) {
  if (compact) return { w: MARK, h: MARK, lines: [] as string[], metricLines: [] as string[] }
  const lines = wrapLabel(n.label, Math.floor((maxW - ICON - 12) / CHAR))
  const metricLines = n.metric ? wrapLabel(n.metric.label, Math.floor((maxW - ICON - 12) / MCHAR)) : []
  const need = Math.max(...lines.map(l => l.length * CHAR), ...metricLines.map(l => l.length * MCHAR), sub.length * SCHAR, 96)
  const w = Math.max(MINW, Math.min(maxW, Math.ceil(need + ICON + 14)))
  const h = 14 + lines.length * LINE + 16 + metricLines.length * 17 + (metricLines.length ? 4 : 0) + 10
  return { w, h, lines, metricLines }
}

function bezier(x1: number, y1: number, x2: number, y2: number, horizontal: boolean) {
  if (horizontal) {
    const dx = Math.max(36, (x2 - x1) / 2)
    const c1 = { x: x1 + dx, y: y1 }, c2 = { x: x2 - dx, y: y2 }
    return { d: `M${x1},${y1} C${c1.x},${c1.y} ${c2.x},${c2.y} ${x2},${y2}`, mid: { x: (x1 + 3 * c1.x + 3 * c2.x + x2) / 8, y: (y1 + 3 * c1.y + 3 * c2.y + y2) / 8 } }
  }
  const dy = Math.max(40, Math.abs(y2 - y1) / 2)
  const c1 = { x: x1, y: y1 + dy }, c2 = { x: x2, y: y2 - dy }
  return { d: `M${x1},${y1} C${c1.x},${c1.y} ${c2.x},${c2.y} ${x2},${y2}`, mid: { x: (x1 + 3 * c1.x + 3 * c2.x + x2) / 8, y: (y1 + 3 * c1.y + 3 * c2.y + y2) / 8 } }
}

/** A right-angled path through the points, with rounded corners. */
function orthogonal(pts: [number, number][], r = 12) {
  const p = pts.filter((q, i) => !i || Math.abs(q[0] - pts[i - 1][0]) + Math.abs(q[1] - pts[i - 1][1]) > 0.5)
  const q = p.filter((c, i) => i === 0 || i === p.length - 1
    || !((Math.abs(p[i - 1][0] - c[0]) < 0.5 && Math.abs(c[0] - p[i + 1][0]) < 0.5) || (Math.abs(p[i - 1][1] - c[1]) < 0.5 && Math.abs(c[1] - p[i + 1][1]) < 0.5)))
  let d = `M${q[0][0]},${q[0][1]}`
  for (let i = 1; i < q.length - 1; i++) {
    const [ax, ay] = q[i - 1], [bx, by] = q[i], [cx, cy] = q[i + 1]
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by)
    const rr = Math.min(r, l1 / 2, l2 / 2)
    d += ` L${bx - ((bx - ax) / l1) * rr},${by - ((by - ay) / l1) * rr} Q${bx},${by} ${bx + ((cx - bx) / l2) * rr},${by + ((cy - by) / l2) * rr}`
  }
  const last = q[q.length - 1]
  return `${d} L${last[0]},${last[1]}`
}

function edgeBetween(link: AskLink, s: PNode, t: PNode, mode: Placed['mode']): PEdge {
  const key = `${link.source}>${link.target}`
  let geo
  if (mode === 'ring') {
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2
    const c = { x: mx * 0.78, y: my * 0.78 }   // bend towards the middle
    geo = { d: `M${s.x},${s.y} Q${c.x},${c.y} ${t.x},${t.y}`, mid: { x: (s.x + 2 * c.x + t.x) / 4, y: (s.y + 2 * c.y + t.y) / 4 } }
  } else if (t.x - t.w / 2 > s.x + s.w / 2 + 8) {
    geo = bezier(s.x + s.w / 2, s.y, t.x - t.w / 2, t.y, true)
  } else {
    geo = bezier(s.x, s.y + s.h / 2, t.x, t.y - t.h / 2, false)   // wraps to the next row
  }
  return { key, link, s, t, d: geo.d, mid: geo.mid, depth: s.depth }
}

const scoreOf = (w: number, h: number) => Math.min(STAGE_W / Math.max(1, w), STAGE_H / Math.max(1, h))

// ---- flow: columns by depth ------------------------------------------------------------------

interface Slot { n: DNode; x: number; y: number; w: number; h: number; lines: string[]; metricLines: string[]; compact: boolean; col: number; pos: number }
interface Flow { slots: Slot[]; colW: number[]; bounds: Bounds }

/** Columns `depth - base` of `nodes`, using only the links among them. x starts at 0, y centres on 0. */
function flowLayout(nodes: DNode[], links: AskLink[], depth: Map<string, number>, base: number, subs: Map<string, string>,
                    opt: { maxW?: number; gapX?: number; colW?: number[] } = {}): Flow {
  const { kids, pars } = adjacency(nodes, links)
  const gapX = opt.gapX ?? GAP_X
  const colOf = (n: DNode) => Math.max(0, (depth.get(n.id) ?? base) - base)
  const maxD = Math.max(0, ...nodes.map(colOf))
  const cols: DNode[][] = Array.from({ length: maxD + 1 }, () => [])
  nodes.forEach(n => cols[colOf(n)].push(n))
  const pos = new Map<string, number>()   // order inside its column
  const ranked = (c: DNode[]) => c.length > 1 && c.every(n => n.rank != null)
  cols.forEach((c, d) => {
    if (ranked(c)) c.sort((a, b) => a.rank! - b.rank!)
    else if (d === 0) c.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.metric?.value ?? 0) - (a.metric?.value ?? 0))
    else {
      const bary = (n: DNode) => { const ps = pars.get(n.id)!.map(p => pos.get(p) ?? 0); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0 }
      c.sort((a, b) => bary(a) - bary(b) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.metric?.value ?? 0) - (a.metric?.value ?? 0))
    }
    c.forEach((n, i) => pos.set(n.id, i))
  })
  const compactCol = cols.map(c => c.length > CROWDED)
  const sizes = new Map(nodes.map(n => [n.id, measure(n, compactCol[colOf(n)], subs.get(n.id) ?? '', opt.maxW)]))
  const colW = cols.map((c, i) => Math.max(opt.colW?.[i] ?? 0, MARK, ...c.map(n => sizes.get(n.id)!.w)))
  const colX: number[] = []
  colW.reduce((x, w, i) => { colX[i] = x + w / 2; return x + w + gapX }, 0)

  const y = new Map<string, number>()
  const gapOf = (d: number) => (compactCol[d] ? 7 : GAP_Y)
  const stack = (c: DNode[], d: number, want: (n: DNode) => number) => {
    const hs = c.map(n => sizes.get(n.id)!.h)
    const ys = c.map(want)
    for (let i = 1; i < c.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + (hs[i - 1] + hs[i]) / 2 + gapOf(d))
    // centre the block on what it wanted, keeping the spacing
    const shift = c.reduce((s, n, i) => s + (want(n) - ys[i]), 0) / Math.max(1, c.length)
    c.forEach((n, i) => y.set(n.id, ys[i] + shift))
  }
  // first pass: plain stacks centred on 0
  cols.forEach((c, d) => {
    const total = c.reduce((s, n) => s + sizes.get(n.id)!.h, 0) + gapOf(d) * (c.length - 1)
    let at = -total / 2
    c.forEach(n => { const h = sizes.get(n.id)!.h; y.set(n.id, at + h / 2); at += h + gapOf(d) })
  })
  const mean = (xs: string[]) => xs.reduce((s, p) => s + (y.get(p) ?? 0), 0) / xs.length
  for (let pass = 0; pass < 3; pass++) {
    // children next to their parents
    for (let d = 1; d <= maxD; d++) {
      if (ranked(cols[d]) && cols[d].length > 6) continue   // long ranked lists keep their order as one stack
      stack(cols[d], d, n => (pars.get(n.id)!.length ? mean(pars.get(n.id)!) : y.get(n.id)!))
    }
    // parents centred on their children
    for (let d = maxD - 1; d >= 0; d--) {
      stack(cols[d], d, n => (kids.get(n.id)!.length ? mean(kids.get(n.id)!) : y.get(n.id)!))
    }
  }
  const slots = nodes.map(n => {
    const s = sizes.get(n.id)!, d = colOf(n)
    return { n, x: colX[d], y: y.get(n.id)!, w: s.w, h: s.h, lines: s.lines, metricLines: s.metricLines, compact: compactCol[d], col: d, pos: pos.get(n.id) ?? 0 }
  })
  return { slots, colW, bounds: boundsOf(slots) }
}

function boundsOf(ps: { x: number; y: number; w: number; h: number }[]): Bounds {
  if (!ps.length) return { x0: 0, y0: 0, x1: 1, y1: 1 }
  return ps.reduce((b, p) => ({
    x0: Math.min(b.x0, p.x - p.w / 2), y0: Math.min(b.y0, p.y - p.h / 2),
    x1: Math.max(b.x1, p.x + p.w / 2), y1: Math.max(b.y1, p.y + p.h / 2),
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
}

/** Heights into k columns, tallest first onto the shortest column; each column keeps reading order. */
function balance(hs: number[], k: number, gap: number): number[][] {
  const cols = Array.from({ length: k }, () => ({ h: -gap, items: [] as number[] }))
  hs.map((h, i) => ({ h, i })).sort((a, b) => b.h - a.h || a.i - b.i).forEach(({ h, i }) => {
    const c = cols.reduce((m, x) => (x.h < m.h ? x : m))
    c.h += h + gap; c.items.push(i)
  })
  return cols.map(c => c.items.sort((a, b) => a - b)).filter(c => c.length).sort((a, b) => a[0] - b[0])
}

/** Split heights into k consecutive runs with the smallest tallest run. */
function partition(hs: number[], k: number, gap: number): number[][] {
  const n = hs.length
  const pre = [0]
  hs.forEach(h => pre.push(pre[pre.length - 1] + h))
  const run = (i: number, j: number) => pre[j] - pre[i] + gap * (j - i - 1)
  const best = Array.from({ length: k + 1 }, () => Array(n + 1).fill(Infinity) as number[])
  const cut = Array.from({ length: k + 1 }, () => Array(n + 1).fill(0) as number[])
  best[0][0] = 0
  for (let c = 1; c <= k; c++) {
    for (let j = c; j <= n; j++) {
      for (let i = c - 1; i < j; i++) {
        const v = Math.max(best[c - 1][i], run(i, j))
        if (v < best[c][j]) { best[c][j] = v; cut[c][j] = i }
      }
    }
  }
  const out: number[][] = []
  for (let c = k, j = n; c > 0; c--) {
    const i = cut[c][j]
    out.unshift(Array.from({ length: j - i }, (_, x) => i + x))
    j = i
  }
  return out
}

// ---- grid: trunk on top, pieces below ----------------------------------------------------------

type Target = { id: string; x: number; y: number; w: number }
interface Grid { slots: (Slot & { depth: number })[]; feed: Map<string, (t: Target) => { d: string; mid: { x: number; y: number } }>; bounds: Bounds }

function gridLayout(g: DGraph, subs: Map<string, string>): Grid | null {
  const bands = findBands(g.nodes, g.links)
  if (!bands) return null
  const { s, depth } = bands
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  const trunk = flowLayout(bands.trunk.map(id => byId.get(id)!), g.links, depth, 0, subs)
  const units = sortUnits(bands.units, byId).map(u => u.map(id => byId.get(id)!))
  const opt = { maxW: UNIT_MAXW, gapX: UNIT_GAP_X }
  const colW: number[] = []
  units.forEach(u => flowLayout(u, g.links, depth, s, subs, opt).colW.forEach((w, i) => { colW[i] = Math.max(colW[i] ?? 0, w) }))
  const lays = units.map(u => flowLayout(u, g.links, depth, s, subs, { ...opt, colW }))
  const unitW = colW.reduce((a, b) => a + b, 0) + UNIT_GAP_X * (colW.length - 1)
  const hs = lays.map(l => l.bounds.y1 - l.bounds.y0)
  const tW = trunk.bounds.x1 - trunk.bounds.x0, tH = trunk.bounds.y1 - trunk.bounds.y0

  let pick: { runs: number[][]; gridW: number; W: number; score: number } | null = null
  for (let k = 1; k <= Math.min(4, lays.length); k++) {
    // in rank order down each column, unless balancing the columns makes the picture much bigger
    const tall = (runs: number[][]) => Math.max(...runs.map(r => r.reduce((a, i) => a + hs[i], 0) + GRID_GY * (r.length - 1)))
    const inOrder = partition(hs, k, GRID_GY), balanced = balance(hs, k, GRID_GY)
    const runs = tall(inOrder) <= tall(balanced) * 1.08 ? inOrder : balanced
    const gridW = GUT + runs.length * unitW + (runs.length - 1) * GRID_GX
    const gridH = tall(runs)
    const W = Math.max(tW, gridW)
    const score = scoreOf(W, tH + LANE + gridH)
    if (!pick || score > pick.score + 1e-6) pick = { runs, gridW, W, score }
  }
  if (!pick) return null

  const out: Grid['slots'] = []
  const dx = (pick.W - tW) / 2 - trunk.bounds.x0, dy = -trunk.bounds.y0
  trunk.slots.forEach(t => out.push({ ...t, x: t.x + dx, y: t.y + dy, depth: t.col + t.pos * 0.06 }))
  const gridX0 = (pick.W - pick.gridW) / 2
  const laneY = tH + LANE / 2
  const gutter: number[] = []
  const colOfUnit = new Map<number, number>()
  pick.runs.forEach((run, k) => {
    const left = gridX0 + GUT + k * (unitW + GRID_GX)
    gutter[k] = left - GUT * 0.55
    let top = tH + LANE
    run.forEach(i => {
      const l = lays[i]
      colOfUnit.set(i, k)
      l.slots.forEach(sl => out.push({ ...sl, x: sl.x - l.bounds.x0 + left, y: sl.y - l.bounds.y0 + top, depth: s + sl.col + i * 0.2 }))
      top += hs[i] + GRID_GY
    })
  })
  const unitOf = new Map<string, number>()
  units.forEach((u, i) => u.forEach(n => unitOf.set(n.id, i)))

  // each trunk node that feeds a piece leaves from its bottom (or its right side if a card is below it)
  const placedTrunk = out.filter(o => bands.trunk.includes(o.n.id))
  const feed: Grid['feed'] = new Map()
  placedTrunk.forEach(p => {
    const blocked = placedTrunk.some(o => o !== p && o.y > p.y && Math.abs(o.x - p.x) < (o.w + p.w) / 2)
    const exit: [number, number][] = blocked
      ? [[p.x + p.w / 2, p.y], [p.x + p.w / 2 + 18, p.y], [p.x + p.w / 2 + 18, laneY]]
      : [[p.x, p.y + p.h / 2], [p.x, laneY]]
    feed.set(p.n.id, t => {
      const gx = gutter[colOfUnit.get(unitOf.get(t.id)!)!]
      return { d: orthogonal([...exit, [gx, laneY], [gx, t.y], [t.x - t.w / 2, t.y]]), mid: { x: gx, y: t.y } }
    })
  })
  return { slots: out, feed, bounds: boundsOf(out) }
}

// ---- the answer --------------------------------------------------------------------------------

export function placeAnswer(g: DGraph): Placed {
  const adj = adjacency(g.nodes, g.links)
  const { kids, pars } = adj
  const ids = g.nodes.map(n => n.id)
  const nodeOf = new Map(g.nodes.map(n => [n.id, n]))
  // two different things with the same name get their ids; the same place on two route options does not
  const named = new Map<string, Set<string>>()
  g.nodes.forEach(n => { if (!n.members) named.set(`${n.kind}|${n.label}`, (named.get(`${n.kind}|${n.label}`) ?? new Set()).add(baseId(n.id))) })
  const subs = new Map(g.nodes.map(n => [n.id, subLine(n, !n.members && (named.get(`${n.kind}|${n.label}`)?.size ?? 0) > 1)]))
  let mode: Placed['mode'] = hasCycle(ids, kids) ? 'ring'
    : g.nodes.length >= 6 && g.nodes.every(n => kids.get(n.id)!.length <= 1 && pars.get(n.id)!.length <= 1)
      && g.links.length === g.nodes.length - 1 ? 'chain' : 'flow'
  const placed: PNode[] = []
  const pnode = (n: DNode, x: number, y: number, depth: number, m: ReturnType<typeof measure>, compact = false): PNode =>
    ({ id: n.id, node: n, x, y, w: m.w, h: m.h, lines: m.lines, metricLines: m.metricLines, compact, depth, sub: subs.get(n.id) ?? '' })
  let feed: Grid['feed'] | null = null

  if (mode === 'chain') {
    // follow the single path from its start
    const start = g.nodes.find(n => !pars.get(n.id)!.length)!
    const order: DNode[] = []
    for (let cur: DNode | undefined = start; cur; cur = nodeOf.get(kids.get(cur.id)![0] ?? '')) order.push(cur)
    const sized = order.map(n => ({ n, m: measure(n, false, subs.get(n.id) ?? '') }))
    const colW = Math.max(...sized.map(s => s.m.w)), rowH = Math.max(...sized.map(s => s.m.h))
    sized.forEach((s, i) => {
      const row = Math.floor(i / PER_ROW), col = i % PER_ROW
      placed.push(pnode(s.n, col * (colW + GAP_X) + colW / 2, row * (rowH + 78) + rowH / 2, i, s.m))
    })
  } else if (mode === 'ring') {
    const sorted = [...g.nodes].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.metric?.value ?? 0) - (a.metric?.value ?? 0))
    const sized = sorted.map(n => ({ n, m: measure(n, false, subs.get(n.id) ?? '') }))
    const [center, ...rest] = sized
    const perim = rest.reduce((s, r) => s + r.m.w + 30, 0)
    const R = Math.max(250, perim / (2 * Math.PI))
    placed.push(pnode(center.n, 0, 0, 0, center.m))
    rest.forEach((s, i) => {
      const a = -Math.PI / 2 + (i / rest.length) * Math.PI * 2
      placed.push(pnode(s.n, Math.cos(a) * R * 1.25, Math.sin(a) * R * 0.78, 1 + i * 0.25, s.m))
    })
  } else {
    const depth = depths(ids, adj)
    const plain = flowLayout(g.nodes, g.links, depth, 0, subs)
    const grid = gridLayout(g, subs)
    const sc = (b: Bounds) => scoreOf(b.x1 - b.x0, b.y1 - b.y0)
    if (grid && sc(grid.bounds) > sc(plain.bounds) * 1.05) {
      mode = 'grid'
      feed = grid.feed
      grid.slots.forEach(s => placed.push(pnode(s.n, s.x, s.y, s.depth, s, s.compact)))
    } else {
      plain.slots.forEach(s => placed.push(pnode(s.n, s.x, s.y, s.col + s.pos * 0.06, s, s.compact)))
    }
  }

  const byId = new Map(placed.map(p => [p.id, p]))
  const edges = g.links.filter(l => byId.has(l.source) && byId.has(l.target) && l.source !== l.target)
    .map(l => {
      const s = byId.get(l.source)!, t = byId.get(l.target)!
      const route = feed?.get(l.source)
      const inTrunk = route && feed!.has(l.target)
      if (route && !inTrunk) {
        const r = route(t)
        return { key: `${l.source}>${l.target}`, link: l, s, t, d: r.d, mid: r.mid, depth: Math.max(s.depth, t.depth - 0.6), bus: true }
      }
      return edgeBetween(l, s, t, mode)
    })
  return { mode, nodes: placed, edges, byId, bounds: boundsOf(placed), maxDepth: Math.max(0, ...placed.map(p => p.depth)) }
}

/** Everything upstream and downstream of a node: the path a hover highlights. */
export function pathThrough(P: Placed, id: string): Set<string> {
  const up = new Map<string, string[]>(), down = new Map<string, string[]>()
  P.edges.forEach(e => {
    down.set(e.s.id, [...(down.get(e.s.id) ?? []), e.t.id])
    up.set(e.t.id, [...(up.get(e.t.id) ?? []), e.s.id])
  })
  const seen = new Set([id])
  const walk = (m: Map<string, string[]>, from: string) => (m.get(from) ?? []).forEach(n => { if (!seen.has(n)) { seen.add(n); walk(m, n) } })
  walk(up, id); walk(down, id)
  return seen
}
