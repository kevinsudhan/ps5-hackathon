import { useState } from 'react'
import type { Chip } from '../api/types'

interface Props {
  docked: boolean               // false: centred on the landing state; true: at the bottom of the stage
  asking: boolean
  chips: Chip[]
  error: string | null
  rejected: { detail: string; suggestions: Chip[] } | null
  onAsk: (q: string) => void
  hint: boolean
  onDismissHint: () => void
}

/** "Ask": one predictable place for questions, centred at first, docked after the first answer. */
export function AskDock({ docked, asking, chips, error, rejected, onAsk, hint, onDismissHint }: Props) {
  const [text, setText] = useState('')
  const submit = (q: string) => {
    const question = q.trim()
    if (!question || asking) return
    onAsk(question)
    setText('')
  }
  const shown = rejected?.suggestions.length ? rejected.suggestions : chips
  return (
    <section className={`ask ${docked ? 'docked' : 'centred'}`} aria-label="Ask">
      {!docked && (
        <div className="ask-guide">
          <div className="section-title">Ask <span className="section-sub">Plain-English questions, answered from the graph</span></div>
          <p>Ask anything about this disruption, and the answer will be drawn as a graph.</p>
        </div>
      )}
      <form className="ask-box" onSubmit={e => { e.preventDefault(); submit(text) }}>
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden className="ask-icon"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M14 14l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        <input value={text} onChange={e => setText(e.target.value)} aria-label="Ask a question"
          placeholder={docked ? 'Ask another question…' : 'e.g. Which orders are at risk? Why is Aisha’s order late? The 10 most loss-inducing orders?'} />
        <button className="btn btn-primary" type="submit" disabled={asking || !text.trim()}>
          {asking ? <span className="spinner" /> : null} Ask
        </button>
      </form>
      {(error || rejected) && (
        <div className={`notice${error ? ' err' : ''}`} role="alert">
          {error ?? `${rejected!.detail || "I can't answer that one."} Try one of these:`}
        </div>
      )}
      <div className="chips" aria-label="Suggested questions">
        {shown.map(c => (
          <button key={c.question} className="chip" disabled={asking} onClick={() => submit(c.question)} title={c.question}>{c.label}</button>
        ))}
      </div>
      {hint && !docked && (
        <div className="first-hint" role="note">
          <span><b>New here?</b> Click a suggestion or type a question. Or press <b>Run the agents</b> on the right to watch six agents respond.</span>
          <button className="close-x" onClick={onDismissHint} aria-label="Dismiss the hint">×</button>
        </div>
      )}
    </section>
  )
}
