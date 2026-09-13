# Campaign transport: distributed baseline runbook (final infrastructure instruction)

This is the fixed procedure for the first real multi-host measurement of the campaign transport. It changes no
code. It runs the benchmark kit at commit `1329ab8` (`artifacts/api-server/benchmark/distributed/`, whose README
holds the kit's own procedure and acceptance rules) against production `src/` at `111e0fe`. Every command below is
one the kit already provides; nothing is added or patched on the hosts.

Status at the time of writing: the required hosts do not exist in the development environment (one 4-vCPU
container, outbound 5432 and 6379 blocked). Nothing below has been run. Same-host measurements are not a
substitute and must not be reported as any of the results below.

## Host naming

This runbook uses the names from the instruction; the kit README uses letters from its P22 diagram.

| This runbook | Role | Kit README |
|---|---|---|
| Host C | transport Cell 1, phones 1-4 | Host A |
| Host D | transport Cell 2, phones 5-8 | Host B |
| Host S | PostgreSQL 16 and Redis 7 together | Host C |
| Host M (optional) | samplers on one clock | Host D |

## Topology (required)

- Host C: transport Cell 1, 4 vCPU / 4 GB, phones 1-4, the four shard threads pinned to one CPU
  (`SHARD_CPUS=3 OTHER_CPUS=0,1,2`), nothing else running.
- Host D: transport Cell 2, 4 vCPU / 4 GB, phones 5-8, same pinning, nothing else running.
- Host S: PostgreSQL 16 and Redis 7 on dedicated CPU and memory. `max_connections >= 26 x 3 + 20 = 98`
  (two cells plus one replacement runtime plus samplers; `preflight.sh` computes and checks this),
  `shared_preload_libraries = 'pg_stat_statements'`, `synchronous_commit` as in production, Redis with
  `appendonly yes`. Do not split PostgreSQL and Redis onto separate hosts unless an infrastructure constraint
  forces it: the objective is transport CPU isolation with the shared-service cost measured consistently.
- Host M (optional): psql, redis-cli, python3; runs the three shared samplers so the concurrent aggregate is on one
  clock. Without M, run the samplers on Host S.
- Network: LAN, sub-millisecond RTT expected; the measured RTT is part of the result. NTP on every host, within
  50 ms.
- Environment on every host (identical):
  `CAMPAIGN_BENCHMARK_DATABASE_URL=postgresql://<user>@<host-s>/campaign_benchmark` (name must contain `bench`),
  `CAMPAIGN_BENCHMARK_CONFIRM=campaign_benchmark`, `REDIS_URL=redis://<host-s>:6379`, `COMMIT=1329ab8...`
  (the full 40-character SHA), and on each transport host `PEERS="<the other transport host> <host-s>"`.

## Pre-run checks (all ten, on both transport hosts, before every experiment)

Run from `artifacts/api-server/benchmark/distributed/` on Host C and on Host D:

```
git checkout <full sha of 1329ab8> && git status --porcelain      # 1, 2: exact commit, clean tree
COMMIT=<full sha> PEERS="<peer> <host-s>" ./preflight.sh          # 3-10 below
```

`preflight.sh` covers the checks as follows; it exits non-zero on any FAIL, and no experiment starts on a FAIL.

| Check | Where it is verified |
|---|---|
| 1. exactly `1329ab8` checked out | PASS/FAIL `commit` |
| 2. clean tree | PASS/FAIL `working tree clean`; the harness also asserts the `benchmark/`+`src/` hash at the end of every run |
| 3. preflight on both hosts | the script itself, once per host, output saved as `results/<exp>/preflight-<host>.txt` |
| 4. PostgreSQL reachable from both transport hosts | PASS/FAIL `PostgreSQL reachable` and `PostgreSQL on another host` |
| 5. Redis reachable from both | PASS/FAIL `Redis reachable` and `Redis on another host` |
| 6. LAN RTT and clock offsets | INFO `RTT to <host>` for S and the peer; INFO `clock` (chrony/ntpq) and `this host vs PostgreSQL clock` |
| 7. phone scopes Cell 1 = 1-4, Cell 2 = 5-8 | `cell.sh k` derives the scope from the index (4k-3..4k) and prints it in `events.log`; the harness prints it at start; INFO `phones present` after Cell 1 has inserted its rows |
| 8. shard CPU affinity | `pin.log` in the cell's results (thread ids and CPUs); re-run `preflight.sh` while the cell runs for INFO `affinity: 4 threads on cpus 3` |
| 9. no unrelated workload | PASS/FAIL `no process above 5% CPU`, `no postgres/redis-server on this host` |
| 10. exact source SHA and hardware identity | `harness.json` records `source.gitCommit`, `source` file hashes and `hardware.hostname`/CPU/memory; keep `preflight-<host>.txt` (cpus, mem, load) next to it |

Record also, once per experiment in `results/<exp>/notes.txt`: Host S CPU model and core count, PostgreSQL and Redis
versions (preflight prints both), `max_connections`, and whether Host M was used.

## Run order (fixed; nothing is changed between steps)

Every experiment starts with `./prepare.sh` from a host that reaches S (drops and recreates the database, pushes the
schema, flushes Redis). Never reuse a database across experiments. Never edit or commit anything on any host while a
run is measuring: the harness fails the run on a changed source profile.

Shared samplers (Host M, or S) for every experiment, into that experiment's results directory:

```
samplers/pg-delta-sampler.sh "$CAMPAIGN_BENCHMARK_DATABASE_URL" results/<exp>/pg.csv &
samplers/redis-sampler.sh    "$REDIS_URL"                        results/<exp>/redis.csv &
samplers/progress-sampler.sh "$CAMPAIGN_BENCHMARK_DATABASE_URL" results/<exp>/progress.csv &
```

### CONTROL 1: Cell 1 alone on Host C, remote PostgreSQL and Redis on S

```
./prepare.sh
Host C: ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 1 results/control/cell-1
```

### CONTROL 2: Cell 2 alone on Host D, same S

```
./prepare.sh
Host D: ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 1 results/control/cell-2
```

Kit constraint, stated rather than worked around: on a fresh database `cell.sh 2` waits for phones 1-4 to exist
before inserting 5-8, so an isolated run on Host D uses cell index 1 and phones 1-4. The control measures the host
and the shared services, not the phone ids; Host D owns phones 5-8 in Experiments A, B and the failover, where
Cell 1 runs first. The results directory name (`cell-2`) is what the analyzer reads, not the index.

### CONTROL 3: repeat one isolated cell on the same infrastructure

```
./prepare.sh
Host C: ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 1 results/control/cell-3
```

Control mean = mean `steadySuccessfulTps` of the three `results/control/cell-*/harness.json`; `analyze.py
--control results/control` prints it with the three values. Controls with local PostgreSQL or Redis must never be
mixed into this directory; the preflight fails on a local service address for exactly this reason.

### EXPERIMENT A: two independent campaigns, 400K each

```
./prepare.sh; samplers into results/expA
Host C: ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 1 results/expA/cell-1     # first
Host D: ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 2 results/expA/cell-2     # within seconds
```

Copy both `cell-*` directories next to the three sampler files, then:

```
./verify.sh 2 400000
python3 analyze.py results/expA --control results/control
```

Required: the window in which both campaigns send above 500/s is at least 60 s (400K rows gives about 100 s per
cell); `ownershipDenials` 0 in both cells; `verify.sh` passes every check. Outputs: aggregate provider-start TPS
over the concurrent window (from `progress.csv`, one clock), per-cell and per-phone TPS, efficiency =
aggregate / (2 x control mean), PostgreSQL and Redis deltas per message versus the control.

### EXPERIMENT B: one 800K campaign across both cells

```
./prepare.sh
./seed-shared-campaign.sh 2 800000 results/expB/seed.json      # from any host that reaches S
samplers into results/expB
Host C: SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./shared-cell.sh 1 results/expB/seed.json results/expB/shared-cell-1
Host D: SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./shared-cell.sh 2 results/expB/seed.json results/expB/shared-cell-2
```

Cell 1 owns phones 1-4 and Cell 2 phones 5-8 of the seeded campaign; both send concurrently. Then:

```
./verify-shared.sh 2 results/expB/seed.json
python3 analyze-shared.py results/expB --experiment-a results/expA
```

Outputs: aggregate and per-cell/per-phone provider-start TPS over the window in which both cells send, campaign
settlement throughput and `success_settlement` p50/p95/p99 (this phase includes the campaign-row lock wait),
PostgreSQL lock waiters from `pg.csv` over the same window, plus the same deltas as Experiment A.

### FAILOVER: hard kill of Cell 1 at +20 s, Cell 2 live, at least 3 clean runs

For each run n in 1..3 (more if any run is not clean):

```
./prepare.sh; samplers into results/failover-<n>
Host C: ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 KILL_AFTER=20 ./failover.sh 1 results/failover-<n>/cell-1   # first
Host D: ROWS=400000 SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 2 results/failover-<n>/cell-2                    # within seconds
```

`failover.sh` runs Cell 1, SIGKILLs the harness 20 s after its runtime starts, starts a replacement runtime with
the same scope (phones 1-4) on Host C, waits until every job of the killed campaign is terminal, and prints the
timeline and accounting (`summary.txt`, `jobs.txt`, `replacement.jsonl`). A run is clean when the replacement
drained and Cell 2 finished with `OK`. Verify per run: ownership takeover time, first replacement provider start,
drain time, duplicates (must be 0), lost jobs (must be 0), delivery-unknown count, and Cell 2's per-second rate
and ownership across the outage from `progress.csv` and its `harness.json` (`ownershipDenials` 0, no rate dip
attributable to the kill).

## Do not change between or during experiments

Pacing, scheduler, settlement, reservoir, workers, leases, Redis ownership, PostgreSQL behaviour or configuration,
provider rate logic, the kit, or the commit. If a run fails for an infrastructure reason, fix the infrastructure,
re-run the preflight, and repeat that experiment from `./prepare.sh`.

## Decision rule

Experiment A efficiency:
- at or above 95 percent: strong scaling;
- 90 to 95 percent: acceptable; identify the shared bottleneck from the PostgreSQL/Redis per-message deltas and
  statement latency versus the control;
- below 90 percent: diagnose before any code change.

Experiment B:
- tracks Experiment A: single-campaign scaling is healthy;
- Experiment A scales but B plateaus around the predicted 5 to 6K/s with rising campaign-row lock waiters and
  settlement latency: the campaign settlement serialization ceiling is proven. The lock is not redesigned until B
  proves it.

No 8K or 20K capacity claim is valid before these measurements exist.

## Final report contents

1. Raw results: every `harness.json`, `cell.json`, `host.jsonl`, `pin.log`, `preflight-<host>.txt`, `pg.csv`,
   `redis.csv`, `progress.csv`, failover `summary.txt`/`jobs.txt`/`replacement.jsonl`, `notes.txt`.
2. Control mean and the three control values.
3. Experiment A: aggregate TPS over the concurrent window, window length, efficiency, per-cell and per-phone TPS.
4. Experiment B: aggregate and per-cell/per-phone TPS, settlement throughput and p50/p95/p99, lock waiters.
5. PostgreSQL and Redis deltas per message (cores, WAL, commits, tuple updates, statement latency, ops) for the
   controls, A and B.
6. CPU and run-queue data per transport host (main thread, shard threads, node total) from `host.jsonl`.
7. Failover: per run, takeover, first replacement start, drain, duplicates, lost, delivery-unknown count, and
   Cell 2's rate during the outage.
8. The decision-rule classification for A and for B, and nothing beyond what those numbers support.

If the infrastructure is unavailable: STOP. Do not substitute same-host measurements.
