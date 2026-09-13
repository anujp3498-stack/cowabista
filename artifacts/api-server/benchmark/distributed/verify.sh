#!/bin/bash
# Post-run acceptance checks for a multi-cell experiment, from any host that reaches the shared services.
# Usage: ./verify.sh <cells> [rows-per-cell]     Env: CAMPAIGN_BENCHMARK_DATABASE_URL, REDIS_URL
# Prints one PASS/FAIL line per check; exit status is non-zero if any check fails.
set -uo pipefail
cells=${1:?number of cells}; rows=${2:-200000}
: "${CAMPAIGN_BENCHMARK_DATABASE_URL:?}"; : "${REDIS_URL:?}"
q() { psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" -At -F'|' -c "$1"; }
fail=0; check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1: got '$2' expected '$3'"; fail=1; fi; }
check "campaigns" "$(q "select count(*) from campaigns")" "$cells"
check "phones (4 per cell, ids 1..$((4*cells)))" "$(q "select count(*) || '/' || coalesce(min(id),0) || '-' || coalesce(max(id),0) from phone_numbers")" "$((4*cells))/1-$((4*cells))"
# Each harness re-sends exactly one job on attempt 2: its own recovery probe (claimed, lease expired, requeued).
check "every campaign sent exactly its rows (all on attempt 1 except the one recovery-probe job), nothing failed or open" \
  "$(q "select count(*) from campaigns c where (select count(*) from campaign_jobs j where j.campaign_id=c.id and j.status='Sent')=$rows and (select count(*) from campaign_jobs j where j.campaign_id=c.id and j.attempts>1)=1 and (select count(*) from campaign_jobs j where j.campaign_id=c.id and j.status<>'Sent')=0")" "$cells"
check "every campaign completed" "$(q "select count(*) from campaigns where status='Completed'")" "$cells"
check "no job of any campaign was sent on a phone outside its own cell (route->phone consistent)" \
  "$(q "select count(*) from campaign_jobs j join campaign_routes r on r.id=j.route_id join campaigns c on c.id=j.campaign_id where r.campaign_id<>c.id or r.organization_id<>j.organization_id")" "0"
check "campaign_metrics exact (sent = rows, processing = queued = 0) for every campaign" \
  "$(q "select count(*) from campaign_metrics where sent=$rows and processing=0 and queued=0 and failed=0")" "$cells"
check "each phone stream has one consumer group with nothing pending" \
  "$(for p in $(seq 1 $((4*cells))); do redis-cli -u "$REDIS_URL" XPENDING "campaign:prepared:{phone:$p}" campaign-prepared-v1 2>/dev/null | head -1; done | sort -u | tr -d '\n')" "0"
# Ownership record: every phone stream has exactly one consumer, named <runtime worker id>:<fencing token>; the four
# phones of a cell must share one worker id and no worker id may appear in two cells. (The harness's final
# phoneOwnership snapshot is taken after its lanes drained and can be empty; ownershipDenials must still be 0.)
owners=""; ok=1
for k in $(seq 1 "$cells"); do
  names=$(for p in $(seq $((4*k-3)) $((4*k))); do redis-cli -u "$REDIS_URL" XINFO CONSUMERS "campaign:prepared:{phone:$p}" campaign-prepared-v1 2>/dev/null | awk 'NR==2'; done | sort | uniq -c | awk '{print $1":"$2}' | tr '\n' ' ')
  case "$names" in "4:"*" ") owner=${names#4:}; owner=${owner%:* }; owners="$owners $owner";; *) ok=0; echo "cell $k consumers: $names";; esac
done
check "each cell's 4 phone streams have exactly one consumer each, all from one runtime" "$ok" "1"
check "no runtime owns phones in two cells" "$(echo $owners | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')" "$cells"
echo "also require ownershipDenials = 0 in every cell's harness.json (analyze.py prints it)."
exit $fail
