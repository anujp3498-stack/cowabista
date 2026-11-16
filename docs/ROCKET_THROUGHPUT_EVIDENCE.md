# Rocket sending path: crash ambiguity, throughput and recovery evidence (P0/P1)

Status: evidence for the P0/P1 work on `feature/rocket-crash-ambiguity` (not merged, not deployed). Every number here
comes from this repository's own benchmarks on one 4-vCPU development host with a local PostgreSQL 16 and Redis 7, the
fake Graph server (no Meta call) and disposable databases. Production may differ: there the cells, PostgreSQL and Redis
do not share four cores.

<!-- RESULTS -->

## 3. The "about 500 TPS" sending-path bottleneck

The B13 in-process benchmark (no HTTP) reports far more than the HTTP path can send, so the HTTP path was measured
directly: kill-benchmark control runs (one cell, 4 phones × 1,000 approved TPS, real `CampaignRuntime`, real HTTP from
the transport shards to the fake Graph server, per-job timings, 1 s resource samples, `pg_stat_statements`).

| Run (code) | Jobs | Sustained accepted /s (p10) | Per phone /s | Prepare 256-job batch p50 / p95 ms | Host CPU busy mean / p95 | Cell / PostgreSQL cores |
|---|---|---|---|---|---|---|
| plan-less jobs (8be3e5c) | 40,000 | 528 (0) | 132 | 1,764 / 2,046 | 0.73 / 0.83 | 1.28 / 1.31 |
| plan-less jobs (560ba28) | 40,000 | 2,216 (1,828) | 528–568 | 225 / 380 | 0.83 / 0.97 | 2.11 / 0.58 |
| plan-backed, two campaigns (8be3e5c) | 40,000 | 2,410 (2,028) | 589–611 | 178 / 323 | 0.79 / 0.97 | 2.01 / 0.53 |
| plan-backed, one campaign (560ba28) | 120,000 | 2,604 (2,412) | 645–657 | 190 / 295 | 0.91 / 0.96 | 2.30 / 0.67 |

**First bottleneck: plan-less jobs (the ~500/s).** `resolveJobTemplates` was set-based only for a batch of one
plan-backed campaign. Jobs without a plan (created before Plan→Execute) and claim batches spanning campaigns fell back
to `resolveJobTemplate` per job, four or five round trips each, about 1,280 queries per 256-job batch: 6.9 ms per job,
PostgreSQL at 1.3 cores, and sending stalled between batches (p10 0/s). The two heaviest statements were the per-job
payload update (40,000 calls) and the per-job live-context read (40,000 calls). Fixed in 560ba28 (`resolveLegacyBatch`,
the same checks, order, error texts and lease-fenced write, with set-based reads; `test:template-resolution-batch`
proves equal outcomes against the single-job resolver): 528/s → 2,216/s.

**Second limit: the per-phone pacer loses its 1 ms cadence when its thread wakes late.** With supply fixed, a phone
approved for 1,000 TPS sends less, and less as the host gets busier (control runs, 40,000 jobs per phone):

| Phones | Per phone /s | Host CPU busy | Shard wake delay per start (mean) | Claim → prepared cycle p50 | Refill could supply /s per phone |
|---|---|---|---|---|---|
| 1 (c979cd8) | 919 | – | – | 74 ms (preparation p50) | – |
| 1 (98a3150) | 921 | 0.59 | 0.34 ms | 76 ms | ~3,370 |
| 2 (98a3150) | 799 | 0.81 | 0.65 ms | 113 ms | ~2,265 |
| 4 (560ba28) | 645–657 | 0.91 | 0.99 ms | 328 ms | ~780 |

- Supply is not the limit: every claim is 256 jobs and one 256-job claim-and-prepare cycle per lane could feed far
  more than the phone sends (with 1–2 phones), and each send waits about 1.6 s in its shard after admission (p50), so
  the shard always has work queued. The same holds before and after P1 (919/s at c979cd8, 921/s now, both with the
  same 1.3 s pacing lateness), so P1 does not cause it.
- At 1,000 TPS a phone's slot interval is 1 ms. Each phone's transport shard thread both paces and performs its HTTP
  calls (about 0.6 core at 921/s). The pacer keeps ordinary wake latency on its grid, but by design never replays
  missed slots in a burst (the rolling-second ceiling must hold), so a thread that wakes late loses slots. The mean
  wake delay per start (startedAt − due, `shardEventLoopDelayMs` / starts) grows with host load, 0.34 → 0.65 →
  0.99 ms, and the per-phone rate falls with it, 92 % → 80 % → 65 % of the approved TPS. The pacer's own notes record
  the same effect (a 10–12 % per-phone cadence loss at 1,000 TPS on a saturated 4-core host).
- With four phones the claim-and-prepare cycle also stretches (CPU contention), to the point where it is close to
  binding (~780/s possible against ~650/s sent).

**Where the CPU goes (threads-1, 2,604/s).** Host 91 % busy (96 % p95). The cell used 2.3 cores: its event loop 0.56
core, the four busy transport shards 0.33–0.38 core each (HTTP client, about 0.55 ms CPU per request), four helper
threads (GC, platform) about 0.1 core each. PostgreSQL 0.67 core, the fake Graph server 0.27, Redis 0.10. No thread is
saturated, so there is no single serial CPU bottleneck; the host's four cores are shared by everything, which inflates
the claim and prepare latencies that set the per-phone cycle above. A sampling CPU profile attributed about 5 s per
shard to `waitUntil`; that function blocks in `Atomics.wait` (a futex, no CPU), and per-thread `/proc` accounting
confirms the shards use about a third of a core each, so that time is waiting, not spinning.

**PostgreSQL.** No lock or I/O wait to speak of (lock waiters p95 1, LWLock p95 1; 2–3 active backends). The heaviest
statement is the metric-delta fold (`campaign_metric_deltas`, about 16–28 ms mean, 200–460 calls per run), then the
set-based claim and preparation statements (11–15 ms each per 256-job batch).

**Redis.** About 15,000 ops/s mean (19,000 max), 0.1 core, 8 MB: not a bottleneck.

**What would lift the per-phone limit** (not implemented: each changes pacing or the supply pipeline, runtime
semantics that need the owner's approval, and new Gate B evidence):
- let the pacer start more than one request per wake when it is behind while still enforcing the rolling-second
  ceiling, or move HTTP completion work off the pacing thread, so a late wake does not cost slots;
- give the cells their own cores in production (here a cell shares four with PostgreSQL, Redis and the fake provider);
- pipeline a lane's refills (a second claim while the first prepares) for many phones per cell, and move the
  metric-delta fold off the claim path's PostgreSQL time.

## 4. Lease reaper under backlog (Test G)

Production contract (`CampaignRuntime`): `startCampaignRuntime()` calls `start()` with its default 100 ms tick, so the
housekeeping timer fires every min(100, `HOUSEKEEPING_INTERVAL_MS` = 200) = 100 ms and is skipped while a pass still
runs. A pass flushes metrics, then reaps expired leases oldest expiry first in batches of `REAP_BATCH_LIMIT` = 100 until
a short batch or `REAP_PASS_BUDGET_MS` = 250 ms (always at least one batch), then renews leases and activates due
campaigns. So a lease with N expired leases ordered before it is reaped by pass floor(N / 100) + 1.

`benchmark/reaper` runs that real housekeeping (and the separate metrics-flush timer) on the production timer, in one or
two runtimes, against a separate disposable database, and samples every 50 ms. Results on this host:

| Scenario | Expired leases | All reaped in | Rate /s | Passes p50 / p95 / max ms | Expiry-order violations | First campaign done / newest lease reaped |
|---|---|---|---|---|---|---|
| clean database | 1 | 0.12 s | – | 25 / 25 / 25 | 0 | – / 0.12 s |
| 20 campaigns × 500 | 10,001 | 18.4 s | 545 | 308 / 343 / 395 | 0 | 1.1 s / 18.4 s |
| same, plus 50,000 settled jobs per campaign | 10,001 | 22.9 s | 437 | 400 / 446 / 739 | 0 | 1.3 s / 22.9 s |
| same as row 2, two cells reaping | 10,001 | 15.2 s | 658 | 308 / 349 / 371 | 0 | 1.1 s / 15.2 s |
| a dead cell's leases, 4 campaigns × 6,000 | 24,001 | 49.6 s | 484 | 343 / 430 / 537 | 0 | 12.8 s / 49.6 s |

Every reaped job ended `Queued` (none lost, none failed).

- **Starvation:** none. Every pass reaps at least one batch, oldest first, so a newly expired lease waits only behind
  the older backlog (backlog / ~500 per s on this host), never indefinitely. The 250 ms budget bounds a pass (p95
  343–446 ms, max 739 ms, lease renewal included), not the reap rate: the rate is set by one or two round trips per row
  (about 1.5–2 ms) plus one campaign recount per affected campaign per batch (rows 2 and 3: the recount over 50,000
  settled jobs cost about 20 %).
- **Fairness across campaigns:** strictly by expiry (0 order violations), not round-robin: the campaign whose leases
  expired first is recovered first.
- **Two cells** add only about 20 %: both read the same oldest rows and the fence lets one win.
- **Recovery time** after a dead cell is therefore about its expired leases / ~500 per s on this host (24,000 leases:
  about 50 s). Faster recovery would need a set-based reaper (one fenced update per batch) or `SKIP LOCKED` between
  cells; not changed here.

**Tests.** The suites that asserted recovery after ONE reaper pass (and failure-settlement G's fixed 40 passes) now use
`test/reaper-housekeeping.ts`: it counts the expired leases actually ordered before the job, with the reaper's own
predicate and order, runs passes on the 100 ms cadence, and the test asserts the job was reached within
floor(N / 100) + 2 passes (2 on a clean database). G2 seeds 350 older expired leases and asserts FIFO and the bound.
This fixed CI 43863340429 (validate-prepared-batch M, reproduced locally with 400 seeded leases: the old test fails,
the new one passes).
