#!/bin/bash
# ExecStartPre guard for campaign-cell@<cell>.service. Fails closed: the transport runtime only starts when this
# cell's phone assignment is explicit and matches the fleet manifest, it is the only cell on this host, and the
# shared PostgreSQL and Redis answer. Two assignment modes:
#   auto   (V2-372) CAMPAIGN_TRANSPORT_ASSIGNMENT=auto, no CAMPAIGN_TRANSPORT_PHONE_IDS, manifest scope column "auto":
#          the live cells divide every sendable phone between them and take over a dead cell's phones, so a newly
#          connected phone is sent without editing any scope (src/services/campaign-phone-assignment.ts).
#   static CAMPAIGN_TRANSPORT_PHONE_IDS=<ids>, equal to the manifest scope and disjoint from every other static
#          cell. A phone in no static scope is never sent (the runtime logs "Sendable phone has no transport owner").
# Prints the effective configuration (secrets redacted) to the journal before the process starts. Deployment-only:
# it changes nothing in the application. Exit 78 (EX_CONFIG) on refusal; systemd does not restart on it.
set -uo pipefail
cell=${CAMPAIGN_CELL:?CAMPAIGN_CELL (the unit instance name) is required}
manifest=${CAMPAIGN_CELL_MANIFEST:-/etc/cowabista/cells.manifest}
host=$(hostname)
refuse() { echo "campaign-cell[$cell] REFUSING START: $*" >&2; exit 78; }

expand() {  # "1-4,9" -> sorted unique ids, one per line; refuses descending or zero ids like the application does
  local part a b; IFS=, read -ra parts <<<"$1"
  for part in "${parts[@]}"; do
    if [[ $part == *-* ]]; then a=${part%-*}; b=${part#*-}; else a=$part; b=$part; fi
    { [ "$a" -ge 1 ] && [ "$b" -ge "$a" ]; } 2>/dev/null || refuse "\"$part\" must name positive phone ids in ascending order"
    seq "$a" "$b"
  done | sort -n | uniq
}

# 1. Explicit assignment. An unset scope without automatic mode would make the runtime race every other runtime for
#    every phone, first come first served (src/services/campaign-phone-scope.ts, "unscoped").
mode=${CAMPAIGN_TRANSPORT_ASSIGNMENT:-}; mode=${mode//[[:space:]]/}; mode=${mode,,}
scope=${CAMPAIGN_TRANSPORT_PHONE_IDS:-}; scope=${scope//[[:space:]]/}
case "$mode" in
  auto)
    [ -z "$scope" ] || refuse "CAMPAIGN_TRANSPORT_ASSIGNMENT=auto with CAMPAIGN_TRANSPORT_PHONE_IDS=\"$scope\"; automatic cells take no scope, unset it"
    ;;
  ""|static)
    [ -n "$scope" ] || refuse "CAMPAIGN_TRANSPORT_PHONE_IDS is unset or blank; set CAMPAIGN_TRANSPORT_ASSIGNMENT=auto (recommended) or an explicit scope"
    [[ "$scope" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]] || refuse "CAMPAIGN_TRANSPORT_PHONE_IDS=\"$scope\" is not of the form 1-4 or 1,2,3,9"
    mode=static
    ids=$(expand "$scope") || exit 78; count=$(echo "$ids" | wc -l | tr -d ' ')
    ;;
  *) refuse "CAMPAIGN_TRANSPORT_ASSIGNMENT=\"$mode\" must be auto or static" ;;
esac
[[ "$cell" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || refuse "cell name \"$cell\" must be 1-64 letters, digits, '.', '_' or '-'"

# 2. The manifest is the single source of truth (cell -> host -> scope or "auto"). This cell must be listed, on this
#    host, with exactly this assignment; a static cell may share no phone with another static cell. Automatic cells
#    need no disjointness: the fenced Redis lease, not the manifest, keeps two runtimes from owning one phone.
[ -r "$manifest" ] || refuse "fleet manifest $manifest is missing or unreadable"
line=$(grep -vE '^[[:space:]]*(#|$)' "$manifest" | awk -v c="$cell" '$1==c' | head -1)
[ -n "$line" ] || refuse "cell \"$cell\" is not listed in $manifest"
read -r _ mhost mscope <<<"$line"
[ "$mhost" = "$host" ] || refuse "$manifest assigns cell $cell to host \"$mhost\"; this host is \"$host\""
mscope=${mscope//[[:space:]]/}
if [ "$mode" = auto ]; then
  [ "$mscope" = auto ] || refuse "cell $cell is automatic here but $manifest gives it the static scope \"$mscope\"; write auto in its scope column"
else
  [ "$mscope" != auto ] || refuse "$manifest makes cell $cell automatic but this environment gives it the static scope \"$scope\""
  mids=$(expand "$mscope") || exit 78
  [ "$mids" = "$ids" ] || refuse "CAMPAIGN_TRANSPORT_PHONE_IDS=\"$scope\" differs from the manifest scope \"$mscope\" for cell $cell"
fi
while read -r other ohost oscope; do
  [[ -z $other || $other == \#* || $other == "$cell" ]] && continue
  [ "$ohost" != "$host" ] || refuse "$manifest also assigns cell $other to this host; one cell per host"
  oscope=${oscope//[[:space:]]/}
  [ "$mode" = static ] && [ "$oscope" != auto ] || continue
  oids=$(expand "$oscope") || exit 78
  # comm needs both lists in its own (text) order; expand() sorts numerically, which comm misreads for
  # multi-digit ids (9-12 against 12-14 would pass unnoticed).
  overlap=$(comm -12 <(sort <<<"$ids") <(sort <<<"$oids") | head -1)
  [ -z "$overlap" ] || refuse "phone $overlap is in the scope of cell $cell and of cell $other ($manifest); scopes must be disjoint"
done < <(grep -vE '^[[:space:]]*(#|$)' "$manifest")

# 3. Exactly one transport runtime per host: refuse if another cell instance is already active here.
if command -v systemctl >/dev/null 2>&1; then
  for unit in $(systemctl list-units --plain --no-legend --state=active,activating,deactivating 'campaign-cell@*.service' 2>/dev/null | awk '{print $1}'); do
    other=${unit#campaign-cell@}; other=${other%.service}
    [ "$other" = "$cell" ] || refuse "cell $other is already running on this host (unit $unit); one cell per host"
  done
fi

# 4. Production mode and the shared services. NODE_ENV=production makes the application itself require the Redis
#    coordinator and broker; the guard checks the same things earlier and with a clearer message.
[ "${NODE_ENV:-}" = production ] || refuse "NODE_ENV must be production (got \"${NODE_ENV:-}\")"
[ "${CAMPAIGN_COORDINATOR_MODE:-}" = redis ] || refuse "CAMPAIGN_COORDINATOR_MODE must be redis (got \"${CAMPAIGN_COORDINATOR_MODE:-}\")"
redis=${CAMPAIGN_REDIS_URL:-${REDIS_URL:-}}; [ -n "$redis" ] || refuse "CAMPAIGN_REDIS_URL (or REDIS_URL) is required"
[ -n "${DATABASE_URL:-}" ] || refuse "DATABASE_URL is required"
[[ "${PORT:-}" =~ ^[0-9]+$ ]] && [ "$PORT" -gt 0 ] || refuse "PORT must be a positive integer (got \"${PORT:-}\")"
redact() { sed -E 's#(://[^:/@]*):[^@]*@#\1:***@#'; }
wait_for() { local i; for ((i = 0; i < ${CAMPAIGN_CELL_WAIT_SECONDS:-60}; i += 1)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
wait_for pg_isready -q -d "$DATABASE_URL" || refuse "PostgreSQL $(redact <<<"$DATABASE_URL") did not answer within ${CAMPAIGN_CELL_WAIT_SECONDS:-60} s"
wait_for redis-cli -u "$redis" ping || refuse "Redis $(redact <<<"$redis") did not answer PING within ${CAMPAIGN_CELL_WAIT_SECONDS:-60} s"
for extra in ${CAMPAIGN_CELL_REQUIRED_ENV:-}; do [ -n "${!extra:-}" ] || refuse "$extra is required (listed in CAMPAIGN_CELL_REQUIRED_ENV)"; done

# 5. Visible startup configuration.
repo=${CAMPAIGN_CELL_REPO:-$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)}
commit=$(git -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
if [ "$mode" = auto ]; then assignment="assignment=auto"; else assignment="assignment=static scope=$scope phones=$count"; fi
echo "campaign-cell[$cell] OK host=$host $assignment shards=${CAMPAIGN_TRANSPORT_SHARDS:-8} port=$PORT node=$(node --version 2>/dev/null || echo unknown) commit=$commit db=$(redact <<<"$DATABASE_URL") redis=$(redact <<<"$redis") manifest=$manifest"
