// Copied verbatim from docs/api-contract.md (locked Oct 16). Do not edit here first:
// change the contract, then copy it again.

export interface Health { falkordb: 'ok'; tenants: string[]; companies?: string[] }   // companies: v2

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
}
export interface Recall {
  run_id: string; event_id: string; event_name: string; when: string;
  why_similar: string;     // e.g. 'same hub' | 'one lane away from Port of Singapore' | 'same kind of disruption'
  action: string; outcome: string; cost_usd: number; saved_usd: number;
}
export interface Playbook { id: string; trigger: string; action: string; uses: number; successes: number }
export interface Run {
  id: string; event_id: string;
  status: 'running' | 'awaiting_approval' | 'done' | 'failed';
  requested_by: string; created_at: string;
  decisions: Decision[];   // in handoff order
  recall: Recall[]; playbooks: Playbook[];
}

// ---- UI contract v2 (docs/ui-contract.md, Oct 16): ask, engine switch, story ----------------
export type Engine = 'falkordb' | 'postgres';
export type Tone = 'neutral' | 'warning' | 'danger' | 'good' | 'muted';
export type NodeKind = 'event' | 'port' | 'airport' | 'place' | 'warehouse' | 'factory' | 'shipment'
                     | 'order' | 'group';

export interface AskNode {
  id: string;
  kind: NodeKind;        // shape
  label: string;         // short, plain English, e.g. "Port of Singapore", "Aisha Rahman's order"
  tone: Tone;            // colour: danger = broken / closed, warning = delayed, good = fine / rescued
  size: number;          // 1 = normal; bigger for hubs and groups (relative)
  why: string[];         // 2-3 plain lines shown when clicked
  step?: number;         // supply-chain steps from the disruption (0 = the closed port); used by the story
}
export interface AskLink {
  source: string; target: string;
  label?: string;        // e.g. "4 steps", "by sea, 13 days"
  tone: Tone;
  why: string[];         // 2-3 plain lines shown when clicked
}
export interface AskGraph { nodes: AskNode[]; links: AskLink[]; truncated: boolean; note?: string }

export interface QueryInfo {
  engine: Engine;
  text: string;          // the exact query that ran (parameters shown separately)
  params: Record<string, unknown>;
  chars: number; lines: number;
  ms: number;            // measured wall time of that query on the server, never estimated
}

export interface Answer {
  template: string;      // e.g. 'at_risk'
  title: string;         // "Orders at risk"
  read_as: string;       // how the question was understood: "Orders at risk because Singapore terminals shut (Oct 20-24)"
  answer: string;        // ONE plain sentence, numbers from the rows
  columns: string[];
  rows: (string | number | null)[][];   // first 200 rows
  row_count: number;
  graph: AskGraph;
  query: QueryInfo;
  understood_by: 'gemini' | 'keywords';
}

export interface Comparison {
  same_answer: boolean;  // rows compared exactly
  row_count: number;
  falkordb: QueryInfo; postgres: QueryInfo;
}

export interface SweepPoint { depth: number; same_answer: boolean; row_count: number;
                              falkordb_ms: number; postgres_ms: number }
export interface Sweep { event_id: string; tenant: string; runs_per_point: number; points: SweepPoint[] }

export interface Chip { label: string; question: string }

export interface Story {
  event: { id: string; name: string; start: string; end: string };
  graph: AskGraph;       // port, root shipments, the steps in between (capped), broken orders (capped); node.step set
  persona: { node_id: string; path: string[]; caption: string };   // the one order the camera flies to
  captions: { closes: string; spreads: string; breaks: string; agents: string; memory: string };
}
