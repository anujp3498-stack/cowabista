#!/bin/bash
# Post-run acceptance checks for the shared-campaign experiment (Experiment B). Usage: ./verify-shared.sh <cells> <seed.json>
# Env: CAMPAIGN_BENCHMARK_DATABASE_URL, REDIS_URL. Exit status is non-zero if any check fails.
set -uo pipefail
cells=${1:?cells}; seed=${2:?seed.json}
: "${CAMPAIGN_BENCHMARK_DATABASE_URL:?}"; : "${REDIS_URL:?}"
cid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['campaignId'])" "$seed"); rows=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['rows'])" "$seed")
q() { psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" -At -F'|' -c "$1"; }
fail=0; check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1: got '$2' expected '$3'"; fail=1; fi; }
check "campaign $cid sent exactly $rows rows, all on attempt 1, nothing failed or open" \
  "$(q "select count(*) filter (where status='Sent' and attempts=1) || '/' || count(*) filter (where status<>'Sent') from campaign_jobs where campaign_id=$cid")" "$rows/0"
check "campaign completed" "$(q "select status from campaigns where id=$cid")" "Completed"
check "campaign_metrics exact" "$(q "select sent || '/' || processing || '/' || queued || '/' || failed from campaign_metrics where campaign_id=$cid")" "$rows/0/0/0"
check "every route of the campaign maps to one of its $((4*cells)) phones" "$(q "select count(distinct phone_number_id) from campaign_routes where campaign_id=$cid")" "$((4*cells))"
owners=""; ok=1
for k in $(seq 1 "$cells"); do
  names=$(for p in $(seq $((4*k-3)) $((4*k))); do redis-cli -u "$REDIS_URL" XINFO CONSUMERS "campaign:prepared:{phone:$p}" campaign-prepared-v1 2>/dev/null | awk 'NR==2'; done | sort | uniq -c | awk '{print $1":"$2}' | tr '\n' ' ')
  case "$names" in "4:"*" ") owner=${names#4:}; owner=${owner%:* }; owners="$owners $owner";; *) ok=0; echo "cell $k consumers: $names";; esac
done
check "each cell's 4 phone streams have exactly one consumer each, all from one runtime" "$ok" "1"
check "no runtime owns phones in two cells" "$(echo $owners | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')" "$cells"
check "no pending stream entries" "$(for p in $(seq 1 $((4*cells))); do redis-cli -u "$REDIS_URL" XPENDING "campaign:prepared:{phone:$p}" campaign-prepared-v1 2>/dev/null | head -1; done | sort -u | tr -d '\n')" "0"
exit $fail
