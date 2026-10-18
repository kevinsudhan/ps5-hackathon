import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Globe, { type GlobeInstance } from 'globe.gl'
import * as THREE from 'three'
import type { AskGraph, Tone } from '../api/types'
import { TONE_RGB } from '../lib/format'
import { arcDeg, between, buildScene, fitView, geoRequest, type Arc, type GeoData, type HopChip, type LL, type Marker, type Scene, type Spot } from '../lib/geoScene'
import { rgb, token } from '../lib/theme'
import { useSize } from '../lib/useSize'
import type { Pick } from './AnswerGraph'
import { landFeatures } from './worldmap/land'
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
}

const geoCache = new Map<string, GeoData>()
async function fetchGeo(tenant: string, req: ReturnType<typeof geoRequest>, signal: AbortSignal): Promise<GeoData> {
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

// globe.gl accessors are typed (obj: object) => T; ours know their datum type
const acc = <D, R>(f: (d: D) => R) => f as unknown as (d: object) => R
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const compact = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
type HtmlDatum = { el: 'marker'; m: Marker } | { el: 'chip'; c: HopChip }

export default function WorldMap({ tenant, graph, animKey, template, reduced, story, reveal = null, focus = null, flyKey = 0, onPick }: WorldMapProps) {
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

  const visible = useCallback((step: number) => !story || reveal == null || step <= reveal, [story, reveal])
  const focusKey = (focus ?? []).join('|')
  const at = (e: MouseEvent) => {
    const r = box.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  // ---- the globe itself (made once) ------------------------------------------------------------
  const elements = useRef(new WeakMap<object, HTMLElement>())
  useEffect(() => {
    const el = host.current
    if (!el) return
    const periwinkle = rgb(token('--periwinkle'))
    const g = new Globe(el, { rendererConfig: { antialias: true, alpha: true }, animateIn: false })
    g.backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true).atmosphereColor(token('--periwinkle')).atmosphereAltitude(0.16)
      .globeMaterial(new THREE.MeshPhongMaterial({ color: new THREE.Color('#1a1f3e'), emissive: new THREE.Color('#12152c'), emissiveIntensity: 0.7, shininess: 4 }))
      .hexPolygonsData(landFeatures()).hexPolygonResolution(3).hexPolygonMargin(0.28)
      .hexPolygonUseDots(true).hexPolygonAltitude(0.002).hexPolygonsTransitionDuration(0)
      .hexPolygonColor(() => `rgba(${periwinkle}, 0.34)`)
      .arcStartLat(acc((a: Arc) => a.from.lat)).arcStartLng(acc((a: Arc) => a.from.lng))
      .arcEndLat(acc((a: Arc) => a.to.lat)).arcEndLng(acc((a: Arc) => a.to.lng))
      .arcAltitudeAutoScale(acc((a: Arc) => a.lift)).arcDashInitialGap(acc((a: Arc) => a.phase))
      .arcCurveResolution(48).arcCircularResolution(6)
      .arcLabel(acc((a: Arc) => `<div class="wm-tip">${esc(a.label)}</div>`))
      .onArcClick((d, e) => {
        const a = d as Arc
        if (a.node) pickRef.current({ type: 'node', node: a.node }, at(e))
        else if (a.link) pickRef.current({ type: 'link', link: a.link }, at(e))
      })
      .ringLat(acc((m: Marker) => m.at.lat)).ringLng(acc((m: Marker) => m.at.lng)).ringAltitude(0.003)
      .ringColor(() => (t: number) => `rgba(${TONE_RGB.danger}, ${Math.pow(1 - t, 1.5).toFixed(3)})`)
      .ringMaxRadius(6.5).ringPropagationSpeed(3.2).ringRepeatPeriod(1000)
      .pointLat(acc((s: Spot) => s.at.lat)).pointLng(acc((s: Spot) => s.at.lng)).pointAltitude(0.004)
      .pointRadius(acc((s: Spot) => s.r)).pointColor(acc((s: Spot) => `rgba(${TONE_RGB[s.tone]}, 0.7)`))
      .pointLabel(acc((s: Spot) => `<div class="wm-tip">${esc(s.label)}</div>`))
      .onPointClick((d, e) => pickRef.current({ type: 'node', node: (d as Spot).node }, at(e)))
      .htmlLat(acc((d: HtmlDatum) => (d.el === 'marker' ? d.m.at : d.c.at).lat))
      .htmlLng(acc((d: HtmlDatum) => (d.el === 'marker' ? d.m.at : d.c.at).lng))
      .htmlAltitude(acc((d: HtmlDatum) => (d.el === 'marker' ? 0.006 : 0.03)))
      .htmlElement(d => elements.current.get(d) ?? document.createElement('div'))
      .htmlElementVisibilityModifier((node, shown) => { node.classList.toggle('wm-far', !shown) })
      .onGlobeClick((_c, e) => pickRef.current(null, at(e)))
    const c = g.controls()
    c.minDistance = 128
    c.maxDistance = 560
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

  useEffect(() => {
    if (!globe.current || !size.width || !size.height) return
    // in the story the caption card covers the bottom of the stage: lift the globe above it
    globe.current.width(size.width).height(size.height).globeOffset([0, story ? -Math.round(size.height * 0.13) : 0])
  }, [size.width, size.height, ready, story])

  // ---- data on the globe: what is revealed, what the story focuses on ---------------------------
  useEffect(() => {
    const g = globe.current
    if (!g || !ready) return
    if (!scene) { g.arcsData([]).ringsData([]).pointsData([]).htmlElementsData([]); return }
    const lit = new Set(focus ?? [])
    const on = (a: Arc) => !lit.size || (a.node ? lit.has(a.node.id) : a.ids.every(id => lit.has(id)))
    const arcs = scene.arcs.filter(a => visible(a.step) && (!reduced || a.layer === 'base'))
    g.arcColor(acc((a: Arc) => {
      const c = a.blocked ? TONE_RGB.danger : TONE_RGB[a.tone]
      const k = on(a)
      if (a.blocked) return `rgba(${c}, ${k ? 0.95 : 0.3})`
      if (a.layer === 'base') return `rgba(${c}, ${reduced ? (k ? 0.9 : 0.22) : k ? 0.45 : 0.08})`
      return `rgba(${c}, ${k ? 1 : 0.16})`
    }))
      .arcStroke(acc((a: Arc) => (a.layer === 'flow' ? a.stroke : a.stroke * 0.62) * (lit.size && on(a) ? 1.5 : 1)))
      .arcDashLength(acc((a: Arc) => (a.blocked ? 0.022 : a.layer === 'flow' ? 0.16 : 1)))
      .arcDashGap(acc((a: Arc) => (a.blocked ? 0.022 : a.layer === 'flow' ? 0.42 : 0)))
      .arcDashAnimateTime(acc((a: Arc) => (reduced || a.layer === 'base' ? 0 : 2600)))
      .arcsTransitionDuration(reduced ? 0 : 900)
      .arcsData(arcs)
    g.ringsData(reduced ? [] : scene.markers.filter(m => m.ring && visible(m.step)))
    g.pointsTransitionDuration(0).pointsData(scene.spots.filter(s => visible(s.step)))

    const html: HtmlDatum[] = []
    shown.current = []
    shownChips.current = []
    for (const m of scene.markers) {
      if (!visible(m.step)) continue
      let el = elements.current.get(m)
      if (!el) { el = markerEl(m, (mk, e) => pickRef.current({ type: 'node', node: mk.node }, at(e))); elements.current.set(m, el) }
      const hit = lit.size > 0 && m.ids.some(id => lit.has(id))
      el.classList.toggle('dim', lit.size > 0 && !hit)
      el.classList.toggle('label-on', hit || (m.important && !lit.size) || (m.important && m.ring))
      shown.current.push({ m, el })
      // a datum object per marker, kept stable so globe.gl reuses its element
      html.push(datum(m, () => ({ el: 'marker', m })))
    }
    const hops = !story && template === 'why_late' && scene.chips.length <= 12
    for (const c of scene.chips) {
      if (!visible(c.step) || !(hops || lit.has(c.node.id))) continue
      if (!elements.current.get(c)) elements.current.set(c, chipEl(c, (ch, e) => pickRef.current({ type: 'node', node: ch.node }, at(e))))
      html.push(datum(c, () => ({ el: 'chip', c })))
      shownChips.current.push({ c, el: elements.current.get(c)! })
    }
    g.htmlTransitionDuration(reduced ? 0 : 600).htmlElementsData(html)
  }, [scene, visible, focusKey, reduced, ready, story, template]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const viewFor = useCallback((s: Scene) => {
    const all: LL[] = [], centre: LL[] = []
    for (const [id, a] of s.anchors) {
      if (!visible(s.steps.get(id) ?? 0)) continue
      all.push(...a.all)
      centre.push(a.in, a.out)
    }
    // the story keeps the closed port in the picture: it weighs as much as everything else together
    const port = story ? s.markers.find(m => m.ring)?.at : undefined
    if (port) centre.push(...centre.map(() => port))
    return fitView(all, story ? 0.95 : 0.6, 2.1, centre)
  }, [visible, story])
  const fit = useCallback((ms: number) => {
    const g = globe.current
    const pov = g && scene ? viewFor(scene) : null
    if (g && pov) g.pointOfView(pov, reduced ? 0 : ms)
  }, [scene, viewFor, reduced])

  // labels that would overlap a more important one hide (hover still shows them)
  const shown = useRef<{ m: Marker; el: HTMLElement }[]>([])
  const shownChips = useRef<{ c: HopChip; el: HTMLElement }[]>([])
  useEffect(() => {
    const g = globe.current
    if (!g || !scene) return
    const tick = () => {
      const boxes: number[][] = []
      const hit = (b: number[]) => boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])
      for (const { m, el } of shown.current) {
        if (!el.isConnected || el.classList.contains('wm-far')) continue
        const p = g.getScreenCoords(m.at.lat, m.at.lng, 0.006)
        if (!p) continue
        const r = m.size / 2
        if (el.classList.contains('label-on')) {
          const lab = el.lastElementChild as HTMLElement
          const w = lab.offsetWidth, h = lab.offsetHeight
          const right = [p.x + r + 5, p.y - h / 2, p.x + r + 9 + w, p.y + h / 2]
          const left = [p.x - r - 9 - w, p.y - h / 2, p.x - r - 5, p.y + h / 2]
          const box = !hit(right) ? right : !hit(left) ? left : null
          el.classList.toggle('crowded', !box)
          el.classList.toggle('flip', box === left)
          if (box) boxes.push(box)
        }
        boxes.push([p.x - r, p.y - r, p.x + r, p.y + r])
      }
      // hop labels: the middle of the longest leg, or the first free spot further along the route
      const view = g.pointOfView()
      const W = g.width(), H = g.height()
      for (const { c, el } of shownChips.current) {
        if (!el.isConnected) continue
        const pill = el.firstElementChild as HTMLElement
        const w = pill.offsetWidth, h = pill.offsetHeight
        const p0 = g.getScreenCoords(c.at.lat, c.at.lng, 0.03)
        let placed = false
        // on the route first, then just above or below it
        for (const dy of [0, -(h + 6), h + 6]) {
          for (const q of c.cands) {
            if (arcDeg({ lat: view.lat, lng: view.lng }, q) > 72) continue
            const s = g.getScreenCoords(q.lat, q.lng, 0.03)
            const p = { x: s.x, y: s.y + dy }
            const box = [p.x - w / 2 - 3, p.y - h / 2 - 2, p.x + w / 2 + 3, p.y + h / 2 + 2]
            if (box[0] < 4 || box[2] > W - 4 || box[1] < 40 || box[3] > H - 44 || hit(box)) continue
            pill.style.transform = `translate(${Math.round(p.x - p0.x - w / 2)}px, ${Math.round(p.y - p0.y - h / 2)}px)`
            boxes.push(box)
            placed = true
            break
          }
          if (placed) break
        }
        el.classList.toggle('crowded', !placed)
      }
    }
    tick()
    const id = window.setInterval(tick, 180)
    return () => clearInterval(id)
  }, [scene, ready])

  // a new answer: fly to fit it; the first time, swing in and turn gently for a few seconds
  const fittedFor = useRef<string | null>(null)
  const firstShow = useRef(true)
  useEffect(() => {
    const g = globe.current
    if (!g || !ready || !scene || fittedFor.current === animKey) return
    fittedFor.current = animKey
    clearTimers()
    const pov = viewFor(scene)
    if (!pov) return
    const c = g.controls()
    if (firstShow.current && !reduced) {
      firstShow.current = false
      g.pointOfView({ lat: pov.lat + 6, lng: pov.lng - 38, altitude: pov.altitude + 1.1 }, 0)
      g.pointOfView(pov, 2200)
      if (!story) {
        later(() => {
          if (userMoved.current) return
          c.autoRotate = true
          c.autoRotateSpeed = 0.45
          const t0 = performance.now()
          const ease = window.setInterval(() => {
            const k = (performance.now() - t0) / 6000
            if (k >= 1 || userMoved.current) { c.autoRotate = false; clearInterval(ease) } else c.autoRotateSpeed = 0.45 * (1 - k) * (1 - k)
          }, 100)
          timers.current.push(ease)
        }, 2250)
      }
    } else {
      firstShow.current = false
      c.autoRotate = false
      g.pointOfView(pov, reduced ? 0 : 1400)
    }
  }, [scene, animKey, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  // the story: pull back as the red wave spreads; refit when the camera flight is over
  useEffect(() => {
    if (!story || !scene || focus?.length || fittedFor.current !== animKey) return
    fit(1100)
  }, [story, reveal, focusKey]) // eslint-disable-line react-hooks/exhaustive-deps

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
        const low = i === hops.length - 1 ? 0.62 : 0.8
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

  // ---- legend ----------------------------------------------------------------------------------
  const legend = useMemo(() => {
    if (!scene) return null
    const tones = new Set<Tone>()
    let ring = false, blocked = false, groups = false
    for (const m of scene.markers) { if (!visible(m.step)) continue; tones.add(m.tone); ring ||= m.ring; groups ||= m.node.kind === 'group' }
    for (const a of scene.arcs) { if (!visible(a.step)) continue; if (a.blocked) blocked = true; else tones.add(a.tone) }
    return { tones: (['danger', 'warning', 'good', 'neutral'] as Tone[]).filter(t => tones.has(t)), ring, blocked, groups }
  }, [scene, visible])
  const TONE_WORD: Record<Tone, string> = { danger: 'late or stuck', warning: 'delayed', good: 'on track', neutral: 'other', muted: 'context' }

  return (
    <div className="wm" ref={setBox}>
      <div className="wm-globe" ref={host} />
      {!scene && !failed && <div className="wm-status"><span className="spinner" /> Placing the answer on the map…</div>}
      {failed && <div className="stage-empty">This answer could not be placed on the map. The diagram view still shows it.</div>}
      {scene && legend && !story && (
        <div className="legend wm-legend" aria-label="Legend">
          {legend.ring && <span><i className="wm-key ring" />closed port</span>}
          {legend.tones.map(t => <span key={t}><i className={`wm-key line tone-${t}`} />{TONE_WORD[t]}</span>)}
          {legend.blocked && <span><i className="wm-key dashed" />closed way</span>}
          {legend.groups && <span><i className="wm-key group" />group of orders</span>}
          {scene.missing > 0 && <><span className="legend-sep" aria-hidden /><span>{scene.missing} not on the map</span></>}
        </div>
      )}
      {scene && !story && (
        <button className="btn btn-sm stage-recentre"
          onClick={e => { e.stopPropagation(); userMoved.current = true; if (globe.current) globe.current.controls().autoRotate = false; fit(1100) }}
          title="Fit the whole answer in view">Re-centre</button>
      )}
    </div>
  )
}

function markerEl(m: Marker, onClick: (m: Marker, e: MouseEvent) => void): HTMLElement {
  const el = document.createElement('div')
  el.className = `wm-mk tone-${m.tone}${m.ring ? ' ring' : ''}${m.node.kind === 'group' ? ' group' : ''}${m.count != null ? ' counted' : ''}`
  el.style.setProperty('--sz', `${Math.round(m.size)}px`)
  const dot = document.createElement('button')
  dot.type = 'button'
  dot.className = 'wm-dot'
  dot.setAttribute('aria-label', m.sub ? `${m.label}, ${m.sub}` : m.label)
  if (m.count != null) dot.textContent = compact(m.count)
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
  el.append(dot, label)
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
  if (c.lead) {
    const b = document.createElement('b')
    b.textContent = c.lead
    pill.append(b)
  }
  pill.append(document.createTextNode(c.text))
  pill.addEventListener('click', e => { e.stopPropagation(); onClick(c, e) })
  el.append(pill)
  return el
}
