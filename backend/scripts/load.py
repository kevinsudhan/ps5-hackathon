"""Generate synthetic data and load it into FalkorDB (product) and Postgres (baseline).

    python -m scripts.load                      # the demo: northwind (20k orders) + lumen (3k), with memory
    python -m scripts.load --tenant bench --orders 100000 --supply-tiers 5 --no-memory
    python -m scripts.load --if-missing         # container start: only tenants that are not loaded yet
"""
import argparse
import time

from promisegraph import datagen, falkor_store, history, memory, pg_store
from promisegraph.config import graph_name

DEMO = [
    {"tenant": "northwind", "company": "Northwind Retail", "orders": 20000, "seed": 7, "families": None},
    {"tenant": "lumen", "company": "Lumen Home Co", "orders": 3000, "seed": 21, "families": ["furniture", "home"]},
]


def load_one(spec: dict, supply_tiers: int, skip_postgres: bool, with_memory: bool):
    t0 = time.perf_counter()
    ds = datagen.generate(orders=spec["orders"], supply_tiers=supply_tiers, seed=spec["seed"],
                          tenant=spec["tenant"], company=spec["company"], families=spec["families"])
    print(f"[{spec['tenant']}] generated in {time.perf_counter() - t0:.1f}s: {ds.counts()}")
    print(f"[{spec['tenant']}] FalkorDB graph loaded in {falkor_store.load(ds):.1f}s")
    if with_memory:
        g = falkor_store.graph(spec["tenant"])
        memory.ensure_schema(g)
        history.seed(g)
        print(f"[{spec['tenant']}] agent memory schema + seeded history ready")
    if not skip_postgres:
        print(f"[{spec['tenant']}] Postgres schema loaded in {pg_store.load(ds):.1f}s")


def loaded(tenant: str, skip_postgres: bool) -> bool:
    """True when the tenant's graph exists in FalkorDB and (unless skipped) its Postgres schema too."""
    if graph_name(tenant) not in falkor_store.connect().list_graphs():
        return False
    if skip_postgres:
        return True
    with pg_store.psycopg.connect(pg_store.PG_DSN) as conn:
        return conn.execute("SELECT 1 FROM information_schema.schemata WHERE schema_name = %s",
                            (pg_store.schema_name(tenant),)).fetchone() is not None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant", help="load one tenant instead of the demo set")
    ap.add_argument("--company", default=None)
    ap.add_argument("--orders", type=int, default=20000)
    ap.add_argument("--supply-tiers", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--skip-postgres", action="store_true")
    ap.add_argument("--no-memory", action="store_true", help="skip agent memory schema and seeded history")
    ap.add_argument("--if-missing", action="store_true", help="skip tenants that are already loaded")
    a = ap.parse_args()

    specs = DEMO if a.tenant is None else [
        {"tenant": a.tenant, "company": a.company or a.tenant.title(), "orders": a.orders, "seed": a.seed,
         "families": None}]
    for spec in specs:
        if a.if_missing and loaded(spec["tenant"], a.skip_postgres):
            print(f"[{spec['tenant']}] already loaded, skipped")
            continue
        load_one(spec, a.supply_tiers, a.skip_postgres, not a.no_memory)


if __name__ == "__main__":
    main()
