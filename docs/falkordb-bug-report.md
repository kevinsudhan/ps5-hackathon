# FalkorDB bug report (draft, ready to post)

Status: **not posted yet.** Before posting, search the FalkorDB GitHub issues for "Expand Into",
"variable length" and "aggregate" in case one is already open. Post it on
[github.com/FalkorDB/FalkorDB/issues](https://github.com/FalkorDB/FalkorDB/issues), then link it in
the README and in `bench/NOTES.md`.

Reproduce everything below with one command (needs only the FalkorDB container):

```bash
cd backend
python -m scripts.repro_falkordb      # exits 1 while the bugs still reproduce
```

---

## Title

Planner drops bound variables: (A) nodes grouped after collect/UNWIND have no relationships,
(B) `WHERE` on the start node is lost before a variable-length path followed by another hop

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
