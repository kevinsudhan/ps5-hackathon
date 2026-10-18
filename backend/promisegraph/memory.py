"""Agent memory, stored in the tenant's graph (Track 2).

  semantic   = the world graph itself (hubs, lanes, shipments, buffers)
  episodic   = (:Run)-[:ABOUT]->(:Event), (:Decision)-[:PART_OF]->(:Run), (:Outcome)
  procedural = (:Playbook), learned from approved plans and their outcomes; its track record is
               (:Playbook)<-[:FOLLOWED]-(plan:Decision)-[:RESULTED_IN]->(:Outcome {expected: false})
  handoffs   = (:Decision)-[:NEXT]->(:Decision); each agent reads the previous agent's output
               from these nodes, not from Python variables
  influence  = (plan:Decision)-[:USED_MEMORY {realization, effect}]->(:Playbook): which learned
               habit Finance applied, and whether it changed the plan ('changed') or not ('checked')

Decisions carry their figures in `numbers` and Finance's memory reasoning in `memory` (JSON
strings; FalkorDB properties cannot be maps) and point at the nodes that justify them with
EVIDENCE edges. A run made with memory switched off (the with/without comparison) has
memory = 'off' and (twin:Run)-[:COUNTERFACTUAL_OF]->(main:Run).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

AGENTS = [
    ("sentinel", "Sentinel", "Watches disruptions and chokepoints; recalls similar past disruptions"),
    ("impact_analyst", "Impact Analyst", "Finds broken promises and stranded clusters"),
    ("rerouter", "Rerouter", "Finds alternative routes for each cluster's root shipments"),
    ("finance", "Finance", "Prices every option and proposes the plan"),
    ("verifier", "Verifier", "Re-runs every query and re-walks every evidence path"),
    ("comms", "Comms", "Drafts customer messages from the approved plan"),
]
EVIDENCE_LABELS = ["Event", "Hub", "Shipment", "Promise", "Run"]
INDEXES = [("Agent", "id"), ("Person", "name"), ("Run", "id"), ("Decision", "id"), ("Cluster", "id"),
           ("RouteOption", "id"), ("Outcome", "id"), ("Playbook", "id")]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"


def ensure_schema(g):
    existing = {(r[0], r[1]) for r in g.query(
        "CALL db.indexes() YIELD label, properties UNWIND properties AS p RETURN label, p").result_set}
    for label, prop in INDEXES:
        if (label, prop) not in existing:
            g.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
    g.query("UNWIND $rows AS r MERGE (a:Agent {id: r[0]}) SET a.name = r[1], a.role = r[2]",
            {"rows": [list(a) for a in AGENTS]})


# ---- writes -------------------------------------------------------------------------------

def create_run(g, event_id: str, requested_by: str, run_id: str | None = None,
               created_at: str | None = None, use_memory: bool = True,
               counterfactual_of: str | None = None) -> str:
    run_id = run_id or new_id("RUN")
    res = g.query("""
        MATCH (e:Event {id: $event})
        MERGE (p:Person {name: $by})
        CREATE (r:Run {id: $id, event_id: $event, status: 'running', requested_by: $by, created_at: $at,
                       memory: $memory})
        CREATE (r)-[:ABOUT]->(e), (p)-[:REQUESTED]->(r)
        RETURN r.id""", {"event": event_id, "by": requested_by, "id": run_id, "at": created_at or now_iso(),
                         "memory": "on" if use_memory else "off"})
    if not res.result_set:
        raise KeyError(f"unknown event {event_id}")
    if counterfactual_of:
        g.query("MATCH (t:Run {id: $t}), (m:Run {id: $m}) CREATE (t)-[:COUNTERFACTUAL_OF]->(m)",
                {"t": run_id, "m": counterfactual_of})
    return run_id


def set_run_status(g, run_id: str, status: str):
    g.query("MATCH (r:Run {id: $id}) SET r.status = $s", {"id": run_id, "s": status})


def add_decision(g, run_id: str, agent: str, kind: str, summary: str, *, numbers: dict | None = None,
                 evidence: dict[str, list[str]] | None = None, status: str = "info",
                 requires_approval: bool = False, explanation: str | None = None,
                 created_at: str | None = None, memory_info: dict | None = None) -> str:
    """Write a Decision, chain it after the run's latest decision, link agent and evidence."""
    did = new_id("DEC")
    prev = g.query("MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision) RETURN d.id, d.seq ORDER BY d.seq DESC LIMIT 1",
                   {"run": run_id}).result_set
    seq = prev[0][1] + 1 if prev else 1
    g.query("""
        MATCH (r:Run {id: $run}), (a:Agent {id: $agent})
        CREATE (d:Decision {id: $id, run_id: $run, agent: $agent, kind: $kind, summary: $summary,
                            explanation: $explanation, explanation_source: 'template', status: $status,
                            requires_approval: $ra, numbers: $numbers, seq: $seq, created_at: $at,
                            memory: $memory})
        CREATE (d)-[:PART_OF]->(r), (a)-[:MADE]->(d)""",
            {"run": run_id, "agent": agent, "id": did, "kind": kind, "summary": summary,
             "explanation": explanation or summary, "status": status, "ra": requires_approval,
             "numbers": json.dumps(numbers or {}), "seq": seq, "at": created_at or now_iso(),
             "memory": json.dumps(memory_info) if memory_info is not None else None})
    if prev:
        g.query("MATCH (p:Decision {id: $p}), (d:Decision {id: $d}) CREATE (p)-[:NEXT]->(d)",
                {"p": prev[0][0], "d": did})
    for label, ids in (evidence or {}).items():
        if label not in EVIDENCE_LABELS:
            raise ValueError(f"bad evidence label {label}")
        if ids:
            g.query(f"MATCH (d:Decision {{id: $d}}) UNWIND $ids AS x MATCH (n:{label} {{id: x}}) "
                    f"CREATE (d)-[:EVIDENCE]->(n)", {"d": did, "ids": list(dict.fromkeys(ids))})
    return did


def set_explanation(g, decision_id: str, text: str, source: str):
    g.query("MATCH (d:Decision {id: $id}) SET d.explanation = $t, d.explanation_source = $s",
            {"id": decision_id, "t": text, "s": source})


def set_decision_status(g, decision_id: str, status: str, by: str | None = None):
    g.query("MATCH (d:Decision {id: $id}) SET d.status = $s", {"id": decision_id, "s": status})
    if by and status in ("approved", "rejected"):
        rel = "APPROVED_BY" if status == "approved" else "REJECTED_BY"
        g.query(f"MATCH (d:Decision {{id: $id}}) MERGE (p:Person {{name: $by}}) "
                f"CREATE (d)-[:{rel} {{at: $at}}]->(p)", {"id": decision_id, "by": by, "at": now_iso()})


def write_clusters(g, decision_id: str, run_id: str, clusters: list[dict]):
    rows = [[f"{run_id}-C{i + 1}", i + 1, c["shipments"], c["promises_at_risk"], float(c["penalty_usd"] or 0),
             c["roots"]] for i, c in enumerate(clusters)]
    g.query("""
        MATCH (d:Decision {id: $d})
        UNWIND $rows AS r
        CREATE (c:Cluster {id: r[0], run_id: $run, n: r[1], shipments: r[2], promises_at_risk: r[3],
                           penalty_usd: r[4]})
        CREATE (d)-[:FOUND]->(c)
        WITH c, r UNWIND r[5] AS root
        MATCH (s:Shipment {id: root}) CREATE (c)-[:ROOT]->(s)""", {"d": decision_id, "run": run_id, "rows": rows})


def write_route_options(g, decision_id: str, run_id: str, options: list[dict]) -> list[str]:
    ids = []
    for o in options:
        oid = new_id("OPT")
        ids.append(oid)
        g.query("""
            MATCH (d:Decision {id: $d}), (s:Shipment {id: $root})
            CREATE (o:RouteOption {id: $id, run_id: $run, root: $root, option: $option, hubs: $hubs,
                                   modes: $modes, days: $days, usd_per_kg: $usd, cost_usd: $cost,
                                   start_day: $start, new_eta_day: $eta, residual_delay: $residual})
            CREATE (d)-[:PROPOSES]->(o), (o)-[:FOR]->(s)
            WITH o UNWIND $hubs AS hid MATCH (h:Hub {id: hid}) CREATE (o)-[:VIA]->(h)""",
                {"d": decision_id, "run": run_id, "id": oid, "root": o["root"], "option": o["option"],
                 "hubs": o["hubs"], "modes": o["modes"], "days": o["days"], "usd": o["usd_per_kg"],
                 "cost": o["cost_usd"], "start": o["start_day"], "eta": o["new_eta_day"],
                 "residual": o["residual_delay"]})
        o["id"] = oid
    return ids


def choose_options(g, decision_id: str, option_ids: list[str]):
    g.query("MATCH (d:Decision {id: $d}) UNWIND $ids AS x MATCH (o:RouteOption {id: x}) CREATE (d)-[:CHOOSES]->(o)",
            {"d": decision_id, "ids": option_ids})


def last_seq(g, run_id: str) -> int:
    res = g.query("MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision) RETURN max(d.seq)", {"run": run_id}).result_set
    return (res[0][0] or 0) if res else 0


def mark_step(g, run_id: str, after_seq: int, ms: int) -> list[str]:
    """Stamp the decisions one agent step wrote (seq > after_seq) with how long the step took."""
    return [r[0] for r in g.query(
        "MATCH (:Run {id: $run})<-[:PART_OF]-(d:Decision) WHERE d.seq > $after SET d.ms = $ms RETURN d.id ORDER BY d.seq",
        {"run": run_id, "after": after_seq, "ms": ms}).result_set]


def link_memory_use(g, decision_id: str, playbook_id: str, realization: float, effect: str):
    """(plan)-[:USED_MEMORY]->(playbook): Finance applied this habit's track record ('changed' or 'checked')."""
    g.query("MATCH (d:Decision {id: $d}), (p:Playbook {id: $p}) "
            "CREATE (d)-[:USED_MEMORY {realization: $r, effect: $e}]->(p)",
            {"d": decision_id, "p": playbook_id, "r": float(realization), "e": effect})


def record_outcome(g, decision_id: str, summary: str, cost_usd: float, saved_usd: float,
                   promises_saved: int, worked: bool, expected: bool):
    g.query("""
        MATCH (d:Decision {id: $d})
        CREATE (o:Outcome {id: $id, summary: $summary, cost_usd: $cost, saved_usd: $saved,
                           promises_saved: $promises, worked: $worked, expected: $expected})
        CREATE (d)-[:RESULTED_IN]->(o)""",
            {"d": decision_id, "id": new_id("OUT"), "summary": summary, "cost": float(cost_usd),
             "saved": float(saved_usd), "promises": promises_saved, "worked": worked, "expected": expected})


def upsert_playbook(g, pid: str, event_type: str, trigger: str, action: str, worked: bool,
                    decision_id: str | None = None):
    g.query("""
        MERGE (p:Playbook {id: $id})
        ON CREATE SET p.event_type = $type, p.trigger = $trigger, p.action = $action, p.uses = 0, p.successes = 0
        SET p.uses = p.uses + 1, p.successes = p.successes + $win""",
            {"id": pid, "type": event_type, "trigger": trigger, "action": action, "win": 1 if worked else 0})
    if decision_id:
        g.query("MATCH (d:Decision {id: $d}), (p:Playbook {id: $p}) CREATE (d)-[:FOLLOWED]->(p)",
                {"d": decision_id, "p": pid})


# ---- reads --------------------------------------------------------------------------------

# Memory recall: past runs about disruptions that hit the same hub, a hub one lane away, or
# the same kind of event, with the plan that was approved and how it turned out. Only events that
# started before this one count: a later disruption is not past experience.
RECALL = """
MATCH (e:Event {id: $event})-[:AFFECTS]->(h:Hub)
OPTIONAL MATCH (h)-[:LANE]-(n:Hub)
WITH e, collect(DISTINCT h.id) AS hubs, collect(DISTINCT h.name) AS hub_names, collect(DISTINCT n.id) AS nbrs
MATCH (past:Event)<-[:ABOUT]-(r:Run)<-[:PART_OF]-(d:Decision {kind: 'plan'})
WHERE past.id <> e.id AND past.start_day < e.start_day AND d.status = 'approved'
MATCH (past)-[:AFFECTS]->(ph:Hub)
WITH e, hubs, hub_names, nbrs, past, r, d, collect(ph.id) AS phubs
WITH past, r, d,
     CASE WHEN any(x IN phubs WHERE x IN hubs) THEN 'same hub'
          WHEN any(x IN phubs WHERE x IN nbrs) THEN 'one lane away from ' + hub_names[0]
          WHEN past.type = e.type THEN 'same kind of disruption' END AS why,
     CASE WHEN any(x IN phubs WHERE x IN hubs) THEN 0
          WHEN any(x IN phubs WHERE x IN nbrs) THEN 1 ELSE 2 END AS rank
WHERE why IS NOT NULL
OPTIONAL MATCH (d)-[:RESULTED_IN]->(o:Outcome)
RETURN r.id, past.id, past.name, past.start_day, why, d.summary, o.summary, o.cost_usd, o.saved_usd, o.worked
ORDER BY rank, past.start_day DESC
"""

PLAYBOOKS = """
MATCH (e:Event {id: $event})
MATCH (p:Playbook) WHERE p.event_type = e.type OR p.event_type = 'any'
RETURN p.id, p.trigger, p.action, p.uses, p.successes ORDER BY p.uses DESC
"""


# Track record of a learned habit: every past plan that followed it and how it actually turned out.
# Expected = the saving the plan promised when it was approved; actual = the outcome. Only real
# outcomes (expected: false) count, never the forecasts the live agents record for themselves.
TRACK_RECORD = """
MATCH (p:Playbook) WHERE p.id IN $ids
MATCH (p)<-[:FOLLOWED]-(d:Decision)-[:RESULTED_IN]->(o:Outcome)
WHERE o.expected = false
MATCH (d)-[:PART_OF]->(r:Run)-[:ABOUT]->(e:Event)
RETURN p.id, p.action, p.uses, p.successes, d.id, d.numbers, o.cost_usd, o.saved_usd, o.summary, o.worked,
       r.id, e.id, e.name, e.start_day
ORDER BY e.start_day DESC
"""


def track_record(g, playbook_ids: list[str]) -> dict[str, dict]:
    """playbook id -> {realization = actual / expected saving, uses, successes, past: [...]}.
    Playbooks without a single real outcome are left out (nothing learned yet)."""
    from .config import to_date
    out: dict[str, dict] = {}
    if not playbook_ids:
        return out
    for (pid, action, uses, wins, did, nums, cost, actual, summary, worked, rid, eid, ename,
         start) in g.query(TRACK_RECORD, {"ids": list(playbook_ids)}).result_set:
        expected = json.loads(nums or "{}").get("saved_usd")
        if not expected:
            continue
        rec = out.setdefault(pid, {"id": pid, "action": action, "uses": uses, "successes": wins,
                                   "expected_usd": 0.0, "actual_usd": 0.0, "past": []})
        rec["expected_usd"] += float(expected)
        rec["actual_usd"] += float(actual or 0)
        rec["past"].append({"run_id": rid, "decision_id": did, "event_id": eid, "event_name": ename,
                            "when": to_date(start).isoformat(), "cost_usd": cost or 0, "expected_usd": expected,
                            "actual_usd": actual or 0, "outcome": summary, "worked": bool(worked)})
    for rec in out.values():
        rec["realization"] = round(rec["actual_usd"] / rec["expected_usd"], 4)
    return out


# Memory influence on one run: the learned habits its plan applied, and where each one was learned.
INFLUENCE = """
MATCH (d:Decision {run_id: $run, kind: 'plan'})-[u:USED_MEMORY]->(p:Playbook)
OPTIONAL MATCH (p)<-[:FOLLOWED]-(pd:Decision)-[:RESULTED_IN]->(o:Outcome)
WHERE o.expected = false
OPTIONAL MATCH (pd)-[:PART_OF]->(r:Run)-[:ABOUT]->(e:Event)
RETURN d.id, p.id, p.trigger, p.action, p.uses, p.successes, u.realization, u.effect,
       pd.id, pd.numbers, o.summary, o.cost_usd, o.saved_usd, o.worked, r.id, e.id, e.name, e.start_day
ORDER BY u.effect, p.id, e.start_day DESC
"""


def influence_rows(g, run_id: str) -> list[tuple]:
    return g.query(INFLUENCE, {"run": run_id}).result_set


def recall(g, event_id: str) -> list[dict]:
    from .config import to_date
    out = []
    for rid, eid, name, start, why, plan, outcome, cost, saved, worked in g.query(
            RECALL, {"event": event_id}).result_set:
        out.append({"run_id": rid, "event_id": eid, "event_name": name, "when": to_date(start).isoformat(),
                    "why_similar": why, "action": plan, "outcome": outcome or "no outcome recorded",
                    "cost_usd": cost or 0, "saved_usd": saved or 0, "worked": bool(worked)})
    # who asked and who signed off, so two runs about the same disruption are told apart
    people = {r[0]: (r[1], r[2]) for r in g.query(
        "UNWIND $ids AS x MATCH (r:Run {id: x}) "
        "OPTIONAL MATCH (:Decision {run_id: x, kind: 'plan'})-[:APPROVED_BY]->(a:Person) "
        "RETURN x, r.requested_by, a.name", {"ids": [o["run_id"] for o in out]}).result_set}
    for o in out:
        o["requested_by"], o["approved_by"] = people.get(o["run_id"], (None, None))
    return out


def playbooks(g, event_id: str) -> list[dict]:
    return [{"id": i, "trigger": t, "action": a, "uses": u, "successes": s}
            for i, t, a, u, s in g.query(PLAYBOOKS, {"event": event_id}).result_set]


def decisions(g, run_id: str) -> list[dict]:
    res = g.query("""
        MATCH (r:Run {id: $run})<-[:PART_OF]-(d:Decision)
        OPTIONAL MATCH (p:Decision)-[:NEXT]->(d)
        OPTIONAL MATCH (d)-[:EVIDENCE]->(n)
        OPTIONAL MATCH (d)-[:APPROVED_BY|REJECTED_BY]->(who:Person)
        RETURN d.id, d.agent, d.kind, d.summary, d.explanation, d.explanation_source, d.status,
               d.requires_approval, d.numbers, d.created_at, d.seq, p.id, collect(DISTINCT n.id), who.name,
               d.memory, d.ms
        ORDER BY d.seq""", {"run": run_id})
    return [{"id": i, "run_id": run_id, "agent": a, "kind": k, "summary": s, "explanation": ex,
             "explanation_source": src, "status": st, "requires_approval": bool(ra),
             "numbers": json.loads(nums or "{}"), "created_at": at, "prev": prev,
             "evidence": [x for x in ev if x], "approved_by": who,
             "memory": json.loads(mem) if mem else None, "ms": ms}
            for i, a, k, s, ex, src, st, ra, nums, at, _seq, prev, ev, who, mem, ms in res.result_set]


def get_run(g, run_id: str, with_memory: bool = True) -> dict | None:
    res = g.query("MATCH (r:Run {id: $id}) RETURN r.event_id, r.status, r.requested_by, r.created_at, r.memory",
                  {"id": run_id}).result_set
    if not res:
        return None
    event_id, status, by, at, mem = res[0]
    mem = mem or "on"
    # Two plain lookups on purpose: one query with two OPTIONAL MATCHes and a collect() over an
    # unmatched one panics this FalkorDB build (the server process dies; see docs/falkordb-bug-report.md).
    main = g.query("MATCH (:Run {id: $id})-[:COUNTERFACTUAL_OF]->(m:Run) RETURN m.id", {"id": run_id}).result_set
    twin = g.query("MATCH (t:Run)-[:COUNTERFACTUAL_OF]->(:Run {id: $id}) RETURN t.id ORDER BY t.created_at DESC LIMIT 1",
                   {"id": run_id}).result_set
    run = {"id": run_id, "event_id": event_id, "status": status, "requested_by": by, "created_at": at,
           "memory": mem, "counterfactual_of": main[0][0] if main else None,
           "counterfactual": twin[0][0] if twin else None,
           "decisions": decisions(g, run_id), "recall": [], "playbooks": []}
    if with_memory and mem == "on":
        run["recall"] = [r for r in recall(g, event_id) if r["run_id"] != run_id]
        run["playbooks"] = playbooks(g, event_id)
    return run


def list_runs(g, include_history: bool = False) -> list[dict]:
    q = "MATCH (r:Run)-[:ABOUT]->(e:Event) WHERE NOT (r)-[:COUNTERFACTUAL_OF]->() "
    if not include_history:
        q += "AND NOT coalesce(e.historic, false) "
    q += "RETURN r.id ORDER BY r.created_at DESC"
    return [get_run(g, rid) for (rid,) in g.query(q).result_set]


def delete_run(g, run_id: str):
    """Remove a run and everything it wrote (decisions, clusters, route options, outcomes)."""
    g.query("""
        MATCH (r:Run {id: $id})
        OPTIONAL MATCH (r)<-[:PART_OF]-(d:Decision)
        OPTIONAL MATCH (d)-[:FOUND|PROPOSES|RESULTED_IN]->(x)
        DETACH DELETE x, d, r""", {"id": run_id})
