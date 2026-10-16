import os
from datetime import date, timedelta

# 127.0.0.1, not localhost: docker-compose binds the databases to IPv4 loopback only, and on Windows
# "localhost" tries ::1 first, where a refused connect costs ~2 s (and libpq can hang on it).
FALKOR_HOST = os.getenv("FALKOR_HOST", "127.0.0.1")
FALKOR_PORT = int(os.getenv("FALKOR_PORT", "6379"))
FALKOR_USERNAME = os.getenv("FALKOR_USERNAME") or None   # FalkorDB Cloud needs both; local Docker neither
FALKOR_PASSWORD = os.getenv("FALKOR_PASSWORD") or None
PG_DSN = os.getenv("PG_DSN", "postgresql://promise:promise@127.0.0.1:5544/promise")

# All dates are stored as integer "day numbers" so both engines can do date maths with
# plain integers. Day 0 is 2026-01-01. Use to_date()/to_day() at the edges only.
EPOCH = date(2026, 1, 1)
TODAY = date(2026, 10, 15)


def to_day(d: date) -> int:
    return (d - EPOCH).days


def to_date(day: int) -> date:
    return EPOCH + timedelta(days=day)


def graph_name(tenant: str) -> str:
    """One isolated FalkorDB graph per shipper company (tenant)."""
    return f"promise_{tenant}"
