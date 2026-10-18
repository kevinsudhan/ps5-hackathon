// The globe view's scene: answer-graph nodes placed on the world (backend/promisegraph/geo.py says
// where each id is), turned into markers, arcs, hop labels and rings. Pure functions, no three.js.
import type { AskGraph, AskLink, AskNode, NodeKind, Tone } from '../api/types'

export interface GeoHub { id: string; name: string; kind: string; lat: number; lon: number }
export type GeoPlace =
  | { type: 'point'; hub: string; customer?: string }
  | { type: 'route'; hubs: string[]; mode?: string; stage?: string }
  | { type: 'spread'; hub: string; zones: [string, number][] }
export interface GeoData { hubs: Record<string, GeoHub>; places: Record<string, GeoPlace> }

export interface LL { lat: number; lng: number }
export interface Anchor { in: LL; out: LL; mid: LL; all: LL[]; hubs: string[]; route: boolean }

export interface Marker {
  key: string; at: LL; node: AskNode; nodes: AskNode[]; ids: string[]
  tone: Tone; size: number; label: string; sub: string | null; count: number | null
  important: boolean; ring: boolean; step: number
}
export interface Arc {
  key: string; layer: 'base' | 'flow'; from: LL; to: LL; tone: Tone; stroke: number; blocked: boolean
  lift: number; phase: number; step: number; ids: string[]; node?: AskNode; link?: AskLink; label: string
}
export interface HopChip { key: string; at: LL; cands: LL[]; lead: string; text: string; tone: Tone; node: AskNode; step: number }
export interface Spot { key: string; at: LL; tone: Tone; r: number; step: number; node: AskNode; label: string }
export interface Scene {
  markers: Marker[]; arcs: Arc[]; chips: HopChip[]; spots: Spot[]
  anchors: Map<string, Anchor>; steps: Map<string, number>; missing: number
}

/** What to ask geo.py for: every node id, plus each group's parents (to find where its orders go). */
export function geoRequest(graph: AskGraph) {
  const ids = graph.nodes.map(n => n.id)
  const groups: Record<string, string[]> = {}
  for (const n of graph.nodes) {
    if (n.kind !== 'group') continue
    const parents = graph.links.filter(l => l.target === n.id).map(l => l.source)
    if (parents.length) groups[n.id] = parents
  }
  return { ids, groups, key: JSON.stringify([ids, groups]) }
}

// ---- spherical helpers ----------------------------------------------------------------------
const RAD = Math.PI / 180
function vec(p: LL): [number, number, number] {
  const la = p.lat * RAD, lo = p.lng * RAD
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
}
function fromVec([x, y, z]: number[]): LL {
  const r = Math.hypot(x, y, z) || 1
  return { lat: Math.asin(z / r) / RAD, lng: Math.atan2(y, x) / RAD }
}
/** Great-circle distance in degrees. */
export function arcDeg(a: LL, b: LL): number {
  const [x1, y1, z1] = vec(a), [x2, y2, z2] = vec(b)
  return Math.acos(Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2))) / RAD
}
/** The point a fraction t of the way from a to b along the great circle. */
export function between(a: LL, b: LL, t: number): LL {
  const d = arcDeg(a, b) * RAD
  if (d < 1e-6) return a
  const va = vec(a), vb = vec(b), s = Math.sin(d)
  const ka = Math.sin((1 - t) * d) / s, kb = Math.sin(t * d) / s
  return fromVec([va[0] * ka + vb[0] * kb, va[1] * ka + vb[1] * kb, va[2] * ka + vb[2] * kb])
}

/** A camera position that shows every point: look at their centre, back off until the farthest fits. */
export function fitView(points: LL[], minAlt = 0.6, maxAlt = 2.1, centreOn: LL[] = points): { lat: number; lng: number; altitude: number } | null {
  if (!points.length) return null
  const base = centreOn.length ? centreOn : points
  const sum = base.reduce((s, p) => { const v = vec(p); return [s[0] + v[0], s[1] + v[1], s[2] + v[2]] }, [0, 0, 0])
  const c = Math.hypot(sum[0], sum[1], sum[2]) < 1e-3 ? base[0] : fromVec(sum)
  const theta = Math.max(...points.map(p => arcDeg(c, p)))
  // a point theta away from the view centre appears phi off-axis; keep phi inside ~19 degrees (fov 50)
  const t = Math.min(90, theta) * RAD
  const alt = Math.cos(t) + Math.sin(t) / Math.tan(19 * RAD) - 1
  // tilt the centre a little south so labels (drawn to the right / below) are not cut by the top bar
  return { lat: c.lat - 2, lng: c.lng, altitude: Math.max(minAlt, Math.min(maxAlt, theta > 90 ? maxAlt : alt + 0.15)) }
}

const KIND_ORDER: Record<NodeKind, number> = {
  port: 0, airport: 1, warehouse: 2, factory: 2, place: 3, event: 4, group: 5, order: 6, shipment: 7,
}
const HUB_KINDS = new Set<NodeKind>(['port', 'airport', 'warehouse', 'factory', 'place'])

function dayCount(n: AskNode, incoming?: AskLink): string | null {
  if (incoming?.label && /^\+\d+d$/.test(incoming.label)) return incoming.label
  if (n.metric?.unit === 'days') return `+${n.metric.value}d`
  for (const w of n.why) {
    const m = w.match(/(\d+) days? late/)
    if (m) return `+${m[1]}d`
  }
  return null
}

const short = (s: string, n = 30) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

/** Lay the answer on the world. Nodes geo.py could not place are counted in `missing`. */
export function buildScene(graph: AskGraph, geo: GeoData, template?: string): Scene {
  const hubLL = (id: string): LL | null => {
    const h = geo.hubs[id]
    return h ? { lat: h.lat, lng: h.lon } : null
  }
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const into = new Map<string, AskLink[]>(), outOf = new Map<string, AskLink[]>()
  for (const l of graph.links) {
    into.set(l.target, [...(into.get(l.target) ?? []), l])
    outOf.set(l.source, [...(outOf.get(l.source) ?? []), l])
  }
  const steps = new Map<string, number>(graph.nodes.map(n => [n.id, n.step ?? 0]))

  // 1. anchors: where each node sits (a point, or a route through several hubs)
  const anchors = new Map<string, Anchor>()
  const spreads = new Map<string, [string, number][]>()
  for (const n of graph.nodes) {
    const p = geo.places[n.id]
    if (!p) continue
    if (p.type === 'route') {
      const ids = p.hubs.filter(h => geo.hubs[h])
      const pts = ids.map(h => hubLL(h)!)
      if (!pts.length) continue
      let best = 0, mid = pts[0]
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = arcDeg(pts[i], pts[i + 1])
        if (d > best) { best = d; mid = between(pts[i], pts[i + 1], 0.5) }
      }
      anchors.set(n.id, { in: pts[0], out: pts[pts.length - 1], mid, all: pts, hubs: ids, route: true })
    } else {
      const at = hubLL(p.hub)
      if (!at) continue
      anchors.set(n.id, { in: at, out: at, mid: at, all: [at], hubs: [p.hub], route: false })
      if (p.type === 'spread') spreads.set(n.id, p.zones)
    }
  }
  // groups and anything else unplaced: between the parent and the child, or at the parent's end
  for (const n of graph.nodes) {
    if (anchors.has(n.id)) continue
    const par = (into.get(n.id) ?? []).map(l => anchors.get(l.source)).find(Boolean)
    const kid = (outOf.get(n.id) ?? []).map(l => anchors.get(l.target)).find(Boolean)
    const at = par && kid ? between(par.out, kid.in, 0.5) : par ? par.out : kid ? kid.in : null
    if (at) anchors.set(n.id, { in: at, out: at, mid: at, all: [at], hubs: [], route: false })
  }

  // 2. markers: point-like nodes, merged when they sit on (almost) the same spot
  // (a closed place only merges with what is at that very hub: Changi airport is not the closed seaport)
  type Bucket = { at: LL; hub: string | null; closed: boolean; nodes: AskNode[] }
  const buckets: Bucket[] = []
  const closedHubs = new Set(graph.nodes.filter(n => n.kind === 'event' || n.blocked).map(n => anchors.get(n.id)?.hubs[0]))
  for (const n of graph.nodes) {
    const a = anchors.get(n.id)
    if (!a || a.route) continue
    const hub = a.hubs[0] ?? null
    const closed = closedHubs.has(hub ?? undefined)
    const b = buckets.find(x => (hub && x.hub === hub) || (!closed && !x.closed && arcDeg(x.at, a.in) < 0.4))
    if (b) b.nodes.push(n)
    else buckets.push({ at: a.in, hub, closed, nodes: [n] })
  }
  const few = buckets.length <= 14
  const markers: Marker[] = buckets.map(b => {
    const nodes = [...b.nodes].sort((x, y) => (KIND_ORDER[x.kind] - KIND_ORDER[y.kind]) || ((x.rank ?? 99) - (y.rank ?? 99)) || (y.size - x.size))
    const node = nodes[0]
    const hubsHere = nodes.filter(n => HUB_KINDS.has(n.kind))
    const orders = nodes.filter(n => n.kind === 'order')
    const ring = nodes.some(n => n.kind === 'event' || n.blocked)
    const count = node.kind === 'group' ? node.count ?? null : orders.length > 1 && node.kind === 'order' ? orders.length : null
    let size: number
    if (node.kind === 'group') size = 15 + Math.min(17, Math.sqrt(node.count ?? 1) * 1.15)
    else if (node.kind === 'order') size = orders.length > 1 ? 11 : 8
    else size = Math.max(10, Math.min(24, 5 + node.size * 4.2))
    // other places merged into this marker (the same hub twice, e.g. a stop on two routes, counts once)
    const extra = new Set(hubsHere.map(n => anchors.get(n.id)?.hubs[0] ?? n.id)).size - (HUB_KINDS.has(node.kind) ? 1 : 0)
    const label = node.kind === 'order' && orders.length > 1 ? `${node.label} +${orders.length - 1} more`
      : extra > 0 ? `${node.label} +${extra}` : node.label
    const sub = node.blocked || (ring && node.kind === 'port') ? 'Closed' : node.metric?.label ?? null
    const important = few || ring || node.kind === 'group' || (node.rank ?? 99) <= 3 || HUB_KINDS.has(node.kind) && node.size >= 2.5
    return {
      key: `m:${nodes.map(n => n.id).join('|')}`, at: b.at, node, nodes, ids: nodes.map(n => n.id), tone: node.tone,
      size, label, sub, count, important, ring, step: Math.min(...nodes.map(n => n.step ?? 0)),
    }
  })
  // label priority (the globe hides labels that would overlap one placed before them)
  const named = markers.filter(m => m.node.kind === 'order').length <= 3     // a persona's order, drawn on its own
  const prio = (m: Marker) => (m.ring ? 0 : 1e9)
    + (m.node.kind === 'group' ? 1e6 - (m.count ?? 0) : m.node.kind === 'order' && named ? 5e5 : 2e6)
    + (m.node.rank ?? (m.node.size >= 2 ? 0 : 999)) * 10 - m.node.size
  markers.sort((a, b) => prio(a) - prio(b))

  // 3. arcs: each shipment's legs, then the answer's links between places (skipping those a route already draws)
  const arcs: Arc[] = []
  let seq = 0
  const push = (a: Omit<Arc, 'layer' | 'phase' | 'key'>, key: string) => {
    const phase = ((seq++ * 0.381966) % 1)
    arcs.push({ ...a, key: `${key}:b`, layer: 'base', phase })
    if (!a.blocked) arcs.push({ ...a, key: `${key}:f`, layer: 'flow', phase })
  }
  const strokeOf = (w: number | undefined) => 0.5 + 1.2 * Math.max(0, Math.min(1, w ?? 0.3))
  for (const n of graph.nodes) {
    const a = anchors.get(n.id)
    if (!a?.route) continue
    const w = Math.max(0, ...(into.get(n.id) ?? []).map(l => l.weight ?? 0)) || undefined
    const label = n.metric?.label ? `${n.label} · ${n.metric.label}` : n.label
    for (let i = 0; i + 1 < a.all.length; i++) {
      if (arcDeg(a.all[i], a.all[i + 1]) < 0.05) continue
      push({ from: a.all[i], to: a.all[i + 1], tone: n.tone, stroke: strokeOf(w), blocked: false, lift: 0.32,
             step: n.step ?? 0, ids: [n.id], node: n, label }, `leg:${n.id}:${i}`)
    }
  }
  graph.links.forEach((l, i) => {
    const s = anchors.get(l.source), t = anchors.get(l.target)
    if (!s || !t) return
    if (!s.route && t.route && s.hubs.some(h => t.hubs.includes(h))) return
    if (s.route && !t.route && t.hubs.some(h => s.hubs.includes(h))) return
    if (arcDeg(s.out, t.in) < 0.3) return
    const lift = l.blocked ? 0.2 : l.route ? 0.26 + 0.12 * (l.route - 1) : 0.3
    const label = l.label ? `${byId.get(l.source)?.label ?? l.source} → ${byId.get(l.target)?.label ?? l.target} · ${l.label}`
      : `${byId.get(l.source)?.label ?? l.source} → ${byId.get(l.target)?.label ?? l.target}`
    push({ from: s.out, to: t.in, tone: l.tone, stroke: l.blocked ? 0.3 : strokeOf(l.weight), blocked: !!l.blocked, lift,
           step: Math.max(steps.get(l.source) ?? 0, steps.get(l.target) ?? 0), ids: [l.source, l.target], link: l, label },
         `link:${i}:${l.source}>${l.target}`)
  })

  // 4. hop labels at each shipment's longest leg ("+8d Radio modules"), and where grouped orders go
  const chips: HopChip[] = []
  for (const n of graph.nodes) {
    const a = anchors.get(n.id)
    if (!a?.route) continue
    const lead = dayCount(n, (into.get(n.id) ?? [])[0])
    // places along the route the label may slide to when the middle of its longest leg is taken
    const legs = a.all.slice(1).map((p, i) => [a.all[i], p] as const).sort((x, y) => arcDeg(y[0], y[1]) - arcDeg(x[0], x[1]))
    const cands = [a.mid, ...legs.flatMap(([p, q]) => [0.28, 0.72, 0.5].map(t => between(p, q, t)))]
    chips.push({ key: `c:${n.id}`, at: a.mid, cands, lead: lead ?? '', text: short(n.label, template === 'why_late' ? 28 : 24),
                 tone: n.tone, node: n, step: n.step ?? 0 })
  }
  const spots: Spot[] = []
  for (const [gid, zones] of spreads) {
    const g = byId.get(gid)!
    const top = Math.max(1, ...zones.map(z => z[1]))
    zones.slice(1).forEach(([z, cnt]) => {
      const at = hubLL(z)
      if (at) spots.push({ key: `s:${gid}:${z}`, at, tone: g.tone, r: 0.18 + 0.32 * Math.sqrt(cnt / top), step: g.step ?? 0, node: g,
                           label: `${geo.hubs[z]?.name ?? z}: part of ${g.label}` })
    })
  }

  const missing = graph.nodes.filter(n => !anchors.has(n.id)).length
  return { markers, arcs, chips, spots, anchors, steps, missing }
}
