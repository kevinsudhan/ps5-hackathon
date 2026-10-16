"""Integration tests. Need `docker compose up -d` (FalkorDB + Postgres) and nothing else.

    cd backend && python -m pytest -q

They build their own small tenant ("pytest", 3k orders), so they never touch the demo data.
"""
import pytest

from promisegraph import agents, datagen, falkor_store as fs, llm, memory, pg_store, views

from .conftest import DEPTH, TENANT

LIVE = [e["id"] for e in datagen.generate(orders=10, tenant="x").events if not e["historic"]]


@pytest.mark.parametrize("event", LIVE)
@pytest.mark.parametrize("depth", [0, 2, 4, 8])
def test_cascade_parity(ds, g, event, depth):
    """FalkorDB, the Postgres baseline and the plain-Python reference agree row for row."""
    ref = datagen.reference_impact(ds, event, depth)
    with pg_store.connect(TENANT) as conn:
        assert fs.cascade(g, event, depth) == ref == pg_store.cascade(conn, event, depth)


def test_whatif_without_overrides_is_the_cascade(g):
    assert fs.cascade_whatif(g, LIVE[0], DEPTH, {}) == fs.cascade(g, LIVE[0], DEPTH)


def test_clusters_partition_the_impact(g):
    rows = fs.cascade(g, LIVE[0], DEPTH)
    cl = fs.clusters(g, LIVE[0], DEPTH)
    assert sum(c["promises_at_risk"] for c in cl) == len(rows)
    assert round(sum(c["penalty_usd"] or 0 for c in cl)) == sum(r[6] for r in rows)
    with pg_store.connect(TENANT) as conn:
        pg = pg_store.clusters(conn, LIVE[0], DEPTH)
    key = lambda c: (c["shipments"], c["promises_at_risk"], int(c["penalty_usd"] or 0))  # noqa: E731
    assert sorted(map(key, cl)) == sorted(map(key, pg))


def test_agents_end_to_end(g):
    run_id = agents.start_run(g, LIVE[0], "Requester One", explain=False)
    run = memory.get_run(g, run_id)
    decs = run["decisions"]
    assert run["status"] == "awaiting_approval"
    assert [d["agent"] for d in decs][:2] == ["sentinel", "sentinel"]  # alert + memory recall
    assert all(d["prev"] == (decs[i - 1]["id"] if i else None) for i, d in enumerate(decs))  # unbroken handoffs
    plan = next(d for d in decs if d["kind"] == "plan")
    assert plan["requires_approval"] and plan["status"] == "verified"
    assert plan["numbers"]["promises_before"] == len(fs.cascade(g, LIVE[0], DEPTH))
    # memory did real work: the failed Suez air-freight playbook rules out air for full containers
    assert any(r["event_id"] == "EV-EGPSD-0715" and not r["worked"] for r in run["recall"])

    with pytest.raises(agents.PolicyError):
        agents.approve(g, run_id, plan["id"], "requester one")  # policy gate, case-insensitive
    uses_before = {p["id"]: p["uses"] for p in memory.playbooks(g, LIVE[0])}
    agents.approve(g, run_id, plan["id"], "Approver Two")
    with pytest.raises(agents.StateError):
        agents.approve(g, run_id, plan["id"], "Approver Two")  # no double approval
    run = memory.get_run(g, run_id)
    assert run["status"] == "done" and run["decisions"][-1]["agent"] == "comms"
    if plan["numbers"]["roots_rescued"]:
        assert memory.playbooks(g, LIVE[0])  # outcome recorded, playbook still there
        assert sum(p["uses"] for p in memory.playbooks(g, LIVE[0])) >= sum(uses_before.values())


def test_views_return_real_graph_paths(g):
    rows = fs.cascade(g, LIVE[0], DEPTH)
    sg = views.subgraph(g, LIVE[0], DEPTH, 500)
    ids = {n["id"] for n in sg["nodes"]}
    assert all(l["source"] in ids and l["target"] in ids for l in sg["links"])
    deepest = max(rows, key=lambda r: r[4])
    path = views.promise_path(g, deepest[0], LIVE[0], DEPTH)
    feeds = [l for l in path["links"] if l["type"] == "FEEDS"]
    assert len(feeds) == deepest[4]  # one FEEDS link per hop
    assert path["steps"][-1]["node"]["days_late"] == deepest[5]


def test_llm_guard_rejects_new_numbers():
    facts = "755 promises break, worth $114,065. Cluster roots: OCN-00062."
    assert llm.safe("OCN-00062 puts 755 promises and $114,065 at risk.", facts)
    assert not llm.safe("About 760 promises are at risk.", facts)
    assert not llm.safe("This costs $120,000.", facts)
