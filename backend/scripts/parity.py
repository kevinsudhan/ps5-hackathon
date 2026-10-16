"""Prove FalkorDB and the Postgres baseline give the SAME answer, and that it is the right one.

Regenerates the dataset in memory (deterministic seed) to get the plain-Python reference
answer, then compares it row by row with what each engine returns.

    python -m scripts.parity --orders 20000 --supply-tiers 3
"""
import argparse
import sys

from promisegraph import datagen, falkor_store, pg_store


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orders", type=int, default=20000)
    ap.add_argument("--supply-tiers", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--tenant", default="northwind")
    a = ap.parse_args()

    ds = datagen.generate(orders=a.orders, supply_tiers=a.supply_tiers, seed=a.seed, tenant=a.tenant)
    g = falkor_store.graph(a.tenant)
    conn = pg_store.connect(a.tenant)
    ok = True
    for event in [e["id"] for e in ds.events]:
        for depth in range(0, a.supply_tiers + 4):
            ref = datagen.reference_impact(ds, event, depth)
            fk = falkor_store.cascade(g, event, depth)
            pg = pg_store.cascade(conn, event, depth)
            same = ref == fk == pg
            ok &= same
            print(f"{event} depth={depth}: reference={len(ref):5d} falkordb={len(fk):5d} "
                  f"postgres={len(pg):5d}  {'OK' if same else 'MISMATCH'}")
            if not same:
                for name, rows in (("falkordb", fk), ("postgres", pg)):
                    diff = set(rows) ^ set(ref)
                    if diff:
                        print(f"   {name} differs on {len(diff)} rows, e.g. {sorted(diff)[:3]}")
    print("ALL ENGINES AGREE" if ok else "PARITY FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
