#!/bin/bash
# 1s per-campaign progress on one clock (sent/queued/processing from campaign_metrics) for the true concurrent aggregate.
# Usage: progress-sampler.sh <db url> <out.csv>
url=$1; out=$2; echo "epoch_ms,campaign_id,sent,queued,processing,failed" > "$out"
while true; do psql "$url" -At -F, -c "select $(date +%s%3N), campaign_id, sent, queued, processing, failed from campaign_metrics" >> "$out" 2>/dev/null; sleep 1; done
