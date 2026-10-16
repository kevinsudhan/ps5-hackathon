"""PostgreSQL BASELINE. Not part of the product.

This exists only so we can race FalkorDB against a fair relational baseline on the same
synthetic data and prove both return the same answer. Rules for keeping it fair:
  * every join column and filter column is indexed,
  * ANALYZE runs after loading,
  * the recursive CTE prunes dead branches early (something FalkorDB's version does not get),
  * where Postgres has a graph algorithm via an extension (pgRouting: connected components,
    betweenness, k shortest paths), the race uses it too,
  * nothing is cached between runs by our code.
"""
from __future__ import annotations

import time

import psycopg

from .config import PG_DSN
from .datagen import Dataset

SCHEMA = """
DROP SCHEMA IF EXISTS {s} CASCADE;
CREATE SCHEMA {s};
SET search_path TO {s};
CREATE TABLE hub (id text PRIMARY KEY, name text, kind text, country text, lat float8, lon float8, region text);
CREATE TABLE carrier (id text PRIMARY KEY, name text, mode text);
CREATE TABLE lane (src text REFERENCES hub, dst text REFERENCES hub, mode text, days int, cost_per_kg float8,
                   PRIMARY KEY (src, dst, mode));
CREATE TABLE customer (id text PRIMARY KEY, name text, tier text, zone text REFERENCES hub, city text);
CREATE TABLE orders (id text PRIMARY KEY, customer_id text REFERENCES customer, placed_day int, value_usd int,
                     family text, channel text);
CREATE TABLE promise (id text PRIMARY KEY, order_id text REFERENCES orders, due_day int, due_date text,
                      status text, penalty_per_day int);
CREATE TABLE shipment (id text PRIMARY KEY, stage text, tier int, mode text, family text, description text,
                       origin text, destination text, weight_kg int, value_usd int, depart_day int, eta_day int);
CREATE TABLE fulfilled_by (order_id text REFERENCES orders, shipment_id text REFERENCES shipment,
                           PRIMARY KEY (order_id, shipment_id));
CREATE TABLE leg (id text PRIMARY KEY, shipment_id text REFERENCES shipment, seq int, mode text,
                  from_hub text REFERENCES hub, to_hub text REFERENCES hub, carrier_id text REFERENCES carrier,
                  depart_day int, arrive_day int);
CREATE TABLE feeds (src text REFERENCES shipment, dst text REFERENCES shipment, buffer_days int,
                    PRIMARY KEY (src, dst));
CREATE TABLE event (id text PRIMARY KEY, type text, name text, start_day int, end_day int, backlog_days int,
                    severity text);
CREATE TABLE affects (event_id text REFERENCES event, hub_id text REFERENCES hub, PRIMARY KEY (event_id, hub_id));
"""

INDEXES = """
CREATE INDEX ON leg (to_hub, arrive_day) INCLUDE (shipment_id);
CREATE INDEX ON leg (from_hub, depart_day) INCLUDE (shipment_id);
CREATE INDEX ON leg (shipment_id);
CREATE INDEX ON feeds (src) INCLUDE (dst, buffer_days);
CREATE INDEX ON feeds (dst);
CREATE INDEX ON fulfilled_by (shipment_id);
CREATE INDEX ON promise (order_id) INCLUDE (status, due_day, penalty_per_day);
CREATE INDEX ON orders (customer_id);
CREATE INDEX ON shipment (stage);
CREATE INDEX IF NOT EXISTS customer_name_idx ON customer (name);
CREATE INDEX IF NOT EXISTS customer_city_idx ON customer (city);
CREATE INDEX IF NOT EXISTS promise_due_day_idx ON promise (due_day);
"""

# Indexes added after the first load; ensure_indexes() adds them to an existing schema.
LATE_INDEXES = INDEXES.split("CREATE INDEX ON shipment (stage);")[1]


def ensure_indexes(conn: psycopg.Connection):
    conn.execute(LATE_INDEXES)
    conn.execute("ANALYZE customer; ANALYZE promise")

COLUMNS = {
    "hub": ["id", "name", "kind", "country", "lat", "lon", "region"],
    "carrier": ["id", "name", "mode"],
    "lane": ["src", "dst", "mode", "days", "cost_per_kg"],
    "customer": ["id", "name", "tier", "zone", "city"],
    "orders": ["id", "customer_id", "placed_day", "value_usd", "family", "channel"],
    "promise": ["id", "order_id", "due_day", "due_date", "status", "penalty_per_day"],
    "shipment": ["id", "stage", "tier", "mode", "family", "description", "origin", "destination",
                 "weight_kg", "value_usd", "depart_day", "eta_day"],
    "fulfilled_by": ["order_id", "shipment_id"],
    "leg": ["id", "shipment_id", "seq", "mode", "from_hub", "to_hub", "carrier_id", "depart_day", "arrive_day"],
    "feeds": ["src", "dst", "buffer_days"],
    "event": ["id", "type", "name", "start_day", "end_day", "backlog_days", "severity"],
    "affects": ["event_id", "hub_id"],
}

SOURCE = {"orders": "orders", "fulfilled_by": "fulfilled_by"}  # table -> Dataset attribute (rest: name + 's')


def schema_name(tenant: str) -> str:
    if not tenant.isidentifier():
        raise ValueError("tenant must be a plain identifier")
    return f"t_{tenant}"


def connect(tenant: str) -> psycopg.Connection:
    conn = psycopg.connect(PG_DSN, autocommit=True)
    # public holds the pgRouting extension (its functions call each other unqualified).
    conn.execute(f"SET search_path TO {schema_name(tenant)}, public")
    return conn


def load(ds: Dataset) -> float:
    t0 = time.perf_counter()
    s = schema_name(ds.tenant)
    with psycopg.connect(PG_DSN, autocommit=True) as conn:
        # Once per database, in public so dropping a tenant schema never drops it.
        # CASCADE pulls in PostGIS, which pgRouting 3.x requires.
        conn.execute("CREATE EXTENSION IF NOT EXISTS pgrouting SCHEMA public CASCADE")
        conn.execute(SCHEMA.format(s=s))
        conn.execute(f"SET search_path TO {s}")
        for table, cols in COLUMNS.items():
            rows = getattr(ds, SOURCE.get(table, table if table.endswith("s") else table + "s"))
            with conn.cursor().copy(f"COPY {table} ({', '.join(cols)}) FROM STDIN") as cp:
                for r in rows:
                    cp.write_row([r.get(c) for c in cols])
        conn.execute(INDEXES)
        conn.execute("ANALYZE")
    return time.perf_counter() - t0


# Q1 baseline. Same semantics as falkor_store.CASCADE, written as a well-tuned recursive CTE.
CASCADE = """
WITH RECURSIVE
hit AS (
    SELECT x.shipment_id AS sid, MAX(e.end_day + e.backlog_days - x.t + 1) AS d0
    FROM event e
    JOIN affects a ON a.event_id = e.id
    CROSS JOIN LATERAL (
        SELECT l.shipment_id, l.arrive_day AS t FROM leg l
        WHERE l.to_hub = a.hub_id AND l.arrive_day BETWEEN e.start_day AND e.end_day
        UNION ALL
        SELECT l.shipment_id, l.depart_day FROM leg l
        WHERE l.from_hub = a.hub_id AND l.depart_day BETWEEN e.start_day AND e.end_day
    ) x
    WHERE e.id = %(event)s
    GROUP BY x.shipment_id
),
cascade (sid, delay, hops) AS (
    SELECT sid, d0, 0 FROM hit
    UNION
    SELECT f.dst, c.delay - f.buffer_days, c.hops + 1
    FROM cascade c
    JOIN feeds f ON f.src = c.sid
    WHERE c.hops < %(depth)s AND c.delay - f.buffer_days > 0
),
worst AS (
    SELECT sid, MAX(delay) AS delay, MIN(hops) AS hops FROM cascade GROUP BY sid
)
SELECT p.id, o.id, w.sid, w.delay, w.hops,
       s.eta_day + w.delay - p.due_day AS days_late,
       (s.eta_day + w.delay - p.due_day) * p.penalty_per_day AS penalty
FROM worst w
JOIN shipment s ON s.id = w.sid
JOIN fulfilled_by fb ON fb.shipment_id = w.sid
JOIN orders o ON o.id = fb.order_id
JOIN promise p ON p.order_id = o.id
WHERE p.status = 'active' AND s.eta_day + w.delay > p.due_day
"""


def cascade(conn: psycopg.Connection, event_id: str, depth: int) -> list[tuple]:
    rows = conn.execute(CASCADE, {"event": event_id, "depth": int(depth)}).fetchall()
    return sorted(tuple(r) for r in rows)


# Q3 baseline: stranded clusters, two ways. Both share the impacted set (the cascade CTE above)
# and the per-cluster stats below; only the connected-components step differs.
_WORST = CASCADE.split("SELECT p.id, o.id")[0].rstrip()
_CLUSTER_STATS = """
late AS (
    SELECT i.sid, (i.eta_day + i.delay - p.due_day) * p.penalty_per_day AS penalty
    FROM imp i
    JOIN fulfilled_by fb ON fb.shipment_id = i.sid
    JOIN promise p ON p.order_id = fb.order_id
    WHERE p.status = 'active' AND i.eta_day + i.delay > p.due_day
)
SELECT c.cluster,
       COUNT(DISTINCT c.sid) AS shipments,
       ARRAY_AGG(DISTINCT c.sid) FILTER (WHERE i.hops = 0) AS roots,
       COUNT(l.penalty) AS promises_at_risk,
       SUM(l.penalty) AS penalty_usd,
       ARRAY_AGG(DISTINCT c.sid) AS members
FROM comp c
JOIN imp i ON i.sid = c.sid
LEFT JOIN late l ON l.sid = c.sid
GROUP BY c.cluster
ORDER BY penalty_usd DESC NULLS LAST
"""

# (a) Plain SQL: label every impacted shipment with the smallest shipment id it can reach over
# undirected FEEDS edges (recursive reachability), then group by that label.
CLUSTERS = _WORST + """,
imp AS (SELECT w.sid, w.delay, w.hops, s.eta_day FROM worst w JOIN shipment s ON s.id = w.sid),
edge AS (
    SELECT f.src AS a, f.dst AS b FROM feeds f
    JOIN imp x ON x.sid = f.src JOIN imp y ON y.sid = f.dst
),
undirected AS (SELECT a, b FROM edge UNION ALL SELECT b, a FROM edge),
reach (root, node) AS (
    SELECT sid, sid FROM imp
    UNION
    SELECT r.root, u.b FROM reach r JOIN undirected u ON u.a = r.node
),
comp AS (SELECT node AS sid, MIN(root) AS cluster FROM reach GROUP BY node),""" + _CLUSTER_STATS

# (b) pgRouting: pgr_connectedComponents, the closest Postgres gets to FalkorDB's algo.WCC.
# pgRouting wants integer vertex ids and reads edges from a SQL string it runs on its own
# (it cannot see this query's CTEs), so impacted shipments are numbered in shipment-id order
# and the edge list is handed over inline as two bigint arrays. That was ~2.5x faster than
# materialising a temp table for pgRouting to read. pgRouting labels each component with its
# smallest vertex id, which maps back to the smallest shipment id: the same label as (a).
# Shipments with no impacted neighbour are not in pgRouting's output; they are their own cluster.
CLUSTERS_PGR = _WORST + """,
imp AS (
    SELECT w.sid, w.delay, w.hops, s.eta_day, ROW_NUMBER() OVER (ORDER BY w.sid) AS vid
    FROM worst w JOIN shipment s ON s.id = w.sid
),
edge AS (
    SELECT x.vid AS source, y.vid AS target FROM feeds f
    JOIN imp x ON x.sid = f.src JOIN imp y ON y.sid = f.dst
),
cc AS (
    SELECT node, component FROM pgr_connectedComponents((
        SELECT 'SELECT row_number() OVER () AS id, source, target, 1::float8 AS cost FROM unnest('
               || quote_literal(COALESCE(array_agg(source), '{}')) || '::bigint[], '
               || quote_literal(COALESCE(array_agg(target), '{}')) || '::bigint[]) AS e(source, target)'
        FROM edge))
),
comp AS (
    SELECT i.sid, COALESCE(r.sid, i.sid) AS cluster
    FROM imp i LEFT JOIN cc ON cc.node = i.vid LEFT JOIN imp r ON r.vid = cc.component
),""" + _CLUSTER_STATS

_CLUSTER_COLS = ["cluster", "shipments", "roots", "promises_at_risk", "penalty_usd", "members"]


def clusters(conn: psycopg.Connection, event_id: str, depth: int) -> list[dict]:
    rows = conn.execute(CLUSTERS, {"event": event_id, "depth": int(depth)}).fetchall()
    return [dict(zip(_CLUSTER_COLS, r)) for r in rows]


def clusters_pgr(conn: psycopg.Connection, event_id: str, depth: int) -> list[dict]:
    rows = conn.execute(CLUSTERS_PGR, {"event": event_id, "depth": int(depth)}).fetchall()
    return [dict(zip(_CLUSTER_COLS, r)) for r in rows]


# Hubs numbered in id order for pgRouting (it wants integer vertex ids), and every lane as an edge
# between those numbers. Lanes are one-way rows (both directions are listed where a lane runs both
# ways) and no two lanes join the same pair of hubs, so (src, dst) identifies a lane.
_LANE_GRAPH = """
v AS (SELECT id, name, kind, ROW_NUMBER() OVER (ORDER BY id) AS vid FROM hub),
e AS (
    SELECT ROW_NUMBER() OVER (ORDER BY l.src, l.dst, l.mode) AS id, a.vid AS source, b.vid AS target,
           l.mode, l.days, l.cost_per_kg
    FROM lane l JOIN v a ON a.id = l.src JOIN v b ON b.id = l.dst
)"""

# Q4 baseline: chokepoints with pgr_betweennessCentrality (Boost's Brandes). Checked against
# FalkorDB on our lane graph: algo.betweenness is directed, unweighted (hop count) and
# unnormalised, and is exact once it samples every hub (samplingSize >= hub count; its default
# samples 32). pgRouting computes the same directed, unweighted betweenness (it ignores cost here)
# but returns it divided by (n-1)(n-2), so it is multiplied back to compare raw scores.
CHOKEPOINTS_PGR = "WITH" + _LANE_GRAPH + """,
n AS (SELECT count(*) AS n FROM (SELECT source FROM e UNION SELECT target FROM e) x),
bc AS (
    SELECT vid, centrality FROM pgr_betweennessCentrality((
        SELECT 'SELECT id, source, target, 1::float8 AS cost FROM unnest('
               || quote_literal(array_agg(id)) || '::bigint[], '
               || quote_literal(array_agg(source)) || '::bigint[], '
               || quote_literal(array_agg(target)) || '::bigint[]) AS e(id, source, target)'
        FROM e), directed => true)
)
SELECT v.id, v.name, v.kind, bc.centrality * (n.n - 1) * (n.n - 2) AS score
FROM bc JOIN v ON v.vid = bc.vid CROSS JOIN n
ORDER BY score DESC LIMIT %(k)s
"""


def chokepoints_pgr(conn: psycopg.Connection, k: int = 10) -> list[tuple]:
    return [tuple(r) for r in conn.execute(CHOKEPOINTS_PGR, {"k": int(k)}).fetchall()]


# Q5 baseline: reroutes with pgr_KSP (Yen's k shortest loopless paths), then the same filter as
# falkor_store.REROUTE: drop paths through a closed hub, keep the k lightest.
# One real difference: the product asks algo.SPpaths for the 20 lightest paths of at most 7 lanes
# (pathCount 20, maxLen 7). pgr_KSP has no hop limit, so its 20 lightest paths can include longer
# ones. reroute_pgr() therefore asks for K paths, keeps those of <= 7 lanes, and doubles K until
# 20 short paths are in (or KSP ran out of paths). Same answer as SPpaths, at the cost of extra
# KSP work when many lighter long paths exist (see bench/NOTES.md).
REROUTE_PGR = "WITH" + _LANE_GRAPH + """,
ksp AS (
    SELECT k.path_id, k.path_seq, k.node, k.edge FROM pgr_KSP(
        (SELECT 'SELECT * FROM unnest('
                || quote_literal(array_agg(id)) || '::bigint[], '
                || quote_literal(array_agg(source)) || '::bigint[], '
                || quote_literal(array_agg(target)) || '::bigint[], '
                || quote_literal(array_agg({weight}::float8)) || '::float8[]) AS e(id, source, target, cost)'
         FROM e),
        (SELECT vid FROM v WHERE id = %(src)s), (SELECT vid FROM v WHERE id = %(dst)s), %(K)s, directed => true) k
),
path AS (
    SELECT k.path_id, array_agg(v.id ORDER BY k.path_seq) AS hubs,
           array_agg(e.mode ORDER BY k.path_seq) FILTER (WHERE e.id IS NOT NULL) AS modes,
           sum(e.days) AS days, sum(e.cost_per_kg) AS usd, sum(e.{weight}) AS weight, count(e.id) AS lanes,
           bool_or(v.id = ANY(%(closed)s::text[])) AS through_closed
    FROM ksp k JOIN v ON v.vid = k.node LEFT JOIN e ON e.id = k.edge
    GROUP BY k.path_id
),
short AS (SELECT * FROM path WHERE lanes <= %(max_len)s ORDER BY weight, path_id LIMIT %(paths)s)
SELECT (SELECT count(*) FROM path) AS found, (SELECT count(*) FROM short) AS kept,
       r.hubs, r.modes, r.days, r.usd
FROM (SELECT 1) one
LEFT JOIN LATERAL (SELECT * FROM short WHERE NOT through_closed ORDER BY weight, path_id LIMIT %(k)s) r ON true
"""


def reroute_pgr(conn: psycopg.Connection, src: str, dst: str, closed: list[str], by: str = "days", k: int = 3,
                paths: int = 20, max_len: int | None = 7, max_k: int = 10240) -> tuple[list[dict], int]:
    """Same answer and shape as falkor_store.reroute. Also returns the K pgr_KSP finally needed."""
    sql = REROUTE_PGR.format(weight={"days": "days", "cost": "cost_per_kg"}[by])
    params = {"src": src, "dst": dst, "closed": list(closed), "k": int(k), "paths": int(paths),
              "max_len": 1_000_000 if max_len is None else int(max_len)}
    K = int(paths)
    while True:
        rows = conn.execute(sql, {**params, "K": K}).fetchall()
        found, kept = rows[0][0], rows[0][1]
        if kept >= paths or found < K:
            break
        if K >= max_k:
            raise RuntimeError(f"pgr_KSP: {K} paths {src}->{dst} still hold only {kept} of <= {max_len} lanes")
        K *= 2
    return [{"hubs": hubs, "modes": modes, "days": days, "usd_per_kg": round(usd, 2)}
            for _f, _k, hubs, modes, days, usd in rows if hubs is not None], K
