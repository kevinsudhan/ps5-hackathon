"""Put agent memory back to the demo starting point without rebuilding the graphs.

Deletes every run (live and seeded), all playbooks, then re-seeds the synthetic history, so the
first run in the demo recalls exactly the three past disruptions. World data is untouched.

    python -m scripts.reset_demo
"""
from promisegraph import falkor_store as fs, history, memory

TENANTS = ["northwind", "lumen"]


def main():
    for tenant in TENANTS:
        g = fs.graph(tenant)
        runs = [r[0] for r in g.query("MATCH (r:Run) RETURN r.id").result_set]
        for rid in runs:
            memory.delete_run(g, rid)
        g.query("MATCH (p:Playbook) DETACH DELETE p")
        g.query("MATCH (o:Outcome) DETACH DELETE o")
        g.query(fs.CLEAR_IMPACTED)
        history.seed(g)
        g.query("MATCH (p:Person) OPTIONAL MATCH (p)-[r]-() WITH p, count(r) AS links WHERE links = 0 DELETE p")
        left = g.query("MATCH (r:Run) RETURN count(r)").result_set[0][0]
        pbs = [(p["id"], p["uses"], p["successes"]) for p in memory.playbooks(g, "EV-SGSIN-1020")]
        print(f"[{tenant}] removed {len(runs)} runs; now {left} seeded runs; playbooks {pbs}")


if __name__ == "__main__":
    main()
