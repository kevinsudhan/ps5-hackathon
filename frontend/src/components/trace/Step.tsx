import { useEffect, useRef, type ReactNode } from 'react'

// One step of the vertical stepper: a rail with a number (or icon), one plain sentence, and details
// that open on demand. Picking the step also lights up what it touched on the left.
export interface StepProps {
  marker: ReactNode            // the number or an icon
  kicker: string               // "Step 2 · What FalkorDB walked"
  sentence: ReactNode          // the one plain sentence
  tags?: ReactNode
  selected: boolean
  open: boolean
  state?: 'done' | 'live' | 'pending'
  last?: boolean
  reduced: boolean
  onPick: () => void
  children?: ReactNode
}

export function Step({ marker, kicker, sentence, tags, selected, open, state = 'done', last, reduced, onPick, children }: StepProps) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (state === 'live') ref.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }, [state, reduced])
  return (
    <li ref={ref} className={`tr-step tr-${state}${selected ? ' sel' : ''}${open ? ' open' : ''}${last ? ' last' : ''}`}>
      <div className="tr-rail" aria-hidden><span className="tr-marker">{marker}</span></div>
      <div className="tr-body">
        <button className="tr-head" onClick={onPick} aria-expanded={open} disabled={state === 'pending' && !children}>
          <span className="tr-kicker">{kicker}{state === 'live' && <span className="tr-working"><i />working</span>}</span>
          <span className="tr-sentence">{sentence}</span>
          {tags && <span className="tr-tags">{tags}</span>}
        </button>
        {children && <div className="tr-more" aria-hidden={!open}><div className="tr-more-in">{children}</div></div>}
      </div>
    </li>
  )
}

export function Tag({ children, tone = 'feature' }: { children: ReactNode; tone?: 'feature' | 'ok' | 'warn' | 'danger' | 'muted' }) {
  return <span className={`tr-tag tr-tag-${tone}`}>{children}</span>
}

export function Cypher({ title, text, meta }: { title: string; text: string; meta?: string }) {
  const lines = text.split('\n').length
  return (
    <details className="tr-cypher">
      <summary><span>{title}</span><em>{meta ?? `${lines} ${lines === 1 ? 'line' : 'lines'} of Cypher`}</em></summary>
      <pre>{text}</pre>
    </details>
  )
}

export function Facts({ rows }: { rows: [string, string][] }) {
  if (!rows.length) return null
  return <dl className="tr-facts">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
}
