# FalkorDB bug report (draft, ready to post)

Status: **not posted yet.** Searched the open issues on Oct 16 (night); both bugs still reproduce
on the pinned image (5 failing cases).

* **B is already known upstream. Do not open a new issue for it.** [#2972](https://github.com/FalkorDB/FalkorDB/issues/2972)
  and [#3188](https://github.com/FalkorDB/FalkorDB/issues/3188) report the dropped `WHERE`, and the open PR
  [#3264](https://github.com/FalkorDB/FalkorDB/pull/3264) fixes exactly our shape
  (`MATCH (a) WHERE ... MATCH (a)-[*1..2]->(b ...)`). Post section B below as a comment on #3264
  ("seen on a real workload, here is a minimal repro") so it counts as confirmation.
* **A has no matching issue** (closest: [#2284](https://github.com/FalkorDB/FalkorDB/issues/2284), a different
  collect/UNION case). Post it as a new issue on
  [github.com/FalkorDB/FalkorDB/issues](https://github.com/FalkorDB/FalkorDB/issues) with the title below,
  the Environment, Graph and section A.

Then link both in the README and in `bench/NOTES.md`.

Reproduce everything below with one command (needs only the FalkorDB container):

```bash
cd backend
python -m scripts.repro_falkordb      # exits 1 while the bugs still reproduce
```

---

## Title (new issue, section A only)

A node grouped by an aggregation after collect/UNWIND has no relationships (silently empty traversal;
re-binding it by `ID()` fails with "Variable not found")

## Environment

* Docker image `falkordb/falkordb@sha256:107455e862a824e45e8e9f5a7fbfdf5e00a08b14e13eae2577c72fd9e3f59ba6`
  (`latest`, built 2026-10-08), `MODULE LIST` reports graph module version `60002`, Redis 8.10.2
* Client: falkordb-py 1.8.0 (same results from `redis-cli GRAPH.QUERY`)

## Graph

```cypher
CREATE (l1:L {id: 'l1'}), (l2:L {id: 'l2'}),
       (a:S {id: 'a'})-[:USES]->(l1), (a)-[:USES]->(l2),
       (a)-[:FEEDS]->(b:S {id: 'b'})-[:FEEDS]->(c:S {id: 'c'}),
       (c)<-[:FOR]-(:O {id: 'o'})
```

## A. A node that comes out of an aggregation after collect/UNWIND has no relationships

```cypher
MATCH (l:L) WITH collect(l) AS ls UNWIND ls AS l
MATCH (l)<-[:USES]-(s0:S)
WITH s0, count(*) AS n
MATCH (s0)-[:FEEDS]->(x)
RETURN x.id
```

Expected `[['b']]`. Actual: **no rows**. With `-[:FEEDS*0..3]->` instead, only the zero-length path
comes back (`[['a']]` instead of `a, b, c`). The plan looks correct:

```
Project
    Conditional Traverse | (s0)->(x)
        Aggregate
            Conditional Traverse | (l)<-(s0:S)
                Unwind
                    Aggregate
                        Node By Label Scan | (l:L)
```

Each of these returns the right row: `WITH DISTINCT s0` instead of the aggregation; an extra
`WITH s0` right after the aggregation; dropping the collect/UNWIND
(`MATCH (l:L) MATCH (l)<-[:USES]-(s0:S) WITH s0, count(*) AS n ...`).

Related: re-binding the node by id right after the same aggregation fails to plan:

```cypher
MATCH (l:L) WITH collect(l) AS ls UNWIND ls AS l
MATCH (l)<-[:USES]-(s0:S)
WITH ID(s0) AS sid, count(*) AS n
MATCH (s1) WHERE ID(s1) = sid
MATCH (s1)-[:FEEDS]->(x)
RETURN x.id
```

Error: `Variable sid not found`. The plan is only `Project <- Conditional Traverse <- NodeByIdSeek`:
everything before the `NodeByIdSeek` (the UNWIND and both aggregations) has been removed.

## B. `WHERE` on the start node is dropped before a variable-length path followed by another hop

*(Known upstream: post this as a comment on [#3264](https://github.com/FalkorDB/FalkorDB/pull/3264), not as a new issue.)*

```cypher
MATCH (s0:S) WHERE s0.id = 'a'
MATCH (s0)-[:FEEDS*0..3]->(x)<-[:FOR]-(o)
RETURN x.id
```

Expected `[['c']]`. Actual: **no rows** (same with `*1..3`). The plan has no operation that binds
`s0`; it starts from `o` and then runs an Expand Into with `s0` unbound:

```
Project
    Conditional Variable Length Traverse (Expand Into) | (s0)-[_anon_0:FEEDS*0..3]->(x)
        Conditional Traverse | (o)->(x)
            Filter
                All Node Scan | (o)
```

Each of these returns `[['c']]`: `MATCH (s0:S {id: 'a'})` (inline property); `WITH s0` between the two
MATCH clauses; one MATCH with the `WHERE` after it; a fixed two-hop pattern instead of `*0..3`.
The same happens with an index on `:S(id)` and with `WHERE s0.id IN [...]`.

## How we found them

Both returned silently empty results inside larger queries (a supply-chain cascade and a "why is
this order late" path). Our parity test against PostgreSQL and a plain-Python reference caught the
difference (FalkorDB 0 rows, the others 1,240 and 2). We now use the workarounds above (re-bind by
`ID()` in a shape that plans correctly, and a `WITH` barrier). Happy to test a fix.

---

## C. Server panic: collect() over an unmatched OPTIONAL MATCH (found Oct 17; post as its own issue)

**Run it only against a scratch FalkorDB**: the process exits, and with Docker's default settings the
container stays down (we added `restart: unless-stopped`). Writes since the last snapshot are lost.

```cypher
CREATE (:Run {id: 'R1', status: 'x', event_id: 'E', requested_by: 'A', created_at: 'now', memory: 'on'})
```

```cypher
MATCH (r:Run {id: $id})
OPTIONAL MATCH (r)-[:COUNTERFACTUAL_OF]->(main:Run)
OPTIONAL MATCH (twin:Run)-[:COUNTERFACTUAL_OF]->(r)
RETURN r.event_id, r.status, r.requested_by, r.created_at, coalesce(r.memory, 'on'), main.id, collect(twin.id)
```

with `$id = 'R1'`. Expected one row (`... , null, []`); actual: the connection closes and the log shows

```
<module> FalkorDB panic: panicked at src/reply.rs:655:58:
called `Option::unwrap()` on a `None` value
   ... falkordb::reply::reply_compact
   ... falkordb::graph_core::execute_query
```

The same query with `twin.id` instead of `collect(twin.id)` returns the expected row. Neither OPTIONAL
MATCH alone nor `collect()` of a single unmatched OPTIONAL MATCH panics; the combination does. Not yet
reduced further. Same image as above (graph module `60002`).
