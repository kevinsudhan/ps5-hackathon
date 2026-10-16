# Benchmark notes (day 1, Oct 15)

Full numbers: [`day1.md`](day1.md) (machine-readable: `day1.json`). Reproduce with:

```
cd backend
python -m scripts.bench --sizes 5000 20000 100000 --supply-tiers 5 --runs 9 --tag day1
```

## How we keep the race fair

* Same synthetic data in both engines, from one deterministic generator.
* **Every result is checked identical** before a timing counts (`assert` in `bench.py`), and
  `scripts/parity.py` also checks both against a third, plain-Python reference implementation.
* Postgres gets every index its query plan wants, `ANALYZE` after loading, and a recursive CTE that
  prunes dead branches early (an optimisation the Cypher version does not get).
* **Postgres gets its graph extension too.** The Postgres image ships pgRouting 3.8 (on Postgres
  16.9). Clusters race `pgr_connectedComponents` (the closest thing to `algo.WCC`), chokepoints race
  `pgr_betweennessCentrality`, reroutes race `pgr_KSP`. pgRouting wants integer vertex ids, so hubs and
  shipments are numbered in id order and the edge list is passed inline as arrays (for clusters that
  was ~2.5x faster than a temp table for pgRouting to read).
* **Same question, not just same algorithm name.** Before racing Q4 and Q5 we checked what each
  engine actually computes (below) and made the two sides answer the same thing.
* Both drivers use C protocol parsers (psycopg-binary; hiredis for FalkorDB).
* We report **wall time** (end to end into Python) and, for the cascade, **server time** (FalkorDB
  `run_time_ms`, Postgres `EXPLAIN ANALYZE` execution time).
* Both run in Docker on the same laptop with default configs. Cascade: medians of 9 after 2 warm-ups.
  Clusters: WCC and pgRouting alternate, medians of 9 after 1 warm-up; the recursive SQL runs 3
  times on its own afterwards (it takes ~50 s per run at 100k orders). Chokepoints: the three versions
  alternate, medians of 9 after 2 warm-ups. Reroutes: per-query medians of 9 after 1 warm-up (3 runs
  for the uncapped variant), summed over every query the event needs.

**Fixed Oct 15:** the clusters race used to compare WCC only against hand-written recursive SQL.
With pgRouting added as a third column, **Postgres wins that race** (below). All three return
identical clusters: same sizes, root shipments, promises at risk and penalty; the two Postgres
versions also agree on every cluster label and member.

**Fixed Oct 15, later:** Q4 chokepoints and Q5 reroutes are now raced against pgRouting too, with
parity asserted. What we had to match first:

* **Q4, betweenness.** We compared FalkorDB against an exact Brandes implementation in Python.
  `algo.betweenness` over `Hub`/`LANE` is **directed, unweighted (hop count) and unnormalised**. By
  default it **samples 32 source hubs** (`samplingSize`, documented default 32), so with 121 hubs our
  shipped query is an approximation: it gets 9 of the true top 10, in a different order (USLAX in,
  Tanjung Pelepas out). With `samplingSize` >= hub count it matches exact Brandes to 0.0.
  `pgr_betweennessCentrality` is also directed and ignores edge cost, but returns scores divided by
  (n-1)(n-2); the baseline multiplies that back. Parity: every hub's score equal (relative 1e-6),
  same top 10. The race times the exact FalkorDB query against pgRouting, and shows the shipped
  (sampled) query as a separate column.
* **Q5, k shortest paths.** We compared `algo.SPpaths` against exhaustive enumeration of every simple
  path. With `pathCount: 20, maxLen: 7` it returns exactly the 20 lightest simple paths of **at most 7
  lanes**, lightest first. The product then drops paths through closed hubs and keeps the 3 lightest.
  `pgr_KSP` (Yen's algorithm) returns the K lightest simple paths with **no hop limit**, so its top 20
  includes 8-12-lane paths that SPpaths leaves out. The baseline (`pg_store.reroute_pgr`) keeps
  paths of at most 7 lanes and doubles K until it has 20 of them (or KSP runs out of paths); that is
  provably the same candidate set. Then the same closed-hub filter and top 3, in SQL.
* **Ties.** Lane days are whole numbers, so many routes tie. Neither engine defines which of the tied
  routes it returns. Parity therefore asserts the same weights in the same order, the same routes
  wherever the weight is not tied at the cut-off, and that every route either engine returns is a real
  simple lane path avoiding the closed hub with the stated days and cost (checked against the lane
  table). Tied routes the engines picked differently are counted in the table (0 / 1 / 7 by size).
* **The uncapped question.** To show what pgRouting is good at, the bench also races plain k shortest
  paths (SPpaths without `maxLen`, `pgr_KSP` with K = 20), same parity checks.

**Run-to-run noise:** this run (after adding Q4/Q5) came out slower than the earlier day 1 run on
the FalkorDB side of Q1 and Q3 (for example clusters at 5k orders: 29.6 ms before, 57.1 ms now; a
smoke run an hour earlier gave 28.8 ms). Other dev servers and sessions were running on the laptop.
The ratios held: pgRouting beat WCC by 1.6-2.5x before and 2.0-2.5x now. Treat any single number,
especially at 100k, as rough. The lane graph is the same 121 hubs and 299 lanes at every size, so
Q4 and Q5 do not grow with orders; Q5 only gets more queries (more shipments hit).

## What the numbers say (honest summary)

* **Cascade (Q1)**: FalkorDB's engine is 1.4-3.2x faster from 20k orders up at 2+ hops (20k:
  1.4-2.6x; 100k: 1.6-3.2x). End to end, the Python driver eats that lead at 20k orders: Postgres was
  ahead at 5-7 hops in this run (7 hops: 53 ms vs 42 ms; the previous run had them level, 36 vs 38).
  At 100k FalkorDB is 1.0-1.7x faster end to end. At 5k orders and 5-6 hops Postgres is ahead
  (end to end ~9.5 ms vs ~16 ms). **Not a 10x story; do not sell it as one.**
* **Clusters (Q3)**: **Postgres + pgRouting is faster than our FalkorDB version**: 28 ms vs 57 ms at
  5k orders, 54 ms vs 135 ms at 20k (2.5x), 201 ms vs 410 ms at 100k (2.0x). FalkorDB only wins big
  against plain recursive SQL (28x at 20k, 124x at 100k), which is not the baseline a fair judge
  would pick. Why FalkorDB loses: `algo.WCC` itself takes ~5 ms. Most of our time is the round
  trips around it. At 100k (measured separately, medians of 7, total ~300 ms): the impacted-shipments
  query ~100 ms, clearing last run's `:Impacted` tags ~55 ms, tagging 8,068 shipments ~105 ms, then
  WCC plus the promise lookups ~27 ms. Postgres does all of it in one statement.
* **Chokepoints (Q4)**: **level.** Exact betweenness takes 3.6-3.9 ms in FalkorDB and 3.5-4.6 ms
  in pgRouting (0.97-1.17x). The shipped, sampled FalkorDB query takes 2.1-2.9 ms but is approximate.
* **Reroutes (Q5)**: two answers, and both matter.
  * *The product's question* (routes of at most 7 lanes): FalkorDB 35 / 59 / 154 ms for all 6 / 12 /
    26 queries the event needs, pgRouting 66 / 75 / 173 ms (1.1-1.9x). Per query they are about level
    (4-6 ms). FalkorDB's edge comes from `maxLen`: the baseline needed K = 80 for the worst pairs here.
    In a separate probe over other hub pairs, `pgr_KSP` with K = 5,120 (16-26 s) still had not found 20
    paths of at most 7 lanes (SUP-KCH to ZN-FRA, SUP-CHN to DC-SEA by days, APT-DXB to ZN-AUS by
    cost), because thousands of lighter long paths come first. SPpaths answers those in 4-11 ms.
  * *Plain k shortest paths* (no lane cap): **pgRouting is 11-21x faster** per query (~5 ms vs
    52-104 ms), and FalkorDB hit its 1 s server timeout on 11 of 44 queries. Yen's algorithm is the
    right tool for that; SPpaths without `maxLen` is not.

So the pitch is: **multi-hop answers in one readable query, graph algorithms as one-line tools for
agents, and exact parity with a tuned SQL baseline**, not "graphs are always faster". **Do not
claim FalkorDB wins the clusters race: once Postgres has pgRouting, it does not.** On chokepoints it
is a tie; on reroutes FalkorDB wins only the hop-capped question the product asks.

## FalkorDB findings while tuning (worth a blog post)

1. **Multi-type traversals are slow here.** `(:Hub)<-[:FROM|TO]-(:Leg)` took ~21 ms on 20k orders;
   `<-[:TO]-` and `<-[:FROM]-` separately took 0.35 ms and 0.47 ms. We use two single-type pattern
   comprehensions instead.
2. **Engine bug A (minimal repro Oct 16).** A node that comes out of an aggregation
   (`WITH s0, count(*)` or `max(...)`) after a collect/UNWIND + MATCH has **no relationships**: one
   hop from it returns 0 rows, and `[:FEEDS*0..n]` returns only the zero-length path. (Earlier we
   thought single hops still worked; the minimal repro shows they do not.) `WITH DISTINCT s0`, or an
   extra `WITH s0` after the aggregation, gives the right rows. Re-binding with
   `MATCH (s1) WHERE ID(s1) = sid` right after the aggregation fails differently: the planner keeps
   only a `NodeByIdSeek` and errors with `Variable sid not found` (our product query re-binds in a
   shape that plans correctly). Our parity check caught it: 0 rows instead of 1,240.
   Repro: `python -m scripts.repro_falkordb`; issue text: [`docs/falkordb-bug-report.md`](../docs/falkordb-bug-report.md).
3. **Planner direction inside Apply.** After `CALL algo.WCC(...) YIELD node`, a single
   `OPTIONAL MATCH (node)<-[:FULFILLED_BY]-(:Order)-[:HAS_PROMISE]->(pr:Promise)` started from the
   unbound `pr` side and timed out (>60 s). Two separate `OPTIONAL MATCH`es: ~5 ms.
4. **Driver overhead matters.** Without `hiredis`, redis-py parsed replies in pure Python and
   added ~35 ms to a 1,567-row result. With it: ~11 ms.
5. **WCC is fast; getting the subgraph to WCC is not.** `algo.WCC` only filters by label and
   relationship type, so to run it on "impacted shipments" we write an `:Impacted` label onto them
   first (and clear the old one). Those writes are over half of our clusters time at 100k orders,
   and are why pgRouting, which takes any edge list as SQL, wins Q3.
6. **`algo.betweenness` samples by default** (fixed in the product Oct 16: `CHOKEPOINTS` now passes `samplingSize: 100000`, so it is exact). 32 source nodes unless you pass `samplingSize`, and the
   docs say results may vary between runs without `samplingSeed` (ours came back identical every
   time). On a small graph, pass `samplingSize` >= node count to get exact scores.
7. **`algo.SPpaths` needs `maxLen`.** With it, the 20 lightest paths of at most 7 lanes take ~3-6 ms.
   Without it, the same call took 20-900 ms and often hit the 1 s timeout on a 121-node graph.
   The hop cap is also the one thing `pgr_KSP` cannot express.
8. **Engine bug B (found Oct 16, minimal repro the same day).** `MATCH (s0:S) WHERE s0.id = 'a'
   MATCH (s0)-[:FEEDS*0..3]->(x)<-[:FOR]-(o) RETURN x.id` returns **0 rows**: the plan has no
   operation that binds `s0` (it starts from `o` and runs an Expand Into with `s0` unbound). Inline
   `{id: 'a'}`, a `WITH s0` barrier, or the `WHERE` inside the same MATCH all work. In the product
   this hid Aisha Rahman's 5-step chain (Postgres returned it, FalkorDB returned none); the fix in
   `questions.WHY_CYPHER` is a `WITH` barrier. Same repro script and issue text as finding 2.
9. **A read on a deleted graph re-creates it.** `GRAPH.QUERY` against a graph deleted a moment ago
   creates a new empty graph with that name. Our health check did that to the test graph. Use
   `GRAPH.RO_QUERY` (falkordb-py `ro_query`) for existence-style reads; it errors instead.

## Product notes found while racing

* ~~The shipped Q4 is the sampled approximation.~~ Fixed Oct 16: `CHOKEPOINTS` passes
  `samplingSize: 100000`, so Sentinel's "number N chokepoint" rank is exact.
* `maxLen: 7` means some hub pairs have no reroute at all (Hamburg to the Seattle zone needs at
  least 8 lanes). None of this event's pairs are affected.

## Prompt box: depth sweep for "orders at risk" (Oct 16, 20k orders, API `/sweep`)

Same rows on both engines at every depth. Medians of 3 after a warm-up, measured inside the API.
This question also names the root shipment for every order, so the SQL walk carries the root
through its recursion; that is part of why Postgres slows more from step 4, where the deep supply
chains start.

| steps | late orders | FalkorDB | Postgres |
|---:|---:|---:|---:|
| 2 | 471 | 19 ms | 25 ms |
| 3 | 471 | 19 ms | 24 ms |
| 4 | 737 | 30 ms | 96 ms |
| 5 | 755 | 30 ms | 103 ms |
| 6 | 755 | 29 ms | 98 ms |
| 7 | 755 | 30 ms | 98 ms |
| 8 | 755 | 32 ms | 102 ms |

