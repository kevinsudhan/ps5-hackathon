// Shape facts about an answer graph, shared by folding (simplify) and placing (answerLayout):
// who links to whom, how deep each node sits (longest path from a source), and whether the graph is
// a short "trunk" (the disruption and the closed hub) that fans out into separate pieces ("units"),
// e.g. one stuck shipment with its late orders. Nothing here is about the business numbers.

import type { AskLink, AskNode } from '../api/types'

export interface Adj { kids: Map<string, string[]>; pars: Map<string, string[]> }

export function adjacency(nodes: { id: string }[], links: AskLink[]): Adj {
  const kids = new Map<string, string[]>(), pars = new Map<string, string[]>()
  nodes.forEach(n => { kids.set(n.id, []); pars.set(n.id, []) })
  links.forEach(l => {
    if (!kids.has(l.source) || !kids.has(l.target) || l.source === l.target) return
    kids.get(l.source)!.push(l.target); pars.get(l.target)!.push(l.source)
  })
  return { kids, pars }
}

export function hasCycle(ids: string[], kids: Map<string, string[]>) {
  const state = new Map<string, number>()
  const visit = (id: string): boolean => {
    state.set(id, 1)
    for (const k of kids.get(id) ?? []) {
      const s = state.get(k)
      if (s === 1 || (!s && visit(k))) return true
    }
    state.set(id, 2)
    return false
  }
  return ids.some(id => !state.get(id) && visit(id))
}

/** Longest path from a source (a node nothing points at). */
export function depths(ids: string[], { kids, pars }: Adj): Map<string, number> {
  const depth = new Map<string, number>()
  const indeg = new Map(ids.map(id => [id, pars.get(id)!.length]))
  const queue = ids.filter(id => !indeg.get(id))
  queue.forEach(id => depth.set(id, 0))
  while (queue.length) {
    const id = queue.shift()!
    for (const k of kids.get(id)!) {
      depth.set(k, Math.max(depth.get(k) ?? 0, depth.get(id)! + 1))
      indeg.set(k, indeg.get(k)! - 1)
      if (!indeg.get(k)) queue.push(k)
    }
  }
  ids.forEach(id => { if (!depth.has(id)) depth.set(id, 0) })
  return depth
}

export interface Bands { s: number; depth: Map<string, number>; trunk: string[]; units: string[][] }
const MIN_UNITS = 3
const MAX_TRUNK = 8

/** The first depth after which the graph falls apart into 3+ separate pieces, if there is one. */
export function findBands(nodes: AskNode[], links: AskLink[]): Bands | null {
  const ids = nodes.map(n => n.id)
  const adj = adjacency(nodes, links)
  if (ids.length < 6 || hasCycle(ids, adj.kids)) return null
  const depth = depths(ids, adj)
  const maxD = Math.max(0, ...depth.values())
  for (let s = 1; s <= maxD; s++) {
    const trunk = ids.filter(id => depth.get(id)! < s)
    if (trunk.length > MAX_TRUNK) return null
    const inside = ids.filter(id => depth.get(id)! >= s)
    const up = new Map(inside.map(id => [id, id]))
    const find = (x: string): string => { while (up.get(x) !== x) x = up.get(x)!; return x }
    links.forEach(l => { if (up.has(l.source) && up.has(l.target)) up.set(find(l.source), find(l.target)) })
    const groups = new Map<string, string[]>()
    inside.forEach(id => { const r = find(id); groups.set(r, [...(groups.get(r) ?? []), id]) })
    if (groups.size >= MIN_UNITS) return { s, depth, trunk, units: [...groups.values()] }
  }
  return null
}

const FOLDED = /^(more|units):/

/** Units in reading order: best rank first, then the biggest dollar figure; "+N more" nodes last. */
export function sortUnits(units: string[][], byId: Map<string, AskNode>): string[][] {
  const key = (u: string[]) => {
    const ns = u.map(id => byId.get(id)!)
    return {
      folded: ns.some(n => FOLDED.test(n.id)) ? 1 : 0,
      rank: Math.min(...ns.map(n => n.rank ?? Infinity)),
      usd: Math.max(...ns.map(n => (n.metric?.unit === 'usd' ? n.metric.value : -Infinity))),
      label: ns[0].label,
    }
  }
  return units.map(u => ({ u, k: key(u) }))
    .sort((a, b) => a.k.folded - b.k.folded || a.k.rank - b.k.rank || b.k.usd - a.k.usd || a.k.label.localeCompare(b.k.label))
    .map(x => x.u)
}
