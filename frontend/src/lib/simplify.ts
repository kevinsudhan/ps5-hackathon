// Keep an answer graph readable, in three display-only steps:
//   1. twins     siblings that look identical (same kind, label, rank and links, e.g. three shipments
//                of the same goods on the same route) are drawn as one card that says "3 shipments"
//   2. units     when the graph fans out into more than six separate pieces of several cards each (one
//                stuck shipment and its late orders), the lowest-ranked fold into "+N more" under their hub
//   3. leaves    above ~25 nodes, the leaves with the weakest claim fold into "+N more" per parent
// Every "+N more" expands on click. Nodes in `keep` (the story's persona path) and parents the user
// expanded never fold. Nothing is computed about the business: counts and sums come from the nodes
// the API sent.

import type { AskGraph, AskLink, AskNode, Tone } from '../api/types'
import { num, usd } from './format'
import { adjacency, findBands, sortUnits } from './graphShape'

export interface DNode extends AskNode {
  members?: AskNode[]       // a "+N more" or twins node made here: the nodes it stands for
  parent?: string           // a "+N more" node: the node to expand
  twins?: number            // a twins node: how many identical-looking nodes it stands for
}
export interface DGraph { nodes: DNode[]; links: AskLink[]; folded: number }
type Part = { nodes: DNode[]; links: AskLink[] }

export const MAX_VISIBLE = 25
const MAX_UNITS = 6
const SEVERITY: Record<Tone, number> = { danger: 0, warning: 1, good: 2, neutral: 3, muted: 4 }
const PLURAL: Partial<Record<AskNode['kind'], string>> = {
  order: 'orders', shipment: 'shipments', place: 'places', port: 'ports', warehouse: 'warehouses', group: 'groups',
  airport: 'airports', factory: 'factories',
}

function strength(a: AskNode, b: AskNode) {
  if (a.rank != null && b.rank != null && a.rank !== b.rank) return a.rank - b.rank
  const ma = a.metric?.value ?? -Infinity, mb = b.metric?.value ?? -Infinity
  if (ma !== mb) return mb - ma
  return SEVERITY[a.tone] - SEVERITY[b.tone] || a.label.localeCompare(b.label)
}
const worstTone = (ns: AskNode[]) => ns.reduce<Tone>((t, m) => (SEVERITY[m.tone] < SEVERITY[t] ? m.tone : t), 'muted')
const usdSum = (ns: AskNode[]) => (ns.length && ns.every(m => m.metric?.unit === 'usd') ? ns.reduce((s, m) => s + m.metric!.value, 0) : null)

export function simplify(g: AskGraph, keep: Set<string> = new Set(), expanded: Set<string> = new Set(),
                         max = MAX_VISIBLE): DGraph {
  const t = mergeTwins(g, keep)
  const u = foldUnits(t, keep, expanded)
  const l = foldLeaves(u, keep, expanded, max)
  return { nodes: l.nodes, links: l.links, folded: u.folded + l.folded }
}

/** 1. Identical-looking siblings become one card. */
function mergeTwins(g: Part, keep: Set<string>): Part {
  const { kids, pars } = adjacency(g.nodes, g.links)
  const sig = (n: AskNode) => [n.kind, n.label, n.tone, n.rank ?? '', [...pars.get(n.id)!].sort().join(','), [...kids.get(n.id)!].sort().join(',')].join('|')
  const bySig = new Map<string, AskNode[]>()
  g.nodes.forEach(n => { if (!keep.has(n.id) && n.kind !== 'event') bySig.set(sig(n), [...(bySig.get(sig(n)) ?? []), n]) })
  const into = new Map<string, string>()
  const nodes: DNode[] = []
  g.nodes.forEach(n => {
    const twins = bySig.get(sig(n))
    if (keep.has(n.id) || !twins || twins.length < 2) { nodes.push(n); return }
    const id = `twins:${twins[0].id}`
    into.set(n.id, id)
    if (twins[0] !== n) return
    const sum = usdSum(twins)
    nodes.push({
      ...n, id, members: twins, twins: twins.length,
      metric: sum != null ? { value: sum, unit: 'usd', label: `${usd(sum)} together` } : n.metric,
      why: [`${num(twins.length)} ${PLURAL[n.kind] ?? 'items'} that look the same here (same goods, same route): ${twins.map(x => x.id).join(', ')}.`,
            ...n.why.slice(0, 2)],
    })
  })
  if (!into.size) return g
  const links = new Map<string, AskLink>()
  g.links.forEach(l => {
    const source = into.get(l.source) ?? l.source, target = into.get(l.target) ?? l.target
    const key = `${source}>${target}`
    const prev = links.get(key)
    if (prev) links.set(key, { ...prev, weight: Math.min(1, (prev.weight ?? 0) + (l.weight ?? 0)) })
    else links.set(key, { ...l, source, target })
  })
  return { nodes, links: [...links.values()] }
}

/** 2. More than six separate pieces under a hub: the lowest-ranked fold into "+N more". */
function foldUnits(g: Part, keep: Set<string>, expanded: Set<string>): Part & { folded: number } {
  const bands = findBands(g.nodes, g.links)
  // pieces that are single cards are a plain list (e.g. "the 10 costliest orders"): never folded here
  if (!bands || bands.units.length <= MAX_UNITS || bands.units.every(u => u.length === 1)) return { ...g, folded: 0 }
  const byId = new Map(g.nodes.map(n => [n.id, n as DNode]))
  const trunk = new Set(bands.trunk)
  const hubOf = (u: string[]) => {
    const feeds = g.links.filter(l => trunk.has(l.source) && u.includes(l.target)).map(l => l.source)
    return feeds.sort((a, b) => (bands.depth.get(b) ?? 0) - (bands.depth.get(a) ?? 0))[0]
  }
  const byHub = new Map<string, string[][]>()
  sortUnits(bands.units, byId).forEach((u, i) => {
    if (i < MAX_UNITS - 1 || u.some(id => keep.has(id))) return
    const hub = hubOf(u)
    if (hub && !expanded.has(hub)) byHub.set(hub, [...(byHub.get(hub) ?? []), u])
  })
  const hidden = new Set<string>()
  const added: DNode[] = []
  const addedLinks: AskLink[] = []
  byHub.forEach((units, hub) => {
    if (units.length < 2) return
    // what each piece is "about": the deepest node holding its best rank (else the piece's head)
    const about = units.map(u => {
      const ns = u.map(id => byId.get(id)!)
      const best = Math.min(...ns.map(n => n.rank ?? Infinity))
      const holders = best < Infinity ? ns.filter(n => n.rank === best) : ns.filter(n => g.links.some(l => l.source === hub && l.target === n.id))
      return holders.sort((a, b) => (bands.depth.get(b.id) ?? 0) - (bands.depth.get(a.id) ?? 0))[0] ?? ns[0]
    })
    const kind = about[0].kind
    const members = units.flat().map(id => byId.get(id)!).filter(n => n.kind === kind)
    const ranked = members.some(n => n.rank != null)
    const word = PLURAL[kind] ?? 'more'
    const sum = usdSum(members)
    const feeds = g.links.filter(l => l.source === hub && units.some(u => u.includes(l.target)))
    units.flat().forEach(id => hidden.add(id))
    const id = `units:${hub}`
    added.push({
      id, kind: 'group', label: `+${num(members.length)} more ${word}`, tone: worstTone(members), size: 1.2, count: members.length,
      step: Math.min(...units.flat().map(x => byId.get(x)!.step ?? 99)), members, parent: hub,
      ...(sum != null ? { metric: { value: sum, unit: 'usd' as const, label: `${usd(sum)} together` } } : {}),
      why: [`${num(members.length)} more ${word}${ranked ? ', ranked lower' : ''}, folded to keep the picture readable.`, 'Click to show them all.'],
    })
    addedLinks.push({
      source: hub, target: id, tone: feeds[0]?.tone ?? worstTone(members), label: `${num(members.length)} more`,
      weight: Math.min(1, feeds.reduce((s, l) => s + (l.weight ?? 0), 0)),
      why: [`${num(members.length)} more ${word} trace back to this.`],
    })
  })
  if (!hidden.size) return { ...g, folded: 0 }
  return {
    nodes: [...g.nodes.filter(n => !hidden.has(n.id)), ...added],
    links: [...g.links.filter(l => !hidden.has(l.source) && !hidden.has(l.target)), ...addedLinks],
    folded: hidden.size,
  }
}

/** 3. Above `max` nodes, the weakest single-parent leaves fold into "+N more" per parent. */
function foldLeaves(g: Part, keep: Set<string>, expanded: Set<string>, max: number): Part & { folded: number } {
  if (g.nodes.length <= max) return { ...g, folded: 0 }
  const outDeg = new Map<string, number>()
  const parents = new Map<string, string[]>()
  for (const l of g.links) {
    outDeg.set(l.source, (outDeg.get(l.source) ?? 0) + 1)
    parents.set(l.target, [...(parents.get(l.target) ?? []), l.source])
  }
  // a leaf with exactly one parent can be folded into that parent's "+N more"
  const foldable = g.nodes.filter(n => !outDeg.get(n.id) && parents.get(n.id)?.length === 1 && !keep.has(n.id) && !(n as DNode).members)
  const parentOf = (n: AskNode) => parents.get(n.id)![0]
  const fixed = g.nodes.length - foldable.length
  const ranked = [...foldable].sort(strength)

  let k = Math.max(0, max - fixed)
  let shown = new Set<string>()
  for (;;) {
    shown = new Set(ranked.slice(0, k).map(n => n.id))
    foldable.forEach(n => { if (expanded.has(parentOf(n))) shown.add(n.id) })
    const groups = new Set(foldable.filter(n => !shown.has(n.id)).map(parentOf))
    if (fixed + shown.size + groups.size <= max || k === 0) break
    k--
  }

  const hidden = new Map<string, AskNode[]>()
  foldable.forEach(n => { if (!shown.has(n.id)) hidden.set(parentOf(n), [...(hidden.get(parentOf(n)) ?? []), n]) })
  const hiddenIds = new Set([...hidden.values()].flat().map(n => n.id))
  const nodes: DNode[] = g.nodes.filter(n => !hiddenIds.has(n.id))
  const links: AskLink[] = g.links.filter(l => !hiddenIds.has(l.target))

  hidden.forEach((members, parent) => {
    const id = `more:${parent}`
    const kinds = new Set(members.map(m => m.kind))
    const word = kinds.size === 1 ? PLURAL[members[0].kind] ?? 'more' : 'more'
    const sum = usdSum(members)
    const memberLinks = g.links.filter(l => l.source === parent && members.some(m => m.id === l.target))
    const ranks = members.map(m => m.rank).filter((r): r is number => r != null)
    nodes.push({
      id, kind: 'group', label: `+${num(members.length)} more ${word}`, tone: worstTone(members), size: 1.2, count: members.length,
      step: Math.min(...members.map(m => m.step ?? 99)), members, parent,
      rank: ranks.length ? Math.min(...ranks) : undefined,
      ...(sum != null ? { metric: { value: sum, unit: 'usd' as const, label: `${usd(sum)} together` } } : {}),
      why: [`${num(members.length)} more ${word} here, folded to keep the picture readable.`, 'Click to show them all.'],
    })
    links.push({
      source: parent, target: id, tone: memberLinks[0]?.tone ?? worstTone(members), label: `${num(members.length)} more`,
      weight: Math.min(1, memberLinks.reduce((s, l) => s + (l.weight ?? 0), 0)),
      why: [`${num(members.length)} more ${word} depend on this.`],
    })
  })
  return { nodes, links, folded: hiddenIds.size }
}
