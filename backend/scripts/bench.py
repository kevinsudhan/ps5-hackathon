"""Race FalkorDB against the Postgres baseline on the cascade query.

For every (data size, depth): load identical data into both engines, check both return the
same rows, then time N runs of each (alternating, after warm-up). Two numbers per engine:
  * wall ms   - client-side, end to end, rows parsed into Python (C parsers on both sides:
                hiredis for FalkorDB, psycopg-binary for Postgres)
  * server ms - the engine's own execution time (FalkorDB run_time_ms, Postgres
                EXPLAIN ANALYZE "Execution Time"), i.e. no driver or network

Then the stranded-clusters race at full depth: FalkorDB algo.WCC vs Postgres pgRouting
(pgr_connectedComponents) vs Postgres recursive SQL, end-to-end wall ms, results checked identical.

Then chokepoints (algo.betweenness vs pgr_betweennessCentrality) and reroutes (algo.SPpaths vs
pgr_KSP) for the same event, end-to-end wall ms, results checked identical (up to ties).

    python -m scripts.bench --sizes 5000 20000 100000 --supply-tiers 5 --runs 9
"""
import argparse
import json
import platform
import statistics
import time
from pathlib import Path

from promisegraph import datagen, falkor_store, pg_store

OUT = Path(__file__).resolve().parents[2] / "bench"

# Q4 as shipped was approximate (algo.betweenness samples 32 source hubs by default) until Oct 16;
# it now passes samplingSize: 100000, i.e. exact. The bench still runs its own copy with
# samplingSize = hub count, so the "exact" column does not depend on that constant.
CHOKEPOINTS_EXACT = falkor_store.CHOKEPOINTS.replace("samplingSize: 100000", "samplingSize: $sources")
# Q5 without the product's 7-lane cap: plain k shortest simple paths, pgr_KSP's native question.
REROUTE_UNCAPPED = falkor_store.REROUTE.replace(", maxLen: 7", "")
assert CHOKEPOINTS_EXACT != falkor_store.CHOKEPOINTS and REROUTE_UNCAPPED != falkor_store.REROUTE


def med(xs):
    return round(statistics.median(xs), 2)


def reroute_uncapped(g, src, dst, closed, by, k):
    """falkor_store.reroute with REROUTE_UNCAPPED. None if FalkorDB hits its query timeout."""
    weight, cost = {"days": ("days", "cost_per_kg"), "cost": ("cost_per_kg", "days")}[by]
    try:
        res = g.query(REROUTE_UNCAPPED.format(weight=weight, cost=cost),
                      {"src": src, "dst": dst, "closed": closed, "k": k})
    except Exception as e:  # redis ResponseError("Query timed out") at the server's TIMEOUT
        if "timed out" in str(e):
            return None
        raise
    return [{"hubs": h, "modes": m, "days": w if by == "days" else c,
             "usd_per_kg": round(c if by == "days" else w, 2)} for h, m, w, c in res.result_set]


def check_routes(fk, pg, lanes, closed, by, max_len, what):
    """Same answer up to ties: the same weights in the same order, the same routes below the last
    (cut-off) weight, and every route a real simple lane path that avoids the closed hubs.
    Returns how many routes were tied and picked or ordered differently by the two engines."""
    def exact(routes):
        out = []
        for r in routes:
            hubs, modes = r["hubs"], r["modes"]
            assert len(modes) == len(hubs) - 1 and len(set(hubs)) == len(hubs), f"{what}: not a simple path"
            assert max_len is None or len(modes) <= max_len, f"{what}: too many lanes"
            assert not set(hubs) & set(closed), f"{what}: goes through a closed hub"
            ls = [lanes[(a, b, m)] for a, b, m in zip(hubs, hubs[1:], modes)]  # KeyError: not a lane
            days, usd = sum(x["days"] for x in ls), sum(x["cost_per_kg"] for x in ls)
            assert r["days"] == days and abs(r["usd_per_kg"] - usd) < 0.0051, f"{what}: wrong totals"
            out.append((days if by == "days" else usd, tuple(hubs)))
        return out
    f, p = exact(fk), exact(pg)
    assert len(f) == len(p) and all(abs(a[0] - b[0]) < 1e-9 for a, b in zip(f, p)), f"{what}: weights differ"
    if f:
        below = lambda xs: sorted(h for w, h in xs if w < f[-1][0] - 1e-9)  # noqa: E731
        assert below(f) == below(p), f"{what}: routes differ"
    return sum(a[1] != b[1] for a, b in zip(f, p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", type=int, nargs="+", default=[5000, 20000, 100000])
    ap.add_argument("--supply-tiers", type=int, default=5)
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--event", default="EV-SGSIN-1020")
    ap.add_argument("--tenant", default="bench")
    ap.add_argument("--tag", default="cascade")
    a = ap.parse_args()

    results, cluster_results, choke_results, reroute_results = [], [], [], []
    for size in a.sizes:
        ds = datagen.generate(orders=size, supply_tiers=a.supply_tiers, tenant=a.tenant)
        falkor_store.load(ds)
        pg_store.load(ds)
        g = falkor_store.graph(a.tenant)
        conn = pg_store.connect(a.tenant)
        for depth in range(0, a.supply_tiers + 3):
            cy = falkor_store.cascade_query_text(depth)
            fparams = {"event": a.event}
            pparams = {"event": a.event, "depth": depth}
            for _ in range(2):  # warm-up
                g.query(cy, fparams)
                conn.execute(pg_store.CASCADE, pparams).fetchall()
            fk_wall, fk_srv, pg_wall, pg_srv = [], [], [], []
            for _ in range(a.runs):
                t0 = time.perf_counter()
                res = g.query(cy, fparams)
                fk_rows = sorted(tuple(r) for r in res.result_set)
                fk_wall.append((time.perf_counter() - t0) * 1000)
                fk_srv.append(res.run_time_ms)
                t0 = time.perf_counter()
                pg_rows = sorted(tuple(r) for r in conn.execute(pg_store.CASCADE, pparams).fetchall())
                pg_wall.append((time.perf_counter() - t0) * 1000)
            for _ in range(max(3, a.runs // 2)):
                plan = conn.execute("EXPLAIN (ANALYZE, FORMAT JSON) " + pg_store.CASCADE, pparams).fetchone()[0]
                pg_srv.append(plan[0]["Execution Time"])
            assert fk_rows == pg_rows, f"engines disagree at size={size} depth={depth}"
            row = {"orders": size, "depth": depth, "at_risk": len(fk_rows),
                   "falkordb_wall_ms": med(fk_wall), "postgres_wall_ms": med(pg_wall),
                   "falkordb_server_ms": med(fk_srv), "postgres_server_ms": med(pg_srv)}
            results.append(row)
            print(json.dumps(row), flush=True)

        # Clusters race, full depth, end-to-end wall time. FalkorDB algo.WCC vs Postgres two ways:
        # pgRouting's pgr_connectedComponents, and plain recursive SQL reachability.
        # WCC and pgRouting alternate (1 warm-up, then --runs each); the recursive SQL takes
        # seconds to minutes, so it runs 3 times on its own afterwards.
        depth = a.supply_tiers + 2
        fk_ms, pgr_ms, pg_ms = [], [], []
        falkor_store.clusters(g, a.event, depth)
        pg_store.clusters_pgr(conn, a.event, depth)
        for _ in range(a.runs):
            t0 = time.perf_counter()
            fk = falkor_store.clusters(g, a.event, depth)
            fk_ms.append((time.perf_counter() - t0) * 1000)
            t0 = time.perf_counter()
            pgr = pg_store.clusters_pgr(conn, a.event, depth)
            pgr_ms.append((time.perf_counter() - t0) * 1000)
        for _ in range(3):
            t0 = time.perf_counter()
            pg = pg_store.clusters(conn, a.event, depth)
            pg_ms.append((time.perf_counter() - t0) * 1000)

        def stats(cs):
            return sorted((c["shipments"], c["promises_at_risk"], int(c["penalty_usd"] or 0),
                           sorted(set(r for r in c["roots"] or [] if r is not None))) for c in cs)
        assert stats(fk) == stats(pgr), f"FalkorDB and pgRouting clusters disagree at size={size}"
        assert stats(fk) == stats(pg), f"FalkorDB and recursive-SQL clusters disagree at size={size}"
        # The two Postgres versions also agree on cluster labels and full member lists.
        by_label = lambda cs: sorted(cs, key=lambda c: c["cluster"])  # noqa: E731
        assert by_label(pgr) == by_label(pg), f"Postgres versions disagree at size={size}"
        crow = {"orders": size, "depth": depth, "clusters": len(fk),
                "impacted_shipments": sum(c["shipments"] for c in fk),
                "falkordb_wall_ms": med(fk_ms), "pgrouting_wall_ms": med(pgr_ms),
                "postgres_wall_ms": med(pg_ms)}
        cluster_results.append(crow)
        print(json.dumps(crow), flush=True)

        # Q4 chokepoints, top 10 hubs. Three versions, alternating after 2 warm-ups: FalkorDB as
        # shipped (sampled), FalkorDB exact, pgRouting (exact). Parity: exact FalkorDB and pgRouting
        # give every hub the same score, so the same top 10 (ties at 10th place aside).
        n_hubs = len(ds.hubs)
        xparams = {"k": 10, "sources": n_hubs}
        for _ in range(2):
            falkor_store.chokepoints(g, 10)
            g.query(CHOKEPOINTS_EXACT, xparams)
            pg_store.chokepoints_pgr(conn, 10)
        sm_ms, fx_ms, pc_ms = [], [], []
        for _ in range(a.runs):
            t0 = time.perf_counter()
            shipped = falkor_store.chokepoints(g, 10)
            sm_ms.append((time.perf_counter() - t0) * 1000)
            t0 = time.perf_counter()
            fx = [tuple(r) for r in g.query(CHOKEPOINTS_EXACT, xparams).result_set]
            fx_ms.append((time.perf_counter() - t0) * 1000)
            t0 = time.perf_counter()
            pc = pg_store.chokepoints_pgr(conn, 10)
            pc_ms.append((time.perf_counter() - t0) * 1000)
        fx_all = {r[0]: r[3] for r in g.query(CHOKEPOINTS_EXACT, {"k": n_hubs, "sources": n_hubs}).result_set}
        pc_all = {r[0]: r[3] for r in pg_store.chokepoints_pgr(conn, n_hubs)}
        assert fx_all.keys() == pc_all.keys() and all(
            abs(fx_all[h] - pc_all[h]) <= 1e-6 * max(1.0, fx_all[h]) for h in fx_all), \
            f"FalkorDB and pgRouting betweenness disagree at size={size}"
        cut = fx[-1][3]
        above = lambda rows: sorted(r[0] for r in rows if r[3] > cut + 1e-6)  # noqa: E731
        assert [round(r[3], 6) for r in fx] == [round(r[3], 6) for r in pc] and above(fx) == above(pc), \
            f"FalkorDB and pgRouting top-10 chokepoints disagree at size={size}"
        qrow = {"orders": size, "hubs": n_hubs, "lanes": len(ds.lanes),
                "falkordb_shipped_wall_ms": med(sm_ms), "falkordb_exact_wall_ms": med(fx_ms),
                "pgrouting_wall_ms": med(pc_ms),
                "shipped_top10_in_exact_top10": len({r[0] for r in shipped} & {r[0] for r in fx}),
                "shipped_order_matches_exact": [r[0] for r in shipped] == [r[0] for r in fx],
                "exact_top10": [r[0] for r in fx]}
        choke_results.append(qrow)
        print(json.dumps(qrow), flush=True)

        # Q5 reroutes: the rerouter's workload for this event. For every shipment arriving at a
        # closed hub during the closure, the 3 lightest routes from where its goods are to where
        # they must end up, fastest and cheapest. Per query: 1 warm-up, then --runs alternating;
        # totals add up the per-query medians. Same routes up to ties (check_routes).
        lanes = {(x["src"], x["dst"], x["mode"]): x for x in ds.lanes}
        closed = sorted(x["hub_id"] for x in ds.affects if x["event_id"] == a.event)
        pairs = sorted({(h["leg_from"], h["destination"])
                        for h in falkor_store.hits(g, a.event).values() if h["direction"] == "TO"})
        queries = [(s, d, by) for s, d in pairs for by in ("days", "cost")]
        fs_med, kp_med, ties, max_k, routes = [], [], 0, 0, 0
        for s, d, by in queries:
            falkor_store.reroute(g, s, d, closed, by, 3)
            pg_store.reroute_pgr(conn, s, d, closed, by, 3)
            f_ms, p_ms = [], []
            for _ in range(a.runs):
                t0 = time.perf_counter()
                fk = falkor_store.reroute(g, s, d, closed, by, 3)
                f_ms.append((time.perf_counter() - t0) * 1000)
                t0 = time.perf_counter()
                pr, K = pg_store.reroute_pgr(conn, s, d, closed, by, 3)
                p_ms.append((time.perf_counter() - t0) * 1000)
            ties += check_routes(fk, pr, lanes, closed, by, 7, f"reroute {s}->{d} by {by} at size={size}")
            fs_med.append(statistics.median(f_ms))
            kp_med.append(statistics.median(p_ms))
            max_k, routes = max(max_k, K), routes + len(fk)

        # Q5 again without the 7-lane cap. Uncapped SPpaths can take seconds, so 3 runs each, and a
        # query that hits FalkorDB's 1 s server timeout counts as a timeout, not a time.
        uruns = min(3, a.runs)
        uf_med, up_med, timeouts, uties = [], [], 0, 0
        for s, d, by in queries:
            reroute_uncapped(g, s, d, closed, by, 3)
            pg_store.reroute_pgr(conn, s, d, closed, by, 3, max_len=None)
            f_ms, p_ms, fk = [], [], None
            for _ in range(uruns):
                t0 = time.perf_counter()
                fk = reroute_uncapped(g, s, d, closed, by, 3)
                f_ms.append((time.perf_counter() - t0) * 1000)
                if fk is None:
                    break
                t0 = time.perf_counter()
                pr, _K = pg_store.reroute_pgr(conn, s, d, closed, by, 3, max_len=None)
                p_ms.append((time.perf_counter() - t0) * 1000)
            if fk is None:
                timeouts += 1
                t0 = time.perf_counter()
                pg_store.reroute_pgr(conn, s, d, closed, by, 3, max_len=None)
                up_med.append((time.perf_counter() - t0) * 1000)
                continue
            uties += check_routes(fk, pr, lanes, closed, by, None, f"uncapped {s}->{d} by {by} at size={size}")
            uf_med.append(statistics.median(f_ms))
            up_med.append(statistics.median(p_ms))
        rrow = {"orders": size, "closed": closed, "pairs": len(pairs), "queries": len(queries), "routes": routes,
                "falkordb_total_ms": round(sum(fs_med), 1), "pgrouting_total_ms": round(sum(kp_med), 1),
                "falkordb_per_query_ms": med(fs_med), "pgrouting_per_query_ms": med(kp_med),
                "pgrouting_max_k": max_k, "tied_routes_differ": ties,
                "uncapped_runs": uruns, "uncapped_falkordb_timeouts": timeouts,
                "uncapped_falkordb_per_query_ms": med(uf_med) if uf_med else None,
                "uncapped_pgrouting_per_query_ms": med(up_med),
                "uncapped_tied_routes_differ": uties}
        reroute_results.append(rrow)
        print(json.dumps(rrow), flush=True)
        conn.close()

    OUT.mkdir(exist_ok=True)
    with pg_store.connect(a.tenant) as conn:
        pg_version = conn.execute("SELECT split_part(version(), ' ', 2) || ', pgRouting ' || pgr_version()"
                                  ).fetchone()[0]
    meta = {"event": a.event, "supply_tiers": a.supply_tiers, "runs": a.runs,
            "machine": f"{platform.system()} {platform.machine()}, {platform.processor()}",
            "postgres": pg_version,
            "note": "Both engines in Docker on the same machine, default configs. Postgres has full "
                    "indexes + ANALYZE, and pgRouting for the clusters, chokepoints and reroutes races. "
                    "Cascade: medians after 2 warm-ups. Clusters: WCC and pgRouting medians of --runs after "
                    "1 warm-up, recursive SQL median of 3. Chokepoints: medians of --runs after 2 warm-ups. "
                    "Reroutes: per-query medians of --runs after 1 warm-up (uncapped: 3 runs). Results "
                    "verified identical (reroutes up to tied routes)."}
    (OUT / f"{a.tag}.json").write_text(json.dumps(
        {"meta": meta, "cascade": results, "clusters": cluster_results, "chokepoints": choke_results,
         "reroutes": reroute_results}, indent=2))
    lines = ["## Q1 cascade (which promises break)", "",
             "| orders | depth | at-risk | FalkorDB wall | Postgres wall | FalkorDB server | Postgres server |",
             "|---:|---:|---:|---:|---:|---:|---:|"]
    for r in results:
        lines.append(f"| {r['orders']:,} | {r['depth']} | {r['at_risk']:,} | {r['falkordb_wall_ms']} ms | "
                     f"{r['postgres_wall_ms']} ms | {r['falkordb_server_ms']} ms | {r['postgres_server_ms']} ms |")
    lines += ["", "## Q3 stranded clusters (connected components), end-to-end", "",
              "FalkorDB `algo.WCC` vs Postgres + pgRouting `pgr_connectedComponents` vs Postgres "
              "recursive SQL reachability. Ratios are Postgres time / FalkorDB time.", "",
              "| orders | impacted shipments | clusters | FalkorDB WCC | Postgres pgRouting | Postgres recursive SQL"
              " | pgRouting / WCC | recursive / WCC |",
              "|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in cluster_results:
        fk = r["falkordb_wall_ms"]
        lines.append(f"| {r['orders']:,} | {r['impacted_shipments']:,} | {r['clusters']} | {fk} ms"
                     f" | {r['pgrouting_wall_ms']} ms | {r['postgres_wall_ms']} ms"
                     f" | {r['pgrouting_wall_ms'] / fk:.2f}x | {r['postgres_wall_ms'] / fk:.1f}x |")
    lines += ["", "## Q4 chokepoints (betweenness over the lane graph), end-to-end", "",
              "Top 10 hubs. With `samplingSize` >= hub count `algo.betweenness` is exact and gives every hub "
              "the same score as `pgr_betweennessCentrality` (asserted). Since Oct 16 the shipped query is exact "
              "too (before that it sampled 32 hubs). Ratio is pgRouting / FalkorDB exact.", "",
              "| orders | hubs | lanes | FalkorDB as shipped | FalkorDB exact | Postgres pgRouting"
              " | pgRouting / exact | shipped top 10 vs exact |",
              "|---:|---:|---:|---:|---:|---:|---:|---|"]
    for r in choke_results:
        same = "same order" if r["shipped_order_matches_exact"] else "different order"
        lines.append(f"| {r['orders']:,} | {r['hubs']} | {r['lanes']} | {r['falkordb_shipped_wall_ms']} ms"
                     f" | {r['falkordb_exact_wall_ms']} ms | {r['pgrouting_wall_ms']} ms"
                     f" | {r['pgrouting_wall_ms'] / r['falkordb_exact_wall_ms']:.2f}x"
                     f" | {r['shipped_top10_in_exact_top10']}/10 hubs, {same} |")
    lines += ["", "## Q5 reroutes (k shortest paths around the closed hub), end-to-end", "",
              "Every query the rerouter needs for this event: for each (from hub, destination) of a shipment "
              "arriving at a closed hub during the closure, the 3 lightest routes, by days and by cost. "
              "Product semantics: the 20 lightest paths of at most 7 lanes, then drop paths through closed "
              "hubs. `algo.SPpaths` has the lane cap built in; `pgr_KSP` does not, so the baseline doubles "
              "K until 20 short paths are in. Times are sums / medians of per-query medians.", "",
              "| orders | queries | routes found | FalkorDB SPpaths total | pgRouting KSP total"
              " | per query FalkorDB | per query pgRouting | largest K needed | tied routes picked differently |",
              "|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in reroute_results:
        lines.append(f"| {r['orders']:,} | {r['queries']} | {r['routes']} | {r['falkordb_total_ms']} ms"
                     f" | {r['pgrouting_total_ms']} ms | {r['falkordb_per_query_ms']} ms"
                     f" | {r['pgrouting_per_query_ms']} ms | {r['pgrouting_max_k']} | {r['tied_routes_differ']} |")
    lines += ["", "### Q5 without the 7-lane cap (plain k shortest simple paths, pgr_KSP's native question)", "",
              "Same queries, `maxLen` removed. FalkorDB's server timeout is 1 s (image default); a query "
              "that hits it is counted, not timed.", "",
              "| orders | queries | FalkorDB timeouts | per query FalkorDB (completed) | per query pgRouting"
              " | tied routes picked differently |",
              "|---:|---:|---:|---:|---:|---:|"]
    for r in reroute_results:
        fk = r["uncapped_falkordb_per_query_ms"]
        lines.append(f"| {r['orders']:,} | {r['queries']} | {r['uncapped_falkordb_timeouts']}"
                     f" | {'-' if fk is None else f'{fk} ms'} | {r['uncapped_pgrouting_per_query_ms']} ms"
                     f" | {r['uncapped_tied_routes_differ']} |")
    (OUT / f"{a.tag}.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
