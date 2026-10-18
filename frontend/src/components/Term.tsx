import type { ReactNode } from 'react'

/** A technical term with its plain-English explanation on hover or keyboard focus. */
export function Term({ children, tip }: { children: ReactNode; tip: string }) {
  return (
    <span className="term" tabIndex={0}>
      {children}
      <span role="tooltip" className="tip">{tip}</span>
    </span>
  )
}

/** Any control with an explanation bubble (shown on hover and focus within). */
export function Tip({ children, tip, below }: { children: ReactNode; tip: string; below?: boolean }) {
  return (
    <span className={`has-tip${below ? ' below' : ''}`}>
      {children}
      <span role="tooltip" className="tip">{tip}</span>
    </span>
  )
}
