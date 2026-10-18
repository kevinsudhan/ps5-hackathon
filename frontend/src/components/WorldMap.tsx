import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import Globe, { type GlobeInstance } from 'globe.gl'
import * as THREE from 'three'
import type { AskGraph, Run, Tone } from '../api/types'
import { TONE_RGB } from '../lib/format'
import {
  arcDeg, between, buildScene, extraGraph, fitView, frameItems, geoRequest, summarize,
  type Arc, type GeoData, type GeoNetwork, type HopChip, type LL, type Marker, type MarkerIcon, type Scene, type Spot,
} from '../lib/geoScene'
import { rgb, token } from '../lib/theme'
import { useSize } from '../lib/useSize'
import type { Pick } from './AnswerGraph'
import AgentIcon from './agentgraph/AgentIcon'
import type { Col } from './agentgraph/words'
import { AGENT_NAME, AGENT_RGB, buildWalk, type WalkArc, type WalkData, type WalkRing } from './worldmap/agentWalk'
import { borderPaths, landFeatures } from './worldmap/land'
import '../styles/worldmap.css'

// The globe view: the current answer (or the story) drawn on the real world. Places come from
// POST /api/{tenant}/geo (backend/promisegraph/geo.py); the scene is built in lib/geoScene.ts.
export interface WorldMapProps {
  tenant: string
  graph: AskGraph
  animKey: string
  template?: string
  reduced: boolean
  story: boolean
  reveal?: number | null
  focus?: string[] | null
  flyKey?: number
  onPick: (pick: Pick | null, at: { x: number; y: number }) => void
  /** Split view: graph ids a "Step by step" step touched; light these up (they may not be in `graph`). */
  highlight?: { key: string; ids: string[]; label?: string } | null
  /** The agents' latest run, if any: the globe can replay it ("Watch the agents", and in the story). */
  run?: Run | null
}

type GeoReq = { ids: string[]; groups: Record<string, string[]>; key: string }
const geoCache = new Map<string, GeoData>()
async function fetchGeo(tenant: string, req: GeoReq, signal: AbortSignal): Promise<GeoData> {
  const key = `${tenant}|${req.key}`
  const hit = geoCache.get(key)
  if (hit) return hit
  const r = await fetch(`/api/${encodeURIComponent(tenant)}/geo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ ids: req.ids.slice(0, 600), groups: req.groups }),
  })
  if (!r.ok) throw new Error(`geo ${r.status}`)
  const data = (await r.json()) as GeoData
  geoCache.set(key, data)
  return data
}
const netCache = new Map<string, Promise<GeoNetwork>>()
function fetchNetwork(tenant: string): Promise<GeoNetwork> {
  let p = netCache.get(tenant)
  if (!p) {
    p = fetch(`/api/${encodeURIComponent(tenant)}/geo/network`).then(r => {
      if (!r.ok) throw new Error(`network ${r.status}`)
      return r.json() as Promise<GeoNetwork>
    })
    p.catch(() => netCache.delete(tenant))
    netCache.set(tenant, p)
  }
  return p
}

// globe.gl accessors are typed (obj: object) => T; ours know their datum type
const acc = <D, R>(f: (d: D) => R) => f as unknown as (d: object) => R
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const compact = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
type HtmlDatum = { el: 'marker'; m: Marker } | { el: 'chip'; c: HopChip }
type Path = { pts: [number, number][]; kind: 'lane' | 'border' }
type PortLabel = { lat: number; lng: number; name: string }
const NAMES_BELOW = 1.25          // camera altitude under which the network's port names appear

export default function WorldMap({ tenant, graph, animKey, template, reduced, story, reveal = null, focus = null, flyKey = 0, onPick, highlight = null, run = null }: WorldMapProps) {
  const [boxRef, size] = useSize<HTMLDivElement>()
  const box = useRef<HTMLDivElement | null>(null)
  const setBox = useCallback((el: HTMLDivElement | null) => { box.current = el; boxRef(el) }, [boxRef])
  const host = useRef<HTMLDivElement | null>(null)
  const globe = useRef<GlobeInstance | null>(null)
  const [ready, setReady] = useState(false)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const userMoved = useRef(false)
  const timers = useRef<number[]>([])
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)) }
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = [] }

  // ---- where everything is ------------------------------------------------------------------
  const req = useMemo(() => geoRequest(graph), [graph])
  const [geo, setGeo] = useState<{ key: string; data: GeoData } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const ctl = new AbortController()
    setFailed(false)
    fetchGeo(tenant, req, ctl.signal)
      .then(data => setGeo({ key: `${tenant}|${req.key}`, data }))
      .catch(e => { if ((e as Error).name !== 'AbortError') setFailed(true) })
    return () => ctl.abort()
  }, [tenant, req])
  const scene: Scene | null = useMemo(
    () => (geo && geo.key === `${tenant}|${req.key}` ? buildScene(graph, geo.data, template) : null),
    [geo, tenant, req, graph, template])

  // a highlight (split view) may name places the answer does not draw: look those up too
  const hlKey = highlight ? `${highlight.key}|${highlight.ids.join(',')}` : ''
  const [extra, setExtra] = useState<{ key: string; scene: Scene } | null>(null)
  useEffect(() => {
    if (!highlight || !scene) { setExtra(null); return }
    const ids = [...new Set(highlight.ids)].filter(id => !scene.anchors.has(id)).slice(0, 400)
    if (!ids.length) { setExtra({ key: hlKey, scene: buildScene({ nodes: [], links: [], truncated: false }, { hubs: {}, places: {} }) }); return }
    const ctl = new AbortController()
    fetchGeo(tenant, { ids, groups: {}, key: `hl:${ids.join(',')}` }, ctl.signal)
      .then(data => setExtra({ key: hlKey, scene: buildScene(extraGraph(ids, data), data) }))
      .catch(() => { /* the highlight still lights up what the answer draws */ })
    return () => ctl.abort()
  }, [hlKey, scene, tenant]) // eslint-disable-line react-hooks/exhaustive-deps
  const hl = highlight && extra?.key === hlKey ? { ids: new Set(highlight.ids), extra: extra.scene } : null

  // ---- the agents walking the graph: their latest run, replayed step by step ------------------------
  const [walkData, setWalkData] = useState<WalkData | null>(null)
  const runKey = run ? `${run.id}:${run.decisions.length}:${run.status}` : ''
  useEffect(() => {
    if (!run) { setWalkData(null); return }
    const ctl = new AbortController()
    fetch(`/api/${encodeURIComponent(tenant)}/geo/run/${encodeURIComponent(run.id)}`, { signal: ctl.signal })
      .then(r => (r.ok ? (r.json() as Promise<WalkData>) : null)).then(d => setWalkData(d))
      .catch(() => { /* no replay; everything else still works */ })
    return () => ctl.abort()
  }, [tenant, runKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const [walking, setWalking] = useState(false)
  const [walkLayer, setWalkLayer] = useState<{ arcs: WalkArc[]; rings: WalkRing[] }>({ arcs: [], rings: [] })
  const [walkCaption, setWalkCaption] = useState<{ agent: string; text: string } | null>(null)
  const [badgeAgent, setBadgeAgent] = useState<string | null>(null)
  const walkTimers = useRef<number[]>([])
  const badge = useRef<HTMLDivElement | null>(null)
  const badgePath = useRef<{ pts: LL[]; t0: number; dur: number } | null>(null)
  const stopWalk = useCallback(() => {
    walkTimers.current.forEach(clearTimeout)
    walkTimers.current = []
    badgePath.current = null
    setWalking(false)
    setWalkLayer({ arcs: [], rings: [] })
    setWalkCaption(null)
    setBadgeAgent(null)
  }, [])
  const playWalk = useCallback(() => {
    const g = globe.current
    if (!walkData || !g) return
    stopWalk()
    const { beats, total, points, port } = buildWalk(walkData)
    if (!beats.length) return
    setWalking(true)
    clearTimers()
    g.controls().autoRotate = false
    const pov = frameItems([{ pts: port ? [port] : [], must: true }, ...points.map(p => ({ pts: [p] }))], 0.8, 2.5)
    walkTimers.current.push(window.setTimeout(() => { if (pov) g.pointOfView(pov, reduced ? 0 : 1200) }, 60))
    const later = (fn: () => void, ms: number) => { walkTimers.current.push(window.setTimeout(fn, ms)) }
    if (reduced) {
      // no motion: every trail at once, then back to the answer
      setWalkLayer({ arcs: beats.flatMap(b => b.arcs).filter(a => a.layer === 'base'), rings: [] })
      setWalkCaption({ agent: beats[beats.length - 1].agent, text: "Everything the agents read and wrote in this run." })
      later(stopWalk, 9000)
      return
    }
    // the story gives the agents about ten seconds before it moves on: play faster there
    const k = story ? Math.min(1, 9600 / total) : 1, lead = story ? 300 : 1100
    for (const b of beats) {
      later(() => {
        if (b.arcs.length || b.rings.length) setWalkLayer(l => ({ arcs: [...l.arcs, ...b.arcs], rings: [...l.rings, ...b.rings] }))
        if (b.rings.length) later(() => setWalkLayer(l => ({ ...l, rings: l.rings.filter(r => !b.rings.includes(r)) })), 1900 * k)
        if (b.caption) setWalkCaption({ agent: b.agent, text: b.caption })
        if (b.path) { badgePath.current = { pts: b.path.pts, t0: performance.now(), dur: b.path.dur * k }; setBadgeAgent(b.agent) }
      }, lead + b.at * k)
    }
    later(stopWalk, lead + total * k + 3200)
  }, [walkData, reduced, stopWalk, story]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => stopWalk, [animKey, stopWalk])
  // the badge glides between the places its agent visits (screen-space, every frame)
  useEffect(() => {
    if (!walking) return
    let raf = 0
    const tick = () => {
      const g = globe.current, el = badge.current, bp = badgePath.current
      if (g && el && bp && bp.pts.length) {
        const k = Math.min(1, (performance.now() - bp.t0) / Math.max(1, bp.dur))
        const segs = bp.pts.length - 1
        let p = bp.pts[0]
        if (segs > 0) {
          const x = k * segs, i = Math.min(segs - 1, Math.floor(x)), f = x - i
          p = between(bp.pts[i], bp.pts[i + 1], f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2)
        }
        const view = g.pointOfView()
        const s = g.getScreenCoords(p.lat, p.lng, 0.04)
        el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`
        el.style.opacity = arcDeg({ lat: view.lat, lng: view.lng }, p) < 78 ? '1' : '0'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [walking])
  // in the story: once the camera has flown to the persona, the agents take over with the run the story started
  const storyRunAtStart = useRef<string | null | undefined>(undefined)
  const playedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!story) { storyRunAtStart.current = undefined; playedFor.current = null; stopWalk(); return }
    if (storyRunAtStart.current === undefined) storyRunAtStart.current = run?.id ?? null
  }, [story]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!story || !flyKey || focus?.length || !run || !walkData || walkData.run !== run.id) return
    if (run.id === storyRunAtStart.current || playedFor.current === run.id) return
    playedFor.current = run.id
    playWalk()
  }, [story, flyKey, focus?.length, walkData]) // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useCallback((step: number) => !story || reveal == null || step <= reveal, [story, reveal])
  const focusKey = (focus ?? []).join('|')
  const at = (e: MouseEvent) => {
    const r = box.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  // ---- the globe itself (made once) ------------------------------------------------------------
  const elements = useRef(new WeakMap<object, HTMLElement>())
  const portNames = useRef<PortLabel[]>([])
  const namesOn = useRef(false)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const periwinkle = rgb(token('--periwinkle'))
    const g = new Globe(el, { rendererConfig: { antialias: true, alpha: true }, animateIn: false })
    g.backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true).atmosphereColor('#7f93c9').atmosphereAltitude(0.2)
      .globeMaterial(new THREE.MeshPhongMaterial({ color: new THREE.Color('#1a1f3e'), emissive: new THREE.Color('#12152c'), emissiveIntensity: 0.75, shininess: 6, specular: new THREE.Color('#2a3360') }))
      .hexPolygonsData(landFeatures()).hexPolygonResolution(3).hexPolygonMargin(0.3)
      .hexPolygonUseDots(true).hexPolygonAltitude(0.002).hexPolygonsTransitionDuration(0)
      .hexPolygonColor(() => `rgba(${periwinkle}, 0.3)`)
      // the backdrop: country borders, the network's lanes (very faint) and every hub as a tiny dot
      .pathsData(borderPaths().map(pts => ({ pts, kind: 'border' }) as Path))
      .pathPoints(acc((p: Path) => p.pts)).pathPointLat((q: [number, number]) => q[1]).pathPointLng((q: [number, number]) => q[0])
      .pathPointAlt(0.0025).pathResolution(2).pathTransitionDuration(0).pathStroke(null)
      .pathColor(acc((p: Path) => (p.kind === 'border' ? `rgba(${periwinkle}, 0.16)` : `rgba(${periwinkle}, 0.11)`)))
      .particlesList(acc((d: { pts: object[] }) => d.pts))
      .particleLat(acc((h: { lat: number }) => h.lat)).particleLng(acc((h: { lon: number }) => h.lon)).particleAltitude(0.005)
      .particlesSize(2.6).particlesSizeAttenuation(false).particlesColor(() => `rgba(${periwinkle}, 0.75)`)
      .labelLat(acc((l: PortLabel) => l.lat)).labelLng(acc((l: PortLabel) => l.lng)).labelText(acc((l: PortLabel) => l.name))
      .labelSize(0.42).labelDotRadius(0.1).labelAltitude(0.006).labelResolution(2).labelsTransitionDuration(0)
      .labelColor(() => `rgba(${periwinkle}, 0.8)`)
      // the answer
      .arcStartLat(acc((a: Arc) => a.from.lat)).arcStartLng(acc((a: Arc) => a.from.lng))
      .arcEndLat(acc((a: Arc) => a.to.lat)).arcEndLng(acc((a: Arc) => a.to.lng))
      .arcAltitudeAutoScale(acc((a: Arc) => a.lift)).arcDashInitialGap(acc((a: Arc) => a.phase))
      .arcCurveResolution(56).arcCircularResolution(8)
      .arcLabel(acc((a: Arc) => `<div class="wm-tip">${esc(a.label)}</div>`))
      .onArcClick((d, e) => {
        const a = d as Arc
        if (a.node) pickRef.current({ type: 'node', node: a.node }, at(e))
        else if (a.link) pickRef.current({ type: 'link', link: a.link }, at(e))
      })
      .ringLat(acc((m: Marker) => m.at.lat)).ringLng(acc((m: Marker) => m.at.lng)).ringAltitude(0.004)
      .ringColor(acc((d: { rgb?: string }) => (t: number) => `rgba(${d.rgb ?? TONE_RGB.danger}, ${(0.95 * Math.pow(1 - t, 1.6)).toFixed(3)})`))
      .ringMaxRadius(7).ringPropagationSpeed(3.4).ringRepeatPeriod(900).ringResolution(72)
      .pointLat(acc((s: Spot) => s.at.lat)).pointLng(acc((s: Spot) => s.at.lng)).pointAltitude(0.004)
      .pointRadius(acc((s: Spot) => s.r)).pointColor(acc((s: Spot) => `rgba(${TONE_RGB[s.tone]}, 0.7)`))
      .pointLabel(acc((s: Spot) => `<div class="wm-tip">${esc(s.label)}</div>`))
      .onPointClick((d, e) => pickRef.current({ type: 'node', node: (d as Spot).node }, at(e)))
      .htmlLat(acc((d: HtmlDatum) => (d.el === 'marker' ? d.m.at : d.c.at).lat))
      .htmlLng(acc((d: HtmlDatum) => (d.el === 'marker' ? d.m.at : d.c.at).lng))
      .htmlAltitude(acc((d: HtmlDatum) => (d.el === 'marker' ? 0.008 : 0.03)))
      .htmlElement(d => elements.current.get(d) ?? document.createElement('div'))
      .htmlElementVisibilityModifier((node, shown) => { node.classList.toggle('wm-far', !shown) })
      .onGlobeClick((_c, e) => pickRef.current(null, at(e)))
      .onZoom(pov => {
        const want = pov.altitude < NAMES_BELOW
        if (want !== namesOn.current) { namesOn.current = want; g.labelsData(want ? portNames.current : []) }
      })
    const c = g.controls()
    c.minDistance = 125
    c.maxDistance = 600
    c.rotateSpeed = 0.55
    c.zoomSpeed = 0.7
    c.addEventListener('start', () => { userMoved.current = true; c.autoRotate = false })
    g.pointOfView({ lat: 18, lng: 70, altitude: 2.6 }, 0)
    globe.current = g
    setReady(true)
    return () => {
      clearTimers()
      const r = g.renderer()
      g._destructor()
      r.dispose()
      r.forceContextLoss()
      el.innerHTML = ''
      globe.current = null
    }
  }, [])

  // the network behind the answer (per company)
  useEffect(() => {
    if (!ready) return
    let alive = true
    fetchNetwork(tenant).then(net => {
      const g = globe.current
      if (!alive || !g) return
      const byId = new Map(net.hubs.map(h => [h.id, h]))
      const lanes: Path[] = net.lanes.map(([a, b]) => [byId.get(a), byId.get(b)])
        .filter((p): p is [GeoNetwork['hubs'][number], GeoNetwork['hubs'][number]] => !!p[0] && !!p[1])
        .map(([a, b]) => ({ pts: [[a.lon, a.lat], [b.lon, b.lat]], kind: 'lane' }))
      g.pathsData([...borderPaths().map(pts => ({ pts, kind: 'border' }) as Path), ...lanes])
      g.particlesData([{ pts: net.hubs.filter(h => h.kind !== 'zone') }])
      portNames.current = net.hubs.filter(h => h.kind === 'port' || h.kind === 'airport' || h.kind === 'dc_national')
        .map(h => ({ lat: h.lat, lng: h.lon, name: h.name.replace(/^Port of /, '') }))
      if (namesOn.current) g.labelsData(portNames.current)
    }).catch(() => { /* the backdrop is decoration; the answer still draws */ })
    return () => { alive = false }
  }, [tenant, ready])

  useEffect(() => {
    if (!globe.current || !size.width || !size.height) return
    // in the story the caption card covers the bottom of the stage: lift the globe above it
    globe.current.width(size.width).height(size.height).globeOffset([0, story ? -Math.round(size.height * 0.13) : 0])
  }, [size.width, size.height, ready, story])

  // ---- data on the globe: what is revealed, what the story focuses on, what a step highlights -------
  const shown = useRef<{ m: Marker; el: HTMLElement }[]>([])
  const shownChips = useRef<{ c: HopChip; el: HTMLElement }[]>([])
  useEffect(() => {
    const g = globe.current
    if (!g || !ready) return
    if (!scene) { g.arcsData([]).ringsData([]).pointsData([]).htmlElementsData([]); return }
    const lit = hl ? hl.ids : new Set(focus ?? [])
    const isExtra = new Set<object>([...(hl?.extra.markers ?? []), ...(hl?.extra.arcs ?? []), ...(hl?.extra.chips ?? [])])
    const agentArc = (a: Arc): a is WalkArc => 'rgb' in a
    const on = (a: Arc) => agentArc(a) || (!walking && (!lit.size || isExtra.has(a) || (a.node ? lit.has(a.node.id) : a.ids.every(id => lit.has(id)))))
    const arcs = [...scene.arcs, ...(hl?.extra.arcs.slice(0, 300) ?? []), ...walkLayer.arcs].filter(a => visible(a.step) && (!reduced || a.layer === 'base'))
    g.arcColor(acc((a: Arc) => {
      const c = agentArc(a) ? a.rgb : a.blocked ? TONE_RGB.danger : TONE_RGB[a.tone]
      const k = on(a)
      if (agentArc(a)) return a.layer === 'base' ? `rgba(${c}, 0.7)` : [`rgba(${c}, 0.7)`, `rgba(255, 255, 255, 0.95)`]
      if (a.blocked) return `rgba(${c}, ${k ? 0.95 : 0.25})`
      if (a.layer === 'base') return `rgba(${c}, ${reduced ? (k ? 0.9 : 0.18) : k ? 0.42 : 0.06})`
      return [`rgba(${c}, ${k ? 0.55 : 0.08})`, `rgba(${c}, ${k ? 1 : 0.14})`]
    }))
      .arcStroke(acc((a: Arc) => (a.layer === 'flow' ? a.stroke : a.stroke * 0.6) * (agentArc(a) ? 1.5 : lit.size && on(a) ? 1.45 : 1)))
      .arcDashLength(acc((a: Arc) => (a.blocked ? 0.022 : a.layer === 'flow' ? 0.09 : 1)))
      .arcDashGap(acc((a: Arc) => (a.blocked ? 0.022 : a.layer === 'flow' ? 0.27 : 0)))
      .arcDashAnimateTime(acc((a: Arc) => (reduced || a.layer === 'base' ? 0 : 3200)))
      .arcsTransitionDuration(reduced ? 0 : walking ? 700 : 900)
      .arcsData(arcs)
    g.ringsData(reduced ? [] : [...scene.markers.filter(m => m.ring && visible(m.step)), ...walkLayer.rings])
    g.pointsTransitionDuration(0).pointsData(scene.spots.filter(s => visible(s.step)))

    const html: HtmlDatum[] = []
    shown.current = []
    shownChips.current = []
    for (const m of [...scene.markers, ...(hl?.extra.markers.slice(0, 200) ?? [])]) {
      if (!visible(m.step)) continue
      let el = elements.current.get(m)
      if (!el) { el = markerEl(m, (mk, e) => pickRef.current({ type: 'node', node: mk.node }, at(e)), isExtra.has(m)); elements.current.set(m, el) }
      const hit = lit.size > 0 && (isExtra.has(m) || m.ids.some(id => lit.has(id)))
      el.classList.toggle('dim', lit.size > 0 && !hit)
      el.classList.toggle('hl', !!hl && hit)
      el.classList.toggle('label-on', (hit && (!hl || !isExtra.has(m) || (hl.extra.markers.length <= 12))) || (m.important && !lit.size) || m.ring)
      shown.current.push({ m, el })
      // a datum object per marker, kept stable so globe.gl reuses its element
      html.push(datum(m, () => ({ el: 'marker', m })))
    }
    const hops = !story && template === 'why_late' && scene.chips.length <= 12
    const chips = [...scene.chips, ...(hl && hl.extra.chips.length <= 8 ? hl.extra.chips : [])]
    for (const c of chips) {
      const wanted = hl ? lit.has(c.node.id) && (hl.ids.size <= 14) : hops || lit.has(c.node.id)
      if (!visible(c.step) || !wanted) continue
      if (!elements.current.get(c)) elements.current.set(c, chipEl(c, (ch, e) => pickRef.current({ type: 'node', node: ch.node }, at(e))))
      html.push(datum(c, () => ({ el: 'chip', c })))
      shownChips.current.push({ c, el: elements.current.get(c)! })
    }
    g.htmlTransitionDuration(reduced ? 0 : 600).htmlElementsData(html)
  }, [scene, visible, focusKey, reduced, ready, story, template, hl?.extra, walkLayer, walking]) // eslint-disable-line react-hooks/exhaustive-deps

  // stable wrapper objects for the HTML layer (and their elements)
  const wrappers = useRef(new WeakMap<object, HtmlDatum>())
  function datum(o: Marker | HopChip, make: () => HtmlDatum): HtmlDatum {
    let d = wrappers.current.get(o)
    if (!d) {
      d = make()
      wrappers.current.set(o, d)
      elements.current.set(d, elements.current.get(o)!)
    }
    return d
  }

  // ---- camera ----------------------------------------------------------------------------------
  // everything shown must fit; the view centres on the places and route ends (not every stop on the way)
  // in order of importance: the closed place and a persona's order always; then the biggest groups,
  // the costliest routes, the rest (the story: nearest the port first)
  const viewFor = useCallback((s: Scene) => {
    if (story) {
      // the story pulls back smoothly as the wave spreads: the closed port weighs as much as the rest
      const all: LL[] = [], centre: LL[] = []
      for (const [id, a] of s.anchors) {
        if (!visible(s.steps.get(id) ?? 0)) continue
        all.push(...a.all)
        centre.push(a.in, a.out)
      }
      const port = s.markers.find(m => m.ring)?.at
      if (port) centre.push(...centre.map(() => port))
      return fitView(all, 0.95, 2.4, centre, 1)
    }
    const ms = s.markers.filter(m => visible(m.step))
    const routes = [...s.anchors.entries()].filter(([id, a]) => a.route && visible(s.steps.get(id) ?? 0))
    const node = (id: string) => s.markers.find(m => m.ids.includes(id))?.node ?? s.chips.find(c => c.node.id === id)?.node
    const items: { pts: LL[]; must?: boolean; w: number }[] = [
      ...ms.map(m => ({ pts: [m.at], must: m.ring || (m.node.kind === 'order' && m.important), w: story ? -m.step : m.node.kind === 'group' ? 1e6 + m.weight : m.weight })),
      ...routes.map(([id, a]) => ({ pts: a.all, w: story ? -(s.steps.get(id) ?? 0) : node(id)?.metric?.value ?? 1 })),
    ]
    items.sort((a, b) => b.w - a.w)
    return frameItems(items, story ? 0.95 : 0.6, 2.5)
  }, [visible, story])
  const fit = useCallback((ms: number) => {
    const g = globe.current
    const pov = g && scene ? viewFor(scene) : null
    if (g && pov) g.pointOfView(pov, reduced ? 0 : ms)
  }, [scene, viewFor, reduced])

  // labels: the closed place always shows; others, most important first, go right, left, or a little
  // above/below with a leader line; whatever still collides hides until hovered
  useEffect(() => {
    const g = globe.current
    if (!g || !scene) return
    const tick = () => {
      const boxes: number[][] = []
      const W = g.width(), H = g.height()
      // the stage's own chrome (title, view switch, summary, legend, re-centre) is in the way too
      const origin = box.current?.getBoundingClientRect()
      if (origin) {
        for (const o of box.current!.parentElement?.querySelectorAll('.stage-top > *, .wm-summary, .wm-legend, .stage-recentre, .stage-highlight') ?? []) {
          const r = o.getBoundingClientRect()
          if (r.width) boxes.push([r.left - origin.left - 4, r.top - origin.top - 4, r.right - origin.left + 4, r.bottom - origin.top + 4])
        }
      }
      const hit = (b: number[]) => b[0] < 2 || b[2] > W - 2 || b[1] < 4 || b[3] > H - 4 || boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])
      // dots first: a label never covers another place
      const live = shown.current.filter(({ el }) => el.isConnected && !el.classList.contains('wm-far'))
      const pos = new Map<HTMLElement, { x: number; y: number }>()
      for (const { m, el } of live) {
        const p = g.getScreenCoords(m.at.lat, m.at.lng, 0.008)
        if (!p) continue
        pos.set(el, p)
        const r = m.size / 2
        boxes.push([p.x - r, p.y - r, p.x + r, p.y + r])
      }
      for (const { m, el } of live) {
        const p = pos.get(el)
        if (!p || !el.classList.contains('label-on')) continue
        const lab = el.querySelector('.wm-label') as HTMLElement
        const w = lab.offsetWidth, h = lab.offsetHeight, r = m.size / 2, gap = 7
        const box = (side: 1 | -1, dy: number) => side > 0 ? [p.x + r + gap - 2, p.y + dy - h / 2, p.x + r + gap + w + 2, p.y + dy + h / 2]
          : [p.x - r - gap - w - 2, p.y + dy - h / 2, p.x - r - gap + 2, p.y + dy + h / 2]
        const step = h + 6
        const tries: [1 | -1, number][] = [[1, 0], [-1, 0], [1, -step], [1, step], [-1, -step], [-1, step], [1, -2 * step], [1, 2 * step], [-1, -2 * step], [-1, 2 * step]]
        // (a label box starts past the marker's own dot, so its own dot never blocks it)
        let pick: [1 | -1, number] | null = null
        for (const t of tries) { if (!hit(box(t[0], t[1]))) { pick = t; break } }
        if (!pick && m.ring) pick = p.x + r + gap + w < W - 4 ? [1, 0] : [-1, 0]     // the closed port's label always shows
        el.classList.toggle('crowded', !pick)
        if (!pick) continue
        el.classList.toggle('flip', pick[0] < 0)
        lab.style.setProperty('--dy', `${pick[1]}px`)
        const lead = el.querySelector('.wm-lead') as HTMLElement
        if (pick[1]) {
          const x = pick[0] * (r + gap), y = pick[1]
          lead.style.width = `${Math.hypot(x, y)}px`
          lead.style.transform = `rotate(${Math.atan2(y, x)}rad)`
          el.classList.add('led')
        } else el.classList.remove('led')
        boxes.push(box(pick[0], pick[1]))
      }
      // hop labels: the middle of the longest leg, or the first free spot further along the route
      const view = g.pointOfView()
      for (const { c, el } of shownChips.current) {
        if (!el.isConnected) continue
        const pill = el.firstElementChild as HTMLElement
        const w = pill.offsetWidth, h = pill.offsetHeight
        const p0 = g.getScreenCoords(c.at.lat, c.at.lng, 0.03)
        let placed = false
        for (const dy of [0, -(h + 6), h + 6]) {
          for (const q of c.cands) {
            if (arcDeg({ lat: view.lat, lng: view.lng }, q) > 72) continue
            const s = g.getScreenCoords(q.lat, q.lng, 0.03)
            const p = { x: s.x, y: s.y + dy }
            const b = [p.x - w / 2 - 3, p.y - h / 2 - 2, p.x + w / 2 + 3, p.y + h / 2 + 2]
            if (hit(b)) continue
            pill.style.transform = `translate(${Math.round(p.x - p0.x - w / 2)}px, ${Math.round(p.y - p0.y - h / 2)}px)`
            boxes.push(b)
            placed = true
            break
          }
          if (placed) break
        }
        el.classList.toggle('crowded', !placed)
      }
    }
    tick()
    const id = window.setInterval(tick, 160)
    return () => clearInterval(id)
  }, [scene, ready])

  // a new answer: fly to fit it; the first time, swing in and turn gently for a few seconds
  const fittedFor = useRef<string | null>(null)
  const firstShow = useRef(true)
  useEffect(() => {
    const g = globe.current
    if (!g || !ready || !scene || fittedFor.current === animKey) return
    fittedFor.current = animKey
    userMoved.current = false
    clearTimers()
    const pov = viewFor(scene)
    if (!pov) return
    const c = g.controls()
    if (firstShow.current && !reduced) {
      // the first time: swing in from the west and settle on the answer (the turn ends where it fits)
      firstShow.current = false
      c.autoRotate = false
      g.pointOfView({ lat: pov.lat + 8, lng: pov.lng - 55, altitude: pov.altitude + 1.2 }, 0)
      g.pointOfView(pov, 2600)
    } else {
      firstShow.current = false
      c.autoRotate = false
      g.pointOfView(pov, reduced ? 0 : 1400)
    }
  }, [scene, animKey, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  // the stage changed size (split view, window): refit unless the person has moved the globe
  useEffect(() => {
    if (!scene || userMoved.current || fittedFor.current !== animKey || hl || focus?.length) return
    const t = window.setTimeout(() => fit(600), 250)
    return () => clearTimeout(t)
  }, [size.width, size.height]) // eslint-disable-line react-hooks/exhaustive-deps

  // the story: pull back as the red wave spreads; refit when the camera flight is over
  useEffect(() => {
    if (!story || !scene || focus?.length || fittedFor.current !== animKey) return
    fit(1100)
  }, [story, reveal, focusKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // a step picked in the split view: fly to what it touched; back to the whole answer when it clears
  const hadHl = useRef(false)
  useEffect(() => {
    const g = globe.current
    if (!g || !scene) return
    if (!hl) {
      if (hadHl.current) { hadHl.current = false; fit(1100) }
      return
    }
    hadHl.current = true
    const items = [...hl.ids].map((id, i) => ({ pts: (scene.anchors.get(id) ?? hl.extra.anchors.get(id))?.all ?? [], must: i === 0 }))
    const pov = frameItems(items.filter(it => it.pts.length).map((it, i) => ({ ...it, must: i === 0 })), 1.05, 2.5)
    if (pov) { g.controls().autoRotate = false; g.pointOfView(pov, reduced ? 0 : 1200) }
  }, [hl?.extra, scene]) // eslint-disable-line react-hooks/exhaustive-deps

  // the story's persona: fly hop by hop along their chain
  useEffect(() => {
    const g = globe.current
    if (!g || !flyKey || !focus?.length || !scene) return
    const hops: LL[] = []
    for (const id of focus) {
      const a = scene.anchors.get(id)
      if (!a) continue
      const p = a.route ? a.out : a.in
      if (hops.length && arcDeg(hops[hops.length - 1], p) < 1.2) hops[hops.length - 1] = p
      else hops.push(p)
    }
    if (!hops.length) return
    clearTimers()
    g.controls().autoRotate = false
    if (reduced) {
      const pov = fitView(hops, 0.8)
      if (pov) g.pointOfView(pov, 0)
      return
    }
    const per = Math.max(900, Math.min(2200, (focus.length * 950) / hops.length))
    hops.forEach((p, i) => {
      later(() => {
        const prev = i ? hops[i - 1] : p
        const d = arcDeg(prev, p)
        const low = i === hops.length - 1 ? 0.9 : 1.0
        if (d > 22) {
          const mid = between(prev, p, 0.5)
          g.pointOfView({ lat: mid.lat, lng: mid.lng, altitude: Math.min(2.1, 0.9 + d / 60) }, per * 0.5)
          later(() => g.pointOfView({ lat: p.lat - 1, lng: p.lng, altitude: low }, per * 0.5), per * 0.5)
        } else {
          g.pointOfView({ lat: p.lat - 1, lng: p.lng, altitude: i === 0 ? 1.05 : low }, per * 0.9)
        }
      }, i * per)
    })
  }, [flyKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- legend and the summary card -------------------------------------------------------------
  const legend = useMemo(() => {
    if (!scene) return null
    const tones = new Set<Tone>()
    const icons = new Set<MarkerIcon>()
    let ring = false, blocked = false
    for (const m of scene.markers) { if (!visible(m.step)) continue; ring ||= m.ring; if (!m.ring) icons.add(m.icon) }
    for (const a of scene.arcs) { if (!visible(a.step)) continue; if (a.blocked) blocked = true; else tones.add(a.tone) }
    return { tones: (['danger', 'warning', 'good', 'neutral', 'muted'] as Tone[]).filter(t => tones.has(t)), icons: ICON_ORDER.filter(i => icons.has(i)), ring, blocked }
  }, [scene, visible])
  const summary = useMemo(() => (scene && geo ? summarize(graph, scene, geo.data, visible) : []), [scene, geo, graph, visible])

  return (
    <div className={`wm${story ? ' story' : ''}${hl ? ' highlighting' : ''}${walking ? ' walking' : ''}`} ref={setBox}>
      <div className="wm-stars" aria-hidden />
      <div className="wm-globe" ref={host} />
      <div className="wm-vignette" aria-hidden />
      {!scene && !failed && <div className="wm-status"><span className="spinner" /> Placing the answer on the map…</div>}
      {failed && <div className="stage-empty">This answer could not be placed on the map. The diagram view still shows it.</div>}
      {scene && !story && summary.length > 0 && (
        <div className="wm-summary" aria-label="On the map">
          {summary.map((s, i) => {
            const m = s.match(/^([\d,]+)\s(.*)$/)
            return <span key={i} className={i === 0 && s.endsWith(' closed') ? 'closed' : ''}>{m ? <><b>{m[1]}</b> {m[2]}</> : s}</span>
          })}
        </div>
      )}
      {scene && legend && !story && (
        <div className="legend wm-legend" aria-label="Legend">
          {legend.ring && <span><i className="wm-key ring" />closed</span>}
          {legend.icons.map(i => <span key={i}><i className={`wm-key icon ${i}`} dangerouslySetInnerHTML={{ __html: ICON_SVG[i] ?? '' }} />{ICON_WORD[i]}</span>)}
          {(legend.icons.length > 0 || legend.ring) && legend.tones.length > 0 && <span className="legend-sep" aria-hidden />}
          {legend.tones.map(t => <span key={t}><i className={`wm-key line tone-${t}`} />{t === 'muted' && template === 'reroute' ? 'other options' : TONE_WORD[t]}</span>)}
          {legend.blocked && <span><i className="wm-key dashed" />closed way</span>}
          {scene.missing > 0 && <><span className="legend-sep" aria-hidden /><span>{scene.missing} not on the map</span></>}
        </div>
      )}
      {walking && badgeAgent && (
        <div className="wm-agent" ref={badge} style={{ '--agent-rgb': AGENT_RGB[badgeAgent] } as CSSProperties} aria-hidden>
          <div><AgentIcon col={badgeAgent as Col} className="wm-agent-icon" />{AGENT_NAME[badgeAgent] ?? badgeAgent}</div>
        </div>
      )}
      {walkCaption && (
        <div className="wm-walk-caption" role="status" style={{ '--agent-rgb': AGENT_RGB[walkCaption.agent] } as CSSProperties}>
          <span className="who"><AgentIcon col={walkCaption.agent as Col} className="wm-agent-icon" />{AGENT_NAME[walkCaption.agent] ?? walkCaption.agent}</span>
          <span className="what">{walkCaption.text}</span>
        </div>
      )}
      {scene && !story && run && walkData && walkData.run === run.id && (
        <button className="btn btn-sm wm-walk-btn" onClick={e => { e.stopPropagation(); if (walking) stopWalk(); else playWalk() }}
          title="Replay the agents' run on the globe: what each one read and wrote in FalkorDB">{walking ? 'Stop' : '▶ Watch the agents'}</button>
      )}
      {scene && !story && (
        <button className="btn btn-sm stage-recentre"
          onClick={e => { e.stopPropagation(); userMoved.current = false; if (globe.current) globe.current.controls().autoRotate = false; fit(1100) }}
          title="Fit the whole answer in view">Re-centre</button>
      )}
    </div>
  )
}

const TONE_WORD: Record<Tone, string> = { danger: 'late or stuck', warning: 'delayed', good: 'on track', neutral: 'route', muted: 'lane' }
const ICON_ORDER: MarkerIcon[] = ['port', 'airport', 'warehouse', 'factory', 'place', 'group', 'order', 'event']
const ICON_WORD: Record<MarkerIcon, string> = {
  port: 'port', airport: 'airport', warehouse: 'warehouse', factory: 'supplier or factory', place: 'city',
  group: 'late orders (count)', order: 'customer order', event: 'disruption',
}
// small line icons drawn inside the marker dots (24-unit grid)
const ICON_SVG: Partial<Record<MarkerIcon, string>> = {
  port: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><path d="M12 7.2V20M5 13a7 7 0 0 0 14 0M8.5 10.5h7"/></svg>',
  airport: '<svg viewBox="0 0 24 24"><path d="M21 15.5v-1.8l-7.5-4.7V4.2a1.5 1.5 0 0 0-3 0V9L3 13.7v1.8l7.5-2.3v4.6l-2 1.5V21l3.5-1 3.5 1v-1.7l-2-1.5v-4.6z" class="fill"/></svg>',
  warehouse: '<svg viewBox="0 0 24 24"><path d="M3.5 10 12 4.5l8.5 5.5V20h-17zM8 20v-6h8v6"/></svg>',
  factory: '<svg viewBox="0 0 24 24"><path d="M3.5 20V10l5 3.2V10l5 3.2V5h7v15z"/></svg>',
  place: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" class="fill"/></svg>',
  event: '<svg viewBox="0 0 24 24"><path d="M12 6v8M12 17.5v.5"/></svg>',
  order: '',
  group: '',
}

function markerEl(m: Marker, onClick: (m: Marker, e: MouseEvent) => void, extra = false): HTMLElement {
  const el = document.createElement('div')
  el.className = `wm-mk tone-${m.tone} icon-${m.icon}${m.ring ? ' ring' : ''}${m.count != null ? ' counted' : ''}${extra ? ' extra' : ''}`
  el.style.setProperty('--sz', `${Math.round(m.size + (m.icon === 'warehouse' || m.icon === 'port' || m.icon === 'airport' || m.icon === 'factory' ? 3 : 0))}px`)
  const lead = document.createElement('i')
  lead.className = 'wm-lead'
  const dot = document.createElement('button')
  dot.type = 'button'
  dot.className = 'wm-dot'
  dot.setAttribute('aria-label', m.sub ? `${m.label}, ${m.sub}` : m.label)
  if (m.count != null) dot.textContent = compact(m.count)
  else if (ICON_SVG[m.icon]) dot.innerHTML = ICON_SVG[m.icon]!
  const label = document.createElement('span')
  label.className = 'wm-label'
  const b = document.createElement('b')
  b.textContent = m.label
  label.append(b)
  if (m.sub) {
    const s = document.createElement('small')
    s.textContent = m.sub
    label.append(s)
  }
  el.append(lead, dot, label)
  const click = (e: MouseEvent) => { e.stopPropagation(); onClick(m, e) }
  dot.addEventListener('click', click)
  label.addEventListener('click', click)
  return el
}

function chipEl(c: HopChip, onClick: (c: HopChip, e: MouseEvent) => void): HTMLElement {
  const el = document.createElement('div')
  el.className = `wm-chip-at tone-${c.tone}`
  const pill = document.createElement('button')
  pill.type = 'button'
  pill.className = 'wm-chip'
  pill.title = c.full
  pill.setAttribute('aria-label', c.lead ? `${c.lead}: ${c.full}` : c.full)
  if (c.lead) {
    const b = document.createElement('b')
    b.textContent = c.lead
    pill.append(b)
  }
  const t = document.createElement('span')
  t.className = 'wm-chip-text'
  t.append(document.createTextNode(c.text))
  if (c.sub) {
    const s = document.createElement('small')
    s.textContent = c.sub
    t.append(s)
  }
  pill.append(t)
  pill.addEventListener('click', e => { e.stopPropagation(); onClick(c, e) })
  el.append(pill)
  return el
}
