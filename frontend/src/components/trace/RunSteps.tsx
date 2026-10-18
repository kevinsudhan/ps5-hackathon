import { useEffect, useState } from 'react'
import type { Answer, Decision, Run } from '../../api/types'
import { ms as fmtMs, num, recommendation, usd, plain } from '../../lib/format'
import AgentIcon from '../agentgraph/AgentIcon'
import { COL_NAME, numberRows, type Col } from '../agentgraph/words'
import type { TraceHighlight } from '../AgentTrace'
import { Cypher, Facts, Step, Tag } from './Step'
import { firstSentence } from './words'

// GET /api/{tenant}/runs/{run_id}/trace (backend/promisegraph/runviz.py)
interface TraceQuery { title: string; feature: string | null; cypher: string }
interface RunTrace {
  run_id: string; depth: number
  agents: Record<string, { asked: string; queries: TraceQuery[] }>
  extra_ids: Record<string, string[]>
}

const AGENTS: Col[] = ['sentinel', 'impact_analyst', 'rerouter', 'finance', 'verifier']

interface Props {
  tenant: string; run: Run; answer: Answer | null; reduced: boolean
  highlightKey: string | null; onHighlight: (h: TraceHighlight | null) => void
}

export default function RunSteps({ tenant, run, answer, reduced, highlightKey, onHighlight }: Props) {
  const [trace, setTrace] = useState<RunTrace | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const n = run.decisions.length
  useEffect(() => {
    const ac = new AbortController()
    fetch(`/api/${tenant}/runs/${encodeURIComponent(run.id)}/trace`, { signal: ac.signal })
      .then(r => (r.ok ? r.json() : null)).then(t => { if (t) setTrace(t) }).catch(() => {})
    return () => ac.abort()
  }, [tenant, run.id, n])
  const tr = trace?.run_id === run.id ? trace : null

  const by = (c: Col) => run.decisions.filter(d => d.agent === c)
  const plan = run.decisions.find(d => d.kind === 'plan') ?? null
  const firstOpen = AGENTS.find(c => by(c).length === 0) ?? null
  const graphIds = new Set(answer?.graph.nodes.map(x => x.id) ?? [])

  // The ids a step touched: its evidence, plus the groups' roots and route shipments/hubs it wrote,
  // plus the diagram's own group node for each root shipment ("orders-<root>").
  const idsOf = (ds: Decision[]) => {
    const ids = new Set<string>()
    for (const d of ds) {
      d.evidence.forEach(x => ids.add(x))
      tr?.extra_ids[d.id]?.forEach(x => ids.add(x))
    }
    for (const x of [...ids]) if (graphIds.has(`orders-${x}`)) ids.add(`orders-${x}`)
    return [...ids]
  }
  const label = (c: Col, ds: Decision[]): string => {
    const nums = Object.assign({}, ...ds.map(d => d.numbers)) as Record<string, number>
    switch (c) {
      case 'sentinel': return `Sentinel: the closed port and the ${num(nums.direct_hits)} shipments passing through it`
      case 'impact_analyst': return `Impact analyst: the ${num(nums.roots)} shipments where the delay starts, and the promises they break`
      case 'rerouter': return `Rerouter: ${num(nums.options)} routes around the closed port`
      case 'finance': return nums.roots_rescued ? `Finance: the ${num(nums.roots_rescued)} shipments it proposes to rescue` : 'Finance: no rescue is worth its cost'
      case 'verifier': return `Verifier: the rescue routes it re-walked lane by lane`
      case 'comms': return `Comms: the customers still late after the rescue`
      default: return COL_NAME[c]
    }
  }
  const pick = (key: string, ids: string[], text: string) => {
    const wasOpen = open.has(key)
    setOpen(s => { const t = new Set(s); if (wasOpen && highlightKey === key) t.delete(key); else t.add(key); return t })
    if (highlightKey === key && wasOpen) onHighlight(null)
    else onHighlight({ key, ids, label: text })
  }

  const steps = AGENTS.map((c, i) => {
    const ds = by(c)
    const key = `run-${c}`
    const state = ds.length ? 'done' : c === firstOpen && run.status === 'running' ? 'live' : 'pending'
    const meta = tr?.agents[c]
    const features = [...new Set(meta?.queries.map(q => q.feature).filter((f): f is string => !!f && f !== 'handoff') ?? [])]
    const main = ds.find(d => d.kind !== 'recall') ?? ds[0]
    const recall = ds.find(d => d.kind === 'recall')
    const msv = ds.reduce<number | null>((m, d) => (d.ms != null ? Math.max(m ?? 0, d.ms) : m), null)
    return (
      <Step key={key} marker={<AgentIcon col={c} className="tr-icon" />} kicker={`${i + 1} · ${COL_NAME[c]}${msv != null ? ` · ${fmtMs(msv)}` : ''}`}
        sentence={main ? plain(firstSentence(main.summary)) : state === 'live' ? 'Asking the graph…' : 'Waiting for the previous agent’s decision.'}
        tags={features.map(f => <Tag key={f}>{f}</Tag>)}
        selected={highlightKey === key} open={open.has(key) && !!main} state={state} reduced={reduced}
        onPick={() => main && pick(key, idsOf(ds), label(c, ds))}>
        {main && <>
          {meta && <div className="tr-sec"><h4>Asked the graph</h4><p>{meta.asked}</p></div>}
          <div className="tr-sec"><h4>What came back</h4><Facts rows={ds.flatMap(d => numberRows(d.numbers)).slice(0, 8)} /></div>
          <div className="tr-sec"><h4>Concluded</h4><p>{plain(main.summary)}</p></div>
          {recall && <div className="tr-sec tr-mem"><h4>Memory · past runs</h4><p>{plain(recall.summary)}</p></div>}
          {c === 'finance' && main.memory && <FinanceMemory d={main} />}
          {c === 'verifier' && <p className="tr-note">{Number(main.numbers.failed) ? 'It blocked the plan: nothing goes to approval.' : 'Every check agreed, so the plan was cleared for a person to approve.'}</p>}
          {meta && <div className="tr-sec"><h4>The Cypher it ran</h4>{meta.queries.map(q => <Cypher key={q.title} title={q.title} text={q.cypher} />)}</div>}
          <p className="tr-note">It read its input from the previous agent’s decision in the graph and wrote its own decision node, with {num(ds.reduce((s, d) => s + d.evidence.length, 0))} evidence links.</p>
        </>}
      </Step>
    )
  })

  // The human approval, then Comms.
  const verified = plan?.status === 'verified'
  const approvedBy = plan?.approved_by ?? null
  const apState = plan?.status === 'approved' || plan?.status === 'rejected' || plan?.status === 'blocked' ? 'done' : verified ? 'live' : 'pending'
  const apSentence = plan?.status === 'approved' ? `${approvedBy} approved the plan that ${run.requested_by} asked for.`
    : plan?.status === 'rejected' ? `${approvedBy ?? 'A person'} rejected the plan; nothing is spent.`
    : plan?.status === 'blocked' ? 'Nothing to approve: the Verifier blocked the plan.'
    : verified ? `Waiting for someone other than ${run.requested_by} to approve.` : 'A second person must sign off before money is spent.'
  const apKey = 'run-approval'
  const comms = by('comms')
  const cMain = comms[0]
  const cMeta = tr?.agents.comms
  return (
    <ol className="tr-steps">
      {steps}
      <Step marker={<AgentIcon col="approval" className="tr-icon" />} kicker="6 · Human approval" sentence={apSentence}
        tags={plan?.status === 'approved' ? <Tag tone="ok">approved</Tag> : verified ? <Tag tone="warn">needs approval</Tag> : plan?.status === 'rejected' || plan?.status === 'blocked' ? <Tag tone="danger">{plan.status}</Tag> : undefined}
        selected={highlightKey === apKey} open={open.has(apKey)} state={apState === 'live' ? 'live' : apState} reduced={reduced}
        onPick={() => plan && pick(apKey, idsOf([plan]), `Approval: the plan ${approvedBy ? `${approvedBy} signed off` : 'waiting for sign-off'}`)}>
        {plan && <>
          <Facts rows={[['Asked for by', run.requested_by], [plan.status === 'rejected' ? 'Rejected by' : 'Approved by', approvedBy ?? '—'],
            ['Spend', usd(Number(plan.numbers.cost_usd ?? 0))]]} />
          <p className="tr-note">Nothing that spends money happens without an approval edge from the plan to a person, and nobody can approve their own request: the server refuses it.</p>
        </>}
      </Step>
      <Step marker={<AgentIcon col="comms" className="tr-icon" />} kicker={`7 · Comms${cMain?.ms != null ? ` · ${fmtMs(cMain.ms)}` : ''}`}
        sentence={cMain ? plain(firstSentence(cMain.summary)) : plan?.status === 'approved' ? 'Writing to customers…' : 'Runs once the plan is approved.'}
        tags={cMain ? <><Tag>variable-length FEEDS traversal</Tag><Tag>memory write</Tag></> : undefined}
        selected={highlightKey === 'run-comms'} open={open.has('run-comms') && !!cMain} state={cMain ? 'done' : 'pending'} last reduced={reduced}
        onPick={() => cMain && pick('run-comms', idsOf(comms), label('comms', comms))}>
        {cMain && <>
          {cMeta && <div className="tr-sec"><h4>Asked the graph</h4><p>{cMeta.asked}</p></div>}
          <div className="tr-sec"><h4>What came back</h4><Facts rows={numberRows(cMain.numbers)} /></div>
          <div className="tr-sec"><h4>Concluded</h4><p>{plain(cMain.summary)}</p></div>
          <div className="tr-sec tr-mem"><h4>Written back to memory</h4>
            <p>The expected outcome of this plan ({num(Number(plan?.numbers.promises_saved ?? 0))} promises saved for {usd(Number(plan?.numbers.cost_usd ?? 0))}), linked to the plan, and one more use of the playbook it followed. The next run’s Sentinel and Finance read these.</p></div>
          {cMeta && <div className="tr-sec"><h4>The Cypher it ran</h4>{cMeta.queries.map(q => <Cypher key={q.title} title={q.title} text={q.cypher} />)}</div>}
        </>}
      </Step>
    </ol>
  )
}

function FinanceMemory({ d }: { d: Decision }) {
  const m = d.memory!
  if (!m.used) return <div className="tr-sec tr-mem"><h4>Memory</h4><p>Switched off for this run: every option was priced at face value.</p></div>
  return (
    <div className="tr-sec tr-mem">
      <h4>Memory · learned habits</h4>
      {m.records.length === 0 && <p>Nothing learned so far applies to these options.</p>}
      <ul>{m.records.map(r => (
        <li key={r.id}><b>{r.action}</b>: delivered {Math.round(r.realization * 100)}% of the saving expected before
          ({r.successes} of {r.uses} worked). <Tag tone={m.effects[r.id] === 'changed' ? 'warn' : 'muted'}>{m.effects[r.id] === 'changed' ? 'changed the plan' : 'checked'}</Tag></li>
      ))}</ul>
      {m.changed
        ? <p>Without memory it would have proposed: <b>{recommendation(m.without_memory)}</b>. With it: <b>{recommendation(m.plan)}</b>.</p>
        : m.records.length > 0 && <p>The same option wins at face value, so memory confirmed the plan.</p>}
    </div>
  )
}
