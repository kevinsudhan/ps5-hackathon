"""Graph-shaped reads for the UI: the impact subgraph (3D view), one promise's chain back to the
disruption ("Why?"), and the evidence behind an agent decision. Shapes follow docs/api-contract.md.

Every node and link returned here is a real node or relationship (or a direct summary of a
FEEDS path) in the tenant graph; nothing is invented for display.
"""
from __future__ import annotations

from . import falkor_store as fs
from .config import to_date

DEPTH = 8


def _iso(day: int | None) -> str | None:
    return to_date(day).isoformat() if day is not None else None


def _hub_nodes(g, ids, closed=frozenset()) -> dict[str, dict]:
    rows = g.query("UNWIND $ids AS x MATCH (h:Hub {id: x}) RETURN h.id, h.name, h.kind, h.country, h.lat, h.lon",
                   {"ids": list(ids)}).result_set
    return {i: {"id": i, "type": "hub", "name": n, "kind": k, "country": c, "lat": la, "lon": lo,
                "closed": i in closed} for i, n, k, c, la, lo in rows}


def _shipment_nodes(g, ids) -> dict[str, dict]:
    rows = g.query("UNWIND $ids AS x MATCH (s:Shipment {id: x}) RETURN s.id, s.stage, s.mode, s.description, s.eta_day",
                   {"ids": list(ids)}).result_set
    return {i: {"id": i, "type": "shipment", "name": i, "stage": st, "mode": m, "description": d, "eta": _iso(eta)}
            for i, st, m, d, eta in rows}


def _event_nodes(g, ids) -> dict[str, dict]:
    rows = g.query("UNWIND $ids AS x MATCH (e:Event {id: x}) RETURN e.id, e.name, e.start_day, e.end_day",
                   {"ids": list(ids)}).result_set
    return {i: {"id": i, "type": "event", "name": n, "start": _iso(s), "end": _iso(e)} for i, n, s, e in rows}


def _promise_nodes(g, ids, impact_rows=None) -> dict[str, dict]:
    late = {r[0]: r for r in (impact_rows or [])}
    out = {}
    for pid, d in fs.promise_details(g, ids).items():
        r = late.get(pid)
        out[pid] = {"id": pid, "type": "promise", "name": f"{d['customer']} ({d['city']})", "customer": d["customer"],
                    "city": d["city"], "due_date": d["due_date"],
                    "days_late": r[5] if r else 0, "penalty_usd": r[6] if r else 0}
    return out


def _closed_hubs(g, event_id: str) -> list[str]:
    return [r[0] for r in g.query("MATCH (:Event {id: $e})-[:AFFECTS]->(h:Hub) RETURN h.id", {"e": event_id}).result_set]


def _leg_hubs(g, shipment_ids) -> dict[str, list[str]]:
    rows = g.query("""
        UNWIND $ids AS x MATCH (s:Shipment {id: x}) WITH s
        MATCH (s)-[:USES]->(l:Leg) WITH s, l
        MATCH (l)-[:FROM]->(a:Hub) WITH s, l, a
        MATCH (l)-[:TO]->(b:Hub)
        RETURN s.id, collect(DISTINCT a.id) + collect(DISTINCT b.id)""", {"ids": list(shipment_ids)}).result_set
    return {i: list(dict.fromkeys(h)) for i, h in rows}


def _feeds(g, shipment_ids) -> list[tuple]:
    rows = g.query("""
        UNWIND $ids AS x MATCH (a:Shipment {id: x}) WITH a
        MATCH (a)-[f:FEEDS]->(b:Shipment) RETURN a.id, b.id, f.buffer_days""", {"ids": list(shipment_ids)}).result_set
    return [tuple(r) for r in rows]


def _fulfils(g, shipment_ids) -> list[tuple]:
    rows = g.query("""
        UNWIND $ids AS x MATCH (s:Shipment {id: x}) WITH s
        MATCH (o:Order)-[:FULFILLED_BY]->(s) WITH s, o
        MATCH (o)-[:HAS_PROMISE]->(p:Promise) RETURN s.id, p.id""", {"ids": list(shipment_ids)}).result_set
    return [tuple(r) for r in rows]


# ---- 3D view: everything one disruption touches --------------------------------------------
def subgraph(g, event_id: str, depth: int = DEPTH, limit: int = 1500) -> dict:
    impacted = {sid: (delay, hops) for sid, delay, hops in fs.impacted(g, event_id, depth)}
    rows = fs.cascade(g, event_id, depth)
    closed = _closed_hubs(g, event_id)
    ships = _shipment_nodes(g, impacted)
    for sid, node in ships.items():
        node["delay"], node["hops"] = impacted[sid]
        node["root"] = impacted[sid][1] == 0

    # Budget: every non-last-mile shipment, then at-risk promises (worst first, the demo persona
    # always), then the remaining delayed last-mile shipments.
    backbone = [s for s, n in ships.items() if n["stage"] != "lastmile"]
    promises = _promise_nodes(g, [r[0] for r in rows], rows)
    persona = {p for p, n in promises.items() if n["customer"] == "Aisha Rahman"}
    ranked = sorted(rows, key=lambda r: (r[0] not in persona, -r[6]))
    budget = max(0, limit - len(backbone) - len(closed) - 1)
    keep_rows = ranked[:budget // 2]
    keep_ship = set(backbone) | {r[2] for r in keep_rows}
    spare = budget - 2 * len(keep_rows)
    others = [s for s, n in ships.items() if n["stage"] == "lastmile" and s not in keep_ship]
    keep_ship |= set(others[:max(0, spare)])
    truncated = len(keep_rows) < len(rows) or len(keep_ship) < len(ships)

    leg_hubs = _leg_hubs(g, backbone)
    hub_ids = set(closed) | {h for hs in leg_hubs.values() for h in hs}
    nodes = {**_event_nodes(g, [event_id]), **_hub_nodes(g, hub_ids, frozenset(closed))}
    nodes.update({s: ships[s] for s in keep_ship})
    nodes.update({r[0]: promises[r[0]] for r in keep_rows})

    links = [{"source": event_id, "target": h, "type": "AFFECTS"} for h in closed]
    links += [{"source": s, "target": h, "type": "VIA"} for s, hs in leg_hubs.items() for h in hs]
    links += [{"source": a, "target": b, "type": "FEEDS", "buffer_days": buf}
              for a, b, buf in _feeds(g, backbone) if b in keep_ship]
    keep_promises = {r[0] for r in keep_rows}
    links += [{"source": s, "target": p, "type": "FULFILLS"}
              for s, p in _fulfils(g, [r[2] for r in keep_rows]) if p in keep_promises]
    return {"nodes": list(nodes.values()), "links": links, "truncated": truncated}


# ---- Why?: one promise back to the disruption ------------------------------------------------
def promise_path(g, promise_id: str, event_id: str, depth: int = DEPTH) -> dict | None:
    found = g.query("""
        MATCH (p:Promise {id: $p}) WITH p
        MATCH (o:Order)-[:HAS_PROMISE]->(p) WITH p, o
        MATCH (o)-[:FULFILLED_BY]->(s:Shipment) RETURN s.id""", {"p": promise_id}).result_set
    if not found:
        return None
    target = found[0][0]
    rows = fs.cascade(g, event_id, depth)
    promise = _promise_nodes(g, [promise_id], rows)[promise_id]
    hits = fs.hits(g, event_id)
    paths = g.query(f"""
        MATCH (s:Shipment {{id: $s}}) WITH s
        MATCH p = (r:Shipment)-[:FEEDS*0..{int(depth)}]->(s) WHERE r.id IN $roots
        RETURN [n IN nodes(p) | n.id], [f IN relationships(p) | f.buffer_days]""",
                    {"s": target, "roots": list(hits)}).result_set
    best = None
    for ids, bufs in paths:
        d, trail = hits[ids[0]]["d0"], [hits[ids[0]]["d0"]]
        for b in bufs:
            d = max(0, d - b)
            trail.append(d)
        key = (d, -len(ids))
        if best is None or key > best[0]:
            best = (key, ids, bufs, trail)
    if best is None or best[0][0] == 0:
        return {"promise": promise_id, "links": [],
                "steps": [{"node": promise, "delay_days": 0, "text": "This promise is not affected by this disruption."}]}

    _key, ids, bufs, trail = best
    root = hits[ids[0]]
    ev = _event_nodes(g, [event_id])[event_id]
    hub = _hub_nodes(g, [root["hub"]], frozenset([root["hub"]]))[root["hub"]]
    ships = _shipment_nodes(g, ids)
    origins = {r[0]: r[1] for r in g.query("""
        UNWIND $ids AS x MATCH (s:Shipment {id: x}) WITH s
        MATCH (s)-[:USES]->(l:Leg {seq: 1}) WITH s, l MATCH (l)-[:FROM]->(h:Hub) RETURN s.id, h.name""",
                                           {"ids": ids}).result_set}
    backlog = g.query("MATCH (e:Event {id: $e}) RETURN e.backlog_days", {"e": event_id}).result_set[0][0]
    verb = "is due into" if root["direction"] == "TO" else "is due to leave"
    steps = [
        {"node": ev, "delay_days": None,
         "text": f"{ev['name']}: closed {ev['start']} to {ev['end']}, then {backlog} days of backlog."},
        {"node": hub, "delay_days": None, "text": f"{hub['name']} is shut."},
        {"node": {**ships[ids[0]], "delay": trail[0], "root": True}, "delay_days": trail[0],
         "text": f"{ids[0]} ({ships[ids[0]]['description']}) {verb} {hub['name']} on {_iso(root['day'])}, "
                 f"inside the closure. It starts {trail[0]} days late."},
    ]
    for i in range(1, len(ids)):
        sid, buf, d = ids[i], bufs[i - 1], trail[i]
        where = origins.get(sid, "the next stop")
        slack = (f"No slack at {where}, so" if buf == 0 else
                 f"{buf} day{'s' if buf != 1 else ''} of slack at {where} absorb{'s' if buf == 1 else ''} part of it, so")
        steps.append({"node": {**ships[sid], "delay": d}, "delay_days": d,
                      "text": f"{slack} {sid} ({ships[sid]['description']}) leaves {d} days late."})
    steps.append({"node": promise, "delay_days": trail[-1],
                  "text": f"{promise['customer']} was promised delivery by {promise['due_date']}. It now lands "
                          f"{promise['days_late']} days late (${promise['penalty_usd']:,} penalty)."
                  if promise["days_late"] else
                  f"{promise['customer']} was promised delivery by {promise['due_date']}; the slack still covers it."})
    links = [{"source": event_id, "target": hub["id"], "type": "AFFECTS"},
             {"source": ids[0], "target": hub["id"], "type": "VIA"}]
    links += [{"source": ids[i], "target": ids[i + 1], "type": "FEEDS", "buffer_days": bufs[i]}
              for i in range(len(ids) - 1)]
    links.append({"source": ids[-1], "target": promise_id, "type": "FULFILLS"})
    return {"promise": promise_id, "steps": steps, "links": links}


# ---- evidence behind a decision ---------------------------------------------------------------
def evidence(g, decision_id: str) -> dict | None:
    rows = g.query("""
        MATCH (d:Decision {id: $d}) OPTIONAL MATCH (d)-[:EVIDENCE]->(n)
        RETURN d.run_id, labels(n)[0], n.id""", {"d": decision_id}).result_set
    if not rows:
        return None
    run_id = rows[0][0]
    by_label: dict[str, list[str]] = {}
    for _r, label, nid in rows:
        if label:
            by_label.setdefault(label, []).append(nid)
    event_id = g.query("MATCH (r:Run {id: $r}) RETURN r.event_id", {"r": run_id}).result_set[0][0]
    closed = set(_closed_hubs(g, event_id))
    # Past runs (memory recall) are shown through the events they were about.
    if by_label.get("Run"):
        by_label.setdefault("Event", []).extend(r[0] for r in g.query(
            "UNWIND $ids AS x MATCH (r:Run {id: x}) RETURN r.event_id", {"ids": by_label["Run"]}).result_set)

    events = set(by_label.get("Event", []))
    ships = set(by_label.get("Shipment", []))
    hubs = set(by_label.get("Hub", []))
    promises = set(by_label.get("Promise", []))
    rows_impact = fs.cascade(g, event_id, DEPTH) if promises else []
    nodes = {**_event_nodes(g, events), **_hub_nodes(g, hubs, frozenset(closed)), **_shipment_nodes(g, ships),
             **_promise_nodes(g, promises, rows_impact)}

    links = []
    for eid, hid in g.query("UNWIND $ids AS x MATCH (e:Event {id: x}) WITH e MATCH (e)-[:AFFECTS]->(h:Hub) "
                            "RETURN e.id, h.id", {"ids": list(events)}).result_set:
        if hid in hubs:
            links.append({"source": eid, "target": hid, "type": "AFFECTS"})
    # Chosen or proposed reroutes: shipment -> each hub on its new route.
    route_links = g.query("""
        MATCH (d:Decision {id: $d})-[:CHOOSES|PROPOSES]->(o:RouteOption) WITH o
        MATCH (o)-[:FOR]->(s:Shipment) RETURN s.id, o.hubs""", {"d": decision_id}).result_set
    seen = set()
    for sid, route in route_links:
        for h in route:
            if h in hubs and (sid, h) not in seen:
                seen.add((sid, h))
                links.append({"source": sid, "target": h, "type": "VIA"})
    for sid, hs in _leg_hubs(g, ships).items():
        for h in hs:
            if h in hubs and (sid, h) not in seen:
                seen.add((sid, h))
                links.append({"source": sid, "target": h, "type": "VIA"})
    links += [{"source": a, "target": b, "type": "FEEDS", "buffer_days": buf}
              for a, b, buf in _feeds(g, ships) if b in ships]
    links += [{"source": s, "target": p, "type": "FULFILLS"} for s, p in _fulfils(g, ships) if p in promises]
    return {"nodes": list(nodes.values()), "links": links, "truncated": False}
