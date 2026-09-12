# Distributed transport benchmark kit

Runs the corrected campaign benchmark as N independent transport cells (one runtime process, 4 phones, explicit phone
scope each) against one shared PostgreSQL and one shared Redis, and measures true horizontal scaling efficiency,
shared-resource cost per message, and hard-kill failover recovery. Nothing here is production code.

## Topology

```
Host A (4 vCPU)             Host B (4 vCPU)             Host C ... (one per cell)
  cell 1: phones 1-4          cell 2: phones 5-8
  shard threads on 1 CPU      shard threads on 1 CPU
  main thread + V8 on rest    main thread + V8 on rest
            \                       /
             shared PostgreSQL (own CPU domain, >= 2 vCPU per 8K TPS)  +  shared Redis (1 vCPU)
```

Measured on one 4-vCPU host with the four shard threads pinned to a CPU of their own, one cell reaches ~3.9K
provider-start TPS. A cell needs about 1.4 cores (main thread ~0.85, four shard threads ~0.3, V8 helpers ~0.2);
PostgreSQL needs 0.11-0.15 cores per 1K TPS; Redis about 0.02 cores per 1K TPS. Do not co-locate two cells with
PostgreSQL on a 4-vCPU host: the result measures host saturation, not the architecture.

## Prerequisites (each transport host)

- Node 22, pnpm, this repository installed (`pnpm install`), Python 3.
- `psql` and `redis-cli` reachable to the shared services.
- Permission to set CPU affinity for the runtime's threads (root or CAP_SYS_NICE), if pinning is used.
- Environment on every host:
  `CAMPAIGN_BENCHMARK_DATABASE_URL=postgresql://user@db-host/campaign_benchmark` (name must contain `bench`),
  `CAMPAIGN_BENCHMARK_CONFIRM=campaign_benchmark`, `REDIS_URL=redis://redis-host:6379`.

## Procedure

1. Prepare once, from any host: `./prepare.sh` (drops and recreates the database, pushes the schema, flushes Redis).
2. Start the shared samplers from any host that reaches the services (they only read cumulative counters):
   `samplers/pg-delta-sampler.sh "$CAMPAIGN_BENCHMARK_DATABASE_URL" results/exp/pg.csv &`
   `samplers/redis-sampler.sh "$REDIS_URL" results/exp/redis.csv &`
   `samplers/progress-sampler.sh "$CAMPAIGN_BENCHMARK_DATABASE_URL" results/exp/progress.csv &`
3. Start the cells, one per host, within a few seconds of each other:
   host A: `SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 1 results/exp/cell-1`
   host B: `SHARD_CPUS=3 OTHER_CPUS=0,1,2 ./cell.sh 2 results/exp/cell-2`
   Cell k owns phones 4k-3..4k and waits until the previous cells' phone rows exist, so ids are deterministic without
   any other coordination. Each cell imports 200K rows, sustains 30 s, drains fully and asserts recovery.
4. Copy every host's `results/exp/cell-*` directory to one place next to `pg.csv`, `redis.csv`, `progress.csv`.
5. Control: run `./cell.sh 1 results/control-<n>` alone three times on a transport host (same pinning), then
   `python3 analyze.py results/exp --control results/control-1` (point `--control` at a directory holding the
   `cell-1` results of all control reps, or run it per rep and average).

Efficiency = concurrent aggregate TPS (from `progress.csv`, the window in which every campaign is sending) divided
by N times the control's single-cell TPS. Do not sum per-cell steady figures from different windows.

## Failover

On one cell's host while the others run normally: `KILL_AFTER=20 ./failover.sh 1 results/failover-1`.
It SIGKILLs the cell 20 s after its runtime starts, immediately starts a replacement runtime with the same scope,
waits for the killed campaign to drain, and prints: ownership denial interval, ownership takeover time,
first XAUTOCLAIM, first replacement provider start, drain time, and the job accounting (sent, requeued and sent,
failed closed as delivery-unknown, lost). Expected with the current 5 s ownership TTL and 30 s job lease: takeover
about 5 s, provider resume about 20-25 s, zero duplicates, zero lost, and one in-flight window (at most 4,096
envelopes) failed closed as "Provider delivery is unknown after broker consumer loss".

## Output

`analyze.py` prints per cell: provider-start and steady TPS, per-phone TPS, ownership and denials, inter-start
interval mean/p99 and rolling-second peak with the ceiling assertion, shard scheduler lateness, main-thread event
loop p95/p99, slot occupancy and refusals, lane starvation, broker reclaims, settlement latency and throughput,
supply rate, and recovery assertions; per host: node/postgres/redis cores, main-thread and shard-thread
utilization and run-queue wait, scheduler stall per message; shared: PostgreSQL WAL, commits, tuple updates and
inserts per second and per message, active backends, lock waiters, connections, mean statement latency; Redis
cores, ops per second and per message. Everything is delta-based over the concurrent window.
