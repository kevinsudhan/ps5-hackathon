import { useEffect } from 'react'
import { getRecall } from '../api/client'
import type { Engine, EventInfo, Recall, Run } from '../api/types'
import { monthYear, plain, usd } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import { Benchmark } from './Benchmark'

export type Tab = 'memory' | 'benchmark'

interface Props {
  tab: Tab
  onTab: (t: Tab) => void
  onClose: () => void
  tenant: string
  tenants: string[]
  engine: Engine
  event: EventInfo | null
  run: Run | null
}

export function Drawer(p: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])
  return (
    <aside className="drawer" aria-label="Memory and benchmark">
      <div className="drawer-head">
        {(['memory', 'benchmark'] as Tab[]).map(t => (
          <button key={t} className={`btn btn-quiet btn-sm${p.tab === t ? ' on' : ''}`} onClick={() => p.onTab(t)}>
            {t === 'memory' ? 'Memory' : 'Benchmark'}
          </button>
        ))}
        <span className="spacer" />
        <button className="close-x" onClick={p.onClose} aria-label="Close">×</button>
      </div>
      <div className="drawer-body">
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

// ---- Memory ------------------------------------------------------------------------------

function Memory({ tenant, engine, event, run }: Props) {
  const fetched = useLoad(() => (event ? getRecall(tenant, event.id) : null), [tenant, event?.id])
  const data = run?.recall.length ? { recall: run.recall, playbooks: run.playbooks } : fetched.value?.data
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
          {(m.requested_by || m.approved_by) && (
            <div className="who">Run {m.run_id}{m.requested_by ? ` · requested by ${m.requested_by}` : ''}{m.approved_by ? ` · approved by ${m.approved_by}` : ''}</div>
          )}
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
