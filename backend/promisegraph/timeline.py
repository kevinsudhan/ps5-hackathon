"""Dates for the order timeline view (frontend/src/components/OrderTimeline.tsx). FalkorDB only.

Owned by the order-timeline work. Routes are mounted from api.py via `router`.

The "why is X's order late" answer says how late each step of the chain is (its rows). This endpoint
adds the planned calendar behind those rows, straight from the graph: each shipment's legs and dates,
the FEEDS buffers between them, the disruption window and the promise. It computes no delay of its
own; the view draws the rows' numbers on top of these planned dates.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Query

from . import falkor_store as fs
from .config import EPOCH, graph_name

router = APIRouter()

MAX_SHIPMENTS = 16      # why_late walks at most 12 FEEDS hops, so 13 shipments
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")

EVENT = """
MATCH (e:Event {id: $event})
OPTIONAL MATCH (e)-[:AFFECTS]->(h:Hub)
RETURN e.id, e.name, e.type, e.start_day, e.end_day, e.backlog_days, collect([h.id, h.name, h.kind])
"""

LEGS = """
UNWIND $ids AS x MATCH (s:Shipment {id: x}) WITH s
MATCH (s)-[:USES]->(l:Leg) WITH s, l
MATCH (l)-[:FROM]->(a:Hub), (l)-[:TO]->(b:Hub)
OPTIONAL MATCH (l)-[:OPERATED_BY]->(c:Carrier)
RETURN s.id, s.stage, s.mode, s.description, s.depart_day, s.eta_day,
       l.seq, l.mode, l.depart_day, l.arrive_day, a.id, a.name, a.kind, b.id, b.name, b.kind, c.name
ORDER BY s.id, l.seq
"""

FEEDS = """
UNWIND $pairs AS pr MATCH (a:Shipment {id: pr[0]}) WITH a, pr
MATCH (a)-[f:FEEDS]->(b:Shipment {id: pr[1]})
RETURN a.id, b.id, f.buffer_days
"""

# Same WITH barriers as falkor_store.PROMISE_DETAILS: seek the Promise by index first.
PROMISE = """
MATCH (p:Promise {id: $pid}) WITH p
MATCH (o:Order)-[:HAS_PROMISE]->(p) WITH p, o
MATCH (c:Customer)-[:PLACED]->(o)
OPTIONAL MATCH (o)-[:FULFILLED_BY]->(s:Shipment)
RETURN p.id, p.due_day, p.due_date, p.penalty_per_day, p.status, o.id, o.placed_day, c.name, c.city, collect(s.id)
"""


def _graph(tenant: str):
    db = fs.connect()
    if graph_name(tenant) not in db.list_graphs():
        raise HTTPException(404, f"unknown tenant {tenant!r}")
    return db.select_graph(graph_name(tenant))


def _ids(raw: str) -> list[str]:
    ids = [x.strip() for x in raw.split(",") if x.strip()]
    if not ids or len(ids) > MAX_SHIPMENTS or not all(_ID.match(x) for x in ids):
        raise HTTPException(422, f"shipments must be 1-{MAX_SHIPMENTS} comma-separated ids")
    return ids


def _hub(i, name, kind) -> dict:
    return {"id": i, "name": name, "kind": kind}


def _touches(legs: list[dict], ev: dict) -> list[dict]:
    """Where a shipment's planned legs meet a closed hub inside the closure window (as in the cascade
    queries: a leg arriving at it, or leaving it, between start_day and end_day). `start_delay` is the
    delay the cascade gives that touch; the view only uses it to check the rows."""
    closed = {h["id"] for h in ev["hubs"]}
    out = []
    for lg in legs:
        for direction, hub, day in (("arrives", lg["to"], lg["arrive_day"]), ("leaves", lg["from"], lg["depart_day"])):
            if hub["id"] in closed and ev["start_day"] <= day <= ev["end_day"]:
                out.append({"seq": lg["seq"], "direction": direction, "hub": hub["id"], "day": day,
                            "start_delay": ev["end_day"] + ev["backlog_days"] - day + 1})
    return out


@router.get("/api/{tenant}/timeline")
def timeline(tenant: str, event_id: str, shipments: str = Query(..., description="comma-separated, in chain order"),
             order: str = Query(..., description="the promise id (order_ref in the why_late rows)")):
    """Planned dates for one why_late chain: the disruption window, each shipment's legs, the FEEDS
    buffers between consecutive shipments and the customer's promise. Days are integers from `epoch`."""
    ids = _ids(shipments)
    if not _ID.match(event_id) or not _ID.match(order):
        raise HTTPException(422, "bad event_id or order")
    g = _graph(tenant)

    res = g.ro_query(EVENT, {"event": event_id}).result_set
    if not res:
        raise HTTPException(404, f"unknown event {event_id!r}")
    i, name, typ, start, end, backlog, hubs = res[0]
    ev = {"id": i, "name": name, "type": typ, "start_day": start, "end_day": end, "backlog_days": backlog,
          "hubs": sorted((_hub(*h) for h in hubs if h[0] is not None), key=lambda h: h["id"])}

    by_id: dict[str, dict] = {}
    for (sid, stage, mode, desc, dep, eta, seq, lmode, ldep, larr,
         a_id, a_name, a_kind, b_id, b_name, b_kind, carrier) in g.ro_query(LEGS, {"ids": ids}).result_set:
        s = by_id.setdefault(sid, {"id": sid, "stage": stage, "mode": mode, "description": desc,
                                   "depart_day": dep, "eta_day": eta, "legs": []})
        s["legs"].append({"seq": seq, "mode": lmode, "depart_day": ldep, "arrive_day": larr,
                          "from": _hub(a_id, a_name, a_kind), "to": _hub(b_id, b_name, b_kind), "carrier": carrier})
    missing = [x for x in ids if x not in by_id]
    if missing:
        raise HTTPException(404, f"unknown shipments {missing}")
    chain = [by_id[x] for x in ids]
    for s in chain:
        s["touches"] = _touches(s["legs"], ev)

    pairs = [[a, b] for a, b in zip(ids, ids[1:])]
    feeds = [{"src": a, "dst": b, "buffer_days": buf}
             for a, b, buf in (g.ro_query(FEEDS, {"pairs": pairs}).result_set if pairs else [])]

    res = g.ro_query(PROMISE, {"pid": order}).result_set
    if not res:
        raise HTTPException(404, f"unknown promise {order!r}")
    pid, due_day, due_date, per_day, status, oid, placed, customer, city, fulfilled = res[0]
    promise = {"id": pid, "due_day": due_day, "due_date": due_date, "penalty_per_day": per_day, "status": status,
               "order": oid, "placed_day": placed, "customer": customer, "city": city,
               "shipments": sorted(fulfilled)}

    return {"epoch": EPOCH.isoformat(), "event": ev, "shipments": chain, "feeds": feeds, "promise": promise}
