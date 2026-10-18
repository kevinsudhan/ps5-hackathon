// The order timeline's data: the why_late rows (how late each step is) on top of the planned calendar
// from GET /api/{tenant}/timeline. Every delay, buffer, late day and fee drawn comes from the rows;
// the graph only says where on the calendar each step was planned to be. Nothing here invents a number.

import type { Answer } from '../../api/types'

// ---- what /api/{tenant}/timeline returns (backend/promisegraph/timeline.py) --------------------
export interface Hub { id: string; name: string; kind: string }
export interface Leg {
  seq: number; mode: string; depart_day: number; arrive_day: number; from: Hub; to: Hub; carrier: string | null
}
export interface Touch { seq: number; direction: 'arrives' | 'leaves'; hub: string; day: number; start_delay: number }
export interface PlannedShipment {
  id: string; stage: string; mode: string; description: string; depart_day: number; eta_day: number
  legs: Leg[]; touches: Touch[]
}
export interface Plan {
  epoch: string
  event: { id: string; name: string; type: string; start_day: number; end_day: number; backlog_days: number; hubs: Hub[] }
  shipments: PlannedShipment[]
  feeds: { src: string; dst: string; buffer_days: number }[]
  promise: {
    id: string; due_day: number; due_date: string; penalty_per_day: number; status: string
    order: string; placed_day: number; customer: string; city: string; shipments: string[]
  }
}

// ---- the why_late rows (questions.WHY_COLS) ----------------------------------------------------
export interface WhyStep { step: number; shipment: string; what: string; from: string; lateHere: number; slack: number | null }
export interface Why {
  steps: WhyStep[]; order: string; city: string; promised: string; daysLate: number; fee: number; port: string
}

export function readWhy(a: Answer): Why | null {
  if (a.template !== 'why_late' || !a.rows.length) return null
  const at = (name: string) => a.columns.indexOf(name)
  const col = {
    step: at('step'), shipment: at('shipment'), what: at('what'), from: at('leaves_from'), here: at('days_late_here'),
    slack: at('slack_days'), order: at('order_ref'), city: at('city'), promised: at('promised'),
    late: at('days_late'), fee: at('late_fee'), port: at('port'),
  }
  if (Object.values(col).some(i => i < 0)) return null
  const rows = [...a.rows].sort((x, y) => Number(x[col.step]) - Number(y[col.step]))
  const last = rows[rows.length - 1]
  return {
    steps: rows.map(r => ({
      step: Number(r[col.step]), shipment: String(r[col.shipment]), what: String(r[col.what] ?? ''),
      from: String(r[col.from] ?? ''), lateHere: Number(r[col.here]),
      slack: r[col.slack] == null ? null : Number(r[col.slack]),
    })),
    order: String(last[col.order]), city: String(last[col.city] ?? ''), promised: String(last[col.promised]),
    daysLate: Number(last[col.late]), fee: Number(last[col.fee]), port: String(last[col.port]),
  }
}

/** The disruption this answer is about: its graph names the event node; the header's choice is the fallback. */
export function answerEvent(a: Answer, fallback: string | null): string | null {
  return a.graph?.nodes.find(n => n.kind === 'event')?.id ?? fallback
}

// ---- dates ----------------------------------------------------------------------------------------
const DAY_MS = 86_400_000
const epochMs = (epoch: string) => Date.parse(`${epoch}T00:00:00Z`)
export const dateOf = (epoch: string, day: number) => new Date(epochMs(epoch) + day * DAY_MS)
export const dayOf = (epoch: string, iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - epochMs(epoch)) / DAY_MS)
const fmtShort = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const fmtLong = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
export const short = (epoch: string, day: number) => fmtShort.format(dateOf(epoch, day))     // "Dec 14"
export const long = (epoch: string, day: number) => fmtLong.format(dateOf(epoch, day))       // "Mon, Dec 14"
export const days = (n: number) => `${n.toLocaleString('en-US')} ${Math.abs(n) === 1 ? 'day' : 'days'}`
export const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
export const cap = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1)

/** "Oct 20–24" or "Oct 30 – Nov 2" for an inclusive day range. */
export function span(epoch: string, from: number, to: number) {
  const a = dateOf(epoch, from), b = dateOf(epoch, to)
  if (from === to) return short(epoch, from)
  return a.getUTCMonth() === b.getUTCMonth() ? `${short(epoch, from)}–${b.getUTCDate()}` : `${short(epoch, from)} – ${short(epoch, to)}`
}

const BY: Record<string, string> = {
  ocean: 'by sea', sea: 'by sea', air: 'by air', truck: 'by truck', rail: 'by rail', parcel: 'by courier',
}
export const byMode = (mode: string) => BY[mode] ?? `by ${mode}`

// ---- the model the chart draws -----------------------------------------------------------------
export interface StepRow {
  i: number
  id: string
  title: string             // plain English, no ids
  what: string
  from: string
  to: string
  mode: string
  depart: number            // planned (graph)
  eta: number               // planned (graph)
  late: number              // days late here (rows)
  departNow: number         // when it can actually leave: the step before's new arrival (rows' delay on graph dates)
  arriveNow: number         // eta + late
  slack: number | null      // buffer before this step (rows)
  absorbed: number          // how much of the incoming delay that buffer soaked up (rows: late before - late here)
  bufferFrom: number | null // where the buffer sits on the calendar: the step before's planned arrival (graph)
  touch: Touch | null       // step 0: where it met the closed port
  legs: Leg[]
}

export interface Model {
  epoch: string
  domain: [number, number]
  event: Plan['event']
  port: Hub                 // the closed port this chain starts at (rows' port)
  otherPorts: Hub[]
  closeFrom: number         // first closed day
  closeTo: number           // last closed day
  clearDay: number          // first day moving again (end + backlog + 1)
  steps: StepRow[]
  order: {
    customer: string; city: string; id: string
    due: number             // promised (rows)
    arrive: number          // promised + days late (rows)
    plannedArrive: number   // the last step's planned arrival (graph)
    margin: number          // rows: last step's delay - days late
    daysLate: number; fee: number; perDay: number | null
  }
  mismatches: string[]      // places where the graph's planned dates and the rows disagree (rows win)
}

/** The calendar's x axis. Long stretches where nothing on the chart starts or ends (a five-week voyage)
 *  are squeezed to `squeeze` days, marked as a break, so they do not crowd out the days that matter.
 *  `vis` maps a day to its position in drawn days. */
export interface Break { from: number; to: number }
export function timeAxis(m: Model, gap = 10, keep = 2, squeeze = 3) {
  const [d0, d1] = m.domain
  const keys = new Set<number>([d0, d1, m.closeFrom, m.closeTo + 1, m.clearDay, m.order.due, m.order.arrive, m.order.plannedArrive])
  for (const s of m.steps) {
    for (const d of [s.depart, s.eta, s.departNow, s.arriveNow, s.bufferFrom, s.touch?.day]) if (d != null) keys.add(d)
  }
  const ks = [...keys].filter(d => d >= d0 && d <= d1).sort((a, b) => a - b)
  const breaks: Break[] = []
  for (let i = 1; i < ks.length; i++) if (ks[i] - ks[i - 1] > gap) breaks.push({ from: ks[i - 1] + keep, to: ks[i] - keep })
  const vis = (d: number) => {
    let v = d - d0
    for (const b of breaks) if (d > b.from) v -= (Math.min(d, b.to) - b.from) * (1 - squeeze / (b.to - b.from))
    return v
  }
  return { breaks, vis, total: vis(d1), inBreak: (d: number) => breaks.some(b => d > b.from && d < b.to) }
}

export function buildModel(why: Why, plan: Plan): Model {
  const epoch = plan.epoch
  const ev = plan.event
  const byId = new Map(plan.shipments.map(s => [s.id, s]))
  const feed = new Map(plan.feeds.map(f => [`${f.src}>${f.dst}`, f.buffer_days]))
  const port = ev.hubs.find(h => h.id === why.port) ?? { id: why.port, name: why.port, kind: 'port' }
  const mismatches: string[] = []

  const steps: StepRow[] = why.steps.map((w, i) => {
    const s = byId.get(w.shipment)
    if (!s) throw new Error(`The graph has no planned dates for step ${i + 1}.`)
    const legs = [...s.legs].sort((a, b) => a.seq - b.seq)
    const to = legs.length ? legs[legs.length - 1].to.name : ''
    const prev = i > 0 ? why.steps[i - 1] : null
    const prevPlan = prev ? byId.get(prev.shipment) : undefined
    let touch: Touch | null = null
    if (i === 0) {
      // The touch the cascade starts from: the one giving the biggest starting delay (earliest on a tie).
      touch = [...s.touches].sort((a, b) => b.start_delay - a.start_delay || a.day - b.day || a.seq - b.seq)[0] ?? null
      if (!touch) mismatches.push(`step 1 has no planned leg at ${port.name} during the closure`)
      else if (touch.start_delay !== w.lateHere)
        mismatches.push(`step 1 starts ${days(w.lateHere)} late in the answer, the planned dates give ${days(touch.start_delay)}`)
    }
    if (prev && prevPlan) {
      const graphBuf = feed.get(`${prev.shipment}>${w.shipment}`)
      const gap = s.depart_day - prevPlan.eta_day
      if (w.slack != null && graphBuf != null && graphBuf !== w.slack)
        mismatches.push(`step ${i + 1}: buffer ${w.slack} in the answer, ${graphBuf} in the graph`)
      if (w.slack != null && gap !== w.slack)
        mismatches.push(`step ${i + 1}: buffer ${w.slack} in the answer, but it is planned to leave ${days(gap)} after step ${i} arrives`)
      if (w.slack != null && w.lateHere !== Math.max(0, prev.lateHere - w.slack))
        mismatches.push(`step ${i + 1}: ${prev.lateHere} - ${w.slack} buffer should leave ${Math.max(0, prev.lateHere - w.slack)}, the answer says ${w.lateHere}`)
    }
    const through = i === 0 && touch && port.name !== w.from ? `, through ${port.name}` : ''
    return {
      i, id: s.id, what: w.what, from: w.from, to, mode: s.mode,
      title: `${cap(w.what)}, ${byMode(s.mode)} from ${w.from}${through}`,
      depart: s.depart_day, eta: s.eta_day, late: w.lateHere,
      departNow: s.depart_day, arriveNow: s.eta_day + w.lateHere,
      slack: i === 0 ? null : w.slack,
      absorbed: prev ? Math.max(0, prev.lateHere - w.lateHere) : 0,
      bufferFrom: prevPlan ? prevPlan.eta_day : null,
      touch, legs,
    }
  })
  // It leaves when the step before arrives (or as planned, if its buffer swallowed the whole delay).
  for (let i = 1; i < steps.length; i++) steps[i].departNow = Math.max(steps[i].depart, steps[i - 1].arriveNow)

  const last = steps[steps.length - 1]
  const due = dayOf(epoch, why.promised)
  const arrive = due + why.daysLate
  if (plan.promise.due_date !== why.promised)
    mismatches.push(`promised ${why.promised} in the answer, ${plan.promise.due_date} in the graph`)
  if (last.arriveNow !== arrive)
    mismatches.push(`the last step arrives ${short(epoch, last.arriveNow)} on the planned dates, the answer says ${short(epoch, arrive)}`)
  if (!plan.promise.shipments.includes(last.id))
    mismatches.push('the last step is not the shipment that delivers the order')
  const perDay = plan.promise.penalty_per_day
  const feeAgrees = perDay != null && perDay * why.daysLate === why.fee

  const first = steps[0]
  // From just before the first shipment leaves (or the closure starts) to just after the new delivery date;
  // a long quiet stretch in between is squeezed by timeAxis().
  const lo = Math.min(ev.start_day - 2, first.depart - 1)
  const hi = Math.max(arrive, due, ...steps.map(s => s.arriveNow)) + 3
  return {
    epoch, domain: [lo, hi], event: ev, port, otherPorts: ev.hubs.filter(h => h.id !== port.id),
    closeFrom: ev.start_day, closeTo: ev.end_day, clearDay: ev.end_day + ev.backlog_days + 1,
    steps,
    order: {
      customer: plan.promise.customer, city: why.city || plan.promise.city, id: why.order,
      due, arrive, plannedArrive: last.eta, margin: Math.max(0, last.late - why.daysLate),
      daysLate: why.daysLate, fee: why.fee, perDay: feeAgrees ? perDay : null,
    },
    mismatches,
  }
}
