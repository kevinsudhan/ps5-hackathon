#!/bin/sh
# Entry point of Dockerfile.render: FalkorDB on 127.0.0.1 inside the container, then the API on
# $PORT (Render sets it; 10000 by default).
#   --bake   build time only: load the demo data, save it to /data/dump.rdb and stop.
set -e

redis-server --bind 127.0.0.1 --port 6379 --dir /data --dbfilename dump.rdb \
    --save "" --appendonly no \
    --loadmodule /opt/falkordb/falkordb.so $FALKORDB_ARGS &

# Replies LOADING until the snapshot is read.
until [ "$(redis-cli ping 2>/dev/null)" = "PONG" ]; do sleep 0.2; done

if [ "$1" = "--bake" ]; then
    python -m scripts.load --skip-postgres
    redis-cli save
    redis-cli shutdown nosave || true
    wait
    exit 0
fi

python -m scripts.load --if-missing --skip-postgres   # no-op unless the snapshot is missing
exec uvicorn promisegraph.api:app --host 0.0.0.0 --port "${PORT:-10000}"
