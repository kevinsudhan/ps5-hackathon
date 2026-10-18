"""Coordinates for the globe view (frontend/src/components/WorldMap.tsx). FalkorDB only.

Owned by the globe/map work. Routes are mounted from api.py via `router`.

POST /api/{tenant}/geo {ids: [...], groups: {group_id: [parent ids]}} resolves every answer-graph
node id to somewhere on the map:
  hub id (SGSIN, DC-VNL, also "APT-HKG@2" from a reroute)  -> a point
  event id                                                -> the hub it closes
  shipment id                                             -> a route: the hubs its legs pass, in order
  promise / order / customer id                           -> the customer's delivery zone
  "city-<name>", "wh-<name>" (orders in a date range)     -> the hub with that name
  a group                                                 -> a spread: where the orders downstream of
                                                             its parent shipments are delivered
Ids it cannot place are simply left out; the globe draws what it can.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import falkor_store as fs
from .config import graph_name, to_date

router = APIRouter()

MAX_IDS = 600

HUBS = "UNWIND $ids AS x MATCH (h:Hub {id: x}) RETURN h.id, h.name, h.kind, h.lat, h.lon, h.country"
HUBS_BY_NAME = "UNWIND $names AS x MATCH (h:Hub {name: x}) RETURN h.name, h.id, h.kind, h.lat, h.lon"
EVENTS = ("UNWIND $ids AS x MATCH (e:Event {id: x}) WITH e "
          "MATCH (e)-[:AFFECTS]->(h:Hub) RETURN e.id, min(h.id), e.name, e.start_day, e.end_day")
# the whole network, drawn faintly behind every answer
NET_HUBS = "MATCH (h:Hub) RETURN h.id, h.name, h.kind, h.country, h.lat, h.lon ORDER BY h.id"
NET_LANES = "MATCH (a:Hub)-[l:LANE]->(b:Hub) RETURN DISTINCT a.id, b.id, l.mode"
# every leg of each shipment, in order: [from, to] per leg
LEGS = ("UNWIND $ids AS x MATCH (s:Shipment {id: x}) WITH s "
        "MATCH (s)-[:USES]->(l:Leg) WITH s, l "
        "MATCH (l)-[:FROM]->(a:Hub) WITH s, l, a "
        "MATCH (l)-[:TO]->(b:Hub) "
        "RETURN s.id, s.mode, s.stage, l.seq, a.id, b.id ORDER BY s.id, l.seq")
PROMISE_ZONE = ("UNWIND $ids AS x MATCH (p:Promise {id: x}) WITH p "
                "MATCH (o:Order)-[:HAS_PROMISE]->(p) WITH p, o "
                "MATCH (c:Customer)-[:PLACED]->(o) WITH p, c "
                "MATCH (c)-[:LOCATED_IN]->(z:Hub) RETURN p.id, z.id, c.name")
ORDER_ZONE = ("UNWIND $ids AS x MATCH (o:Order {id: x}) WITH o "
              "MATCH (c:Customer)-[:PLACED]->(o) WITH o, c "
              "MATCH (c)-[:LOCATED_IN]->(z:Hub) RETURN o.id, z.id, c.name")
CUSTOMER_ZONE = ("UNWIND $ids AS x MATCH (c:Customer {id: x}) WITH c "
                 "MATCH (c)-[:LOCATED_IN]->(z:Hub) RETURN c.id, z.id, c.name")
# where the parcels downstream of a shipment are delivered (last-mile shipments end in a zone)
DOWNSTREAM_ZONES = ("UNWIND $ids AS x MATCH (s:Shipment {id: x}) WITH s "
                    "MATCH (s)-[:FEEDS*0..8]->(lm:Shipment {stage: 'lastmile'}) WITH DISTINCT lm "
                    "MATCH (lm)-[:USES]->(l:Leg)-[:TO]->(z:Hub {kind: 'zone'}) "
                    "RETURN z.id, count(DISTINCT lm) AS n ORDER BY n DESC, z.id")


class GeoBody(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=MAX_IDS)
    groups: dict[str, list[str]] = Field(default_factory=dict)


def _graph(tenant: str):
    db = fs.connect()
    if graph_name(tenant) not in db.list_graphs():
        raise HTTPException(404, f"unknown tenant {tenant!r}")
    return db.select_graph(graph_name(tenant))


def resolve(g, ids: list[str], groups: dict[str, list[str]] | None = None) -> dict:
    ids = list(dict.fromkeys(i for i in ids if isinstance(i, str) and i))
    hubs: dict[str, dict] = {}

    def need_hubs(hub_ids):
        missing = [h for h in set(hub_ids) if h not in hubs]
        if missing:
            for hid, name, kind, lat, lon, country in g.query(HUBS, {"ids": missing}).result_set:
                if lat is not None and lon is not None:
                    hubs[hid] = {"id": hid, "name": name, "kind": kind, "lat": float(lat), "lon": float(lon),
                                 "country": country}

    base = {i: i.split("@", 1)[0] for i in ids}          # reroute stops: "APT-HKG@2" is APT-HKG
    need_hubs(base.values())
    places: dict[str, dict] = {}
    for i in ids:
        if base[i] in hubs:
            places[i] = {"type": "point", "hub": base[i]}
    rest = [i for i in ids if i not in places]

    # events -> the hub they close (and when, for the "Closed Oct 20-24" badge)
    events: dict[str, dict] = {}
    if rest:
        ev = {}
        for e, h, name, start, end in g.query(EVENTS, {"ids": rest}).result_set:
            if h:
                ev[e] = h
                events[e] = {"name": name, "hub": h, "start": to_date(int(start)).isoformat(),
                             "end": to_date(int(end)).isoformat()}
        need_hubs(ev.values())
        for e, h in ev.items():
            if h in hubs:
                places[e] = {"type": "point", "hub": h}
        rest = [i for i in rest if i not in places]

    # shipments -> their legs
    if rest:
        legs: dict[str, list] = {}
        meta: dict[str, tuple] = {}
        for sid, mode, stage, _seq, a, b in g.query(LEGS, {"ids": rest}).result_set:
            legs.setdefault(sid, []).append((a, b))
            meta[sid] = (mode, stage)
        need_hubs(h for ls in legs.values() for leg in ls for h in leg)
        for sid, ls in legs.items():
            path = [ls[0][0]] + [b for _a, b in ls]
            path = [h for k, h in enumerate(path) if h in hubs and (k == 0 or h != path[k - 1])]
            if path:
                places[sid] = {"type": "route", "hubs": path, "mode": meta[sid][0], "stage": meta[sid][1]}
        rest = [i for i in rest if i not in places]

    # promises, orders and customers -> the delivery zone
    for query in (PROMISE_ZONE, ORDER_ZONE, CUSTOMER_ZONE):
        if not rest:
            break
        found = {x: (z, who) for x, z, who in g.query(query, {"ids": rest}).result_set}
        need_hubs(z for z, _w in found.values())
        for x, (z, who) in found.items():
            if z in hubs:
                places[x] = {"type": "point", "hub": z, "customer": who}
        rest = [i for i in rest if i not in places]

    # "city-Liverpool", "wh-Northwind DC Venlo": places named in the answer
    named = {i: i.split("-", 1)[1] for i in rest if i.startswith(("city-", "wh-"))}
    if named:
        by_name = {}
        for name, hid, kind, lat, lon in g.query(HUBS_BY_NAME, {"names": list(set(named.values()))}).result_set:
            if lat is None or lon is None:
                continue
            # a city name can be both a zone and a DC town: prefer the zone for city-, the DC for wh-
            by_name.setdefault(name, []).append({"id": hid, "name": name, "kind": kind, "lat": float(lat), "lon": float(lon),
                                                 "country": None})
        for i, name in named.items():
            cands = by_name.get(name) or []
            if not cands:
                continue
            want_zone = i.startswith("city-")
            h = sorted(cands, key=lambda c: (c["kind"] != "zone") if want_zone else (c["kind"] == "zone"))[0]
            hubs.setdefault(h["id"], h)
            places[i] = {"type": "point", "hub": h["id"]}

    # groups -> where the orders downstream of their parent shipments go
    for gid, parents in (groups or {}).items():
        roots = [p for p in parents if places.get(p, {}).get("type") == "route"]
        if not roots:
            continue
        zones = [(z, n) for z, n in g.query(DOWNSTREAM_ZONES, {"ids": roots}).result_set]
        need_hubs(z for z, _n in zones)
        zones = [(z, n) for z, n in zones if z in hubs]
        if zones:
            places[gid] = {"type": "spread", "hub": zones[0][0], "zones": [[z, n] for z, n in zones[:24]]}

    used = {p["hub"] for p in places.values() if "hub" in p}
    used |= {h for p in places.values() for h in p.get("hubs", [])}
    used |= {z for p in places.values() for z, _n in p.get("zones", [])}
    return {"hubs": {h: hubs[h] for h in used if h in hubs}, "places": places, "events": events}


@router.get("/api/{tenant}/geo/network")
def network(tenant: str):
    """Every hub and lane, for the faint backdrop of the globe (one call per company)."""
    g = _graph(tenant)
    hubs = [{"id": i, "name": n, "kind": k, "country": c, "lat": float(la), "lon": float(lo)}
            for i, n, k, c, la, lo in g.query(NET_HUBS).result_set if la is not None and lo is not None]
    seen, lanes = set(), []
    for a, b, mode in g.query(NET_LANES).result_set:
        key = (min(a, b), max(a, b))
        if key not in seen:
            seen.add(key)
            lanes.append([a, b, mode])
    return {"hubs": hubs, "lanes": lanes}


@router.post("/api/{tenant}/geo")
def geo(tenant: str, body: GeoBody):
    groups = {k: v[:40] for k, v in list(body.groups.items())[:80]}
    return resolve(_graph(tenant), body.ids, groups)
