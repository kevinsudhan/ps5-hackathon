import { useEffect } from 'react'
import { compare } from '../api/client'
import type { Engine, QueryInfo } from '../api/types'
import { ENGINE_COLOR, ENGINE_NAME, ms, num } from '../lib/format'
import { useLoad } from '../lib/useLoad'

interface Props { tenant: string; question: string; onClose: () => void }

export function CompareSheet({ tenant, question, onClose }: Props) {
  const res = useLoad(() => compare(tenant, question), [tenant, question])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const c = res.value?.data
  const max = c ? Math.max(c.falkordb.ms, c.postgres.ms) : 1

  return (
    <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Compare engines">
        <button className="close-x" onClick={onClose} aria-label="Close">×</button>
        <div>
          <h2 className="h2">Same question, both databases</h2>
          <p className="sub">“{question}”: asked to FalkorDB and to PostgreSQL back to back on the server. Both are fully indexed.</p>
        </div>
        {res.loading && <div className="row notice"><span className="spinner" /> Running it on both…</div>}
        {res.error && <div className="notice err">{res.error}</div>}
        {c && (
          <>
            <div className="row">
              <span className={`same${c.same_answer ? '' : ' diff'}`}>
                {c.same_answer ? '✓ Same answer from both' : '✗ The answers differ'}
              </span>
              <span className="notice">{num(c.row_count)} results each</span>
              {res.value?.source === 'fixture' && <span className="notice">· sample numbers (live endpoint not ready yet)</span>}
            </div>
            <div className="cols">
              <EngineCol q={c.falkordb} max={max} />
              <EngineCol q={c.postgres} max={max} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function EngineCol({ q, max }: { q: QueryInfo; max: number }) {
  const e: Engine = q.engine
  return (
    <div className="engine-col">
      <div className="engine-head"><i className="dot" style={{ background: ENGINE_COLOR[e] }} />{ENGINE_NAME[e]}</div>
      <div className="engine-ms">{ms(q.ms)}</div>
      <div className="bar"><div style={{ width: `${(q.ms / max) * 100}%`, background: ENGINE_COLOR[e] }} /></div>
      <div className="notice">Query: {num(q.chars)} characters, {num(q.lines)} lines</div>
      <pre className="code" style={{ maxHeight: 320 }}>{q.text}</pre>
    </div>
  )
}
