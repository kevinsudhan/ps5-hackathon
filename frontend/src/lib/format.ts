// Formatting and plain-English wording only. Nothing here computes a business number.

import type { AgentName, Engine, NodeKind, Tone } from '../api/types'
import { rgb, token } from './theme'

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const int = new Intl.NumberFormat('en-US')

export const usd = (n: number | null | undefined) => (n == null ? '—' : usd0.format(n))
export const num = (n: number | null | undefined) => (n == null ? '—' : int.format(n))
export const ms = (n: number) => `${n < 10 ? n.toFixed(1) : int.format(Math.round(n))} ms`

export function shortDate(iso: string | undefined) {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
export function monthYear(iso: string) {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export const ENGINE_NAME: Record<Engine, string> = { falkordb: 'FalkorDB', postgres: 'PostgreSQL' }
/** Engine identity. FalkorDB is the primary engine. */
export const ENGINE_COLOR: Record<Engine, string> = {
  get falkordb() { return token('--engine-falkor') }, get postgres() { return token('--engine-pg') },
}

/** Semantic only: closed / late, delayed, on track, other. Read from the design tokens. */
const TONE_TOKEN: Record<Tone, string> = {
  danger: '--danger', warning: '--delayed', good: '--ok', neutral: '--other', muted: '--mauve',
}
export const TONE_COLOR: Record<Tone, string> = {
  get danger() { return token(TONE_TOKEN.danger) }, get warning() { return token(TONE_TOKEN.warning) },
  get good() { return token(TONE_TOKEN.good) }, get neutral() { return token(TONE_TOKEN.neutral) },
  get muted() { return token(TONE_TOKEN.muted) },
}
/** The same tones as "r, g, b" for translucent fills and strokes. */
export const TONE_RGB: Record<Tone, string> = {
  get danger() { return rgb(TONE_COLOR.danger) }, get warning() { return rgb(TONE_COLOR.warning) },
  get good() { return rgb(TONE_COLOR.good) }, get neutral() { return rgb(TONE_COLOR.neutral) },
  get muted() { return rgb(TONE_COLOR.muted) },
}
/** Text-safe tone colours (AA on indigo surfaces): coral text uses its lighter tint. */
export const TONE_TEXT: Record<Tone, string> = {
  get danger() { return token('--danger-text') }, get warning() { return token('--delayed') },
  get good() { return token('--ok') }, get neutral() { return token('--text-2') }, get muted() { return token('--text-2') },
}
/** Graph surfaces for code that cannot read CSS variables (three.js). */
export const GRAPH = {
  get stage() { return token('--bg') }, get card() { return token('--indigo') }, get ink() { return token('--text') },
  get ink2() { return token('--text-2') }, get ink3() { return token('--text-2') }, get quiet() { return token('--purple') },
  get line() { return token('--purple') }, get lineHover() { return token('--mauve') }, get select() { return token('--text') },
  get flow() { return token('--periwinkle') }, get cardQuiet() { return token('--bg-deep') },
}

/** "Reroute 3 shipments by sea" / "Air-freight 5 shipments" / "No rescue": the same words as the backend. */
export function recommendation(p: { roots: number; by_air: number; by_sea: number }) {
  if (!p.roots) return 'No rescue: inform affected customers'
  const n = (k: number) => `${k} shipment${k === 1 ? '' : 's'}`
  if (p.by_air && !p.by_sea) return `Air-freight ${n(p.by_air)}`
  if (p.by_sea && !p.by_air) return `Reroute ${n(p.by_sea)} by sea`
  return `Reroute ${p.by_sea} by sea, air-freight ${p.by_air}`
}
export const pct = (r: number) => `${Math.round(r * 100)}%`

const KIND_WORD: Record<NodeKind, string> = {
  event: 'Disruption', port: 'Port', airport: 'Airport', place: 'Place', warehouse: 'Warehouse',
  factory: 'Factory', shipment: 'Shipment', order: 'Customer order', group: 'Group of orders',
}
export const kindWord = (k: NodeKind) => KIND_WORD[k] ?? 'Item'

/** A word for the colour, so colour never carries meaning alone. */
export function toneWord(tone: Tone, kind?: NodeKind): string | null {
  if (tone === 'danger') {
    if (kind === 'event' || kind === 'port' || kind === 'airport') return 'Closed'
    if (kind === 'shipment') return 'Stuck'
    if (kind === 'order') return 'Late'
    return 'At risk'
  }
  if (tone === 'warning') return 'Delayed'
  if (tone === 'good') return kind === 'shipment' ? 'Rescued' : 'On track'
  return null
}

export const AGENT_LABEL: Record<AgentName, { name: string; role: string }> = {
  sentinel: { name: 'Sentinel', role: 'spots the disruption' },
  impact_analyst: { name: 'Impact analyst', role: 'finds the orders it breaks' },
  rerouter: { name: 'Rerouter', role: 'finds ways around it' },
  finance: { name: 'Finance', role: 'weighs cost against penalties' },
  verifier: { name: 'Verifier', role: 're-checks every number' },
  comms: { name: 'Comms', role: 'writes to customers' },
}

/** Column headers in plain words. */
const COLUMN_WORD: Record<string, string> = {
  hops: 'steps from the port', tier: 'customer type', days_late: 'days late', penalty_usd: 'penalty',
  due_date: 'promised for', delay_days: 'delay (days)', cluster: 'group', betweenness: 'routes through it',
  late_fee: 'late fee', steps: 'steps from the port', root_what: 'what got stuck',
}
export const columnWord = (c: string) => COLUMN_WORD[c] ?? c.replace(/_/g, ' ')

export function cellText(column: string, v: string | number | null) {
  if (v == null) return '—'
  if (typeof v === 'number') return /usd|penalty|cost|fee/.test(column) ? usd(v) : num(v)
  if (/^d{4}-d{2}-d{2}$/.test(v)) return shortDate(v)
  return v
}

/** First sentence of a longer text, for captions. */
export function firstSentence(s: string) {
  const m = s.match(/^.*?[.!?](\s|$)/)
  return (m ? m[0] : s).trim()
}

/** Internal ids (order refs, shipment and hub codes) are not for people; the results preview hides them. */
const ID_COLUMNS = /^(order_ref|order|root|port|hub|shipment|promise|event|.*_id|id)$/
export const showColumn = (c: string) => !ID_COLUMNS.test(c)

/**
 * Agent and memory texts come from the backend and still use a few internal words. Swap those for
 * plain English (wording only: numbers and names are left exactly as they are).
 */
const PLAIN: [RegExp, string][] = [
  [/\broot shipments\b/gi, 'shipments where the delay starts'],
  [/\broot shipment\b/gi, 'shipment where the delay starts'],
  [/\bclusters\b/gi, 'groups of orders'],
  [/\bcluster\b/gi, 'group of orders'],
  [/\bpromises\b/g, 'orders'],
  [/\bpromise\b/g, 'order'],
  [/\bchokepoint by betweenness\b/gi, 'place everything depends on (most of our shortest routes pass through it)'],
  [/\bchokepoints?\b/gi, 'place everything depends on'],
  [/\b(\d+) hops?\b/gi, '$1 steps'],
  [/\bmore hops\b/gi, 'more steps'],
]
export function plain(s: string) {
  return PLAIN.reduce((t, [re, w]) => t.replace(re, w), s)
}
