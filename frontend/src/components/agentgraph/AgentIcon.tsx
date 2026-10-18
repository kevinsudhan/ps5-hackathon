import type { Col } from './words'

/** One small line icon per pipeline step; shared by the Agents view and the step-by-step trace. */
export default function AgentIcon({ col, className = 'ag-icon' }: { col: Col; className?: string }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {col === 'sentinel' && <><circle cx="8" cy="8" r="6" {...p} /><circle cx="8" cy="8" r="2" {...p} /><path d="M8 8 L12.5 4" {...p} /></>}
      {col === 'impact_analyst' && <><circle cx="8" cy="8" r="1.6" {...p} /><circle cx="8" cy="8" r="4.2" {...p} opacity="0.7" /><circle cx="8" cy="8" r="6.6" {...p} opacity="0.4" /></>}
      {col === 'rerouter' && <><path d="M2 12 H14" {...p} /><path d="M2 12 C6 12 6 4 10 4 H14" {...p} /><circle cx="2.5" cy="12" r="1.2" {...p} /></>}
      {col === 'finance' && <><path d="M10.8 4.6 C10 3.6 6 3.2 6 5.6 C6 8 11 7.4 11 10.2 C11 12.6 6.6 12.6 5.2 11.2" {...p} /><path d="M8 2 V14" {...p} /></>}
      {col === 'verifier' && <><path d="M8 1.8 L13.4 4 V8 C13.4 11 11 13.2 8 14.2 C5 13.2 2.6 11 2.6 8 V4 Z" {...p} /><path d="M5.4 8.2 L7.3 10 L10.8 6.2" {...p} /></>}
      {col === 'approval' && <><circle cx="8" cy="5.2" r="2.6" {...p} /><path d="M3 14 C3 10.4 13 10.4 13 14" {...p} /></>}
      {col === 'comms' && <><path d="M2.5 3.5 H13.5 V10.5 H7 L4 13 V10.5 H2.5 Z" {...p} /></>}
    </svg>
  )
}
