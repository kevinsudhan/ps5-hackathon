import { useEffect, useState } from 'react'
import { compareMemory, errorText } from '../api/client'
import type { MemoryComparison, MemorySide } from '../api/types'
import { monthYear, num, pct, usd } from '../lib/format'

/**
 * The same analysis run twice: with memory (the run on screen) and again with memory switched off
 * (POST /runs/{id}/without-memory, a real second run). Only the numbers the two runs wrote are shown.
 */
export function MemoryCompare({ tenant, runId, tech, onClose }: { tenant: string; runId: string; tech: boolean; onClose: () => void }) {
  const [res, setRes] = useState<MemoryComparison | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    compareMemory(tenant, runId).then(r => { if (live) setRes(r.data) }, e => { if (live) setErr(errorText(e)) })
    return () => { live = false }
  }, [tenant, runId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="With and without memory" onClick={e => e.stopPropagation()}>
        <button className="close-x" onClick={onClose} aria-label="Close">×</button>
        <div>
          <h2 className="h2">With and without memory</h2>
          <p className="sub">Same disruption. Same data. The only difference is whether the agents can use past experience.</p>
        </div>
        {!res && !err && <div className="notice row"><span className="spinner" /> Running the same analysis again with memory switched off…</div>}
        {err && <div className="notice err">{err}</div>}
        {res && <Body res={res} tech={tech} />}
      </div>
    </div>
  )
}

function Body({ res, tech }: { res: MemoryComparison; tech: boolean }) {
  const s = res.same_inputs
  const lesson = res.impact.lesson
  return (
    <>
      <div className="proof" aria-label="What was held the same">
        <Proof ok={s.event} text="Same disruption" />
        <Proof ok={s.impact} text="Same impact on orders" />
        <Proof ok={s.route_options} text="Same route options" />
        <Proof ok={s.penalty_before} text="Same cost model" />
        <Proof ok={s.memory} text="Memory on vs off" />
      </div>
      <div className="vs">
        <Side label="Without memory" side={res.without_memory} lesson={null} />
        <Side label="With memory" side={res.with_memory} lesson={lesson} withMemory />
      </div>
      <div className={`impact${res.same_plan ? '' : ' win'}`}>
        <div className="impact-head">{res.impact.headline}</div>
        {res.impact.detail && <div className="impact-text">{res.impact.detail}</div>}
        <div className="impact-text" style={{ color: 'var(--ink-3)', fontSize: 12 }}>{res.yardstick}</div>
      </div>
      {tech && (
        <div className="kv">
          <span>Run with memory <b>{res.with_memory.run_id}</b></span>
          <span>Run without memory <b>{res.without_memory.run_id}</b></span>
          <span>Linked in the graph as <b>(:Run)-[:COUNTERFACTUAL_OF]-&gt;(:Run)</b></span>
        </div>
      )}
    </>
  )
}

function Proof({ ok, text }: { ok: boolean; text: string }) {
  return <span><span className={ok ? 'ok' : ''} style={ok ? undefined : { color: 'var(--danger)' }}>{ok ? '✓' : '✗'}</span>{text}</span>
}

function Side({ label, side, lesson, withMemory }: {
  label: string; side: MemorySide; lesson: MemoryComparison['impact']['lesson']; withMemory?: boolean
}) {
  const net = side.expected_net_usd
  return (
    <div className={`vs-col${withMemory ? ' with' : ''}`}>
      <div className="vs-label">{label}{withMemory && <span className="pill info">{side.memories_used} past lesson{side.memories_used === 1 ? '' : 's'} applied</span>}</div>
      <div className="vs-rec">{side.recommendation}</div>
      <div className="vs-rows">
        <div className="vs-row"><span>Cost</span><b>{usd(side.cost_usd)}</b></div>
        <div className="vs-row"><span>Late fees avoided, on paper</span><b>{usd(side.saved_usd)}</b></div>
        <div className="vs-row"><span>Orders back on time, on paper</span><b>{num(side.promises_saved)}</b></div>
        <div className="vs-row">
          <span>Past experience used</span>
          <b>{side.memory_used
            ? lesson?.past ? `${lesson.past.event_name}, ${monthYear(lesson.past.when)}` : `${side.memories_used} track record${side.memories_used === 1 ? '' : 's'}`
            : 'None'}</b>
        </div>
        <div className="vs-row">
          <span>Expected result, given past outcomes{lesson && !withMemory ? ` (${pct(lesson.realization)} delivered last time)` : ''}</span>
          <b className={net < 0 ? 'bad' : net > 0 ? 'good' : ''}>{net < 0 ? `loses ${usd(-net)}` : usd(net)}</b>
        </div>
      </div>
    </div>
  )
}
