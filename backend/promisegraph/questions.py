"""The question whitelist behind the prompt box.

Every template has a Cypher version (FalkorDB) and a SQL version (Postgres, indexed), both
parameterised and tested to return the same rows (tests/test_questions.py). The engine switch picks
which one answers. Nothing here builds a query from user text: an interpreter (nl.py) only picks a
template id and fills validated slots.

Each template also turns its own rows into a small graph for the 3D view, with plain-English
"why" lines on every node and link. That graph is built from the rows only, so whichever engine
answered, the picture shows exactly what that engine returned.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable

from . import falkor_store as fs
from . import pg_store as ps
from .config import to_date

MAX_ROWS = 200
GRAPH_CAP = 120   # broken orders drawn individually; the rest are grouped


def _day(day_or_iso) -> str:
    d = to_date(day_or_iso) if isinstance(day_or_iso, int) else __import__("datetime").date.fromisoformat(day_or_iso)
    return f"{d.strftime('%b')} {d.day}"


def _usd(x) -> str:
    return f"${x:,.0f}"


def _cap(s: str) -> str:
    """First letter up, the rest untouched (str.capitalize() would turn "Northwind DC" into "northwind dc")."""
    return s[:1].upper() + s[1:]


def _plural(n: int, word: str, plural: str | None = None) -> str:
    return f"{n:,} {word if n == 1 else (plural or word + 's')}"


def _norm(rows) -> list[tuple]:
    out = []
    for r in rows:
        out.append(tuple(round(v, 2) if isinstance(v, float) else (list(v) if isinstance(v, (list, tuple)) else v)
                         for v in r))
    return out


@dataclass
class Run:
    rows: list[tuple]
    text: str
    params: dict
    ms: float
    extra: dict = field(default_factory=dict)


def _timed(fn):
    t0 = time.perf_counter()
    out = fn()
    return out, (time.perf_counter() - t0) * 1000


# =============================================================================================
# 1. at_risk: which orders does a disruption break (optionally only in one city)?
# =============================================================================================
AT_RISK_CYPHER = """
MATCH (e:Event {{id: $event}})-[:AFFECTS]->(h:Hub)
WITH e, h, [(h)<-[:TO]-(l:Leg) WHERE l.arrive_day >= e.start_day AND l.arrive_day <= e.end_day | [l, l.arrive_day]]
         + [(h)<-[:FROM]-(l:Leg) WHERE l.depart_day >= e.start_day AND l.depart_day <= e.end_day | [l, l.depart_day]]
         AS touches
UNWIND touches AS touch
WITH e, h, touch[0] AS l, touch[1] AS t
MATCH (l)<-[:USES]-(s0:Shipment)
WITH ID(s0) AS sid, max(e.end_day + e.backlog_days - t + 1) AS d0, min(h.id) AS port
MATCH (s0) WHERE ID(s0) = sid
MATCH p = (s0)-[:FEEDS*0..{depth}]->(s:Shipment)
WITH s, s0, port, length(p) AS hops,
     reduce(d = d0, f IN relationships(p) | CASE WHEN d > f.buffer_days THEN d - f.buffer_days ELSE 0 END) AS delay
WHERE delay > 0
WITH s, s0, port, hops, delay ORDER BY delay DESC, hops ASC, s0.id ASC
WITH s, max(delay) AS delay, min(hops) AS steps, collect([s0.id, port, s0.description])[0] AS root
MATCH (s)<-[:FULFILLED_BY]-(o:Order)-[:HAS_PROMISE]->(pr:Promise {{status: 'active'}})
WITH pr, o, s, delay, steps, root, s.eta_day + delay - pr.due_day AS late
WHERE late > 0
MATCH (c:Customer)-[:PLACED]->(o)
WITH pr, o, c, late, steps, root WHERE $city IS NULL OR c.city = $city
RETURN pr.id, o.id, c.name, c.city, pr.due_date, late, late * pr.penalty_per_day, steps, root[0], root[2], root[1]
"""

AT_RISK_SQL = """
WITH RECURSIVE
hit AS (
    SELECT x.shipment_id AS sid, MAX(e.end_day + e.backlog_days - x.t + 1) AS d0, MIN(x.hub) AS port
    FROM event e
    JOIN affects a ON a.event_id = e.id
    CROSS JOIN LATERAL (
        SELECT l.shipment_id, l.arrive_day AS t, a.hub_id AS hub FROM leg l
        WHERE l.to_hub = a.hub_id AND l.arrive_day BETWEEN e.start_day AND e.end_day
        UNION ALL
        SELECT l.shipment_id, l.depart_day, a.hub_id FROM leg l
        WHERE l.from_hub = a.hub_id AND l.depart_day BETWEEN e.start_day AND e.end_day
    ) x
    WHERE e.id = %(event)s
    GROUP BY x.shipment_id
),
walk (root, port, sid, delay, hops) AS (
    SELECT sid, port, sid, d0, 0 FROM hit
    UNION
    SELECT w.root, w.port, f.dst, w.delay - f.buffer_days, w.hops + 1
    FROM walk w JOIN feeds f ON f.src = w.sid
    WHERE w.hops < %(depth)s AND w.delay - f.buffer_days > 0
),
worst AS (SELECT sid, MAX(delay) AS delay, MIN(hops) AS steps FROM walk GROUP BY sid),
best AS (
    SELECT DISTINCT ON (sid) sid, root, port FROM walk
    ORDER BY sid, delay DESC, hops ASC, root COLLATE "C" ASC
)
SELECT p.id, o.id, c.name, c.city, p.due_date,
       s.eta_day + w.delay - p.due_day AS late,
       (s.eta_day + w.delay - p.due_day) * p.penalty_per_day AS fee,
       w.steps, b.root, rs.description, b.port
FROM worst w
JOIN best b ON b.sid = w.sid
JOIN shipment s ON s.id = w.sid
JOIN fulfilled_by fb ON fb.shipment_id = w.sid
JOIN orders o ON o.id = fb.order_id
JOIN promise p ON p.order_id = o.id
JOIN customer c ON c.id = o.customer_id
JOIN shipment rs ON rs.id = b.root
WHERE p.status = 'active' AND s.eta_day + w.delay > p.due_day
  AND (%(city)s::text IS NULL OR c.city = %(city)s::text)
"""
AT_RISK_COLS = ["order_ref", "order", "customer", "city", "promised", "days_late", "late_fee", "steps",
                "root", "root_what", "port"]


def _sort_at_risk(rows):
    return sorted(rows, key=lambda r: (-r[6], r[0]))


def at_risk_falkor(g, p):
    text = AT_RISK_CYPHER.format(depth=int(p["depth"]))
    params = {"event": p["event"], "city": p.get("city")}
    res, ms = _timed(lambda: g.query(text, params).result_set)
    return Run(_sort_at_risk(_norm(res)), text, params, ms)


def at_risk_pg(conn, p):
    params = {"event": p["event"], "city": p.get("city"), "depth": int(p["depth"])}
    res, ms = _timed(lambda: conn.execute(AT_RISK_SQL, params).fetchall())
    return Run(_sort_at_risk(_norm(res)), AT_RISK_SQL, params, ms)


def at_risk_answer(rows, p, ctx):
    ev = ctx["events"][p["event"]]
    where = f" from {p['city']} customers" if p.get("city") else ""
    if not rows:
        return f"No orders{where} are hurt by {ev['short']}."
    fee = sum(r[6] for r in rows)
    ports = " and ".join(sorted({ctx["hubs"].get(r[10], r[10]) for r in rows}))
    return (f"{_plural(len(rows), 'order')}{where} will arrive late because {ev['short']}, "
            f"with {_usd(fee)} in late fees. Each one traces back to a shipment stuck at {ports}.")


def at_risk_graph(rows, p, ctx):
    ev = ctx["events"][p["event"]]
    nodes, links = {}, []
    nodes[ev["id"]] = {"id": ev["id"], "kind": "event", "label": ev["name"], "tone": "danger", "size": 2,
                       "step": 0, "why": [ev["name"] + ".", f"Closed {ev['when']}, then {ev['backlog']} more days to clear the backlog."]}
    by_root: dict[str, list] = {}
    for r in rows:
        by_root.setdefault(r[8], []).append(r)
    for port in sorted({r[10] for r in rows} or set(ev["hubs"])):
        name = ctx["hubs"].get(port, port)
        n_roots = len({r[8] for r in rows if r[10] == port})
        nodes[port] = {"id": port, "kind": "port", "label": name, "tone": "danger", "size": 3, "step": 0,
                       "why": [f"{name} is shut during the disruption.",
                               f"{_plural(n_roots, 'shipment')} on the way through it {'is' if n_roots == 1 else 'are'} now stuck."]}
        links.append({"source": ev["id"], "target": port, "tone": "danger", "label": "shut",
                      "why": [f"{ev['name']} closes {name}."]})
    keep = set(r[0] for r in rows[:GRAPH_CAP]) | {r[0] for r in rows if r[2] == ctx.get("persona")}
    for root, rs in sorted(by_root.items(), key=lambda kv: -sum(r[6] for r in kv[1])):
        port = rs[0][10]
        fee = sum(r[6] for r in rs)
        nodes[root] = {"id": root, "kind": "shipment", "label": _cap(rs[0][9]), "tone": "warning",
                       "size": 1.6, "step": 1,
                       "why": [f"{_cap(rs[0][9])} ({root}).",
                               f"It was due through {ctx['hubs'].get(port, port)} while it was shut.",
                               f"{_plural(len(rs), 'order')} downstream will be late ({_usd(fee)} in fees)."]}
        links.append({"source": port, "target": root, "tone": "danger", "label": "stuck",
                      "why": [f"{root} was due through {ctx['hubs'].get(port, port)} during the closure."]})
        shown = [r for r in rs if r[0] in keep]
        for r in shown:
            nodes[r[0]] = {"id": r[0], "kind": "order", "label": f"{r[2]}'s order", "tone": "danger",
                           "size": 1, "step": 1 + r[7],
                           "why": [f"{r[2]} in {r[3]} was promised delivery on {_day(r[4])}.",
                                   f"It will now arrive {_plural(r[5], 'day')} late; the late fee is {_usd(r[6])}.",
                                   f"The delay reaches it {_plural(r[7], 'step')} along the supply chain."]}
            links.append({"source": root, "target": r[0], "tone": "warning", "label": _plural(r[7], "step"),
                          "why": [f"This order depends on {root} through {_plural(r[7], 'step')} of the supply chain.",
                                  f"Each step has a little slack; what is left of the delay arrives here."]})
        rest = len(rs) - len(shown)
        if rest:
            gid = f"more-{root}"
            nodes[gid] = {"id": gid, "kind": "group", "label": f"+ {rest:,} more orders", "tone": "muted",
                          "size": 1.2 + min(rest, 300) / 150, "step": 2,
                          "why": [f"{rest:,} more orders depend on {root} and will also be late.",
                                  "They are grouped to keep the picture readable; the list has them all."]}
            links.append({"source": root, "target": gid, "tone": "muted", "why": [f"{rest:,} more late orders."]})
    return {"nodes": list(nodes.values()), "links": links, "truncated": len(keep) < len(rows)}


# =============================================================================================
# 2. orders_window: orders from one city's customers, promised between two dates
# =============================================================================================
WINDOW_CYPHER = """
MATCH (c:Customer {city: $city})-[:PLACED]->(o:Order)-[:HAS_PROMISE]->(p:Promise)
WHERE p.due_day >= $from_day AND p.due_day <= $to_day
MATCH (o)-[:FULFILLED_BY]->(s:Shipment)-[:USES]->(l:Leg)-[:FROM]->(w:Hub)
RETURN o.id, c.name, p.due_date, o.value_usd, p.status, w.name, s.eta_day
"""
WINDOW_SQL = """
SELECT o.id, c.name, p.due_date, o.value_usd, p.status, w.name, s.eta_day
FROM customer c
JOIN orders o ON o.customer_id = c.id
JOIN promise p ON p.order_id = o.id
JOIN fulfilled_by fb ON fb.order_id = o.id
JOIN shipment s ON s.id = fb.shipment_id
JOIN leg l ON l.shipment_id = s.id
JOIN hub w ON w.id = l.from_hub
WHERE c.city = %(city)s AND p.due_day BETWEEN %(from_day)s AND %(to_day)s
"""
WINDOW_COLS = ["order", "customer", "promised", "value", "status", "ships_from", "arrives_day"]


def _sort_window(rows):
    return sorted(rows, key=lambda r: (r[2], r[0]))


def window_falkor(g, p):
    params = {"city": p["city"], "from_day": p["from_day"], "to_day": p["to_day"]}
    res, ms = _timed(lambda: g.query(WINDOW_CYPHER, params).result_set)
    return Run(_sort_window(_norm(res)), WINDOW_CYPHER, params, ms)


def window_pg(conn, p):
    params = {"city": p["city"], "from_day": p["from_day"], "to_day": p["to_day"]}
    res, ms = _timed(lambda: conn.execute(WINDOW_SQL, params).fetchall())
    return Run(_sort_window(_norm(res)), WINDOW_SQL, params, ms)


def window_answer(rows, p, ctx):
    span = f"between {_day(p['from_day'])} and {_day(p['to_day'])}"
    if not rows:
        return f"No orders from {p['city']} customers are due {span}."
    return (f"{_plural(len(rows), 'order')} from {p['city']} customers {'is' if len(rows) == 1 else 'are'} due "
            f"{span}, worth {_usd(sum(r[3] for r in rows))} in total.")


def window_graph(rows, p, ctx):
    city = f"city-{p['city']}"
    nodes = {city: {"id": city, "kind": "place", "label": p["city"], "tone": "neutral", "size": 3,
                    "why": [f"Customers in {p['city']}.", f"{_plural(len(rows), 'order')} due {_day(p['from_day'])} to {_day(p['to_day'])}."]}}
    links = []
    for r in rows[:GRAPH_CAP]:
        wid = f"wh-{r[5]}"
        if wid not in nodes:
            n = sum(1 for x in rows if x[5] == r[5])
            nodes[wid] = {"id": wid, "kind": "warehouse", "label": r[5], "tone": "neutral", "size": 2,
                          "why": [f"{r[5]} ships these orders.", f"{_plural(n, 'order')} in this list leave from here."]}
        nodes[r[0]] = {"id": r[0], "kind": "order", "label": f"{r[1]}'s order",
                       "tone": "good" if r[6] <= _due_day(r[2]) else "warning", "size": 1,
                       "why": [f"{r[1]} ordered goods worth {_usd(r[3])}.",
                               f"Promised for {_day(r[2])}; planned to arrive {_day(r[6])}."]}
        links.append({"source": wid, "target": r[0], "tone": "muted", "why": [f"Ships from {r[5]}."]})
        links.append({"source": r[0], "target": city, "tone": "muted", "why": [f"Delivered to {r[1]} in {p['city']}."]})
    return {"nodes": list(nodes.values()), "links": links, "truncated": len(rows) > GRAPH_CAP}


def _due_day(iso: str) -> int:
    from .config import to_day
    import datetime
    return to_day(datetime.date.fromisoformat(iso))


# =============================================================================================
# 3. why_late: one customer's order, traced back to the disruption step by step
# =============================================================================================
WHY_CYPHER = """
MATCH (e:Event {{id: $event}})-[:AFFECTS]->(h:Hub)
WITH e, h, [(h)<-[:TO]-(l:Leg) WHERE l.arrive_day >= e.start_day AND l.arrive_day <= e.end_day | [l, l.arrive_day]]
         + [(h)<-[:FROM]-(l:Leg) WHERE l.depart_day >= e.start_day AND l.depart_day <= e.end_day | [l, l.depart_day]]
         AS touches
UNWIND touches AS touch
WITH e, h, touch[0] AS l, touch[1] AS t
MATCH (l)<-[:USES]-(s0:Shipment)
WITH ID(s0) AS sid, max(e.end_day + e.backlog_days - t + 1) AS d0, min(h.id) AS port
MATCH (s0) WHERE ID(s0) = sid
MATCH p = (s0)-[:FEEDS*0..{depth}]->(s:Shipment)
// The WITH barrier is required: without it the planner drops the `WHERE ID(s0) = sid` binding of
// the start node (it plans from the customer side) and returns 0 rows on this FalkorDB build.
// Engine bug B, bench/NOTES.md #8; minimal repro in scripts/repro_falkordb.py.
WITH p, port, d0, s
MATCH (s)<-[:FULFILLED_BY]-(o:Order)<-[:PLACED]-(c:Customer)
WHERE c.name = $customer
MATCH (o)-[:HAS_PROMISE]->(pr:Promise {{status: 'active'}})
WITH p, port, d0, s, pr, c,
     reduce(d = d0, f IN relationships(p) | CASE WHEN d > f.buffer_days THEN d - f.buffer_days ELSE 0 END) AS delay
WHERE delay > 0 AND s.eta_day + delay > pr.due_day
WITH p, port, d0, pr, c, delay, s.eta_day + delay - pr.due_day AS late,
     reduce(k = '', n IN nodes(p) | k + n.id + '>') AS pathkey
ORDER BY late DESC, pr.id ASC, delay DESC, length(p) ASC, pathkey ASC
LIMIT 1
WITH p, port, pr, c, late, [f IN relationships(p) | f.buffer_days] AS bufs,
     reduce(acc = [d0], f IN relationships(p) |
            acc + [CASE WHEN acc[size(acc) - 1] > f.buffer_days THEN acc[size(acc) - 1] - f.buffer_days ELSE 0 END]) AS delays
UNWIND range(0, length(p)) AS i
WITH i, nodes(p)[i] AS n, port, pr, c, late, bufs, delays
RETURN i, n.id, n.description, [(n)-[:USES]->(lg:Leg {{seq: 1}})-[:FROM]->(fh:Hub) | fh.name][0],
       delays[i], CASE WHEN i = 0 THEN NULL ELSE bufs[i - 1] END,
       pr.id, c.city, pr.due_date, late, late * pr.penalty_per_day, port
ORDER BY i
"""

WHY_SQL = """
WITH RECURSIVE
hit AS (
    SELECT x.shipment_id AS sid, MAX(e.end_day + e.backlog_days - x.t + 1) AS d0, MIN(x.hub) AS port
    FROM event e
    JOIN affects a ON a.event_id = e.id
    CROSS JOIN LATERAL (
        SELECT l.shipment_id, l.arrive_day AS t, a.hub_id AS hub FROM leg l
        WHERE l.to_hub = a.hub_id AND l.arrive_day BETWEEN e.start_day AND e.end_day
        UNION ALL
        SELECT l.shipment_id, l.depart_day, a.hub_id FROM leg l
        WHERE l.from_hub = a.hub_id AND l.depart_day BETWEEN e.start_day AND e.end_day
    ) x
    WHERE e.id = %(event)s
    GROUP BY x.shipment_id
),
target AS (
    SELECT s.id AS sid, s.eta_day, p.id AS pid, p.due_day, p.due_date, p.penalty_per_day, c.city
    FROM customer c
    JOIN orders o ON o.customer_id = c.id
    JOIN promise p ON p.order_id = o.id AND p.status = 'active'
    JOIN fulfilled_by fb ON fb.order_id = o.id
    JOIN shipment s ON s.id = fb.shipment_id
    WHERE c.name = %(customer)s
),
walk (port, sid, delay, path, bufs, delays) AS (
    SELECT port, sid, d0, ARRAY[sid], ARRAY[]::int[], ARRAY[d0] FROM hit
    UNION ALL
    SELECT w.port, f.dst, GREATEST(w.delay - f.buffer_days, 0), w.path || f.dst, w.bufs || f.buffer_days,
           w.delays || GREATEST(w.delay - f.buffer_days, 0)
    FROM walk w JOIN feeds f ON f.src = w.sid
    WHERE cardinality(w.path) <= %(depth)s
),
pick AS (
    SELECT w.*, t.pid, t.due_date, t.penalty_per_day, t.city, t.eta_day + w.delay - t.due_day AS late
    FROM walk w JOIN target t ON t.sid = w.sid
    WHERE w.delay > 0 AND t.eta_day + w.delay > t.due_day
    ORDER BY late DESC, t.pid COLLATE "C" ASC, w.delay DESC, cardinality(w.path) ASC,
             array_to_string(w.path, '>') || '>' COLLATE "C" ASC
    LIMIT 1
)
SELECT u.i - 1, u.sid, s.description, fh.name, pick.delays[u.i],
       CASE WHEN u.i = 1 THEN NULL ELSE pick.bufs[u.i - 1] END,
       pick.pid, pick.city, pick.due_date, pick.late, pick.late * pick.penalty_per_day, pick.port
FROM pick
CROSS JOIN LATERAL unnest(pick.path) WITH ORDINALITY AS u(sid, i)
JOIN shipment s ON s.id = u.sid
JOIN leg lg ON lg.shipment_id = u.sid AND lg.seq = 1
JOIN hub fh ON fh.id = lg.from_hub
ORDER BY u.i
"""
WHY_COLS = ["step", "shipment", "what", "leaves_from", "days_late_here", "slack_days",
            "order_ref", "city", "promised", "days_late", "late_fee", "port"]


def why_falkor(g, p):
    text = WHY_CYPHER.format(depth=int(p["depth"]))
    params = {"event": p["event"], "customer": p["customer"]}
    res, ms = _timed(lambda: g.query(text, params).result_set)
    return Run(_norm(res), text, params, ms)


def why_pg(conn, p):
    params = {"event": p["event"], "customer": p["customer"], "depth": int(p["depth"])}
    res, ms = _timed(lambda: conn.execute(WHY_SQL, params).fetchall())
    return Run(_norm(res), WHY_SQL, params, ms)


def why_answer(rows, p, ctx):
    ev = ctx["events"][p["event"]]
    if not rows:
        return f"{p['customer']} has no orders hurt by {ev['short']}."
    first, last = rows[0], rows[-1]
    port = ctx["hubs"].get(first[11], first[11])
    return (f"{p['customer']}'s order arrives {_plural(last[9], 'day')} late because {first[2]} got stuck at {port}; "
            f"the delay travelled {_plural(len(rows) - 1, 'step')} along the supply chain to reach it.")


def why_graph(rows, p, ctx):
    ev = ctx["events"][p["event"]]
    if not rows:
        return {"nodes": [], "links": [], "truncated": False}
    port = rows[0][11]
    port_name = ctx["hubs"].get(port, port)
    nodes = [
        {"id": ev["id"], "kind": "event", "label": ev["name"], "tone": "danger", "size": 2, "step": 0,
         "why": [ev["name"] + ".", f"Closed {ev['when']}, then {ev['backlog']} more days of backlog."]},
        {"id": port, "kind": "port", "label": port_name, "tone": "danger", "size": 3, "step": 0,
         "why": [f"{port_name} is shut.", "Anything due through it waits until it reopens."]},
    ]
    links = [{"source": ev["id"], "target": port, "tone": "danger", "label": "shut",
              "why": [f"{ev['name']} closes {port_name}."]}]
    prev = port
    for i, r in enumerate(rows):
        late_here, slack = r[4], r[5]
        if i == 0:
            why = [f"{_cap(r[2])} ({r[1]}).", f"It was due through {port_name} while it was shut.",
                   f"It starts {_plural(late_here, 'day')} late."]
            link_why = [f"{r[1]} was due through {port_name} during the closure."]
        else:
            cover = "No slack here, so" if not slack else f"{_plural(slack, 'day')} of slack at {r[3]} {'absorbs' if slack == 1 else 'absorb'} part of it, so"
            why = [f"{_cap(r[2])} ({r[1]}).", f"It cannot leave {r[3]} until the step before arrives.",
                   f"{cover} it leaves {_plural(late_here, 'day')} late."]
            link_why = [f"{r[1]} waits for {rows[i - 1][1]}.",
                        "No slack in between." if not slack else f"{_plural(slack, 'day')} of slack in between."]
        nodes.append({"id": r[1], "kind": "shipment", "label": _cap(r[2]),
                      "tone": "danger" if late_here >= 4 else "warning", "size": 1.4, "step": i + 1, "why": why})
        links.append({"source": prev, "target": r[1], "tone": "warning",
                      "label": f"+{late_here}d", "why": link_why})
        prev = r[1]
    last = rows[-1]
    oid = last[6]
    nodes.append({"id": oid, "kind": "order", "label": f"{p['customer']}'s order", "tone": "danger", "size": 1.6,
                  "step": len(rows) + 1,
                  "why": [f"{p['customer']} in {last[7]} was promised delivery on {_day(last[8])}.",
                          f"It will arrive {_plural(last[9], 'day')} late; the late fee is {_usd(last[10])}."]})
    links.append({"source": prev, "target": oid, "tone": "danger", "label": "late",
                  "why": [f"This parcel carries {p['customer']}'s order."]})
    return {"nodes": nodes, "links": links, "truncated": False}


# =============================================================================================
# 4. rescue_first: groups of late orders that share a cause, biggest first
# =============================================================================================
DESC_CYPHER = "UNWIND $ids AS x MATCH (s:Shipment {id: x}) RETURN s.id, s.description"
DESC_SQL = "SELECT id, description FROM shipment WHERE id = ANY(%(ids)s)"


def _clusters_rows(cl, descs):
    rows = []
    for c in cl:
        roots = sorted(r for r in c["roots"] if r)
        rows.append((", ".join(roots), " / ".join(descs.get(r, r) for r in roots), c["promises_at_risk"],
                     round(float(c["penalty_usd"] or 0), 2), c["shipments"]))
    return sorted(rows, key=lambda r: (-r[3], r[0]))


def rescue_falkor(g, p):
    def go():
        cl = fs.clusters(g, p["event"], int(p["depth"]))
        ids = sorted({r for c in cl for r in c["roots"] if r})
        descs = dict(g.query(DESC_CYPHER, {"ids": ids}).result_set)
        return cl, descs
    (cl, descs), ms = _timed(go)
    text = "// 1. tag the delayed shipments\n" + fs.MARK_IMPACTED.strip() + "\n\n// 2. connected groups\n" + fs.CLUSTERS.strip()
    return Run(_clusters_rows(cl, descs), text, {"event": p["event"], "depth": int(p["depth"])}, ms)


def rescue_pg(conn, p):
    def go():
        cl = ps.clusters_pgr(conn, p["event"], int(p["depth"]))
        ids = sorted({r for c in cl for r in (c["roots"] or []) if r})
        descs = dict(conn.execute(DESC_SQL, {"ids": ids}).fetchall())
        return cl, descs
    (cl, descs), ms = _timed(go)
    return Run(_clusters_rows(cl, descs), ps.CLUSTERS_PGR, {"event": p["event"], "depth": int(p["depth"])}, ms)


RESCUE_COLS = ["rescue", "what", "late_orders", "late_fees", "shipments_affected"]


def rescue_answer(rows, p, ctx):
    ev = ctx["events"][p["event"]]
    if not rows:
        return f"Nothing to rescue: no orders are hurt by {ev['short']}."
    top = rows[0]
    total = sum(r[2] for r in rows)
    n_roots = sum(len(r[0].split(", ")) for r in rows)
    return (f"Rescue {top[0]} first: on its own it makes {_plural(top[2], 'order')} late ({_usd(top[3])} in fees). "
            f"All {total:,} late orders fall into {len(rows)} groups that trace back to {_plural(n_roots, 'shipment')}.")


def rescue_graph(rows, p, ctx):
    ev = ctx["events"][p["event"]]
    nodes = {ev["id"]: {"id": ev["id"], "kind": "event", "label": ev["name"], "tone": "danger", "size": 2,
                        "why": [ev["name"] + ".", f"Closed {ev['when']}."]}}
    links = []
    for h in ev["hubs"]:
        nodes[h] = {"id": h, "kind": "port", "label": ctx["hubs"].get(h, h), "tone": "danger", "size": 3,
                    "why": [f"{ctx['hubs'].get(h, h)} is shut.", "Every group below starts with a shipment stuck here."]}
        links.append({"source": ev["id"], "target": h, "tone": "danger", "why": ["The disruption closes this port."]})
    for i, r in enumerate(rows):
        gid = f"group-{i + 1}"
        nodes[gid] = {"id": gid, "kind": "group", "label": f"{r[2]:,} late orders", "tone": "danger" if i == 0 else "warning",
                      "size": 1 + r[2] / max(1, rows[0][2]) * 2.5,
                      "why": [f"{_plural(r[2], 'order')} late, {_usd(r[3])} in late fees.",
                              f"They all wait on: {r[1]}.", "Rescue that and the whole group is back on time."]}
        for root, what in zip(r[0].split(", "), r[1].split(" / ")):
            nodes[root] = {"id": root, "kind": "shipment", "label": _cap(what), "tone": "warning", "size": 1.4,
                           "why": [f"{_cap(what)} ({root}).", "Stuck at the closed port.",
                                   f"{_plural(r[2], 'order')} wait on it."]}
            links.append({"source": ev["hubs"][0], "target": root, "tone": "danger", "why": [f"{root} is stuck at the port."]})
            links.append({"source": root, "target": gid, "tone": "warning", "label": f"{r[2]:,} orders",
                          "why": [f"These {r[2]:,} orders all depend on {root}."]})
    return {"nodes": list(nodes.values()), "links": links, "truncated": False}


# =============================================================================================
# 5. weak_points: places most of our routes depend on (betweenness, exact)
# =============================================================================================
LANES_AMONG_CYPHER = ("MATCH (a:Hub)-[l:LANE]->(b:Hub) WHERE a.id IN $ids AND b.id IN $ids "
                      "RETURN a.id, b.id, l.mode, l.days")
LANES_AMONG_SQL = "SELECT src, dst, mode, days FROM lane WHERE src = ANY(%(ids)s) AND dst = ANY(%(ids)s)"
TOP = 8


def _top(rows):
    rows = sorted(((h, n, k, round(s, 1)) for h, n, k, s in rows), key=lambda r: (-r[3], r[0]))
    return rows[:TOP]


def weak_falkor(g, p):
    def go():
        top = _top(fs.chokepoints(g, 30))
        lanes = g.query(LANES_AMONG_CYPHER, {"ids": [r[0] for r in top]}).result_set
        return top, lanes
    (top, lanes), ms = _timed(go)
    return Run(_norm(top), fs.CHOKEPOINTS, {"k": 30}, ms, {"lanes": sorted(map(tuple, lanes))})


def weak_pg(conn, p):
    def go():
        top = _top(ps.chokepoints_pgr(conn, 30))
        lanes = conn.execute(LANES_AMONG_SQL, {"ids": [r[0] for r in top]}).fetchall()
        return top, lanes
    (top, lanes), ms = _timed(go)
    return Run(_norm(top), ps.CHOKEPOINTS_PGR, {"k": 30}, ms, {"lanes": sorted(map(tuple, lanes))})


WEAK_COLS = ["place_id", "place", "kind", "routes_through_it"]


def weak_answer(rows, p, ctx):
    names = [r[1] for r in rows[1:3]]
    return (f"{rows[0][1]} is the place everything depends on most: more of our shortest routes pass through it "
            f"than anywhere else. Next come {names[0]} and {names[1]}.")


def weak_graph(rows, p, ctx, extra):
    kinds = {"port": "port", "airport": "airport", "dc_national": "warehouse", "dc_regional": "warehouse"}
    nodes = [{"id": h, "kind": kinds.get(k, "place"), "label": n, "tone": "danger" if i == 0 else "warning" if i < 3 else "neutral",
              "size": 1 + s / rows[0][3] * 3,
              "why": [f"About {s:,.0f} of the shortest routes between our places pass through {n}.",
                      "If it closes, all of those routes have to find another way."]}
             for i, (h, n, k, s) in enumerate(rows)]
    mode_word = {"ocean": "by sea", "air": "by air", "rail": "by rail", "truck": "by road", "parcel": "by van"}
    links = [{"source": a, "target": b, "tone": "muted", "label": f"{mode_word.get(m, m)}, {_plural(d, 'day')}",
              "why": [f"A {mode_word.get(m, m)[3:]} route, {_plural(d, 'day')}."]}
             for a, b, m, d in extra.get("lanes", [])]
    return {"nodes": nodes, "links": links, "truncated": False}


# =============================================================================================
# 6. reroute: fastest ways from A to B that avoid a closed place
# =============================================================================================
def _routes(found):
    rows = [(" > ".join(r["hubs"]), " > ".join(r["modes"]), int(r["days"]), round(r["usd_per_kg"], 2)) for r in found]
    return sorted(rows, key=lambda r: (r[2], r[3], r[0]))[:3]


def reroute_falkor(g, p):
    found, ms = _timed(lambda: fs.reroute(g, p["from_hub"], p["to_hub"], [p["avoid_hub"]], "days", 20))
    return Run(_routes(found), fs.REROUTE.format(weight="days", cost="cost_per_kg"),
               {"src": p["from_hub"], "dst": p["to_hub"], "closed": [p["avoid_hub"]], "k": 20}, ms)


def reroute_pg(conn, p):
    (found, _k), ms = _timed(lambda: ps.reroute_pgr(conn, p["from_hub"], p["to_hub"], [p["avoid_hub"]], "days", 20))
    return Run(_routes(found), ps.REROUTE_PGR.format(weight="days"),
               {"src": p["from_hub"], "dst": p["to_hub"], "closed": [p["avoid_hub"]], "k": 20}, ms)


REROUTE_COLS = ["route", "travel", "days", "usd_per_kg"]
MODE = {"ocean": "sea", "air": "air", "rail": "rail", "truck": "road", "parcel": "van"}


def reroute_answer(rows, p, ctx):
    a, b, x = (ctx["hubs"][p[k]] for k in ("from_hub", "to_hub", "avoid_hub"))
    if not rows:
        return f"There is no route from {a} to {b} that avoids {x} within 7 legs."
    hubs, modes, days, usd = rows[0][0].split(" > "), rows[0][1].split(" > "), rows[0][2], rows[0][3]
    via = [ctx["hubs"][h] for h in hubs[1:-1]]
    how = " and ".join(sorted({MODE.get(m, m) for m in modes}))
    return (f"Fastest way from {a} to {b} without {x}: by {how} via {', '.join(via) or 'a direct lane'}, "
            f"{_plural(days, 'day')} at ${usd} per kg.")


def reroute_graph(rows, p, ctx):
    nodes, links = {}, []
    x = p["avoid_hub"]
    nodes[x] = {"id": x, "kind": "port", "label": ctx["hubs"][x], "tone": "danger", "size": 2.5,
                "why": [f"{ctx['hubs'][x]} is avoided.", "None of these routes pass through it."]}
    for rank, r in enumerate(rows):
        hubs, modes = r[0].split(" > "), r[1].split(" > ")
        for i, h in enumerate(hubs):
            if h not in nodes:
                ends = h in (p["from_hub"], p["to_hub"])
                nodes[h] = {"id": h, "kind": ctx["kinds"].get(h, "place"), "label": ctx["hubs"].get(h, h),
                            "tone": "good" if ends else "neutral", "size": 2.2 if ends else 1.4,
                            "why": [ctx["hubs"].get(h, h) + ".",
                                    "Start of the route." if h == p["from_hub"] else
                                    "Destination." if h == p["to_hub"] else "A stop on an alternative route."]}
            if i:
                links.append({"source": hubs[i - 1], "target": h, "tone": "good" if rank == 0 else "muted",
                              "label": f"by {MODE.get(modes[i - 1], modes[i - 1])}",
                              "why": [f"Option {rank + 1}: {_plural(r[2], 'day')} door to door, ${r[3]} per kg.",
                                      f"This leg goes by {MODE.get(modes[i - 1], modes[i - 1])}."]})
    return {"nodes": list(nodes.values()), "links": links, "truncated": False}


# =============================================================================================
@dataclass
class Template:
    id: str
    title: str
    columns: list[str]
    falkor: Callable
    pg: Callable
    answer: Callable
    graph: Callable
    slots: tuple[str, ...]


TEMPLATES = {
    "at_risk": Template("at_risk", "Orders at risk", AT_RISK_COLS, at_risk_falkor, at_risk_pg, at_risk_answer,
                        at_risk_graph, ("event", "city?", "depth")),
    "orders_window": Template("orders_window", "Orders due in a date range", WINDOW_COLS, window_falkor, window_pg,
                              window_answer, window_graph, ("city", "from_day", "to_day")),
    "why_late": Template("why_late", "Why an order is late", WHY_COLS, why_falkor, why_pg, why_answer, why_graph,
                         ("customer", "event", "depth")),
    "rescue_first": Template("rescue_first", "What to rescue first", RESCUE_COLS, rescue_falkor, rescue_pg,
                             rescue_answer, rescue_graph, ("event", "depth")),
    "weak_points": Template("weak_points", "Places everything depends on", WEAK_COLS, weak_falkor, weak_pg,
                            weak_answer, weak_graph, ()),
    "reroute": Template("reroute", "Ways around a closed place", REROUTE_COLS, reroute_falkor, reroute_pg,
                        reroute_answer, reroute_graph, ("from_hub", "to_hub", "avoid_hub")),
}


def context(g) -> dict:
    """Names the answers and graphs need (events, hubs). Read once per request from FalkorDB."""
    evs = g.query("MATCH (e:Event)-[:AFFECTS]->(h:Hub) WHERE NOT coalesce(e.historic, false) "
                  "RETURN e.id, e.name, e.start_day, e.end_day, e.backlog_days, collect(h.id)").result_set
    hubs = g.query("MATCH (h:Hub) RETURN h.id, h.name, h.kind").result_set
    kinds = {"port": "port", "airport": "airport", "dc_national": "warehouse", "dc_regional": "warehouse",
             "factory": "factory", "supplier": "factory", "zone": "place"}
    events = {}
    for i, name, s, e, b, hs in evs:
        short = {"EV-SGSIN-1020": "Singapore's terminals shut", "EV-USWC-1120": "the LA / Long Beach ports went on strike"}
        events[i] = {"id": i, "name": name, "hubs": sorted(hs), "backlog": b,
                     "when": f"{_day(s)} to {_day(e)}", "short": short.get(i, name.lower())}
    persona = g.query("MATCH (c:Customer {name: 'Aisha Rahman'}) RETURN c.name LIMIT 1").result_set
    return {"events": events, "hubs": {h: n for h, n, _k in hubs},
            "kinds": {h: kinds.get(k, "place") for h, _n, k in hubs},
            "persona": persona[0][0] if persona else None}


def run(template_id: str, params: dict, engine: str, g, tenant: str, ctx: dict | None = None) -> tuple[Run, dict]:
    t = TEMPLATES[template_id]
    if engine == "falkordb":
        out = t.falkor(g, params)
    elif engine == "postgres":
        with ps.connect(tenant) as conn:
            out = t.pg(conn, params)
    else:
        raise ValueError("engine must be falkordb or postgres")
    return out, ctx or context(g)


def build_answer(template_id: str, params: dict, out: Run, ctx: dict, engine: str) -> dict:
    t = TEMPLATES[template_id]
    graph = t.graph(out.rows, params, ctx, out.extra) if t.id == "weak_points" else t.graph(out.rows, params, ctx)
    return {
        "template": t.id, "title": t.title,
        "answer": t.answer(out.rows, params, ctx),
        "columns": t.columns, "rows": [list(r) for r in out.rows[:MAX_ROWS]], "row_count": len(out.rows),
        "graph": graph,
        "query": query_info(engine, out),
    }


def query_info(engine: str, out: Run) -> dict:
    text = out.text.strip()
    return {"engine": engine, "text": text, "params": out.params, "chars": len(text),
            "lines": text.count("\n") + 1, "ms": round(out.ms, 2)}
