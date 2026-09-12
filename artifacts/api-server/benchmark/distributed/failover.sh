#!/bin/bash
# Hard-kill failover test for one cell. Run this on the cell's host while the other cells run normally elsewhere.
# It runs cell <k> through cell.sh, SIGKILLs the harness process KILL_AFTER seconds after its runtime starts,
# then immediately starts a replacement runtime with the same phone scope and waits for the killed cell's campaign to drain.
# Usage: ./failover.sh <cell-index> [results-dir]     Env: KILL_AFTER (20), plus everything cell.sh needs.
set -uo pipefail
k=${1:?cell index}; out=${2:-./results/failover-cell-$k}; mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd); api=$(cd "$here/../.." && pwd)
from=$(( 4*k - 3 )); to=$(( 4*k ))
"$here/cell.sh" "$k" "$out/cell" & CELL=$!
until grep -q "Campaign runtime started" "$out/cell/run.log" 2>/dev/null; do sleep 0.5; done
pid=$(pgrep -f "benchmark-dist/campaign-benchmark.mjs" | head -1)
campaign=$(psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" -At -c "select c.id from campaigns c join organizations o on o.id=c.organization_id where o.slug like 'campaign-benchmark-$pid-%'")
echo "$(date +%s%3N) runtime started pid $pid campaign $campaign" >> "$out/events.log"
sleep "${KILL_AFTER:-20}"
echo "$(date +%s%3N) KILL pid $pid" >> "$out/events.log"; kill -KILL "$pid"
(cd "$api" && node -e "
const {build}=require('esbuild');build({entryPoints:['benchmark/distributed/replacement-runtime.ts'],outfile:'.benchmark-dist/replacement-runtime.mjs',bundle:true,platform:'node',format:'esm',sourcemap:'inline',external:['pg-native','pino','pino-pretty','thread-stream'],banner:{js:\"import { createRequire as __cr } from 'node:module'; globalThis.require = __cr(import.meta.url);\"}}).catch(e=>{console.error(e);process.exit(1)})")
echo "$(date +%s%3N) replacement starting" >> "$out/events.log"
(cd "$api" && DATABASE_URL="$CAMPAIGN_BENCHMARK_DATABASE_URL" CAMPAIGN_REDIS_URL="$REDIS_URL" CAMPAIGN_COORDINATOR_MODE=redis CAMPAIGN_TRANSPORT_PHONE_IDS="$from-$to" P19_CAMPAIGN_ID="$campaign" P19_LOG="$out/replacement.jsonl" node --expose-gc .benchmark-dist/replacement-runtime.mjs > "$out/replacement.log" 2>&1) & REPL=$!
wait $REPL
psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" -At -F'|' -c "select status, attempts, count(*), left(coalesce(error_reason,''),80) from campaign_jobs where campaign_id=$campaign group by 1,2,4 order by 1,2" > "$out/jobs.txt"
python3 "$here/failover-analyze.py" "$out" | tee "$out/summary.txt"
