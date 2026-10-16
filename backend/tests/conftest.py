"""Shared fixtures: one small tenant ("pytest", 3k orders) in both engines, built once per run."""
import pytest

from promisegraph import datagen, falkor_store as fs, history, memory, pg_store
from promisegraph.config import graph_name

TENANT = "pytest"
DEPTH = 8


@pytest.fixture(scope="session")
def ds():
    data = datagen.generate(orders=3000, seed=11, tenant=TENANT)
    fs.load(data)
    pg_store.load(data)
    g = fs.graph(TENANT)
    memory.ensure_schema(g)
    history.seed(g)
    yield data
    fs.connect().select_graph(graph_name(TENANT)).delete()
    with pg_store.psycopg.connect(pg_store.PG_DSN, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA IF EXISTS {pg_store.schema_name(TENANT)} CASCADE")


@pytest.fixture(scope="session")
def g(ds):
    return fs.graph(TENANT)
