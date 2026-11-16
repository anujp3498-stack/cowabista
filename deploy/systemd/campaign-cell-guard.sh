#!/bin/bash
# ExecStartPre guard for campaign-cell@<cell>.service. Fails closed: the transport runtime only starts when this
# cell's phone assignment is explicit and matches the fleet manifest, it is the only cell on this host, and the
# shared PostgreSQL and Redis answer. Two assignment modes:
#   auto   (V2-372) CAMPAIGN_TRANSPORT_ASSIGNMENT=auto, no CAMPAIGN_TRANSPORT_PHONE_IDS, manifest scope column "auto":
#          the live cells divide every sendable phone between them and take over a dead cell's phones, so a newly
#          connected phone is sent without editing any scope (src/services/campaign-phone-assignment.ts).
#   static CAMPAIGN_TRANSPORT_PHONE_IDS=<ids>, equal to the manifest scope and disjoint from every other static
#          cell. A phone in no static scope is never sent (the runtime logs "Sendable phone has no transport owner").
# The manifest's third column is `auto`, a static scope such as `1-4`, or, while a fleet migrates between the two,
# `auto|1-4`: the cell may start automatic, or static with exactly that scope. Every intermediate state of the
# migration (docs/AUTO_PHONE_ASSIGNMENT.md, section 7) then accepts each cell's current environment, so a cell that
# restarts unexpectedly mid-migration starts again instead of being refused. A refused cell does not run until its
# files are fixed: whether systemd retries a refused ExecStartPre until its start limit is unverified (deploy/cutover
# RUNBOOK G78); after fixing, `systemctl reset-failed campaign-cell@<cell>` and start it.
# Dry run: CAMPAIGN_CELL_GUARD_DRY_RUN=1 runs only the assignment and manifest checks (1-2) against the environment
# and manifest given (for example a candidate manifest via CAMPAIGN_CELL_MANIFEST), prints "DRY-RUN OK" and exits 0,
# or refuses exactly as a start would. It starts nothing and contacts no service. With CAMPAIGN_CELL_GUARD_ENV_FILE
# (dry run only) the two assignment variables are read from that file the way systemd's EnvironmentFile= reads them,
# without executing it; run the dry run as the service user, so a file it cannot read is refused here too.
# Prints the effective configuration (secrets redacted) to the journal before the process starts. Deployment-only:
# it changes nothing in the application. Exit 78 (EX_CONFIG) on refusal; see above for whether systemd retries it.
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

# 0. Dry run against a candidate env file. Only CAMPAIGN_TRANSPORT_ASSIGNMENT and CAMPAIGN_TRANSPORT_PHONE_IDS matter to
#    the checks a dry run makes; they are read like systemd's EnvironmentFile= (KEY=VALUE lines, '#' and ';' comment
#    lines, whitespace around the key and value trimmed, one pair of surrounding quotes removed, the last assignment
#    wins) and replace any value in this process's environment. The file is never executed (secrets in it could be).
envfile=${CAMPAIGN_CELL_GUARD_ENV_FILE:-}
if [ -n "$envfile" ]; then
  [ "${CAMPAIGN_CELL_GUARD_DRY_RUN:-}" = 1 ] || refuse "CAMPAIGN_CELL_GUARD_ENV_FILE is for dry runs only (set CAMPAIGN_CELL_GUARD_DRY_RUN=1)"
  [ -r "$envfile" ] || refuse "environment file $envfile is missing or unreadable"
  env_value() {  # the last value of $1 in $envfile; status 1 when the file does not set it
    awk -v k="$1" -v sq="'" -v dq='"' '
      { sub(/\r$/, ""); sub(/^[ \t]+/, "") }
      $0 == "" || /^[#;]/ { next }
      { i = index($0, "="); if (i == 0) next
        key = substr($0, 1, i - 1); sub(/[ \t]+$/, "", key); if (key != k) next
        v = substr($0, i + 1); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v)
        q = substr(v, 1, 1)
        if (length(v) >= 2 && (q == sq || q == dq) && substr(v, length(v), 1) == q) v = substr(v, 2, length(v) - 2)
        found = 1; val = v }
      END { if (!found) exit 1; print val }' "$envfile"
  }
  unset CAMPAIGN_TRANSPORT_ASSIGNMENT CAMPAIGN_TRANSPORT_PHONE_IDS
  if value=$(env_value CAMPAIGN_TRANSPORT_ASSIGNMENT); then CAMPAIGN_TRANSPORT_ASSIGNMENT=$value; fi
  if value=$(env_value CAMPAIGN_TRANSPORT_PHONE_IDS); then CAMPAIGN_TRANSPORT_PHONE_IDS=$value; fi
fi

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

# 2. The manifest is the single source of truth (cell -> host -> assignment). This cell must be listed, on this host,
#    with an assignment that allows this environment; a static cell may share no phone with any other cell's static
#    scope. Automatic cells need no disjointness: the fenced Redis lease, not the manifest, keeps two runtimes from
#    owning one phone. Assignment column: `auto` | `<scope>` | `auto|<scope>` (transitional: either mode).
static_part() {  # the static scope a manifest assignment allows ("" for auto only); refuses a malformed column
  local column=$1 who=$2
  case "$column" in
    auto) echo "" ;;
    auto\|*)
      local rest=${column#auto|}
      [[ "$rest" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]] || refuse "$manifest gives cell $who the assignment \"$column\"; a transitional row is auto|<scope>, for example auto|1-4"
      echo "$rest" ;;
    *)
      [[ "$column" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]] || refuse "$manifest gives cell $who the assignment \"$column\"; use auto, a scope such as 1-4, or auto|<scope> during a migration"
      echo "$column" ;;
  esac
}
[ -r "$manifest" ] || refuse "fleet manifest $manifest is missing or unreadable"
line=$(grep -vE '^[[:space:]]*(#|$)' "$manifest" | awk -v c="$cell" '$1==c' | head -1)
[ -n "$line" ] || refuse "cell \"$cell\" is not listed in $manifest"
read -r _ mhost massign <<<"$line"
[ "$mhost" = "$host" ] || refuse "$manifest assigns cell $cell to host \"$mhost\"; this host is \"$host\""
massign=${massign//[[:space:]]/}
mstatic=$(static_part "$massign" "$cell") || exit 78
if [ "$mode" = auto ]; then
  [ "$massign" = auto ] || [[ "$massign" == auto\|* ]] \
    || refuse "cell $cell is automatic here but $manifest gives it the static scope \"$massign\"; write auto (or auto|$massign while migrating) in its assignment column"
else
  [ -n "$mstatic" ] || refuse "$manifest makes cell $cell automatic only, but this environment gives it the static scope \"$scope\"; write auto|$scope in its assignment column while migrating"
  mids=$(expand "$mstatic") || exit 78
  [ "$mids" = "$ids" ] || refuse "CAMPAIGN_TRANSPORT_PHONE_IDS=\"$scope\" differs from the manifest scope \"$mstatic\" for cell $cell"
fi
while read -r other ohost oassign; do
  [[ -z $other || $other == \#* || $other == "$cell" ]] && continue
  [ "$ohost" != "$host" ] || refuse "$manifest also assigns cell $other to this host; one cell per host"
  ostatic=$(static_part "${oassign//[[:space:]]/}" "$other") || exit 78
  [ "$mode" = static ] && [ -n "$ostatic" ] || continue
  oids=$(expand "$ostatic") || exit 78
  # comm needs both lists in its own (text) order; expand() sorts numerically, which comm misreads for
  # multi-digit ids (9-12 against 12-14 would pass unnoticed).
  overlap=$(comm -12 <(sort <<<"$ids") <(sort <<<"$oids") | head -1)
  [ -z "$overlap" ] || refuse "phone $overlap is in the scope of cell $cell and of cell $other ($manifest); scopes must be disjoint"
done < <(grep -vE '^[[:space:]]*(#|$)' "$manifest")

if [ "${CAMPAIGN_CELL_GUARD_DRY_RUN:-}" = 1 ]; then
  if [ "$mode" = auto ]; then planned="assignment=auto"; else planned="assignment=static scope=$scope phones=$count"; fi
  echo "campaign-cell[$cell] DRY-RUN OK host=$host $planned manifest_assignment=$massign manifest=$manifest env=${envfile:-(process environment)} (host and service checks skipped)"
  exit 0
fi

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
assignment="$assignment manifest_assignment=$massign"
echo "campaign-cell[$cell] OK host=$host $assignment shards=${CAMPAIGN_TRANSPORT_SHARDS:-8} port=$PORT node=$(node --version 2>/dev/null || echo unknown) commit=$commit db=$(redact <<<"$DATABASE_URL") redis=$(redact <<<"$redis") manifest=$manifest"
