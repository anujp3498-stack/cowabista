# Rocket sending path: crash ambiguity, throughput and recovery evidence (P0/P1)

Status: evidence for the P0/P1 work on `feature/rocket-crash-ambiguity` (not merged, not deployed). Every number here
comes from this repository's own benchmarks on one 4-vCPU development host with a local PostgreSQL 16 and Redis 7, the
fake Graph server (no Meta call) and disposable databases. Production may differ: there the cells, PostgreSQL and Redis
do not share four cores.

## 1. Before and after (decision 4)

**Code.** Before is `c979cd8`, the commit this branch starts from (`measuredFilesSha256` `d352906f…`). After is
`04f21c4ee1f0` (`1ce169b0…`). Every result records its commit and hash, and each table row shows both. Every run
used a clean checkout of exactly that commit.

**What was measured.**

- **Kill benchmark** (`artifacts/api-server/benchmark/kill`, a separate non-measured kit). Each cell is its own OS
  process running the production campaign runtime and the production sender (`WhatsAppTemplateSender`: durable provider
  intents, outcome flush). Cells send over HTTP to a fake Graph server (`fake-graph.mjs`), which answers like Graph and
  logs every request it receives. That log is the ground truth for duplicates and for what reached the provider.
  PostgreSQL 16 and Redis 7 are real and local. Four phones unless noted, at 1,000, 500 or 80 TPS per phone.
  - "Accepted" means the fake provider answered with a message id.
  - "Sustained" is the mean (and p10) of the per-second accepted count over the steady window: after the per-phone
    warm-up plateau, before the tail.
  - Crash runs SIGKILL one cell mid-run. In *static* mode one cell owns every phone and a replacement process starts.
    In *auto* mode there are two cells, and the survivor takes over the dead cell's phones after its 5 s lease.
- **B13 harness** (`artifacts/api-server/benchmark/campaign-benchmark.ts`, Gate B): one in-process cell.
  - *Control* uses the benchmark sender: no preparation and no intents.
  - *Production path* uses the production sender with a mock provider client in the shard, and no HTTP.
  - These numbers are **not** proof of real sending capacity: there is no HTTP, no network and no provider latency.

**Host.** One 4-vCPU development VM (Xeon, 2.1 GHz) with 16 GB RAM. The cells, PostgreSQL, Redis and the fake
provider all share those four cores. At 4 × 1,000 TPS the host is CPU-bound (83–89 % busy on average), so the
sustained rate there is a host limit, not a pacing limit. Production cells, PostgreSQL and Redis run on separate hosts.

**Code labels.** The before kill runs used `c979cd8`'s measured code with the kill kit committed on top (`6e81913`, the
same `measuredFilesSha256` `d352906f…`). The tables label them `c979cd8`.

### 1.1 Throughput, latency and pacing (no kill)

| Target (4 phones unless noted) | Code | Sustained accepted /s mean (p10) | Per phone /s | Peak per phone in any 1 s after warm-up (limit) | Rate-cap check | Preparation p95 / p99 ms | Scheduling (admission to accepted) p95 / p99 ms | Provider HTTP p95 / p99 ms | Pacing lateness p95 ms | Duplicates |
|---|---|---|---|---|---|---|---|---|---|---|
| 4 × 1,000 TPS | c979cd8 / d352906f | 2,506 (2,231) | 621–635 | 804 (1000) | pass | 497 / 610 | 1,372 / 1,562 | 72.86 / 85.43 | 1,295 | 0 |
| 4 × 1,000 TPS | 04f21c4 / 1ce169b0 | 2,816 (2,516) | 666–723 | 993 (1000) | pass | 394 / 514 | 1,429 / 1,485 | 67.67 / 77.38 | 1,602 | 0 |
| 1 × 1,000 TPS | c979cd8 / d352906f | 934 (910) | 934 | 976 (1000) | pass | 99 / 110 | 1,766 / 1,791 | 57.11 / 62.02 | 1,334 | 0 |
| 1 × 1,000 TPS | 04f21c4 / 1ce169b0 | 950 (915) | 950 | 992 (1000) | pass | 97 / 114 | 1,735 / 1,776 | 56.28 / 60.5 | 1,320 | 0 |
| 4 × 500 TPS | c979cd8 / d352906f | 1,839 (1,726) | 459–461 | 500 (500) | pass | 301 / 459 | 1,926 / 2,065 | 65.01 / 75.43 | 1,491 | 0 |
| 4 × 500 TPS | 04f21c4 / 1ce169b0 | 1,881 (1,794) | 467–473 | 502 (500) | FAIL | 307 / 435 | 1,871 / 1,935 | 62.84 / 70.83 | 1,358 | 0 |
| 4 × 500 TPS (repeat) | 04f21c4 / 1ce169b0 | 1,882 (1,772) | 470–472 | 502 (500) | FAIL | 297 / 375 | 1,878 / 1,924 | 63.46 / 71.78 | 1,363 | 0 |
| 4 × 80 TPS | c979cd8 / d352906f | 319 (318) | 80–80 | 81 (80) | pass | 182 / 250 | 748 / 759 | 53.79 / 57.32 | 197 | 0 |
| 4 × 80 TPS | 04f21c4 / 1ce169b0 | 319 (318) | 80–80 | 81 (80) | pass | 202 / 230 | 723 / 731 | 53.4 / 56.47 | 173 | 0 |
| 4 × 80 TPS (repeat) | 04f21c4 / 1ce169b0 | 319 (318) | 80–80 | 81 (80) | pass | 197 / 239 | 722 / 734 | 53.24 / 56.51 | 172 | 0 |

- **Rates.**
  - 4 × 1,000 TPS: after sends 2,816/s sustained (p10 2,516), 12 % more than before (2,506/s), or 666–723/s per
    phone.
  - 1 × 1,000 TPS: one phone alone sends 950/s, 95 % of its approved rate (before 934/s).
  - 4 × 500 TPS: 1,881/s, about 470/s per phone, 94 % of the target (before 1,839/s).
  - 4 × 80 TPS: exactly on target, 80/s per phone, before and after.
- **Latency.**
  - Preparation p95 fell from 497 to 394 ms at 4 × 1,000.
  - Provider HTTP latency (the fake Graph server) is unchanged: p99 56–86 ms.
- **Pacing lateness** is how far a send started after its paced slot.
  - At 80 TPS it is under 0.2 s (172 ms p95; before, 197 ms).
  - At 500 and 1,000 TPS per phone it is 1.3–1.6 s, before and after. Those runs send below their target rate on this
    host, so jobs fall further behind their slots as the run goes on. The number therefore grows with the run's
    length; it does not measure pacing quality.
  - The higher value after at 4 × 1,000 (1,602 against 1,295 ms) comes with 12 % more throughput. Lanes now keep the
    transport shards fuller, so each message waits longer in a shard that cannot keep its 1 ms cadence (section 3).
- **Duplicates:** 0 in every run.

### 1.2 Resources (1 s samples)

| Run | Code | Host CPU busy mean / p95 | Cell cores mean / p95 | PostgreSQL cores mean | Redis cores mean | RSS MB cell / PostgreSQL / Redis | PostgreSQL commits/s mean / p95 | PostgreSQL lock waiters max | Redis ops/s mean / p95 |
|---|---|---|---|---|---|---|---|---|---|
| 4 × 1,000 control | c979cd8 / d352906f | 0.886 / 0.948 | 2.217 / 2.64 | 0.646 | 0.097 | 901 / 2589 / 31 | 265 / 356 | 1 | 14,678 / 18,693 |
| 4 × 1,000 control | 04f21c4 / 1ce169b0 | 0.834 / 0.931 | 2.09 / 2.617 | 0.65 | 0.092 | 951 / 2637 / 32 | 361 / 488 | 1 | 16,180 / 19,610 |
| 1 × 1,000 | c979cd8 / d352906f | 0.55 / 0.671 | 1.173 / 1.53 | 0.513 | 0.071 | 573 / 1208 / 24 | 403 / 535 | 1 | 6,045 / 6,872 |
| 1 × 1,000 | 04f21c4 / 1ce169b0 | 0.54 / 0.682 | 1.168 / 1.55 | 0.491 | 0.067 | 585 / 1243 / 25 | 435 / 552 | 1 | 6,392 / 7,060 |
| 4 × 500 | c979cd8 / d352906f | 0.782 / 0.905 | 1.865 / 2.443 | 0.654 | 0.097 | 909 / 1905 / 30 | 397 / 529 | 1 | 11,959 / 13,847 |
| 4 × 500 | 04f21c4 / 1ce169b0 | 0.752 / 0.894 | 1.836 / 2.368 | 0.607 | 0.094 | 911 / 2172 / 31 | 462 / 626 | 1 | 12,229 / 14,296 |
| 4 × 80 | c979cd8 / d352906f | 0.406 / 0.479 | 0.838 / 1.11 | 0.353 | 0.057 | 595 / 1068 / 23 | 317 / 416 | 1 | 3,464 / 3,992 |
| 4 × 80 | 04f21c4 / 1ce169b0 | 0.381 / 0.511 | 0.8 / 1.129 | 0.374 | 0.048 | 599 / 1232 / 24 | 386 / 602 | 0 | 3,468 / 4,552 |

- **CPU is the bottleneck on this host** with four phones at 500 and 1,000 TPS. The host is 75–83 % busy on average
  and 89–93 % at p95. The cell takes about 2 cores, PostgreSQL about 0.6 and Redis 0.1. Section 3 explains why a
  busy host costs the per-phone pacer its slots.
- **PostgreSQL** shows no lock contention: at most one waiter in any sample. Commits rose from 265/s to 361/s at
  4 × 1,000. That comes with 12 % more sends and smaller claim batches: a claim is now sized by the free outcome
  capacity net of claims in flight (1.6, item 2). Its RSS of about 2.6 GB is mostly shared buffers and the page cache of
  the benchmark database.
- **Redis** is not a bottleneck: 16,000 ops/s mean (19,600 p95), 0.1 core, 32 MB.
- **The cell** uses about 950 MB RSS at 4 × 1,000 TPS.

### 1.3 Against the 80, 500 and 1,000 TPS targets (this host)

| Approved TPS per phone | After (`04f21c4`), HTTP path | Verdict on this host |
|---|---|---|
| 80 | 80/s per phone (4 phones, 319/s). At most 81 arrivals in any second after warm-up. Lateness p95 172 ms. | met |
| 500 | 467–473/s per phone (4 phones, 1,881/s) | 94 %, not met; CPU-bound |
| 1,000 | one phone alone 950/s (95 %; the pacing thread's wake latency, section 3); four phones 666–723/s each (2,816/s) | not met; four phones are CPU-bound (section 3) |

This is one 4-vCPU VM shared by the cells, PostgreSQL, Redis and the fake provider. Production runs them on separate
hosts. Before 500 or 1,000 TPS per phone can be claimed, it must be measured on production-like hardware (the fake
Graph server only). The B13 in-process numbers below are not that evidence.

### 1.4 Rate-cap check

The kit counts the fake Graph server's arrivals per phone in every rolling second after each sender's first 2 s. It
allows one request of arrival jitter (limit + 1).

| Target | After | Check |
|---|---|---|
| 1,000 TPS | 993 (4 phones) and 992 (1 phone) | pass |
| 80 TPS | 81 | pass |
| 500 TPS | 502 in both after runs; also 502 at `74c5732`, and 500 in the single `c979cd8` run | fails by one request |

- **The pacer is unchanged.** This branch does not change the shard pacer (`campaign-shard-pacing.ts`). It never
  starts more than floor(1000 / interval) requests in any rolling 1,001 ms on its own clock (`test:shard-pacing`).
- **The extra arrivals come from timing after the start.** The HTTP client, the loopback interface and the fake
  server's event loop all sit between the start and the fake server's timestamp. On a host about 75 % busy, they can
  bunch two requests that started 2 ms apart.
- **The provider counts arrivals.** Whether one or two requests over in a single second ever draws a rate-limit error
  is not known.
- **A margin would remove the risk.** For example, pacing at about 99 % of the approved rate, or a slightly longer
  guard window. Either changes pacing, so it needs the owner's approval.

### 1.5 B13 (Gate B, in-process)

**Production path** (in-process, production sender, mock provider client; 200,000 jobs, 4 phones × 1,000 TPS)

| Run | Code / hash | Status | Steady provider starts /s | Sends | Jobs claimed (supply) | Claimed and returned unsent | Claim calls | DB commits | Benchmark process CPU user s | Peak RSS MB |
|---|---|---|---|---|---|---|---|---|---|---|
| before (c979cd8) | c979cd8 / d352906f | ok | 3,444 | 200,000 | 200,001 | 1 | 794 | 24,239 | 82 | 890 |
| before (c979cd8), 6 reruns | c979cd8 / d352906f | no result: 5 ended with the pre-existing harness crash (1.6, item 3), 1 stopped in `prepare.sh` (database reset race) | | | | | | | | |
| 490c76c (before the re-claim fix) | 490c76c / 217cf402 | ok | 2,865 | 200,000 | 325,321 | 125,321 | 2,808 | 73,491 | 103 | 750 |
| after, rep 1 | 04f21c4 / 1ce169b0 | ok | 3,568 | 200,000 | 200,001 | 1 | 1,334 | 39,251 | 79 | 780 |
| after, rep 2 | 04f21c4 / 1ce169b0 | ok | 3,534 | 200,000 | 200,001 | 1 | 1,359 | 39,960 | 78 | 853 |

**Control** (benchmark sender; 400,000 jobs, 4 phones × 1,000 TPS)

| Run | Identity | provider-start TPS / steady | verify |
|---|---|---|---|
| before (c979cd8) | c979cd8 / d352906f | 3792 / 3792 | exit 0 |
| 490c76c | 490c76c / 217cf402 | 3798 / 3797 | exit 0 |
| after | 04f21c4 / 1ce169b0 | 3834 / 3834 | exit 0 |

- **These numbers do not prove real sending capacity.** B13 runs one cell in-process with no HTTP; the production path
  uses a mock provider client in the shard.
- **Control (benchmark sender):** unchanged.
- **Production path (the production sender):**
  - `490c76c` lost 17 % to the re-claim churn (1.6, item 2): 125,321 jobs were claimed and returned unsent.
  - After the fix, two runs of the final code send 3,534 and 3,568/s, 3 % more than `c979cd8`'s 3,444/s. They use less
    CPU (78–79 s against 82 s user) and return no claimed job (the single returned job in every run is the harness's
    own interrupted lease).
  - Database commits are higher than before (39,000–40,000 against 24,239), because claims are smaller: they are sized
    by the free outcome capacity.
- **Some `c979cd8` reruns have no result.** The pre-existing harness crash (1.6, item 3) or a database-reset race in
  the benchmark's `prepare.sh` stopped them.

### 1.6 Defects these benchmarks found (all fixed on this branch)

1. **Claim order** (`7a96b56`). `claimBatch` re-read the claimed rows without `ORDER BY`, so a batch was published to
   the phone's stream in physical row order (rotated by updates), not in slot order. Since P1 reads the stream only a
   short window ahead, an early-slot job published behind later ones was sent up to 1.5 s late, and strict pacing
   never let it catch up. At 4 × 80 TPS the p95 pacing lateness was about 1 s. With the batch ordered by
   `scheduled_send_at, id` there are no inversions, and lateness is back under 0.2 s.
2. **Re-claim churn on the production sending path** (`04f21c4`). Each refill sizes its claim by the sender's free
   durable-outcome capacity (4,096 per process, shared by every lane). The sender reserves that capacity only when the
   batch is prepared, so lanes refilling at the same moment each saw the full headroom and together claimed several
   times it. Every batch past the first was then refused whole at preparation and returned unsent, to be claimed
   again.
   - It was latent before this branch. Once P1 kept every lane supplied, the shared capacity sat near full and the
     race fired on most claims.
   - Effect on the B13 production path at `490c76c` (scratch instrumentation, not committed): 116,149 of 316,149
     claimed jobs were refused, in 873 batches. Sends fell from 3,444/s to 2,865/s, with 73,491 database commits
     against 24,239.
   - Fix: the reservoir counts the slots of refills already claiming or preparing against the headroom.
   - The HTTP-path kill runs never showed it (claimed equalled prepared in every run): there the provider's latency
     keeps lanes below the shared capacity.
3. **Lane metrics carried a Node timer** (`490c76c`). The B13 harness serializes live lane metrics at the end of the
   sustained interval. When a drain timer was armed at that moment, serialization threw "Converting circular
   structure to JSON", and the run ended with no result. This is pre-existing: the same field exists at `c979cd8`,
   whose B13 runs fail this way intermittently. That is why most "before" B13 reruns in 1.5 have no result.

## 2. Crash: delivery-unknown, duplicates and failover (SIGKILL one cell at 4 × 1,000 TPS)

| Run | Mode | Code | Checks | Duplicates | Delivery-unknown (never reached the provider) | Path A / B | Admitted to transport, unsent, at the kill | Held by the victim | Successor's first send (max over phones) ms | Back to 95 % of pre-kill rate ms | Sustained /s mean |
|---|---|---|---|---|---|---|---|---|---|---|---|
| before 1 | static | c979cd8 / d352906f | all pass | 0 | 984 (882) | 984 / 0 | 780 | 2,055 | 5,723 | 22,292 | 2,132 |
| before 2 | static | c979cd8 / d352906f | all pass | 0 | 1,603 (1,463) | 1,592 / 11 | 2,013 | 2,174 | 5,274 | – | – |
| before 3 | static | c979cd8 / d352906f | all pass | 0 | 2,298 (2,161) | 2,298 / 0 | 2,648 | 2,959 | 5,631 | 14,326 | – |
| before 4 | static | c979cd8 / d352906f | all pass | 0 | 2,402 (2,185) | 2,402 / 0 | 1,924 | 3,145 | 5,416 | 20,348 | 2,252 |
| after 1 | static | 04f21c4 / 1ce169b0 | all pass | 0 | 1,904 (1,757) | 1,648 / 256 | 1,737 | 2,761 | 5,710 | 14,327 | 2,318 |
| after 2 | static | 04f21c4 / 1ce169b0 | all pass | 0 | 2,737 (2,513) | 2,439 / 298 | 2,567 | 3,486 | 5,524 | 14,292 | 2,513 |
| before 1 | auto | c979cd8 / d352906f | all pass | 0 | 3,022 (2,966) | 1,069 / 1,953 | 2,999 | 3,383 | 5,929 | 10,993 | 1,517 |
| before 2 | auto | c979cd8 / d352906f | all pass | 0 | 3,118 (3,048) | 1,423 / 1,695 | 2,895 | 3,233 | 5,667 | 17,945 | 1,837 |
| after 1 | auto | 04f21c4 / 1ce169b0 | all pass | 0 | 3,093 (3,018) | 1,253 / 1,840 | 2,905 | 3,447 | 6,224 | 15,928 | 1,782 |

- **No duplicate, and every check passes** in every run. That means no phantom send, every job settled, no unknown
  outside a crash, and no cell exit other than the kill. The fake provider's request log is the ground truth.
- **Delivery-unknown per crash is not lower after this branch.**
  - Static mode: 1,904 and 2,737 after, 984–2,402 before.
  - Automatic mode: 3,093 after, 3,022 and 3,118 before.
  - 92–98 % of it never reached the provider, so in principle it is avoidable.
- **It tracks the work already admitted to the transport shards** and waiting for its paced slot at the kill (the
  "Admitted to transport" column, sampled each second), plus the requests in flight.
  - P1 shortened the stream read-ahead, but that work is past it.
  - On this CPU-bound host the shard pacer runs behind its schedule (section 3), so that queue holds 0.8–2.6 thousand
    messages (up to 3.0 thousand in automatic mode).
  - Paths A and B are the two ways the same dead-cell work gets settled (`docs/DELIVERY_UNKNOWN_REDUCTION_PLAN.md`
    1.1). Which one applies depends on timing.
- **The rest of the victim's work ended Sent.** The victim held 2,761 and 3,486 jobs. The rest (857 and 749) ended
  Sent. Most of it (585 and 576) was unread or not-started work that was settled never started, requeued and sent
  once.
- **Only P2 can shrink the unknown.** P2 is a durable "started" record before the provider call; only it can tell the
  never-started part of the admitted work apart. It changes the send path, so it needs the owner's approval.
- **The P0 gate passes, but not because of P1.** The gate is ≤ TPS × (0.75 s + L) per phone per crash, with
  TPS = 1,000 and L = provider p99 ≈ 0.08 s, so 830 per phone. After: 476 and 684 per phone (static), 773 (automatic).
  The `c979cd8` runs were within it too (246–600 static, 756–780 automatic), because this host cannot reach 1,000 TPS
  per phone.
- **Failover.**
  - The successor's first send came 5.5–6.2 s after the kill, set by the 5 s ownership lease. Before: 5.3–5.9 s.
  - The rate was back to 95 % of the pre-kill rate after 14.3 s (static) and 15.9 s (automatic). Before: 11.0–22.3 s.

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
