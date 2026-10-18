# UI contract v2: ask, engine switch, story (Oct 16; answer graphs reshaped Oct 17)

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
  // added Oct 17 (optional, additive): the figures the picture is ranked and sized by, all from the rows
  rank?: number;         // 1 = first in a ranked answer (costliest order, rescue #1, step 1 of a chain, route option)
  metric?: { value: number; unit: 'usd' | 'orders' | 'days' | 'score'; label: string }
  count?: number;        // a group node: how many orders it stands for
  blocked?: boolean;     // the closed place in a reroute, drawn as blocked
}
export interface AskLink {
  source: string; target: string;
  label?: string;        // e.g. "4 steps", "by sea, 13 days"
  tone: Tone;
  why: string[];         // 2-3 plain lines shown when clicked
  // added Oct 17 (optional, additive)
  weight?: number;       // 0..1, share of the answer's impact carried by this link (line thickness)
  blocked?: boolean;     // the closed way (drawn dashed)
  route?: number;        // reroute: which option (1 = fastest) a leg belongs to
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
| GET | `/api/{tenant}/chips?event_id=` | `Chip[]`: up to 7 suggestions, real values that return results. With `event_id` (optional, added Oct 17) the questions name that disruption; without it, Singapore |
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
| `top_loss_orders` (Oct 17) | Show the 10 most loss-inducing orders / top 5 costliest late orders | event, n (1-50, default 10; words like "ten" work), depth |

`top_loss_orders` is the head of `at_risk`: the same Cypher and SQL with `ORDER BY fee DESC, promise
ASC LIMIT $n`, tested for identical rows on both engines and for matching the first n rows of
`at_risk` (`tests/test_questions.py`).

## Answer graphs (Oct 17)

Each template's graph holds only the entities that answer the question, at most ~20 nodes (top-N
answers hold exactly their N orders), ranked and sized by figures from the rows:

| Template | Shape |
|---|---|
| `at_risk` | disruption -> closed port(s) -> stuck shipments ranked by late fees -> their group of late orders (the persona's order kept) |
| `orders_window` | warehouses -> on-time / late groups -> the city |
| `why_late` | one chain: disruption -> port -> each shipment step (days late added there) -> the order |
| `rescue_first` | port -> stuck shipments -> rescue groups ranked #1.. by fees |
| `weak_points` | the busiest hubs ranked by shortest routes through them, with the lanes between them |
| `reroute` | from -> each option's stops (tagged Fastest / Cheapest / Option N) -> to; the closed hub blocked |
| `top_loss_orders` | disruption -> port -> shipments -> the N costliest orders, ranked |

The UI folds what does not fit (identical-looking siblings into one "3 shipments" card, more than six
pieces into "+N more", above ~25 nodes the weakest leaves); every fold expands on click.

## UI behaviour the backend assumes

* Top bar: logo, company, engine switch FalkorDB (primary) / PostgreSQL, Benchmark, Memory,
  "Play the 30-second story". The engine switch only changes who answers questions; agents and
  memory always run on FalkorDB.
* Landing: no graph. "What happened" (the disruption, its dates, four figures), a centred ask box with
  chips (`/chips?event_id=`).
* After a question: the answer sentence, then a 2D (or 3D) graph of only the answering entities, then
  a one-line "How it was found" (engine, ms, query size; expands to the steps, the exact query with a
  Copy button and the first rows) with Compare engines (`/compare`). The ask box docks at the bottom.
* Right panel: "What the agents recommend" (live timeline, recommendation, approval) and "What we
  learned" (memory influence, with vs without memory).
* Benchmark (`/sweep`) and Memory (`/memory/recall`) open in a drawer.
* "Play the story" uses `/story`, then `POST /runs` for the agents step, then the run's `recall`.
