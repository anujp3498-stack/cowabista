#!/bin/bash
# Reset the shared benchmark database and Redis once per experiment, from any host that reaches both.
# Usage: CAMPAIGN_BENCHMARK_DATABASE_URL=postgresql://... REDIS_URL=redis://... ./prepare.sh
set -euo pipefail
: "${CAMPAIGN_BENCHMARK_DATABASE_URL:?set to the shared benchmark database (its name must contain 'benchmark')}"
: "${REDIS_URL:?set to the shared Redis}"
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../../../.." && pwd)
dbname=$(python3 -c "import sys,urllib.parse as u; print(u.urlparse(sys.argv[1]).path.lstrip('/'))" "$CAMPAIGN_BENCHMARK_DATABASE_URL")
admin=$(python3 -c "import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(p._replace(path='/postgres').geturl())" "$CAMPAIGN_BENCHMARK_DATABASE_URL")
case "$dbname" in *bench*) ;; *) echo "refusing database '$dbname': name must contain 'bench'"; exit 2;; esac
psql "$admin" -q -c "drop database if exists \"$dbname\" with (force);" -c "create database \"$dbname\";"
redis-cli -u "$REDIS_URL" flushall > /dev/null
(cd "$repo" && DATABASE_URL="$CAMPAIGN_BENCHMARK_DATABASE_URL" pnpm --filter @workspace/db run push-force > /dev/null)
psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" -q -c "create extension if not exists pg_stat_statements" 2>/dev/null || true
echo "prepared $dbname and flushed Redis"
