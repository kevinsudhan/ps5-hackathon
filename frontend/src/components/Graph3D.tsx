import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-3d'
import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { AskGraph, AskLink, AskNode, NodeKind, Tone } from '../api/types'
import { TONE_COLOR } from '../lib/format'
import { layoutGraph } from '../lib/layout'
import { useSize } from '../lib/useSize'

export type Pick = { type: 'node'; node: AskNode } | { type: 'link'; link: AskLink }

type Extra = { dot: boolean; lift: number; footer: boolean; compact: boolean }   // lift: label offset above a cloud
type N = NodeObject<AskNode & Extra>
type L = LinkObject<AskNode, AskLink & { orig: AskLink; dot: boolean }>

interface Props {
  graph: AskGraph
  reveal?: number | null
  focus?: string[] | null
  flyKey?: number
  selectedId?: string | null
  onPick: (pick: Pick | null, at: { x: number; y: number }) => void
}

const BACKGROUND = '#f1f0ec'
const QUIET = '#d3d5da'
const SX = 0.7                                  // layout pixels -> world units; a little taller
const SY = 1.0                                  // than wide because the camera looks down a bit
const LINK_RGB: Record<Tone, string> = {
  danger: '208, 59, 59', warning: '232, 160, 28', good: '31, 157, 92', neutral: '107, 122, 144', muted: '150, 150, 150',
}
const BASE_R: Record<NodeKind, number> = {
  event: 7.5, port: 7.5, airport: 6.5, warehouse: 6.5, factory: 6.5, place: 5.5, shipment: 5, group: 6, order: 3.6,
}

const geoCache = new Map<string, THREE.BufferGeometry>()
function geometry(kind: NodeKind, r: number): THREE.BufferGeometry {
  const key = `${kind}:${r.toFixed(2)}`
  let g = geoCache.get(key)
  if (g) return g
  switch (kind) {
    case 'event': g = new THREE.OctahedronGeometry(r * 1.15, 0); break
    case 'airport': g = new THREE.ConeGeometry(r * 0.95, r * 1.7, 3); break
    case 'warehouse': g = new THREE.BoxGeometry(r * 1.55, r * 1.55, r * 1.55); break
    case 'factory': g = new THREE.CylinderGeometry(r * 0.85, r * 0.85, r * 1.5, 6); break
    case 'shipment': g = new THREE.CapsuleGeometry(r * 0.55, r * 1.1, 6, 16).rotateZ(Math.PI / 2); break
    case 'place': g = new THREE.TorusGeometry(r * 0.75, r * 0.28, 14, 36); break
    case 'group': g = new THREE.DodecahedronGeometry(r, 0); break
    default: g = new THREE.SphereGeometry(r, 24, 16)
  }
  geoCache.set(key, g)
  return g
}

function htmlLabel(text: string, className: string) {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return new CSS2DObject(el)
}
/** A link end is an id before the engine runs and the node object after. */
const endId = (v: unknown) => (typeof v === 'object' && v !== null ? String((v as { id: string }).id) : String(v))
const short = (s: string, n = 34) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** Even points on a sphere (Fibonacci), for a block of orders orbiting next to its shipment. */
function spherePoint(i: number, n: number) {
  const y = 1 - (2 * (i + 0.5)) / n
  const r = Math.sqrt(1 - y * y)
  const t = i * Math.PI * (3 - Math.sqrt(5))
  return { x: Math.cos(t) * r, y, z: Math.sin(t) * r }
}

interface Styled { mat: THREE.MeshStandardMaterial; obj: THREE.Object3D; label?: HTMLElement; dot: boolean }

export default function Graph3D({ graph, reveal = null, focus = null, flyKey = 0, selectedId = null, onPick }: Props) {
  const fgRef = useRef<ForceGraphMethods<N, L> | undefined>(undefined)
  const [wrapRef, size] = useSize<HTMLDivElement>()
  const wrapEl = useRef<HTMLDivElement | null>(null)
  const setWrap = useCallback((el: HTMLDivElement | null) => { wrapEl.current = el; wrapRef(el) }, [wrapRef])
  const extraRenderers = useMemo(() => [new CSS2DRenderer()], [])
  const [spin, setSpin] = useState(true)

  // ---- fixed positions from the shared layout (the 2D diagram, lifted into space) ------------
  const { data, floorY, radius, half } = useMemo(() => {
    const Lo = layoutGraph(graph)
    const cx = (Lo.bounds.x0 + Lo.bounds.x1) / 2, cy = (Lo.bounds.y0 + Lo.bounds.y1) / 2
    const cardAt = new Map(Lo.cards.map(c => [c.node.id, c]))
    const bundleAt = new Map(Lo.bundles.map(b => [b.id, b]))
    const dotAt = new Map(Lo.dots.map(d => [d.node.id, d]))
    const footerOf = new Map(Lo.bundles.filter(b => b.more).map(b => [b.more!.node.id, b]))
    // Orders orbit the one shipment they all depend on (no long fans); a block with several
    // parents (e.g. warehouse -> orders -> city) stays where the diagram puts it.
    const parentsOf = new Map<string, Set<string>>()
    graph.links.forEach(l => (parentsOf.get(l.target) ?? parentsOf.set(l.target, new Set()).get(l.target)!).add(l.source))
    const orbit = new Map<string, { x: number; y: number }>()
    Lo.bundles.forEach(b => {
      const ps = new Set(b.members.flatMap(m => [...(parentsOf.get(m) ?? [])]))
      const p = ps.size === 1 ? cardAt.get([...ps][0]) : undefined
      orbit.set(b.id, p ? { x: p.x, y: p.y } : { x: b.x, y: b.y })
    })
    const cloudR = (n: number) => 7 + Math.sqrt(n) * 2.5
    const liftOf = new Map<string, number>()      // shipment id -> radius of the cloud around it
    Lo.bundles.forEach(b => {
      const ps = new Set(b.members.flatMap(m => [...(parentsOf.get(m) ?? [])]))
      if (ps.size === 1 && cardAt.has([...ps][0])) liftOf.set([...ps][0], cloudR(b.members.length))
    })
    const memberIndex = new Map<string, number>()
    Lo.bundles.forEach(b => b.members.forEach((m, i) => memberIndex.set(m, i)))
    // Layout point -> world. The flow bends gently around the viewer at its left and right ends
    // (a panorama), which gives real depth without ever stacking things behind each other.
    const halfW = Math.max(1, ((Lo.bounds.x1 - Lo.bounds.x0) / 2) * SX)
    const bend = Lo.mode === 'layered' ? 0.5 : 0
    const place = (lx: number, ly: number) => {
      const X = (lx - cx) * SX, Y = -(ly - cy) * SY
      if (!bend) return { x: X, y: Y, z: 0 }
      const R = halfW / bend, th = X / R
      return { x: R * Math.sin(th), y: Y, z: -R * (1 - Math.cos(th)) }
    }
    const nodes = graph.nodes.map(n => {
      let p = { x: 0, y: 0, z: 0 }
      const c = cardAt.get(n.id), d = dotAt.get(n.id)
      if (c) {
        p = place(c.x, c.y)
        if (Lo.mode === 'radial') p.z = ((c.col % 2) * 2 - 1) * 16
      } else if (d) {
        const b = bundleAt.get(d.bundle)!
        const o = orbit.get(b.id)!, at = place(o.x, o.y)
        const s = spherePoint(memberIndex.get(n.id)!, b.members.length)
        const R = cloudR(b.members.length)
        p = { x: at.x + s.x * R, y: at.y + s.y * R, z: at.z + s.z * R }
      } else if (footerOf.has(n.id)) {
        // "+ N more orders" floats just right of its cloud of orders
        const b = footerOf.get(n.id)!
        const o = orbit.get(b.id)!, at = place(o.x, o.y)
        p = { x: at.x, y: at.y - cloudR(b.members.length) - 9, z: at.z }
      }
      const cloud = liftOf.get(n.id) ?? 0
      return { ...n, dot: !!d, footer: footerOf.has(n.id), compact: !!c?.compact, lift: cloud, ...p, fx: p.x, fy: p.y, fz: p.z }
    }) as N[]
    const dotIds = new Set(Lo.dots.map(d => d.node.id))
    const links = graph.links.map(l => ({ ...l, orig: l, dot: dotIds.has(l.source) || dotIds.has(l.target) })) as L[]
    const ys = nodes.map(n => n.y ?? 0)
    const rad = Math.max(60, ...nodes.map(n => Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0)))
    const xs = nodes.map(n => n.x ?? 0), zs = nodes.map(n => n.z ?? 0)
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
    const half = {
      w: (box.x1 - box.x0) / 2 + 50, h: (box.y1 - box.y0) / 2 + 34,
      cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2,
    }
    return { data: { nodes, links }, floorY: Math.min(...ys) - 40, radius: rad, half }
  }, [graph])
  const byId = useMemo(() => new Map(data.nodes.map(n => [n.id, n])), [data])
  const focusSet = useMemo(() => new Set(focus ?? []), [focus])
  const focusPairs = useMemo(() => {
    const s = new Set<string>()
    focus?.forEach((id, i) => { if (i) { s.add(`${focus[i - 1]}>${id}`); s.add(`${id}>${focus[i - 1]}`) } })
    return s
  }, [focus])

  // ---- nodes: shape by kind, colour by tone, styled in place (no rebuilds on story ticks) ----
  const styled = useRef(new Map<string, Styled>())
  const live = useRef({ reveal, focusSet, selectedId })
  live.current = { reveal, focusSet, selectedId }
  const quiet = (n: AskNode, rev: number | null) => rev != null && n.step != null && n.step > rev

  const styleNode = useCallback((id: string) => {
    const s = styled.current.get(id), n = byId.get(id)
    if (!s || !n) return
    const { reveal, focusSet, selectedId } = live.current
    s.mat.color.set(quiet(n, reveal) ? QUIET : TONE_COLOR[n.tone])
    const faded = focusSet.size > 0 && !focusSet.has(id)
    s.mat.opacity = faded ? 0.12 : n.kind === 'group' ? 0.8 : 1
    s.mat.emissive.set(id === selectedId || focusSet.has(id) ? '#2a2a2a' : '#000000')
    s.obj.scale.setScalar(id === selectedId ? 1.35 : focusSet.has(id) && s.dot ? 1.8 : 1)
    if (s.label) s.label.style.opacity = faded ? '0.15' : '1'
  }, [byId])

  const nodeThreeObject = useCallback((n: N): THREE.Object3D => {
    const r = n.dot ? 2.6 : n.footer ? 2.2 : BASE_R[n.kind] * (0.85 + 0.15 * Math.min(3, Math.max(0.5, n.size)))
    const mat = new THREE.MeshStandardMaterial({
      color: TONE_COLOR[n.tone], roughness: 0.5, metalness: 0.05, transparent: true,
      flatShading: ['event', 'airport', 'factory', 'group'].includes(n.kind),
    })
    const mesh = new THREE.Mesh(geometry(n.dot ? 'order' : n.kind, r), mat)
    const group = new THREE.Group()
    group.add(mesh)
    const s: Styled = { mat, obj: mesh, dot: n.dot }
    if (!n.dot && !n.compact) {
      const big = n.kind === 'event' || n.kind === 'port' || n.kind === 'airport'
      const cls = n.kind === 'group' ? 'g3-label small' : `g3-label${big ? ' big' : ''}${n.kind === 'event' ? ' above' : ''}`
      const l = htmlLabel(short(n.label, n.kind === 'shipment' ? 30 : 34), n.lift ? 'g3-label lifted' : cls)
      // above its cloud of orders (in world units, so it never covers the dots)
      if (n.lift) l.position.set(0, n.lift + 7, 0)
      group.add(l)
      s.label = l.element
    }
    styled.current.set(n.id, s)
    // when the library drops this node (new answer), its HTML label must go with it
    group.addEventListener('removed', () => {
      s.label?.remove()
      if (styled.current.get(n.id) === s) styled.current.delete(n.id)
    })
    queueMicrotask(() => styleNode(n.id))
    return group
  }, [styleNode])

  useEffect(() => { styled.current.forEach((_, id) => styleNode(id)) }, [reveal, focusSet, selectedId, styleNode])

  // ---- links: tubes between places and shipments, hairlines into the order clouds -----------
  const key = (l: L) => `${endId(l.source)}>${endId(l.target)}`
  const linkColor = useCallback((l: L) => {
    if (focusPairs.has(key(l))) return 'rgba(27, 27, 26, 0.95)'
    const target = byId.get(endId(l.target))
    const isQuiet = !!target && quiet(target, reveal)
    const a = (l.dot ? 0.16 : l.tone === 'muted' ? 0.4 : 0.75) * (focusSet.size ? 0.25 : 1)
    return isQuiet ? `rgba(200, 202, 207, ${a})` : `rgba(${LINK_RGB[l.tone]}, ${a})`
  }, [byId, focusPairs, focusSet, reveal])
  const linkWidth = useCallback((l: L) => (focusPairs.has(key(l)) ? 1.6 : l.dot ? 0 : 0.9), [focusPairs])

  // ---- scene: soft light, a floor for depth --------------------------------------------------
  const ready = size.width > 0
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !ready) return
    const scene = fg.scene()
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd9d4c8, 1.1)
    const floor = new THREE.GridHelper(radius * 3.2, 24, 0xd6d2c8, 0xe4e0d7)
    floor.position.y = floorY
    const m = floor.material as THREE.Material
    m.transparent = true
    m.opacity = 0.7
    scene.add(hemi, floor)
    return () => { scene.remove(hemi, floor); floor.geometry.dispose() }
  }, [ready, floorY, radius])

  // ---- camera: a three-quarter view of the whole answer; gentle orbit until touched ----------
  const fit = useCallback((ms = 700) => {
    const fg = fgRef.current
    if (!fg) return
    const t = Math.tan((25 * Math.PI) / 180), aspect = size.width / Math.max(1, size.height)
    const d = Math.max(half.h / t, half.w / (t * aspect)) * 1.12
    fg.cameraPosition({ x: half.cx + d * 0.18, y: half.cy + d * 0.26, z: half.cz + d * 0.95 }, { x: half.cx, y: half.cy, z: half.cz }, ms)
  }, [half, size.width, size.height])
  useEffect(() => {
    if (!ready || focus?.length) return
    const t = window.setTimeout(() => fit(0), 30)
    return () => clearTimeout(t)
  }, [ready, data, fit, focus])

  // A gentle sway (about ±25°) rather than a full spin: a flat diagram seen side-on is unreadable.
  useEffect(() => {
    type Controls = THREE.EventDispatcher<{ start: object }> & {
      autoRotate: boolean; autoRotateSpeed: number; getAzimuthalAngle: () => number
    }
    const controls = fgRef.current?.controls() as Controls | undefined
    if (!controls) return
    controls.autoRotate = spin && !focus?.length
    controls.autoRotateSpeed = 0.35
    let raf = 0
    const sway = () => {
      const az = controls.getAzimuthalAngle()
      // positive speed turns the azimuth down, negative turns it up
      if (az > 0.42) controls.autoRotateSpeed = Math.abs(controls.autoRotateSpeed)
      else if (az < -0.42) controls.autoRotateSpeed = -Math.abs(controls.autoRotateSpeed)
      raf = requestAnimationFrame(sway)
    }
    if (controls.autoRotate) raf = requestAnimationFrame(sway)
    const stop = () => setSpin(false)
    controls.addEventListener('start', stop)
    return () => { cancelAnimationFrame(raf); controls.removeEventListener('start', stop) }
  }, [spin, focus, ready])

  // ---- labels for focused orders inside a cloud (e.g. the story's persona) -----------------
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !ready || !focus?.length) return
    const g = new THREE.Group()
    focus.forEach(id => {
      const n = byId.get(id)
      if (!n || (!n.dot && !n.compact)) return
      const l = htmlLabel(n.label, 'g3-label focus')
      l.position.set(n.x ?? 0, n.y ?? 0, n.z ?? 0)
      g.add(l)
    })
    fg.scene().add(g)
    return () => {
      fg.scene().remove(g)
      g.children.forEach(o => (o as CSS2DObject).element.remove())
    }
  }, [focus, byId, ready])

  // ---- fly along `focus` --------------------------------------------------------------------
  const timers = useRef<number[]>([])
  useEffect(() => {
    timers.current.forEach(clearTimeout); timers.current = []
    const fg = fgRef.current
    if (!fg || !flyKey || !focus?.length) return
    const pts = focus.map(id => byId.get(id)).filter((n): n is N => !!n)
    if (!pts.length) return
    const v = (n: N) => new THREE.Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0)
    const STEP = 950
    pts.forEach((n, i) => timers.current.push(window.setTimeout(() => {
      const here = v(n)
      const next = pts[i + 1] ? v(pts[i + 1]) : null
      const prev = pts[i - 1] ? v(pts[i - 1]) : null
      const dir = (next ? next.clone().sub(here) : prev ? here.clone().sub(prev) : new THREE.Vector3(1, 0, 0)).normalize()
      const cam = here.clone().sub(dir.clone().multiplyScalar(70)).add(new THREE.Vector3(0, 38, 62))
      fg.cameraPosition({ x: cam.x, y: cam.y, z: cam.z }, { x: here.x, y: here.y, z: here.z }, STEP - 100)
    }, i * STEP)))
    timers.current.push(window.setTimeout(() => {
      const c = pts.reduce((a, n) => a.add(v(n)), new THREE.Vector3()).divideScalar(pts.length)
      const span = Math.max(80, ...pts.map(n => v(n).distanceTo(c)))
      fg.cameraPosition({ x: c.x + span * 0.3, y: c.y + span * 0.55, z: c.z + span * 1.9 }, { x: c.x, y: c.y, z: c.z }, 1200)
    }, pts.length * STEP + 300))
    return () => timers.current.forEach(clearTimeout)
  }, [flyKey, focus, byId])

  const at = (e: MouseEvent) => {
    const r = wrapEl.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  return (
    <div ref={setWrap} style={{ position: 'absolute', inset: 0 }}>
      {ready && (
        <ForceGraph3D<AskNode & Extra, AskLink & { orig: AskLink; dot: boolean }>
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor={BACKGROUND}
          showNavInfo={false}
          controlType="orbit"
          extraRenderers={extraRenderers}
          nodeId="id"
          nodeThreeObject={nodeThreeObject}
          nodeLabel={(n: N) => (n.dot || n.compact ? n.label : '')}
          linkColor={linkColor}
          linkOpacity={1}
          linkWidth={linkWidth}
          linkCurvature={(l: L) => (l.dot ? 0 : 0.12)}
          linkLabel={(l: L) => l.label ?? ''}
          linkHoverPrecision={4}
          linkDirectionalParticles={(l: L) => (focusPairs.has(key(l)) ? 2 : 0)}
          linkDirectionalParticleSpeed={0.008}
          linkDirectionalParticleWidth={2.2}
          linkDirectionalParticleColor={() => '#1b1b1a'}
          enableNodeDrag={false}
          warmupTicks={0}
          cooldownTicks={1}
          onNodeClick={(n: N, e: MouseEvent) => onPick({ type: 'node', node: graph.nodes.find(x => x.id === n.id) ?? n }, at(e))}
          onLinkClick={(l: L, e: MouseEvent) => onPick({ type: 'link', link: l.orig }, at(e))}
          onBackgroundClick={(e: MouseEvent) => onPick(null, at(e))}
        />
      )}
      <div className="view-tools">
        <button className={`btn btn-sm${spin ? '' : ' btn-quiet'}`} onClick={() => setSpin(s => !s)}>{spin ? 'Hold still' : 'Sway gently'}</button>
        <button className="btn btn-sm" onClick={() => fit()}>Re-centre</button>
      </div>
    </div>
  )
}
