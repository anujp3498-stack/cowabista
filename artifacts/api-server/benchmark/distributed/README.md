# Distributed transport benchmark kit

Runs the campaign benchmark as N independent transport cells (one runtime process, 4 phones, explicit phone scope
each) against one shared PostgreSQL and one shared Redis, and measures true horizontal scaling efficiency,
shared-resource cost per message, and hard-kill failover recovery. Nothing here is production code.

Everything measured so far on one 4-vCPU host (single cell ~3.9K provider-start TPS with the shard threads pinned to
their own CPU; two same-host cells at 0.78-0.85 efficiency) is a host-saturation number, not a scaling result. The
first valid 2-cell result needs the topology below.

## Topology (P22 target experiment)

```
Host A (cell 1)                    Host B (cell 2)
  runtime process, phones 1-4        runtime process, phones 5-8
  4 shard threads pinned to 1 CPU    4 shard threads pinned to 1 CPU
  main thread + V8 on the rest       main thread + V8 on the rest
          \                                  /
   Host C: PostgreSQL 16 (own CPU domain) + Redis 7 (own CPU domain)
   Host D (or C): samplers + analysis (psql, redis-cli, python3), one clock for progress.csv
```

## Infrastructure requirements

- Transport hosts A and B: 4 vCPU and 4 GB each, nothing else running (the host sampler sums every `node`,
  `postgres` and `redis-server` process on the host, and the pinning script picks the runtime by name). Node 22,
  pnpm, this repository at the same git commit on every host (the harness records and asserts the commit and
  file hashes; do not commit or edit anything under `benchmark/` or `src/` while a run is measuring).
  Permission to set thread CPU affinity (root or CAP_SYS_NICE) if `SHARD_CPUS` is used.
- Host C: PostgreSQL with at least 2 dedicated vCPU per 8K TPS (measured 0.11-0.15 cores per 1K TPS plus WAL at
  ~2.7 KB/msg), `max_connections >= 26 x (cells + replacement runtimes) + 20` (each runtime process holds a
  20-connection claim pool and a 6-connection settlement pool; samplers add one short connection per second),
  `shared_preload_libraries = 'pg_stat_statements'` for statement latency, synchronous_commit as in production.
  Redis 7 on its own vCPU (measured ~0.02 cores per 1K TPS; 2 clients per runtime process; streams hold at most
  4,096 unacknowledged entries per phone).
- Network: transport hosts to C on a LAN with sub-millisecond RTT; note the measured RTT, it is part of the result.
- Clocks: NTP on every host within 50 ms. The concurrent aggregate uses one clock (the sampler host writing
  `progress.csv`); cross-host event timelines (kill, takeover, first start) are compared on host clocks.
- Environment on every host: `CAMPAIGN_BENCHMARK_DATABASE_URL=postgresql://user@host-c/campaign_benchmark` (the
  name must contain `bench`), `CAMPAIGN_BENCHMARK_CONFIRM=campaign_benchmark`, `REDIS_URL=redis://host-c:6379`.

## Procedure

1. `./prepare.sh` once per experiment, from any host: drops and recreates the database, pushes the schema,
   flushes Redis. Phone ids are deterministic only on a fresh database: cell k owns phones 4k-3..4k because
   cell 1's harness inserts phones 1-4 first and cell k waits until 4(k-1) phone rows exist. Never reuse a
   database across experiments, and always start cell 1 first.
2. Start the shared samplers on host D:
   `samplers/pg-delta-sampler.sh "$CAMPAIGN_BENCHMARK_DATABASE_URL" results/exp/pg.csv &`
   `samplers/redis-sampler.sh "$REDIS_URL" results/exp/redis.csv &`
   `samplers/progress-sampler.sh "$CAMPAIGN_BENCHMARK_DATABASE_URL" results/exp/progress.csv &`
3. Start the cells within a few seconds of each other, cell 1 first:
   host A: `ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 1 results/exp/cell-1`
   host B: `ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 2 results/exp/cell-2`
   400K rows per cell gives ~100 s of sending per cell so the window in which both cells send exceeds 60 s
   (the harness needs at least 126K rows for its own 30 s sustained assertion). Each cell imports, sends,
   drains and asserts recovery on its own campaign only.
4. Copy every host's `results/exp/cell-*` next to `pg.csv`, `redis.csv`, `progress.csv` and run
   `./verify.sh 2 400000` (acceptance checks, exit status) and
   `python3 analyze.py results/exp --control results/control` (per-cell, aggregate, efficiency, shared costs).
5. Control: three single-cell reps on host A alone, same pinning and rows (`./cell.sh 1 results/control-<n>`
   after `./prepare.sh` each time); point `--control` at a directory holding their `cell-1` results.
6. Failover: with cell 2 running normally on host B, run `KILL_AFTER=20 ./failover.sh 1 results/failover-1` on
   host A (it runs cell 1, SIGKILLs it, starts a replacement with the same scope, waits until every job of the
   killed campaign is terminal, and prints the recovery timeline and accounting).

## Experiment B: one campaign across both cells (settlement-lock ceiling)

Independent campaigns (one per cell, above) never contend on a campaign row. To measure whether one campaign can
be settled at the aggregate transport rate, seed a single campaign whose routes cover every cell's phones and let
scoped cells send from it concurrently:

1. `./prepare.sh`, then from any host `./seed-shared-campaign.sh 2 800000 results/expB/seed.json` (the harness in
   `CAMPAIGN_BENCHMARK_SEED_ONLY=1` mode: imports the campaign with 8 phones and 8 routes, leaves every job Queued,
   writes the seed file naming campaign, phones and routes, and exits without a probe or workload).
2. Samplers on host D as in step 2 above, into `results/expB`.
3. host A: `SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./shared-cell.sh 1 results/expB/seed.json results/expB/shared-cell-1`;
   host B the same with `2`, within seconds. Each cell owns phones 4k-3..4k of the seeded campaign.
4. Collect, then `./verify-shared.sh 2 results/expB/seed.json` (exact accounting, Completed, consumer-group
   ownership) and `python3 analyze-shared.py results/expB`: per-cell and per-phone provider-start TPS over the
   window in which both cells send, aggregate, inter-start statistics and ceiling check, settlement transaction
   p50/p95/p99 and throughput (the `success_settlement` phase includes the campaign-row lock wait), slots,
   starvation, reclaims, supply, event loop, RSS, host CPU, and the PostgreSQL/Redis deltas over the same window.
5. Compare with Experiment A on the same hosts: if the shared campaign's aggregate plateaus while independent
   campaigns scale, and its settlement p95 and PostgreSQL lock waiters rise with it, the campaign-row settlement
   lock is the proven ceiling. Never mix the two experiments into one efficiency number.

## Metrics captured

Per cell (harness.json, host.jsonl): provider-start TPS over the steady window, per-phone TPS, inter-start
interval mean/p99 and rolling-second peak with the 1,000/s ceiling assertion, shard scheduler lateness,
main-thread event-loop p95/p99, settlement slot occupancy and refusals, lane starvation, broker reclaims,
settlement latency and throughput, supply rate and claim latency, sends and attempts, recovery assertions;
node/postgres/redis CPU on the host, main-thread and shard-thread utilization and run-queue wait, RSS.
Shared (pg.csv, redis.csv, progress.csv, deltas over the concurrent window): PostgreSQL WAL, commits, tuple
updates and inserts per second and per message, active backends, lock waiters, connections, mean statement
latency; Redis cores, ops per second and per message, clients; per-campaign sent/queued/processing/failed per
second on one clock, from which the concurrent aggregate TPS and scaling efficiency are computed.
Failover (replacement.jsonl, jobs.txt): ownership denial interval, takeover, first XAUTOCLAIM, first replacement
provider start, drain, and the job accounting (sent first attempt, requeued and sent, failed closed, lost).

## Acceptance criteria for a valid 2-cell result

- Isolation: `ownershipDenials` is 0 in every cell and `verify.sh` passes: every campaign sent exactly its rows
  (all on attempt 1 except its one recovery-probe job), nothing failed or open, every campaign Completed,
  route/phone/cell consistent, campaign_metrics exact, no pending stream entries, and the Redis consumer groups
  show each cell's four phone streams owned by exactly one runtime with no runtime in two cells. (The harness's
  final `phoneOwnership` snapshot is taken after its lanes drained and may be empty; do not use it.)
- Health: every cell reports `attemptedCeilingSatisfied`, no settlement refusals, starvation 0, reclaims 0,
  shard run-queue wait under 2 percent, main-thread utilization under 90 percent, host `postgres`/`redis` CPU
  on the transport hosts 0 (they run elsewhere).
- Window: the concurrent window (both campaigns above 500/s) is at least 60 s.
- Efficiency = concurrent aggregate / (2 x control mean). At or above 0.95: strong linear; 0.90-0.95:
  acceptable, classify the shared bottleneck from the PostgreSQL/Redis deltas; below 0.90: not linear, report
  which shared cost per message grew versus the control.
- Failover: takeover within ~6 s, first replacement provider start within ~1 s of takeover, 0 duplicates,
  0 lost, the other cell's rate and ownership unaffected during the outage.

## Known artifacts (fixed or documented)

- The harness's recovery probe used to claim the oldest claimable job in the whole database; with two cells that
  was the other cell's job and the run's final assertion failed or hung. It now claims from the run's own first
  phone.
- Organization slugs are host-qualified, so `failover.sh` finds the right campaign when pids collide across hosts.
- After a hard kill, `campaign_metrics` can drift (a lease reaper recounts from rows while settlement deltas are
  still pending; observed sent +692, processing +18 on one run) and the campaign row then never completes. Job
  rows are exact; the replacement runtime and the failover analysis use them and only report the campaign
  status. Separate accounting issue, not part of this kit.
- Same-host runs of several cells measure host saturation (0.72-0.85 efficiency on 4 vCPU) and must not be
  reported as scaling results.
