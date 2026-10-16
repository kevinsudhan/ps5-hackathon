import { useEffect, useState } from 'react'
import { errorText, getRecall, type Loaded } from '../api/client'
import type { Decision, Engine, EventInfo, Recall, Run } from '../api/types'
import { AGENT_LABEL, monthYear, plain, usd } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import { Benchmark } from './Benchmark'

export type Tab = 'agents' | 'memory' | 'benchmark'

interface Props {
  tab: Tab
  onTab: (t: Tab) => void
  onClose: () => void
  tenant: string
  tenants: string[]
  engine: Engine
  event: EventInfo | null
  run: Loaded<Run> | null
  running: boolean
  runError: string | null
  me: string
  onMe: (s: string) => void
  onRun: () => void
  onDecide: (d: Decision, by: string, approve: boolean) => Promise<void>
}

export function Drawer(p: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])
  return (
    <aside className="drawer" aria-label="Agents, memory and benchmark">
      <div className="drawer-head">
        {(['agents', 'memory', 'benchmark'] as Tab[]).map(t => (
          <button key={t} className={`btn btn-quiet btn-sm${p.tab === t ? ' on' : ''}`} onClick={() => p.onTab(t)}>
            {t === 'agents' ? 'Agents' : t === 'memory' ? 'Memory' : 'Benchmark'}
          </button>
        ))}
        <span className="spacer" />
        <button className="close-x" onClick={p.onClose} aria-label="Close">×</button>
      </div>
      <div className="drawer-body">
        {p.tab === 'agents' && <Agents {...p} />}
        {p.tab === 'memory' && <Memory {...p} />}
        {p.tab === 'benchmark' && <Benchmark tenant={p.tenant} tenants={p.tenants} eventId={p.event?.id ?? null} />}
      </div>
    </aside>
  )
}

function RunsOnFalkor({ engine }: { engine: Engine }) {
  return (
    <div className="runs-on">
      <i className="dot" style={{ background: 'var(--falkor)' }} />
      <span>
        Runs on FalkorDB (the graph is the agents' memory)
        {engine === 'postgres' && <>, even while questions are answered by PostgreSQL</>}.
      </span>
    </div>
  )
}

// ---- Agents ------------------------------------------------------------------------------

function Agents({ engine, event, run, running, runError, me, onMe, onRun, onDecide }: Props) {
  const r = run?.data
  return (
    <>
      <div>
        <h2 className="h2">Agents</h2>
        <p className="sub">Six agents work out what to do about {event ? <b>{event.name}</b> : 'the disruption'}, passing each step to the next. Nothing that spends money happens until a person approves it.</p>
      </div>
      <RunsOnFalkor engine={engine} />
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          Requested by
          <input className="input" value={me} onChange={e => onMe(e.target.value)} />
        </label>
        <button className="btn btn-dark" style={{ alignSelf: 'flex-end' }} onClick={onRun} disabled={running || !event}>
          {running ? <span className="spinner" /> : null} {r ? 'Run again' : 'Run the agents'}
        </button>
      </div>
      {runError && <div className="notice err">{runError}</div>}
      {r && (
        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="notice">Requested by <b style={{ color: 'var(--ink)' }}>{r.requested_by}</b></span>
            <span className="spacer" />
            <RunStatus status={r.status} />
          </div>
          <div className="steps-list">
            {r.decisions.map((d, i) => <Step key={d.id} d={d} n={i + 1} onDecide={onDecide} />)}
            {r.status === 'awaiting_approval' && !r.decisions.some(d => d.agent === 'comms') && (
              <div className="agent-step" style={{ opacity: 0.55 }}>
                <span className="agent-dot">·</span>
                <div><div className="agent-name">Comms <span className="agent-role">· writes to customers</span></div>
                  <div className="agent-text">Waits until a person approves the plan.</div></div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function RunStatus({ status }: { status: Run['status'] }) {
  if (status === 'awaiting_approval') return <span className="pill warn">Waiting for a person to approve</span>
  if (status === 'done') return <span className="pill good">Done</span>
  if (status === 'failed') return <span className="pill bad">Failed</span>
  return <span className="pill"><span className="spinner" /> Working</span>
}

function Step({ d, n, onDecide }: { d: Decision; n: number; onDecide: Props['onDecide'] }) {
  const [by, setBy] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const gate = d.requires_approval && d.status === 'verified'
  const who = AGENT_LABEL[d.agent]
  const src = (d as Decision & { explanation_source?: string }).explanation_source

  const act = async (approve: boolean) => {
    if (!by.trim()) { setMsg('Type your name first.'); return }
    setBusy(true); setMsg(null)
    try { await onDecide(d, by.trim(), approve) } catch (e) { setMsg(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <div className="agent-step" style={{ animationDelay: `${Math.min(n, 8) * 60}ms` }}>
      <span className="agent-dot">{n}</span>
      <div>
        <div className="row" style={{ gap: 8 }}>
          <span className="agent-name">{who?.name ?? d.agent} <span className="agent-role">· {d.kind === 'recall' ? 'remembers past disruptions' : who?.role}</span></span>
          <span className="spacer" />
          <StatusPill d={d} gate={gate} />
        </div>
        <div className="agent-text">{plain(d.summary)}</div>
        {d.kind === 'message' && <div className="message">{d.explanation}</div>}
        {d.kind !== 'message' && d.explanation && d.explanation !== d.summary && (
          <>
            <button className="linkish" style={{ marginTop: 4, fontSize: 13 }} onClick={() => setMore(m => !m)}>{more ? 'Less' : 'In plain words'}</button>
            {more && <div className="agent-text" style={{ marginTop: 4 }}>{plain(d.explanation)}{src === 'gemini' && <span style={{ color: 'var(--ink-3)' }}> (worded by Gemini; numbers from the graph)</span>}</div>}
          </>
        )}
        {gate && (
          <div className="gate">
            <div style={{ fontSize: 14, fontWeight: 600 }}>This plan spends money. Someone other than the requester must approve it.</div>
            <div className="row">
              <input className="input" style={{ flex: 1 }} placeholder="Your name" value={by} onChange={e => setBy(e.target.value)} aria-label="Approver name" />
              <button className="btn btn-good btn-sm" disabled={busy} onClick={() => act(true)}>{busy ? <span className="spinner" /> : null} Approve</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => act(false)}>Reject</button>
            </div>
            {msg && <div className="notice err" role="alert">{msg}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusPill({ d, gate }: { d: Decision; gate: boolean }) {
  if (d.status === 'approved') return <span className="pill good">Approved{d.approved_by ? ` by ${d.approved_by}` : ''}</span>
  if (d.status === 'rejected') return <span className="pill bad">Rejected</span>
  if (d.status === 'blocked') return <span className="pill bad">Blocked by the check</span>
  if (gate) return <span className="pill warn">Needs approval</span>
  if (d.status === 'verified') return <span className="pill good">Checked</span>
  if (d.status === 'proposed') return <span className="pill">Proposed</span>
  return null
}

// ---- Memory ------------------------------------------------------------------------------

function Memory({ tenant, engine, event, run }: Props) {
  const fetched = useLoad(() => (event ? getRecall(tenant, event.id) : null), [tenant, event?.id])
  const data = run?.data.recall.length ? { recall: run.data.recall, playbooks: run.data.playbooks } : fetched.value?.data
  return (
    <>
      <div>
        <h2 className="h2">Memory</h2>
        <p className="sub">What happened the last times something similar hit, and the habits the agents have learned from it.</p>
      </div>
      <RunsOnFalkor engine={engine} />
      {fetched.loading && !data && <div className="notice row"><span className="spinner" /> Remembering…</div>}
      {fetched.error && !data && <div className="notice err">{fetched.error}</div>}
      {data && data.recall.length === 0 && <div className="notice">Nothing similar has happened before.</div>}
      {data?.recall.map((m: Recall & { worked?: boolean }) => (
        <div key={m.run_id + m.event_id} className="card memory-item">
          <div className="row" style={{ gap: 8 }}>
            <span className="when">{monthYear(m.when)} · {m.why_similar}</span>
            <span className="spacer" />
            {m.worked === true && <span className="pill good">Worked</span>}
            {m.worked === false && <span className="pill bad">Lesson: did not pay off</span>}
          </div>
          <div className="title">{m.event_name}</div>
          <div className="agent-text">{plain(`${m.action}. ${m.outcome}.`)}</div>
          <div className="money">
            <div><small>Cost</small><b>{usd(m.cost_usd)}</b></div>
            <div><small>{m.worked === false ? 'Penalties it avoided' : 'Saved'}</small><b>{usd(m.saved_usd)}</b></div>
          </div>
        </div>
      ))}
      {data && data.playbooks.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, margin: '4px 0 8px' }}>Learned habits</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {data.playbooks.map(p => (
              <div key={p.id} className="card soft">
                <div className="agent-text" style={{ marginTop: 0 }}>When <b style={{ color: 'var(--ink)' }}>{p.trigger.charAt(0).toLowerCase() + p.trigger.slice(1)}</b>:</div>
                <div style={{ fontWeight: 600, marginTop: 2 }}>{p.action}</div>
                <div className="notice" style={{ marginTop: 4 }}>Worked {p.successes} of {p.uses} {p.uses === 1 ? 'time' : 'times'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
