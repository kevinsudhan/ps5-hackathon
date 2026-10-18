import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-3d'
import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { AskLink, NodeKind } from '../api/types'
import { pathThrough, type Placed } from '../lib/answerLayout'
import { TONE_COLOR, TONE_RGB } from '../lib/format'
import { rgb, token } from '../lib/theme'
import type { DNode } from '../lib/simplify'
import { useSize } from '../lib/useSize'
import type { Pick } from './AnswerGraph'

interface Props {
  placed: Placed
  animKey: string
  reduced: boolean
  reveal?: number | null
  focus?: string[] | null
  flyKey?: number
  selectedId?: string | null
  onPick: (pick: Pick | null, at: { x: number; y: number }) => void
  onExpand: (parentId: string) => void
}

type Extra = { depth: number }
type N = NodeObject<DNode & Extra>
type L = LinkObject<DNode & Extra, AskLink & { orig: AskLink; depth: number; key: string }>

const SX = 0.62                    // layout pixels -> world units
const SY = 0.8
const STAGGER = 150
const BASE_R: Record<NodeKind, number> = {
  event: 8, port: 8, airport: 7, warehouse: 7, factory: 7, place: 6, shipment: 5.5, group: 6.5, order: 4.6,
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

const endId = (v: unknown) => (typeof v === 'object' && v !== null ? String((v as { id: string }).id) : String(v))

interface Styled { mat: THREE.MeshStandardMaterial; mesh: THREE.Mesh; label?: HTMLElement; shown: boolean }

export default function Graph3D({ placed: P, animKey, reduced, reveal = null, focus = null, flyKey = 0, selectedId = null, onPick, onExpand }: Props) {
  const fgRef = useRef<ForceGraphMethods<N, L> | undefined>(undefined)
  const [wrapRef, size] = useSize<HTMLDivElement>()
  const wrapEl = useRef<HTMLDivElement | null>(null)
  const setWrap = useCallback((el: HTMLDivElement | null) => { wrapEl.current = el; wrapRef(el) }, [wrapRef])
  const extraRenderers = useMemo(() => [new CSS2DRenderer()], [])
  const [spin, setSpin] = useState(!reduced)
  const [hover, setHover] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(reduced ? Infinity : 0)   // ms since this answer appeared
  const story = reveal != null

  // ---- the shared layout, lifted into space ---------------------------------------------------
  const { data, floorY, half } = useMemo(() => {
    const cx = (P.bounds.x0 + P.bounds.x1) / 2, cy = (P.bounds.y0 + P.bounds.y1) / 2
    const halfW = Math.max(1, ((P.bounds.x1 - P.bounds.x0) / 2) * SX)
    const bend = P.mode === 'flow' ? 0.45 : 0
    const place = (lx: number, ly: number) => {
      const X = (lx - cx) * SX, Y = -(ly - cy) * SY
      if (!bend) return { x: X, y: Y, z: 0 }
      const R = halfW / bend, th = X / R
      return { x: R * Math.sin(th), y: Y, z: -R * (1 - Math.cos(th)) }
    }
    const nodes = P.nodes.map((p, i) => {
      const at = place(p.x, p.y)
      if (P.mode === 'ring' && i) at.z = ((i % 2) * 2 - 1) * 18
      return { ...p.node, depth: p.depth, ...at, fx: at.x, fy: at.y, fz: at.z }
    }) as N[]
    const links = P.edges.map(e => ({ ...e.link, orig: e.link, depth: e.depth, key: e.key })) as L[]
    const xs = nodes.map(n => n.x ?? 0), ys = nodes.map(n => n.y ?? 0), zs = nodes.map(n => n.z ?? 0)
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
    return {
      data: { nodes, links }, floorY: box.y0 - 42,
      half: { w: (box.x1 - box.x0) / 2 + 70, h: (box.y1 - box.y0) / 2 + 46, cx: (box.x0 + box.x1) / 2,
              cy: (box.y0 + box.y1) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2 },
    }
  }, [P])
  const byId = useMemo(() => new Map(data.nodes.map(n => [n.id, n])), [data])

  // ---- reveal clock: nodes grow in cause -> effect, then the flow starts ----------------------
  const total = reduced ? 0 : P.maxDepth * STAGGER + 700
  useEffect(() => {
    if (reduced) { setElapsed(Infinity); return }
    setElapsed(0)
    const t0 = performance.now()
    const id = window.setInterval(() => {
      const e = performance.now() - t0
      setElapsed(e)
      if (e > total + 200) clearInterval(id)
    }, 90)
    return () => clearInterval(id)
  }, [animKey, total, reduced])
  const revealedAt = useCallback((depth: number) => elapsed >= depth * STAGGER, [elapsed])
  const flowing = !reduced && !story && elapsed > total

  const lit = useMemo(() => (hover ? pathThrough(P, hover) : null), [P, hover])
  const focusSet = useMemo(() => new Set(focus ?? []), [focus])
  const quiet = (n: DNode) => story && n.step != null && n.step > (reveal ?? 0)

  // ---- nodes ------------------------------------------------------------------------------------
  const styled = useRef(new Map<string, Styled>())
  const live = useRef({ lit, focusSet, selectedId, elapsed, hover })
  live.current = { lit, focusSet, selectedId, elapsed, hover }

  const styleNode = useCallback((id: string) => {
    const s = styled.current.get(id), n = byId.get(id)
    if (!s || !n) return
    const { lit, focusSet, selectedId, elapsed, hover } = live.current
    const dim = lit ? !lit.has(id) : focusSet.size > 0 && !focusSet.has(id)
    s.mat.color.set(quiet(n) ? token('--purple') : TONE_COLOR[n.tone])
    s.mat.opacity = dim ? 0.16 : n.kind === 'group' ? 0.85 : 1
    s.mat.emissive.set(id === selectedId || focusSet.has(id) ? token('--steel') : '#000000')
    const on = elapsed >= n.depth * STAGGER
    if (on && !s.shown) {
      s.shown = true
      const t0 = performance.now()
      const grow = () => {
        const k = Math.min(1, (performance.now() - t0) / 420)
        s.mesh.scale.setScalar(0.001 + (1 - Math.pow(1 - k, 3)) * (id === selectedId ? 1.3 : 1))
        if (k < 1) requestAnimationFrame(grow)
      }
      requestAnimationFrame(grow)
    }
    // a name only for the node under the pointer or the one clicked (and the story's path)
    if (s.label) s.label.style.opacity = on && (id === hover || id === selectedId || focusSet.has(id)) ? '1' : '0'
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId])

  const nodeThreeObject = useCallback((n: N): THREE.Object3D => {
    const r = BASE_R[n.kind] * (0.85 + 0.12 * Math.min(3, Math.max(0.6, n.size ?? 1)))
    const mat = new THREE.MeshStandardMaterial({
      color: TONE_COLOR[n.tone], roughness: 0.45, metalness: 0.08, transparent: true,
      flatShading: ['event', 'airport', 'factory', 'group'].includes(n.kind),
    })
    const mesh = new THREE.Mesh(geometry(n.kind, r), mat)
    mesh.scale.setScalar(0.001)
    const group = new THREE.Group()
    group.add(mesh)
    const el = document.createElement('div')
    el.className = `g3-label${n.kind === 'event' || n.kind === 'port' ? ' big' : ''}${n.blocked ? ' blocked' : ''}`
    const title = document.createElement('b')
    title.textContent = (n.rank != null ? `${n.rank}. ` : '') + n.label
    el.appendChild(title)
    if (n.metric) {
      const m = document.createElement('span')
      m.textContent = n.metric.label
      el.appendChild(m)
    }
    el.style.opacity = '0'
    const label = new CSS2DObject(el)
    label.position.set(0, -r - 4, 0)
    group.add(label)
    const s: Styled = { mat, mesh, label: el, shown: false }
    styled.current.set(n.id, s)
    group.addEventListener('removed', () => {
      el.remove()
      if (styled.current.get(n.id) === s) styled.current.delete(n.id)
    })
    queueMicrotask(() => styleNode(n.id))
    return group
  }, [styleNode])

  useEffect(() => { styled.current.forEach((_, id) => styleNode(id)) }, [lit, focusSet, selectedId, elapsed, hover, styleNode])
  useEffect(() => { styled.current.forEach(s => { s.shown = false }) }, [animKey])

  // ---- links: thickness by impact, coral for critical paths, flowing pulses after the reveal ---
  const linkColor = useCallback((l: L) => {
    const s = byId.get(endId(l.source)), t = byId.get(endId(l.target))
    if (!s || !revealedAt(s.depth)) return 'rgba(0,0,0,0)'
    const dim = lit ? !(lit.has(s.id) && t && lit.has(t.id)) : focusSet.size > 0 && !(focusSet.has(s.id) && t && focusSet.has(t.id))
    const a = dim ? 0.12 : l.blocked ? 0.55 : 0.8
    if (t && quiet(t)) return `rgba(${rgb(token('--purple'))}, ${a * 0.6})`
    if (l.tone === 'danger' || l.blocked) return `rgba(${TONE_RGB.danger}, ${a})`
    if (l.tone === 'good') return `rgba(${TONE_RGB.good}, ${a})`
    return `rgba(${rgb(token('--mauve'))}, ${a})`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, lit, focusSet, revealedAt])
  const linkWidth = useCallback((l: L) => 0.5 + 2.2 * Math.min(1, l.weight ?? 0.25), [])
  const particles = useCallback((l: L) => (flowing && !l.blocked ? ((l.weight ?? 0.3) > 0.5 ? 3 : 1) : 0), [flowing])
  const particleColor = useCallback((l: L) => (l.tone === 'danger' ? token('--danger-text') : token('--periwinkle')), [])

  // ---- scene ------------------------------------------------------------------------------------
  const ready = size.width > 0
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !ready) return
    const scene = fg.scene()
    const hemi = new THREE.HemisphereLight(0xffffff, new THREE.Color(token('--indigo')), 1.4)
    const floor = new THREE.GridHelper(Math.max(half.w, half.h) * 5, 26, new THREE.Color(token('--purple')), new THREE.Color(token('--indigo')))
    floor.position.y = floorY
    const m = floor.material as THREE.Material
    m.transparent = true
    m.opacity = 0.55
    scene.add(hemi, floor)
    return () => { scene.remove(hemi, floor); floor.geometry.dispose() }
  }, [ready, floorY, half])

  const fit = useCallback((ms = 700) => {
    const fg = fgRef.current
    if (!fg) return
    const t = Math.tan((25 * Math.PI) / 180), aspect = size.width / Math.max(1, size.height)
    const d = Math.max(half.h / t, half.w / (t * aspect)) * 1.1
    fg.cameraPosition({ x: half.cx + d * 0.16, y: half.cy + d * 0.24, z: half.cz + d * 0.96 }, { x: half.cx, y: half.cy, z: half.cz }, ms)
  }, [half, size.width, size.height])
  useEffect(() => {
    if (!ready || focus?.length) return
    const t = window.setTimeout(() => fit(0), 30)
    return () => clearTimeout(t)
  }, [ready, data, fit, focus])

  // a gentle sway (about ±25°) until someone touches the view
  useEffect(() => {
    type Controls = THREE.EventDispatcher<{ start: object }> & { autoRotate: boolean; autoRotateSpeed: number; getAzimuthalAngle: () => number }
    const controls = fgRef.current?.controls() as Controls | undefined
    if (!controls) return
    controls.autoRotate = spin && !focus?.length && !reduced
    controls.autoRotateSpeed = 0.32
    let raf = 0
    const sway = () => {
      const az = controls.getAzimuthalAngle()
      if (az > 0.42) controls.autoRotateSpeed = Math.abs(controls.autoRotateSpeed)
      else if (az < -0.42) controls.autoRotateSpeed = -Math.abs(controls.autoRotateSpeed)
      raf = requestAnimationFrame(sway)
    }
    if (controls.autoRotate) raf = requestAnimationFrame(sway)
    const stop = () => setSpin(false)
    controls.addEventListener('start', stop)
    return () => { cancelAnimationFrame(raf); controls.removeEventListener('start', stop) }
  }, [spin, focus, ready, reduced])

  // fly along `focus` (the story)
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
    return () => timers.current.forEach(clearTimeout)
  }, [flyKey, focus, byId])

  const at = (e: MouseEvent) => {
    const r = wrapEl.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  return (
    <div ref={setWrap} className="graph3d" style={{ position: 'absolute', inset: 0 }}>
      {ready && (
        <ForceGraph3D<DNode & Extra, AskLink & { orig: AskLink; depth: number; key: string }>
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          controlType="orbit"
          extraRenderers={extraRenderers}
          nodeId="id"
          nodeThreeObject={nodeThreeObject}
          nodeLabel={() => ''}
          linkColor={linkColor}
          linkOpacity={1}
          linkWidth={linkWidth}
          linkCurvature={0.12}
          linkLabel={(l: L) => l.label ?? ''}
          linkHoverPrecision={4}
          linkDirectionalParticles={particles}
          linkDirectionalParticleSpeed={0.006}
          linkDirectionalParticleWidth={2.6}
          linkDirectionalParticleColor={particleColor}
          enableNodeDrag={false}
          warmupTicks={0}
          cooldownTicks={1}
          onNodeHover={(n: N | null) => setHover(n ? n.id : null)}
          onNodeClick={(n: N, e: MouseEvent) => {
            const node = P.byId.get(n.id)?.node ?? n
            if (node.members?.length && node.parent) onExpand(node.parent)
            else onPick({ type: 'node', node }, at(e))
          }}
          onLinkClick={(l: L, e: MouseEvent) => onPick({ type: 'link', link: l.orig }, at(e))}
          onBackgroundClick={(e: MouseEvent) => onPick(null, at(e))}
        />
      )}
      <div className="view-tools">
        {!reduced && <button className={`btn btn-sm${spin ? '' : ' btn-quiet'}`} onClick={() => setSpin(s => !s)}>{spin ? 'Hold still' : 'Sway gently'}</button>}
        <button className="btn btn-sm" onClick={() => fit()}>Re-centre</button>
      </div>
    </div>
  )
}
