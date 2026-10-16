"""The six agents.

Rules every agent follows:
  * Every number comes from a Cypher query (falkor_store) or from a node another agent wrote.
  * Each agent reads its input from the graph: the previous agent's Decision node, the Cluster
    and RouteOption nodes hanging off it. Nothing is passed along in Python variables.
  * Each agent writes one Decision, chained after the previous one, with EVIDENCE edges.
  * Gemini only rewrites wording afterwards, in the background (llm.py), and is never needed.

Flow: sentinel -> impact_analyst -> rerouter -> finance -> verifier -> (human approves) -> comms
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date

from . import falkor_store as fs
from . import llm, memory
from .config import TODAY, to_date, to_day

log = logging.getLogger(__name__)
TODAY_DAY = to_day(TODAY)
DEPTH = 8
FULL_CONTAINER_KG = 5000
AIR_PLAYBOOK = "PB-AIR-FULL-CONTAINER"
SEA_PLAYBOOK = "PB-SEA-NEIGHBOUR"
_pool = ThreadPoolExecutor(max_workers=8)


class PolicyError(Exception):
    """Raised when someone tries to approve their own request."""


class StateError(Exception):
    """Raised when a decision is not in a state that allows the action."""


@dataclass
class Ctx:
    g: object
    run_id: str
    event_id: str


def _day(d: int) -> str:
    return to_date(d).strftime("%b %d").replace(" 0", " ")


def _usd(x: float) -> str:
    return f"${x:,.0f}"


def _count(count: int, word: str, plural: str | None = None) -> str:
    """'1 root shipment', '3 root shipments'."""
    return f"{count} {word if count == 1 else (plural or word + 's')}"


def _latest(ctx: Ctx, agent: str, kind: str) -> dict:
    """Handoff: read the newest decision of `agent`/`kind` in this run from the graph."""
    for d in reversed(memory.decisions(ctx.g, ctx.run_id)):
        if d["agent"] == agent and d["kind"] == kind:
            return d
    raise StateError(f"no {agent}/{kind} decision in run {ctx.run_id}")


def _closed_hubs(ctx: Ctx, alert_id: str) -> list[dict]:
    rows = ctx.g.query("MATCH (:Decision {id: $d})-[:EVIDENCE]->(e:Event)-[:AFFECTS]->(h:Hub) RETURN h.id, h.name",
                       {"d": alert_id}).result_set
    return [{"id": i, "name": n} for i, n in rows]


# ---- 1. Sentinel ---------------------------------------------------------------------------
def sentinel(ctx: Ctx):
    g = ctx.g
    name, start, end, backlog = g.query(
        "MATCH (e:Event {id: $e}) RETURN e.name, e.start_day, e.end_day, e.backlog_days",
        {"e": ctx.event_id}).result_set[0]
    hubs = g.query("MATCH (:Event {id: $e})-[:AFFECTS]->(h:Hub) RETURN h.id, h.name", {"e": ctx.event_id}).result_set
    ranking = {h: (i + 1, score) for i, (h, _n, _k, score) in enumerate(fs.chokepoints(g, 200))}
    hits = fs.hits(g, ctx.event_id)
    worst_hub, worst_name = min(hubs, key=lambda h: ranking.get(h[0], (999, 0))[0])
    rank, score = ranking.get(worst_hub, (None, 0))
    names = " and ".join(n for _i, n in hubs)
    summary = (f"{names} shut {_day(start)} to {_day(end)}, plus {backlog} days of backlog. "
               f"{worst_name} is our number {rank} chokepoint by betweenness. "
               f"{len(hits)} shipments pass through it inside that window.")
    memory.add_decision(
        g, ctx.run_id, "sentinel", "alert", summary,
        numbers={"chokepoint_rank": rank, "betweenness": round(score, 1), "direct_hits": len(hits),
                 "backlog_days": backlog, "start": to_date(start).isoformat(), "end": to_date(end).isoformat()},
        evidence={"Event": [ctx.event_id], "Hub": [h for h, _ in hubs], "Shipment": list(hits)})

    past = memory.recall(g, ctx.event_id)
    if past:
        top = past[0]
        verdict = "it paid off" if top["worked"] else "it did not pay off"
        summary = (f"Seen something like this {len(past)} times before. Closest: {top['event_name']} "
                   f"({date.fromisoformat(top['when']).strftime('%b %Y')}, {top['why_similar']}). "
                   f"We {lower_first(top['action'])} and {verdict}: spent {_usd(top['cost_usd'])}, "
                   f"saved {_usd(top['saved_usd'])}.")
        memory.add_decision(
            g, ctx.run_id, "sentinel", "recall", summary,
            numbers={"similar_runs": len(past), "cost_usd": top["cost_usd"], "saved_usd": top["saved_usd"]},
            evidence={"Run": [p["run_id"] for p in past], "Event": [p["event_id"] for p in past]})


def lower_first(s: str) -> str:
    return s[:1].lower() + s[1:] if s else s


# ---- 2. Impact Analyst ---------------------------------------------------------------------
def impact_analyst(ctx: Ctx):
    g = ctx.g
    alert = _latest(ctx, "sentinel", "alert")
    event_id = g.query("MATCH (:Decision {id: $d})-[:EVIDENCE]->(e:Event) RETURN e.id",
                       {"d": alert["id"]}).result_set[0][0]
    rows = fs.cascade(g, event_id, DEPTH)
    clusters = fs.clusters(g, event_id, DEPTH)
    penalty = sum(r[6] for r in rows)
    far = sum(1 for r in rows if r[4] >= 3)
    roots = sorted({s for c in clusters for s in c["roots"]})
    top = sorted(rows, key=lambda r: -r[6])[:25]
    summary = (f"{len(rows)} promises break, worth {_usd(penalty)} in late penalties. "
               f"{far} of them sit 3 or more hops away from the port. "
               f"They split into {_count(len(clusters), 'independent cluster')}, all traced to "
               f"{_count(len(roots), 'root shipment')}.")
    did = memory.add_decision(
        g, ctx.run_id, "impact_analyst", "impact", summary,
        numbers={"promises_at_risk": len(rows), "penalty_usd": penalty, "far_promises": far,
                 "max_hops": max((r[4] for r in rows), default=0), "clusters": len(clusters), "roots": len(roots)},
        evidence={"Event": [event_id], "Hub": [h["id"] for h in _closed_hubs(ctx, alert["id"])],
                  "Shipment": roots, "Promise": [r[0] for r in top]})
    memory.write_clusters(g, did, ctx.run_id, clusters)


# ---- 3. Rerouter ---------------------------------------------------------------------------
def rerouter(ctx: Ctx):
    g = ctx.g
    impact = _latest(ctx, "impact_analyst", "impact")
    alert = _latest(ctx, "sentinel", "alert")
    closed_hubs = _closed_hubs(ctx, alert["id"])
    closed = [h["id"] for h in closed_hubs]
    roots = [r[0] for r in g.query(
        "MATCH (:Decision {id: $d})-[:FOUND]->(:Cluster)-[:ROOT]->(s:Shipment) RETURN DISTINCT s.id",
        {"d": impact["id"]}).result_set]
    hit = fs.hits(g, ctx.event_id)
    options, stuck = [], []
    for root in roots:
        h = hit[root]
        if h["direction"] == "FROM":  # already inside the closed port: nothing can move it
            stuck.append(root)
            continue
        start = max(TODAY_DAY, h["leg_depart_day"])
        seen = set()
        for by, label in (("cost", "cheapest"), ("days", "fastest")):
            for route in fs.reroute(g, h["leg_from"], h["destination"], closed, by, k=1):
                key = tuple(route["hubs"])
                if key in seen:
                    continue
                seen.add(key)
                # +1 day of dwell at each intermediate hub, which the lane graph does not include.
                new_eta = start + route["days"] + max(0, len(route["hubs"]) - 2)
                residual = max(0, new_eta - h["eta_day"])
                if residual >= h["d0"]:
                    continue  # no faster than waiting for the port to reopen
                options.append({"root": root, "option": label, "hubs": route["hubs"], "modes": route["modes"],
                                "days": route["days"], "usd_per_kg": route["usd_per_kg"],
                                "cost_usd": round(h["weight_kg"] * route["usd_per_kg"]),
                                "start_day": start, "new_eta_day": new_eta, "residual_delay": residual})
    with_opts = sorted({o["root"] for o in options})
    route_hubs = sorted({x for o in options for x in o["hubs"]})
    summary = (f"Found {_count(len(options), 'route')} around {' and '.join(h['name'] for h in closed_hubs)} for {len(with_opts)} of "
               f"{_count(len(roots), 'root shipment')}, each faster than waiting for the port to reopen.")
    if stuck:
        summary += (f" {_count(len(stuck), 'root shipment')} {'is' if len(stuck) == 1 else 'are'} already inside "
                    f"the closed port and can only wait.")
    did = memory.add_decision(
        g, ctx.run_id, "rerouter", "reroute", summary,
        numbers={"options": len(options), "roots_with_options": len(with_opts), "roots_stuck": len(stuck),
                 "roots": len(roots)},
        evidence={"Shipment": roots, "Hub": route_hubs})
    memory.write_route_options(g, did, ctx.run_id, options)


# ---- 4. Finance ----------------------------------------------------------------------------
def finance(ctx: Ctx):
    g = ctx.g
    impact = _latest(ctx, "impact_analyst", "impact")
    reroute = _latest(ctx, "rerouter", "reroute")
    alert = _latest(ctx, "sentinel", "alert")
    clusters = g.query("MATCH (:Decision {id: $d})-[:FOUND]->(c:Cluster)-[:ROOT]->(s:Shipment) "
                       "RETURN c.n, c.penalty_usd, collect(s.id) ORDER BY c.n", {"d": impact["id"]}).result_set
    opt_rows = g.query("""
        MATCH (:Decision {id: $d})-[:PROPOSES]->(o:RouteOption)-[:FOR]->(s:Shipment)
        RETURN o.id, o.root, o.option, o.modes, o.cost_usd, o.residual_delay, s.weight_kg""",
                       {"d": reroute["id"]}).result_set
    opts: dict[str, dict[str, dict]] = {}
    for oid, root, label, modes, cost, residual, weight in opt_rows:
        opts.setdefault(root, {})[label] = {"id": oid, "modes": modes, "cost": cost, "residual": residual,
                                            "weight": weight}

    # Procedural memory: a playbook that failed before changes what we are willing to try.
    pbs = {p["id"]: p for p in memory.playbooks(g, ctx.event_id)}
    air_pb = pbs.get(AIR_PLAYBOOK)
    avoid_air = bool(air_pb and air_pb["uses"] and air_pb["successes"] / air_pb["uses"] < 0.5)
    ruled_out_ids: set[str] = set()

    def allowed(o):
        if avoid_air and "air" in o["modes"] and o["weight"] >= FULL_CONTAINER_KG:
            ruled_out_ids.add(o["id"])
            return False
        return True

    base = fs.cascade(g, ctx.event_id, DEPTH)
    base_pen = sum(r[6] for r in base)
    chosen: dict[str, dict] = {}
    for _n, _pen, roots in clusters:
        best, best_net = None, 0.0
        for prefer in ("cheapest", "fastest"):
            plan = {}
            for root in roots:
                cand = [o for o in (opts.get(root, {}).get(prefer), opts.get(root, {}).get(
                    "fastest" if prefer == "cheapest" else "cheapest")) if o and allowed(o)]
                if cand:
                    plan[root] = cand[0]
            if not plan:
                continue
            after = fs.cascade_whatif(g, ctx.event_id, DEPTH, {r: o["residual"] for r, o in plan.items()})
            net = (base_pen - sum(r[6] for r in after)) - sum(o["cost"] for o in plan.values())
            if net > best_net:
                best, best_net = plan, net
        if best:
            chosen.update(best)

    after = fs.cascade_whatif(g, ctx.event_id, DEPTH, {r: o["residual"] for r, o in chosen.items()})
    pen_after = sum(r[6] for r in after)
    cost = sum(o["cost"] for o in chosen.values())
    saved = base_pen - pen_after
    rescued_clusters = sum(1 for _n, _p, roots in clusters if any(r in chosen for r in roots))
    by_air = sum(1 for o in chosen.values() if "air" in o["modes"])
    if chosen:
        summary = (f"Rescue {_count(len(chosen), 'root shipment')} ({len(chosen) - by_air} by sea, {by_air} by air) "
                   f"in {rescued_clusters} of {_count(len(clusters), 'cluster')} for {_usd(cost)}. Late penalties drop from "
                   f"{_usd(base_pen)} to {_usd(pen_after)}, saving {_usd(saved)} and putting "
                   f"{_count(len(base) - len(after), 'promise')} back on time.")
        if rescued_clusters < len(clusters):
            summary += f" Leave the other {_count(len(clusters) - rescued_clusters, 'cluster')} alone: rescue costs more than it saves."
    else:
        summary = (f"No reroute saves more than it costs. Keep all {len(base)} affected customers informed "
                   f"instead; expected penalties stay at {_usd(base_pen)}.")
    ruled_out = len(ruled_out_ids)
    if avoid_air and ruled_out:
        summary += (f" Memory: {air_pb['action']} worked {air_pb['successes']} of {air_pb['uses']} times "
                    f"before, so air freight for full containers was ruled out.")
    alert_hubs = [h["id"] for h in _closed_hubs(ctx, alert["id"])]
    chosen_hubs = [r[0] for r in g.query("UNWIND $ids AS x MATCH (o:RouteOption {id: x}) UNWIND o.hubs AS h "
                                          "RETURN DISTINCT h", {"ids": [o["id"] for o in chosen.values()]}).result_set]
    did = memory.add_decision(
        g, ctx.run_id, "finance", "plan", summary, status="proposed", requires_approval=True,
        numbers={"penalty_before": base_pen, "penalty_after": pen_after, "saved_usd": saved, "cost_usd": cost,
                 "net_usd": saved - cost, "promises_before": len(base), "promises_after": len(after),
                 "promises_saved": len(base) - len(after), "roots_rescued": len(chosen),
                 "clusters_rescued": rescued_clusters, "clusters_total": len(clusters),
                 "air_options_ruled_out_by_memory": ruled_out},
        evidence={"Event": [ctx.event_id], "Hub": alert_hubs + chosen_hubs, "Shipment": list(chosen)})
    memory.choose_options(g, did, [o["id"] for o in chosen.values()])


# ---- 5. Verifier ---------------------------------------------------------------------------
def verifier(ctx: Ctx):
    g = ctx.g
    impact = _latest(ctx, "impact_analyst", "impact")
    plan = _latest(ctx, "finance", "plan")
    alert = _latest(ctx, "sentinel", "alert")
    closed = {h["id"] for h in _closed_hubs(ctx, alert["id"])}
    checks: list[tuple[str, bool]] = []

    rows = fs.cascade(g, ctx.event_id, DEPTH)
    checks.append(("impact recomputed", len(rows) == impact["numbers"]["promises_at_risk"]
                   and sum(r[6] for r in rows) == impact["numbers"]["penalty_usd"]))
    cl_total = g.query("MATCH (:Decision {id: $d})-[:FOUND]->(c:Cluster) RETURN sum(c.promises_at_risk)",
                       {"d": impact["id"]}).result_set[0][0] or 0
    checks.append(("clusters add up to the impact", cl_total == len(rows)))

    chosen = g.query("""
        MATCH (:Decision {id: $d})-[:CHOOSES]->(o:RouteOption)-[:FOR]->(s:Shipment)
        RETURN o.root, o.hubs, o.modes, o.residual_delay, o.cost_usd, s.weight_kg, o.usd_per_kg""",
                     {"d": plan["id"]}).result_set
    after = fs.cascade_whatif(g, ctx.event_id, DEPTH, {r[0]: r[3] for r in chosen})
    checks.append(("plan recomputed", sum(r[6] for r in after) == plan["numbers"]["penalty_after"]
                   and len(after) == plan["numbers"]["promises_after"]))
    checks.append(("cost recomputed", sum(r[4] for r in chosen) == plan["numbers"]["cost_usd"]))
    hit = fs.hits(g, ctx.event_id)
    for root, hubs, modes, _res, cost, weight, usd in chosen:
        checks.append((f"{root} really is hit by the closure", root in hit))
        pairs = [[hubs[i], hubs[i + 1], modes[i]] for i in range(len(hubs) - 1)]
        walked = g.query("UNWIND $pairs AS p MATCH (a:Hub {id: p[0]})-[l:LANE]->(b:Hub {id: p[1]}) "
                         "WHERE l.mode = p[2] RETURN count(*)", {"pairs": pairs}).result_set[0][0]
        checks.append((f"{root} route re-walked lane by lane", walked == len(pairs)))
        checks.append((f"{root} route avoids closed hubs", not (set(hubs) & closed)))
    passed = sum(ok for _c, ok in checks)
    failed = [c for c, ok in checks if not ok]
    ok = not failed
    memory.set_decision_status(g, plan["id"], "verified" if ok else "blocked")
    summary = (f"{passed} of {len(checks)} checks passed. Re-ran the impact and the plan in Cypher and re-walked "
               f"{len(chosen)} rescue routes lane by lane.")
    summary += " The plan is cleared for human approval." if ok else f" Blocked: {'; '.join(failed[:3])}."
    memory.add_decision(
        g, ctx.run_id, "verifier", "verification", summary, status="info",
        numbers={"checks": len(checks), "passed": passed, "failed": len(failed)},
        evidence={"Shipment": [r[0] for r in chosen], "Hub": sorted({h for r in chosen for h in r[1]})})


# ---- 6. Comms (after a human approves) -------------------------------------------------------
def comms(ctx: Ctx):
    g = ctx.g
    plan = _latest(ctx, "finance", "plan")
    chosen = g.query("MATCH (:Decision {id: $d})-[:CHOOSES]->(o:RouteOption) RETURN o.root, o.residual_delay",
                     {"d": plan["id"]}).result_set
    base = fs.cascade(g, ctx.event_id, DEPTH)
    after = fs.cascade_whatif(g, ctx.event_id, DEPTH, {r: d for r, d in chosen})
    late_ids = {r[0] for r in after}
    saved = [r for r in base if r[0] not in late_ids]
    ev_name = g.query("MATCH (e:Event {id: $e}) RETURN e.name", {"e": ctx.event_id}).result_set[0][0]

    sample = _sample_customer(g, after, base)
    summary = (f"{len(saved)} customers are back on time after the rescue and need no message. "
               f"Drafted {_count(len(after), 'apology message')} with a credit for promises still "
               f"{min((r[5] for r in after), default=0)} to {max((r[5] for r in after), default=0)} days late.")
    message = None
    if sample:
        message = (f"Hi {sample['first']}, your order {sample['order']} was promised for {sample['due']}. "
                   f"It was caught in a disruption ({ev_name}) and will now arrive on {sample['new_date']}, "
                   f"{sample['days_late']} days late. We are sorry, and we have added a credit to your account.")
    did = memory.add_decision(
        g, ctx.run_id, "comms", "message", summary, status="info", explanation=message or summary,
        numbers={"messages": len(after), "promises_saved": len(saved),
                 "max_days_late": max((r[5] for r in after), default=0)},
        evidence={"Promise": ([sample["promise"]] if sample else []) + [r[0] for r in after[:10]]})
    if sample:
        _pool.submit(_draft_message, g, did, sample, ev_name, message)

    # Episodic + procedural memory: what we expect this plan to achieve, and which playbook it used.
    num = plan["numbers"]
    memory.record_outcome(g, plan["id"], f"Expected: {num['promises_saved']} promises saved for {_usd(num['cost_usd'])}",
                          num["cost_usd"], num["saved_usd"], num["promises_saved"], worked=num["net_usd"] > 0,
                          expected=True)
    modes = g.query("MATCH (:Decision {id: $d})-[:CHOOSES]->(o:RouteOption) RETURN o.modes", {"d": plan["id"]}).result_set
    if modes and all("air" not in m[0] for m in modes):
        memory.upsert_playbook(g, SEA_PLAYBOOK, "port_closure", "A transshipment port shuts for a few days",
                               "Reroute cluster root shipments by sea through a neighbouring port",
                               worked=num["net_usd"] > 0, decision_id=plan["id"])


def _sample_customer(g, after: list[tuple], base: list[tuple]) -> dict | None:
    """Prefer the demo persona if she is still late; else the latest-running promise."""
    if not after:
        return None
    details = fs.promise_details(g, [r[0] for r in after])
    rows = {r[0]: r for r in after}
    pick = next((p for p in details.values() if p["customer"] == "Aisha Rahman"), None) or max(
        details.values(), key=lambda p: rows[p["promise"]][5])
    late = rows[pick["promise"]]
    return {"promise": pick["promise"], "first": pick["customer"].split()[0], "order": pick["order"],
            "due": _day(pick["due_day"]), "new_date": _day(pick["due_day"] + late[5]), "days_late": late[5]}


# ---- orchestration -------------------------------------------------------------------------
PIPELINE = [sentinel, impact_analyst, rerouter, finance, verifier]


def start_run(g, event_id: str, requested_by: str, explain: bool = True) -> str:
    run_id = memory.create_run(g, event_id, requested_by)
    ctx = Ctx(g, run_id, event_id)
    try:
        for step in PIPELINE:
            step(ctx)
        memory.set_run_status(g, run_id, "awaiting_approval")
    except Exception:
        memory.set_run_status(g, run_id, "failed")
        raise
    if explain:
        _pool.submit(_explain_run, g, run_id)
    return run_id


def _find(g, run_id: str, decision_id: str) -> tuple[dict, dict]:
    run = memory.get_run(g, run_id, with_memory=False)
    if run is None:
        raise KeyError(run_id)
    dec = next((d for d in run["decisions"] if d["id"] == decision_id), None)
    if dec is None:
        raise KeyError(decision_id)
    return run, dec


def approve(g, run_id: str, decision_id: str, by: str):
    run, dec = _find(g, run_id, decision_id)
    if by.strip().casefold() == run["requested_by"].strip().casefold():
        raise PolicyError("you can't approve your own request")
    if not dec["requires_approval"] or dec["status"] != "verified":
        raise StateError(f"decision is {dec['status']}, only verified plans can be approved")
    memory.set_decision_status(g, decision_id, "approved", by)
    try:
        comms(Ctx(g, run_id, run["event_id"]))
    except Exception:
        memory.set_run_status(g, run_id, "failed")
        raise
    memory.set_run_status(g, run_id, "done")


def reject(g, run_id: str, decision_id: str, by: str):
    run, dec = _find(g, run_id, decision_id)
    if not dec["requires_approval"] or dec["status"] not in ("verified", "blocked", "proposed"):
        raise StateError(f"decision is {dec['status']}")
    memory.set_decision_status(g, decision_id, "rejected", by)
    memory.set_run_status(g, run_id, "done")


# ---- wording (background, optional) --------------------------------------------------------
def _facts(d: dict) -> str:
    return d["summary"] + "\n" + "\n".join(f"{k}: {v}" for k, v in d["numbers"].items())


def _explain_run(g, run_id: str):
    try:
        for d in memory.decisions(g, run_id):
            if d["explanation_source"] == "template" and d["kind"] != "message":
                _pool.submit(_explain_one, g, d)
    except Exception:
        log.exception("explain run %s", run_id)


def _explain_one(g, d: dict):
    text, source = llm.rewrite(
        f"You are the {d['agent'].replace('_', ' ')} agent. Explain this update to an operations manager in "
        "2 or 3 plain sentences: what you found and why it matters for customers. A plan is a proposal that "
        "still needs human approval: describe it as proposed, never as already done.", _facts(d), d["summary"])
    if source == "gemini":
        memory.set_explanation(g, d["id"], text, source)


def _draft_message(g, decision_id: str, sample: dict, ev_name: str, fallback: str):
    facts = (f"Customer first name: {sample['first']}\nOrder: {sample['order']}\nPromised date: {sample['due']}\n"
             f"New expected date: {sample['new_date']}\nDays late: {sample['days_late']}\nCause: {ev_name}\n"
             "Remedy: a credit has been added to the customer's account")
    text, source = llm.rewrite("Write a short, warm, honest delivery-delay message to this customer (max 70 words).",
                               facts, fallback)
    if source == "gemini":
        memory.set_explanation(g, decision_id, text, source)
