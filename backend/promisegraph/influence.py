"""Memory influence and the with/without-memory comparison, read back from the graph.

Every figure here comes from nodes the agents wrote (Decision numbers and memory, Outcome,
RouteOption) or from the playbooks' track record; the sentences are templates, never the LLM.

  influence(g, run)        which learned habits Finance applied, where each was learned, and
                           whether it changed the plan
  compare(g, main, twin)   the run with memory next to its twin run without memory: same event,
                           same graph, same route options (checked), different memory
"""
from __future__ import annotations

from datetime import date

from . import agents, memory


def _usd(x: float) -> str:
    return f"-${-x:,.0f}" if x < 0 else f"${x:,.0f}"


def _nets(x: float) -> str:
    return f"loses {_usd(-x)}" if x < 0 else f"nets {_usd(x)}"


def _month(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%b %Y")


HABIT_NAMES = {agents.AIR_PLAYBOOK: "Air freight for full containers",
               agents.SEA_PLAYBOOK: "Sea reroutes through a neighbouring port"}


def _plan(run: dict) -> dict | None:
    return next((d for d in run["decisions"] if d["kind"] == "plan"), None)


def recommendation(p: dict) -> str:
    """Short imperative: 'Reroute 3 shipments by sea', 'Air-freight 5 shipments', 'No rescue: inform customers'."""
    if not p["roots"]:
        return "No rescue: inform affected customers"
    n = lambda k, w="shipment": f"{p[k]} {w}{'' if p[k] == 1 else 's'}"  # noqa: E731
    if p["by_air"] and not p["by_sea"]:
        return f"Air-freight {n('by_air')}"
    if p["by_sea"] and not p["by_air"]:
        return f"Reroute {n('by_sea')} by sea"
    return f"Reroute {p['by_sea']} by sea, air-freight {p['by_air']}"


def influence(g, run_id: str) -> dict:
    run = memory.get_run(g, run_id)
    if run is None:
        raise KeyError(run_id)
    plan = _plan(run)
    mem = (plan or {}).get("memory") or {"used": run["memory"] == "on", "changed": False, "records": [], "effects": {}}
    items: dict[str, dict] = {}
    for (_did, pid, trigger, action, uses, wins, realization, effect, _pd, _nums, outcome, cost, actual, worked,
         prun, pev, pname, pstart) in memory.influence_rows(g, run_id):
        it = items.setdefault(pid, {"playbook": {"id": pid, "trigger": trigger, "action": action, "uses": uses,
                                                 "successes": wins},
                                    "realization": realization, "effect": effect, "past": []})
        if prun:
            from .config import to_date
            it["past"].append({"run_id": prun, "event_id": pev, "event_name": pname,
                               "when": to_date(pstart).isoformat(), "outcome": outcome, "cost_usd": cost,
                               "saved_usd": actual, "worked": bool(worked)})
    records = {r["id"]: r for r in mem.get("records", [])}
    without, proposal = mem.get("without_memory"), mem.get("plan")
    out_items = []
    for pid, it in sorted(items.items(), key=lambda kv: kv[1]["effect"] != "changed"):
        rec = records.get(pid, {})
        pct = round(it["realization"] * 100)
        pb = it["playbook"]
        name = HABIT_NAMES.get(pid, pb["action"])
        tried = (("tried once, and it worked" if pb["successes"] else "tried once, and it did not pay off")
                 if pb["uses"] == 1 else f"tried {pb['uses']} times, worked {pb['successes']}")
        learned = f"{name}: {tried}. It delivered {pct}% of the saving expected at the time."
        it["name"] = name
        if it["effect"] == "changed" and without and proposal:
            now = (f"At face value, {agents.plan_words(without)} would save {_usd(without['saved_usd'])} "
                   f"for {_usd(without['cost_usd'])}.")
            effect = (f"Counted at {pct}%, it would save about {_usd(without['expected_saved_usd'])}, "
                      f"{'less than' if without['expected_saved_usd'] < without['cost_usd'] else 'barely more than'} it costs. "
                      f"Finance chose {agents.plan_words(proposal)} instead.")
        else:
            now = "Today's options of this kind were priced with this track record."
            effect = "It did not change the plan: the same option wins at face value."
        out_items.append({**it, "expected_usd": rec.get("expected_usd"), "actual_usd": rec.get("actual_usd"),
                          "learned": learned, "now": now, "effect_text": effect})
    changed = sum(1 for i in out_items if i["effect"] == "changed")
    if not mem.get("used"):
        headline = "Memory was switched off for this run"
    elif changed:
        headline = f"{changed} past experience{'' if changed == 1 else 's'} changed this decision"
    elif out_items:
        headline = "Past experience was checked; it did not change this decision"
    else:
        headline = "Nothing learned yet applies to this decision"
    return {"run_id": run_id, "event_id": run["event_id"], "used": bool(mem.get("used")), "changed": bool(mem.get("changed")),
            "influenced": changed, "consulted": len(out_items), "headline": headline, "items": out_items,
            "recall": run["recall"][:3], "decision": plan["summary"] if plan else None,
            "plan": proposal, "without_memory": without, "query": memory.INFLUENCE.strip()}


# The route options a run's Rerouter proposed, as comparable rows (ids differ between runs).
_OPTIONS = """
MATCH (:Decision {run_id: $run, kind: 'reroute'})-[:PROPOSES]->(o:RouteOption)
RETURN o.root, o.option, o.hubs, o.modes, o.cost_usd, o.residual_delay ORDER BY o.root, o.option
"""
_CHOSEN = """
MATCH (:Decision {run_id: $run, kind: 'plan'})-[:CHOOSES]->(o:RouteOption)-[:FOR]->(s:Shipment)
RETURN o.root, o.option, o.modes, o.cost_usd, s.weight_kg
"""


def compare(g, main_id: str, twin_id: str) -> dict:
    a, b = memory.get_run(g, main_id), memory.get_run(g, twin_id)
    if a is None or b is None:
        raise KeyError(main_id if a is None else twin_id)
    pa, pb = _plan(a), _plan(b)
    if pa is None or pb is None:
        raise agents.StateError("both runs must reach the Finance step")
    ia = next(d for d in a["decisions"] if d["kind"] == "impact")["numbers"]
    ib = next(d for d in b["decisions"] if d["kind"] == "impact")["numbers"]
    oa, ob = g.query(_OPTIONS, {"run": main_id}).result_set, g.query(_OPTIONS, {"run": twin_id}).result_set
    keys = ("promises_at_risk", "penalty_usd", "clusters", "roots")
    same = {"event": a["event_id"] == b["event_id"],
            "impact": all(ia.get(k) == ib.get(k) for k in keys),
            "route_options": oa == ob,
            "penalty_before": pa["numbers"]["penalty_before"] == pb["numbers"]["penalty_before"],
            "memory": a["memory"] != b["memory"]}
    same["only_memory_differs"] = all(same.values())

    # One yardstick for both plans: today's track record (what each kind of move delivered before).
    applicable = {p["id"] for p in memory.playbooks(g, a["event_id"])}
    records = memory.track_record(g, sorted(applicable & {agents.AIR_PLAYBOOK, agents.SEA_PLAYBOOK}))

    def side(run: dict, plan: dict) -> dict:
        rows = g.query(_CHOSEN, {"run": run["id"]}).result_set
        opts = {r[0]: {"root": r[0], "label": r[1], "modes": r[2], "cost": r[3], "weight": r[4]} for r in rows}
        for o in opts.values():
            o["playbook"] = agents.playbook_for(o)
        n = plan["numbers"]
        rate = agents.plan_rate(opts, records) if opts else 1.0
        by_air = sum(1 for o in opts.values() if "air" in o["modes"])
        p = {"roots": len(opts), "by_air": by_air, "by_sea": len(opts) - by_air}
        exp_saved = round(rate * n["saved_usd"])
        mem = plan.get("memory") or {}
        return {"run_id": run["id"], "memory_used": run["memory"] == "on",
                "memories_used": len(mem.get("records", [])) if run["memory"] == "on" else 0,
                "similar_disruptions": len(run["recall"]),
                "recommendation": recommendation(p), **p,
                "cost_usd": n["cost_usd"], "saved_usd": n["saved_usd"], "promises_saved": n["promises_saved"],
                "net_usd": n["net_usd"], "expected_saved_usd": exp_saved, "expected_net_usd": exp_saved - n["cost_usd"],
                "options": sorted([o["root"], o["label"]] for o in opts.values()), "summary": plan["summary"]}

    w, wo = side(a, pa), side(b, pb)
    same_plan = w["options"] == wo["options"]
    avoided = max(0, w["expected_net_usd"] - wo["expected_net_usd"])
    infl = influence(g, main_id)
    lesson = next((i for i in infl["items"] if i["effect"] == "changed"), None)
    past = lesson["past"][0] if lesson and lesson["past"] else None
    if same_plan:
        impact = "Same plan either way: past experience was checked, but the best option is the same at face value."
    else:
        impact = f"Using past experience avoided an expected loss of {_usd(avoided)}."
    detail = None
    if not same_plan and lesson and past:
        detail = (f"Without memory the agents would {wo['recommendation'][0].lower() + wo['recommendation'][1:]} for "
                  f"{_usd(wo['cost_usd'])}, expecting to save {_usd(wo['saved_usd'])}. The last time "
                  f"{lesson['name'][0].lower() + lesson['name'][1:]} was used "
                  f"({past['event_name']}, {_month(past['when'])}), it delivered {round(lesson['realization'] * 100)}% "
                  f"of the expected saving. At that rate that plan {_nets(wo['expected_net_usd'])}; "
                  f"the plan made with memory {_nets(w['expected_net_usd'])}.")
    return {"event_id": a["event_id"], "same_inputs": same, "same_plan": same_plan,
            "with_memory": w, "without_memory": wo,
            "impact": {"avoided_loss_usd": avoided, "headline": impact, "detail": detail,
                       "lesson": ({"action": lesson["name"], "realization": lesson["realization"],
                                   "past": past} if lesson else None)},
            "yardstick": "Both plans priced with today's track record: each kind of move counted at the share of "
                         "its expected saving it actually delivered in past outcomes."}
