"""Data for "Play the story" and for the suggestion chips. FalkorDB only (this is the product).

The story graph: the closed port, every delayed shipment before the last mile (with how many
supply-chain steps it sits from the port), and the broken orders (worst first, capped), plus one
order's full chain for the camera to fly along. Every number comes from the same queries the rest
of the product uses.
"""
from __future__ import annotations

from collections import Counter
from datetime import date

from . import falkor_store as fs
from . import questions as q
from .config import TODAY, to_date, to_day

ORDER_CAP = 100


def story(g, event_id: str, ctx: dict) -> dict:
    ev = ctx["events"][event_id]
    impacted = {sid: (delay, hops) for sid, delay, hops in fs.impacted(g, event_id, 8)}
    rows = fs.cascade(g, event_id, 8)
    who = fs.promise_details(g, [r[0] for r in rows])
    ships = g.query("UNWIND $ids AS x MATCH (s:Shipment {id: x}) RETURN s.id, s.stage, s.description",
                    {"ids": list(impacted)}).result_set
    stage = {i: st for i, st, _d in ships}
    desc = {i: d for i, _st, d in ships}
    backbone = [s for s in impacted if stage.get(s) != "lastmile"]
    hits = fs.hits(g, event_id)

    persona_name = ctx.get("persona")
    if not persona_name or not any(who.get(r[0], {}).get("customer") == persona_name for r in rows):
        worst = max(rows, key=lambda r: (r[4], r[5], r[0]), default=None)
        persona_name = who[worst[0]]["customer"] if worst else None

    nodes: dict[str, dict] = {}
    links: list[dict] = []
    nodes[event_id] = {"id": event_id, "kind": "event", "label": ev["name"], "tone": "danger", "size": 2, "step": 0,
                       "why": [ev["name"] + ".", f"Closed {ev['when']}, then {ev['backlog']} more days of backlog."]}
    for h in ev["hubs"]:
        name = ctx["hubs"][h]
        n_hit = sum(1 for x in hits.values() if x["hub"] == h)
        nodes[h] = {"id": h, "kind": "port", "label": name, "tone": "danger", "size": 3.2, "step": 0,
                    "why": [f"{name} is shut.", f"{q._plural(n_hit, 'shipment')} on the way through it are stuck."]}
        links.append({"source": event_id, "target": h, "tone": "danger", "label": "shut",
                      "why": [f"{ev['name']} closes {name}."]})
    for sid in backbone:
        delay, hops = impacted[sid]
        what = q._cap(desc.get(sid) or sid)
        nodes[sid] = {"id": sid, "kind": "shipment", "label": what, "tone": "danger" if delay >= 4 else "warning",
                      "size": 1.6 if hops == 0 else 1.2, "step": hops + 1,
                      "why": [f"{what} ({sid}).",
                              "Stuck at the closed port." if hops == 0 else
                              f"{q._plural(hops, 'step')} along the supply chain from the port.",
                              f"Now running {q._plural(delay, 'day')} late."]}
        if sid in hits:
            links.append({"source": hits[sid]["hub"], "target": sid, "tone": "danger", "label": "stuck",
                          "why": [f"{sid} was due through {ctx['hubs'][hits[sid]['hub']]} while it was shut."]})
    backbone_set = set(backbone)
    for a, b, buf in g.query("UNWIND $ids AS x MATCH (a:Shipment {id: x}) WITH a "
                             "MATCH (a)-[f:FEEDS]->(b:Shipment) RETURN a.id, b.id, f.buffer_days",
                             {"ids": backbone}).result_set:
        if b in backbone_set:
            links.append({"source": a, "target": b, "tone": "warning",
                          "why": [f"{b} cannot leave until {a} arrives.",
                                  "No slack in between." if not buf else f"{q._plural(buf, 'day')} of slack in between."]})

    ranked = sorted(rows, key=lambda r: (who[r[0]]["customer"] != persona_name, -r[6], r[0]))
    shown = ranked[:ORDER_CAP]
    feeders = dict(g.query("UNWIND $ids AS x MATCH (lm:Shipment {id: x}) WITH lm "
                           "MATCH (t:Shipment)-[:FEEDS]->(lm) WHERE t.stage = 'transfer' RETURN lm.id, min(t.id)",
                           {"ids": [r[2] for r in shown]}).result_set)
    for r in shown:
        d = who[r[0]]
        nodes[r[0]] = {"id": r[0], "kind": "order", "label": f"{d['customer']}'s order", "tone": "danger", "size": 1,
                       "step": r[4] + 1,
                       "why": [f"{d['customer']} in {d['city']} was promised delivery on {q._day(d['due_date'])}.",
                               f"It will arrive {q._plural(r[5], 'day')} late; the late fee is {q._usd(r[6])}."]}
        if feeders.get(r[2]) in backbone_set:
            links.append({"source": feeders[r[2]], "target": r[0], "tone": "warning",
                          "why": [f"{d['customer']}'s parcel leaves after {feeders[r[2]]} arrives."]})

    persona = None
    if persona_name:
        p = {"customer": persona_name, "event": event_id, "depth": 8}
        steps = q.why_falkor(g, p).rows
        if steps:
            path = [event_id, steps[0][11]] + [s[1] for s in steps[:-1]] + [steps[-1][6]]
            path = [x for x in path if x in nodes]
            last = steps[-1]
            persona = {"node_id": last[6], "path": path,
                       "caption": f"{persona_name}'s order: promised for {q._day(last[8])}, now "
                                  f"{q._plural(last[9], 'day')} late, {q._plural(len(steps) - 1, 'step')} from the port."}

    port_names = " and ".join(ctx["hubs"][h] for h in ev["hubs"])
    fee = sum(r[6] for r in rows)
    return {
        "event": {"id": event_id, "name": ev["name"],
                  "start": ev["when"].split(" to ")[0], "end": ev["when"].split(" to ")[1]},
        "graph": {"nodes": list(nodes.values()), "links": links, "truncated": len(shown) < len(rows),
                  "note": f"Showing the {len(shown)} worst of {len(rows):,} late orders." if len(shown) < len(rows) else None},
        "persona": persona,
        "captions": {
            "closes": f"{ev['name']}. {port_names} is closed {ev['when']}.",
            "spreads": f"The delay moves along the supply chain: {q._plural(len(backbone), 'shipment')} slip, one step after another.",
            "breaks": f"{len(rows):,} customer orders will now arrive late: {q._usd(fee)} in late fees.",
            "agents": "Six AI agents work out a fix together, and a person approves it.",
            "memory": "Memory: we have seen something like this before.",
        },
    }


def chips(g, ctx: dict) -> list[dict]:
    """Six suggestions with real values that return results for this company."""
    event = next((e for e in ctx["events"] if "SGSIN" in e), sorted(ctx["events"])[0])
    port_short = "Singapore" if "SGSIN" in event else ctx["hubs"][ctx["events"][event]["hubs"][0]]
    rows = fs.cascade(g, event, 8)
    who = fs.promise_details(g, [r[0] for r in rows])
    persona = ctx.get("persona") if any(d["customer"] == ctx.get("persona") for d in who.values()) else None
    if not persona and rows:
        worst = max(rows, key=lambda r: (r[4], r[5], r[0]))
        persona = who[worst[0]]["customer"]

    # a city and a 7-day window with plenty of orders due
    due = g.query("MATCH (c:Customer)-[:PLACED]->(:Order)-[:HAS_PROMISE]->(p:Promise {status: 'active'}) "
                  "RETURN c.city, p.due_day").result_set
    city = "Miami" if any(c == "Miami" for c, _ in due) else Counter(c for c, _ in due).most_common(1)[0][0]
    days = Counter(d for c, d in due if c == city)
    week = lambda d: sum(days.get(d + i, 0) for i in range(7))  # noqa: E731
    dec1 = to_day(date(TODAY.year, 12, 1))
    # Prefer an easy-to-say window (Dec 1-7) when it has orders, else the busiest week.
    start = dec1 if week(dec1) else max(days, key=lambda d: (week(d), -d))
    a, b = to_date(start), to_date(start + 6)

    out = [
        {"label": f"Orders at risk from {port_short}", "question": f"Which orders are at risk because {port_short} closed?"},
        {"label": f"{city} orders, {a.strftime('%b')} {a.day}-{b.day}" if a.month == b.month else f"{city} orders due soon",
         "question": f"Show orders from {city} customers due between {a.strftime('%b')} {a.day} and {b.strftime('%b')} {b.day}"},
    ]
    if persona:
        short = persona.split()[0] if len(persona.split()) == 2 else persona
        out.append({"label": f"Why is {short}'s order late?", "question": f"Why is {persona}'s order late?"})
    out += [
        {"label": "What to rescue first", "question": "Which shipments should we rescue first?"},
        {"label": "Places everything depends on", "question": "Which ports does everything depend on?"},
        {"label": f"A way around {port_short}",
         "question": f"How do we get goods from Ho Chi Minh City to Venlo without {port_short}?"},
    ]
    return out
