# UI contract v2: ask, engine switch, story (Oct 16)

The redesigned UI is built on these endpoints. The day-2 endpoints in `api-contract.md` still exist:
the Agents and Memory tabs keep using `/runs`, `/runs/{id}`, approve/reject and `/memory/recall`.

## The idea

The user types a question (or clicks a chip). The backend maps it to **one template from a whitelist**.
The LLM may pick the template and fill its slots; it never writes a query. Every template has a
Cypher version (FalkorDB) and a SQL version (Postgres, fully indexed), both parameterised and tested
to return the **same rows**. The engine switch picks which one answers. Each answer carries only its
own small subgraph for the 3D view, with plain-English "why" lines on every node and link.

Agents and memory run on FalkorDB only (Rule 3: the product must not work without it). When the
switch is on PostgreSQL, the Agents/Memory tabs say "Runs on FalkorDB (the graph is the agents'
memory)". They stay usable.

## Types

```ts
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
```

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{falkordb, tenants, companies}`: show only `companies` in the company picker (`bench` is benchmark-only) |
| GET | `/api/{tenant}/chips` | `Chip[]`: 6 suggestions, real values that return results |
| POST | `/api/{tenant}/ask` body `{question, engine}` | `Answer`; 422 `{detail, suggestions: Chip[]}` when the question does not fit any template |
| POST | `/api/{tenant}/compare` body `{question}` | `Comparison`: same question on both engines, back to back |
| GET | `/api/{tenant}/sweep?event_id=EV-SGSIN-1020` | `Sweep`: depth 2..8, real timings (median of 3 per point) for "orders at risk"; may take ~3-10 s. Call it on `bench` (100k orders) too when that tenant exists |
| GET | `/api/{tenant}/story?event_id=EV-SGSIN-1020` | `Story` |

## Templates (whitelist)

| id | Example question | Slots |
|---|---|---|
| `at_risk` | Which orders are at risk because Singapore closed? / Which Seattle orders are at risk? | event, optional city, depth (2-8, default 8) |
| `orders_window` | Show orders from Miami customers due between Dec 1 and Dec 7 | city, from date, to date |
| `why_late` | Why is Aisha Rahman's order late? | customer name, event |
| `rescue_first` | Which shipments should we rescue first? | event |
| `weak_points` | Which ports does everything depend on? | (none) |
| `reroute` | How do we get goods from Ho Chi Minh City to Venlo without Singapore? | from hub, to hub, avoid hub |

## UI behaviour the backend assumes

* Default screen: slim top bar (company, engine switch FalkorDB / PostgreSQL, Compare), one big 3D
  view of the current answer's graph, the answer sentence, a collapsible "How it was found"
  (query text, ms, chars/lines, engine), chips above a prompt box at the bottom.
* Agents, Memory and Benchmark (depth slider = `/sweep`) live behind tabs or a drawer.
* "Play the story" uses `/story`, then `POST /runs` for the agents step, then the run's `recall`.
