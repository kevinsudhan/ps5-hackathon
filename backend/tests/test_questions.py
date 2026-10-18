"""The prompt box: every whitelisted template answers identically on FalkorDB and Postgres, its 3D
graph is well formed, and every suggestion chip is understood without an LLM."""
from collections import Counter

import pytest

from promisegraph import falkor_store as fs, nl, questions as q, story

from .conftest import TENANT

SG, LA = "EV-SGSIN-1020", "EV-USWC-1120"


@pytest.fixture(scope="module")
def ctx(g):
    return q.context(g)


def _both(tid, params, g, ctx):
    fk, _ = q.run(tid, params, "falkordb", g, TENANT, ctx)
    pg, _ = q.run(tid, params, "postgres", g, TENANT, ctx)
    return fk, pg


def _cases(g, ctx):
    risk = q.at_risk_falkor(g, {"event": SG, "city": None, "depth": 8}).rows
    city = Counter(r[3] for r in risk).most_common(1)[0][0]
    due = g.query("MATCH (c:Customer {city: $c})-[:PLACED]->(:Order)-[:HAS_PROMISE]->(p:Promise) RETURN p.due_day",
                  {"c": city}).result_set
    start = min(d for (d,) in due)
    cases = [("at_risk", {"event": SG, "city": None, "depth": d}) for d in (2, 4, 8)]
    cases += [("at_risk", {"event": SG, "city": city, "depth": 8}), ("at_risk", {"event": LA, "city": None, "depth": 8}),
              ("orders_window", {"city": city, "from_day": start, "to_day": start + 30}),
              ("rescue_first", {"event": SG, "depth": 8}), ("weak_points", {}),
              ("top_loss_orders", {"event": SG, "n": 10, "depth": 8}), ("top_loss_orders", {"event": SG, "n": 1, "depth": 8}),
              ("top_loss_orders", {"event": SG, "n": 50, "depth": 8}), ("top_loss_orders", {"event": LA, "n": 5, "depth": 8}),
              ("reroute", {"from_hub": "VNSGN", "to_hub": "DC-VNL", "avoid_hub": "SGSIN"})]
    cases += [("why_late", {"customer": n, "event": SG, "depth": 8}) for n in sorted({r[2] for r in risk})[:12]]
    return cases


def test_every_template_same_rows_on_both_engines(g, ctx):
    for tid, params in _cases(g, ctx):
        fk, pg = _both(tid, params, g, ctx)
        assert fk.rows == pg.rows, (tid, params)
        if params.get("event") == SG or tid in ("weak_points", "reroute"):
            assert fk.rows, (tid, params)  # these cases are chosen to return rows (LA may break nothing here)


def test_at_risk_matches_the_cascade(g, ctx):
    rows = q.at_risk_falkor(g, {"event": SG, "city": None, "depth": 8}).rows
    casc = fs.cascade(g, SG, 8)
    assert sorted(r[0] for r in rows) == sorted(r[0] for r in casc)
    assert sum(r[6] for r in rows) == sum(r[6] for r in casc)


def test_graphs_are_well_formed_and_explained(g, ctx):
    for tid, params in _cases(g, ctx):
        fk, _ = q.run(tid, params, "falkordb", g, TENANT, ctx)
        ans = q.build_answer(tid, params, fk, ctx, "falkordb")
        ids = {n["id"] for n in ans["graph"]["nodes"]}
        assert len(ids) == len(ans["graph"]["nodes"]), tid
        assert all(l["source"] in ids and l["target"] in ids for l in ans["graph"]["links"]), tid
        assert all(1 <= len(n["why"]) <= 3 for n in ans["graph"]["nodes"]), tid
        assert ans["answer"] and ans["query"]["ms"] >= 0 and ans["query"]["chars"] > 0


def test_chips_are_understood_without_an_llm(g, ctx, monkeypatch):
    monkeypatch.setattr(nl.llm, "available", lambda: False)
    for chip in story.chips(g, ctx):
        tid, params, how = nl.interpret(chip["question"], g, ctx)
        assert how == "keywords" and tid in q.TEMPLATES, chip
        fk, _ = q.run(tid, params, "falkordb", g, TENANT, ctx)
        assert fk.rows, chip  # every chip shows something


def test_unknown_question_is_refused_without_an_llm(g, ctx, monkeypatch):
    monkeypatch.setattr(nl.llm, "available", lambda: False)
    with pytest.raises(nl.NotUnderstood):
        nl.interpret("tell me a joke", g, ctx)


def test_story_path_is_inside_its_graph(g, ctx):
    st = story.story(g, SG, ctx)
    ids = {n["id"] for n in st["graph"]["nodes"]}
    assert all(l["source"] in ids and l["target"] in ids for l in st["graph"]["links"])
    assert st["persona"] and all(x in ids for x in st["persona"]["path"])


# ---- top_loss_orders and the shape of answer graphs (Oct 17) --------------------------------

def test_top_loss_is_the_head_of_orders_at_risk(g, ctx):
    """The N costliest late orders are exactly the first N of the at-risk list ranked by late fee."""
    risk = q.at_risk_falkor(g, {"event": SG, "city": None, "depth": 8}).rows
    for n in (1, 10, 50):
        top = q.top_loss_falkor(g, {"event": SG, "n": n, "depth": 8}).rows
        assert top == risk[:n]  # at_risk is sorted by (-fee, promise id), the same order


def test_top_n_is_validated(g, ctx):
    for bad in (0, 51, -3):
        with pytest.raises(ValueError):
            q.top_loss_falkor(g, {"event": SG, "n": bad, "depth": 8})


@pytest.mark.parametrize("question, n", [
    ("Show the 10 most loss-inducing orders", 10), ("top 5 costliest late orders", 5),
    ("which three orders lose us the most money?", 3), ("top 80 most expensive late orders", 50)])
def test_ranked_questions_are_understood(g, ctx, monkeypatch, question, n):
    monkeypatch.setattr(nl.llm, "available", lambda: False)
    tid, params, _how = nl.interpret(question, g, ctx)
    assert tid == "top_loss_orders" and params["n"] == n


def test_answer_graphs_stay_small_and_ranked(g, ctx):
    """Every answer draws only what answers it: a few dozen nodes at most, never one per late order.
    A ranked top-N answer has exactly its N orders plus the few nodes that explain them (the UI groups
    anything past ~25 into an expandable "+N more")."""
    for tid, params in _cases(g, ctx):
        fk, _ = q.run(tid, params, "falkordb", g, TENANT, ctx)
        graph = q.build_answer(tid, params, fk, ctx, "falkordb")["graph"]
        if tid == "top_loss_orders":
            assert sum(n["kind"] == "order" for n in graph["nodes"]) == len(fk.rows)
            assert len(graph["nodes"]) <= len(fk.rows) + 1 + 2 + len({r[8] for r in fk.rows})
        else:
            assert len(graph["nodes"]) <= 30, (tid, params, len(graph["nodes"]))
        ranks = [n["rank"] for n in graph["nodes"] if n.get("rank") and n["kind"] in ("order", "group")]
        assert ranks == sorted(ranks), tid
        assert all(0 <= l.get("weight", 0) <= 1 for l in graph["links"]), tid
        if tid == "top_loss_orders" and fk.rows:
            fees = [n["metric"]["value"] for n in graph["nodes"] if n["kind"] == "order"]
            assert fees == [r[6] for r in fk.rows]  # labelled with the ranked metric, in rank order


def test_event_chips_name_their_disruption(g, ctx, monkeypatch):
    monkeypatch.setattr(nl.llm, "available", lambda: False)
    for chip in story.chips(g, ctx, LA):
        tid, params, how = nl.interpret(chip["question"], g, ctx)
        assert how == "keywords" and tid in q.TEMPLATES, chip
        if "event" in params:
            assert params["event"] == LA, chip
