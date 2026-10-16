"""FalkorDB: the product's database. Loading, plus every query the product depends on.

One isolated graph per tenant (shipper company): `promise_<tenant>`.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict

from falkordb import FalkorDB

from .config import FALKOR_HOST, FALKOR_PASSWORD, FALKOR_PORT, FALKOR_USERNAME, graph_name
from .datagen import Dataset

BATCH = 5000

INDEXES = [
    ("Hub", "id"), ("Carrier", "id"), ("Customer", "id"), ("Order", "id"), ("Promise", "id"),
    ("Promise", "status"), ("Shipment", "id"), ("Shipment", "stage"), ("Leg", "id"), ("Event", "id"),
    ("Customer", "name"), ("Customer", "city"), ("Promise", "due_day"),
]


def ensure_indexes(g):
    """Create any missing index on an existing graph (idempotent)."""
    have = {(r[0], r[1]) for r in g.query(
        "CALL db.indexes() YIELD label, properties UNWIND properties AS p RETURN label, p").result_set}
    for label, prop in INDEXES:
        if (label, prop) not in have:
            g.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")


def connect() -> FalkorDB:
    return FalkorDB(host=FALKOR_HOST, port=FALKOR_PORT, username=FALKOR_USERNAME, password=FALKOR_PASSWORD)


def graph(tenant: str, db: FalkorDB | None = None):
    return (db or connect()).select_graph(graph_name(tenant))


def _batched(g, query: str, rows: list[dict]):
    for i in range(0, len(rows), BATCH):
        g.query(query, {"rows": rows[i:i + BATCH]})


def load(ds: Dataset, db: FalkorDB | None = None) -> float:
    """Drop and rebuild the tenant graph. Returns seconds taken."""
    t0 = time.perf_counter()
    db = db or connect()
    name = graph_name(ds.tenant)
    if name in db.list_graphs():
        db.select_graph(name).delete()
    g = db.select_graph(name)
    for label, prop in INDEXES:
        g.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")

    # Nodes
    _batched(g, "UNWIND $rows AS r CREATE (:Hub {id:r.id, name:r.name, kind:r.kind, country:r.country, "
                "lat:r.lat, lon:r.lon, region:r.region})", ds.hubs)
    _batched(g, "UNWIND $rows AS r CREATE (:Carrier {id:r.id, name:r.name, mode:r.mode})", ds.carriers)
    _batched(g, "UNWIND $rows AS r CREATE (:Customer {id:r.id, name:r.name, tier:r.tier, city:r.city})",
             ds.customers)
    _batched(g, "UNWIND $rows AS r CREATE (:Order {id:r.id, placed_day:r.placed_day, value_usd:r.value_usd, "
                "family:r.family, channel:r.channel})", ds.orders)
    _batched(g, "UNWIND $rows AS r CREATE (:Promise {id:r.id, due_day:r.due_day, due_date:r.due_date, "
                "status:r.status, penalty_per_day:r.penalty_per_day})", ds.promises)
    _batched(g, "UNWIND $rows AS r CREATE (:Shipment {id:r.id, stage:r.stage, tier:r.tier, mode:r.mode, "
                "family:r.family, description:r.description, weight_kg:r.weight_kg, value_usd:r.value_usd, "
                "depart_day:r.depart_day, eta_day:r.eta_day})", ds.shipments)
    _batched(g, "UNWIND $rows AS r CREATE (:Leg {id:r.id, seq:r.seq, mode:r.mode, depart_day:r.depart_day, "
                "arrive_day:r.arrive_day})", ds.legs)
    _batched(g, "UNWIND $rows AS r CREATE (:Event {id:r.id, type:r.type, name:r.name, start_day:r.start_day, "
                "end_day:r.end_day, backlog_days:r.backlog_days, severity:r.severity, historic:r.historic})",
             ds.events)

    # Edges
    _batched(g, "UNWIND $rows AS r MATCH (a:Hub {id:r.src}), (b:Hub {id:r.dst}) "
                "CREATE (a)-[:LANE {mode:r.mode, days:r.days, cost_per_kg:r.cost_per_kg}]->(b)", ds.lanes)
    _batched(g, "UNWIND $rows AS r MATCH (c:Customer {id:r.id}), (z:Hub {id:r.zone}) "
                "CREATE (c)-[:LOCATED_IN]->(z)", ds.customers)
    _batched(g, "UNWIND $rows AS r MATCH (c:Customer {id:r.customer_id}), (o:Order {id:r.id}) "
                "CREATE (c)-[:PLACED]->(o)", ds.orders)
    _batched(g, "UNWIND $rows AS r MATCH (o:Order {id:r.order_id}), (p:Promise {id:r.id}) "
                "CREATE (o)-[:HAS_PROMISE]->(p)", ds.promises)
    _batched(g, "UNWIND $rows AS r MATCH (o:Order {id:r.order_id}), (s:Shipment {id:r.shipment_id}) "
                "CREATE (o)-[:FULFILLED_BY]->(s)", ds.fulfilled_by)
    _batched(g, "UNWIND $rows AS r MATCH (s:Shipment {id:r.shipment_id}), (l:Leg {id:r.id}), "
                "(a:Hub {id:r.from_hub}), (b:Hub {id:r.to_hub}), (c:Carrier {id:r.carrier_id}) "
                "CREATE (s)-[:USES]->(l), (l)-[:FROM]->(a), (l)-[:TO]->(b), (l)-[:OPERATED_BY]->(c)", ds.legs)
    _batched(g, "UNWIND $rows AS r MATCH (a:Shipment {id:r.src}), (b:Shipment {id:r.dst}) "
                "CREATE (a)-[:FEEDS {buffer_days:r.buffer_days}]->(b)", ds.feeds)
    _batched(g, "UNWIND $rows AS r MATCH (e:Event {id:r.event_id}), (h:Hub {id:r.hub_id}) "
                "CREATE (e)-[:AFFECTS]->(h)", ds.affects)
    return time.perf_counter() - t0


# ---------------------------------------------------------------------------------------
# The queries the product depends on. Each one is documented in docs/queries.md.
# ---------------------------------------------------------------------------------------

def _check_depth(depth: int) -> int:
    # Cypher cannot take a variable-length bound as a parameter, so it is formatted in.
    # Force it to a small int so nothing else can ever be formatted into the query.
    depth = int(depth)
    if not 0 <= depth <= 12:
        raise ValueError("depth must be 0..12")
    return depth


# Q1. Cascade impact: which active promises does this event break, by how many days,
# and how many FEEDS hops away from the disruption are they?
#
# Step 1 finds legs that arrive at / depart from a closed hub inside the closure window.
# It uses two single-type pattern comprehensions instead of one `<-[:FROM|TO]-` pattern:
# same answer, but a multi-type traversal measured ~16x slower here (21 ms vs 1.3 ms on
# 20k orders). Shipments are then re-bound by ID() before the variable-length step: without
# that, nodes that came out of a list + aggregation silently return zero FEEDS paths
# (engine bug A, bench/NOTES.md #2; scripts/parity.py catches it, scripts/repro_falkordb.py shows it).
_DELAYS = """
MATCH (e:Event {{id: $event}})-[:AFFECTS]->(h:Hub)
WITH e, [(h)<-[:TO]-(l:Leg) WHERE l.arrive_day >= e.start_day AND l.arrive_day <= e.end_day | [l, l.arrive_day]]
      + [(h)<-[:FROM]-(l:Leg) WHERE l.depart_day >= e.start_day AND l.depart_day <= e.end_day | [l, l.depart_day]]
      AS touches
UNWIND touches AS touch
WITH e, touch[0] AS l, touch[1] AS t
MATCH (l)<-[:USES]-(s0:Shipment)
WITH ID(s0) AS sid, max(e.end_day + e.backlog_days - t + 1) AS d0
MATCH (s0) WHERE ID(s0) = sid
MATCH p = (s0)-[:FEEDS*0..{depth}]->(s:Shipment)
WITH s, length(p) AS hops,
     reduce(d = d0, f IN relationships(p) |
            CASE WHEN d > f.buffer_days THEN d - f.buffer_days ELSE 0 END) AS delay
WHERE delay > 0
WITH s, max(delay) AS delay, min(hops) AS hops
"""

CASCADE = _DELAYS + """
MATCH (s)<-[:FULFILLED_BY]-(o:Order)-[:HAS_PROMISE]->(pr:Promise {{status: 'active'}})
WITH pr, o, s, delay, hops, s.eta_day + delay - pr.due_day AS days_late
WHERE days_late > 0
RETURN pr.id, o.id, s.id, delay, hops, days_late, days_late * pr.penalty_per_day
"""

# Q2. Every shipment the event delays (late promise or not), with delay and distance.
IMPACTED = _DELAYS + "RETURN s.id, delay, hops"


def cascade(g, event_id: str, depth: int) -> list[tuple]:
    res = g.query(CASCADE.format(depth=_check_depth(depth)), {"event": event_id})
    return sorted(tuple(r) for r in res.result_set)


def cascade_query_text(depth: int) -> str:
    return CASCADE.format(depth=_check_depth(depth))


def impacted(g, event_id: str, depth: int) -> list[tuple]:
    res = g.query(IMPACTED.format(depth=_check_depth(depth)), {"event": event_id})
    return sorted(tuple(r) for r in res.result_set)


# Q1b. What-if cascade: Q1 again, but some directly-hit shipments get a new starting delay
# (e.g. 0 or 1 day after a reroute). Finance prices plans with this, so "how much does the
# rescue save" is also answered by Cypher, not by Python arithmetic or the LLM.
_OVERRIDE = ("WITH s0, coalesce(head([i IN range(0, size($ov_ids) - 1) WHERE $ov_ids[i] = s0.id "
             "| $ov_delays[i]]), d0) AS d0\n")
WHATIF = CASCADE.replace("MATCH p = (s0)", _OVERRIDE + "MATCH p = (s0)", 1)


def cascade_whatif(g, event_id: str, depth: int, overrides: dict[str, int]) -> list[tuple]:
    params = {"event": event_id, "ov_ids": list(overrides), "ov_delays": [int(v) for v in overrides.values()]}
    res = g.query(WHATIF.format(depth=_check_depth(depth)), params)
    return sorted(tuple(r) for r in res.result_set)


# Q6. Direct hits: which leg of which shipment touches a closed hub inside the closure window,
# where the goods are coming from, where the shipment must end up, and the starting delay.
HITS = """
MATCH (e:Event {id: $event})-[:AFFECTS]->(h:Hub)
WITH e, h, [(h)<-[:TO]-(l:Leg) WHERE l.arrive_day >= e.start_day AND l.arrive_day <= e.end_day
            | [l, l.arrive_day, 'TO']]
         + [(h)<-[:FROM]-(l:Leg) WHERE l.depart_day >= e.start_day AND l.depart_day <= e.end_day
            | [l, l.depart_day, 'FROM']] AS touches
UNWIND touches AS touch
WITH e, h, touch[0] AS l, touch[1] AS t, touch[2] AS direction
MATCH (l)<-[:USES]-(s:Shipment), (l)-[:FROM]->(a:Hub)
MATCH (s)-[:USES]->(last:Leg)-[:TO]->(dest:Hub)
WITH e, h, l, t, direction, s, a, last, dest ORDER BY last.seq DESC
WITH e, h, l, t, direction, s, a, collect(dest)[0] AS dest
RETURN s.id, s.stage, s.weight_kg, s.eta_day, h.id, l.id, l.seq, direction, t, l.depart_day, a.id, dest.id,
       e.end_day + e.backlog_days - t + 1 AS d0
ORDER BY s.id, l.seq
"""


# Who is behind each promise. The WITH barriers make FalkorDB seek each Promise by index first;
# written as one pattern it walked every HAS_PROMISE edge per id and timed out on ~350 ids.
PROMISE_DETAILS = """
UNWIND $ids AS pid MATCH (p:Promise {id: pid}) WITH p
MATCH (o:Order)-[:HAS_PROMISE]->(p) WITH p, o
MATCH (c:Customer)-[:PLACED]->(o)
RETURN p.id, c.name, c.city, c.tier, o.id, p.due_day, p.due_date
"""


def promise_details(g, ids: list[str]) -> dict[str, dict]:
    cols = ["promise", "customer", "city", "tier", "order", "due_day", "due_date"]
    return {r[0]: dict(zip(cols, r)) for r in g.query(PROMISE_DETAILS, {"ids": list(ids)}).result_set}


def hits(g, event_id: str) -> dict[str, dict]:
    """shipment id -> its first hit leg (lowest seq) and worst starting delay."""
    cols = ["shipment", "stage", "weight_kg", "eta_day", "hub", "leg", "seq", "direction", "day",
            "leg_depart_day", "leg_from", "destination", "d0"]
    out: dict[str, dict] = {}
    for r in g.query(HITS, {"event": event_id}).result_set:
        row = dict(zip(cols, r))
        cur = out.get(row["shipment"])
        if cur is None:
            out[row["shipment"]] = row
        else:
            cur["d0"] = max(cur["d0"], row["d0"])
    return out


# Q3. Stranded clusters. Impacted shipments are tagged with an :Impacted label (plus their
# delay and hop distance, so the FalkorDB Browser shows them), then Weakly Connected
# Components over FEEDS splits them into independent problems. Each cluster traces back to
# its own root shipments: rescue those and the whole cluster is saved.
# The tag is per-tenant scratch state, so run one analysis per tenant at a time.
#
# The promise lookup is two separate OPTIONAL MATCHes on purpose. As a single pattern (or a
# pattern comprehension) the planner started from the unbound Promise side and timed out
# after 60 s; split, it runs in ~5 ms on 20k orders.
MARK_IMPACTED = """
UNWIND $rows AS r
MATCH (s:Shipment {id: r[0]})
SET s:Impacted, s.impact_delay = r[1], s.impact_hops = r[2]
"""
CLEAR_IMPACTED = "MATCH (s:Impacted) REMOVE s:Impacted SET s.impact_delay = NULL, s.impact_hops = NULL"
CLUSTERS = """
CALL algo.WCC({nodeLabels: ['Impacted'], relationshipTypes: ['FEEDS']}) YIELD node, componentId
OPTIONAL MATCH (node)<-[:FULFILLED_BY]-(o:Order)
OPTIONAL MATCH (o)-[:HAS_PROMISE]->(pr:Promise)
WITH componentId, node,
     CASE WHEN pr.status = 'active' AND node.eta_day + node.impact_delay > pr.due_day
          THEN (node.eta_day + node.impact_delay - pr.due_day) * pr.penalty_per_day END AS penalty
RETURN componentId,
       count(node) AS shipments,
       collect(CASE WHEN node.impact_hops = 0 THEN node.id END) AS roots,
       count(penalty) AS promises_at_risk,
       sum(penalty) AS penalty_usd
ORDER BY penalty_usd DESC
"""


_TAG_LOCKS: dict[str, threading.Lock] = defaultdict(threading.Lock)


def clusters(g, event_id: str, depth: int) -> list[dict]:
    rows = impacted(g, event_id, depth)
    with _TAG_LOCKS[g.name]:  # the :Impacted tag is shared scratch state inside one tenant graph
        g.query(CLEAR_IMPACTED)
        g.query(MARK_IMPACTED, {"rows": [list(h) for h in rows]})
        res = g.query(CLUSTERS)
    cols = ["cluster", "shipments", "roots", "promises_at_risk", "penalty_usd"]
    return [dict(zip(cols, r)) for r in res.result_set]


# Q4. Chokepoints: hubs that the most shortest routes depend on (Sentinel, before anything breaks).
# samplingSize above the hub count makes it exact; the default samples only 32 source hubs.
CHOKEPOINTS = """
CALL algo.betweenness({nodeLabels: ['Hub'], relationshipTypes: ['LANE'], samplingSize: 100000}) YIELD node, score
RETURN node.id, node.name, node.kind, score ORDER BY score DESC LIMIT $k
"""


def chokepoints(g, k: int = 10) -> list[tuple]:
    return [tuple(r) for r in g.query(CHOKEPOINTS, {"k": k}).result_set]


# Q5. Reroutes: k shortest lane paths from where the goods are to where they must go,
# discarding any path through a closed hub. weight = 'days' (fastest) or 'cost_per_kg' (cheapest).
REROUTE = """
MATCH (a:Hub {{id: $src}}), (b:Hub {{id: $dst}})
CALL algo.SPpaths({{sourceNode: a, targetNode: b, relTypes: ['LANE'], weightProp: '{weight}',
                   costProp: '{cost}', pathCount: 20, maxLen: 7}})
YIELD path, pathWeight, pathCost
WITH path, pathWeight, pathCost WHERE none(n IN nodes(path) WHERE n.id IN $closed)
RETURN [n IN nodes(path) | n.id] AS hubs, [r IN relationships(path) | r.mode] AS modes,
       pathWeight, pathCost
ORDER BY pathWeight LIMIT $k
"""


def reroute(g, src: str, dst: str, closed: list[str], by: str = "days", k: int = 3) -> list[dict]:
    weight, cost = {"days": ("days", "cost_per_kg"), "cost": ("cost_per_kg", "days")}[by]
    res = g.query(REROUTE.format(weight=weight, cost=cost), {"src": src, "dst": dst, "closed": closed, "k": k})
    out = []
    for hubs, modes, w, c in res.result_set:
        days, usd = (w, c) if by == "days" else (c, w)
        out.append({"hubs": hubs, "modes": modes, "days": days, "usd_per_kg": round(usd, 2)})
    return out
