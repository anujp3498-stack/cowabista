#!/bin/bash
# Hard-kill failover test for one transport cell.
# Replacement artifacts are prebuilt outside .benchmark-dist so run.mjs
# cleanup cannot race with or delete them.
set -uo pipefail

k=${1:?cell index}
out=$(realpath -m "${2:-./results/failover-cell-$k}")

: "${CAMPAIGN_BENCHMARK_DATABASE_URL:?}"
: "${REDIS_URL:?}"
: "${CAMPAIGN_BENCHMARK_CONFIRM:?}"

command -v flock >/dev/null 2>&1 || {
  echo "ERROR: flock is required" >&2
  exit 2
}

exec 9>"/tmp/wabista-benchmark-failover-cell-${k}.lock"
if ! flock -n 9; then
  echo "ERROR: another failover test for cell $k is already running" >&2
  exit 2
fi

if [ -e "$out" ]; then
  if [ ! -d "$out" ] || [ -n "$(ls -A "$out" 2>/dev/null)" ]; then
    echo "ERROR: result directory already exists and is not empty: $out" >&2
    exit 2
  fi
fi
mkdir -p "$out"

here=$(cd "$(dirname "$0")" && pwd)
api=$(cd "$here/../.." && pwd)

from=$((4*k - 3))
to=$((4*k))

CELL=""
REPL=""

kill_if_alive() {
  local p="${1:-}"
  if [[ "$p" =~ ^[0-9]+$ ]] && kill -0 "$p" 2>/dev/null; then
    kill -TERM "$p" 2>/dev/null || true
  fi
}

cleanup() {
  local rc=$?

  runtime_pid=""
  runner_pid=""

  [ -s "$out/cell/runtime.pid" ] && runtime_pid=$(tr -d '[:space:]' < "$out/cell/runtime.pid")
  [ -s "$out/cell/runner.pid" ] && runner_pid=$(tr -d '[:space:]' < "$out/cell/runner.pid")

  kill_if_alive "${REPL:-}"
  kill_if_alive "${runtime_pid:-}"
  kill_if_alive "${runner_pid:-}"
  kill_if_alive "${CELL:-}"

  return "$rc"
}

trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'exit 129' HUP

# ------------------------------------------------------------
# PREBUILD replacement artifacts BEFORE the kill.
# Do NOT use .benchmark-dist: run.mjs deletes that directory
# when the killed benchmark child exits.
# ------------------------------------------------------------
builddir="$out/replacement-dist"
mkdir -p "$builddir"

echo "$(date +%s%3N) replacement prebuild starting" >> "$out/events.log"

(
  cd "$api" || exit 1

  FAILOVER_BUILD_DIR="$builddir" node - <<'NODE'
const path = require("node:path");
const { build } = require("esbuild");

const dir = process.env.FAILOVER_BUILD_DIR;
if (!dir) throw new Error("FAILOVER_BUILD_DIR missing");

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; globalThis.require = __cr(import.meta.url);",
  },
};

(async () => {
  await Promise.all([
    build({
      ...common,
      entryPoints: ["benchmark/distributed/replacement-runtime.ts"],
      outfile: path.join(dir, "replacement-runtime.mjs"),
    }),
    build({
      ...common,
      entryPoints: ["src/services/campaign-transport-shard-worker.ts"],
      outfile: path.join(dir, "campaign-transport-shard-worker.mjs"),
    }),
  ]);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
) || {
  echo "ERROR: replacement build failed" >&2
  exit 6
}

for artifact in \
  "$builddir/replacement-runtime.mjs" \
  "$builddir/campaign-transport-shard-worker.mjs"
do
  if [ ! -s "$artifact" ]; then
    echo "ERROR: missing/empty replacement artifact: $artifact" >&2
    exit 6
  fi

  node --check "$artifact" >/dev/null || {
    echo "ERROR: replacement artifact failed syntax check: $artifact" >&2
    exit 6
  }
done

echo "$(date +%s%3N) replacement prebuild ready" >> "$out/events.log"

# ------------------------------------------------------------
# Start original benchmark cell.
# ------------------------------------------------------------
"$here/cell.sh" "$k" "$out/cell" &
CELL=$!
printf '%s\n' "$CELL" > "$out/cell-wrapper.pid"

runtime_start_timeout="${FAILOVER_RUNTIME_START_TIMEOUT:-300}"

if ! [[ "$runtime_start_timeout" =~ ^[0-9]+$ ]] || [ "$runtime_start_timeout" -lt 30 ]; then
  echo "ERROR: invalid FAILOVER_RUNTIME_START_TIMEOUT: $runtime_start_timeout" >&2
  exit 3
fi

echo "$(date +%s%3N) waiting for local runtime startup timeout ${runtime_start_timeout}s" >> "$out/events.log"

deadline=$((SECONDS + runtime_start_timeout))

while :; do
  if [ -s "$out/cell/runtime.pid" ] &&
     grep -q "Campaign runtime started" "$out/cell/run.log" 2>/dev/null; then
    break
  fi

  if ! kill -0 "$CELL" 2>/dev/null; then
    echo "ERROR: cell exited before campaign runtime started" >&2
    wait "$CELL" 2>/dev/null || true
    exit 3
  fi

  if (( SECONDS >= deadline )); then
    echo "ERROR: timed out waiting for campaign runtime startup" >&2
    exit 3
  fi

  sleep 0.25
done

pid=$(tr -d '[:space:]' < "$out/cell/runtime.pid")

if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
  echo "ERROR: invalid benchmark runtime PID: ${pid:-missing}" >&2
  exit 4
fi

if ! kill -0 "$pid" 2>/dev/null; then
  echo "ERROR: benchmark runtime PID $pid is not alive" >&2
  exit 4
fi

cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
case "$cmdline" in
  *".benchmark-dist/campaign-benchmark.mjs"*) ;;
  *)
    echo "ERROR: PID $pid is not the expected campaign benchmark runtime" >&2
    echo "cmdline=$cmdline" >&2
    exit 4
    ;;
esac

campaign=$(
  psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" \
    -v ON_ERROR_STOP=1 \
    -At \
    -c "select c.id
        from campaigns c
        join organizations o on o.id=c.organization_id
        where o.slug like 'campaign-benchmark-$(hostname)-${pid}-%'
        order by c.id desc
        limit 1"
) || {
  echo "ERROR: campaign lookup failed" >&2
  exit 5
}

campaign=$(printf '%s' "$campaign" | tr -d '[:space:]')

if ! [[ "$campaign" =~ ^[0-9]+$ ]]; then
  echo "ERROR: campaign id not found for runtime PID $pid" >&2
  exit 5
fi

echo "$(date +%s%3N) runtime started pid $pid campaign $campaign" >> "$out/events.log"

# ------------------------------------------------------------
# Optional peer-ready gate.
# For a valid two-cell failover test, do not start the kill
# countdown until the companion cell is demonstrably sending.
# ------------------------------------------------------------
if [ -n "${FAILOVER_PEER_HOST:-}" ]; then
  peer_host="$FAILOVER_PEER_HOST"
  peer_min="${FAILOVER_PEER_SENT_MIN:-40000}"
  peer_timeout="${FAILOVER_PEER_READY_TIMEOUT:-180}"

  if ! [[ "$peer_host" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "ERROR: invalid FAILOVER_PEER_HOST: $peer_host" >&2
    exit 11
  fi

  if ! [[ "$peer_min" =~ ^[0-9]+$ ]] || ! [[ "$peer_timeout" =~ ^[0-9]+$ ]]; then
    echo "ERROR: invalid peer gate numeric configuration" >&2
    exit 11
  fi

  echo "$(date +%s%3N) waiting for peer host $peer_host sent >= $peer_min" >> "$out/events.log"

  peer_deadline=$((SECONDS + peer_timeout))
  peer_campaign=""
  peer_sent=0

  while :; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "ERROR: local benchmark runtime exited while waiting for peer readiness" >&2
      exit 12
    fi

    peer_row=$(
      psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" \
        -v ON_ERROR_STOP=1 \
        -At -F'|' \
        -c "select
              c.id,
              c.status,
              coalesce(m.sent,0),
              coalesce(m.queued,0),
              coalesce(m.processing,0)
            from campaigns c
            join organizations o on o.id=c.organization_id
            left join campaign_metrics m on m.campaign_id=c.id
            where o.slug like 'campaign-benchmark-${peer_host}-%'
            order by c.id desc
            limit 1" 2>/dev/null || true
    )

    if [ -n "$peer_row" ]; then
      IFS='|' read -r peer_campaign peer_status peer_sent peer_queued peer_processing <<< "$peer_row"

      peer_remaining=$(( ${peer_queued:-0} + ${peer_processing:-0} ))

      if [[ "$peer_campaign" =~ ^[0-9]+$ ]] &&
         [ "$peer_status" = "Running" ] &&
         [ "${peer_sent:-0}" -ge "$peer_min" ] &&
         [ "$peer_remaining" -gt 0 ]; then

        echo "$(date +%s%3N) peer ready campaign $peer_campaign sent $peer_sent remaining $peer_remaining" \
          >> "$out/events.log"
        break
      fi
    fi

    if (( SECONDS >= peer_deadline )); then
      echo "ERROR: timed out waiting for active peer $peer_host" >&2
      exit 13
    fi

    sleep 0.5
  done
fi

# KILL_AFTER is now the delay AFTER all required runtimes are ready.
sleep "${KILL_AFTER:-20}"

# The local campaign itself must still have active work.
local_row=$(
  psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" \
    -v ON_ERROR_STOP=1 \
    -At -F'|' \
    -c "select
          c.status,
          coalesce(m.sent,0),
          coalesce(m.queued,0),
          coalesce(m.processing,0)
        from campaigns c
        left join campaign_metrics m on m.campaign_id=c.id
        where c.id=$campaign"
) || {
  echo "ERROR: local campaign pre-kill check failed" >&2
  exit 14
}

IFS='|' read -r local_status local_sent local_queued local_processing <<< "$local_row"
local_remaining=$(( ${local_queued:-0} + ${local_processing:-0} ))

if [ "$local_status" != "Running" ] || [ "$local_remaining" -le 0 ]; then
  echo "ERROR: refusing failover kill because local campaign is no longer active: status=$local_status sent=$local_sent remaining=$local_remaining" >&2
  exit 14
fi

echo "$(date +%s%3N) pre-kill local sent $local_sent remaining $local_remaining peer ${peer_campaign:-none} peerSent ${peer_sent:-0}" \
  >> "$out/events.log"

# Revalidate the exact PID immediately before destructive kill.
if ! kill -0 "$pid" 2>/dev/null; then
  echo "ERROR: benchmark runtime exited before scheduled kill" >&2
  exit 7
fi

cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
case "$cmdline" in
  *".benchmark-dist/campaign-benchmark.mjs"*) ;;
  *)
    echo "ERROR: refusing to kill PID $pid because its command changed" >&2
    exit 7
    ;;
esac

echo "$(date +%s%3N) KILL pid $pid" >> "$out/events.log"

kill -KILL "$pid" || {
  echo "ERROR: SIGKILL failed for runtime PID $pid" >&2
  exit 7
}

# ------------------------------------------------------------
# Start prebuilt replacement immediately.
# ------------------------------------------------------------
echo "$(date +%s%3N) replacement starting" >> "$out/events.log"

(
  cd "$api" || exit 1

  DATABASE_URL="$CAMPAIGN_BENCHMARK_DATABASE_URL" \
  CAMPAIGN_REDIS_URL="$REDIS_URL" \
  CAMPAIGN_COORDINATOR_MODE=redis \
  CAMPAIGN_TRANSPORT_PHONE_IDS="$from-$to" \
  P19_CAMPAIGN_ID="$campaign" \
  P19_LOG="$out/replacement.jsonl" \
  node --expose-gc "$builddir/replacement-runtime.mjs" \
    > "$out/replacement.log" 2>&1
) &

REPL=$!
printf '%s\n' "$REPL" > "$out/replacement.pid"

wait "$REPL"
repl_rc=$?
REPL=""

# Original cell wrapper should terminate after run.mjs observes the SIGKILL.
wait "$CELL" 2>/dev/null || true
CELL=""

jobs_rc=0
psql "$CAMPAIGN_BENCHMARK_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -At -F'|' \
  -c "select status,
             attempts,
             count(*),
             left(coalesce(error_reason,''),80)
      from campaign_jobs
      where campaign_id=$campaign
      group by 1,2,4
      order by 1,2" \
  > "$out/jobs.txt" || jobs_rc=$?

python3 "$here/failover-analyze.py" "$out" | tee "$out/summary.txt"
analysis_rc=${PIPESTATUS[0]}

if (( repl_rc != 0 )); then
  echo "ERROR: replacement runtime exited rc=$repl_rc" >&2
  exit 8
fi

if (( jobs_rc != 0 )); then
  echo "ERROR: final job accounting query failed" >&2
  exit 9
fi

if (( analysis_rc != 0 )); then
  echo "ERROR: failover analyzer failed rc=$analysis_rc" >&2
  exit 10
fi
