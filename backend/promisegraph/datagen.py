"""Synthetic data generator for Northwind Retail. ALL DATA PRODUCED HERE IS SYNTHETIC.

Shape of the world (one tenant = one shipper company):

    supplier --supply--> supplier --supply--> factory --inbound (ocean/air)--> national DC
        --transfer--> regional DC --last mile--> customer zone

Each shipment is a node with legs over real lanes. Shipment A FEEDS shipment B when B cannot
leave until A's goods arrive. `buffer_days` on FEEDS = B.depart_day - A.eta_day: the slack
that absorbs a delay before it passes on. Every last-mile shipment fulfils one customer order,
and every order carries one delivery promise.

The generator is deterministic for a given seed, so every teammate gets identical data.
"""
from __future__ import annotations

import heapq
import math
import random
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from . import world
from .config import TODAY, to_date, to_day

TODAY_DAY = to_day(TODAY)

# How much slack sits between stages. Lean supply chains run on small buffers, with the
# occasional safety-stock cushion that soaks up a delay completely.
SUPPLY_BUFFERS = [0, 0, 1, 1, 1, 2, 2, 3, 4, 7, 10]
DC_BUFFERS = [0, 1, 1, 2, 2, 3, 5, 8]
LASTMILE_BUFFERS = [0, 0, 1, 1, 2, 3]
PROMISE_SLACK = [0, 1, 1, 2, 2, 2, 3, 4, 6, 9]

NO_PASS_THROUGH = {"supplier", "factory", "zone"}


@dataclass
class Dataset:
    tenant: str
    company: str
    hubs: list = field(default_factory=list)
    carriers: list = field(default_factory=list)
    lanes: list = field(default_factory=list)
    customers: list = field(default_factory=list)
    orders: list = field(default_factory=list)
    promises: list = field(default_factory=list)
    shipments: list = field(default_factory=list)
    legs: list = field(default_factory=list)
    feeds: list = field(default_factory=list)  # {src, dst, buffer_days}
    fulfilled_by: list = field(default_factory=list)  # {order_id, shipment_id}
    events: list = field(default_factory=list)
    affects: list = field(default_factory=list)  # {event_id, hub_id}

    def counts(self) -> dict:
        return {k: len(v) for k, v in vars(self).items() if isinstance(v, list)}


def _km(a: dict, b: dict) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


LANE_COST = {  # USD per kg: fixed + per transit day
    "ocean": (0.04, 0.008),
    "rail": (0.02, 0.015),
    "truck": (0.03, 0.025),
    "air": (4.2, 0.4),
    "parcel": (0.9, 0.2),
}


def build_world() -> tuple[dict, dict]:
    hubs: dict[str, dict] = {}

    def hub(id_, name, kind, country, lat, lon, region=None):
        hubs[id_] = {"id": id_, "name": name, "kind": kind, "country": country,
                     "lat": lat, "lon": lon, "region": region}

    for p in world.PORTS + world.AIRPORTS:
        hub(*p)
    for sid, name, kind, country, lat, lon, _gw in world.SITES:
        hub(sid, name, kind, country, lat, lon)
    for rkey, r in world.REGIONS.items():
        nid, nname, ncountry, nlat, nlon = r["national"]
        hub(nid, nname, "dc_national", ncountry, nlat, nlon, rkey)
        for (rid, rname, rcountry, rlat, rlon), zones in r["regional"].items():
            hub(rid, rname, "dc_regional", rcountry, rlat, rlon, rkey)
            for zid, zname, zlat, zlon in zones:
                hub(zid, zname, "zone", rcountry, zlat, zlon, rkey)

    lanes: dict[tuple, dict] = {}

    def lane(a, b, mode, days, both=True):
        fixed, per_day = LANE_COST[mode]
        for s, d in ((a, b), (b, a)) if both else ((a, b),):
            lanes[(s, d, mode)] = {"src": s, "dst": d, "mode": mode, "days": days,
                                   "cost_per_kg": round(fixed + per_day * days, 3)}

    def land_days(a, b):
        return max(1, round(_km(hubs[a], hubs[b]) / 650))

    for a, b, days in world.OCEAN_LANES:
        lane(a, b, "ocean", days)
    for a, b in world.AIR_LANES:
        lane(a, b, "air", 1 if _km(hubs[a], hubs[b]) < 9000 else 2)
    for a, b, days in world.LAND_LANES:
        lane(a, b, "truck", days)
    for a, b in world.PORT_AIRPORT_LINKS:
        lane(a, b, "truck", 1)
    for sid, *_rest, gw in world.SITES:
        lane(sid, gw, "truck", land_days(sid, gw))
    for fac, apt in world.FACTORY_AIRPORTS.items():
        lane(fac, apt, "truck", land_days(fac, apt))
    for rkey, r in world.REGIONS.items():
        nid = r["national"][0]
        inland = "rail" if rkey == "EU" else "truck"
        for p in r["ports"]:
            lane(p, nid, inland, land_days(p, nid), both=False)
        for a in r["airports"]:
            lane(a, nid, "truck", land_days(a, nid), both=False)
        for (rid, *_), zones in r["regional"].items():
            lane(nid, rid, "truck", land_days(nid, rid), both=False)
            for zid, *_z in zones:
                lane(rid, zid, "parcel", land_days(rid, zid), both=False)
    return hubs, lanes


class Router:
    """Dijkstra over lanes. Per-shipment noise on transit days spreads traffic across
    alternative routes the way real carrier service choices do."""

    def __init__(self, hubs: dict, lanes: dict):
        self.hubs = hubs
        self.adj = defaultdict(list)
        for ln in lanes.values():
            self.adj[ln["src"]].append(ln)

    def route(self, src: str, dst: str, modes: set, rng: random.Random, noise: float = 0.35) -> list[dict]:
        dist, prev, pq = {src: 0.0}, {}, [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == dst:
                break
            if d > dist[u] or (u != src and self.hubs[u]["kind"] in NO_PASS_THROUGH):
                continue
            for ln in self.adj[u]:
                if ln["mode"] not in modes:
                    continue
                nd = d + ln["days"] * (1 + rng.uniform(-noise, noise)) + 0.5
                if nd < dist.get(ln["dst"], math.inf):
                    dist[ln["dst"]], prev[ln["dst"]] = nd, ln
                    heapq.heappush(pq, (nd, ln["dst"]))
        if dst not in prev:
            raise ValueError(f"no route {src} -> {dst} over {modes}")
        path, node = [], dst
        while node != src:
            path.append(prev[node])
            node = prev[node]["src"]
        return path[::-1]


def _dwell(rng, prev_mode: str, next_mode: str) -> int:
    if next_mode == "ocean":
        return rng.randint(1, 3) if prev_mode == "ocean" else rng.randint(1, 2)
    if next_mode == "air":
        return rng.randint(0, 1)
    return rng.randint(0, 1)


CARRIERS_BY_MODE = {
    "ocean": ["CAR-MOL", "CAR-BAS", "CAR-KCL"],
    "air": ["CAR-OAC", "CAR-SAF"],
    "parcel": ["CAR-DSX", "CAR-PLP"],
}


def _land_carrier(hub: dict, mode: str) -> str:
    if mode == "rail":
        return "CAR-RRC"
    if hub["country"] in {"US"}:
        return "CAR-PDC" if hub["lon"] < -100 else "CAR-PFW"
    if hub["country"] in {"NL", "DE", "BE", "FR", "IT", "ES", "GB"}:
        return "CAR-NLH"
    return "CAR-AOL"


def _plan_legs(sid: str, path: list[dict], depart: int, rng, hubs: dict) -> tuple[list[dict], int]:
    """Lay legs end to end starting at `depart`. Returns (legs, eta_day)."""
    ocean_carrier = rng.choice(CARRIERS_BY_MODE["ocean"])
    air_carrier = rng.choice(CARRIERS_BY_MODE["air"])
    parcel_carrier = rng.choice(CARRIERS_BY_MODE["parcel"])
    legs, t, prev_mode = [], depart, None
    for i, ln in enumerate(path):
        if i > 0:
            t += _dwell(rng, prev_mode, ln["mode"])
        mode = ln["mode"]
        carrier = {"ocean": ocean_carrier, "air": air_carrier, "parcel": parcel_carrier}.get(mode) \
            or _land_carrier(hubs[ln["src"]], mode)
        legs.append({"id": f"{sid}-L{i + 1}", "shipment_id": sid, "seq": i + 1, "mode": mode,
                     "from_hub": ln["src"], "to_hub": ln["dst"], "carrier_id": carrier,
                     "depart_day": t, "arrive_day": t + ln["days"]})
        t += ln["days"]
        prev_mode = mode
    return legs, t


def _plan_legs_backwards(sid, path, eta, rng, hubs):
    """Same as _plan_legs but anchored on the arrival day."""
    legs, end = _plan_legs(sid, path, 0, rng, hubs)
    shift = eta - end
    for leg in legs:
        leg["depart_day"] += shift
        leg["arrive_day"] += shift
    return legs, legs[0]["depart_day"]


FIRST = {
    "EU": ["Lukas", "Emma", "Sophie", "Jan", "Mila", "Noah", "Lea", "Finn", "Clara", "Mateo", "Lucia",
           "Hugo", "Chloé", "Giulia", "Marco", "Sofia", "Elena", "Pablo", "Inès", "Tomás", "Anouk",
           "Daan", "Sanne", "Bram", "Yusuf", "Amira", "Leon", "Hannah", "Matteo", "Alessia"],
    "UK": ["Oliver", "Amelia", "Harry", "Isla", "Jack", "Ava", "George", "Mia", "Priya", "Mohammed",
           "Zara", "Leo", "Freya", "Arjun", "Ella", "Callum", "Niamh", "Rhys", "Imogen", "Tariq", "Hana"],
    "US": ["James", "Olivia", "Liam", "Emma", "Ethan", "Ava", "Mason", "Sophia", "Lucas", "Isabella",
           "Daniel", "Mia", "Jayden", "Harper", "Carlos", "Maria", "Jamal", "Keisha", "Wei", "Mei",
           "Hiroshi", "Yuki", "Diego", "Valentina", "Andre", "Grace", "Tyler", "Hannah"],
}
LAST = {
    "EU": ["Müller", "Schmidt", "de Vries", "Jansen", "Bakker", "Dubois", "Martin", "Bernard", "Rossi",
           "Bianchi", "Romano", "García", "Fernández", "López", "Martínez", "Peeters", "Janssens",
           "Wagner", "Becker", "Moreau", "Silva", "Costa", "Yılmaz", "Kaya", "Novak"],
    "UK": ["Smith", "Jones", "Taylor", "Brown", "Williams", "Wilson", "Evans", "Patel", "Khan", "Ahmed",
           "Singh", "Hughes", "Campbell", "Murphy", "Davies", "Roberts", "Walker", "Begum", "Okafor", "Mensah"],
    "US": ["Johnson", "Williams", "Garcia", "Rodriguez", "Smith", "Brown", "Nguyen", "Kim", "Chen", "Lee",
           "Martinez", "Hernandez", "Davis", "Miller", "Wilson", "Anderson", "Thomas", "Jackson", "White",
           "Harris", "Washington", "Okoye", "Patel", "Cohen", "Sullivan", "Lopez"],
}
BIZ_A = ["Harbor", "Pine", "Copper", "Willow", "Granite", "Maple", "Cedar", "Juniper", "Linden", "Birch",
         "Oakline", "Summit", "Riverside", "Northgate", "Lakeside"]
BIZ_B = ["Home", "Interiors", "Living", "Outfitters", "Supply", "Goods", "Market", "Trading"]
BIZ_SUFFIX = {"NL": "BV", "DE": "GmbH", "BE": "BV", "FR": "SARL", "IT": "S.r.l.", "ES": "S.L.", "CH": "AG",
              "PT": "Lda", "GB": "Ltd", "US": "LLC"}


EVENTS = [  # id, type, name, start, end, backlog_days, hubs, historic
    ("EV-SGSIN-1020", "port_closure", "Singapore terminals shut by cyber incident",
     date(2026, 10, 20), date(2026, 10, 24), 3, ["SGSIN"], False),
    ("EV-USWC-1120", "labour_action", "LA / Long Beach labour action",
     date(2026, 11, 20), date(2026, 11, 24), 4, ["USLAX", "USLGB"], False),
    ("EV-MYPKG-0608", "port_closure", "Port Klang congestion closes gates",
     date(2026, 6, 8), date(2026, 6, 12), 3, ["MYPKG"], True),
    ("EV-LKCMB-0420", "port_closure", "Colombo crane outage",
     date(2026, 4, 20), date(2026, 4, 23), 2, ["LKCMB"], True),
    ("EV-EGPSD-0715", "canal_disruption", "Suez convoy suspension at Port Said",
     date(2026, 7, 15), date(2026, 7, 19), 5, ["EGPSD"], True),
]


def generate(orders: int = 20000, supply_tiers: int = 3, seed: int = 7, tenant: str = "northwind",
             company: str = "Northwind Retail", families: list[str] | None = None) -> Dataset:
    if not 1 <= supply_tiers <= 5:
        raise ValueError("supply_tiers must be 1..5")
    rng = random.Random(seed)
    ds = Dataset(tenant=tenant, company=company)
    hubs, lanes = build_world()
    router = Router(hubs, lanes)
    ds.hubs = list(hubs.values())
    ds.lanes = list(lanes.values())
    ds.carriers = [{"id": c, "name": n, "mode": m} for c, n, m in world.CARRIERS]

    ship_by_id: dict[str, dict] = {}
    counters = defaultdict(int)

    def new_id(prefix: str, width: int = 5) -> str:
        counters[prefix] += 1
        return f"{prefix}-{counters[prefix]:0{width}d}"

    def add_shipment(s: dict, legs: list[dict]):
        ds.shipments.append(s)
        ds.legs.extend(legs)
        ship_by_id[s["id"]] = s

    def link(src: dict, dst: dict):
        buf = dst["depart_day"] - src["eta_day"]
        assert buf >= 0, (src["id"], dst["id"], buf)
        ds.feeds.append({"src": src["id"], "dst": dst["id"], "buffer_days": buf})

    # ---- supply tiers, planned backwards from the shipment they feed --------------------
    supply_pool: dict[tuple, list[dict]] = defaultdict(list)  # (family, tier) -> shipments

    def build_supply(consumer: dict, family: str, tier: int):
        fam = world.FAMILIES[family]
        chain = fam["chain"][-supply_tiers:] + [fam["factory"]]
        n_feeders = 1 if rng.random() < 0.65 else 2
        linked: set[str] = set()
        for _ in range(n_feeders):
            # A supplier batch often serves several downstream shipments.
            reusable = [p for p in supply_pool[(family, tier)] if p["id"] not in linked
                        and consumer["depart_day"] - 10 <= p["eta_day"] <= consumer["depart_day"]]
            if reusable and rng.random() < 0.3:
                producer = rng.choice(reusable)
                linked.add(producer["id"])
                link(producer, consumer)
                continue
            sid = new_id("SPL")
            path = router.route(chain[tier], chain[tier + 1], {"truck", "ocean"}, rng)
            eta = consumer["depart_day"] - rng.choice(SUPPLY_BUFFERS)
            legs, depart = _plan_legs_backwards(sid, path, eta, rng, hubs)
            weight = rng.randint(2000, 18000)
            s = {"id": sid, "stage": "supply", "tier": tier, "mode": "ocean" if any(
                 lg["mode"] == "ocean" for lg in legs) else "truck", "family": family,
                 "description": f"{fam['parts'][len(fam['chain']) - supply_tiers + tier]} "
                                f"to {hubs[chain[tier + 1]]['name']}",
                 "origin": chain[tier], "destination": chain[tier + 1], "weight_kg": weight,
                 "value_usd": weight * rng.randint(3, 15), "depart_day": depart, "eta_day": eta}
            add_shipment(s, legs)
            supply_pool[(family, tier)].append(s)
            linked.add(sid)
            link(s, consumer)
            if tier > 0:
                build_supply(s, family, tier - 1)

    # ---- inbound finished goods: factory -> national DC ----------------------------------
    region_keys = list(world.REGIONS)
    region_w = [world.REGIONS[k]["weight"] for k in region_keys]
    fam_keys = families or list(world.FAMILIES)
    n_inbound = max(12, round(orders / 260))
    inbound_by_region: dict[str, list[dict]] = defaultdict(list)
    for _ in range(n_inbound):
        family = rng.choice(fam_keys)
        fam = world.FAMILIES[family]
        rkey = rng.choices(region_keys, region_w)[0]
        national = world.REGIONS[rkey]["national"][0]
        is_air = rng.random() < fam["air_share"]
        sid = new_id("AIR" if is_air else "OCN")
        modes = {"truck", "air"} if is_air else {"truck", "rail", "ocean"}
        path = router.route(fam["factory"], national, modes, rng)
        depart = TODAY_DAY + rng.randint(-35, 25)
        legs, eta = _plan_legs(sid, path, depart, rng, hubs)
        weight = rng.randint(300, 2500) if is_air else rng.randint(8000, 22000)
        s = {"id": sid, "stage": "inbound", "tier": supply_tiers, "mode": "air" if is_air else "ocean",
             "family": family, "description": f"{fam['goods']} for {hubs[national]['name']}",
             "origin": fam["factory"], "destination": national, "weight_kg": weight,
             "value_usd": weight * rng.randint(8, 40), "depart_day": depart, "eta_day": eta}
        add_shipment(s, legs)
        inbound_by_region[rkey].append(s)
        build_supply(s, family, supply_tiers - 1)

    # ---- transfers: national DC -> regional DC -------------------------------------------
    transfers: list[dict] = []
    for rkey, inbound in inbound_by_region.items():
        r = world.REGIONS[rkey]
        national = r["national"][0]
        regionals = [k[0] for k in r["regional"]]
        for s in inbound:
            for _ in range(rng.randint(3, 6)):
                feeders = [s]
                others = [o for o in inbound if o is not s and abs(o["eta_day"] - s["eta_day"]) <= 8]
                if others and rng.random() < 0.3:
                    feeders.append(rng.choice(others))
                regional = rng.choice(regionals)
                sid = new_id("TRF")
                depart = max(f["eta_day"] for f in feeders) + rng.choice(DC_BUFFERS)
                legs, eta = _plan_legs(sid, [lanes[(national, regional, "truck")]], depart, rng, hubs)
                weight = rng.randint(3000, 12000)
                t = {"id": sid, "stage": "transfer", "tier": supply_tiers + 1, "mode": "truck",
                     "family": s["family"], "description": f"replenishment to {hubs[regional]['name']}",
                     "origin": national, "destination": regional, "weight_kg": weight,
                     "value_usd": weight * rng.randint(8, 30), "depart_day": depart, "eta_day": eta,
                     "_region": rkey}
                add_shipment(t, legs)
                for f in feeders:
                    link(f, t)
                transfers.append(t)

    # ---- last mile + customer orders + promises ------------------------------------------
    transfers_by_regional = defaultdict(list)
    for t in transfers:
        transfers_by_regional[t["destination"]].append(t)
    weights = [rng.uniform(0.3, 1.7) for _ in transfers]
    picks = rng.choices(range(len(transfers)), weights, k=orders)
    customers_by_zone: dict[str, list[dict]] = defaultdict(list)

    def zone_customer(zone: dict, rkey: str) -> dict:
        pool = customers_by_zone[zone["id"]]
        if pool and rng.random() < 0.25:
            return rng.choice(pool)
        tier = rng.choices(["consumer", "plus", "business"], [0.70, 0.22, 0.08])[0]
        if tier == "business":
            name = f"{rng.choice(BIZ_A)} {rng.choice(BIZ_B)} {BIZ_SUFFIX.get(zone['country'], 'Ltd')}"
        else:
            names = "US" if rkey.startswith("US") else rkey
            name = f"{rng.choice(FIRST[names])} {rng.choice(LAST[names])}"
        c = {"id": new_id("CUS"), "name": name, "tier": tier, "zone": zone["id"], "city": zone["name"]}
        ds.customers.append(c)
        pool.append(c)
        return c

    zones_of = {rid: [hubs[z[0]] for z in zones]
                for r in world.REGIONS.values() for (rid, *_), zones in r["regional"].items()}
    for idx in picks:
        t = transfers[idx]
        regional = t["destination"]
        zone = rng.choice(zones_of[regional])
        feeders = [t]
        if rng.random() < 0.10:
            others = [o for o in transfers_by_regional[regional]
                      if o is not t and abs(o["eta_day"] - t["eta_day"]) <= 5]
            if others:
                feeders.append(rng.choice(others))
        sid = new_id("LMD", 6)
        depart = max(f["eta_day"] for f in feeders) + rng.choice(LASTMILE_BUFFERS)
        legs, eta = _plan_legs(sid, [lanes[(regional, zone["id"], "parcel")]], depart, rng, hubs)
        cust = zone_customer(zone, t["_region"])
        business = cust["tier"] == "business"
        value = rng.randint(4000, 60000) if business else int(rng.lognormvariate(4.8, 0.8)) + 15
        lm = {"id": sid, "stage": "lastmile", "tier": supply_tiers + 2, "mode": "parcel",
              "family": t["family"], "description": f"parcel to {zone['name']}",
              "origin": regional, "destination": zone["id"],
              "weight_kg": rng.randint(200, 2000) if business else rng.randint(1, 60),
              "value_usd": value, "depart_day": depart, "eta_day": eta}
        add_shipment(lm, legs)
        for f in feeders:
            link(f, lm)

        oid = new_id("ORD", 6)
        due = eta + rng.choice(PROMISE_SLACK)
        placed = min(TODAY_DAY - rng.randint(0, 25), due - rng.randint(3, 20))
        if business:
            penalty = max(50, round(value * 0.015))
        elif cust["tier"] == "plus":
            penalty = rng.randint(20, 45)
        else:
            penalty = rng.randint(8, 20)
        ds.orders.append({"id": oid, "customer_id": cust["id"], "placed_day": placed, "value_usd": value,
                          "family": t["family"], "channel": "b2b" if business else rng.choice(["web", "app"])})
        ds.promises.append({"id": oid.replace("ORD", "PRM"), "order_id": oid, "due_day": due,
                            "due_date": to_date(due).isoformat(),
                            "status": "active" if eta >= TODAY_DAY else "kept",
                            "penalty_per_day": penalty})
        ds.fulfilled_by.append({"order_id": oid, "shipment_id": sid})

    for t in transfers:
        t.pop("_region", None)

    # ---- disruption scenarios -----------------------------------------------------------
    # Two live scenarios plus three past disruptions. Past events sit before any generated leg,
    # so they break nothing today; they exist so agent memory has history to recall.
    ds.events, ds.affects = [], []
    for eid, etype, name, start, end, backlog, hubs_hit, historic in EVENTS:
        ds.events.append({"id": eid, "type": etype, "name": name, "start_day": to_day(start),
                          "end_day": to_day(end), "backlog_days": backlog, "severity": "high",
                          "historic": historic})
        ds.affects.extend({"event_id": eid, "hub_id": h} for h in hubs_hit)

    assert len({(f["src"], f["dst"]) for f in ds.feeds}) == len(ds.feeds), "duplicate FEEDS edge"
    if tenant == "northwind":
        _plant_demo_customer(ds)
    return ds


# ---------------------------------------------------------------------------------------
# Reference implementation of the cascade, in plain Python.
#
# This is NOT used by the product. It exists for two reasons only: (1) a third, independent
# oracle so tests can prove FalkorDB and Postgres return the same, correct answer, and
# (2) choosing which synthetic customer becomes the demo persona.
# ---------------------------------------------------------------------------------------
def reference_impact(ds: Dataset, event_id: str, max_depth: int) -> list[tuple]:
    ev = next(e for e in ds.events if e["id"] == event_id)
    hit_hubs = {a["hub_id"] for a in ds.affects if a["event_id"] == event_id}
    d0: dict[str, int] = {}
    for leg in ds.legs:
        for hub, t in ((leg["to_hub"], leg["arrive_day"]), (leg["from_hub"], leg["depart_day"])):
            if hub in hit_hubs and ev["start_day"] <= t <= ev["end_day"]:
                d = ev["end_day"] + ev["backlog_days"] - t + 1
                d0[leg["shipment_id"]] = max(d0.get(leg["shipment_id"], 0), d)
    out = defaultdict(list)
    for f in ds.feeds:
        out[f["src"]].append((f["dst"], f["buffer_days"]))
    best: dict[str, tuple[int, int]] = {}
    frontier, seen = [(s, d, 0) for s, d in d0.items()], set()
    while frontier:
        nxt = []
        for sid, d, h in frontier:
            if (sid, d, h) in seen:
                continue
            seen.add((sid, d, h))
            cur = best.get(sid)
            best[sid] = (max(cur[0], d), min(cur[1], h)) if cur else (d, h)
            if h < max_depth:
                nxt.extend((dst, d - buf, h + 1) for dst, buf in out[sid] if d - buf > 0)
        frontier = nxt
    ships = {s["id"]: s for s in ds.shipments}
    promise_of = {p["order_id"]: p for p in ds.promises}
    rows = []
    for fb in ds.fulfilled_by:
        if fb["shipment_id"] not in best:
            continue
        p = promise_of[fb["order_id"]]
        delay, hops = best[fb["shipment_id"]]
        late = ships[fb["shipment_id"]]["eta_day"] + delay - p["due_day"]
        if p["status"] == "active" and late > 0:
            rows.append((p["id"], fb["order_id"], fb["shipment_id"], delay, hops, late, late * p["penalty_per_day"]))
    return sorted(rows)


def _plant_demo_customer(ds: Dataset):
    """Rename one deep-cascade, at-risk UK 'plus' customer to the demo persona, Aisha Rahman."""
    rows = reference_impact(ds, "EV-SGSIN-1020", 10)
    orders = {o["id"]: o for o in ds.orders}
    customers = {c["id"]: c for c in ds.customers}
    uk = {z for r in ("UK",) for (_rid, *_), zones in world.REGIONS[r]["regional"].items() for z, *_ in zones}

    def score(row):
        c = customers[orders[row[1]]["customer_id"]]
        return (c["zone"] in uk, c["tier"] == "plus", row[4], row[5])

    if not rows:
        return
    best = max(rows, key=score)
    cust = customers[orders[best[1]]["customer_id"]]
    cust["name"] = "Aisha Rahman"
