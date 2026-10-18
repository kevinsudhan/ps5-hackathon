import { useState } from 'react'
import type { EventInfo, InfluenceItem, MemoryInfluence, Playbook, Recall, Run } from '../api/types'
import { monthYear, pct, usd } from '../lib/format'

interface Props {
  run: Run | null                  // the finished run, if any
  influence: MemoryInfluence | null
  onFile: { recall: Recall[]; playbooks: Playbook[] } | null
  tech: boolean
  onCompare: () => void
  onOpenMemory: () => void
  others: EventInfo[]
  onSwitchEvent: (id: string) => void
}

/**
 * Did past experience change this decision? One line by default; expanded, the chain from the
 * past event to today's decision. Everything comes from GET /runs/{id}/memory-influence.
 */
export function MemoryCard({ run, influence, onFile, tech, onCompare, onOpenMemory, others, onSwitchEvent }: Props) {
  const [open, setOpen] = useState(false)

  if (!run) {
    const past = onFile?.recall.length ?? 0
    const habits = onFile?.playbooks.length ?? 0
    return (
      <div className="mem">
        <div className="mem-head" style={{ cursor: 'default' }}>
          <MemIcon />
          <div>
            <div className="mem-headline">
              {onFile ? `${past} similar past disruption${past === 1 ? '' : 's'} and ${habits} learned habit${habits === 1 ? '' : 's'} on file` : 'Reading memory…'}
            </div>
            <div className="mem-sub">The agents check these during the run, and show here whether they changed the decision.</div>
          </div>
          <span />
        </div>
        <div className="mem-foot"><button className="btn btn-sm btn-quiet" onClick={onOpenMemory}>View memory</button></div>
      </div>
    )
  }
  if (run.memory === 'off') return <div className="hint">This run was made with memory switched off.</div>
  if (!influence) return <div className="notice row"><span className="spinner" /> Checking which memories were used…</div>

  const lead = influence.items.find(i => i.effect === 'changed') ?? null
  const canCompare = run.status === 'awaiting_approval' || run.status === 'done'
  const other = others[0]
  return (
    <>
      <div className={`mem${influence.changed ? ' changed' : ''}`}>
        <button className="mem-head" aria-expanded={open} onClick={e => {
          const card = e.currentTarget.parentElement
          setOpen(o => !o)
          // the chain opens below the fold of the panel: bring it into view
          if (!open) window.setTimeout(() => card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30)
        }}>
          <MemIcon />
          <div>
            <div className="mem-headline">{influence.headline}</div>
            <div className="mem-sub">{lead ? leadLine(lead) : checkedLine(influence)}</div>
          </div>
          <span className={`mem-chev${open ? ' open' : ''}`} aria-hidden>▶</span>
        </button>
        {open && (lead ? <Chain item={lead} /> : <Checked influence={influence} />)}
        {open && tech && (
          <div style={{ padding: '0 12px 12px', display: 'grid', gap: 6 }}>
            <div className="chain-k">How this was found (Cypher)</div>
            <pre className="code" style={{ maxHeight: 150 }}>{influence.query}</pre>
          </div>
        )}
        <div className="mem-foot">
          <button className="btn btn-sm" onClick={onCompare} disabled={!canCompare}>Compare with and without memory</button>
          <button className="btn btn-sm btn-quiet" onClick={onOpenMemory}>View full memory</button>
        </div>
      </div>
      {!influence.changed && other && (
        <div className="hint">
          Here the best option is the same either way.{' '}
          <button className="linkish" onClick={() => onSwitchEvent(other.id)}>Try {other.name}</button> to see whether memory changes the plan there.
        </div>
      )}
    </>
  )
}

function leadLine(item: InfluenceItem) {
  const past = item.past[0]
  return past
    ? `${past.event_name} (${monthYear(past.when)}): ${lowerFirst(item.name)} delivered ${pct(item.realization)} of its expected saving.`
    : item.learned
}

function checkedLine(inf: MemoryInfluence) {
  if (!inf.used) return 'Memory was not consulted.'
  if (!inf.items.length) return 'Nothing learned so far applies to the options on the table.'
  return inf.items.map(i => `${i.name}: ${pct(i.realization)} of the expected saving delivered before`).join(" · ")
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

function Chain({ item }: { item: InfluenceItem }) {
  const past = item.past[0]
  return (
    <div className="chain">
      {past && (
        <div className="chain-step past">
          <span className="chain-dot" />
          <div><div className="chain-k">Past event</div><div className="chain-v">{past.event_name} <small>· {monthYear(past.when)}</small></div></div>
        </div>
      )}
      {past && (
        <div className="chain-step bad">
          <span className="chain-dot" />
          <div><div className="chain-k">What happened</div><div className="chain-v">{past.outcome}</div></div>
        </div>
      )}
      <div className="chain-step past">
        <span className="chain-dot" />
        <div><div className="chain-k">What was learned</div><div className="chain-v">{item.learned}</div></div>
      </div>
      <div className="chain-step now">
        <span className="chain-dot" />
        <div><div className="chain-k">Now</div><div className="chain-v">{item.now}</div></div>
      </div>
      <div className="chain-step effect">
        <span className="chain-dot" />
        <div><div className="chain-k">Effect on this decision</div><div className="chain-v">{item.effect_text}</div></div>
      </div>
    </div>
  )
}

function Checked({ influence }: { influence: MemoryInfluence }) {
  return (
    <div className="chain">
      {influence.recall.slice(0, 2).map(r => (
        <div key={r.run_id} className="chain-step past">
          <span className="chain-dot" />
          <div>
            <div className="chain-k">Similar event recalled</div>
            <div className="chain-v">{r.event_name} <small>· {monthYear(r.when)} · {r.why_similar}</small></div>
          </div>
        </div>
      ))}
      {influence.items.map(i => (
        <div key={i.playbook.id} className="chain-step now">
          <span className="chain-dot" />
          <div><div className="chain-k">Habit applied</div><div className="chain-v">{i.learned}</div></div>
        </div>
      ))}
      <div className="chain-step effect">
        <span className="chain-dot" />
        <div>
          <div className="chain-k">Effect on this decision</div>
          <div className="chain-v">
            None: the same plan wins at face value
            {influence.plan && influence.plan.roots > 0 && <> (expected saving {usd(influence.plan.expected_saved_usd)} once past results are counted)</>}.
          </div>
        </div>
      </div>
    </div>
  )
}

function MemIcon() {
  return (
    <span className="mem-icon" aria-hidden>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.5 2.8v2.6h2.6" /><path d="M8 5v3.2l2 1.3" />
      </svg>
    </span>
  )
}
