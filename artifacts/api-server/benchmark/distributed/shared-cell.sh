#!/bin/bash
# Run cell k of the shared-campaign experiment (Experiment B) on this host: a scoped runtime sending from the seeded
# campaign. Usage: ./shared-cell.sh <cell-index> <seed.json> [results-dir]
# Env (required): CAMPAIGN_BENCHMARK_DATABASE_URL, REDIS_URL. Optional: SHARD_CPUS, OTHER_CPUS (pinning), CELL_MAX_SECONDS.
set -uo pipefail
k=${1:?cell index}; seed=${2:?seed.json}; out=${3:-./results/shared-cell-$k}; mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd); api=$(cd "$here/../.." && pwd)
: "${CAMPAIGN_BENCHMARK_DATABASE_URL:?}"; : "${REDIS_URL:?}"
from=$(( 4*k - 3 )); to=$(( 4*k ))
export DATABASE_URL="$CAMPAIGN_BENCHMARK_DATABASE_URL" CAMPAIGN_REDIS_URL="$REDIS_URL" CAMPAIGN_COORDINATOR_MODE=redis
export CAMPAIGN_TRANSPORT_PHONE_IDS="$from-$to" SEED_JSON="$seed" CELL_OUT="$out" CAMPAIGN_BENCHMARK_SEND_DELAY_MS=${CAMPAIGN_BENCHMARK_SEND_DELAY_MS:-10}
(cd "$api" && node -e "
const {build}=require('esbuild');build({entryPoints:['benchmark/distributed/shared-campaign-cell.ts'],outfile:'.benchmark-dist/shared-campaign-cell.mjs',bundle:true,platform:'node',format:'esm',sourcemap:'inline',external:['pg-native','pino','pino-pretty','thread-stream'],banner:{js:\"import { createRequire as __cr } from 'node:module'; globalThis.require = __cr(import.meta.url);\"}}).catch(e=>{console.error(e);process.exit(1)});
build({entryPoints:['src/services/campaign-transport-shard-worker.ts'],outfile:'.benchmark-dist/campaign-transport-shard-worker.mjs',bundle:true,platform:'node',format:'esm',sourcemap:'inline',external:['pg-native','pino','pino-pretty','thread-stream'],banner:{js:\"import { createRequire as __cr } from 'node:module'; globalThis.require = __cr(import.meta.url);\"}}).catch(e=>{console.error(e);process.exit(1)});") || exit 3
echo "$(date +%s%3N) shared cell $k scope $from-$to starting" >> "$out/events.log"
python3 "$here/samplers/host-cpu-sampler.py" "$out/host.jsonl" shared-campaign-cell & SAMPLER=$!
(cd "$api" && node --expose-gc .benchmark-dist/shared-campaign-cell.mjs > "$out/run.log" 2>&1) & RUNNER=$!
if [ -n "${SHARD_CPUS:-}" ]; then
  ( sleep 6; pid=$(pgrep -f "benchmark-dist/shared-campaign-cell.mjs" | head -1); python3 "$here/pin-transport-threads.py" "$pid" "$SHARD_CPUS" "${OTHER_CPUS:-}" >> "$out/pin.log" 2>&1 ) &
fi
wait $RUNNER; rc=$?; kill $SAMPLER 2>/dev/null
echo "$(date +%s%3N) shared cell $k exited rc=$rc" >> "$out/events.log"
[ -f "$out/cell.json" ] && grep -q '"status": "ok"' "$out/cell.json" && echo OK > "$out/status" || echo FAILED > "$out/status"
echo "shared cell $k: $(cat "$out/status")"
