import { useEffect, useState } from 'react'
import type { Answer } from '../api/types'
import { cellText, columnWord, ENGINE_COLOR, ENGINE_NAME, ms, num, showColumn } from '../lib/format'
import { HOW_FOUND } from '../lib/glossary'

/** The technical explanation under every answer: one tidy line, expandable. */
export function TechExplain({ a, onCompare, comparing }: { a: Answer; onCompare: () => void; comparing: boolean }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => { setOpen(false) }, [a.template, a.read_as])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const q = a.query
  const steps = HOW_FOUND[a.template] ?? []
  const params = Object.entries(q.params ?? {})
  const rows = a.rows.slice(0, 6)
  const cols = a.columns.map((c, i) => ({ c, i })).filter(x => showColumn(x.c))
  const copy = async () => {
    try { await navigator.clipboard.writeText(q.text); setCopied(true); window.setTimeout(() => setCopied(false), 1400) } catch { /* no clipboard */ }
  }
  return (
    <section className="tech" aria-label="How this answer was found">
      <div className="tech-line">
        <button className="tech-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <i className="dot" style={{ background: ENGINE_COLOR[q.engine] }} />
          <span>Answered by <b>{ENGINE_NAME[q.engine]}</b> in <b>{ms(q.ms)}</b></span>
          <span className="tech-sep">·</span>
          <span>query of <b>{num(q.chars)}</b> characters, <b>{num(q.lines)}</b> lines</span>
          <span className="tech-sep">·</span>
          <span className="linkish">How it was found</span>
          <span className={`chev${open ? ' open' : ''}`} aria-hidden>▾</span>
        </button>
        <button className="btn btn-sm" onClick={onCompare} disabled={comparing}>Compare engines</button>
      </div>
      {open && (
        <div className="tech-body" role="region" aria-label="How it was found">
          {steps.length > 0 && (
            <ol className="how-steps">
              {steps.map(([plain, tech], i) => <li key={i}><span>{plain}</span><small>{tech}</small></li>)}
            </ol>
          )}
          <div className="kv">
            <span>Read {a.understood_by === 'gemini' ? 'by Gemini (it picked the template; it never writes queries)' : 'by keyword matching'} as <b>{a.title}</b></span>
            <span>Time measured on the server</span>
          </div>
          <div>
            <div className="code-head"><h4>The exact query that ran</h4><button className="btn btn-sm btn-ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
            <pre className="code">{q.text}</pre>
            {params.length > 0 && (
              <div className="kv" style={{ marginTop: 8 }}>
                {params.map(([k, v]) => <span key={k}>{k.replace(/_/g, ' ')} = <b>{typeof v === 'string' ? v : JSON.stringify(v)}</b></span>)}
              </div>
            )}
          </div>
          {rows.length > 0 && (
            <div>
              <h4>First {rows.length} of {num(a.row_count)} results</h4>
              <table className="rows">
                <thead><tr>{cols.map(({ c, i }) => <th key={c} className={typeof rows[0][i] === 'number' ? 'n' : ''}>{columnWord(c)}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(({ c, i: j }) => <td key={c} className={typeof r[j] === 'number' ? 'n' : ''}>{cellText(c, r[j])}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
