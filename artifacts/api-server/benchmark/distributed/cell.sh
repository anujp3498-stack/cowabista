#!/bin/bash
# Run one benchmark transport cell (one runtime process, 4 phones, explicit phone scope) on this host.
#
# Usage: ./cell.sh <cell-index 1..N> [results-dir]
#   Cell k owns phones (4k-3)..(4k). It waits until the previous cells' phone rows exist in the shared database,
#   so phone ids are deterministic across hosts without any other coordination. Cell 1 starts immediately.
# Env (required): CAMPAIGN_BENCHMARK_DATABASE_URL, REDIS_URL (shared services), CAMPAIGN_BENCHMARK_CONFIRM=<db name>
# Env (optional): ROWS (default 200000), SUST (30), SHARD_CPUS (e.g. "3": pin the 4 transport shard threads there),
#                 OTHER_CPUS (e.g. "0,1,2": everything else in this process), DRAIN (600), EXTRA_ENV
set -uo pipefail
k=${1:?cell index}; out=${2:-./results/cell-$k}; mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd); api=$(cd "$here/../.." && pwd)
: "${CAMPAIGN_BENCHMARK_DATABASE_URL:?}"; : "${REDIS_URL:?}"; : "${CAMPAIGN_BENCHMARK_CONFIRM:?}"
from=$(( 4*k - 3 )); to=$(( 4*k ))
export DATABASE_URL="$CAMPAIGN_BENCHMARK_DATABASE_URL" CAMPAIGN_REDIS_URL="$REDIS_URL" CAMPAIGN_COORDINATOR_MODE=redis
export CAMPAIGN_BENCHMARK_ROWS=${ROWS:-200000} CAMPAIGN_BENCHMARK_SUSTAINED_SECONDS=${SUST:-30} CAMPAIGN_BENCHMARK_PHONES=4 CAMPAIGN_BENCHMARK_ROUTES=4
export CAMPAIGN_BENCHMARK_WORKERS=4 CAMPAIGN_BENCHMARK_BATCH_SIZE=256 CAMPAIGN_BENCHMARK_SEND_DELAY_MS=10 CAMPAIGN_BENCHMARK_RETRY_EVERY=1000000
export CAMPAIGN_BENCHMARK_PROVIDER_TPS_LIMIT=1000 CAMPAIGN_BENCHMARK_CONFIGURED_TPS=1000 CAMPAIGN_BENCHMARK_SENDER=benchmark
export CAMPAIGN_BENCHMARK_KEEP_DATA=1 CAMPAIGN_BENCHMARK_DRAIN_TIMEOUT_SECONDS=${DRAIN:-600} CAMPAIGN_BENCHMARK_SKIP_SCHEMA_PUSH=1 CAMPAIGN_BENCHMARK_SKIP_CONTENTION_CHECK=1
export CAMPAIGN_TRANSPORT_PHONE_IDS="$from-$to" CAMPAIGN_BENCHMARK_OUTPUT="$out/harness.json"
# deterministic ids: wait for the previous cells' phones
until [ "$(psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" -At -c 'select count(*) from phone_numbers' 2>/dev/null || echo 0)" -ge $(( from - 1 )) ]; do sleep 0.5; done
echo "$(date +%s%3N) cell $k scope $from-$to starting" >> "$out/events.log"
python3 "$here/samplers/host-cpu-sampler.py" "$out/host.jsonl" campaign-benchmark & SAMPLER=$!
(cd "$api" && node ./benchmark/run.mjs > "$out/run.log" 2>&1) & RUNNER=$!
if [ -n "${SHARD_CPUS:-}" ]; then
  ( until grep -q "Campaign runtime started" "$out/run.log" 2>/dev/null; do sleep 1; done; sleep 2
    pid=$(pgrep -f "benchmark-dist/campaign-benchmark.mjs" | head -1)
    python3 "$here/pin-transport-threads.py" "$pid" "$SHARD_CPUS" "${OTHER_CPUS:-}" >> "$out/pin.log" 2>&1 ) &
fi
wait $RUNNER; rc=$?
kill $SAMPLER 2>/dev/null
echo "$(date +%s%3N) cell $k exited rc=$rc" >> "$out/events.log"
[ -f "$out/harness.json" ] && grep -q '"status": "ok"' "$out/harness.json" && echo OK > "$out/status" || echo FAILED > "$out/status"
echo "cell $k: $(cat "$out/status")"
