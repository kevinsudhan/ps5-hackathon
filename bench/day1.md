## Q1 cascade (which promises break)

| orders | depth | at-risk | FalkorDB wall | Postgres wall | FalkorDB server | Postgres server |
|---:|---:|---:|---:|---:|---:|---:|
| 5,000 | 0 | 0 | 2.31 ms | 2.97 ms | 0.64 ms | 0.72 ms |
| 5,000 | 1 | 0 | 3.38 ms | 2.24 ms | 1.0 ms | 1.47 ms |
| 5,000 | 2 | 0 | 3.48 ms | 4.4 ms | 0.94 ms | 2.99 ms |
| 5,000 | 3 | 0 | 3.53 ms | 4.48 ms | 1.07 ms | 3.5 ms |
| 5,000 | 4 | 256 | 11.91 ms | 13.3 ms | 6.24 ms | 7.92 ms |
| 5,000 | 5 | 259 | 15.4 ms | 9.23 ms | 10.19 ms | 9.21 ms |
| 5,000 | 6 | 259 | 16.97 ms | 9.75 ms | 10.98 ms | 8.94 ms |
| 5,000 | 7 | 259 | 25.22 ms | 23.42 ms | 17.85 ms | 30.43 ms |
| 20,000 | 0 | 0 | 3.72 ms | 5.18 ms | 1.81 ms | 2.4 ms |
| 20,000 | 1 | 0 | 3.9 ms | 4.83 ms | 1.92 ms | 5.31 ms |
| 20,000 | 2 | 1,240 | 31.44 ms | 35.12 ms | 13.37 ms | 28.16 ms |
| 20,000 | 3 | 1,240 | 35.6 ms | 33.98 ms | 16.03 ms | 41.24 ms |
| 20,000 | 4 | 1,562 | 41.46 ms | 43.3 ms | 20.07 ms | 37.87 ms |
| 20,000 | 5 | 1,567 | 54.93 ms | 47.02 ms | 29.0 ms | 41.43 ms |
| 20,000 | 6 | 1,567 | 51.9 ms | 45.0 ms | 27.01 ms | 50.39 ms |
| 20,000 | 7 | 1,567 | 53.1 ms | 42.17 ms | 26.25 ms | 45.06 ms |
| 100,000 | 0 | 0 | 8.76 ms | 3.51 ms | 6.69 ms | 0.43 ms |
| 100,000 | 1 | 0 | 9.34 ms | 9.8 ms | 6.92 ms | 12.63 ms |
| 100,000 | 2 | 3,008 | 71.85 ms | 123.97 ms | 44.26 ms | 140.14 ms |
| 100,000 | 3 | 3,165 | 133.17 ms | 206.3 ms | 59.74 ms | 181.58 ms |
| 100,000 | 4 | 4,100 | 165.98 ms | 254.64 ms | 107.54 ms | 218.5 ms |
| 100,000 | 5 | 4,500 | 206.4 ms | 274.15 ms | 120.31 ms | 297.84 ms |
| 100,000 | 6 | 4,500 | 208.63 ms | 213.96 ms | 108.38 ms | 171.75 ms |
| 100,000 | 7 | 4,500 | 195.58 ms | 277.25 ms | 110.67 ms | 219.92 ms |

## Q3 stranded clusters (connected components), end-to-end

FalkorDB `algo.WCC` vs Postgres + pgRouting `pgr_connectedComponents` vs Postgres recursive SQL reachability. Ratios are Postgres time / FalkorDB time.

| orders | impacted shipments | clusters | FalkorDB WCC | Postgres pgRouting | Postgres recursive SQL | pgRouting / WCC | recursive / WCC |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5,000 | 587 | 3 | 57.12 ms | 28.09 ms | 503.09 ms | 0.49x | 8.8x |
| 20,000 | 2,563 | 6 | 134.84 ms | 53.6 ms | 3713.72 ms | 0.40x | 27.5x |
| 100,000 | 8,068 | 11 | 409.99 ms | 201.02 ms | 50837.18 ms | 0.49x | 124.0x |

## Q4 chokepoints (betweenness over the lane graph), end-to-end

Top 10 hubs. The shipped FalkorDB query lets `algo.betweenness` sample 32 source hubs (its default), so it is approximate; with `samplingSize` >= hub count it is exact and gives every hub the same score as `pgr_betweennessCentrality` (asserted). Ratio is pgRouting / FalkorDB exact.

| orders | hubs | lanes | FalkorDB as shipped (sampled) | FalkorDB exact | Postgres pgRouting | pgRouting / exact | shipped top 10 vs exact |
|---:|---:|---:|---:|---:|---:|---:|---|
| 5,000 | 121 | 299 | 2.12 ms | 3.95 ms | 4.63 ms | 1.17x | 9/10 hubs, different order |
| 20,000 | 121 | 299 | 2.22 ms | 3.56 ms | 3.46 ms | 0.97x | 9/10 hubs, different order |
| 100,000 | 121 | 299 | 2.92 ms | 3.82 ms | 4.19 ms | 1.10x | 9/10 hubs, different order |

## Q5 reroutes (k shortest paths around the closed hub), end-to-end

Every query the rerouter needs for this event: for each (from hub, destination) of a shipment arriving at a closed hub during the closure, the 3 lightest routes, by days and by cost. Product semantics: the 20 lightest paths of at most 7 lanes, then drop paths through closed hubs. `algo.SPpaths` has the lane cap built in; `pgr_KSP` does not, so the baseline doubles K until 20 short paths are in. Times are sums / medians of per-query medians.

| orders | queries | routes found | FalkorDB SPpaths total | pgRouting KSP total | per query FalkorDB | per query pgRouting | largest K needed | tied routes picked differently |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5,000 | 6 | 0 | 35.1 ms | 65.9 ms | 5.49 ms | 5.84 ms | 80 | 0 |
| 20,000 | 12 | 17 | 58.7 ms | 74.7 ms | 4.04 ms | 4.29 ms | 80 | 1 |
| 100,000 | 26 | 47 | 154.4 ms | 173.3 ms | 5.6 ms | 5.04 ms | 80 | 7 |

### Q5 without the 7-lane cap (plain k shortest simple paths, pgr_KSP's native question)

Same queries, `maxLen` removed. FalkorDB's server timeout is 1 s (image default); a query that hits it is counted, not timed.

| orders | queries | FalkorDB timeouts | per query FalkorDB (completed) | per query pgRouting | tied routes picked differently |
|---:|---:|---:|---:|---:|---:|
| 5,000 | 6 | 2 | 84.51 ms | 7.94 ms | 0 |
| 20,000 | 12 | 2 | 52.38 ms | 4.76 ms | 1 |
| 100,000 | 26 | 7 | 103.5 ms | 4.82 ms | 6 |
