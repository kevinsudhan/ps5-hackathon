import { useMemo, useState } from 'react'
import { getSweep, type Loaded } from '../api/client'
import type { Engine, Sweep, SweepPoint } from '../api/types'
import { ENGINE_COLOR, ENGINE_NAME, ms, num, GRAPH } from '../lib/format'
import { useLoad } from '../lib/useLoad'

// Sweeps take seconds to time; keep each one for the session.
const cache = new Map<string, Promise<Loaded<Sweep>>>()
function sweep(tenant: string, eventId: string) {
  const key = `${tenant}:${eventId}`
  if (!cache.has(key)) {
    const p = getSweep(tenant, eventId)
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return cache.get(key)!
}

interface Props { tenant: string; tenants: string[]; eventId: string | null }

export function Benchmark({ tenant, tenants, eventId }: Props) {
  const hasBench = tenants.includes('bench') && tenant !== 'bench'
  const [set, setSet] = useState<'company' | 'bench'>('company')
  const target = set === 'bench' && hasBench ? 'bench' : tenant
  const res = useLoad(() => (eventId ? sweep(target, eventId) : null), [target, eventId])
  const [depth, setDepth] = useState(8)
  const s = res.value?.data
  const point = s?.points.find(p => p.depth === depth) ?? null

  return (
    <>
      <div>
        <h2 className="h2">Benchmark</h2>
        <p className="sub">
          “Which orders are at risk?” asked to both databases, following the delay 2 to 8 steps along the supply chain.
          Each point is the median of {s?.runs_per_point ?? 3} runs, timed on the server.
        </p>
      </div>
      {hasBench && (
        <div className="engine-switch" style={{ justifySelf: 'start' }}>
          <button className={set === 'company' ? 'on' : ''} onClick={() => setSet('company')}><span style={{ textTransform: 'capitalize' }}>{tenant}</span> data</button>
          <button className={set === 'bench' ? 'on' : ''} onClick={() => setSet('bench')}>Big test set (100k orders)</button>
        </div>
      )}
      {res.loading && <div className="notice row"><span className="spinner" /> Timing both databases at every depth. This takes a few seconds…</div>}
      {res.error && <div className="notice err">{res.error}</div>}
      {s && (
        <>
          <Chart points={s.points} depth={depth} onDepth={setDepth} />
          {/* lined up with the chart's plot area (viewBox 480: 44 left, 84 right) */}
          <div style={{ padding: '0 17.5% 0 11.25%', marginTop: -6 }}>
            <input className="slider" type="range" min={2} max={8} step={1} value={depth}
              onChange={e => setDepth(Number(e.target.value))} aria-label="Steps followed along the supply chain" />
          </div>
          {point && (
            <>
              <div className="readout">
                {(['falkordb', 'postgres'] as Engine[]).map(e => (
                  <div key={e} className="card">
                    <div className="engine-head" style={{ fontSize: 13.5 }}><i className="dot" style={{ background: ENGINE_COLOR[e] }} />{ENGINE_NAME[e]}</div>
                    <div className="big">{ms(e === 'falkordb' ? point.falkordb_ms : point.postgres_ms)}</div>
                  </div>
                ))}
              </div>
              <div className="row">
                <span className={`same${point.same_answer ? '' : ' diff'}`}>{point.same_answer ? '✓ Same answer' : '✗ Answers differ'}</span>
                <span className="notice">{num(point.row_count)} orders found when following {depth} steps</span>
              </div>
              {res.value?.source === 'fixture' && <div className="notice">Sample numbers measured earlier; the live benchmark endpoint is not ready yet.</div>}
            </>
          )}
        </>
      )}
    </>
  )
}

function Chart({ points, depth, onDepth }: { points: SweepPoint[]; depth: number; onDepth: (d: number) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 480, H = 250, M = { l: 54, r: 84, t: 30, b: 36 }
  const iw = W - M.l - M.r, ih = H - M.t - M.b
  const { yMax, ticks } = useMemo(() => {
    const top = Math.max(1, ...points.flatMap(p => [p.falkordb_ms, p.postgres_ms]))
    const step = niceStep(top / 4)
    const yMax = Math.ceil((top * 1.08) / step) * step
    return { yMax, ticks: Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step) }
  }, [points])
  const x = (d: number) => M.l + ((d - 2) / 6) * iw
  const y = (v: number) => M.t + ih - (v / yMax) * ih
  const line = (k: 'falkordb_ms' | 'postgres_ms') => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.depth)},${y(p[k])}`).join(' ')
  const last = points[points.length - 1]
  let fy = y(last.falkordb_ms), py = y(last.postgres_ms)
  if (Math.abs(fy - py) < 16) { const mid = (fy + py) / 2; const up = fy <= py; fy = mid + (up ? -8 : 8); py = mid + (up ? 8 : -8) }
  const shown = hover ?? depth
  const sp = points.find(p => p.depth === shown)

  return (
    <div className="viz" onMouseLeave={() => setHover(null)}>
      <div className="row" style={{ gap: 16, fontSize: 13, color: 'var(--ink-2)', marginBottom: 4 }} aria-hidden>
        <span className="row" style={{ gap: 6 }}><i className="dot" style={{ background: ENGINE_COLOR.falkordb }} />FalkorDB</span>
        <span className="row" style={{ gap: 6 }}><i className="dot" style={{ background: ENGINE_COLOR.postgres }} />PostgreSQL</span>
        <span style={{ color: 'var(--ink-3)' }}>time per question, lower is faster</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label={`Query time by depth. ${points.map(p => `${p.depth} steps: FalkorDB ${p.falkordb_ms} ms, PostgreSQL ${p.postgres_ms} ms`).join('; ')}`}
        onMouseMove={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((e.clientX - r.left) / r.width) * W
          const d = Math.round(2 + ((px - M.l) / iw) * 6)
          setHover(Math.min(8, Math.max(2, d)))
        }}
        onClick={() => { if (hover != null) onDepth(hover) }}
      >
        {ticks.map(t => (
          <g key={t}>
            <line x1={M.l} x2={M.l + iw} y1={y(t)} y2={y(t)} stroke={GRAPH.line} strokeWidth={1} />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={GRAPH.ink3}>{t} ms</text>
          </g>
        ))}
        {points.map(p => (
          <text key={p.depth} x={x(p.depth)} y={M.t + ih + 18} textAnchor="middle" fontSize={11.5} fill={p.depth === depth ? GRAPH.ink : GRAPH.ink3} fontWeight={p.depth === depth ? 650 : 400}>{p.depth}</text>
        ))}
        <text x={M.l + iw / 2} y={H - 2} textAnchor="middle" fontSize={11.5} fill={GRAPH.ink2}>steps followed along the supply chain</text>
        <line x1={x(shown)} x2={x(shown)} y1={M.t - 6} y2={M.t + ih} stroke={GRAPH.ink} strokeOpacity={hover != null ? 0.25 : 0.45} strokeDasharray="3 3" />
        {(['postgres_ms', 'falkordb_ms'] as const).map(k => (
          <path key={k} d={line(k)} fill="none" stroke={ENGINE_COLOR[k === 'falkordb_ms' ? 'falkordb' : 'postgres']} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {points.map(p => (['postgres_ms', 'falkordb_ms'] as const).map(k => (
          <circle key={`${k}${p.depth}`} cx={x(p.depth)} cy={y(p[k])} r={p.depth === shown ? 5 : 4}
            fill={ENGINE_COLOR[k === 'falkordb_ms' ? 'falkordb' : 'postgres']} stroke={GRAPH.stage} strokeWidth={2} />
        )))}
        <text x={x(8) + 12} y={fy + 4} fontSize={12} fill={GRAPH.ink} fontWeight={600}>FalkorDB</text>
        <text x={x(8) + 12} y={py + 4} fontSize={12} fill={GRAPH.ink} fontWeight={600}>PostgreSQL</text>
      </svg>
      {hover != null && sp && (
        <div className="viz-tip" style={{ left: `${(x(shown) / W) * 100}%`, top: 34, transform: 'translateX(-50%)' }}>
          <b>{shown} steps</b> · {num(sp.row_count)} orders{sp.same_answer ? ' · same answer' : ' · answers differ'}<br />
          <span><i className="dot" style={{ background: ENGINE_COLOR.falkordb, marginRight: 6 }} />FalkorDB {ms(sp.falkordb_ms)}</span>
          <span style={{ marginLeft: 12 }}><i className="dot" style={{ background: ENGINE_COLOR.postgres, marginRight: 6 }} />PostgreSQL {ms(sp.postgres_ms)}</span>
        </div>
      )}
    </div>
  )
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}
