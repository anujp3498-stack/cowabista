#!/bin/bash
# 1s PostgreSQL sampler of CUMULATIVE counters (the analyzer takes deltas): WAL position, commits, tuple updates/inserts,
# active backends, lock waiters, connections, and pg_stat_statements totals for statement latency. Run from any host.
# Usage: pg-delta-sampler.sh <db url> <out.csv>
url=$1; out=$2
echo "epoch_ms,wal_bytes,xact_commit,tup_updated,tup_inserted,active,waiting,conns,stmt_calls,stmt_exec_ms" > "$out"
while true; do
  psql "$url" -At -F, -c "select $(date +%s%3N), pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0')::bigint, d.xact_commit, d.tup_updated, d.tup_inserted,
    (select count(*) from pg_stat_activity where datname=current_database() and state='active'),
    (select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock'),
    (select count(*) from pg_stat_activity where datname=current_database()),
    coalesce((select sum(calls) from pg_stat_statements s where s.dbid=d.datid),0), coalesce((select round(sum(total_exec_time)) from pg_stat_statements s where s.dbid=d.datid),0)
    from pg_stat_database d where d.datname=current_database()" >> "$out" 2>/dev/null
  sleep 1
done
