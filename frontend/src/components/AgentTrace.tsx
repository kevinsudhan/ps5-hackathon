import { useEffect, useRef, useState } from 'react'
import type { Answer, Run } from '../api/types'
import { ms as fmtMs, num } from '../lib/format'
import { Cypher, Facts, Step, Tag } from './trace/Step'
import RunSteps from './trace/RunSteps'
import { hops, slotRows, walkWords } from './trace/words'
import '../styles/trace.css'

// "Step by step": how the answer, or the agents' run, was worked out in FalkorDB, one plain step at
// a time. Shown beside the diagram or globe when the user turns on the split view. Picking a step
// calls onHighlight with the graph ids that step touched, so the left side lights them up.
export interface TraceHighlight { key: string; ids: string[]; label?: string }
export interface AgentTraceProps {
  tenant: string
  eventId: string | null
  answer: Answer | null     // the current question's answer (always there when the split view is open)
  run: Run | null           // the latest agent run, if any (updates live while it streams)
  reduced: boolean
  highlightKey: string | null
  onHighlight: (h: TraceHighlight | null) => void
}

type Tab = 'answer' | 'run'

export default function AgentTrace({ tenant, answer, run, reduced, highlightKey, onHighlight }: AgentTraceProps) {
  const [tab, setTab] = useState<Tab>(run?.status === 'running' ? 'run' : 'answer')
  // A run that starts while the pane is open: follow it.
  const lastRun = useRef(run?.id ?? null)
  useEffect(() => {
    if (run && run.id !== lastRun.current) { lastRun.current = run.id; setTab('run'); onHighlight(null) }
    if (!run && tab === 'run') setTab('answer')
  }, [run?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const switchTab = (t: Tab) => { setTab(t); onHighlight(null) }

  return (
    <div className={`tr-root${reduced ? ' tr-reduced' : ''}`}>
      <div className="tr-top">
        <div className="tr-title">Step by step</div>
        <div className="tr-sub">How FalkorDB worked it out. Pick a step to light it up on the left.</div>
        {run && (
          <div className="tr-tabs" role="tablist" aria-label="What to trace">
            <button role="tab" aria-selected={tab === 'answer'} className={tab === 'answer' ? 'on' : ''} onClick={() => switchTab('answer')}>This answer</button>
            <button role="tab" aria-selected={tab === 'run'} className={tab === 'run' ? 'on' : ''} onClick={() => switchTab('run')}>
              The agents’ run{run.status === 'running' && <i className="tr-tab-live" aria-label="running" />}
            </button>
          </div>
        )}
      </div>
      {tab === 'answer' || !run
        ? (answer ? <AnswerSteps answer={answer} reduced={reduced} highlightKey={highlightKey} onHighlight={onHighlight} /> : <p className="tr-empty">Ask a question to see how it was answered.</p>)
        : <RunSteps tenant={tenant} run={run} answer={answer} reduced={reduced} highlightKey={highlightKey} onHighlight={onHighlight} />}
      {!run && tab === 'answer' && <p className="tr-foot">Press <b>Run the agents</b> on the right to watch six agents work the disruption through the same graph, step by step.</p>}
    </div>
  )
}

function AnswerSteps({ answer: a, reduced, highlightKey, onHighlight }: {
  answer: Answer; reduced: boolean; highlightKey: string | null; onHighlight: (h: TraceHighlight | null) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set(['ans-walk']))
  useEffect(() => { setOpen(new Set(['ans-walk'])) }, [a])
  const nodes = a.graph.nodes
  const ids = (f: (n: (typeof nodes)[number]) => boolean) => nodes.filter(f).map(n => n.id)
  const pick = (key: string, hl: string[], label: string) => {
    const wasOpen = open.has(key)
    setOpen(s => { const t = new Set(s); if (wasOpen && highlightKey === key) t.delete(key); else t.add(key); return t })
    if (highlightKey === key && wasOpen) onHighlight(null)
    else onHighlight(hl.length ? { key, ids: hl, label } : { key, ids: [], label })
  }
  const walk = walkWords(a)
  const chain = hops(a)
  const start = ids(n => n.step === 0 || n.kind === 'event')
  const ranked = ids(n => n.rank != null)
  const slots = slotRows(a)
  const by = a.understood_by === 'gemini'
    ? 'Gemini read your words and picked this question template and its slots. It never writes the query: the Cypher is fixed and checked.'
    : 'Matched by keywords to this question template. The Cypher is fixed and checked; nothing is generated.'
  return (
    <ol className="tr-steps">
      <Step marker={1} kicker="What you asked" sentence={a.read_as} tags={<Tag tone="muted">{a.title}</Tag>}
        selected={highlightKey === 'ans-asked'} open={open.has('ans-asked')} reduced={reduced}
        onPick={() => pick('ans-asked', start, `The question starts at: ${chain[0]?.text ?? a.read_as}`)}>
        <Facts rows={[['Question type', a.title], ...slots, ['Understood by', a.understood_by === 'gemini' ? 'Gemini (picks the template only)' : 'keyword match']]} />
        <p className="tr-note">{by}</p>
      </Step>
      <Step marker={2} kicker={`What FalkorDB walked · ${fmtMs(a.query.ms)}`} sentence={walk.text} tags={<Tag>{walk.feature}</Tag>}
        selected={highlightKey === 'ans-walk'} open={open.has('ans-walk')} reduced={reduced}
        onPick={() => pick('ans-walk', start, `FalkorDB starts here: ${chain[0]?.text ?? 'the disruption'}`)}>
        <Facts rows={[['Ran in', fmtMs(a.query.ms)], ['Query size', `${num(a.query.lines)} lines, ${num(a.query.chars)} characters`]]} />
        <Cypher title="Show the exact Cypher" text={a.query.text} meta={`${num(a.query.lines)} lines`} />
      </Step>
      <Step marker={3} kicker={`What came back · ${num(a.row_count)} ${a.row_count === 1 ? 'row' : 'rows'}`}
        sentence={chain.length > 1 ? chain.map(h => h.text).join(a.template === 'weak_points' ? ' · ' : ' → ') : `${num(a.row_count)} rows.`}
        selected={highlightKey === 'ans-back'} open={open.has('ans-back')} reduced={reduced}
        onPick={() => pick('ans-back', nodes.map(n => n.id), `Everything the query returned (${num(a.row_count)} rows)`)}>
        {chain.length > 0 && <>
          <p className="tr-note">Pick a link in the chain to light it up:</p>
          <ol className="tr-chain">
            {chain.map((h, i) => (
              <li key={h.key}>
                <button className={highlightKey === h.key ? 'on' : ''} onClick={() => onHighlight(highlightKey === h.key ? null : { key: h.key, ids: h.ids, label: a.template === 'weak_points' ? `#${i + 1}: ${h.text}` : `Link ${i + 1} of the chain: ${h.text}` })}>
                  <span className="tr-chain-n">{i + 1}</span>
                  <span><b>{h.text}</b><small>{h.detail}</small></span>
                </button>
              </li>
            ))}
          </ol>
        </>}
        {a.graph.truncated && <p className="tr-note">The diagram folds the long tail into groups; the list under the answer has every row.</p>}
      </Step>
      <Step marker={4} kicker="The answer" sentence={a.answer} last
        selected={highlightKey === 'ans-answer'} open={open.has('ans-answer')} reduced={reduced}
        onPick={() => pick('ans-answer', ranked.length ? ranked : nodes.map(n => n.id), ranked.length ? 'The answer: the ranked results' : 'The answer')}>
        <p className="tr-note">Every number in this sentence comes from the rows FalkorDB returned; nothing is estimated or written by an AI.</p>
      </Step>
    </ol>
  )
}
