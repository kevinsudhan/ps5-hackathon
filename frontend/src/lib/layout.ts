// One layout for both views, computed from the answer graph alone (no business numbers).
//
// * Orders that hang off exactly the same neighbours are bundled into one compact block of dots,
//   so 120 late orders read as a few blocks next to their shipments instead of hairline fans.
// * Graphs without loops are laid out in columns, left to right along the links (longest path),
//   with each column ordered to keep links straight (barycentre sweeps).
// * Graphs with loops (e.g. lanes between ports) get a radial layout: the most important place in
//   the middle, then rings by tone.

import type { AskGraph, AskNode, Tone } from '../api/types'

export interface LCard {
  kind: 'card'; node: AskNode; x: number; y: number; w: number; h: number; lines: string[]; col: number; row: number
  compact: boolean           // a crowded column shows shapes only; the name is on hover
}
export interface LDot { kind: 'dot'; node: AskNode; x: number; y: number; r: number; bundle: string }
export interface LBundle {
  id: string; x: number; y: number; w: number; h: number; members: string[]; col: number; tone: Tone
  more?: { node: AskNode; y: number }      // a "+ N more orders" node shown as the block's footer
}
export interface LEdge { source: string; target: string; tone: Tone; label?: string; why: string[]; bundled: boolean }
export interface Layout {
  mode: 'layered' | 'radial'
  cards: LCard[]
  dots: LDot[]
  bundles: LBundle[]
  edges: LEdge[]                    // the original links (endpoints are node ids)
  pos: Map<string, { x: number; y: number }>   // every node id -> centre
  bounds: { x0: number; y0: number; x1: number; y1: number }
}

const CARD_MIN = 128
const CARD_MAX = 268
const CHAR_W = 7.1                  // ~13px Inter, average
const LINE_H = 17
const DOT = 9
const PITCH = 13
const COL_GAP = 110
const ROW_GAP = 12
const CROWDED = 14              // more cards than this in one column -> compact markers
const CROWDED_BIG = 8           // ... in a big graph (story-sized)
const MARK = 18

const TONE_RANK: Record<Tone, number> = { danger: 0, warning: 1, good: 2, neutral: 3, muted: 4 }

/** Wrap a label into at most two lines that fit the card. */
export function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  if (lines.length <= 2) return lines
  const second = lines.slice(1).join(' ')
  return [lines[0], second.length > maxChars ? `${second.slice(0, maxChars - 1).trimEnd()}…` : second]
}

function cardSize(n: AskNode) {
  const maxChars = Math.floor((CARD_MAX - 46) / CHAR_W)
  const lines = wrap(n.label, maxChars)
  const longest = Math.max(...lines.map(l => l.length))
  const w = Math.max(CARD_MIN, Math.min(CARD_MAX, 46 + longest * CHAR_W))
  const h = 16 + lines.length * LINE_H + 18     // label lines + the small "kind · state" line
  return { w, h, lines }
}

export function layoutGraph(g: AskGraph): Layout {
  const ids = new Set(g.nodes.map(n => n.id))
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  const links = g.links.filter(l => ids.has(l.source) && ids.has(l.target) && l.source !== l.target)
  const ins = new Map<string, string[]>(), outs = new Map<string, string[]>()
  for (const l of links) {
    (outs.get(l.source) ?? outs.set(l.source, []).get(l.source)!).push(l.target)
    ;(ins.get(l.target) ?? ins.set(l.target, []).get(l.target)!).push(l.source)
  }

  // ---- bundle orders with identical neighbours -------------------------------------------------
  const sig = new Map<string, string[]>()
  for (const n of g.nodes) {
    if (n.kind !== 'order') continue
    const key = `${[...(ins.get(n.id) ?? [])].sort().join(',')}|${[...(outs.get(n.id) ?? [])].sort().join(',')}`
    ;(sig.get(key) ?? sig.set(key, []).get(key)!).push(n.id)
  }
  const unitOf = new Map<string, string>()      // node id -> layout unit id (itself or its bundle)
  const bundleMembers = new Map<string, string[]>()
  for (const [key, members] of sig) {
    if (members.length < 3) continue
    const bid = `bundle:${key}`
    members.sort((a, b) => byId.get(a)!.label.localeCompare(byId.get(b)!.label))
    bundleMembers.set(bid, members)
    members.forEach(m => unitOf.set(m, bid))
  }
  // A "+ N more orders" group that hangs off the same single parent as a block of orders becomes
  // that block's footer instead of a separate card.
  const moreOf = new Map<string, string>()      // bundle id -> group node id
  for (const n of g.nodes) {
    if (n.kind !== 'group' || (outs.get(n.id)?.length ?? 0) > 0) continue
    const parents = ins.get(n.id) ?? []
    if (parents.length !== 1) continue
    const bid = [...bundleMembers.keys()].find(b => b.startsWith(`bundle:${parents[0]}|`) && !moreOf.has(b))
    if (bid) { moreOf.set(bid, n.id); unitOf.set(n.id, bid) }
  }
  g.nodes.forEach(n => { if (!unitOf.has(n.id)) unitOf.set(n.id, n.id) })
  const units = [...new Set(g.nodes.map(n => unitOf.get(n.id)!))]

  // unit graph
  const uOut = new Map<string, Set<string>>(), uIn = new Map<string, Set<string>>()
  units.forEach(u => { uOut.set(u, new Set()); uIn.set(u, new Set()) })
  for (const l of links) {
    const a = unitOf.get(l.source)!, b = unitOf.get(l.target)!
    if (a === b) continue
    uOut.get(a)!.add(b); uIn.get(b)!.add(a)
  }

  // unit sizes
  const size = new Map<string, { w: number; h: number; lines: string[] }>()
  for (const u of units) {
    const members = bundleMembers.get(u)
    if (members) {
      // wide and short: two or three rows of dots, so a block never makes its row taller
      const cols = Math.max(4, Math.min(18, Math.ceil(members.length / 2)))
      const rows = Math.ceil(members.length / cols)
      const more = moreOf.get(u)
      const moreW = more ? 30 + byId.get(more)!.label.length * 6.6 : 0
      size.set(u, { w: Math.max(cols * PITCH + 18, moreW), h: rows * PITCH + 18 + (more ? 22 : 0), lines: [] })
    } else size.set(u, cardSize(byId.get(u)!))
  }

  const hasCycle = (() => {
    const state = new Map<string, number>()
    const visit = (u: string): boolean => {
      state.set(u, 1)
      for (const v of uOut.get(u)!) {
        const s = state.get(v)
        if (s === 1) return true
        if (!s && visit(v)) return true
      }
      state.set(u, 2)
      return false
    }
    return units.some(u => !state.get(u) && visit(u))
  })()

  const center = new Map<string, { x: number; y: number }>()
  let mode: Layout['mode'] = 'layered'
  const colOf = new Map<string, number>()
  const rowOf = new Map<string, number>()        // wrapped line, for long single chains
  const compactSet = new Set<string>()

  if (!hasCycle) {
    // ---- columns by longest path ------------------------------------------------------------
    const rank = new Map<string, number>()
    const rankOf = (u: string): number => {
      if (rank.has(u)) return rank.get(u)!
      rank.set(u, 0)
      let r = 0
      for (const p of uIn.get(u)!) r = Math.max(r, rankOf(p) + 1)
      rank.set(u, r)
      return r
    }
    units.forEach(rankOf)
    const maxRank = Math.max(0, ...rank.values())
    const cols: string[][] = Array.from({ length: maxRank + 1 }, () => [])
    // isolated units (no links at all) go to the first column
    units.forEach(u => cols[rank.get(u)!].push(u))
    const importance = (u: string) => {
      const n = byId.get(u)
      return n ? TONE_RANK[n.tone] * 10 - n.size : 50
    }
    cols[0].sort((a, b) => importance(a) - importance(b) || a.localeCompare(b))
    const idx = new Map<string, number>()
    const reindex = () => cols.forEach(c => c.forEach((u, i) => idx.set(u, i)))
    reindex()
    const bary = (u: string, nbrs: Set<string>) => {
      const xs = [...nbrs].map(v => idx.get(v)).filter((v): v is number => v != null)
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : idx.get(u) ?? 0
    }
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let r = 1; r <= maxRank; r++) {
        const b = new Map(cols[r].map(u => [u, bary(u, uIn.get(u)!)]))
        cols[r].sort((x, y) => b.get(x)! - b.get(y)! || importance(x) - importance(y) || x.localeCompare(y))
        reindex()
      }
      for (let r = maxRank - 1; r >= 0; r--) {
        const b = new Map(cols[r].map(u => [u, uOut.get(u)!.size ? bary(u, uOut.get(u)!) : idx.get(u)!]))
        cols[r].sort((x, y) => b.get(x)! - b.get(y)! || x.localeCompare(y))
        reindex()
      }
    }
    // crowded columns: shapes only, so the picture stays calm
    cols.forEach(c => {
      const cards = c.filter(u => !bundleMembers.has(u))
      if (cards.length > (g.nodes.length > 80 ? CROWDED_BIG : CROWDED)) cards.forEach(u => { size.set(u, { w: MARK, h: MARK, lines: [] }); compactSet.add(u) })
    })
    // x by column, y stacked and pulled toward the parents
    let x = 0
    cols.forEach((c, r) => {
      const w = Math.max(...c.map(u => size.get(u)!.w), 0)
      const gap = r === 0 ? 0 : COL_GAP + Math.min(60, c.length * 4)
      x += gap
      c.forEach(u => { center.set(u, { x: x + w / 2, y: 0 }); colOf.set(u, r) })
      x += w
    })
    cols.forEach((c, r) => {
      const desired = c.map(u => {
        const ps = [...uIn.get(u)!].filter(p => colOf.get(p)! < r).map(p => center.get(p)!.y)
        return r > 0 && ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0
      })
      // stack in order, each as close to its desired y as the one above allows
      const ys: number[] = []
      c.forEach((u, i) => {
        const h = size.get(u)!.h
        const minY = i ? ys[i - 1] + size.get(c[i - 1])!.h / 2 + ROW_GAP + h / 2 : -Infinity
        ys.push(r > 0 ? Math.max(desired[i], minY) : (i ? minY : 0))
      })
      // centre the block on where the parents want it
      const span = (ys[0] + ys[ys.length - 1]) / 2
      const want = r > 0 ? desired.reduce((a, b) => a + b, 0) / Math.max(1, desired.length) : span
      const shift = want - span
      c.forEach((u, i) => { center.get(u)!.y = ys[i] + shift })
    })
    // A long single chain (one card per column) wraps onto a second line, read left to right
    // like text, so every card stays readable.
    if (cols.length > 5 && cols.every(c => c.length === 1)) {
      const perRow = Math.ceil(cols.length / 2)
      const rowH = Math.max(...units.map(u => size.get(u)!.h)) + 90
      let rx = 0
      cols.forEach((c, r) => {
        const u = c[0], w = size.get(u)!.w
        if (r % perRow === 0) rx = 0
        else rx += 64
        center.set(u, { x: rx + w / 2, y: Math.floor(r / perRow) * rowH })
        rowOf.set(u, Math.floor(r / perRow))
        rx += w
      })
    }
  } else {
    // ---- radial: most important in the middle, rings by tone --------------------------------
    mode = 'radial'
    const order = [...units].sort((a, b) => {
      const na = byId.get(a), nb = byId.get(b)
      return (na ? TONE_RANK[na.tone] : 9) - (nb ? TONE_RANK[nb.tone] : 9) || (nb?.size ?? 0) - (na?.size ?? 0) || a.localeCompare(b)
    })
    // rings are wide ellipses: cards are much wider than they are tall
    const ringCap = [1, 7, 14, 99]
    let i = 0, ring = 0
    while (i < order.length) {
      const take = order.slice(i, i + ringCap[ring])
      const ry = ring === 0 ? 0 : 150 + (ring - 1) * 120
      const rx = ry * 2.1
      take.forEach((u, k) => {
        const a = -Math.PI / 2 + (k / take.length) * Math.PI * 2 + ring * 0.3
        center.set(u, { x: Math.cos(a) * rx, y: Math.sin(a) * ry })
        colOf.set(u, ring)
      })
      i += take.length
      ring = Math.min(ring + 1, ringCap.length - 1)
    }
  }

  // ---- emit cards, bundles, dots ------------------------------------------------------------
  const cards: LCard[] = [], dots: LDot[] = [], bundles: LBundle[] = []
  const pos = new Map<string, { x: number; y: number }>()
  for (const u of units) {
    const c = center.get(u)!, s = size.get(u)!
    const members = bundleMembers.get(u)
    if (members) {
      const cols = Math.round((s.w - 18) / PITCH)
      const tones = members.map(m => byId.get(m)!.tone)
      const tone = [...tones].sort((a, b) => TONE_RANK[a] - TONE_RANK[b])[0]
      const more = moreOf.get(u)
      bundles.push({
        id: u, x: c.x, y: c.y, w: s.w, h: s.h, members, col: colOf.get(u) ?? 0, tone,
        ...(more ? { more: { node: byId.get(more)!, y: c.y + s.h / 2 - 15 } } : {}),
      })
      if (more) pos.set(more, { x: c.x, y: c.y + s.h / 2 - 15 })
      members.forEach((m, k) => {
        const dx = c.x - s.w / 2 + 9 + PITCH / 2 + (k % cols) * PITCH
        const dy = c.y - s.h / 2 + 9 + PITCH / 2 + Math.floor(k / cols) * PITCH
        dots.push({ kind: 'dot', node: byId.get(m)!, x: dx, y: dy, r: DOT / 2, bundle: u })
        pos.set(m, { x: dx, y: dy })
      })
    } else {
      cards.push({ kind: 'card', node: byId.get(u)!, x: c.x, y: c.y, w: s.w, h: s.h, lines: s.lines, col: colOf.get(u) ?? 0, row: rowOf.get(u) ?? 0, compact: compactSet.has(u) })
      pos.set(u, c)
    }
  }
  const all = [...cards.map(c => [c.x - c.w / 2, c.y - c.h / 2, c.x + c.w / 2, c.y + c.h / 2]),
    ...bundles.map(b => [b.x - b.w / 2, b.y - b.h / 2, b.x + b.w / 2, b.y + b.h / 2])]
  const bounds = all.length
    ? { x0: Math.min(...all.map(a => a[0])), y0: Math.min(...all.map(a => a[1])), x1: Math.max(...all.map(a => a[2])), y1: Math.max(...all.map(a => a[3])) }
    : { x0: 0, y0: 0, x1: 1, y1: 1 }
  const edges: LEdge[] = links.map(l => ({
    source: l.source, target: l.target, tone: l.tone, label: l.label, why: l.why,
    bundled: unitOf.get(l.source) !== l.source || unitOf.get(l.target) !== l.target,
  }))
  return { mode, cards, dots, bundles, edges, pos, bounds }
}
