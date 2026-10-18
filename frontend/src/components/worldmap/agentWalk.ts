// "Watch the agents": one run's handoff chain replayed on the globe. Each agent walks what it actually
// read or wrote in FalkorDB (GET /api/{tenant}/geo/run/{id}: its EVIDENCE nodes and route options),
// in handoff order. Pure data; WorldMap.tsx plays it.
import { arcDeg, type Arc, type GeoData, type LL } from '../../lib/geoScene'

export interface WalkRoute { id: string; root: string; option: string; hubs: string[]; modes: string[]; days: number; chosen: boolean }
export interface WalkStep { id: string; seq: number; agent: string; kind: string; status: string; summary: string; ids: string[]; routes: WalkRoute[] }
export interface WalkData { run: string; closed: string[]; steps: WalkStep[]; geo: GeoData }

export const AGENT_NAME: Record<string, string> = {
  sentinel: 'Sentinel', impact_analyst: 'Impact Analyst', rerouter: 'Rerouter', finance: 'Finance',
  verifier: 'Verifier', approval: 'Approval', comms: 'Comms',
}
// one colour per agent, from the palette (tokens.css): periwinkle, coral, green, amber, steel-teal, mauve
export const AGENT_RGB: Record<string, string> = {
  sentinel: '146, 161, 194', impact_analyst: '189, 108, 115', rerouter: '127, 181, 154', finance: '217, 168, 108',
  verifier: '132, 196, 205', approval: '241, 238, 246', comms: '162, 134, 156',
}

export type WalkArc = Arc & { rgb: string }
export interface WalkRing { key: string; at: LL; rgb: string }
/** One moment of the walk: what appears, where the agent's badge goes, what the caption says. */
export interface Beat { at: number; agent: string; arcs: WalkArc[]; rings: WalkRing[]; path?: { pts: LL[]; dur: number }; caption?: string }

const first = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim()

export function buildWalk(data: WalkData): { beats: Beat[]; total: number; points: LL[]; port: LL | null } {
  const geo = data.geo
  const hub = (id: string): LL | null => { const h = geo.hubs[id]; return h ? { lat: h.lat, lng: h.lon } : null }
  const where = (id: string): LL | null => {
    const p = geo.places[id]
    if (!p) return null
    return p.type === 'route' ? hub(p.hubs[p.hubs.length - 1]) : hub(p.hub)
  }
  const routeOf = (id: string): LL[] => {
    const p = geo.places[id]
    return p?.type === 'route' ? p.hubs.map(hub).filter((x): x is LL => !!x) : []
  }
  const port = data.closed.map(hub).find(Boolean) ?? null
  const beats: Beat[] = []
  const points: LL[] = port ? [port] : []
  let t = 0, n = 0
  const arc = (from: LL, to: LL, agent: string, stroke = 0.75, lift = 0.3): WalkArc[] => {
    if (arcDeg(from, to) < 0.25) return []
    points.push(from, to)
    const k = `w${n++}`
    const base = { from, to, tone: 'neutral' as const, stroke, blocked: false, lift, step: 0, ids: [], label: AGENT_NAME[agent] ?? agent, rgb: AGENT_RGB[agent] ?? AGENT_RGB.sentinel }
    return [{ ...base, key: `${k}:b`, layer: 'base', phase: 0 }, { ...base, key: `${k}:f`, layer: 'flow', phase: (n * 0.37) % 1 }]
  }
  const legs = (pts: LL[], agent: string, stroke?: number, lift?: number) => pts.slice(1).flatMap((p, i) => arc(pts[i], p, agent, stroke, lift))
  const ring = (at: LL | null, agent: string): WalkRing[] => (at ? [{ key: `r${n++}`, at, rgb: AGENT_RGB[agent] ?? AGENT_RGB.sentinel }] : [])
  const uniq = (pts: (LL | null)[]) => {
    const out: LL[] = []
    for (const p of pts) if (p && !out.some(q => arcDeg(p, q) < 0.4)) out.push(p)
    return out
  }

  for (const s of data.steps) {
    const a = s.agent
    const caption = first(s.summary)
    if (s.kind === 'alert') {
      // the Sentinel sees the closed port and the shipments passing through it
      const ships = s.ids.filter(id => geo.places[id]?.type === 'route').slice(0, 14)
      beats.push({ at: t, agent: a, caption, arcs: [], rings: ring(port, a), path: port ? { pts: [port], dur: 400 } : undefined })
      ships.forEach((id, i) => beats.push({ at: t + 250 + i * 90, agent: a, arcs: legs(routeOf(id), a, 0.55), rings: [] }))
      t += 2000
    } else if (s.kind === 'recall') {
      // ... and remembers past disruptions like it (drawn where they happened)
      const past = uniq(s.ids.map(where)).filter(p => !port || arcDeg(p, port) > 0.4)
      beats.push({ at: t, agent: a, caption, arcs: [], rings: [], path: port ? { pts: [port, ...past, port], dur: 1700 } : undefined })
      past.forEach((p, i) => beats.push({ at: t + 200 + i * 380, agent: a, arcs: port ? arc(port, p, a, 0.6, 0.45) : [], rings: ring(p, a) }))
      t += 2000
    } else if (s.kind === 'impact') {
      // the Impact Analyst follows the delay out to the promises it breaks
      const zones = uniq(s.ids.filter(id => /^(PRM|ORD)-/.test(id)).map(where)).slice(0, 24)
      const far = [...zones].sort((x, y) => (port ? arcDeg(port, y) - arcDeg(port, x) : 0)).slice(0, 2)
      beats.push({ at: t, agent: a, caption, arcs: [], rings: [], path: port ? { pts: [port, ...far], dur: 1900 } : undefined })
      zones.forEach((z, i) => beats.push({ at: t + 150 + i * 60, agent: a, arcs: port ? arc(port, z, a, 0.5, 0.35) : [], rings: i < 6 ? ring(z, a) : [] }))
      t += 2200
    } else if (s.routes.length && s.kind === 'reroute') {
      // the Rerouter finds ways around the closed port
      const opts = s.routes.slice(0, 8)
      const firstPts = opts[0].hubs.map(hub).filter((x): x is LL => !!x)
      beats.push({ at: t, agent: a, caption, arcs: [], rings: [], path: { pts: firstPts, dur: 2000 } })
      opts.forEach((r, i) => beats.push({ at: t + 120 + i * 200, agent: a, arcs: legs(r.hubs.map(hub).filter((x): x is LL => !!x), a, r.option === 'fastest' ? 0.5 : 0.65, 0.22 + 0.04 * (i % 3)), rings: [] }))
      t += 2400
    } else if (s.kind === 'plan') {
      // Finance picks the rescues worth paying for
      const chosen = s.routes.filter(r => r.chosen)
      const ends = uniq(chosen.map(r => hub(r.hubs[r.hubs.length - 1])))
      beats.push({ at: t, agent: a, caption, arcs: [], rings: [], path: ends.length ? { pts: ends, dur: 1500 } : undefined })
      chosen.forEach((r, i) => beats.push({ at: t + 150 + i * 250, agent: a, arcs: legs(r.hubs.map(hub).filter((x): x is LL => !!x), a, 1.15, 0.24), rings: ring(hub(r.hubs[r.hubs.length - 1]), a) }))
      t += 2000
    } else if (s.kind === 'verification') {
      // the Verifier re-walks every chosen route, lane by lane
      const plan = data.steps.find(x => x.kind === 'plan')
      const chosen = (plan?.routes ?? []).filter(r => r.chosen)
      const walk = chosen.flatMap(r => r.hubs.map(hub).filter((x): x is LL => !!x))
      const per = chosen.length ? 2400 / Math.max(1, walk.length) : 0
      beats.push({ at: t, agent: a, caption, arcs: [], rings: [], path: walk.length ? { pts: walk, dur: 2400 } : undefined })
      let k = 0
      for (const r of chosen) {
        const pts = r.hubs.map(hub).filter((x): x is LL => !!x)
        pts.slice(1).forEach((p, i) => { beats.push({ at: t + per * ++k, agent: a, arcs: arc(pts[i], p, a, 0.5, 0.24), rings: ring(p, a) }) })
        k++
      }
      t += 2700
    } else if (s.kind === 'message') {
      // Comms tells the customers
      const zones = uniq(s.ids.map(where)).slice(0, 16)
      const from = port
      beats.push({ at: t, agent: a, caption, arcs: [], rings: [], path: zones.length ? { pts: zones.slice(0, 3), dur: 1500 } : undefined })
      zones.forEach((z, i) => beats.push({ at: t + 120 + i * 70, agent: a, arcs: from ? arc(from, z, a, 0.45, 0.35) : [], rings: ring(z, a) }))
      t += 1900
    }
  }
  return { beats, total: t, points, port }
}
