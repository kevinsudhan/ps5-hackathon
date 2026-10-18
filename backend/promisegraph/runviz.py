"""The agent run as a graph (frontend/src/components/AgentRunGraph.tsx). FalkorDB only.

GET /api/{tenant}/runs/{run_id}/graph returns the subgraph the agents wrote for one run, read back
with the Cypher below (also returned as `queries`, for the "How this is drawn" toggle):

  handoffs  (:Decision)-[:NEXT]->(:Decision) inside the run, one card per agent
  reads     EVIDENCE edges, the past runs the Sentinel recalled, the playbooks Finance used
            (USED_MEMORY), and the nodes an agent read from the previous agent's decision
            (agents.py: the Rerouter reads the Impact Analyst's clusters, Finance its options...)
  writes    FOUND clusters, PROPOSES / CHOOSES route options, APPROVED_BY a person, and what
            Comms wrote back: the expected Outcome and the playbook it FOLLOWED

Every number is a node property or a count; nothing here is computed beyond adding up.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException

from . import falkor_store as fs
from . import memory
from .config import graph_name, to_date

router = APIRouter()

RUN = """
MATCH (p:Person)-[:REQUESTED]->(r:Run {id: $run})-[:ABOUT]->(e:Event)
RETURN r.status, r.memory, r.created_at, p.name, e.id, e.name, e.type, e.start_day, e.end_day, e.backlog_days
"""
CLOSED = "MATCH (:Run {id: $run})-[:ABOUT]->(:Event)-[:AFFECTS]->(h:Hub) RETURN h.id, h.name"

# The handoff chain: every decision the agents wrote in this run, in order, and who wrote it.
CHAIN = """
MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision)<-[:MADE]-(a:Agent)
RETURN d.id, a.id, a.name, d.kind, d.seq, d.summary, d.status, d.requires_approval, d.numbers, d.ms, d.memory
ORDER BY d.seq
"""

# Everything each decision points at: evidence, clusters found, routes proposed and chosen,
# memory used, the approval, the outcome, the next decision in the chain.
EDGES = """
MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision)-[rel]->(n)
WHERE type(rel) <> 'PART_OF'
RETURN d.id, type(rel), labels(n)[0], count(n), collect(coalesce(n.id, n.name))
"""

CLUSTERS = """
MATCH (:Run {id: $run})<-[:PART_OF]-(:Decision {kind: 'impact'})-[:FOUND]->(c:Cluster)-[:ROOT]->(s:Shipment)
RETURN c.id, c.n, c.shipments, c.promises_at_risk, c.penalty_usd, collect(s.id)
ORDER BY c.n
"""

ROUTES = """
MATCH (:Run {id: $run})<-[:PART_OF]-(:Decision {kind: 'reroute'})-[:PROPOSES]->(o:RouteOption)-[:FOR]->(s:Shipment)
RETURN o.id, o.root, o.option, o.hubs, o.modes, o.days, o.cost_usd, o.residual_delay, s.description, s.weight_kg
ORDER BY o.root, o.option
"""

# Episodic memory: the past runs the Sentinel's recall decision points at, and how each turned out.
EPISODIC = """
MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision {kind: 'recall'})-[:EVIDENCE]->(past:Run)-[:ABOUT]->(e:Event)
MATCH (past)<-[:PART_OF]-(plan:Decision {kind: 'plan'})-[:RESULTED_IN]->(o:Outcome)
RETURN d.id, past.id, e.name, e.start_day, plan.summary, o.summary, o.worked, o.cost_usd, o.saved_usd, past.requested_by
ORDER BY e.start_day DESC
"""

# Procedural memory: the playbooks Finance applied, with their track record and whether it changed the plan.
PROCEDURAL = """
MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision)-[u:USED_MEMORY]->(p:Playbook)
RETURN d.id, p.id, p.trigger, p.action, p.uses, p.successes, u.realization, u.effect
"""

PEOPLE = """
MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision)-[a:APPROVED_BY|REJECTED_BY]->(p:Person)
RETURN d.id, type(a), p.name, a.at
"""

OUTCOMES = """
MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision)-[:RESULTED_IN]->(o:Outcome)
RETURN d.id, o.summary, o.cost_usd, o.saved_usd, o.promises_saved, o.worked, o.expected
"""

HUB_NAMES = "MATCH (h:Hub) WHERE h.id IN $ids RETURN h.id, h.name"

HABIT_NAMES = {"PB-AIR-FULL-CONTAINER": "Air freight for full containers",
               "PB-SEA-NEIGHBOUR": "Sea reroutes through a neighbouring port"}

# What an agent reads from the previous agents' decisions without an edge of its own (agents.py):
# the Rerouter queries the Impact Analyst's FOUND clusters, Finance those clusters and the
# Rerouter's PROPOSES options, the Verifier the clusters and the plan's CHOOSES, Comms the CHOOSES.
HANDOFF_READS = {
    "rerouter": [("groups", "the stranded groups the Impact analyst found")],
    "finance": [("groups", "the stranded groups the Impact analyst found"),
                ("routes", "the route options the Rerouter proposed")],
    "verifier": [("groups", "the stranded groups, to check they add up"),
                 ("routes", "the chosen routes, re-walked lane by lane")],
    "comms": [("routes", "the routes the approved plan chose"), ("promises", "the promises still late")],
}


def _graph(tenant: str):
    db = fs.connect()
    if graph_name(tenant) not in db.list_graphs():
        raise HTTPException(404, f"unknown tenant {tenant!r}")
    return db.select_graph(graph_name(tenant))


def _iso(day: int | None) -> str | None:
    return to_date(day).isoformat() if day is not None else None


def _count(n: int, word: str, plural: str | None = None) -> str:
    return f"{n:,} {word if n == 1 else (plural or word + 's')}"


@router.get("/api/{tenant}/runs/{run_id}/graph")
def run_graph(tenant: str, run_id: str):
    g = _graph(tenant)
    p = {"run": run_id}
    head = g.query(RUN, p).result_set
    if not head:
        raise HTTPException(404, f"unknown run {run_id!r}")
    status, mem, created_at, requested_by, eid, ename, etype, start, end, backlog = head[0]
    closed = [{"id": i, "name": n} for i, n in g.query(CLOSED, p).result_set]
    closed_ids = {h["id"] for h in closed}

    steps = []
    for did, agent, aname, kind, seq, summary, st, ra, nums, ms, dmem in g.query(CHAIN, p).result_set:
        steps.append({"id": did, "agent": agent, "agent_name": aname, "kind": kind, "seq": seq, "summary": summary,
                      "status": st, "requires_approval": bool(ra), "numbers": json.loads(nums or "{}"), "ms": ms,
                      "memory_changed": bool(json.loads(dmem).get("changed")) if dmem else None,
                      "evidence": {}, "next": None})
    by_id = {s["id"]: s for s in steps}

    edges = g.query(EDGES, p).result_set
    hub_ids = {x for _d, rel, label, _n, ids in edges if label == "Hub" for x in ids}

    # Route options, with hub names instead of codes.
    routes_raw = g.query(ROUTES, p).result_set
    hub_ids |= {h for r in routes_raw for h in r[3]}
    names = {i: n for i, n in g.query(HUB_NAMES, {"ids": sorted(hub_ids)}).result_set} if hub_ids else {}
    chosen = {x for _d, rel, _l, _n, ids in edges if rel == "CHOOSES" for x in ids}
    routes = []
    for oid, _root, option, hubs, modes, days, cost, residual, desc, weight in routes_raw:
        via = [names.get(h, h) for h in hubs[1:-1]]
        routes.append({"key": oid, "option": option, "what": desc, "from": names.get(hubs[0], hubs[0]),
                       "to": names.get(hubs[-1], hubs[-1]), "via": via, "air": "air" in modes,
                       "modes": sorted(set(modes)), "days": days, "cost_usd": cost, "residual_delay": residual,
                       "weight_kg": weight, "chosen": oid in chosen})

    clusters = []
    for cid, n, ships, promises, penalty, roots in g.query(CLUSTERS, p).result_set:
        clusters.append({"n": n, "shipments": ships, "promises_at_risk": promises, "penalty_usd": penalty,
                         "roots": len(roots), "rescued": any(r[0] in chosen and r[1] in roots for r in routes_raw)})

    # Memory the agents read.
    recalled = {r["run_id"]: r for r in memory.recall(g, eid)} if mem != "off" else {}
    episodic = []
    for rdid, prun, pname, pstart, action, outcome, worked, cost, saved, req in g.query(EPISODIC, p).result_set:
        extra = recalled.get(prun, {})
        episodic.append({"key": f"past:{prun}", "read_by": rdid, "event_name": pname, "when": _iso(pstart),
                         "why_similar": extra.get("why_similar"), "action": action, "outcome": outcome,
                         "worked": bool(worked), "cost_usd": cost or 0, "saved_usd": saved or 0,
                         "requested_by": req, "approved_by": extra.get("approved_by")})

    followed = {x: d for d, rel, _l, _n, ids in edges if rel == "FOLLOWED" for x in ids}
    outcomes = g.query(OUTCOMES, p).result_set
    own_outcome = next((o for o in outcomes if o[6]), None)   # expected: true, the forecast Comms wrote
    procedural, seen = [], set()
    for pdid, pid, trigger, action, uses, wins, realization, effect in g.query(PROCEDURAL, p).result_set:
        seen.add(pid)
        procedural.append(_playbook(pid, trigger, action, uses, wins, pid in followed, own_outcome,
                                    read_by=pdid, realization=realization, effect=effect))
    for pb in (memory.playbooks(g, eid) if mem != "off" else []):
        if pb["id"] not in seen:   # applies to this disruption, but no option of its kind came up
            procedural.append(_playbook(pb["id"], pb["trigger"], pb["action"], pb["uses"], pb["successes"],
                                        pb["id"] in followed, own_outcome))
    procedural.sort(key=lambda x: (x["effect"] is None, x["effect"] != "changed", x["key"]))

    # People and what Comms wrote back.
    approval = {"requested_by": requested_by, "approved_by": None, "rejected_by": None, "at": None}
    for _d, rel, who, at in g.query(PEOPLE, p).result_set:
        approval["approved_by" if rel == "APPROVED_BY" else "rejected_by"] = who
        approval["at"] = at
    comms = next((s for s in steps if s["agent"] == "comms"), None)
    writeback = None
    if comms:
        writeback = {"messages": comms["numbers"].get("messages"), "promises_saved": comms["numbers"].get("promises_saved"),
                     "outcome": None, "playbooks": [x["key"] for x in procedural if x["followed"]]}
        if own_outcome:
            _d, summary, cost, saved, promises, worked, _e = own_outcome
            writeback["outcome"] = {"key": "new-outcome", "summary": summary, "cost_usd": cost, "saved_usd": saved,
                                    "promises_saved": promises, "worked": bool(worked)}

    # Links: what each agent read and wrote, grouped onto the drawn nodes.
    links: dict[tuple, dict] = {}

    def link(src: str, dst: str, kind: str, rel: str, count: int, words: str):
        k = (src, dst, kind)
        if k in links:
            links[k]["count"] = max(links[k]["count"], count)
            if words not in links[k]["words"]:
                links[k]["words"].append(words)
            if rel not in links[k]["rels"]:
                links[k]["rels"].append(rel)
        else:
            links[k] = {"from": src, "to": dst, "kind": kind, "rels": [rel], "count": count, "words": [words]}

    plan = next((s for s in steps if s["kind"] == "plan"), None)
    for did, rel, label, n, ids in edges:
        s = by_id.get(did)
        if s is None:
            continue
        if rel == "NEXT":
            s["next"] = ids[0] if ids else None
            continue
        if rel == "EVIDENCE":
            s["evidence"][label] = s["evidence"].get(label, 0) + n
            if label == "Event" and s["kind"] != "recall":
                link(did, "event", "read", rel, n, "the disruption")
            elif label == "Run":
                for x in ids:
                    link(did, f"past:{x}", "read", rel, 1, "a past run")
            elif label == "Hub":
                c = sum(1 for x in ids if x in closed_ids)
                if c:
                    link(did, "port", "read", rel, c, _count(c, "closed port"))
                if n - c:
                    link(did, "routes", "read", rel, n - c, _count(n - c, "hub on the routes", "hubs on the routes"))
            elif label == "Shipment":
                link(did, "shipments", "read", rel, n, _count(n, "shipment"))
            elif label == "Promise":
                link(did, "promises", "read", rel, n, _count(n, "promise"))
        elif rel == "FOUND":
            link(did, "groups", "wrote", rel, n, f"found {_count(n, 'stranded group')}")
        elif rel == "PROPOSES":
            link(did, "routes", "wrote", rel, n, f"proposed {_count(n, 'route')}")
        elif rel == "CHOOSES":
            link(did, "routes", "wrote", rel, n, f"chose {_count(n, 'route')}")
        elif rel == "USED_MEMORY":
            for x in ids:
                link(did, f"pb:{x}", "read", rel, 1, "used its track record")
        elif rel in ("RESULTED_IN", "FOLLOWED") and comms:
            # Comms writes these on the plan decision after the approval (agents.comms).
            if rel == "RESULTED_IN" and own_outcome and own_outcome[0] == did:
                link(comms["id"], "new-outcome", "wrote", rel, 1, "recorded the expected outcome")
            elif rel == "FOLLOWED":
                for x in ids:
                    link(comms["id"], f"pb:{x}", "wrote", rel, 1, "added this run to its track record")
    for s in steps:
        for dst, words in HANDOFF_READS.get(s["agent"], []):
            if s["kind"] in ("plan", "reroute", "verification", "message"):
                link(s["id"], dst, "read", "handoff", 0, words)
    if comms:
        link(comms["id"], "promises", "wrote", "message", comms["numbers"].get("messages") or 0,
             f"drafted {_count(comms['numbers'].get('messages') or 0, 'apology message')}")

    numbers = {s["kind"]: s["numbers"] for s in steps}
    world = {
        "shipments_hit": numbers.get("alert", {}).get("direct_hits"),
        "roots": numbers.get("impact", {}).get("roots"),
        "promises_at_risk": numbers.get("impact", {}).get("promises_at_risk"),
        "penalty_usd": numbers.get("impact", {}).get("penalty_usd"),
        "promises_saved": numbers.get("plan", {}).get("promises_saved"),
        "promises_after": numbers.get("plan", {}).get("promises_after"),
        "messages": numbers.get("message", {}).get("messages"),
        "clusters": clusters, "routes": routes,
    }
    return {
        "run": {"id": run_id, "status": status, "memory": mem or "on", "created_at": created_at,
                "requested_by": requested_by},
        "event": {"id": eid, "name": ename, "type": etype, "start": _iso(start), "end": _iso(end),
                  "backlog_days": backlog},
        "closed": closed, "steps": steps, "plan_status": plan["status"] if plan else None,
        "memory": {"on": (mem or "on") != "off", "episodic": episodic, "procedural": procedural},
        "world": world, "approval": approval, "writeback": writeback,
        "links": list(links.values()),
        "queries": [
            {"title": "The handoff chain: each agent's decision, in order", "cypher": CHAIN.strip()},
            {"title": "What every decision points at (read and written)", "cypher": EDGES.strip()},
            {"title": "Episodic memory: past runs the Sentinel recalled", "cypher": EPISODIC.strip()},
            {"title": "Procedural memory: playbooks Finance applied", "cypher": PROCEDURAL.strip()},
            {"title": "Stranded groups the Impact analyst found", "cypher": CLUSTERS.strip()},
            {"title": "Route options the Rerouter proposed", "cypher": ROUTES.strip()},
            {"title": "Who approved, and what Comms wrote back", "cypher": PEOPLE.strip() + "\n\n" + OUTCOMES.strip()},
        ],
    }


def _playbook(pid: str, trigger: str, action: str, uses: int, wins: int, followed: bool, own_outcome,
              read_by: str | None = None, realization: float | None = None, effect: str | None = None) -> dict:
    # When this run's approved plan followed the playbook, Comms already added it to the counts:
    # "before" is the track record as Finance read it.
    won = 1 if followed and own_outcome and own_outcome[5] else 0
    return {"key": f"pb:{pid}", "name": HABIT_NAMES.get(pid, action), "trigger": trigger, "action": action,
            "uses": uses, "successes": wins, "uses_before": uses - (1 if followed else 0),
            "successes_before": wins - won, "realization": realization, "effect": effect, "read_by": read_by,
            "followed": followed}


# ---- step by step (frontend/src/components/AgentTrace.tsx) ------------------------------------------
# What each agent asked FalkorDB, in the order agents.py runs it, with the real query text. The
# queries are the module constants the agents call (falkor_store, memory), so this cannot drift
# from what ran. `feature` names the FalkorDB capability the step leans on.
def _q(title: str, feature: str | None, cypher: str) -> dict:
    return {"title": title, "feature": feature, "cypher": cypher.strip()}


def _agent_queries(depth: int) -> dict[str, dict]:
    cascade = fs.CASCADE.format(depth=depth)
    whatif = fs.WHATIF.format(depth=depth)
    reroute = fs.REROUTE.format(weight="cost_per_kg", cost="days")
    return {
        "sentinel": {
            "asked": "Which places does this disruption shut, how much does the network depend on them, which "
                     "shipments pass through while they are shut, and have we seen anything like it before?",
            "queries": [
                _q("Rank every place by how many routes depend on it", "algo.betweenness", fs.CHOKEPOINTS),
                _q("Shipments with a leg through the closed port inside the closure", "pattern match", fs.HITS),
                _q("Recall past runs at the same port, one lane away, or of the same kind", "memory recall",
                   memory.RECALL),
            ]},
        "impact_analyst": {
            "asked": f"Starting at the shipments stuck in the port, follow everything that waits on them, up to "
                     f"{depth} steps, and keep the promises that now miss their date. Then split them into groups "
                     f"that do not depend on each other.",
            "queries": [
                _q("Follow the delay along FEEDS and keep the broken promises", "variable-length FEEDS traversal",
                   cascade),
                _q("Split the delayed shipments into independent groups", "algo.WCC", fs.CLUSTERS),
            ]},
        "rerouter": {
            "asked": "For the shipment at the root of each group, find the cheapest and the fastest way from where the "
                     "goods are to where they must go, never through the closed port.",
            "queries": [
                _q("Read the groups and their root shipments the Impact analyst wrote", "handoff",
                   "MATCH (:Decision {id: $impact})-[:FOUND]->(:Cluster)-[:ROOT]->(s:Shipment) RETURN DISTINCT s.id"),
                _q("Shortest lane paths that avoid the closed port", "algo.SPpaths", reroute),
            ]},
        "finance": {
            "asked": "What does each option cost, how much late penalty would it save, and how well did this kind of "
                     "move work the last times we tried it?",
            "queries": [
                _q("Learned habits that apply to this kind of disruption", "memory recall", memory.PLAYBOOKS),
                _q("Their track record: what past plans expected vs what they actually saved", "memory recall",
                   memory.TRACK_RECORD),
                _q("Re-run the cascade as if the chosen shipments were rescued", "variable-length FEEDS traversal",
                   whatif),
            ]},
        "verifier": {
            "asked": "Re-run the impact and the plan from scratch, check the groups add up, and walk every rescue route "
                     "lane by lane to be sure it exists and avoids the closed port.",
            "queries": [
                _q("Re-run the impact", "variable-length FEEDS traversal", cascade),
                _q("Re-walk each chosen route lane by lane", "pattern match",
                   "UNWIND $pairs AS p MATCH (a:Hub {id: p[0]})-[l:LANE]->(b:Hub {id: p[1]})\n"
                   "WHERE l.mode = p[2] RETURN count(*)"),
            ]},
        "comms": {
            "asked": "With the approved plan, which customers are still late and by how much? Then write the expected "
                     "outcome and the playbook update back into memory.",
            "queries": [
                _q("Promises still late after the rescue", "variable-length FEEDS traversal", whatif),
                _q("Who is behind each late promise", "pattern match", fs.PROMISE_DETAILS),
                _q("Write the expected outcome on the plan", "memory write",
                   "MATCH (d:Decision {id: $d})\nCREATE (o:Outcome {id: $id, summary: $summary, cost_usd: $cost, "
                   "saved_usd: $saved,\n  promises_saved: $promises, worked: $worked, expected: true})\n"
                   "CREATE (d)-[:RESULTED_IN]->(o)"),
            ]},
    }


@router.get("/api/{tenant}/runs/{run_id}/trace")
def run_trace(tenant: str, run_id: str):
    from .agents import DEPTH
    g = _graph(tenant)
    p = {"run": run_id}
    if not g.query("MATCH (r:Run {id: $run}) RETURN r.id", p).result_set:
        raise HTTPException(404, f"unknown run {run_id!r}")
    # Extra ids worth lighting up per decision, beyond its EVIDENCE: the groups' root shipments, and
    # the shipments and hubs of the routes proposed or chosen.
    extra: dict[str, set] = {}
    for did, sid in g.query(
            "MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision)-[:FOUND]->(:Cluster)-[:ROOT]->(s:Shipment) "
            "RETURN d.id, s.id", p).result_set:
        extra.setdefault(did, set()).add(sid)
    for did, sid, hubs in g.query(
            "MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision)-[:PROPOSES|CHOOSES]->(o:RouteOption)-[:FOR]->(s:Shipment) "
            "RETURN d.id, s.id, o.hubs", p).result_set:
        extra.setdefault(did, set()).update([sid, *hubs])
    return {"run_id": run_id, "depth": DEPTH, "agents": _agent_queries(DEPTH),
            "extra_ids": {k: sorted(v) for k, v in extra.items()}}
