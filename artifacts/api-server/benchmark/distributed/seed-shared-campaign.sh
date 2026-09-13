#!/bin/bash
# Seed ONE campaign spanning all cells' phones (Experiment B) and write its seed file. Run once, from any host that
# reaches the shared services, after prepare.sh. Cell k of a C-cell experiment then owns phones 4k-3..4k of it.
# Usage: ./seed-shared-campaign.sh <cells> <rows> <seed.json>     Env: CAMPAIGN_BENCHMARK_DATABASE_URL, REDIS_URL, CAMPAIGN_BENCHMARK_CONFIRM
set -uo pipefail
cells=${1:?cells}; rows=${2:?rows}; seed=${3:?seed.json path}
here=$(cd "$(dirname "$0")" && pwd); api=$(cd "$here/../.." && pwd)
: "${CAMPAIGN_BENCHMARK_DATABASE_URL:?}"; : "${REDIS_URL:?}"; : "${CAMPAIGN_BENCHMARK_CONFIRM:?}"
export DATABASE_URL="$CAMPAIGN_BENCHMARK_DATABASE_URL" CAMPAIGN_REDIS_URL="$REDIS_URL" CAMPAIGN_COORDINATOR_MODE=redis
export CAMPAIGN_BENCHMARK_ROWS=$rows CAMPAIGN_BENCHMARK_SUSTAINED_SECONDS=${SUST:-30} CAMPAIGN_BENCHMARK_PHONES=$((4*cells)) CAMPAIGN_BENCHMARK_ROUTES=$((4*cells))
export CAMPAIGN_BENCHMARK_WORKERS=4 CAMPAIGN_BENCHMARK_BATCH_SIZE=256 CAMPAIGN_BENCHMARK_SEND_DELAY_MS=10 CAMPAIGN_BENCHMARK_RETRY_EVERY=1000000
export CAMPAIGN_BENCHMARK_PROVIDER_TPS_LIMIT=1000 CAMPAIGN_BENCHMARK_CONFIGURED_TPS=1000 CAMPAIGN_BENCHMARK_SENDER=benchmark
export CAMPAIGN_BENCHMARK_KEEP_DATA=1 CAMPAIGN_BENCHMARK_SKIP_SCHEMA_PUSH=1 CAMPAIGN_BENCHMARK_SKIP_CONTENTION_CHECK=1
export CAMPAIGN_BENCHMARK_SEED_ONLY=1 CAMPAIGN_BENCHMARK_OUTPUT="$seed"
(cd "$api" && node ./benchmark/run.mjs) && grep -q '"status": "seeded"' "$seed" && echo "seeded: $(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('campaign', d['campaignId'], 'phones', d['phoneIds'], 'rows', d['rows'], 'commit', d['source']['gitCommit'][:12])" "$seed")"
