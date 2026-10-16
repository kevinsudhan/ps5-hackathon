"""Track 2 check: many agents writing memory at once, readers querying alongside, two tenants.

Starts N agent runs in parallel across tenants (each run writes ~6 decisions plus cluster and
route-option nodes), while reader threads keep running cascade / recall queries. Then checks:
  * every run reached awaiting_approval with an unbroken NEXT chain (no interleaved handoffs),
  * concurrent runs on the same tenant + event computed identical numbers,
  * tenants stayed isolated (each run's evidence resolves inside its own graph only),
and reports throughput and reader latency. Test runs are deleted afterwards.

    python -m scripts.concurrency --runs 8 --readers 8
"""
import argparse
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from promisegraph import agents, falkor_store as fs, memory

JOBS = [("northwind", "EV-SGSIN-1020"), ("lumen", "EV-SGSIN-1020"), ("northwind", "EV-USWC-1120"),
        ("lumen", "EV-SGSIN-1020")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=8)
    ap.add_argument("--readers", type=int, default=8)
    ap.add_argument("--keep", action="store_true", help="keep the test runs")
    a = ap.parse_args()

    stop = threading.Event()
    reads: list[float] = []
    lock = threading.Lock()

    def reader(i: int):
        tenant = ["northwind", "lumen"][i % 2]
        g = fs.graph(tenant)
        while not stop.is_set():
            t0 = time.perf_counter()
            if i % 3 == 0:
                memory.recall(g, "EV-SGSIN-1020")
            else:
                fs.cascade(g, "EV-SGSIN-1020", 8)
            with lock:
                reads.append((time.perf_counter() - t0) * 1000)

    def run(i: int):
        tenant, event = JOBS[i % len(JOBS)]
        g = fs.graph(tenant)
        t0 = time.perf_counter()
        try:
            rid = agents.start_run(g, event, f"tester-{i}", explain=False)
        except Exception as ex:  # report, never hang the readers
            return tenant, event, None, repr(ex)
        return tenant, event, rid, time.perf_counter() - t0

    for tenant in ("northwind", "lumen"):  # leftovers from an interrupted earlier run
        g = fs.graph(tenant)
        for (rid,) in g.query("MATCH (r:Run) WHERE r.requested_by STARTS WITH 'tester-' RETURN r.id").result_set:
            memory.delete_run(g, rid)

    with ThreadPoolExecutor(a.readers) as rpool:
        for i in range(a.readers):
            rpool.submit(reader, i)
        t0 = time.perf_counter()
        try:
            with ThreadPoolExecutor(a.runs) as pool:
                done = list(pool.map(run, range(a.runs)))
        finally:
            stop.set()
        wall = time.perf_counter() - t0

    failed = [d for d in done if d[2] is None]
    for tenant, event, _r, err in failed:
        print(f"{tenant:9s} {event:14s} RUN FAILED: {err}")
    done = [d for d in done if d[2] is not None]

    ok = not failed
    numbers: dict[tuple, set] = {}
    for tenant, event, rid, secs in done:
        g = fs.graph(tenant)
        r = memory.get_run(g, rid, with_memory=False)
        decs = r["decisions"]
        chain_ok = all(d["prev"] == (decs[i - 1]["id"] if i else None) for i, d in enumerate(decs))
        status_ok = r["status"] == "awaiting_approval"
        plan = next(d for d in decs if d["kind"] == "plan")
        numbers.setdefault((tenant, event), set()).add(tuple(sorted(plan["numbers"].items())))
        # isolation: every evidence id of this run exists in this tenant's graph
        ev_ids = {x for d in decs for x in d["evidence"]}
        found = sum(g.query(f"UNWIND $ids AS x MATCH (n:{label} {{id: x}}) RETURN count(n)",
                            {"ids": list(ev_ids)}).result_set[0][0] for label in memory.EVIDENCE_LABELS)
        iso_ok = found == len(ev_ids)
        ok &= chain_ok and status_ok and iso_ok
        print(f"{tenant:9s} {event:14s} {rid}  {secs:5.2f}s  decisions={len(decs)} chain={'ok' if chain_ok else 'BROKEN'} "
              f"status={r['status']} evidence-in-own-graph={'ok' if iso_ok else 'LEAK'}")
    for key, variants in numbers.items():
        same = len(variants) == 1
        ok &= same
        print(f"{key}: concurrent runs agree on the plan numbers: {same}")
    print(f"\n{a.runs} agent runs in {wall:.1f}s wall ({a.runs / wall:.1f} runs/s) with {a.readers} readers; "
          f"{len(reads)} reads, median {statistics.median(reads):.0f} ms, "
          f"p95 {sorted(reads)[int(0.95 * (len(reads) - 1))]:.0f} ms")
    if not a.keep:
        for tenant, _e, rid, _s in done:
            memory.delete_run(fs.graph(tenant), rid)
    print("ALL CHECKS PASSED" if ok else "CHECKS FAILED")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
