import { useEffect, useState } from 'react'
import type { Loaded } from '../api/client'
import type { Answer, Chip, Engine } from '../api/types'
import { cellText, columnWord, ENGINE_COLOR, ENGINE_NAME, ms, num, showColumn } from '../lib/format'

interface Props {
  answer: Loaded<Answer> | null
  asking: boolean
  question: string | null
  engine: Engine
  error: string | null
  rejected: { detail: string; suggestions: Chip[] } | null
  chips: Chip[]
  dim: boolean
  onAsk: (question: string) => void
}

export function Dock({ answer, asking, question, engine, error, rejected, chips, dim, onAsk }: Props) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const a = answer?.data
  useEffect(() => { setOpen(false) }, [a?.template, a?.read_as])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const submit = (q: string) => {
    const question = q.trim()
    if (!question || asking) return
    onAsk(question)
    setText('')
  }
  const shown = rejected ? (rejected.suggestions.length ? rejected.suggestions : chips) : chips

  return (
    <footer className={`dock${dim ? ' dim' : ''}`} aria-hidden={dim || undefined}>
      <div className="dock-inner">
        {a ? (
          <div>
            <div className="read-as">
              {asking ? <Thinking question={question} engine={engine} /> : a.read_as}
              {answer?.source === 'fixture' && <span> · sample answer (live endpoint not ready yet)</span>}
            </div>
            <p className={`answer${asking ? ' muted' : ''}`}>{a.answer}</p>
            <div className="meta" style={{ marginTop: 6 }}>
              <span>
                <i className="dot" style={{ background: ENGINE_COLOR[a.query.engine], marginRight: 7 }} />
                Answered by <b>{ENGINE_NAME[a.query.engine]}</b> in <b>{ms(a.query.ms)}</b>
              </span>
              <span>Query: <b>{num(a.query.chars)}</b> characters, <b>{num(a.query.lines)}</b> lines</span>
              <button className="linkish" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                {open ? 'Hide how it was found' : 'How it was found'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="read-as">Every order is a promise. Ask which ones a disruption breaks, and why.</div>
            {asking && <div className="read-as"><Thinking question={question} engine={engine} /></div>}
            <p className="answer muted">{asking ? 'Finding the answer…' : error ? 'No answer yet.' : 'Ask a question below.'}</p>
          </div>
        )}

        {open && a && <HowFound a={a} />}

        {error && <div className="notice err" role="alert">{error}</div>}
        {rejected && <div className="notice">{rejected.detail || "I can't answer that one."} Try one of these:</div>}

        <div className="chips" aria-label="Suggested questions">
          {shown.map(c => (
            <button key={c.question} className="chip" disabled={asking} onClick={() => submit(c.question)} title={c.question}>
              {c.label}
            </button>
          ))}
        </div>

        <form className="prompt" onSubmit={e => { e.preventDefault(); submit(text) }}>
          <input
            value={text} onChange={e => setText(e.target.value)} aria-label="Ask a question"
            placeholder="Ask about orders, shipments or ports… e.g. Which Seattle orders are at risk?"
          />
          <button className="btn btn-dark" type="submit" disabled={asking || !text.trim()}>
            {asking ? <span className="spinner" /> : null} Ask
          </button>
        </form>
      </div>
    </footer>
  )
}

function Thinking({ question, engine }: { question: string | null; engine: Engine }) {
  return (
    <span className="row" style={{ gap: 8, display: 'inline-flex' }}>
      <span className="spinner" style={{ color: ENGINE_COLOR[engine] }} />
      <span>Asking {ENGINE_NAME[engine]}{question ? <>: “{question}”</> : null}</span>
    </span>
  )
}

function HowFound({ a }: { a: Answer }) {
  const params = Object.entries(a.query.params ?? {})
  const rows = a.rows.slice(0, 6)
  const cols = a.columns.map((c, i) => ({ c, i })).filter(x => showColumn(x.c))
  return (
    <div className="found" role="region" aria-label="How it was found">
      <div className="kv">
        <span>Engine <b>{ENGINE_NAME[a.query.engine]}</b></span>
        <span>Time <b>{ms(a.query.ms)}</b> <span style={{ color: 'var(--ink-3)' }}>(measured on the server)</span></span>
        <span>Length <b>{num(a.query.chars)}</b> characters, <b>{num(a.query.lines)}</b> lines</span>
        <span>Question read {a.understood_by === 'gemini' ? 'by Gemini' : 'by keyword matching'}, as <b>{a.title}</b></span>
      </div>
      <div>
        <h4>The exact query that ran</h4>
        <pre className="code">{a.query.text}</pre>
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
            <thead>
              <tr>{cols.map(({ c, i }) => <th key={c} className={typeof rows[0][i] === 'number' ? 'n' : ''}>{columnWord(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{cols.map(({ c, i: j }) => <td key={c} className={typeof r[j] === 'number' ? 'n' : ''}>{cellText(c, r[j])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
