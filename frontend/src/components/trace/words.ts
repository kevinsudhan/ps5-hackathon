// Plain-English wording for the step-by-step trace. Nothing here computes a business number.

import type { Answer, AskNode } from '../../api/types'
import { num } from '../../lib/format'

/** What FalkorDB was asked to walk, per question template, and the graph feature it leans on. */
export function walkWords(a: Answer): { text: string; feature: string } {
  const p = a.query.params as Record<string, unknown>
  const depth = Number(p.depth ?? 8)
  const steps = `up to ${depth} steps`
  switch (a.template) {
    case 'at_risk':
      return { feature: 'variable-length FEEDS traversal',
        text: `Start at the closed port, take the shipments passing through it while it is shut, follow every shipment that waits on another, ${steps}, and keep the orders that now miss their promised date.` }
    case 'top_loss_orders':
      return { feature: 'variable-length FEEDS traversal',
        text: `Start at the closed port, follow every shipment that waits on another, ${steps}, keep the orders that miss their promised date, then rank them by late fee and keep the top ${num(Number(p.n ?? 10))}.` }
    case 'why_late':
      return { feature: 'variable-length FEEDS traversal',
        text: `Start at ${p.customer ? `${p.customer}’s` : 'the'} order and walk back through the shipments it waits on to the closed port, measuring at each step how much delay is passed on and how much slack absorbs.` }
    case 'rescue_first':
      return { feature: 'algo.WCC',
        text: `Tag every shipment the disruption delays, then let FalkorDB’s connected-components algorithm split them into groups that share one cause. The biggest group is the one to rescue first.` }
    case 'weak_points':
      return { feature: 'algo.betweenness',
        text: 'Score every place by how many of the shortest routes between other places run through it. A high score means a closure there spreads furthest.' }
    case 'reroute':
      return { feature: 'algo.SPpaths',
        text: 'Find the shortest routes between the two places over the lane network, and throw away any route that passes through the closed place.' }
    case 'orders_window':
      return { feature: 'pattern match',
        text: `Start at ${p.city ?? 'the city'}, take the orders due in those dates, and compare each one’s last shipment with its promised date.` }
    default:
      return { feature: 'Cypher', text: 'Walk the graph for the pattern this question describes.' }
  }
}

/** The question's slots, as plain labelled values (ids are left out). */
export function slotRows(a: Answer): [string, string][] {
  const p = a.query.params as Record<string, unknown>
  const out: [string, string][] = []
  if (p.customer) out.push(['Customer', String(p.customer)])
  if (p.city) out.push(['City', String(p.city)])
  if (p.n != null) out.push(['How many', num(Number(p.n))])
  if (p.depth != null) out.push(['How far to follow', `${p.depth} steps`])
  return out
}

const KIND_WORD: Record<string, [string, string]> = {
  event: ['disruption', 'disruptions'], port: ['port', 'ports'], airport: ['airport', 'airports'], place: ['place', 'places'],
  warehouse: ['warehouse', 'warehouses'], factory: ['factory', 'factories'], shipment: ['shipment', 'shipments'],
  order: ['order', 'orders'], group: ['order', 'orders'],
}

export interface Hop { key: string; ids: string[]; text: string; detail: string }

/** "What came back", as a chain: the graph's nodes grouped by how far they are from the disruption. */
export function hops(a: Answer): Hop[] {
  const nodes = a.graph.nodes
  if (!nodes.length) return []
  if (a.template === 'weak_points') {
    // A ranking, not a chain: one link per place, most depended-on first.
    return [...nodes].sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99)).slice(0, 6)
      .map((n, i) => ({ key: `ans-back-r${i}`, ids: [n.id], text: n.label, detail: n.metric?.label ?? n.why[0] ?? '' }))
  }
  const byStep = new Map<number, AskNode[]>()
  nodes.forEach(n => {
    const s = n.step ?? (n.kind === 'event' || n.kind === 'port' ? 0 : n.kind === 'shipment' ? 1 : n.kind === 'order' || n.kind === 'group' ? 2 : 1)
    byStep.set(s, [...(byStep.get(s) ?? []), n])
  })
  const steps = [...byStep.keys()].sort((x, y) => x - y)
  return steps.slice(0, 8).map(s => {
    const ns = byStep.get(s)!
    const places = ns.filter(n => n.kind !== 'event')
    // A "more" group stands for the orders (or shipments) it folds, so it counts with them: Aisha's
    // own order plus the folded groups is the full 755, not just the groups.
    const kinds = new Map<string, number>()
    for (const n of places.length ? places : ns) {
      const k = n.kind === 'group' ? (/shipment/i.test(n.label) ? 'shipment' : 'order') : n.kind
      kinds.set(k, (kinds.get(k) ?? 0) + (n.kind === 'group' ? (n.count ?? 1) : 1))
    }
    const [kind, count] = [...kinds.entries()].sort((x, y) => y[1] - x[1])[0]
    const word = KIND_WORD[kind] ?? [kind, kind + 's']
    let text: string
    if (ns.length === 1 || (places.length === 1 && kind !== 'group')) text = (places[0] ?? ns[0]).label
    else if (kind === 'order' || kind === 'group') text = `${num(count)} late ${count === 1 ? word[0] : word[1]}`
    else text = `${num(count)} ${count === 1 ? word[0] : word[1]}`
    if (s === 0 && ns.some(n => n.kind === 'event') && places.length) text = `${places.map(n => n.label).join(' and ')}, closed`
    const ev = ns.find(n => n.kind === 'event')
    const detail = s === 0 && ev ? `Closed by: ${ev.label}.` : ns.slice(0, 3).map(n => n.label).join(' · ') + (ns.length > 3 ? ` and ${num(ns.length - 3)} more` : '')
    return { key: `ans-back-${s}`, ids: ns.map(n => n.id), text, detail }
  })
}

export const firstSentence = (s: string) => {
  const m = s.match(/^(.+?[.!?])(\s|$)/)
  return m ? m[1] : s
}
