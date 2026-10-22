#!/usr/bin/env bash
# P6 discovery (READ ONLY), Host S: U1 evidence E3 (every PostgreSQL and Redis client, by address and application)
# and the counts-only inventories 01, 11, 12, 13 and 15 of the committed package, in one pass. Run from the
# package directory (deploy/cutover/package) as the database owner role, connected as package/README.md
# "How to connect" says (PGHOST/PGPORT/PGDATABASE/PGUSER/PGSSLMODE exported, password only in ~/.pgpass; never a
# URL on the command line). It first checks the package against SHA256SUMS and stops on any mismatch. Every SQL here
# is read only; no query text, email, name, Clerk id, token or secret is printed. Redis: type the password at the
# prompt (read -rs; it goes to redis-cli through REDISCLI_AUTH only). Writes only into ./logs.
#   mkdir -p logs && bash discovery/discover-s.sh [<REDIS_HOST> [<REDIS_PORT> [<REDIS_DB>]]] 2>&1 | tee logs/discover-s-$(date -u +%Y%m%dT%H%M%SZ).txt
#   <REDIS_DB> is the /N of CAMPAIGN_REDIS_URL that discover-cell.sh prints (default 0); export REDIS_TLS=1 for rediss://.
set -u
RH=${1:-127.0.0.1}; RP=${2:-6379}; RDB=${3:-0}
sha256sum --quiet -c SHA256SUMS || { echo "STOP: package checksum mismatch (run from deploy/cutover/package; see SHA256SUMS)"; exit 3; }
echo "package checksums OK"
PSQL="psql -X -v ON_ERROR_STOP=1"
mkdir -p logs
echo "== PostgreSQL $($PSQL -At -c 'show server_version') database $($PSQL -At -c 'select current_database()') =="
echo "== E3 PostgreSQL clients of the whole server, every database and replication (no query text) =="
$PSQL -c "BEGIN TRANSACTION READ ONLY" \
  -c "select (select rolsuper from pg_roles where rolname = current_user) or pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') as sees_all_sessions" \
  -c "select case when client_addr is not null then host(client_addr) when client_port = -1 then 'local socket' when client_port is null and backend_type is distinct from 'walsender' and (backend_type is null or backend_type = 'client backend') then 'HIDDEN (needs superuser or pg_read_all_stats)' else 'local' end as client, datname, usename, application_name, backend_type, state, count(*) from pg_stat_activity where pid <> pg_backend_pid() and (backend_type in ('client backend', 'walsender') or (backend_type is null and usesysid is not null)) group by 1, 2, 3, 4, 5, 6 order by 1, 2, 3" \
  -c "ROLLBACK"
echo "== databases on this server (names and sizes) =="
$PSQL -At -F' ' -c "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate order by 1"
echo "== E3 Redis clients (addresses and counts only), database $RDB =="
read -rsp "Redis password (not echoed; empty to skip Redis): " REDISCLI_AUTH; echo; export REDISCLI_AUTH
if [ -n "$REDISCLI_AUTH" ]; then
  R="redis-cli -h $RH -p $RP ${REDIS_TLS:+--tls}"
  if [ "$($R PING 2>/dev/null)" = PONG ]; then
    echo AUTH_OK
    CL=$($R CLIENT LIST 2>/dev/null); n=$(printf '%s\n' "$CL" | grep -c '^id=')
    echo "clients total: $n"
    [ "$n" -ge 1 ] || echo "STOP: CLIENT LIST returned no client (this listing is itself one); no Redis client evidence recorded"
    # one row per client (IPv4, [IPv6] and /unix socket addresses), from the same listing; the counts add up to the total
    printf '%s\n' "$CL" | sed -nE '/^id=/{s/.* addr=([^ ]+):[0-9]+ .* name=([^ ]*) .* db=([0-9]+) .*/\1 name=\2 db=\3/p;t;s/.*/(unparsed client line)/p}' | sort | uniq -c
    $R INFO keyspace | grep -E '^db[0-9]+:' | sed 's/^/keyspace /'
    $R -n "$RDB" --scan --pattern 'campaign:ownership:*:owner' > logs/.own.$$ && echo "ownership keys (db $RDB): $(wc -l < logs/.own.$$)" && \
      echo "distinct owning runtimes (db $RDB): $(while read -r k; do $R -n "$RDB" GET "$k"; done < logs/.own.$$ | grep -v '^$' | sort -u | wc -l)"
    rm -f logs/.own.$$
  else echo "STOP: no PONG from redis-cli (connection or authentication failed; no Redis evidence recorded)"; fi
fi
unset REDISCLI_AUTH
echo "== counts-only inventories of the committed package =="
for f in sql/01_preflight_readonly.sql inventory/11_user_inventory_readonly.sql inventory/12_connector_inventory_readonly.sql inventory/13_media_link_inventory_readonly.sql inventory/15_credential_key_inventory_readonly.sql; do
  n=$(basename "$f" .sql); $PSQL -L "logs/$n-$(date -u +%Y%m%dT%H%M%SZ).log" -f "$f" < /dev/null > "logs/$n.out" 2>&1; rc=$?
  echo "-- $n exit=$rc"; grep -vE '^(SET|BEGIN|ROLLBACK|Pager usage is off\.)$' "logs/$n.out"
done
echo "DONE discover-s"
