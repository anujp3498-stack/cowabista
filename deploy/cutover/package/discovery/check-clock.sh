#!/usr/bin/env bash
# Read-only clock gate (G-CLOCK) for cells C and D (C1, C2) and Host S. Run on each host:
#   bash discovery/check-clock.sh                                  # this host's NTP state and offset
#   bash discovery/check-clock.sh <REDIS_HOST> [<REDIS_PORT>]      # on C and D: also the skew against Host S's Redis
# Phone ownership validity is computed from Redis TIME on Host S and compared with each cell's own clock
# (docs/CROSS_CELL_DISPATCH_AUTHORIZATION.md): a cell running seconds off Host S treats every ownership as
# expired, or holds one too long. PASS requires: NTP synchronized, |offset from NTP| < 0.5 s (so any two hosts
# are within 1 s), and, when measured, |cell - Redis TIME| < 1 s.
# Read only: no time change, no service action, no file written; the Redis password (if any) is typed at a hidden
# prompt and passed only through REDISCLI_AUTH; it is never printed. Exit 0 PASS, 3 FAIL, 4 UNKNOWN.
set -uo pipefail
LIMIT_HOST_S=0.5
LIMIT_PAIR_S=1.0
status=0
fail() { echo "FAIL: $*"; status=3; }
unknown() { echo "UNKNOWN: $*"; [ "$status" -eq 0 ] && status=4; }
abs_lt() { awk -v v="$1" -v l="$2" 'BEGIN { if (v < 0) v = -v; exit !(v < l) }'; }

echo "host=$(hostname) utc=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"

synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)
ntp=$(timedatectl show -p NTP --value 2>/dev/null || true)
echo "timedatectl NTP=${ntp:-unknown} NTPSynchronized=${synced:-unknown}"
[ "$synced" = "yes" ] || fail "NTPSynchronized is '${synced:-unknown}', not yes"

offset=""
if command -v chronyc >/dev/null 2>&1; then
  # "System time     : 0.000012345 seconds fast of NTP time"
  line=$(chronyc -n tracking 2>/dev/null | grep -E '^System time' || true)
  leap=$(chronyc -n tracking 2>/dev/null | awk -F': ' '/^Leap status/ { print $2 }' || true)
  echo "chrony: ${line:-no tracking data} leap=${leap:-unknown}"
  offset=$(echo "$line" | awk '{ v = $4; if ($6 == "slow") v = -v; print v }')
  [ "${leap:-}" = "Normal" ] || fail "chrony leap status is '${leap:-unknown}', not Normal"
elif timedatectl timesync-status >/dev/null 2>&1; then
  # "Offset: +1.234ms" (systemd-timesyncd)
  raw=$(timedatectl timesync-status 2>/dev/null | awk -F': ' '/Offset/ { print $2 }' | tr -d ' ')
  echo "timesyncd: offset=${raw:-unknown}"
  offset=$(echo "$raw" | awk '{ v = $0; u = 1; if (v ~ /us$/) { u = 0.000001; sub(/us$/, "", v) } else if (v ~ /ms$/) { u = 0.001; sub(/ms$/, "", v) } else { sub(/s$/, "", v) } print v * u }')
elif command -v ntpq >/dev/null 2>&1; then
  # The selected peer's offset, in milliseconds.
  raw=$(ntpq -pn 2>/dev/null | awk '/^\*/ { print $9 }')
  echo "ntpd: selected-peer offset_ms=${raw:-none}"
  [ -n "$raw" ] && offset=$(awk -v v="$raw" 'BEGIN { print v / 1000 }')
fi
if [ -z "$offset" ]; then
  unknown "no chrony, timesyncd or ntpd offset available"
else
  echo "offset_s=$offset (limit ${LIMIT_HOST_S})"
  abs_lt "$offset" "$LIMIT_HOST_S" || fail "offset ${offset} s from NTP is not under ${LIMIT_HOST_S} s"
fi

if [ $# -ge 1 ]; then
  redis_host=$1
  redis_port=${2:-6379}
  if ! command -v redis-cli >/dev/null 2>&1; then
    unknown "redis-cli not installed: cell-to-Redis skew not measured"
  else
    printf 'Redis password for %s:%s (hidden; empty if none): ' "$redis_host" "$redis_port" >&2
    IFS= read -rs pass; echo >&2
    tls=(); [ "${REDIS_TLS:-0}" = "1" ] && tls=(--tls)
    before=$(date +%s.%N)
    reply=$(REDISCLI_AUTH="$pass" redis-cli "${tls[@]}" -h "$redis_host" -p "$redis_port" --no-auth-warning TIME 2>/dev/null | tr '\n' ' ')
    after=$(date +%s.%N)
    unset pass
    read -r secs usecs _ <<<"$reply"
    if [[ "${secs:-}" =~ ^[0-9]+$ && "${usecs:-}" =~ ^[0-9]+$ ]]; then
      skew=$(awk -v s="$secs" -v u="$usecs" -v b="$before" -v a="$after" 'BEGIN { printf "%.6f", (s + u / 1e6) - (b + a) / 2 }')
      rtt=$(awk -v b="$before" -v a="$after" 'BEGIN { printf "%.6f", a - b }')
      echo "redis_time_minus_local_s=$skew rtt_s=$rtt (limit ${LIMIT_PAIR_S})"
      abs_lt "$skew" "$LIMIT_PAIR_S" || fail "this host is ${skew} s off Host S's Redis clock (limit ${LIMIT_PAIR_S} s)"
    else
      unknown "Redis TIME not read (check host, port, TLS and password); cell-to-Redis skew not measured"
    fi
  fi
fi

case $status in
  0) echo "CLOCK GATE: PASS" ;;
  3) echo "CLOCK GATE: FAIL" ;;
  *) echo "CLOCK GATE: UNKNOWN (not a pass)" ;;
esac
exit $status
