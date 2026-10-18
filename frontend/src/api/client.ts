// Typed client for docs/api-contract.md (runs, memory) and docs/ui-contract.md (ask, compare,
// sweep, chips, story).
//
// Every call returns Loaded<T>: the data plus where it came from. The v2 endpoints fall back to
// src/fixtures/*.json only while the route itself does not exist yet (FastAPI's bare 404
// "Not Found"); any other error is shown as an error. Fixtures only cover northwind / Singapore.

import type {
  Answer, Chip, Cluster, Comparison, Decision, Engine, EventInfo, Health, MemoryComparison, MemoryInfluence, Playbook,
  Recall, Run, RunEvent, Story, Sweep,
} from './types'
import chipsUrl from '../fixtures/chips.json?url'
import askFkUrl from '../fixtures/ask-at_risk-falkordb.json?url'
import askPgUrl from '../fixtures/ask-at_risk-postgres.json?url'
import compareUrl from '../fixtures/compare.json?url'
import sweepUrl from '../fixtures/sweep.json?url'
import storyUrl from '../fixtures/story.json?url'

export type Source = 'live' | 'fixture'
export interface Loaded<T> { data: T; source: Source }

export class ApiError extends Error {
  status: number
  detail: string
  body: unknown
  constructor(status: number, detail: string, body: unknown) {
    super(detail)
    this.status = status
    this.detail = detail
    this.body = body
  }
  /** The route is not built yet, as opposed to "unknown tenant" or "unknown promise". */
  get routeMissing() { return this.status === 404 && this.detail === 'Not Found' }
}

/** POST /ask could not map the question to a template; `suggestions` are questions that work. */
export class AskRejected extends Error {
  suggestions: Chip[]
  constructor(detail: string, suggestions: Chip[]) {
    super(detail)
    this.suggestions = suggestions
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = res.statusText
    let json: unknown = null
    try {
      json = await res.json()
      const d = (json as { detail?: unknown }).detail
      detail = typeof d === 'string' ? d : JSON.stringify(d)
    } catch { /* not JSON */ }
    throw new ApiError(res.status, detail, json)
  }
  return res.json() as Promise<T>
}

const fixtureCache = new Map<string, Promise<unknown>>()
function fixture<T>(url: string): Promise<T> {
  if (!fixtureCache.has(url)) {
    fixtureCache.set(url, fetch(url).then(r => {
      if (!r.ok) throw new Error(`fixture ${url}: ${r.status}`)
      return r.json()
    }))
  }
  return fixtureCache.get(url)!.then(v => structuredClone(v) as T)
}

async function withFallback<T>(call: () => Promise<T>, fallback: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { data: await call(), source: 'live' }
  } catch (e) {
    if (e instanceof ApiError && e.routeMissing) return { data: await fallback(), source: 'fixture' }
    throw e
  }
}

const live = async <T,>(p: Promise<T>): Promise<Loaded<T>> => ({ data: await p, source: 'live' })
const enc = encodeURIComponent
const base = (tenant: string) => `/api/${enc(tenant)}`
const FIXTURE_TENANT = 'northwind'
const noFixture = (what: string) => new Error(`${what} is not available yet for this company.`)

// ---- basics ---------------------------------------------------------------------------------

export const getHealth = () => live(request<Health>('GET', '/api/health'))
export const getEvents = (tenant: string) => live(request<EventInfo[]>('GET', `${base(tenant)}/events`))

// ---- v2: ask, compare, sweep, chips, story --------------------------------------------------

export function getChips(tenant: string, eventId?: string | null) {
  const q = eventId ? `?event_id=${enc(eventId)}` : ''
  return withFallback(() => request<Chip[]>('GET', `${base(tenant)}/chips${q}`), () => fixture<Chip[]>(chipsUrl))
}

export async function ask(tenant: string, question: string, engine: Engine, signal?: AbortSignal): Promise<Loaded<Answer>> {
  try {
    return await withFallback(
      () => request<Answer>('POST', `${base(tenant)}/ask`, { question, engine }, signal),
      async () => {
        // Fixture mode only knows "orders at risk"; anything else behaves like a 422.
        if (tenant === FIXTURE_TENANT && /risk|late|singapore|closed|break/i.test(question)) {
          return fixture<Answer>(engine === 'falkordb' ? askFkUrl : askPgUrl)
        }
        throw new AskRejected("I can't answer that one yet.", await fixture<Chip[]>(chipsUrl))
      },
    )
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) {
      const s = (e.body as { suggestions?: Chip[] } | null)?.suggestions
      throw new AskRejected(e.detail, Array.isArray(s) ? s : [])
    }
    throw e
  }
}

export function compare(tenant: string, question: string) {
  return withFallback(
    () => request<Comparison>('POST', `${base(tenant)}/compare`, { question }),
    async () => {
      if (tenant !== FIXTURE_TENANT) throw noFixture('Compare')
      return fixture<Comparison>(compareUrl)
    },
  )
}

export function getSweep(tenant: string, eventId: string, signal?: AbortSignal) {
  return withFallback(
    () => request<Sweep>('GET', `${base(tenant)}/sweep?event_id=${enc(eventId)}`, undefined, signal),
    async () => {
      if (tenant !== FIXTURE_TENANT) throw noFixture('The benchmark')
      return fixture<Sweep>(sweepUrl)
    },
  )
}

export function getStory(tenant: string, eventId: string) {
  return withFallback(
    () => request<Story>('GET', `${base(tenant)}/story?event_id=${enc(eventId)}`),
    async () => {
      if (tenant !== FIXTURE_TENANT) throw noFixture('The story')
      return fixture<Story>(storyUrl)
    },
  )
}

// ---- agents and memory (api-contract.md; FalkorDB only) --------------------------------------

export const createRun = (tenant: string, eventId: string, requestedBy: string, opts: { live?: boolean } = {}) =>
  live(request<Run>('POST', `${base(tenant)}/runs`, { event_id: eventId, requested_by: requestedBy, live: !!opts.live }))

/**
 * Follow a run as the agents work (server-sent events). Calls onEvent for every step that starts or
 * finishes and once more at the end; returns a function that stops listening.
 */
export function streamRun(tenant: string, runId: string, onEvent: (e: RunEvent) => void, onError: (msg: string) => void) {
  const es = new EventSource(`${base(tenant)}/runs/${enc(runId)}/stream`)
  let ended = false
  const handle = (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as RunEvent
      if (data.type === 'end') { ended = true; es.close() }
      onEvent(data)
    } catch { /* ignore a malformed frame */ }
  }
  es.addEventListener('step', handle as EventListener)
  es.addEventListener('end', handle as EventListener)
  es.onerror = () => { if (!ended) { es.close(); onError('Lost the live feed from the agents.') } }
  return () => { ended = true; es.close() }
}
export const getInfluence = (tenant: string, runId: string) =>
  live(request<MemoryInfluence>('GET', `${base(tenant)}/runs/${enc(runId)}/memory-influence`))
export const compareMemory = (tenant: string, runId: string) =>
  live(request<MemoryComparison>('POST', `${base(tenant)}/runs/${enc(runId)}/without-memory`))
export const getClusters = (tenant: string, eventId: string) =>
  live(request<Cluster[]>('GET', `${base(tenant)}/events/${enc(eventId)}/clusters?depth=8`))
export const getRun = (tenant: string, runId: string) => live(request<Run>('GET', `${base(tenant)}/runs/${enc(runId)}`))
export const listRuns = (tenant: string) => live(request<Run[]>('GET', `${base(tenant)}/runs`))
export const approveDecision = (tenant: string, run: Run, d: Decision, by: string) =>
  live(request<Run>('POST', `${base(tenant)}/runs/${enc(run.id)}/decisions/${enc(d.id)}/approve`, { by }))
export const rejectDecision = (tenant: string, run: Run, d: Decision, by: string) =>
  live(request<Run>('POST', `${base(tenant)}/runs/${enc(run.id)}/decisions/${enc(d.id)}/reject`, { by }))
export const getRecall = (tenant: string, eventId: string) =>
  live(request<{ recall: Recall[]; playbooks: Playbook[] }>('GET', `${base(tenant)}/memory/recall?event_id=${enc(eventId)}`))

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return "You can't approve your own request. Ask someone else to approve it."
    if (e.status === 409) return 'This step has already been decided, or is not ready for a decision yet.'
    if (e.status === 404) return 'That is no longer there (the demo data may have been reset).'
    return `Something went wrong (${e.status}): ${e.detail}`
  }
  if (e instanceof DOMException && e.name === 'AbortError') return ''
  if (e instanceof TypeError) return 'Cannot reach the server. Is the backend running on port 8000?'
  return e instanceof Error ? e.message : String(e)
}
