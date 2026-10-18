import { useState, type ReactNode } from 'react'
import { errorText } from '../api/client'
import type { AgentName, Decision, EventInfo, MemoryInfluence, Recall, Playbook, Run } from '../api/types'
import { firstSentence, num, plain, recommendation, usd } from '../lib/format'
import { TERMS } from '../lib/glossary'
import { MemoryCard } from './MemoryCard'
import { Term } from './Term'

export type Phase = 'started' | 'done' | 'failed'
type StepKey = AgentName | 'approval'
type State = 'pending' | 'working' | 'done' | 'waiting' | 'failed'

/** The response, in the order it happens. `doing` is shown while that step is actually running. */
const STEPS: { key: StepKey; name: string; what: string; doing: string }[] = [
  { key: 'sentinel', name: 'Sentinel', what: 'Detects the disruption, recalls similar ones', doing: 'Detecting the disruption…' },
  { key: 'impact_analyst', name: 'Impact analyst', what: 'Traces the affected supply chain', doing: 'Tracing the supply chain…' },
  { key: 'rerouter', name: 'Rerouter', what: 'Finds routes around the closure', doing: 'Finding alternative routes…' },
  { key: 'finance', name: 'Finance', what: 'Weighs rescue cost against late fees', doing: 'Comparing rescue cost with penalties…' },
  { key: 'verifier', name: 'Verifier', what: 'Re-checks every number in the graph', doing: 'Re-running every query…' },
  { key: 'approval', name: 'Human approval', what: 'A person signs off any spend', doing: 'Waiting for a person' },
  { key: 'comms', name: 'Comms', what: 'Drafts customer messages', doing: 'Drafting messages…' },
]

interface Props {
  event: EventInfo | null
  run: Run | null
  phases: Partial<Record<AgentName, Phase>>
  running: boolean
  approving: boolean
  runError: string | null
  me: string
  onMe: (s: string) => void
  onAnalyze: () => void
  onDecide: (d: Decision, by: string, approve: boolean) => Promise<void>
  tech: boolean
  influence: MemoryInfluence | null
  memoryOnFile: { recall: Recall[]; playbooks: Playbook[] } | null
  onCompare: () => void
  onOpenMemory: () => void
  others: EventInfo[]
  onSwitchEvent: (id: string) => void
}

export function ResponsePanel(p: Props) {
  const r = p.run
  const plan = r?.decisions.find(d => d.kind === 'plan') ?? null
  const finished = !!r && r.status !== 'running'
  return (
    <aside className="panel" aria-label="What the agents recommend">
      <section className="section">
        <div className="section-head">
          <div className="section-title">What the agents recommend
            <span className="section-sub">Six agents work it through in turn; a person approves any spend</span></div>
          {r && <RunPill run={r} running={p.running} />}
        </div>
        {!r && (
          <div className="cta">
            <div className="requester">
              <label htmlFor="requester">Requested by</label>
              <input id="requester" value={p.me} onChange={e => p.onMe(e.target.value)} disabled={p.running} />
            </div>
            <button className="btn btn-primary btn-block" onClick={p.onAnalyze} disabled={p.running || !p.event || !p.me.trim()}>
              {p.running ? <><span className="spinner" /> Agents working…</> : 'Run the agents'}
            </button>
          </div>
        )}
        {r && !p.running && (
          <div className="run-meta">
            <span>Requested by <b>{r.requested_by}</b></span>
            <button className="btn btn-sm btn-ghost" onClick={p.onAnalyze} disabled={!p.event || !p.me.trim()}>Run again</button>
          </div>
        )}
        {p.runError && <div className="notice err" role="alert">{p.runError}</div>}
        <Timeline {...p} />
        {plan && finished && (
          <div className="rec-card">
            <div className="rec-head"><span className="label">Recommendation</span><PlanPill d={plan} /></div>
            <Recommendation plan={plan} />
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <div className="section-title">What we learned
            <span className="section-sub">Past experience the agents used, and whether it changed the decision</span></div>
        </div>
        <MemoryCard
          run={plan && finished ? r : null} influence={plan && finished ? p.influence : null} onFile={p.memoryOnFile} tech={p.tech}
          onCompare={p.onCompare} onOpenMemory={p.onOpenMemory} others={p.others} onSwitchEvent={p.onSwitchEvent}
        />
      </section>
    </aside>
  )
}

function RunPill({ run, running }: { run: Run; running: boolean }) {
  if (running || run.status === 'running') return <span className="pill info"><span className="spinner" /> Running</span>
  if (run.status === 'awaiting_approval') return <span className="pill warn">Needs approval</span>
  if (run.status === 'done') return <span className="pill good">Complete</span>
  if (run.status === 'failed') return <span className="pill bad">Failed</span>
  return null
}

function PlanPill({ d }: { d: Decision }) {
  if (d.status === 'approved') return <span className="pill good">Approved{d.approved_by ? ` by ${d.approved_by}` : ''}</span>
  if (d.status === 'rejected') return <span className="pill bad">Rejected</span>
  if (d.status === 'blocked') return <span className="pill bad">Blocked by the check</span>
  if (d.status === 'verified') return <span className="pill good">Verified</span>
  return <span className="pill">Proposed</span>
}

// ---- timeline ------------------------------------------------------------------------------

function stateOf(key: StepKey, p: Props): State {
  const r = p.run
  if (key === 'approval') {
    const plan = r?.decisions.find(d => d.kind === 'plan')
    if (!plan || !r) return 'pending'
    if (plan.status === 'approved') return 'done'
    if (plan.status === 'rejected' || plan.status === 'blocked') return 'failed'
    return r.status === 'awaiting_approval' && plan.status === 'verified' ? 'waiting' : 'pending'
  }
  if (p.phases[key] === 'failed') return 'failed'
  if (r?.decisions.some(d => d.agent === key)) return 'done'
  if (key === 'comms' && p.approving) return 'working'
  if (p.phases[key] === 'started') return 'working'
  return 'pending'
}

function Timeline(p: Props) {
  const r = p.run
  // one duration per agent step (Sentinel's two decisions share its step's time)
  const perStep = new Map<string, number>()
  r?.decisions.forEach(d => { if (d.agent !== 'comms' && d.ms != null) perStep.set(d.agent, d.ms) })
  const total = [...perStep.values()].reduce((a, b) => a + b, 0)
  return (
    <div className="timeline" aria-live="polite">
      {STEPS.map((s, i) => {
        const st = stateOf(s.key, p)
        const decs = r?.decisions.filter(d => d.agent === s.key) ?? []
        return <Step key={s.key} n={i + 1} step={s} state={st} decisions={decs} {...p} />
      })}
      {r && r.status !== 'running' && total > 0 && (
        <div className="hint" style={{ marginTop: 4 }}>{num(total)} ms in all, handing off through the graph.</div>
      )}
    </div>
  )
}

function Step({ n, step, state, decisions, ...p }: Props & { n: number; step: typeof STEPS[number]; state: State; decisions: Decision[] }) {
  const [open, setOpen] = useState(false)
  const main = decisions.find(d => d.kind !== 'recall') ?? decisions[0]
  const ms = main?.ms
  const mark = state === 'done' ? '✓' : state === 'failed' ? '!' : state === 'working' ? <span className="spinner" style={{ width: 10, height: 10 }} /> : n
  return (
    <div className={`tl-step ${state}`}>
      <span className="tl-mark" aria-hidden>{mark}</span>
      <div style={{ minWidth: 0 }}>
        <div className="tl-head">
          <span className="tl-name">{step.name}</span>
          {state === 'pending' && <span className="tl-what">{step.what}</span>}
          {state === 'working' && <span className="tl-what" style={{ color: 'var(--accent)' }}>{step.doing}</span>}
          {ms != null && state === 'done' && <span className="tl-ms">{num(ms)} ms</span>}
          {step.key !== 'approval' && decisions.length > 0 && (
            <button className={`tl-chev${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} details from ${step.name}`} title="Details">▾</button>
          )}
        </div>
        {step.key === 'approval'
          ? <Approval {...p} state={state} />
          : decisions.length > 0 && (
            <>
              <div className="tl-result"><Result agent={step.key as AgentName} decisions={decisions} /></div>
              {open && <Details decisions={decisions} tech={p.tech} />}
            </>
          )}
        {state === 'failed' && step.key !== 'approval' && <div className="notice err">This step failed; the run stopped here.</div>}
      </div>
    </div>
  )
}

/** One line per agent, straight from the numbers it wrote to the graph. */
function Result({ agent, decisions }: { agent: AgentName; decisions: Decision[] }) {
  const d = decisions.find(x => x.kind !== 'recall') ?? decisions[0]
  const n = d.numbers as Record<string, number>
  const recall = decisions.find(x => x.kind === 'recall')
  switch (agent) {
    case 'sentinel': {
      const similar = recall ? Number(recall.numbers.similar_runs ?? 0) : null
      return (
        <>
          <b>{num(n.direct_hits)}</b> shipments pass through inside the window{n.chokepoint_rank ? <> · chokepoint <b>#{n.chokepoint_rank}</b></> : null}
          {recall && (
            <div className="tl-tag">
              {similar ? `Remembered ${similar} similar past disruption${similar === 1 ? '' : 's'}` : 'Memory switched off for this run'}
            </div>
          )}
        </>
      )
    }
    case 'impact_analyst':
      return <><b>{num(n.promises_at_risk)}</b> orders · <b>{usd(n.penalty_usd)}</b> late fees · <b>{num(n.clusters)}</b> <Term tip={TERMS.groups}>{n.clusters === 1 ? 'group' : 'groups'}</Term></>
    case 'rerouter':
      return <><b>{num(n.options)}</b> {n.options === 1 ? 'route' : 'routes'} for {num(n.roots_with_options)} of {num(n.roots)} <Term tip={TERMS.root}>stuck shipments</Term>{n.roots_stuck ? <> · {num(n.roots_stuck)} inside the port</> : null}</>
    case 'finance': {
      const m = d.memory
      return (
        <>
          <b>{m ? recommendation(m.plan) : plain(firstSentence(d.summary))}</b>{n.cost_usd ? <> for {usd(n.cost_usd)}</> : null}
          {m?.changed && <div className="tl-tag">Past experience changed this plan</div>}
          {m && !m.changed && m.used && Object.keys(m.effects).length > 0 && <div className="tl-tag"><span>Priced with each move's <Term tip={TERMS.trackRecord}>track record</Term>; same plan as at face value</span></div>}
        </>
      )
    }
    case 'verifier':
      return <><b>{num(n.passed)} of {num(n.checks)}</b> checks passed{n.failed ? <>, <b style={{ color: 'var(--danger)' }}>{num(n.failed)} failed</b></> : null}</>
    case 'comms':
      return <>{plain(firstSentence(d.summary))}</>
    default:
      return <>{plain(firstSentence(d.summary))}</>
  }
}

function Details({ decisions, tech }: { decisions: Decision[]; tech: boolean }) {
  return (
    <div className="tl-detail">
      {decisions.map(d => (
        <div key={d.id} style={{ display: 'grid', gap: 6 }}>
          <div>{plain(d.summary)}</div>
          {d.kind === 'message' && d.explanation && <div className="message">{d.explanation}</div>}
          {d.kind !== 'message' && d.explanation && d.explanation !== d.summary && (
            <div style={{ color: 'var(--ink-3)' }}>{plain(d.explanation)}{(d as Decision & { explanation_source?: string }).explanation_source === 'gemini' && ' (worded by Gemini; every number comes from the graph)'}</div>
          )}
          {tech && (
            <>
              <div className="kv"><span>Decision <b>{d.id}</b></span><span>Evidence <b>{d.evidence.length}</b> nodes</span>{d.prev && <span>After <b>{d.prev}</b></span>}</div>
              <pre className="code">{JSON.stringify(d.numbers, null, 1)}</pre>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function Approval(p: Props & { state: State }) {
  const [by, setBy] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const plan = p.run?.decisions.find(d => d.kind === 'plan')
  if (!plan) return null
  if (p.state === 'done') return <div className="tl-result">Approved by <b>{plan.approved_by}</b></div>
  if (plan.status === 'rejected') return <div className="tl-result">Rejected{plan.approved_by ? <> by <b>{plan.approved_by}</b></> : null}; no money was spent.</div>
  if (plan.status === 'blocked') return <div className="tl-result">The Verifier blocked this plan; it cannot be approved.</div>
  if (p.state !== 'waiting') return null
  const act = async (approve: boolean) => {
    if (!by.trim()) { setMsg('Type your name first.'); return }
    setBusy(true); setMsg(null)
    try { await p.onDecide(plan, by.trim(), approve) } catch (e) { setMsg(errorText(e)) } finally { setBusy(false) }
  }
  const spends = Number(plan.numbers.cost_usd ?? 0) > 0
  return (
    <div className="approve">
      <p>{spends ? <>Spends <b>{usd(Number(plan.numbers.cost_usd))}</b>. </> : null}Needs sign-off from someone other than {p.run?.requested_by}.</p>
      <div className="row">
        <input className="input" placeholder="Your name" value={by} onChange={e => setBy(e.target.value)} aria-label="Approver name" />
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(true)}>{busy ? <span className="spinner" /> : null} Approve</button>
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act(false)}>Reject</button>
      </div>
      {msg && <div className="notice err" role="alert">{msg}</div>}
    </div>
  )
}

// ---- recommendation ------------------------------------------------------------------------

function Recommendation({ plan }: { plan: Decision }) {
  const n = plan.numbers as Record<string, number>
  const m = plan.memory
  const title = m ? recommendation(m.plan) : firstSentence(plain(plan.summary))
  const rows: [string, ReactNode, string?][] = n.roots_rescued
    ? [['Cost', usd(n.cost_usd)], ['Late fees avoided', usd(n.saved_usd), 'good'], ['Orders back on time', num(n.promises_saved), 'good']]
    : [['Cost', usd(0)], ['Late fees still due', usd(n.penalty_before)], ['Customers to inform', num(n.promises_before)]]
  return (
    <div className="rec">
      <div className="rec-title">{title}</div>
      <div className="figures">
        {rows.map(([k, v, tone]) => <div key={k}><small>{k}</small><b className={tone}>{v}</b></div>)}
      </div>
    </div>
  )
}
