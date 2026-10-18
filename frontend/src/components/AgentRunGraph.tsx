import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Decision, Run } from '../api/types'
import { ms as fmtMs, num, shortDate, usd } from '../lib/format'
import AgentIcon from './agentgraph/AgentIcon'
import type { RGLink, RGPast, RGPlaybook, RunGraph } from './agentgraph/types'
import {
  COLS, COL_NAME, COL_ROLE, TONE_CLASS, cardLines, dayRange, evidenceWords, kusd, month, numberRows, plural,
  type Col, type Pill,
} from './agentgraph/words'
import '../styles/agentgraph.css'

// How the agents worked: one run as the subgraph they wrote in FalkorDB (GET /runs/{id}/graph).
// Fixed layout, three bands: memory on top (past runs and playbooks the agents read, and what
// Comms wrote back), the handoff pipeline in the middle, the world they read and wrote below.
export interface AgentRunGraphProps {
  tenant: string
  run: Run
  reduced: boolean
}

// ---- layout (viewBox units; the stage is about 1000 px wide, so close to 1:1) -------------------
const W = 1000, H = 418
const CW = 129, CH = 120, CX0 = 12
const CGAP = (W - 2 * CX0 - COLS.length * CW) / (COLS.length - 1)
const colX = (i: number) => CX0 + i * (CW + CGAP)
const MEM = { y: 0, h: 104, chipY: 22, chipH: 76 }
const PIPE = { y: 128, h: 150, cardY: 150 }
const WORLD = { y: 304, h: 112, nodeY: 324, nodeH: 86 }
const CHIP_W = 150
const PAST_X = (i: number) => 12 + i * (CHIP_W + 6)
const PB_X = (i: number) => 490 + i * (CHIP_W + 6)
const WB = { x: 808, w: 180 }
const WORLD_NODES: { key: string; x: number; w: number }[] = [
  { key: 'event', x: 12, w: 162 }, { key: 'port', x: 180, w: 118 }, { key: 'shipments', x: 304, w: 120 },
  { key: 'groups', x: 430, w: 200 }, { key: 'routes', x: 636, w: 196 }, { key: 'promises', x: 838, w: 150 },
]
const SHORT_ROLE: Record<Col, string> = {
  sentinel: 'Spots it, recalls the past', impact_analyst: 'Finds the promises that break',
  rerouter: 'Finds routes around the port', finance: 'Prices the options, proposes a plan',
  verifier: 'Re-checks the plan in Cypher', approval: 'A second person signs off', comms: 'Tells customers, writes memory',
}

type Sel = { type: 'col'; col: Col } | { type: 'node'; key: string }
type State = 'pending' | 'working' | 'done' | 'failed'
interface Card { col: Col; i: number; state: State; pill: Pill; lines: string[]; ms: number | null; decisions: Decision[] }

const colOf = (agent: string): Col => (COLS as string[]).includes(agent) ? agent as Col : 'comms'

export default function AgentRunGraph({ tenant, run, reduced }: AgentRunGraphProps) {
  // ---- the run's subgraph, re-read whenever the run moves on -------------------------------------
  const key = `${run.id}|${run.status}|${run.decisions.map(d => `${d.id}:${d.status}:${d.approved_by ?? ''}`).join(',')}`
  const [fetched, setFetched] = useState<RunGraph | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const ac = new AbortController()
    fetch(`/api/${tenant}/runs/${encodeURIComponent(run.id)}/graph`, { signal: ac.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`the server answered ${r.status}`))))
      .then((g: RunGraph) => { setFetched(g); setErr(null) })
      .catch(e => { if (!ac.signal.aborted) setErr(String(e?.message ?? e)) })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, key])
  const data = fetched && fetched.run.id === run.id ? fetched : null

  const [sel, setSel] = useState<Sel | null>(null)
  const [hover, setHover] = useState<Sel | null>(null)
  const [showCypher, setShowCypher] = useState(false)
  useEffect(() => { setSel(null); setHover(null) }, [run.id])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { setSel(null); setShowCypher(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const memoryOn = (run.memory ?? 'on') !== 'off'
  const closedNames = data?.closed.map(c => c.name) ?? []
  const plan = run.decisions.find(d => d.kind === 'plan') ?? null

  // ---- one card per pipeline step ------------------------------------------------------------------
  const cards: Card[] = useMemo(() => {
    const by: Record<Col, Decision[]> = { sentinel: [], impact_analyst: [], rerouter: [], finance: [], verifier: [], approval: [], comms: [] }
    for (const d of run.decisions) by[colOf(d.agent)].push(d)
    const agentsDone = (['sentinel', 'impact_analyst', 'rerouter', 'finance', 'verifier'] as Col[])
    const firstOpen = agentsDone.find(c => by[c].length === 0) ?? null
    return COLS.map((col, i) => {
      const ds = by[col]
      const msv = ds.reduce<number | null>((m, d) => (d.ms != null ? Math.max(m ?? 0, d.ms) : m), null)
      let state: State = ds.length ? 'done' : 'pending'
      if (!ds.length && col === firstOpen) state = run.status === 'running' ? 'working' : run.status === 'failed' ? 'failed' : 'pending'
      let pill: Pill = state === 'done' ? { word: 'done', tone: 'neutral' } : state === 'working' ? { word: 'working', tone: 'live' }
        : state === 'failed' ? { word: 'failed', tone: 'danger' } : { word: 'waiting', tone: 'muted' }
      const lines = cardLines(col, ds.map(d => ({ ...d, memory_changed: d.memory?.changed ?? null })), { closed: closedNames, memoryOn })
      if (col === 'finance' && plan) {
        pill = { proposed: { word: 'proposed', tone: 'neutral' }, verified: { word: 'verified', tone: 'ok' }, approved: { word: 'approved', tone: 'ok' },
          blocked: { word: 'blocked', tone: 'danger' }, rejected: { word: 'rejected', tone: 'danger' } }[plan.status as string] as Pill ?? pill
      }
      if (col === 'verifier' && ds.length) {
        const failed = Number(ds[0].numbers.failed ?? 0)
        pill = failed ? { word: 'blocked', tone: 'danger' } : { word: 'verified', tone: 'ok' }
      }
      if (col === 'approval') {
        const asked = run.requested_by
        const by_ = plan?.approved_by
        if (!memoryOn) { state = 'done'; pill = { word: 'not needed', tone: 'muted' }; lines.push('Comparison run, no memory', 'Cannot be approved') }
        else if (plan?.status === 'approved') { state = 'done'; pill = { word: 'approved', tone: 'ok' }; lines.push(`Approved by ${by_ ?? 'a person'}`, `Asked by ${asked}`, '2 different people') }
        else if (plan?.status === 'rejected') { state = 'done'; pill = { word: 'rejected', tone: 'danger' }; lines.push(`Rejected by ${by_ ?? 'a person'}`, `Asked by ${asked}`, 'Nothing is spent') }
        else if (plan?.status === 'blocked') { state = 'done'; pill = { word: 'blocked', tone: 'danger' }; lines.push('Nothing to approve', 'Verifier blocked it') }
        else if (plan?.status === 'verified') { state = 'working'; pill = { word: 'needs approval', tone: 'warn' }; lines.push('Waiting for a second person', `Asked by ${asked}`, `${asked.split(' ')[0]} can’t approve`) }
        else lines.push('A second person signs off', `Asked by ${asked}`)
      }
      if (col === 'comms' && !ds.length) {
        pill = { word: plan?.status === 'rejected' || plan?.status === 'blocked' || !memoryOn ? 'not needed' : 'after approval', tone: 'muted' }
      }
      return { col, i, state, pill, lines, ms: msv, decisions: ds }
    })
  }, [run, plan, memoryOn, closedNames.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const decCol = useMemo(() => {
    const m = new Map<string, Col>()
    for (const d of run.decisions) m.set(d.id, colOf(d.agent))
    for (const s of data?.steps ?? []) m.set(s.id, colOf(s.agent))
    return m
  }, [run.decisions, data])

  // ---- memory chips ---------------------------------------------------------------------------------
  const past: RGPast[] = (data?.memory.episodic.length ? data.memory.episodic : run.recall.map(r => ({
    key: `past:${r.run_id}`, read_by: '', event_name: r.event_name, when: r.when, why_similar: r.why_similar, action: r.action,
    outcome: r.outcome, worked: !!r.worked, cost_usd: r.cost_usd, saved_usd: r.saved_usd,
    requested_by: r.requested_by ?? null, approved_by: r.approved_by ?? null,
  }))).slice(0, 3)
  const morePast = Math.max(0, (data?.memory.episodic.length || run.recall.length) - 3)
  const playbooks: RGPlaybook[] = (data?.memory.procedural.length ? data.memory.procedural : run.playbooks.map(p => ({
    key: `pb:${p.id}`, name: p.action, trigger: p.trigger, action: p.action, uses: p.uses, successes: p.successes,
    uses_before: p.uses, successes_before: p.successes, realization: null, effect: null, read_by: null, followed: false,
  }))).slice().sort((a, b) => Number(b.effect === 'changed') - Number(a.effect === 'changed') || b.uses_before - a.uses_before || a.key.localeCompare(b.key)).slice(0, 2)
  const outcome = data?.writeback?.outcome ?? null

  // ---- every drawn node and where its link ends ---------------------------------------------------
  const visibleLinks: RGLink[] = useMemo(() => (data?.links ?? []).filter(l => decCol.has(l.from) && run.decisions.some(d => d.id === l.from)),
    [data, decCol, run.decisions])

  const anchors = useMemo(() => {
    // Spread the ends of the links over each card's and node's edge, so they do not pile up.
    const nodeX = (k: string) => {
      const w = WORLD_NODES.find(n => n.key === k); if (w) return { x: w.x, w: w.w, band: 'world' as const }
      const pi = past.findIndex(p => p.key === k); if (pi >= 0) return { x: PAST_X(pi), w: CHIP_W, band: 'mem' as const }
      const bi = playbooks.findIndex(p => p.key === k); if (bi >= 0) return { x: PB_X(bi), w: CHIP_W, band: 'mem' as const }
      if (k === 'new-outcome') return { x: WB.x, w: WB.w, band: 'mem' as const }
      return null
    }
    const items = visibleLinks.map(l => ({ l, col: decCol.get(l.from)!, node: nodeX(l.to) })).filter(x => x.node)
    const out: { l: RGLink; col: Col; d: string; key: string }[] = []
    const seen = new Set<string>()
    for (const it of items) {
      const k = `${it.col}|${it.l.to}|${it.l.kind}`
      if (seen.has(k)) continue
      seen.add(k)
      const ci = COLS.indexOf(it.col), node = it.node!
      const sameCard = items.filter(x => x.col === it.col && x.node!.band === node.band)
        .map(x => x.node!.x + x.node!.w / 2).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
      const sameNode = items.filter(x => x.l.to === it.l.to).map(x => COLS.indexOf(x.col)).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
      const r1 = sameCard.length > 1 ? sameCard.indexOf(node.x + node.w / 2) / (sameCard.length - 1) : 0.5
      const r2 = sameNode.length > 1 ? sameNode.indexOf(ci) / (sameNode.length - 1) : 0.5
      const cx = colX(ci) + CW * (0.2 + 0.6 * r1)
      const nx = node.x + node.w * (0.18 + 0.64 * r2)
      let d: string
      if (node.band === 'world') {
        const cy = PIPE.cardY + CH, ny = WORLD.nodeY
        d = it.l.kind === 'wrote' ? `M${cx},${cy} C${cx},${cy + 30} ${nx},${ny - 30} ${nx},${ny}` : `M${nx},${ny} C${nx},${ny - 30} ${cx},${cy + 30} ${cx},${cy}`
      } else {
        const cy = PIPE.cardY, ny = MEM.chipY + MEM.chipH
        d = it.l.kind === 'wrote' ? `M${cx},${cy} C${cx},${cy - 30} ${nx},${ny + 30} ${nx},${ny}` : `M${nx},${ny} C${nx},${ny + 30} ${cx},${cy - 30} ${cx},${cy}`
      }
      out.push({ l: it.l, col: it.col, d, key: k })
    }
    return out
  }, [visibleLinks, decCol, past, playbooks])

  // ---- highlight what the hovered or selected thing touches ---------------------------------------
  const active = hover ?? sel
  const touches = (a: { col: Col; l: RGLink }) => !active ? true : active.type === 'col' ? a.col === active.col : a.l.to === active.key
  const litCols = new Set<Col>(), litNodes = new Set<string>()
  if (active) {
    for (const a of anchors) if (touches(a)) { litCols.add(a.col); litNodes.add(a.l.to) }
    if (active.type === 'col') litCols.add(active.col); else litNodes.add(active.key)
  }
  const dimCol = (c: Col) => !!active && !litCols.has(c)
  const dimNode = (k: string) => !!active && !litNodes.has(k)

  const pick = (s: Sel) => setSel(cur => (cur && JSON.stringify(cur) === JSON.stringify(s) ? null : s))
  const hov = (s: Sel | null) => setHover(s)
  const press = (s: Sel) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s) } }
  const isSel = (s: Sel) => !!sel && JSON.stringify(sel) === JSON.stringify(s)
  const interact = (s: Sel) => ({
    role: 'button', tabIndex: 0, onClick: () => pick(s), onKeyDown: press(s),
    onMouseEnter: () => hov(s), onMouseLeave: () => hov(null), onFocus: () => hov(s), onBlur: () => hov(null),
  })

  // ---- the handoff pulse ------------------------------------------------------------------------------
  const working = cards.find(c => c.state === 'working') ?? null
  const pulsePath = working && working.i > 0
    ? (() => { const x1 = colX(working.i - 1) + CW / 2, x2 = colX(working.i) + CW / 2, y = PIPE.cardY + CH
      return `M${x1},${y} Q${(x1 + x2) / 2},${y + 30} ${x2},${y}` })()
    : null

  const totalMs = cards.reduce((s, c) => s + (c.ms ?? 0), 0)
  const agentsDone = cards.filter(c => c.col !== 'approval' && c.state === 'done').length
  const statusWords: Record<string, string> = {
    running: 'working…', awaiting_approval: 'needs a second person to approve', done: plan?.status === 'rejected' ? 'plan rejected' : 'done',
    failed: 'a step failed', what_if: 'comparison run without memory',
  }

  return (
    <div className={`ag-root${reduced ? ' ag-reduced' : ''}`}>
      <div className="ag-head">
        <div className="ag-head-text">
          <b>How the agents handled it</b>
          <span> · asked by {run.requested_by} · {agentsDone} of 6 agents done{totalMs ? ` in ${fmtMs(totalMs)}` : ''} · {statusWords[run.status] ?? run.status}</span>
          {err && <span className="ag-err"> · could not read the run graph ({err})</span>}
        </div>
        <div className="ag-legend" aria-hidden>
          <span><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" className="ag-key-read" /></svg>reads</span>
          <span><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" className="ag-key-wrote" /></svg>writes</span>
          <span><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" className="ag-key-next" /></svg>hands off</span>
        </div>
        <button className={`ag-cypher-btn${showCypher ? ' on' : ''}`} aria-pressed={showCypher} onClick={() => setShowCypher(v => !v)}>How this is drawn</button>
      </div>

      <svg className="ag-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMin meet" role="img"
        aria-label="The agent run as a graph: memory, the handoff pipeline and the world graph they read and wrote"
        onClick={e => { if (e.target === e.currentTarget) setSel(null) }}>
        <defs>
          <marker id="ag-arrow-read" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="ag-arrow-read" />
          </marker>
          <marker id="ag-arrow-wrote" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="ag-arrow-wrote" />
          </marker>
          <marker id="ag-arrow-next" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="ag-arrow-next" />
          </marker>
          <radialGradient id="ag-pulse-glow"><stop offset="0" stopColor="var(--periwinkle)" stopOpacity="0.9" /><stop offset="1" stopColor="var(--periwinkle)" stopOpacity="0" /></radialGradient>
        </defs>

        {/* bands */}
        <rect x={0.5} y={MEM.y + 0.5} width={W - 1} height={MEM.h} rx={14} className="ag-band ag-band-mem" />
        <rect x={0.5} y={PIPE.y + 0.5} width={W - 1} height={PIPE.h} rx={14} className="ag-band" />
        <rect x={0.5} y={WORLD.y + 0.5} width={W - 1} height={WORLD.h - 1} rx={14} className="ag-band ag-band-world" />
        <text x={14} y={15} className="ag-band-label">Memory <tspan>· past runs recalled (episodic)</tspan></text>
        <text x={PB_X(0)} y={15} className="ag-band-label">Playbooks <tspan>· learned habits (procedural)</tspan></text>
        <text x={WB.x} y={15} className="ag-band-label">Written back <tspan>· by Comms</tspan></text>
        <text x={14} y={PIPE.y + 15} className="ag-band-label">Handoffs <tspan>· each agent reads the previous one’s decision from the graph</tspan></text>
        <text x={14} y={WORLD.y + 14} className="ag-band-label">World <tspan>· the supply-chain graph they read and wrote</tspan></text>

        {/* links */}
        <g className="ag-links">
          {anchors.map(a => {
            const on = active && touches(a)
            return (
              <path key={a.key} d={a.d} className={`ag-link ag-link-${a.l.kind}${on ? ' on' : ''}${active && !on ? ' dim' : ''}`}
                markerEnd={`url(#ag-arrow-${a.l.kind})`}>
                <title>{`${COL_NAME[a.col]} ${a.l.kind === 'read' ? 'read' : 'wrote'}: ${a.l.words.join('; ')}`}</title>
              </path>
            )
          })}
        </g>

        {/* handoff arrows between the cards (Decision -[:NEXT]-> Decision) */}
        {cards.slice(0, -1).map((c, i) => {
          const next = cards[i + 1]
          const on = c.state === 'done' && next.state !== 'pending'
          const x1 = colX(i) + CW + 2, x2 = colX(i + 1) - 3, y = PIPE.cardY + CH / 2
          return <line key={c.col} x1={x1} y1={y} x2={x2} y2={y} className={`ag-next${on ? ' on' : ''}`} markerEnd="url(#ag-arrow-next)" />
        })}

        {/* memory: past runs */}
        {!memoryOn && (
          <foreignObject x={12} y={MEM.chipY} width={776} height={MEM.chipH}>
            <div className="ag-chip ag-chip-ghost">Memory was switched off for this comparison run: nothing was recalled and every option was priced at face value.</div>
          </foreignObject>
        )}
        {memoryOn && past.map((p, i) => {
          const s: Sel = { type: 'node', key: p.key }
          return (
            <foreignObject key={`past-${i}`} x={PAST_X(i)} y={MEM.chipY} width={CHIP_W} height={MEM.chipH}>
              <div className={`ag-chip${isSel(s) ? ' sel' : ''}${dimNode(p.key) ? ' dim' : ''}${p.read_by ? '' : ' quiet'}`} {...interact(s)}
                aria-label={`Past run: ${p.event_name}`}>
                <div className="ag-chip-tag"><span>Past run · {month(p.when)}</span>{i === 2 && morePast > 0 && <span>+{morePast}</span>}</div>
                <div className="ag-chip-title">{p.event_name}</div>
                <div className={`ag-chip-foot ${p.worked ? 'ok' : 'bad'}`}>
                  <i aria-hidden>{p.worked ? '✓' : '✕'}</i>{p.worked ? `worked, saved ${kusd(p.saved_usd)}` : 'did not pay off'}
                </div>
              </div>
            </foreignObject>
          )
        })}
        {memoryOn && past.length === 0 && (
          <foreignObject x={12} y={MEM.chipY} width={454} height={MEM.chipH}>
            <div className="ag-chip ag-chip-ghost">No similar past disruption in memory yet.</div>
          </foreignObject>
        )}

        {/* memory: playbooks */}
        {memoryOn && playbooks.map((p, i) => {
          const s: Sel = { type: 'node', key: p.key }
          const u = p.uses_before, w = p.successes_before
          const record = u === 0 ? 'not tried yet' : u === 1 ? (w ? 'tried once, worked' : 'tried once, failed') : `worked ${w} of ${u}`
          const effect = p.effect === 'changed' ? { word: 'changed plan', cls: 'warn' } : p.effect === 'checked' ? { word: 'checked', cls: 'neutral' }
            : { word: 'not needed', cls: 'muted' }
          return (
            <foreignObject key={`pb-${i}`} x={PB_X(i)} y={MEM.chipY} width={CHIP_W} height={MEM.chipH}>
              <div className={`ag-chip ag-chip-pb${isSel(s) ? ' sel' : ''}${dimNode(p.key) ? ' dim' : ''}${p.read_by ? '' : ' quiet'}`} {...interact(s)}
                aria-label={`Playbook: ${p.name}`}>
                <div className="ag-chip-tag"><span>Playbook</span>{p.read_by && <span className={`ag-mini ${effect.cls}`}>{effect.word}</span>}</div>
                <div className="ag-chip-title">{p.name}</div>
                <div className="ag-chip-foot">{record}{p.followed && <span className="ag-plus">+1 use</span>}</div>
              </div>
            </foreignObject>
          )
        })}

        {/* memory: written back */}
        <foreignObject x={WB.x} y={MEM.chipY} width={WB.w} height={MEM.chipH}>
          {outcome ? (
            <div className={`ag-chip ag-chip-wb${isSel({ type: 'node', key: 'new-outcome' }) ? ' sel' : ''}${dimNode('new-outcome') ? ' dim' : ''}`}
              {...interact({ type: 'node', key: 'new-outcome' })} aria-label="What Comms wrote back to memory">
              <div className="ag-chip-tag"><span>New memory · this run</span></div>
              <div className="ag-chip-title">Expected: {plural(outcome.promises_saved, 'promise')} saved for {usd(outcome.cost_usd)}</div>
              <div className="ag-chip-foot">{num(data?.writeback?.messages ?? 0)} messages{data?.writeback?.playbooks.length ? ' · playbook +1 use' : ''}</div>
            </div>
          ) : (
            <div className="ag-chip ag-chip-ghost">{!memoryOn ? 'Comparison run: nothing is written back.'
              : plan?.status === 'rejected' ? 'Plan rejected: nothing was written back.'
              : plan?.status === 'blocked' ? 'Plan blocked: nothing to write back.'
              : 'After approval, Comms records the expected outcome and updates the playbook here.'}</div>
          )}
        </foreignObject>

        {/* the pipeline */}
        {cards.map(c => {
          const s: Sel = { type: 'col', col: c.col }
          const lines = c.lines.length ? c.lines : [SHORT_ROLE[c.col]]
          return (
            <foreignObject key={c.col} x={colX(c.i)} y={PIPE.cardY} width={CW} height={CH} className="ag-fo">
              <div className={`ag-card ag-${c.state}${c.col === 'approval' ? ' ag-human' : ''}${isSel(s) ? ' sel' : ''}${dimCol(c.col) ? ' dim' : ''}${c.pill.tone === 'warn' ? ' ag-wait' : ''}`}
                {...interact(s)} aria-label={`${COL_NAME[c.col]}: ${c.pill.word}`}>
                <div className="ag-card-head">
                  <AgentIcon col={c.col} />
                  <span className="ag-card-name">{COL_NAME[c.col]}</span>
                </div>
                <div className="ag-card-meta">
                  <span className={`ag-pill ${TONE_CLASS[c.pill.tone]}`}>{c.pill.tone === 'live' && <i className="ag-live-dot" />}{c.pill.word}</span>
                  {c.ms != null && <span className="ag-ms">{fmtMs(c.ms)}</span>}
                </div>
                <div className={`ag-card-l1${c.lines.length ? '' : ' muted'}`}>{lines[0]}</div>
                {lines.slice(1).map((l, i) => <div key={i} className="ag-card-l2">{l}</div>)}
              </div>
            </foreignObject>
          )
        })}

        {/* the pulse travelling along the handoff */}
        {working && !reduced && pulsePath && (
          <g className="ag-pulse" aria-hidden>
            <path d={pulsePath} className="ag-pulse-track" />
            <circle r={9} fill="url(#ag-pulse-glow)"><animateMotion dur="1.1s" repeatCount="indefinite" path={pulsePath} /></circle>
            <circle r={3.2} className="ag-pulse-dot"><animateMotion dur="1.1s" repeatCount="indefinite" path={pulsePath} /></circle>
          </g>
        )}

        {/* the world */}
        {WORLD_NODES.map(n => {
          const s: Sel = { type: 'node', key: n.key }
          const body = worldBody(n.key, data, run)
          return (
            <foreignObject key={n.key} x={n.x} y={WORLD.nodeY} width={n.w} height={WORLD.nodeH}>
              <div className={`ag-node${body.ghost ? ' ghost' : ''}${body.danger ? ' danger' : ''}${isSel(s) ? ' sel' : ''}${dimNode(n.key) ? ' dim' : ''}`}
                {...interact(s)} aria-label={body.tag}>
                <div className="ag-chip-tag"><span>{body.tag}</span></div>
                {body.content}
              </div>
            </foreignObject>
          )
        })}
      </svg>

      {sel && <Details sel={sel} cards={cards} data={data} run={run} past={past} playbooks={playbooks} onClose={() => setSel(null)} />}
      {showCypher && (
        <aside className="ag-cypher" role="dialog" aria-label="How this is drawn">
          <button className="close-x" onClick={() => setShowCypher(false)} aria-label="Close">×</button>
          <div className="ag-panel-kind">How this is drawn</div>
          <p>Every card, chip and box is a node the agents wrote into FalkorDB for this run, and every line is an edge
            between them. The view is one call, <code>GET /api/{tenant}/runs/…/graph</code>, which reads it back with these queries:</p>
          {(data?.queries ?? []).map(q => (
            <div key={q.title} className="ag-q"><div className="ag-q-title">{q.title}</div><pre>{q.cypher}</pre></div>
          ))}
          {!data && <p>Loading the queries…</p>}
        </aside>
      )}
    </div>
  )
}

// ---- world nodes ----------------------------------------------------------------------------------------
function worldBody(key: string, data: RunGraph | null, run: Run): { tag: string; content: ReactNode; ghost?: boolean; danger?: boolean } {
  const w = data?.world
  const has = (kind: string) => run.decisions.some(d => d.kind === kind)
  if (key === 'event') {
    if (!data) return { tag: 'Disruption', content: <div className="ag-node-title muted">Reading…</div>, ghost: true }
    const e = data.event
    return { tag: 'Disruption', content: <>
      <div className="ag-node-title">{e.name}</div>
      <div className="ag-node-sub">{dayRange(e.start, e.end)}{e.backlog_days ? ` · +${e.backlog_days}d backlog` : ''}</div>
    </> }
  }
  if (key === 'port') {
    if (!data) return { tag: 'Closed port', content: <div className="ag-node-title muted">Reading…</div>, ghost: true }
    const alert = run.decisions.find(d => d.kind === 'alert')
    return { tag: data.closed.length > 1 ? `${data.closed.length} closed ports` : 'Closed port', danger: true, content: <>
      <div className="ag-node-title">{data.closed.map(c => c.name).join(' and ')}</div>
      {alert && <div className="ag-node-sub">#{alert.numbers.chokepoint_rank} chokepoint</div>}
    </> }
  }
  if (key === 'shipments') {
    if (!has('alert') || !w) return { tag: 'Shipments', content: <div className="ag-node-sub">Not read yet</div>, ghost: true }
    return { tag: 'Shipments', content: <>
      <div className="ag-node-big">{num(w.shipments_hit)}</div>
      <div className="ag-node-sub">pass through the port while it is shut</div>
    </> }
  }
  if (key === 'groups') {
    if (!has('impact') || !w || !w.clusters.length) return { tag: 'Stranded groups', content: <div className="ag-node-sub">Written by the Impact analyst</div>, ghost: true }
    const max = Math.max(...w.clusters.map(c => c.promises_at_risk), 1)
    const rescued = w.clusters.filter(c => c.rescued).length
    const planned = has('plan')
    return { tag: 'Stranded groups', content: <>
      <div className="ag-bubbles" aria-hidden>
        {w.clusters.map(c => {
          const r = 4 + 9 * Math.sqrt(c.promises_at_risk / max)
          return <span key={c.n} className={`ag-bubble${planned && c.rescued ? ' rescued' : ''}`} style={{ width: r * 2, height: r * 2 }} title={`${c.promises_at_risk} promises`} />
        })}
      </div>
      <div className="ag-node-sub">{plural(w.clusters.length, 'group')}{planned ? ` · ${rescued} rescued` : `, ${num(w.promises_at_risk)} promises`}</div>
    </> }
  }
  if (key === 'routes') {
    if (!has('reroute') || !w) return { tag: 'Route options', content: <div className="ag-node-sub">Written by the Rerouter</div>, ghost: true }
    if (!w.routes.length) return { tag: 'Route options', content: <div className="ag-node-sub">No route beats waiting for the port to reopen</div> }
    const chosen = w.routes.filter(r => r.chosen)
    const planned = has('plan')
    return { tag: 'Route options', content: <>
      <div className="ag-routes" aria-hidden>
        {w.routes.map(r => <span key={r.key} className={`ag-route${r.air ? ' air' : ''}${planned && r.chosen ? ' chosen' : ''}${planned && !r.chosen ? ' off' : ''}`}>{r.air ? 'air' : 'sea'}</span>)}
      </div>
      <div className="ag-node-sub">{num(w.routes.length)} proposed{planned ? ` · ${num(chosen.length)} chosen` : ''}</div>
    </> }
  }
  // promises
  if (!has('impact') || !w) return { tag: 'Promises', content: <div className="ag-node-sub">Not read yet</div>, ghost: true }
  return { tag: 'Promises', danger: !has('plan'), content: <>
    <div className="ag-node-big">{num(w.promises_at_risk)} <small>at risk</small></div>
    {w.promises_saved != null && <div className="ag-node-sub ok">{num(w.promises_saved)} back on time</div>}
    {w.messages != null && <div className="ag-node-sub">{num(w.messages)} get an apology</div>}
  </> }
}

// ---- details panel ----------------------------------------------------------------------------------------
function Details({ sel, cards, data, run, past, playbooks, onClose }: {
  sel: Sel; cards: Card[]; data: RunGraph | null; run: Run; past: RGPast[]; playbooks: RGPlaybook[]; onClose: () => void
}) {
  let kind = '', title = '', body: ReactNode = null
  const linksOf = (ids: string[]) => (data?.links ?? []).filter(l => ids.includes(l.from))
  if (sel.type === 'col') {
    const c = cards.find(x => x.col === sel.col)!
    kind = c.col === 'approval' ? 'Human step' : 'Agent'
    title = COL_NAME[c.col]
    const plan = run.decisions.find(d => d.kind === 'plan')
    const steps = c.decisions
    const ls = linksOf(steps.map(d => d.id))
    const reads = ls.filter(l => l.kind === 'read').flatMap(l => l.words)
    const writes = ls.filter(l => l.kind === 'wrote').flatMap(l => l.words)
    const ev = (data?.steps ?? []).filter(s => steps.some(d => d.id === s.id))
      .reduce<Record<string, number>>((m, s) => { for (const [k, v] of Object.entries(s.evidence)) m[k] = (m[k] ?? 0) + v; return m }, {})
    body = <>
      <p className="ag-role">{COL_ROLE[c.col]}</p>
      <div className="ag-panel-row"><span className={`ag-pill ${TONE_CLASS[c.pill.tone]}`}>{c.pill.word}</span>{c.ms != null && <span className="ag-ms">took {fmtMs(c.ms)}</span>}</div>
      {c.col === 'approval' && <>
        <dl className="ag-dl">
          <dt>Asked for by</dt><dd>{run.requested_by}</dd>
          <dt>{plan?.status === 'rejected' ? 'Rejected by' : 'Approved by'}</dt><dd>{plan?.approved_by ?? '—'}</dd>
        </dl>
        <p>Nothing that spends money happens without an approval edge to a person, and nobody can approve their own request:
          the API refuses it. {plan?.approved_by ? `${plan.approved_by} is a different person from ${run.requested_by}, so the plan went ahead.` : ''}</p>
      </>}
      {steps.map(d => (
        <div key={d.id} className="ag-dec">
          <p>{d.summary}</p>
          {numberRows(d.numbers).length > 0 && <dl className="ag-dl">{numberRows(d.numbers).map(([k, v]) => <FragmentRow key={k} k={k} v={v} />)}</dl>}
        </div>
      ))}
      {!steps.length && c.col !== 'approval' && <p className="muted">{c.state === 'working' ? 'Working on it now…' : 'Has not run yet.'}</p>}
      {Object.keys(ev).length > 0 && <><div className="ag-panel-h">Evidence it points at</div><p>{evidenceWords(ev)}</p></>}
      {reads.length > 0 && <><div className="ag-panel-h">Read</div><ul>{reads.map((r, i) => <li key={i}>{r}</li>)}</ul></>}
      {writes.length > 0 && <><div className="ag-panel-h">Wrote</div><ul>{writes.map((r, i) => <li key={i}>{r}</li>)}</ul></>}
    </>
  } else if (sel.key.startsWith('past:')) {
    const p = past.find(x => x.key === sel.key)
    kind = 'Episodic memory · past run'
    title = p?.event_name ?? 'Past run'
    if (p) body = <>
      <dl className="ag-dl">
        <dt>When</dt><dd>{month(p.when)}</dd>
        {p.why_similar && <><dt>Why it is similar</dt><dd>{p.why_similar}</dd></>}
        <dt>What we did</dt><dd>{p.action}</dd>
        <dt>Spent</dt><dd>{usd(p.cost_usd)}</dd>
        <dt>Penalties avoided</dt><dd>{usd(p.saved_usd)}</dd>
        {p.requested_by && <><dt>Asked by</dt><dd>{p.requested_by}</dd></>}
        {p.approved_by && <><dt>Approved by</dt><dd>{p.approved_by}</dd></>}
      </dl>
      <p className={p.worked ? 'ok' : 'bad'}>{p.outcome}</p>
      <p className="muted">{p.read_by ? 'The Sentinel recalled this run (an EVIDENCE edge from its recall decision to the past run).' : 'In memory; the Sentinel has not recalled it yet.'}</p>
    </>
  } else if (sel.key.startsWith('pb:')) {
    const p = playbooks.find(x => x.key === sel.key)
    kind = 'Procedural memory · playbook'
    title = p?.name ?? 'Playbook'
    if (p) body = <>
      <dl className="ag-dl">
        <dt>When it applies</dt><dd>{p.trigger}</dd>
        <dt>What it does</dt><dd>{p.action}</dd>
        <dt>Track record before this run</dt><dd>worked {p.successes_before} of {plural(p.uses_before, 'time')}</dd>
        {p.realization != null && <><dt>Share of the expected saving it delivered</dt><dd>{Math.round(p.realization * 100)}%</dd></>}
      </dl>
      <p>{p.effect === 'changed' ? 'Finance priced today’s options with this track record and it changed the plan.'
        : p.effect === 'checked' ? 'Finance priced today’s options with this track record; the same option still won, so it did not change the plan.'
        : 'No option of this kind came up today, so Finance did not need it.'}</p>
      {p.followed && <p className="ok">This run’s approved plan followed it, so Comms added the run to its track record: now {plural(p.uses, 'use')}.</p>}
    </>
  } else if (sel.key === 'new-outcome') {
    const o = data?.writeback?.outcome
    kind = 'New memory · written by Comms'
    title = 'Expected outcome'
    if (o) body = <>
      <p>{o.summary}</p>
      <dl className="ag-dl">
        <dt>Cost</dt><dd>{usd(o.cost_usd)}</dd><dt>Penalties avoided</dt><dd>{usd(o.saved_usd)}</dd>
        <dt>Promises back on time</dt><dd>{num(o.promises_saved)}</dd>
        <dt>Apology messages drafted</dt><dd>{num(data?.writeback?.messages ?? 0)}</dd>
      </dl>
      <p className="muted">Recorded as a forecast (expected), so it never counts toward a playbook’s real track record until the real outcome is in.</p>
    </>
  } else {
    const w = data?.world
    const b = worldBody(sel.key, data, run)
    kind = 'World graph'
    title = b.tag
    const ls = (data?.links ?? []).filter(l => l.to === sel.key && run.decisions.some(d => d.id === l.from))
    const who = (l: RGLink) => COL_NAME[colOf(data?.steps.find(s => s.id === l.from)?.agent ?? 'comms')]
    body = <>
      {sel.key === 'event' && data && <p>{data.event.name}: shut {shortDate(data.event.start ?? undefined)} to {shortDate(data.event.end ?? undefined)}{data.event.backlog_days ? `, then ${data.event.backlog_days} days of backlog` : ''}.</p>}
      {sel.key === 'groups' && w && <dl className="ag-dl">{w.clusters.map(c => (
        <FragmentRow key={c.n} k={`Group ${c.n}${c.rescued ? ' (rescued)' : ''}`} v={`${num(c.promises_at_risk)} promises, ${usd(c.penalty_usd)}`} />
      ))}</dl>}
      {sel.key === 'routes' && w && <ul>{w.routes.map(r => (
        <li key={r.key} className={r.chosen ? 'ok' : ''}>{r.chosen ? 'Chosen: ' : ''}{r.what}, {r.air ? 'by air' : 'by sea'}{r.via.length ? ` via ${r.via.slice(0, 2).join(', ')}${r.via.length > 2 ? '…' : ''}` : ''}: {r.days} days, {usd(r.cost_usd)}</li>
      ))}</ul>}
      {sel.key === 'promises' && w && <dl className="ag-dl">
        <dt>Promises that break</dt><dd>{num(w.promises_at_risk)}</dd>
        <dt>Late penalties at stake</dt><dd>{usd(w.penalty_usd)}</dd>
        {w.promises_saved != null && <><dt>Back on time with the plan</dt><dd>{num(w.promises_saved)}</dd></>}
        {w.promises_after != null && <><dt>Still late</dt><dd>{num(w.promises_after)}</dd></>}
        {w.messages != null && <><dt>Apology messages</dt><dd>{num(w.messages)}</dd></>}
      </dl>}
      {sel.key === 'shipments' && w && <p>{num(w.shipments_hit)} shipments pass through the closed port while it is shut. {w.roots != null ? `${num(w.roots)} of the shipments the agents traced are the roots of the stranded groups.` : ''}</p>}
      {sel.key === 'port' && data && <p>{data.closed.map(c => c.name).join(' and ')} {data.closed.length > 1 ? 'are' : 'is'} closed by the disruption (an AFFECTS edge).</p>}
      {ls.length > 0 && <><div className="ag-panel-h">Which agents touched it</div>
        <ul>{ls.map((l, i) => <li key={i}><b>{who(l)}</b> {l.kind === 'read' ? 'read' : 'wrote'}: {l.words.join('; ')}</li>)}</ul></>}
    </>
  }
  return (
    <aside className="ag-panel" role="dialog" aria-label={`Details: ${title}`}>
      <button className="close-x" onClick={onClose} aria-label="Close">×</button>
      <div className="ag-panel-kind">{kind}</div>
      <div className="ag-panel-title">{title}</div>
      {body}
    </aside>
  )
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return <><dt>{k}</dt><dd>{v}</dd></>
}
