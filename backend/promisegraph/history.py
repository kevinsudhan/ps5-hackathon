"""Seeded, SYNTHETIC history so agent memory has something to recall on day one.

Three past disruptions, each with a run, an approved plan and an outcome. One of them did not
pay off (air-freighting full containers during a Suez suspension); that failure becomes a
playbook with a bad success rate, and Finance reads it to rule out the same mistake today.
Everything is written through memory.py, the same functions the live agents use.
"""
from . import memory

PAST = [
    {
        "run": "RUN-HIST-LKCMB", "event": "EV-LKCMB-0420", "hub": "LKCMB", "at": "2026-04-20T06:10:00+00:00",
        "requested_by": "Shyam Nair", "approved_by": "Pranay J Sathish",
        "impact": "214 promises at risk across 2 clusters after the Colombo crane outage.",
        "plan": "Rerouted 2 root shipments by sea through Singapore instead of Colombo",
        "cost": 9400, "saved": 31800, "promises": 214, "worked": True,
        "outcome": "Worked: 198 of 214 promises kept; spent $9,400, avoided $29,900 in penalties",
        "playbook": ("PB-SEA-NEIGHBOUR", "port_closure", "A transshipment port shuts for a few days",
                     "Reroute cluster root shipments by sea through a neighbouring port"),
    },
    {
        "run": "RUN-HIST-MYPKG", "event": "EV-MYPKG-0608", "hub": "MYPKG", "at": "2026-06-08T03:40:00+00:00",
        "requested_by": "Manish Arunkumar", "approved_by": "Kevin Sudhan",
        "impact": "362 promises at risk across 3 clusters after Port Klang closed its gates.",
        "plan": "Rerouted 3 root shipments by sea through Tanjung Pelepas",
        "cost": 18200, "saved": 52600, "promises": 362, "worked": True,
        "outcome": "Worked: 340 of 362 promises kept; spent $18,200, avoided $52,600 in penalties",
        "playbook": ("PB-SEA-NEIGHBOUR", "port_closure", "A transshipment port shuts for a few days",
                     "Reroute cluster root shipments by sea through a neighbouring port"),
    },
    {
        "run": "RUN-HIST-EGPSD", "event": "EV-EGPSD-0715", "hub": "EGPSD", "at": "2026-07-15T09:25:00+00:00",
        "requested_by": "Pranay J Sathish", "approved_by": "Manish Arunkumar",
        "impact": "290 promises at risk across 2 clusters after the Suez convoy suspension.",
        "plan": "Air-freighted 2 full containers to the European DC",
        "cost": 96000, "saved": 41000, "promises": 290, "worked": False,
        "outcome": "Did not pay off: spent $96,000 on air freight to avoid $41,000 in penalties",
        "playbook": ("PB-AIR-FULL-CONTAINER", "any", "Rescuing full containers (5+ tonnes)",
                     "Air-freighting full containers"),
    },
]


def seed(g):
    for p in PAST:
        if g.query("MATCH (r:Run {id: $id}) RETURN r.id", {"id": p["run"]}).result_set:
            continue
        memory.create_run(g, p["event"], p["requested_by"], run_id=p["run"], created_at=p["at"])
        memory.add_decision(g, p["run"], "sentinel", "alert", f"{p['hub']} disrupted.",
                            evidence={"Event": [p["event"]], "Hub": [p["hub"]]}, created_at=p["at"])
        memory.add_decision(g, p["run"], "impact_analyst", "impact", p["impact"],
                            numbers={"promises_at_risk": p["promises"]}, created_at=p["at"])
        plan = memory.add_decision(
            g, p["run"], "finance", "plan", p["plan"] + ".", status="verified", requires_approval=True,
            numbers={"cost_usd": p["cost"], "saved_usd": p["saved"]}, evidence={"Hub": [p["hub"]]},
            created_at=p["at"])
        # Keep the action text exactly as the plan, so recall can quote it.
        g.query("MATCH (d:Decision {id: $d}) SET d.summary = $s", {"d": plan, "s": p["plan"]})
        memory.set_decision_status(g, plan, "approved", p["approved_by"])
        memory.record_outcome(g, plan, p["outcome"], p["cost"], p["saved"], p["promises"],
                              worked=p["worked"], expected=False)
        pid, etype, trigger, action = p["playbook"]
        memory.upsert_playbook(g, pid, etype, trigger, action, worked=p["worked"], decision_id=plan)
        memory.set_run_status(g, p["run"], "done")
