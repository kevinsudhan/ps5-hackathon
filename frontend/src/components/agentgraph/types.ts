// GET /api/{tenant}/runs/{run_id}/graph (backend/promisegraph/runviz.py): the subgraph the agents
// wrote for one run. Kept here, next to the view that draws it.

export interface RGStep {
  id: string; agent: string; agent_name: string; kind: string; seq: number; summary: string
  status: string; requires_approval: boolean; numbers: Record<string, number | string>; ms: number | null
  memory_changed: boolean | null
  evidence: Record<string, number>   // label -> how many nodes this decision points at
  next: string | null
}
export interface RGPast {
  key: string; read_by: string; event_name: string; when: string; why_similar: string | null
  action: string; outcome: string; worked: boolean; cost_usd: number; saved_usd: number
  requested_by: string | null; approved_by: string | null
}
export interface RGPlaybook {
  key: string; name: string; trigger: string; action: string
  uses: number; successes: number; uses_before: number; successes_before: number
  realization: number | null; effect: 'changed' | 'checked' | null; read_by: string | null; followed: boolean
}
export interface RGCluster { n: number; shipments: number; promises_at_risk: number; penalty_usd: number; roots: number; rescued: boolean }
export interface RGRoute {
  key: string; option: string; what: string; from: string; to: string; via: string[]; air: boolean
  modes: string[]; days: number; cost_usd: number; residual_delay: number; weight_kg: number; chosen: boolean
}
export interface RGLink {
  from: string        // decision id
  to: string          // drawn node key: event, port, shipments, groups, routes, promises, past:*, pb:*, new-outcome
  kind: 'read' | 'wrote'
  rels: string[]      // graph relationship types behind it ('handoff' = read from the previous agent's decision)
  count: number; words: string[]
}
export interface RunGraph {
  run: { id: string; status: string; memory: string; created_at: string; requested_by: string }
  event: { id: string; name: string; type: string; start: string | null; end: string | null; backlog_days: number | null }
  closed: { id: string; name: string }[]
  steps: RGStep[]
  plan_status: string | null
  memory: { on: boolean; episodic: RGPast[]; procedural: RGPlaybook[] }
  world: {
    shipments_hit: number | null; roots: number | null; promises_at_risk: number | null; penalty_usd: number | null
    promises_saved: number | null; promises_after: number | null; messages: number | null
    clusters: RGCluster[]; routes: RGRoute[]
  }
  approval: { requested_by: string; approved_by: string | null; rejected_by: string | null; at: string | null }
  writeback: {
    messages: number | null; promises_saved: number | null; playbooks: string[]
    outcome: { key: string; summary: string; cost_usd: number; saved_usd: number; promises_saved: number; worked: boolean } | null
  } | null
  links: RGLink[]
  queries: { title: string; cypher: string }[]
}
