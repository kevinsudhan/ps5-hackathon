"""Minimal repros for the FalkorDB planner issues we hit (bench/NOTES.md findings 2 and 8).

Builds a 6-node throwaway graph, runs each failing query next to near-identical queries that work,
prints expected vs actual rows (and the plan of each failing query), then deletes the graph.
Needs only the FalkorDB container. Exits 1 if any failing case is still failing.

    python -m scripts.repro_falkordb
"""
import sys

from falkordb import FalkorDB

from promisegraph.config import FALKOR_HOST, FALKOR_PORT

GRAPH = "repro_planner_bugs"

#   (l1:L) (l2:L)
#      ^      ^
#    USES   USES
#       \   /
#       (a:S)-[:FEEDS]->(b:S)-[:FEEDS]->(c:S)<-[:FOR]-(o:O)
SETUP = """
CREATE (l1:L {id: 'l1'}), (l2:L {id: 'l2'}),
       (a:S {id: 'a'})-[:USES]->(l1), (a)-[:USES]->(l2),
       (a)-[:FEEDS]->(b:S {id: 'b'})-[:FEEDS]->(c:S {id: 'c'}),
       (c)<-[:FOR]-(:O {id: 'o'})
"""

UNWOUND = "MATCH (l:L) WITH collect(l) AS ls UNWIND ls AS l MATCH (l)<-[:USES]-(s0:S) "

# (title, [(label, query, expected rows, is_the_bug)])
CASES = [
    ("A. A node grouped by an aggregation, after collect/UNWIND + MATCH, has no relationships", [
        ("bug: WITH s0, count(*) then one hop", UNWOUND + "WITH s0, count(*) AS n MATCH (s0)-[:FEEDS]->(x) RETURN x.id",
         [["b"]], True),
        ("bug: same, then *0..3", UNWOUND + "WITH s0, count(*) AS n MATCH (s0)-[:FEEDS*0..3]->(x) RETURN x.id ORDER BY x.id",
         [["a"], ["b"], ["c"]], True),
        ("bug: re-bind by ID() right after it", UNWOUND + "WITH ID(s0) AS sid, count(*) AS n "
         "MATCH (s1) WHERE ID(s1) = sid MATCH (s1)-[:FEEDS]->(x) RETURN x.id", [["b"]], True),
        ("ok:  WITH DISTINCT s0 instead", UNWOUND + "WITH DISTINCT s0 MATCH (s0)-[:FEEDS]->(x) RETURN x.id",
         [["b"]], False),
        ("ok:  extra WITH s0 after the aggregation", UNWOUND + "WITH s0, count(*) AS n WITH s0 "
         "MATCH (s0)-[:FEEDS]->(x) RETURN x.id", [["b"]], False),
        ("ok:  no collect/UNWIND", "MATCH (l:L) MATCH (l)<-[:USES]-(s0:S) WITH s0, count(*) AS n "
         "MATCH (s0)-[:FEEDS]->(x) RETURN x.id", [["b"]], False),
    ]),
    ("B. WHERE on the start node is dropped when a variable-length path is followed by another hop", [
        ("bug: WHERE id, then *0..3 and one more hop", "MATCH (s0:S) WHERE s0.id = 'a' "
         "MATCH (s0)-[:FEEDS*0..3]->(x)<-[:FOR]-(o) RETURN x.id", [["c"]], True),
        ("bug: same with *1..3", "MATCH (s0:S) WHERE s0.id = 'a' "
         "MATCH (s0)-[:FEEDS*1..3]->(x)<-[:FOR]-(o) RETURN x.id", [["c"]], True),
        ("ok:  inline {id: 'a'}", "MATCH (s0:S {id: 'a'}) "
         "MATCH (s0)-[:FEEDS*0..3]->(x)<-[:FOR]-(o) RETURN x.id", [["c"]], False),
        ("ok:  WITH s0 barrier", "MATCH (s0:S) WHERE s0.id = 'a' WITH s0 "
         "MATCH (s0)-[:FEEDS*0..3]->(x)<-[:FOR]-(o) RETURN x.id", [["c"]], False),
        ("ok:  one MATCH, WHERE after", "MATCH (s0:S)-[:FEEDS*0..3]->(x)<-[:FOR]-(o) WHERE s0.id = 'a' RETURN x.id",
         [["c"]], False),
        ("ok:  fixed two hops", "MATCH (s0:S) WHERE s0.id = 'a' "
         "MATCH (s0)-[:FEEDS]->()-[:FEEDS]->(x)<-[:FOR]-(o) RETURN x.id", [["c"]], False),
    ]),
]


def main() -> int:
    db = FalkorDB(host=FALKOR_HOST, port=FALKOR_PORT)
    for mod in db.connection.execute_command("MODULE", "LIST"):
        m = {k.decode() if isinstance(k, bytes) else k: v for k, v in zip(mod[::2], mod[1::2])}
        name = m.get("name")
        print(f"module {name.decode() if isinstance(name, bytes) else name} version {m.get('ver')}")
    if GRAPH in db.list_graphs():
        db.select_graph(GRAPH).delete()
    g = db.select_graph(GRAPH)
    g.query(SETUP)
    still_broken = 0
    try:
        for title, variants in CASES:
            print(f"\n== {title}")
            for label, q, expected, is_bug in variants:
                try:
                    got = g.query(q).result_set
                except Exception as ex:  # one of the cases errors instead of returning rows
                    got = f"ERROR: {ex}"
                ok = got == expected
                print(f"  {'PASS' if ok else 'FAIL'}  {label:<44} expected {expected}, got {got}")
                if is_bug and not ok:
                    still_broken += 1
                    print("        " + q)
                    try:
                        print("\n".join("        | " + line for line in str(g.explain(q)).splitlines()))
                    except Exception as ex:
                        print(f"        | (no plan: {ex})")
    finally:
        g.delete()
    print(f"\n{still_broken} failing case(s) still reproduce on this build.")
    return 1 if still_broken else 0


if __name__ == "__main__":
    sys.exit(main())
