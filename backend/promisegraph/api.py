"""HTTP API for the frontend and the agents. Contract: docs/api-contract.md.

    uvicorn promisegraph.api:app --reload --port 8000

Everything here runs on FalkorDB except /race, which also runs the Postgres BASELINE so the
UI can show the engine scoreboard. The product does not fall back to Postgres anywhere.

When the frontend has been built (frontend/dist, or STATIC_DIR), this app serves it too, so a
deployment is one process on one origin (see the Dockerfile).
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import agents, memory, nl, questions, story, views
from . import falkor_store as fs
from . import pg_store as ps
from .config import graph_name, to_date

app = FastAPI(title="Promise Graph API")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"],
                   allow_headers=["*"])


class RunCreate(BaseModel):
    event_id: str
    requested_by: str = Field(min_length=1, max_length=80)


class Actor(BaseModel):
    by: str = Field(min_length=1, max_length=80)


def _graph(tenant: str):
    db = fs.connect()
    if graph_name(tenant) not in db.list_graphs():
        raise HTTPException(404, f"unknown tenant {tenant!r}")
    return db.select_graph(graph_name(tenant))


def _event_exists(g, event_id: str):
    if not g.query("MATCH (e:Event {id: $e}) RETURN e.id", {"e": event_id}).result_set:
        raise HTTPException(404, f"unknown event {event_id!r}")


@app.get("/api/health")
def health():
    db = fs.connect()
    tenants = [g.removeprefix("promise_") for g in db.list_graphs() if g.startswith("promise_")]
    # Tenants with agent memory are the companies; the rest (e.g. bench) are benchmark-only graphs.
    # Read-only on purpose: a normal query on a graph deleted a moment ago would re-create it empty.
    companies = []
    for t in tenants:
        try:
            if db.select_graph(graph_name(t)).ro_query("MATCH (a:Agent) RETURN count(a)").result_set[0][0]:
                companies.append(t)
        except Exception:  # deleted between list and query
            pass
    return {"falkordb": "ok", "tenants": tenants, "companies": companies}


@app.get("/api/{tenant}/events")
def events(tenant: str):
    """Live disruption scenarios. Past (historic) events are memory only and come back via recall."""
    res = _graph(tenant).query(
        "MATCH (e:Event)-[:AFFECTS]->(h:Hub) WHERE NOT coalesce(e.historic, false) "
        "RETURN e.id, e.name, e.type, e.start_day, e.end_day, e.backlog_days, collect(h.id) ORDER BY e.start_day")
    return [{"id": i, "name": n, "type": t, "start": to_date(s).isoformat(), "end": to_date(e).isoformat(),
             "backlog_days": b, "hubs": hubs} for i, n, t, s, e, b, hubs in res.result_set]


@app.get("/api/{tenant}/events/{event_id}/impact")
def impact(tenant: str, event_id: str, depth: int = Query(8, ge=0, le=12)):
    g = _graph(tenant)
    rows = fs.cascade(g, event_id, depth)
    who = fs.promise_details(g, [r[0] for r in rows])
    cols = ["promise", "order", "shipment", "delay_days", "hops", "days_late", "penalty_usd"]
    out = []
    for r in rows:
        d = who.get(r[0], {})
        out.append({**dict(zip(cols, r)), "customer": d.get("customer"), "city": d.get("city"),
                    "tier": d.get("tier"), "due_date": d.get("due_date")})
    return {"promises_at_risk": len(rows), "penalty_usd": sum(r[6] for r in rows), "rows": out}


@app.get("/api/{tenant}/events/{event_id}/clusters")
def clusters(tenant: str, event_id: str, depth: int = Query(8, ge=0, le=12)):
    return fs.clusters(_graph(tenant), event_id, depth)


@app.get("/api/{tenant}/events/{event_id}/subgraph")
def subgraph(tenant: str, event_id: str, depth: int = Query(8, ge=0, le=12),
             limit: int = Query(1500, ge=50, le=5000)):
    g = _graph(tenant)
    _event_exists(g, event_id)
    return views.subgraph(g, event_id, depth, limit)


@app.get("/api/{tenant}/promises/{promise_id}/path")
def promise_path(tenant: str, promise_id: str, event_id: str, depth: int = Query(8, ge=0, le=12)):
    g = _graph(tenant)
    _event_exists(g, event_id)
    out = views.promise_path(g, promise_id, event_id, depth)
    if out is None:
        raise HTTPException(404, f"unknown promise {promise_id!r}")
    return out


@app.get("/api/{tenant}/chokepoints")
def chokepoints(tenant: str, k: int = Query(10, ge=1, le=50)):
    return [{"hub": h, "name": n, "kind": kind, "betweenness": round(s, 1)}
            for h, n, kind, s in fs.chokepoints(_graph(tenant), k)]


@app.get("/api/{tenant}/reroute")
def reroute(tenant: str, src: str, dst: str, closed: list[str] = Query(default=[]),
            by: str = Query("days", pattern="^(days|cost)$"), k: int = Query(3, ge=1, le=10)):
    return fs.reroute(_graph(tenant), src, dst, closed, by, k)


@app.get("/api/{tenant}/race/{event_id}")
def race(tenant: str, event_id: str, depth: int = Query(8, ge=0, le=12)):
    """Engine scoreboard: same question to FalkorDB and to the Postgres baseline."""
    g = _graph(tenant)
    t0 = time.perf_counter()
    fk = fs.cascade(g, event_id, depth)
    fk_ms = (time.perf_counter() - t0) * 1000
    with ps.connect(tenant) as conn:
        t0 = time.perf_counter()
        pg = ps.cascade(conn, event_id, depth)
        pg_ms = (time.perf_counter() - t0) * 1000
    return {
        "same_answer": fk == pg,
        "promises_at_risk": len(fk),
        "depth": depth,
        "falkordb": {"ms": round(fk_ms, 2), "query": fs.cascade_query_text(depth).strip()},
        "postgres": {"ms": round(pg_ms, 2), "query": ps.CASCADE.strip()},
    }


# ---- agents ---------------------------------------------------------------------------------
@app.post("/api/{tenant}/runs")
def create_run(tenant: str, body: RunCreate):
    g = _graph(tenant)
    _event_exists(g, body.event_id)
    if not g.query("MATCH (a:Agent) RETURN count(a)").result_set[0][0]:
        raise HTTPException(409, f"tenant {tenant!r} has no agent memory; load it without --no-memory")
    run_id = agents.start_run(g, body.event_id, body.requested_by.strip())
    return memory.get_run(g, run_id)


@app.get("/api/{tenant}/runs")
def list_runs(tenant: str):
    return memory.list_runs(_graph(tenant))


@app.get("/api/{tenant}/runs/{run_id}")
def get_run(tenant: str, run_id: str):
    run = memory.get_run(_graph(tenant), run_id)
    if run is None:
        raise HTTPException(404, f"unknown run {run_id!r}")
    return run


def _act(tenant: str, run_id: str, decision_id: str, fn, by: str):
    g = _graph(tenant)
    try:
        fn(g, run_id, decision_id, by.strip())
    except agents.PolicyError as ex:
        raise HTTPException(403, str(ex))
    except agents.StateError as ex:
        raise HTTPException(409, str(ex))
    except KeyError as ex:
        raise HTTPException(404, f"unknown {ex}")
    return memory.get_run(g, run_id)


@app.post("/api/{tenant}/runs/{run_id}/decisions/{decision_id}/approve")
def approve(tenant: str, run_id: str, decision_id: str, body: Actor):
    return _act(tenant, run_id, decision_id, agents.approve, body.by)


@app.post("/api/{tenant}/runs/{run_id}/decisions/{decision_id}/reject")
def reject(tenant: str, run_id: str, decision_id: str, body: Actor):
    return _act(tenant, run_id, decision_id, agents.reject, body.by)


@app.get("/api/{tenant}/decisions/{decision_id}/evidence")
def decision_evidence(tenant: str, decision_id: str):
    out = views.evidence(_graph(tenant), decision_id)
    if out is None:
        raise HTTPException(404, f"unknown decision {decision_id!r}")
    return out


# ---- ask: the prompt box (docs/ui-contract.md) ------------------------------------------------
class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=300)
    engine: str = Field("falkordb", pattern="^(falkordb|postgres)$")


class CompareBody(BaseModel):
    question: str = Field(min_length=1, max_length=300)


class _NotUnderstood(Exception):
    def __init__(self, detail: str, suggestions: list):
        self.detail, self.suggestions = detail, suggestions


@app.exception_handler(_NotUnderstood)
def _not_understood(_request, ex: _NotUnderstood):
    return JSONResponse(status_code=422, content={"detail": ex.detail, "suggestions": ex.suggestions})


def _interpret(g, question: str, tenant: str):
    ctx = questions.context(g)
    try:
        template, params, how = nl.interpret(question, g, ctx)
    except nl.NotUnderstood as ex:
        raise _NotUnderstood(str(ex), story.chips(g, ctx))
    return template, params, how, ctx


@app.get("/api/{tenant}/chips")
def chips(tenant: str):
    g = _graph(tenant)
    return story.chips(g, questions.context(g))


@app.post("/api/{tenant}/ask")
def ask(tenant: str, body: Ask):
    g = _graph(tenant)
    template, params, how, ctx = _interpret(g, body.question, tenant)
    out, _ = questions.run(template, params, body.engine, g, tenant, ctx)
    answer = questions.build_answer(template, params, out, ctx, body.engine)
    return {**answer, "read_as": nl.read_as(template, params, ctx), "understood_by": how}


@app.post("/api/{tenant}/compare")
def compare(tenant: str, body: CompareBody):
    g = _graph(tenant)
    template, params, _how, ctx = _interpret(g, body.question, tenant)
    fk, _ = questions.run(template, params, "falkordb", g, tenant, ctx)
    pg, _ = questions.run(template, params, "postgres", g, tenant, ctx)
    return {"same_answer": fk.rows == pg.rows, "row_count": len(fk.rows), "template": template,
            "read_as": nl.read_as(template, params, ctx),
            "falkordb": questions.query_info("falkordb", fk), "postgres": questions.query_info("postgres", pg)}


@app.get("/api/{tenant}/sweep")
def sweep(tenant: str, event_id: str, runs: int = Query(3, ge=1, le=7)):
    """Orders at risk at every depth 2..8 on both engines: real timings, median of `runs`."""
    import statistics
    g = _graph(tenant)
    _event_exists(g, event_id)
    ctx = questions.context(g)
    points = []
    with ps.connect(tenant) as conn:
        for depth in range(2, 9):
            p = {"event": event_id, "city": None, "depth": depth}
            questions.at_risk_falkor(g, p), questions.at_risk_pg(conn, p)  # warm-up
            fk_ms, pg_ms = [], []
            for _ in range(runs):
                a = questions.at_risk_falkor(g, p)
                b = questions.at_risk_pg(conn, p)
                fk_ms.append(a.ms)
                pg_ms.append(b.ms)
            points.append({"depth": depth, "same_answer": a.rows == b.rows, "row_count": len(a.rows),
                           "falkordb_ms": round(statistics.median(fk_ms), 2),
                           "postgres_ms": round(statistics.median(pg_ms), 2)})
    return {"event_id": event_id, "tenant": tenant, "runs_per_point": runs, "points": points}


@app.get("/api/{tenant}/story")
def get_story(tenant: str, event_id: str):
    g = _graph(tenant)
    _event_exists(g, event_id)
    return story.story(g, event_id, questions.context(g))


@app.get("/api/{tenant}/memory/recall")
def recall(tenant: str, event_id: str):
    g = _graph(tenant)
    _event_exists(g, event_id)
    return {"recall": memory.recall(g, event_id), "playbooks": memory.playbooks(g, event_id)}


# Mounted last so every /api route above wins.
WEB_DIST = Path(os.getenv("STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
