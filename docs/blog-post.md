<!-- Draft for the Graph Hacks "best blog post" prize. Team Araxys: edit it into your own voice before
     posting (dev.to / Hashnode / Medium), add the repo link and the demo video, then link the post in the README. -->

# We raced FalkorDB against a tuned Postgres. Postgres won some of it.

*Team Araxys, Graph Hacks (WeMakeDevs x FalkorDB), October 2026*

When you build a graph database project for a graph database hackathon, the easy blog post writes
itself: "graphs are 10x faster than SQL, here's a chart". We wanted to write that post. Then we
gave Postgres the same indexes, the same data and its own graph extension, and checked that both
sides returned the same rows before timing anything. The chart got less exciting and a lot more
useful. This is what we found.

## What we built

Promise Graph treats every customer order as a promise with a due date and a late fee. Orders are
fulfilled by shipments, shipments feed other shipments (a container of radio modules has to reach the
PCB factory before the boards can ship to the device assembler), and every shipment moves over lanes
between real ports and airports. All the companies, customers and orders are synthetic.

When a port closes, the question is: which promises just broke, by how many days, and which few
shipments should we pay to rescue? In our demo, Singapore shuts for five days and 755 of Northwind
Retail's 20,000 orders end up late, worth $114,065 in late fees. Aisha Rahman's parcel to Liverpool is
one of them: the delay starts at a radio-module shipment stuck in Singapore and travels four steps
down the supply chain before it reaches her.

Six agents work through each disruption (spot it, measure it, find routes around it, price the
rescue, verify the numbers, then write to customers once a person approves), and they hand off by
writing `Decision` nodes into the same FalkorDB graph. That graph is also their memory: the next time
a port near Singapore closes, they recall that air-freighting containers during a Suez convoy
suspension cost $96,000 to save $41,000, and they don't propose it again.

The core query is a cascade: start at the shipments that touch the closed port, follow
`FEEDS` relationships up to eight steps, carry the delay along the path minus each step's buffer, and
collect the promises at the end. In Cypher that is a variable-length match and a `reduce()` over the
relationships. In SQL it's a recursive CTE.

## The rules we set for the race

These are the things that made the difference between a fair race and a marketing chart:

* **Same data, same answer, or the timing doesn't count.** One deterministic generator loads both
  engines. The benchmark asserts identical results before recording a time, and a separate parity
  script checks both engines against a third, plain-Python implementation.
* **Postgres gets everything its plans want.** Every join and filter column indexed, `ANALYZE` after
  loading, and a recursive CTE that prunes dead branches early, an optimisation our Cypher version
  doesn't get.
* **Postgres gets its graph extension too.** pgRouting 3.8: `pgr_connectedComponents` against
  `algo.WCC`, `pgr_betweennessCentrality` against `algo.betweenness`, `pgr_KSP` against
  `algo.SPpaths`.
* **Same question, not just the same algorithm name.** Before timing two algorithms we checked what
  each one actually computes. That step found most of the surprises below.
* **Report engine time and end-to-end time.** The engine time is what the database spent; end to end
  is what our Python code waited for. They tell different stories.

## The results

Laptop, both engines in Docker, Singapore closed for five days, supply chains up to seven `FEEDS`
steps deep.

| Question | 20k orders | 100k orders |
|---|---|---|
| Cascade, 7 steps, engine time | FalkorDB 26 ms, Postgres 45 ms | 111 ms vs 220 ms |
| Cascade, 7 steps, end to end | 53 ms vs 42 ms (**Postgres faster**) | 196 ms vs 277 ms |
| Stranded clusters vs Postgres + pgRouting | 135 ms vs 54 ms (**Postgres 2.5x**) | 410 ms vs 201 ms (**Postgres 2x**) |
| Chokepoints, exact betweenness | 3.6 ms vs 3.5 ms | 3.8 ms vs 4.2 ms |
| Reroutes of at most 7 lanes, every query the event needs | 59 ms vs 75 ms | 154 ms vs 173 ms |
| Plain k shortest paths, per query | 52 ms vs 4.8 ms (**pgRouting 11x**) | 104 ms vs 4.8 ms (**21x**) |

If we had only raced the clusters query against hand-written recursive SQL, we could have claimed
FalkorDB was 28x faster at 20k orders and 124x at 100k. Both numbers are real. Neither is the baseline
anyone running Postgres in production would pick, so we don't lead with them.

## What surprised us

**`algo.WCC` takes about 5 ms. Our clusters query takes 135.** WCC only filters by label and
relationship type, so to run it on "the shipments this disruption touches" we first write an
`:Impacted` label onto them and clear last run's labels. At 100k orders that's ~100 ms to find the
shipments, ~55 ms to clear old tags and ~105 ms to tag 8,068 new ones, then ~27 ms for WCC and the
promise lookups. pgRouting takes any edge list you can express in SQL, so Postgres does all of it in
one statement. If FalkorDB's algorithms could take a subgraph from a query instead of a label, this
race would look very different.

**The hop cap is the whole reroute story.** `algo.SPpaths` with `maxLen: 7` returns the 20 lightest
routes of at most seven lanes in 3-6 ms, and that is exactly what the product asks, since nobody books
a twelve-lane reroute. `pgr_KSP` has no hop limit, so to get the same answer the baseline keeps
doubling K until twenty short paths turn up. For some hub pairs, K = 5,120 ran 16-26 seconds without
finding them, because thousands of lighter long paths come first. Remove the cap and the picture
flips: Yen's algorithm in pgRouting is 11-21x faster, and SPpaths without `maxLen` hit our one-second
timeout on 11 of 44 queries.

**`algo.betweenness` samples by default.** Without `samplingSize` it uses 32 source nodes. With 121
hubs that gave us 9 of the true top 10 chokepoints, in a different order. Passing a sampling size at
least as large as the node count made it match an exact Brandes implementation to the last decimal,
for 1-2 ms more. Our Sentinel agent now uses the exact version, because "Singapore is our number 1
chokepoint" should not depend on a random sample.

**The driver can eat the engine's lead.** At 20k orders FalkorDB's engine runs the cascade 1.7x
faster, and the end-to-end time is still slower than Postgres. Without `hiredis`, redis-py parsed
replies in pure Python and added ~35 ms to a 1,567-row result; with it, ~11 ms. If you only measure
inside the database, you are measuring something your users never see.

**Two relationship types cost more than two queries.** `(:Hub)<-[:FROM|TO]-(:Leg)` took ~21 ms;
the same thing as two single-type pattern comprehensions took 0.35 ms and 0.47 ms.

## Parity tests found two engine bugs

Twice, a FalkorDB query returned **zero rows** while Postgres and the Python reference returned the
right answer, with no error.

The first: a node that comes out of an aggregation after a `collect`/`UNWIND` has no relationships,
so one hop from it returns nothing (0 rows instead of 1,240 in our cascade). The second dropped a
`WHERE` on the start node before a variable-length path followed by another hop, which hid Aisha's
five-step chain completely. Both have simple workarounds (`WITH DISTINCT`, or a `WITH` barrier between
the two `MATCH` clauses), and we cut both down to a six-node graph and a one-command repro. The second
turned out to be a known issue with a fix already in review upstream. The first is new.

Without a third implementation to compare against, we would have shipped a demo that said fewer
orders were at risk than really were. That's the strongest argument we have for parity tests in any
benchmark: they are bug detectors as much as fairness checks.

## Where the graph did earn its place

The depth sweep is where it showed. Asking "which orders are at risk?" while following the delay 2
to 8 steps, FalkorDB stays flat at 19-32 ms. Postgres is close behind at two and three steps (24-25 ms),
then jumps to ~100 ms at step four, which is where the deep supply chains start, and stays there. Both
return the same rows at every depth: 471 late orders at two steps, 755 from five on.

The query itself is the other half. The Cypher for that answer is 21 lines; its SQL twin is 41,
with the root shipment threaded through the recursion by hand. Our agents call graph algorithms as
one-line tools, and their memory sits in the same graph as the supply chain, so recalling "what
happened last time a port one lane away closed" is a pattern match from the event, not a join across
a separate store.

So our honest pitch is narrower than the one we started with: multi-hop questions in one readable
query, graph algorithms as tools an agent can call, and a tuned SQL baseline that returns the same
answer, row for row, next to it. Postgres with pgRouting is a serious opponent, and on clusters and
uncapped shortest paths it beat us.

The benchmark scripts, the full notes and the bug repro are in our repo, and the app has an engine
switch: ask any question, flip to PostgreSQL, and press Compare to see both queries and both timings
side by side.
