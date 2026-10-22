#!/usr/bin/env bash
# P6 discovery (READ ONLY), Host S: U1 evidence E3 (every PostgreSQL and Redis client, by address and application)
# and the counts-only inventories 01, 11, 12, 13 and 15 of the committed package, in one pass. Run from the
# package directory (deploy/cutover/package) as the database owner role, connected as package/README.md
# "How to connect" says (PGHOST/PGPORT/PGDATABASE/PGUSER/PGSSLMODE exported, password only in ~/.pgpass; never a
# URL on the command line). Every SQL here is read only; no query text, email, name, Clerk id, token or secret is
# printed. Redis: type the password at the prompt (read -rs; it goes to redis-cli through REDISCLI_AUTH only).
#   bash discovery/discover-s.sh [<REDIS_HOST> [<REDIS_PORT>]] 2>&1 | tee logs/discover-s-$(date -u +%Y%m%dT%H%M%SZ).txt
# (add --tls to the R= line below for a rediss:// URL)
set -u
RH=${1:-127.0.0.1}; RP=${2:-6379}
PSQL="psql -X -v ON_ERROR_STOP=1"
mkdir -p logs
echo "== PostgreSQL $($PSQL -At -c 'show server_version') database $($PSQL -At -c 'select current_database()') =="
echo "== E3 PostgreSQL clients of this database (no query text) =="
$PSQL -c "BEGIN TRANSACTION READ ONLY" -c "select coalesce(host(client_addr),'local') as client, usename, application_name, backend_type, state, count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() group by 1,2,3,4,5 order by 1,2,3" -c "ROLLBACK"
echo "== databases on this server (names and sizes) =="
$PSQL -At -F' ' -c "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate order by 1"
echo "== E3 Redis clients (addresses and counts only) =="
read -rsp "Redis password (not echoed; empty to skip Redis): " REDISCLI_AUTH; echo; export REDISCLI_AUTH
if [ -n "$REDISCLI_AUTH" ]; then
  R="redis-cli -h $RH -p $RP"
  if [ "$($R PING 2>/dev/null)" = PONG ]; then
    echo AUTH_OK
    $R CLIENT LIST | sed -E 's/.* addr=([0-9a-fA-F.:]*):[0-9]+ .* name=([^ ]*) .* db=([0-9]+) .*/\1 name=\2 db=\3/' | sort | uniq -c
    $R INFO keyspace | grep -E '^db[0-9]+:' | sed 's/^/keyspace /'
    $R -n 0 --scan --pattern 'campaign:ownership:*:owner' > logs/.own.$$ && echo "ownership keys: $(wc -l < logs/.own.$$)" && \
      echo "distinct owning runtimes: $(while read -r k; do $R -n 0 GET "$k"; done < logs/.own.$$ | sort -u | wc -l)"
    rm -f logs/.own.$$
  else echo "STOP: redis-cli not authenticated (no Redis evidence recorded)"; fi
fi
unset REDISCLI_AUTH
echo "== counts-only inventories of the committed package =="
for f in sql/01_preflight_readonly.sql inventory/11_user_inventory_readonly.sql inventory/12_connector_inventory_readonly.sql inventory/13_media_link_inventory_readonly.sql inventory/15_credential_key_inventory_readonly.sql; do
  n=$(basename "$f" .sql); $PSQL -L "logs/$n-$(date -u +%Y%m%dT%H%M%SZ).log" -f "$f" < /dev/null > "logs/$n.out" 2>&1; rc=$?
  echo "-- $n exit=$rc"; grep -vE '^(SET|BEGIN|ROLLBACK|Pager usage is off\.)$' "logs/$n.out"
done
echo "DONE discover-s"
