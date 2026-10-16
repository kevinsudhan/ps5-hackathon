"""Write docs/queries.md straight from the query constants, so the docs never drift from the code.

    python -m scripts.export_queries
"""
from pathlib import Path

from promisegraph import falkor_store as fs
from promisegraph import memory
from promisegraph import questions as qs
from promisegraph import pg_store as ps

OUT = Path(__file__).resolve().parents[2] / "docs" / "queries.md"


def _pg(*names):
    """(label, sql) for each Postgres baseline constant that exists right now."""
    labels = {"CASCADE": "recursive CTE", "CLUSTERS": "recursive reachability (plain SQL)",
              "CLUSTERS_PGR": "pgRouting pgr_connectedComponents", "CHOKEPOINTS_PGR": "pgRouting",
              "REROUTE_PGR": "pgRouting"}
    return [(labels.get(n, n), getattr(ps, n)) for n in names if hasattr(ps, n)]


SECTIONS = [
    ("Q1. Cascade: which promises does a disruption break?",
     "Finds legs at a closed hub inside the closure window, walks `FEEDS` up to `depth` hops, shrinks the delay "
     "by each edge's `buffer_days`, keeps the worst delay per shipment, and returns the active promises that now "
     "land late, with days late and penalty. Used by the Impact Analyst, Finance, Verifier and the UI.",
     fs.cascade_query_text(8), _pg("CASCADE")),
    ("Q1b. What-if cascade: the same, after a rescue",
     "Q1 with some directly hit shipments given a new starting delay (the residual delay after a reroute). "
     "Finance prices every plan with it and the Verifier re-checks it, so savings are computed by Cypher.",
     fs.WHATIF.format(depth=8), []),
    ("Q2. Impacted shipments (late promise or not)",
     "Same walk as Q1, stopping at shipments. Feeds Q3 and the 3D view.",
     fs.IMPACTED.format(depth=8), []),
    ("Q3. Stranded clusters (Weakly Connected Components)",
     "Tags impacted shipments `:Impacted`, then `algo.WCC` over `FEEDS` splits them into independent problems. "
     "Each cluster lists its root shipments (hops = 0): rescue those, save the cluster.",
     fs.MARK_IMPACTED.strip() + "\n\n// then\n" + fs.CLUSTERS.strip(), _pg("CLUSTERS", "CLUSTERS_PGR")),
    ("Q4. Chokepoints (betweenness centrality)",
     "Which hubs do the most shortest routes depend on? The Sentinel uses the rank of the closed hub.",
     fs.CHOKEPOINTS, _pg("CHOKEPOINTS_PGR")),
    ("Q5. Reroutes (k shortest weighted paths)",
     "`algo.SPpaths` over `LANE` edges, weighted by `days` (fastest) or `cost_per_kg` (cheapest), dropping any "
     "path through a closed hub. The Rerouter runs it for every cluster root.",
     fs.REROUTE.format(weight="days", cost="cost_per_kg"), _pg("REROUTE_PGR")),
    ("Q6. Direct hits",
     "Which leg of which shipment touches a closed hub in the window, where the goods come from and where the "
     "shipment must end up. The Sentinel counts them; the Rerouter starts reroutes from them.",
     fs.HITS, []),
    ("Q7. Who is behind each promise",
     "Customer, city and due date per promise. The `WITH` barriers force an index seek per promise.",
     fs.PROMISE_DETAILS, []),
    ("P1. Prompt box: orders at risk (optionally one city)",
     "Template `at_risk`. Like Q1, plus the shipment at the start of each order's worst delay path. "
     "The engine switch runs either version; tests/test_questions.py checks they return the same rows.",
     qs.AT_RISK_CYPHER.format(depth=8), [("prompt-box twin", qs.AT_RISK_SQL)]),
    ("P2. Prompt box: orders from one city due between two dates",
     "Template `orders_window`.", qs.WINDOW_CYPHER, [("prompt-box twin", qs.WINDOW_SQL)]),
    ("P3. Prompt box: why one customer's order is late",
     "Template `why_late`: the worst delay path from the closed port to that customer's parcel, step by step.",
     qs.WHY_CYPHER.format(depth=8), [("prompt-box twin", qs.WHY_SQL)]),
    ("M1. Memory recall (episodic)",
     "Past runs about disruptions at the same hub, one lane away, or of the same kind, with the approved plan "
     "and its outcome. The Sentinel posts it; it is shown on every run.",
     memory.RECALL, []),
    ("M2. Playbooks (procedural)",
     "Learned rules with use and success counts. Finance reads them: a playbook that failed before "
     "(air-freighting full containers) rules that option out today.",
     memory.PLAYBOOKS, []),
]

MEMORY_WRITES = """## Memory writes (shared state and handoffs)

Every agent writes through `backend/promisegraph/memory.py`:

* `create_run`: `(:Person)-[:REQUESTED]->(:Run)-[:ABOUT]->(:Event)`
* `add_decision`: `(:Agent)-[:MADE]->(:Decision)-[:PART_OF]->(:Run)`, chained `(:Decision)-[:NEXT]->(:Decision)`,
  with `(:Decision)-[:EVIDENCE]->(Event|Hub|Shipment|Promise|Run)`
* `write_clusters`: `(:Decision)-[:FOUND]->(:Cluster)-[:ROOT]->(:Shipment)`
* `write_route_options`: `(:Decision)-[:PROPOSES]->(:RouteOption)-[:FOR]->(:Shipment)`, `(:RouteOption)-[:VIA]->(:Hub)`
* `choose_options`: `(:Decision)-[:CHOOSES]->(:RouteOption)`
* `set_decision_status`: `(:Decision)-[:APPROVED_BY|REJECTED_BY]->(:Person)`
* `record_outcome`, `upsert_playbook`: `(:Decision)-[:RESULTED_IN]->(:Outcome)`, `(:Decision)-[:FOLLOWED]->(:Playbook)`

The next agent reads the previous agent's output from these nodes (for example the Rerouter reads
`(:Decision {kind:'impact'})-[:FOUND]->(:Cluster)-[:ROOT]->(:Shipment)`), never from Python variables.
"""


def main():
    parts = ["# Queries the product depends on", "",
             "Generated by `python -m scripts.export_queries` from `backend/promisegraph/falkor_store.py` and "
             "`memory.py` (FalkorDB, the product) and `pg_store.py` (Postgres, benchmark baseline only). "
             "Do not edit by hand.", ""]
    for title, why, cypher, baselines in SECTIONS:
        parts += [f"## {title}", "", why, "", "```cypher", cypher.strip(), "```", ""]
        for label, sql in baselines:
            parts += [f"Postgres baseline, {label} (same answer, checked by the benchmark):", "",
                      "```sql", sql.strip(), "```", ""]
    parts.append(MEMORY_WRITES)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(parts), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
