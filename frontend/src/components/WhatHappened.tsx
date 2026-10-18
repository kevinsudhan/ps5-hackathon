import { useEffect, useRef, useState } from 'react'
import type { Cluster, EventInfo } from '../api/types'
import { num, shortDate, usd } from '../lib/format'
import { TERMS } from '../lib/glossary'
import { useCountUp } from '../lib/motion'
import { Term } from './Term'

interface Props {
  compact: boolean               // after a question: a slim strip above the answer
  events: EventInfo[]
  event: EventInfo | null
  onEvent: (id: string) => void
  clusters: Cluster[] | null
  loading: boolean
  disabled: boolean
  reduced: boolean
}

/** "What happened": the active disruption and how big it is (totals over GET /clusters). */
export function WhatHappened({ compact, events, event, onEvent, clusters, loading, disabled, reduced }: Props) {
  const promises = clusters?.reduce((s, c) => s + c.promises_at_risk, 0)
  const exposure = clusters?.reduce((s, c) => s + (c.penalty_usd ?? 0), 0)
  const shipments = clusters?.reduce((s, c) => s + c.shipments, 0)
  return (
    <section className={`happened ${compact ? 'strip' : 'hero'}`} aria-label="What happened">
      <div className="happened-head">
        {!compact && <div className="section-title">What happened <span className="section-sub">The disruption the agents are working on</span></div>}
        <div className="happened-title">
          <span className="status"><span className="pulse" />Active disruption</span>
          <h1>{event?.name ?? <span className="skeleton-text" style={{ width: 280 }} />}</h1>
        </div>
        <div className="happened-when">
          {event && <span>{shortDate(event.start)} – {shortDate(event.end)} · then {event.backlog_days} days of backlog</span>}
          {events.length > 1 && <SwitchEvent events={events} event={event} onEvent={onEvent} disabled={disabled} />}
        </div>
      </div>
      <div className="stats">
        <Stat value={promises} label="Orders at risk" tip={TERMS.atRisk} note="will arrive after the promised date" risk loading={loading} reduced={reduced} />
        <Stat value={exposure} money label="Late-fee exposure" tip={TERMS.exposure} note="due if nothing is done" loading={loading} reduced={reduced} />
        <Stat value={clusters?.length} label="Independent groups" tip={TERMS.groups} note="separate pile-ups, fixable separately" loading={loading} reduced={reduced} />
        <Stat value={shipments} label="Shipments delayed" tip={TERMS.delayed} note="reached by the delay" loading={loading} reduced={reduced} />
      </div>
    </section>
  )
}

function Stat({ value, label, note, tip, risk, money, loading, reduced }: {
  value?: number; label: string; note: string; tip: string; risk?: boolean; money?: boolean; loading: boolean; reduced: boolean
}) {
  const shown = useCountUp(value, reduced)
  return (
    <div className={`stat${risk ? ' risk' : ''}`}>
      <div className="stat-value">
        {shown == null ? (loading ? <span className="skeleton-text" style={{ width: 90, height: 28 }} /> : '—') : money ? usd(shown) : num(Math.round(shown))}
      </div>
      <div className="stat-label"><Term tip={tip}>{label}</Term></div>
      <div className="stat-note">{note}</div>
    </div>
  )
}

function SwitchEvent({ events, event, onEvent, disabled }: { events: EventInfo[]; event: EventInfo | null; onEvent: (id: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) }
  }, [open])
  return (
    <div className="switch-event" ref={box}>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen(o => !o)} disabled={disabled} aria-expanded={open} aria-haspopup="listbox">
        Switch disruption ({events.length}) ▾
      </button>
      {open && (
        <div className="menu" role="listbox" aria-label="Disruptions">
          {events.map(e => (
            <button key={e.id} role="option" aria-selected={e.id === event?.id} className={e.id === event?.id ? 'on' : ''}
              onClick={() => { onEvent(e.id); setOpen(false) }}>
              <span>{e.name}</span>
              <small>{shortDate(e.start)} – {shortDate(e.end)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
