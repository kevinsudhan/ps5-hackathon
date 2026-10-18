"""The three Track 2 features: memory influence, with vs without memory, and the live agent timeline.

They use their own tenant built exactly like the demo company (20k orders, seed 7), loaded into
FalkorDB only, so the LA / Long Beach strike reproduces the case where memory changes the plan
without touching the demo data. The tenant is deleted afterwards.
"""
import json

import pytest
from fastapi.testclient import TestClient

from promisegraph import agents, api, datagen, falkor_store as fs, history, influence, llm, memory
from promisegraph.config import graph_name

MEM_TENANT = "pytest_mem"
SG, LA = "EV-SGSIN-1020", "EV-USWC-1120"


@pytest.fixture(scope="module")
def mg():
    fs.load(datagen.generate(orders=20000, seed=7, tenant=MEM_TENANT))
    g = fs.graph(MEM_TENANT)
    memory.ensure_schema(g)
    history.seed(g)
    yield g
    fs.connect().select_graph(graph_name(MEM_TENANT)).delete()


@pytest.fixture(scope="module")
def la_runs(mg):
    main = agents.start_run(mg, LA, "Requester One", explain=False)
    return main, agents.counterfactual(mg, main)


def _plan(g, run_id):
    return next(d for d in memory.decisions(g, run_id) if d["kind"] == "plan")


# ---- 1. memory influence -------------------------------------------------------------------

def test_memory_influence_names_the_lesson_that_changed_the_plan(mg, la_runs):
    main, _ = la_runs
    plan = _plan(mg, main)
    mem = plan["memory"]
    assert mem["used"] and mem["changed"]
    assert mem["effects"] == {agents.AIR_PLAYBOOK: "changed"}
    # At face value Finance would air-freight the stuck containers; with the track record it does not.
    assert mem["without_memory"]["by_air"] > 0 and mem["plan"]["by_air"] == 0

    # The influence is a graph path: plan -USED_MEMORY-> playbook <-FOLLOWED- past plan -> outcome.
    inf = influence.influence(mg, main)
    assert inf["influenced"] == 1 and inf["headline"].startswith("1 past experience changed")
    item = inf["items"][0]
    assert item["playbook"]["id"] == agents.AIR_PLAYBOOK and item["effect"] == "changed"
    assert [p["event_id"] for p in item["past"]] == ["EV-EGPSD-0715"] and not item["past"][0]["worked"]
    rec = memory.track_record(mg, [agents.AIR_PLAYBOOK])[agents.AIR_PLAYBOOK]
    assert item["realization"] == rec["realization"] == round(41000 / 148000, 4)

    # The Verifier re-read that track record before clearing the plan for approval.
    ver = next(d for d in memory.decisions(mg, main) if d["kind"] == "verification")
    assert ver["numbers"]["failed"] == 0 and plan["status"] == "verified"
    assert ver["numbers"]["checks"] == ver["numbers"]["passed"]


def test_memory_checked_but_not_decisive_is_reported_as_such(mg):
    run = agents.start_run(mg, SG, "Requester One", explain=False)
    mem = _plan(mg, run)["memory"]
    assert mem["used"] and not mem["changed"] and set(mem["effects"].values()) == {"checked"}
    assert mem["plan"]["options"] == mem["without_memory"]["options"]
    inf = influence.influence(mg, run)
    assert inf["influenced"] == 0 and "did not change" in inf["headline"]


# ---- 2 + 3. with vs without memory ---------------------------------------------------------

def test_with_and_without_memory_use_the_same_scenario(mg, la_runs):
    main, twin = la_runs
    assert influence.compare(mg, main, twin)["same_inputs"] == {
        "event": True, "impact": True, "route_options": True, "penalty_before": True, "memory": True,
        "only_memory_differs": True}
    t = memory.get_run(mg, twin)
    assert t["memory"] == "off" and t["counterfactual_of"] == main and t["status"] == "what_if"
    assert memory.get_run(mg, main)["counterfactual"] == twin
    recall = next(d for d in t["decisions"] if d["kind"] == "recall")
    assert recall["numbers"]["similar_runs"] == 0 and t["recall"] == [] and t["playbooks"] == []
    tmem = _plan(mg, twin)["memory"]
    assert not tmem["used"] and not tmem["changed"] and tmem["effects"] == {}
    with pytest.raises(agents.StateError):  # a comparison run can never be approved
        agents.approve(mg, twin, _plan(mg, twin)["id"], "Someone Else")
    assert agents.counterfactual(mg, main) == twin  # created once, then reused


def test_comparison_differs_only_in_memory(mg, la_runs):
    main, twin = la_runs
    mem, tplan = _plan(mg, main)["memory"], _plan(mg, twin)
    # Finance's own face-value choice equals what a real run without memory chose.
    assert tplan["memory"]["plan"]["options"] == mem["without_memory"]["options"]
    assert tplan["numbers"]["cost_usd"] == mem["without_memory"]["cost_usd"]
    assert tplan["numbers"]["saved_usd"] == mem["without_memory"]["saved_usd"]
    cmp = influence.compare(mg, main, twin)
    w, wo = cmp["with_memory"], cmp["without_memory"]
    assert not cmp["same_plan"] and wo["by_air"] > 0 and w["by_air"] == 0
    assert w["memory_used"] and not wo["memory_used"] and w["memories_used"] >= 1 and wo["memories_used"] == 0
    assert cmp["impact"]["avoided_loss_usd"] == w["expected_net_usd"] - wo["expected_net_usd"] > 0


def test_one_twin_even_when_asked_twice_at_once(mg):
    from concurrent.futures import ThreadPoolExecutor
    run = agents.start_run(mg, SG, "Requester One", explain=False)
    with ThreadPoolExecutor(max_workers=3) as ex:
        twins = set(ex.map(lambda _i: agents.counterfactual(mg, run), range(3)))
    assert len(twins) == 1
    assert len(mg.query("MATCH (t:Run)-[:COUNTERFACTUAL_OF]->(:Run {id: $r}) RETURN t.id", {"r": run}).result_set) == 1

# ---- 4. live agent timeline ----------------------------------------------------------------

def test_live_timeline_follows_the_real_steps(mg):
    run_id = agents.launch_run(mg, SG, "Requester One", explain=False)
    events = list(agents.follow(run_id, timeout=60))
    names = [s.__name__ for s in agents.PIPELINE]
    assert [(e["agent"], e["phase"]) for e in events if e["type"] == "step"] == \
        [(n, p) for n in names for p in ("started", "done")]
    assert events[-1]["type"] == "end" and events[-1]["status"] == "awaiting_approval"
    assert [e["i"] for e in events] == list(range(len(events)))
    assert all(a["t"] <= b["t"] for a, b in zip(events, events[1:]))

    run = memory.get_run(mg, run_id)
    assert run["status"] == "awaiting_approval"
    by_id = {d["id"]: d for d in run["decisions"]}
    done = [e for e in events if e.get("phase") == "done"]
    assert sum(len(e["decisions"]) for e in done) == len(run["decisions"])  # every decision came from a step
    for e in done:
        assert e["decisions"] and all(by_id[d]["agent"] == e["agent"] and by_id[d]["ms"] == e["ms"]
                                      for d in e["decisions"])
    # 6. the handoff chain is unbroken
    assert all(d["prev"] == (run["decisions"][i - 1]["id"] if i else None) for i, d in enumerate(run["decisions"]))


def test_live_timeline_reports_a_failed_step(mg, monkeypatch):
    def broken(ctx):
        raise RuntimeError("no route table")
    monkeypatch.setattr(agents, "PIPELINE", [agents.sentinel, agents.impact_analyst, broken, agents.finance,
                                             agents.verifier])
    run_id = agents.launch_run(mg, SG, "Requester One", explain=False)
    events = list(agents.follow(run_id, timeout=60))
    assert events[-2]["phase"] == "failed" and events[-2]["agent"] == "broken"
    assert events[-1] == {**events[-1], "type": "end", "status": "failed"}
    assert memory.get_run(mg, run_id)["status"] == "failed"


def test_stream_endpoint_sends_the_run_and_ends(mg):
    client = TestClient(api.app)
    run = client.post(f"/api/{MEM_TENANT}/runs", json={"event_id": SG, "requested_by": "Requester One",
                                                       "live": True}).json()
    assert run["status"] == "running"
    body = client.get(f"/api/{MEM_TENANT}/runs/{run['id']}/stream").text
    frames = [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]
    assert frames[-1]["type"] == "end" and frames[-1]["run"]["status"] == "awaiting_approval"
    assert {f["agent"] for f in frames if f["type"] == "step"} == {s.__name__ for s in agents.PIPELINE}


# ---- 5. tenant isolation -------------------------------------------------------------------

def test_runs_stay_inside_their_tenant(mg, g):
    run_id = agents.start_run(mg, SG, "Requester One", explain=False)
    assert memory.get_run(g, run_id) is None  # the other tenant's graph has never heard of it
    client = TestClient(api.app)
    assert client.get(f"/api/{MEM_TENANT}/runs/{run_id}").status_code == 200
    for method, path in (("get", "stream"), ("post", "without-memory"), ("get", "memory-influence"), ("get", "")):
        assert getattr(client, method)(f"/api/pytest/runs/{run_id}/{path}".rstrip("/")).status_code == 404


# ---- 7 + 8. numbers ------------------------------------------------------------------------

def test_expected_saving_is_the_paper_saving_times_the_track_record(mg):
    run = agents.start_run(mg, SG, "Requester One", explain=False)
    plan = _plan(mg, run)
    n = plan["numbers"]
    assert n["roots_rescued"] > 0 and plan["memory"]["plan"]["by_air"] == 0
    rec = memory.track_record(mg, [agents.SEA_PLAYBOOK])[agents.SEA_PLAYBOOK]
    assert rec["realization"] == round((29900 + 52600) / (31800 + 55400), 4)
    assert abs(n["expected_saved_usd"] - rec["realization"] * n["saved_usd"]) <= 1
    # paper numbers are unchanged by memory and still recomputed by the Verifier
    assert n["saved_usd"] == n["penalty_before"] - n["penalty_after"]
    ver = next(d for d in memory.decisions(mg, run) if d["kind"] == "verification")
    assert ver["numbers"]["failed"] == 0


def test_memory_texts_only_use_numbers_from_the_graph(mg, la_runs):
    main, twin = la_runs
    plan, tplan = _plan(mg, main), _plan(mg, twin)
    rec = memory.track_record(mg, [agents.AIR_PLAYBOOK, agents.SEA_PLAYBOOK])
    cmp = influence.compare(mg, main, twin)
    inf = influence.influence(mg, main)
    facts = json.dumps([plan["numbers"], plan["memory"], tplan["numbers"], rec,
                        {pb: round(r["realization"] * 100) for pb, r in rec.items()},
                        cmp["with_memory"], cmp["without_memory"], cmp["impact"]["avoided_loss_usd"],
                        inf["influenced"]])
    texts = [plan["summary"], tplan["summary"], cmp["impact"]["headline"], cmp["impact"]["detail"], inf["headline"]]
    texts += [t for i in inf["items"] for t in (i["learned"], i["now"], i["effect_text"])]
    for t in texts:
        assert llm.safe(t, facts), t


def test_recall_only_counts_disruptions_that_came_before(mg, la_runs):
    """An approved run about a later disruption (LA, Nov 20) is not past experience for Singapore (Oct 20)."""
    main, _ = la_runs
    plan = _plan(mg, main)
    if plan["status"] == "verified":
        agents.approve(mg, main, plan["id"], "Someone Else")
    assert memory.get_run(mg, main)["status"] == "done"
    assert all(r["event_id"] != LA for r in memory.recall(mg, SG))
