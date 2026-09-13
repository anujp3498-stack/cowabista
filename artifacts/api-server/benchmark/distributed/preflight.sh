#!/bin/bash
# Pre-run checks for a multi-host cell run. Run on EVERY transport host right before starting its cell, with the
# same environment as cell.sh, plus COMMIT=<the one sha the experiment measures> and PEERS="<host-c> [host-d ...]".
# Prints PASS/FAIL/INFO per check; exits non-zero on any FAIL. Nothing here changes any state.
set -uo pipefail
: "${CAMPAIGN_BENCHMARK_DATABASE_URL:?}"; : "${REDIS_URL:?}"; : "${COMMIT:?the exact commit sha to measure}"
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../../../.." && pwd); cells=${CELLS:-2}
fail=0; pass() { echo "PASS $1"; }; failed() { echo "FAIL $1"; fail=1; }; info() { echo "INFO $1"; }
q() { psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" -At -c "$1" 2>/dev/null; }

# 1-2. one exact commit, clean tree
head=$(git -C "$repo" rev-parse HEAD); dirty=$(git -C "$repo" status --porcelain | wc -l | tr -d ' ')
[ "$head" = "$COMMIT" ] && pass "commit $head" || failed "HEAD $head is not $COMMIT"
[ "$dirty" = 0 ] && pass "working tree clean" || failed "working tree has $dirty changed files"
# 3. nothing under benchmark/ or src/ may change during the run: the harness hashes them; record the profile now
info "benchmark+src profile: $(cd "$repo/artifacts/api-server" && find benchmark src -type f \( -name '*.ts' -o -name '*.mjs' -o -name '*.sh' -o -name '*.py' \) | sort | xargs cat | sha256sum | cut -c1-16) (harness asserts it unchanged at the end)"
# 4. services topology
pgv=$(q "select version()"); [ -n "$pgv" ] && pass "PostgreSQL reachable: ${pgv:0:40}" || failed "PostgreSQL unreachable"
rv=$(redis-cli -u "$REDIS_URL" INFO server 2>/dev/null | awk -F: '/^redis_version/{print $2}' | tr -d '\r'); [ -n "$rv" ] && pass "Redis reachable: $rv" || failed "Redis unreachable"
pghost=$(python3 -c "import sys,urllib.parse as u; print(u.urlparse(sys.argv[1]).hostname)" "$CAMPAIGN_BENCHMARK_DATABASE_URL"); rhost=$(python3 -c "import sys,urllib.parse as u; print(u.urlparse(sys.argv[1]).hostname)" "$REDIS_URL")
case "$pghost" in localhost|127.0.0.1|::1) failed "PostgreSQL is on this host ($pghost): the transport host must not run the database";; *) pass "PostgreSQL on another host ($pghost)";; esac
case "$rhost" in localhost|127.0.0.1|::1) failed "Redis is on this host ($rhost)";; *) pass "Redis on another host ($rhost)";; esac
# 5. RTT and clock offset to the shared hosts
for h in $pghost $rhost ${PEERS:-}; do
  rtt=$(ping -c 5 -i 0.2 -q "$h" 2>/dev/null | awk -F/ '/rtt|round-trip/{print $5}'); info "RTT to $h: ${rtt:-n/a} ms avg"
done
off=$(chronyc tracking 2>/dev/null | awk -F: '/System time/{print $2}'); [ -z "$off" ] && off=$(ntpq -p 2>/dev/null | awk '/^\*/{print $9" ms"}'); [ -z "$off" ] && off=$(timedatectl show -p NTPSynchronized --value 2>/dev/null | sed 's/^/NTPSynchronized=/')
info "clock: ${off:-no chrony/ntpq/timedatectl answer; record the offset by other means}"
dboff=$(q "select round(extract(epoch from (clock_timestamp() - to_timestamp($(date +%s.%N))))*1000)"); info "this host vs PostgreSQL clock: ${dboff:-n/a} ms (includes one-way latency)"
# 6. phone ids: fresh database, or this cell's phones already at the expected ids
n=$(q "select count(*) from phone_numbers"); ids=$(q "select coalesce(string_agg(id::text, ',' order by id),'') from phone_numbers")
[ "${n:-x}" = 0 ] && pass "fresh database (no phones yet): cell k will own 4k-3..4k" || info "phones present: ids $ids (expected 1..$((4*cells)) in cell order)"
# 7. unrelated workload on this host
others=$(ps -eo pid,pcpu,comm --sort=-pcpu | awk 'NR>1 && $2>5 && $3!="ps"' | head -5); [ -z "$others" ] && pass "no process above 5% CPU" || failed "busy processes: $(echo $others)"
for c in postgres redis-server; do pgrep -x "$c" >/dev/null && failed "$c is running on this transport host" || pass "no $c on this host"; done
info "cpus $(nproc), mem $(free -g | awk '/Mem/{print $2}') GB, load $(cut -d' ' -f1-3 /proc/loadavg)"
# 8. affinity (checked after the cell starts): print the shard threads' allowed CPUs for the runtime process
pid=$(pgrep -f "benchmark-dist/campaign-benchmark.mjs" | head -1)
if [ -n "$pid" ]; then for t in /proc/$pid/task/*; do echo "$(basename $t) $(grep Cpus_allowed_list $t/status | awk '{print $2}')"; done | sort -k2 | uniq -c -f1 | awk '{print "INFO affinity: "$1" threads on cpus "$3}'; else info "affinity: run again once the cell is up (pin.log also records the pinned thread ids)"; fi
# 9. connection headroom: 26 per runtime process (20 claim + 6 settlement), +1 replacement, + samplers
maxc=$(q "show max_connections"); cur=$(q "select count(*) from pg_stat_activity"); need=$(( 26 * (cells + 1) + 20 ))
[ "${maxc:-0}" -ge "$need" ] && pass "max_connections $maxc >= $need needed (in use now: $cur)" || failed "max_connections ${maxc:-?} < $need needed"
[ "$(q "select count(*) from pg_extension where extname='pg_stat_statements'")" = 1 ] && pass "pg_stat_statements present" || info "pg_stat_statements missing: statement latency will be blank"
# 10. output identity: the harness records source.gitCommit and hardware.hostname in harness.json
pass "harness.json will record commit $head and hostname $(hostname)"
exit $fail
