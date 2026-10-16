# API contract (locked Oct 16, day 2; all endpoints live)

Backend: FastAPI in `backend/promisegraph/api.py`, `http://localhost:8000`. Interactive docs at `/docs`.
The frontend dev server proxies `/api` to it, so the browser never needs CORS.

Status column: **live** = works today; **day 2** = being built now. Until a day-2 endpoint exists
(it returns 404), the frontend uses the fixture files described at the end.

All dates are ISO strings (`"2026-10-20"`). All money is USD numbers. Tenants: `northwind` (20k
orders, the demo company) and later a second, smaller one.

## Types (copy into `frontend/src/api/types.ts`)

```ts
export interface Health { falkordb: 'ok'; tenants: string[] }

export interface EventInfo {
  id: string; name: string; type: string;          // 'port_closure' | 'labour_action' | ...
  start: string; end: string; backlog_days: number;
  hubs: string[];                                   // hub ids it closes, e.g. ['SGSIN']
}

export interface ImpactRow {
  promise: string; order: string; shipment: string;
  delay_days: number;      // how late the last-mile shipment now runs
  hops: number;            // FEEDS hops from the shipment the event hit directly
  days_late: number;       // past the promised date
  penalty_usd: number;
  customer: string; city: string; tier: 'consumer' | 'plus' | 'business'; due_date: string;
}
export interface Impact { promises_at_risk: number; penalty_usd: number; rows: ImpactRow[] }

export interface Cluster {
  cluster: number; shipments: number;
  roots: string[];         // shipment ids hit directly; rescue these, save the cluster
  promises_at_risk: number; penalty_usd: number;
}

export interface Chokepoint { hub: string; name: string; kind: string; betweenness: number }

export interface Route { hubs: string[]; modes: string[]; days: number; usd_per_kg: number }

export interface Race {
  same_answer: boolean; promises_at_risk: number; depth: number;
  falkordb: { ms: number; query: string };
  postgres: { ms: number; query: string };
}

// ---- graph view (2D/3D) ---------------------------------------------------------------
export type NodeType = 'event' | 'hub' | 'shipment' | 'promise';
export interface GNode {
  id: string; type: NodeType; name: string;
  // event
  start?: string; end?: string;
  // hub
  kind?: string; country?: string; lat?: number; lon?: number; closed?: boolean;
  // shipment
  stage?: 'supply' | 'inbound' | 'transfer' | 'lastmile'; mode?: string;
  delay?: number; hops?: number; root?: boolean; eta?: string; description?: string;
  // promise
  customer?: string; city?: string; due_date?: string; days_late?: number; penalty_usd?: number;
}
export type LinkType = 'AFFECTS' | 'VIA' | 'FEEDS' | 'FULFILLS';
export interface GLink { source: string; target: string; type: LinkType; buffer_days?: number }
export interface Subgraph { nodes: GNode[]; links: GLink[]; truncated: boolean }

export interface PathStep { node: GNode; delay_days: number | null; text: string }
export interface PromisePath { promise: string; steps: PathStep[]; links: GLink[] }

// ---- agents and memory ----------------------------------------------------------------
export type AgentName = 'sentinel' | 'impact_analyst' | 'rerouter' | 'finance' | 'verifier' | 'comms';
export type DecisionStatus = 'info' | 'proposed' | 'verified' | 'blocked' | 'approved' | 'rejected';
export interface Decision {
  id: string; run_id: string; agent: AgentName;
  kind: string;            // 'alert' | 'impact' | 'reroute' | 'plan' | 'verification' | 'message' | 'recall'
  summary: string;         // one line, numbers already filled in
  explanation: string;     // 2-4 sentences (Gemini or template), never introduces new numbers
  status: DecisionStatus;
  requires_approval: boolean;
  numbers: Record<string, number | string>;   // the figures behind the summary, from Cypher
  evidence: string[];      // node ids (hub/shipment/promise) that justify it
  prev: string | null;     // previous decision in the handoff chain
  created_at: string;      // ISO datetime
  approved_by: string | null;
  explanation_source: 'template' | 'gemini';   // added: who wrote `explanation` (Gemini rewrites in the background)
}
export interface Recall {
  run_id: string; event_id: string; event_name: string; when: string;
  why_similar: string;     // e.g. 'same hub' | 'one lane away from Port of Singapore' | 'same kind of disruption'
  action: string; outcome: string; cost_usd: number; saved_usd: number;
  worked: boolean;         // added: false = a lesson (e.g. the Suez air-freight run)
}
export interface Playbook { id: string; trigger: string; action: string; uses: number; successes: number }
export interface Run {
  id: string; event_id: string;
  status: 'running' | 'awaiting_approval' | 'done' | 'failed';
  requested_by: string; created_at: string;
  decisions: Decision[];   // in handoff order
  recall: Recall[]; playbooks: Playbook[];
}
```

## Endpoints

| Method | Path | Returns | Status |
|---|---|---|---|
| GET | `/api/health` | `Health` | live |
| GET | `/api/{tenant}/events` | `EventInfo[]` | live |
| GET | `/api/{tenant}/events/{event_id}/impact?depth=8` | `Impact` (rows include customer/city/tier/due_date) | live |
| GET | `/api/{tenant}/events/{event_id}/clusters?depth=8` | `Cluster[]` | live |
| GET | `/api/{tenant}/chokepoints?k=10` | `Chokepoint[]` | live |
| GET | `/api/{tenant}/reroute?src=VNSGN&dst=DC-VNL&closed=SGSIN&by=days\|cost&k=3` | `Route[]` | live |
| GET | `/api/{tenant}/race/{event_id}?depth=8` | `Race` | live |
| GET | `/api/{tenant}/events/{event_id}/subgraph?depth=8&limit=1500` | `Subgraph` | live |
| GET | `/api/{tenant}/promises/{promise_id}/path?event_id=...` | `PromisePath` (event -> hub -> root -> ... -> promise) | live |
| POST | `/api/{tenant}/runs` body `{event_id, requested_by}` | `Run` (agents run until `awaiting_approval`; can take ~5-20 s) | live |
| GET | `/api/{tenant}/runs` | `Run[]` (newest first, decisions included) | live |
| GET | `/api/{tenant}/runs/{run_id}` | `Run` | live |
| POST | `/api/{tenant}/runs/{run_id}/decisions/{decision_id}/approve` body `{by}` | `Run` | live |
| POST | `/api/{tenant}/runs/{run_id}/decisions/{decision_id}/reject` body `{by}` | `Run` | live |
| GET | `/api/{tenant}/decisions/{decision_id}/evidence` | `Subgraph` (only the evidence nodes and links between them) | live |
| GET | `/api/{tenant}/memory/recall?event_id=...` | `{recall: Recall[], playbooks: Playbook[]}` | live |

Notes from implementation:
* Live events are `EV-SGSIN-1020` (Singapore, Oct 20-24) and `EV-USWC-1120` (LA / Long Beach, Nov 20-24).
  Historic events exist only for memory and are not listed by `/events`.
* `POST /runs` returns in ~0.2-3 s. Gemini rewrites explanations in the background over ~5-10 s:
  poll `GET /runs/{id}` for a few seconds after creating or approving a run.
* Approving runs the Comms agent; its `explanation` is a drafted customer message.

Errors: FastAPI style `{"detail": "..."}`. Approve returns **403** when `by` equals the run's
`requested_by` (policy gate: you cannot approve your own request) and **409** when the decision is
not `verified`. Unknown tenant: 404.

## Behaviour the UI must show

* **Engine scoreboard ("the switch")**: it is a race, not a mode. The product always runs on FalkorDB.
  The scoreboard calls `/race` with a depth slider (0-8), shows both timings, a same-answer badge, and
  the two query texts side by side. Optional data-size choice = tenant `bench` (100k orders) if present
  in `/api/health`.
* **Agent flow**: `POST /runs` -> decisions appear in order
  sentinel -> impact_analyst -> rerouter -> finance -> verifier -> (human approves the finance plan)
  -> comms. Approving needs a name different from `requested_by`.
* **Memory**: `Run.recall` shows what happened last time something similar hit ("Port Klang, Aug 2026:
  air-freighted 2 roots, saved $X"). That is the Track 2 story; give it a visible card.
* **Why?**: clicking a promise calls `/promises/{id}/path`; clicking a decision calls
  `/decisions/{id}/evidence`. Both return real graph paths, never text the UI makes up.

## Example payloads (real values from the 20k-order `northwind` data)

`GET /api/northwind/events/EV-SGSIN-1020/clusters` (first item):
```json
{"cluster": 14, "shipments": 398, "roots": ["OCN-00062"], "promises_at_risk": 210, "penalty_usd": 36756.0}
```

`GET /api/northwind/chokepoints?k=1`:
```json
[{"hub": "SGSIN", "name": "Port of Singapore", "kind": "port", "betweenness": 540.6}]
```

`GET /api/northwind/reroute?src=VNSGN&dst=DC-VNL&closed=SGSIN&by=cost&k=1`:
```json
[{"hubs": ["VNSGN","MYTPP","EGPSD","ESALG","NLRTM","DC-VNL"], "modes": ["ocean","ocean","ocean","ocean","rail"], "days": 25, "usd_per_kg": 0.39}]
```

Demo persona: customer **Aisha Rahman** (Liverpool), promise `PRM-000730`, 3 days late, 4 hops from the
Singapore closure.

## Fixtures for day-2 endpoints

Until an endpoint is live, the frontend reads `frontend/src/fixtures/<name>.json` (subgraph, path,
run, evidence, recall) shaped exactly like the types above. Delete the fallback once the backend
returns 200.
