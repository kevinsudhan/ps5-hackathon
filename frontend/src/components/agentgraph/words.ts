// Plain-English wording for the agent run graph. Every figure comes from the decision's numbers
// (Cypher), nothing is computed here beyond picking which ones to show.

import { num, shortDate, usd } from '../../lib/format'

export type Col = 'sentinel' | 'impact_analyst' | 'rerouter' | 'finance' | 'verifier' | 'approval' | 'comms'
export const COLS: Col[] = ['sentinel', 'impact_analyst', 'rerouter', 'finance', 'verifier', 'approval', 'comms']

export const COL_NAME: Record<Col, string> = {
  sentinel: 'Sentinel', impact_analyst: 'Impact analyst', rerouter: 'Rerouter', finance: 'Finance',
  verifier: 'Verifier', approval: 'Approval', comms: 'Comms',
}
export const COL_ROLE: Record<Col, string> = {
  sentinel: 'Watches disruptions and chokepoints, and recalls similar past disruptions from memory.',
  impact_analyst: 'Finds the promises that break and splits them into independent stranded groups.',
  rerouter: 'Finds routes around the closed port for each group’s root shipments.',
  finance: 'Prices every option, using the track record of past playbooks, and proposes the plan.',
  verifier: 'Re-runs every query and re-walks every route; blocks the plan if anything disagrees.',
  approval: 'A person signs off before anything that spends money happens. Nobody can approve their own request.',
  comms: 'Drafts customer messages from the approved plan and writes the outcome back to memory.',
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'live'
export interface Pill { word: string; tone: Tone }

const plural = (n: number, w: string, p?: string) => `${num(n)} ${n === 1 ? w : (p ?? w + 's')}`
const n = (x: unknown) => (typeof x === 'number' ? x : Number(x ?? 0))

export interface DecisionLike { kind: string; status: string; numbers: Record<string, number | string>; summary: string }

/** Three short lines for a card: a headline and two supporting facts. */
export function cardLines(col: Col, ds: DecisionLike[], ctx: { closed: string[]; memoryOn: boolean }): string[] {
  const by = (k: string) => ds.find(d => d.kind === k)
  if (col === 'sentinel') {
    const a = by('alert'), r = by('recall')
    if (!a) return []
    const port = ctx.closed.length === 1 ? ctx.closed[0] : ctx.closed.length ? `${ctx.closed.length} ports` : 'The port'
    const lines = [`${port} shut ${dayRange(String(a.numbers.start), String(a.numbers.end))}`,
      `#${a.numbers.chokepoint_rank} chokepoint`]
    if (r) lines.push(!ctx.memoryOn ? 'Memory switched off' : n(r.numbers.similar_runs)
      ? `Recalled ${plural(n(r.numbers.similar_runs), 'past run')}` : 'Nothing in memory')
    return lines
  }
  if (col === 'impact_analyst') {
    const d = by('impact')
    if (!d) return []
    return [`${plural(n(d.numbers.promises_at_risk), 'promise')} break`, `${usd(n(d.numbers.penalty_usd))} penalties`,
      `${plural(n(d.numbers.clusters), 'group')}, ${plural(n(d.numbers.roots), 'root')}`]
  }
  if (col === 'rerouter') {
    const d = by('reroute')
    if (!d) return []
    const lines = [`${plural(n(d.numbers.options), 'route')} found`,
      `for ${num(n(d.numbers.roots_with_options))} of ${plural(n(d.numbers.roots), 'root')}`]
    if (n(d.numbers.roots_stuck)) lines.push(`${num(n(d.numbers.roots_stuck))} stuck in port`)
    else lines.push('all beat waiting')
    return lines
  }
  if (col === 'finance') {
    const d = by('plan')
    if (!d) return []
    const roots = n(d.numbers.roots_rescued)
    const lines = roots
      ? [`${plural(roots, 'rescue')} for ${usd(n(d.numbers.cost_usd))}`,
        `Saves ${usd(n(d.numbers.saved_usd))}`]
      : ['No rescue: tell the customers', `${usd(n(d.numbers.penalty_before))} penalties`]
    const mem = (d as { memory_changed?: boolean | null }).memory_changed
    lines.push(!ctx.memoryOn ? 'Face value, no memory' : mem ? 'Memory changed it' : 'Memory: same plan')
    return lines
  }
  if (col === 'verifier') {
    const d = by('verification')
    if (!d) return []
    const ok = !n(d.numbers.failed)
    return [`${num(n(d.numbers.passed))} of ${plural(n(d.numbers.checks), 'check')} passed`,
      ok ? 'Plan cleared' : 'Plan blocked', 'Re-ran in Cypher']
  }
  if (col === 'comms') {
    const d = by('message')
    if (!d) return []
    return [`${plural(n(d.numbers.messages), 'apology message')}`,
      `${num(n(d.numbers.promises_saved))} back on time`, 'Memory updated']
  }
  return []
}

/** Labels for the figures behind a decision, in the order worth reading. */
export const NUMBER_LABEL: Record<string, string> = {
  start: 'Closed from', end: 'Reopens', backlog_days: 'Days of backlog after reopening',
  chokepoint_rank: 'Chokepoint rank (betweenness)', betweenness: 'Betweenness score', direct_hits: 'Shipments through the port in the window',
  similar_runs: 'Similar past runs recalled', cost_usd: 'Cost', saved_usd: 'Penalties avoided',
  promises_at_risk: 'Promises that break', penalty_usd: 'Late penalties at stake', far_promises: 'Promises 3 or more hops away',
  max_hops: 'Deepest cascade (hops)', clusters: 'Stranded groups', roots: 'Root shipments',
  options: 'Route options', roots_with_options: 'Root shipments with a route', roots_stuck: 'Root shipments stuck in the port',
  penalty_before: 'Penalties without a plan', penalty_after: 'Penalties with the plan', net_usd: 'Net saving',
  promises_before: 'Promises late without a plan', promises_after: 'Promises still late', promises_saved: 'Promises back on time',
  roots_rescued: 'Root shipments rescued', clusters_rescued: 'Groups rescued', clusters_total: 'Groups in total',
  expected_saved_usd: 'Saving expected, after the track record',
  checks: 'Checks run', passed: 'Checks passed', failed: 'Checks failed',
  messages: 'Apology messages drafted', max_days_late: 'Latest promise (days late)',
}
const USD_KEYS = new Set(['cost_usd', 'saved_usd', 'penalty_usd', 'penalty_before', 'penalty_after', 'net_usd', 'expected_saved_usd'])

export function numberRows(nums: Record<string, number | string>): [string, string][] {
  const order = Object.keys(NUMBER_LABEL)
  return Object.entries(nums)
    .filter(([k]) => NUMBER_LABEL[k])
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([k, v]) => [NUMBER_LABEL[k], typeof v === 'number'
      ? (USD_KEYS.has(k) ? usd(v) : k === 'betweenness' ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : num(v))
      : k === 'start' || k === 'end' ? shortDate(v) : String(v)])
}

const EVIDENCE_WORD: Record<string, [string, string]> = {
  Event: ['disruption', 'disruptions'], Hub: ['place', 'places'], Shipment: ['shipment', 'shipments'],
  Promise: ['promise', 'promises'], Run: ['past run', 'past runs'],
}
export function evidenceWords(ev: Record<string, number>): string {
  return Object.entries(ev).filter(([, c]) => c > 0)
    .map(([label, c]) => plural(c, EVIDENCE_WORD[label]?.[0] ?? label.toLowerCase(), EVIDENCE_WORD[label]?.[1])).join(' · ')
}

export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'ag-tone-neutral', ok: 'ag-tone-ok', warn: 'ag-tone-warn', danger: 'ag-tone-danger', muted: 'ag-tone-muted', live: 'ag-tone-live',
}

export const month = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}
/** '20–24 Oct', or '28 Oct–3 Nov' across months. */
export function dayRange(a: string | null | undefined, b: string | null | undefined) {
  const s = shortDate(a ?? undefined), e = shortDate(b ?? undefined)
  const [sd, sm] = s.split(' '), [ed, em] = e.split(' ')
  return sm && sm === em ? `${sd}–${ed} ${em}` : `${s}–${e}`
}
export const kusd = (x: number) => (Math.abs(x) >= 10000 ? `$${Math.round(x / 1000)}k` : usd(x))
export { plural }
