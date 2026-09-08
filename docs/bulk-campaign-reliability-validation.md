# Bulk campaign reliability validation

## What the automated tests measure

- Streaming CSV parsing preserves 2,000 quoted rows when input is split at arbitrary chunk boundaries.
- Concurrent import initialization permits one active import, rejects a competing request, and replays a completed idempotency key without creating new work. Import cancellation fences later batch writes.
- Queue tests verify atomic job claims, unique job/idempotency-key ownership under concurrent workers, route TPS limits, and a shared-phone TPS cap across multiple routes. A claim examines at most **100 phone-fair candidates**. Candidates are interleaved by phone and use each route's durable scheduling timestamp to rotate bounded scans; the regression verifies five saturated phones with more than 100 queued jobs each cannot hide eligible work for a sixth phone.
- Cap-race coverage locks a provider-phone row, lowers its cap while a claim is waiting, and verifies the claim re-reads the locked cap rather than authorizing work from a stale candidate snapshot.
- Lifecycle tests cover retry then retry exhaustion, queue idempotency-key conflicts, lease recovery using the database clock, paused/cancelled in-flight send aborts, and resuming a paused send once with its same idempotency key.
- Route validation rejects zero TPS and TPS above the selected phone's provider-approved limit.
- Template tests verify descriptors and Meta payload construction for heterogeneous templates that share an image header while using different body and URL-variable counts.
- Campaign monitoring reports queued and processing depth, delayed retries, expired leases, delivery-unknown provider sends, currently throttled routes, reconciliation runs, and shared-phone-capped effective TPS. These are operational state signals, not throughput benchmarks.

## Provider cap safety

Route TPS must be a positive integer and cannot exceed the selected phone number's cap. Campaign preflight also requires a connected, provider-verified phone and rechecks both limits. A phone-number cap cannot be increased through the API unless synchronized provider metadata contains an equal or higher approved cap; unsynchronized creation is limited to the conservative default of 50 TPS.

## Implemented work bounds

The streaming import implementation flushes persistence work in **500-row batches**. Queue claim selection has a **100-candidate** bound, and the runtime has a separate **100-claim-per-tick** bound. The candidate-bound test verifies the claim-limit constant and ordering behavior; these bounds are not performance benchmarks.

## Limits not established by these tests

Support for **10–20 million contacts is UNPROVEN/UNVALIDATED**. The tests above are correctness and bounded-work tests; they are not a volume, soak, database-capacity, or provider-throughput benchmark.

Operation at **1000 TPS is UNPROVEN/UNVALIDATED**. No automated benchmark in this repository demonstrates that sustained rate, including provider behavior, database contention, network latency, or recovery behavior at that load.

## Opt-in campaign benchmark

The API package contains an explicitly opt-in benchmark which uses the production
incremental CSV parser, phone normalization/partitioning helpers, 500-row
persistence batch shape, database queue, template resolver, rate limiter, worker,
and lease reaper. It creates several routes sharing a phone and uses an in-process
sender with deterministic retryable failures. It does not read Meta credentials or
make provider requests.

The benchmark must use a dedicated PostgreSQL database. The database name must
contain a `bench` or `benchmark` segment, and the confirmation value must exactly
match that database name. Do not point it at a development, staging, or production
database. From the repository root:

```sh
export CAMPAIGN_BENCHMARK_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/wabista_benchmark'
export CAMPAIGN_BENCHMARK_CONFIRM='wabista_benchmark'

# Apply the current schema to that dedicated database.
DATABASE_URL="$CAMPAIGN_BENCHMARK_DATABASE_URL" pnpm --filter @workspace/db push

# Run the benchmark. This writes JSON under benchmark-results/ by default.
pnpm --filter @workspace/api-server benchmark:campaign
```

The defaults are 10,000 generated contacts, four routes, four concurrent workers,
a 15-second sustained interval, a 10 ms simulated send delay, one injected
retryable response per 20 contacts, and a 600-second drain timeout. Configuration
is repeatable through:

```sh
CAMPAIGN_BENCHMARK_ROWS=50000 \
CAMPAIGN_BENCHMARK_ROUTES=8 \
CAMPAIGN_BENCHMARK_WORKERS=8 \
CAMPAIGN_BENCHMARK_SUSTAINED_SECONDS=60 \
CAMPAIGN_BENCHMARK_MAX_STALL_SECONDS=3 \
CAMPAIGN_BENCHMARK_SEND_DELAY_MS=10 \
CAMPAIGN_BENCHMARK_RETRY_EVERY=20 \
CAMPAIGN_BENCHMARK_DRAIN_TIMEOUT_SECONDS=600 \
CAMPAIGN_BENCHMARK_OUTPUT="$PWD/benchmark-results/controlled-run.json" \
pnpm --filter @workspace/api-server benchmark:campaign
```

`CAMPAIGN_BENCHMARK_ROWS` must be large enough to keep all workers busy for the
configured sustained interval; the runner checks this before touching the
database. `CAMPAIGN_BENCHMARK_CSV_CHUNK_BYTES` can vary parser chunking.
Set `CAMPAIGN_BENCHMARK_KEEP_DATA=1` only when retained rows are needed for
database inspection; otherwise the uniquely named benchmark organization is
removed after the measurements are written. Database growth is measured before
that cleanup.

### Assertions and reported measurements

The run samples progress once per second and fails rather than publishing a
partial success when workers make no progress for more than the configured
consecutive-sample limit (three seconds by default), the queue does not drain
before the configured timeout, terminal counts disagree, or leases remain.
Shorter stalls remain visible in the JSON alongside measured database deadlock
retries instead of being hidden. This is a progress/liveness interval, not an
assertion that a target throughput or worker-utilization level was sustained.
Before the worker pool starts, one worker claims a short lease and is deliberately
abandoned.
The benchmark waits for expiry, invokes the production lease recovery path, and
asserts that the same job is requeued, sent, and has exactly one replacement
attempt.

The JSON result records:

- generated CSV bytes, imported rows, elapsed time, and rows/second;
- database and campaign-relation byte growth after import and after queue drain;
- queue claim calls/second, successful claims/second, claim latency,
  provider-send attempts, and successful simulated sends/second;
- idle-claim percentage plus p50/p95/p99 `processOne` latency, peak waiting
  database locks, retried deadlock/serialization failures, and
  deadlock/conflict/transaction deltas as worker-contention data;
- injected retry count and retry pressure percentage;
- peak Node RSS and heap usage sampled during the workload;
- host CPU busy/idle ticks, peak normalized one-minute load, minimum free host
  memory, filesystem capacity/free-space delta, and per-process disk I/O when the
  host kernel exposes `/proc/self/io`;
- peak PostgreSQL active/total connections plus buffer reads/hits, block I/O
  timing, temporary files/bytes, locks, deadlocks, and transaction deltas;
- sustained progress samples and interruption/recovery assertion outcomes.

Every result includes the source Git revision, whether its working tree was
dirty, and a SHA-256 digest over the benchmark, measured production services,
and database source files. It also records the tested client profile (CPU model,
logical CPU count, total RAM, OS/architecture, and Node version) and tested database profile
(PostgreSQL version, endpoint without credentials, database name,
`shared_buffers`, `work_mem`, `effective_cache_size`, and `max_connections`).
Consequently, the exact tested hardware/database profile is the profile embedded
in each result file; there is no unmeasured “reference hardware” claim in this
document. Keep the immutable JSON with the commit SHA, run date, schema state, and
any host-level monitoring used for a capacity decision. Compare runs only when
their recorded configuration and profiles are equivalent.

For a stepped study, set a stable study ID, an ordered size list, and at least
three repeats. The runner stops at the first benchmark failure, at the per-run
time limit, or after every configured step passes:

```sh
CAMPAIGN_BENCHMARK_STUDY_ID='capacity-2026-08-27' \
CAMPAIGN_BENCHMARK_STEPS='7000,9000' \
CAMPAIGN_BENCHMARK_REPEATS=3 \
CAMPAIGN_BENCHMARK_MAX_RUN_SECONDS=600 \
pnpm --filter @workspace/api-server benchmark:campaign:stepped
```

Each run and the study summary are created exclusively and cannot overwrite an
existing result. The stepped runner also refuses to start from a dirty Git tree
and asserts that the commit, measured-file digest, and clean status remain
unchanged through every run. Use a new study ID for a new study.

### Claim policy

Only values present in a successfully completed JSON result are measured values.
Simulated send throughput measures this application and PostgreSQL queue path; it
does **not** measure Meta latency, acceptance, delivery, provider throttling, or
network behavior. It must not be described as provider TPS.

### Measured development profile (August 27, 2026)

The largest completed run retained with this change is
[`campaign-6000-replit-dev-2026-08-27.json`](benchmarks/campaign-6000-replit-dev-2026-08-27.json).
It measured **6,000 contacts**, not the maximum possible capacity. The source
field records the base Git revision and that the benchmark ran from the dirty
task working tree containing this change.

| Measurement | Result |
| --- | ---: |
| Streamed import | 6,000 rows / 436,806 CSV bytes in 1.08 s |
| Import rate | 5,551.62 rows/s |
| Campaign relation growth after import | 4,677,632 bytes |
| Campaign relation growth after drain | 6,225,920 bytes |
| Database growth after drain | 6,320,172 bytes |
| Active simulated-send interval | 141.92 s |
| Queue claim calls | 8,672 at 61.11/s |
| Successful claims | 6,300 at 44.39/s |
| Provider-send attempts | 6,300 |
| Successful simulated sends | 6,000 at 42.28/s |
| Retry pressure | 300 injected retries; 4.76% of claims |
| Worker contention | 3 peak waiting locks; 0 deadlocks; 0 serialization failures |
| Queue claim latency | 57.76 ms p95; 79.56 ms p99 |
| `processOne` latency | 111.39 ms p95; 146.28 ms p99 |
| Sustained-run stalls | 0 consecutive stalled one-second samples |
| Peak process memory | 261,025,792-byte RSS; 87,121,872-byte heap |
| Recovery | interrupted lease requeued; job sent on exactly one replacement attempt |

The measured client had four logical Intel Xeon Platinum 8581C CPUs, 8,352,194,560
bytes of RAM, Linux 6.18.46 x64, and Node v24.13.0. The database was PostgreSQL
16.10 with 128 MB `shared_buffers`, 4 MB `work_mem`, 128 MB
`effective_cache_size`, and 112 maximum connections. The workload used four
routes, four workers, a 10 ms simulated provider delay, a 15-second sustained
assertion, and one injected retryable response per 20 contacts.

This result supports only the statement that the recorded application/database
path completed this 6,000-contact simulated-provider workload on that profile.
It is not evidence for larger contact volumes, a general customer campaign
limit, sustained provider TPS, or production capacity.

### Repeated capacity study on the recorded Replit profile (August 27, 2026)

The retained stepped study is
[`campaign-capacity-replit-2026-08-27/study-summary.json`](benchmarks/campaign-capacity-replit-2026-08-27/study-summary.json).
It predeclared 7,000 and 9,000-contact steps, three repetitions per step, and a
600-second per-run stop limit. All configured runs passed, so the documented
stop condition was `all-configured-steps-passed`; the study did **not** search
for or encounter a failure boundary.

The largest repeatedly passing profile is **9,000 contacts**. Every retained run
was measured from clean Git commit `ffdea4866f748b2040bcc8ddf977a04dd12321e8`
with the same measured-files SHA-256 digest. The six immutable run files are
stored beside the summary.

| 9,000-contact measurement (3 runs) | Minimum | Mean | Maximum |
| --- | ---: | ---: | ---: |
| Streamed import rate (rows/s) | 4,265.44 | 4,305.48 | 4,342.65 |
| Successful simulated sends/s | 33.80 | 34.26 | 34.52 |
| Active simulated-send interval (s) | 260.69 | 262.70 | 266.29 |
| Queue claim p95 latency (ms) | 87.72 | 92.32 | 96.17 |
| `processOne` p95 latency (ms) | 152.58 | 160.23 | 165.95 |
| Peak Node RSS (bytes) | 283,443,200 | 284,009,813 | 284,438,528 |
| Host CPU busy | 34.12% | 34.20% | 34.33% |
| Peak host memory used | 52.23% | 52.30% | 52.36% |

All three 9,000-contact runs sent all 9,000 contacts, injected and recovered 450
retryable sends, drained the queue, left no processing leases, recorded no
sustained one-second stalls, deadlocks, serialization retries, PostgreSQL
temporary files, or temporary bytes. Peak PostgreSQL usage was seven
connections and three waiting locks in every run. PostgreSQL block-read and
block-write time were both zero, with zero physical block reads during each
workload; filesystem free-space changed by 0 to -4,096 bytes. This host kernel
did not expose `/proc/self/io`, so per-process disk I/O is explicitly `null` in
the retained results rather than estimated.

The measured application host had four logical Intel Xeon Platinum 8581C CPUs,
8,352,194,560 bytes of RAM, Linux 6.18.47 x64, and Node v24.13.0. PostgreSQL was
16.10 with 128 MB `shared_buffers`, 4 MB `work_mem`, 128 MB
`effective_cache_size`, and 112 maximum connections. The workload retained the
same four routes, four workers, 10 ms simulated-provider delay, 15-second
sustained assertion, and one retryable response per 20 contacts.

This raises the evidence-backed statement only to: the recorded application and
PostgreSQL path repeatedly completed a **9,000-contact simulated-provider
workload on this exact profile**. It does not establish a maximum campaign size,
a broad customer limit, provider throughput, or production capacity.

The prohibition remains unchanged: do not claim support for **10–20 million
contacts** or **1000 TPS** unless a benchmark run directly uses that contact
volume or directly sustains that rate on the stated hardware/database profile.
Even a 1000 simulated-send/second result does not establish 1000 Meta TPS; a
provider-connected, authorized measurement would also be required for that claim.

### Next-tier repeated capacity study (August 27, 2026)

The retained next-tier study is
[`wabista-next-tier-12000-2026-08-27/study-summary.json`](benchmarks/wabista-next-tier-12000-2026-08-27/study-summary.json).
It predeclared a 12,000-contact step, three repetitions, and a 600-second
per-run stop limit. All three runs passed, so the study stopped at its declared
maximum with `all-configured-steps-passed`; it did **not** encounter or establish
a failure boundary.

The next repeatedly passing tier above 9,000 is **12,000 contacts**. Every run
used clean Git commit `e2a441029bfb1edbb6f255c21f13cf4a8d860016` and the same
measured-files SHA-256 digest
`0ddfa2c20d679e4572e4443d611d6f995e89f37c3bbd66188c358f5920216d86`.
The three immutable run files, summary, and `SHA256SUMS` manifest are retained
together.

| 12,000-contact measurement (3 runs) | Minimum | Mean | Maximum |
| --- | ---: | ---: | ---: |
| Streamed import rate (rows/s) | 4,084.58 | 4,343.46 | 4,736.06 |
| Successful simulated sends/s | 30.22 | 30.37 | 30.57 |
| Active simulated-send interval (s) | 392.49 | 395.14 | 397.08 |
| Queue claim p95 latency (ms) | 103.80 | 105.99 | 109.94 |
| `processOne` p95 latency (ms) | 174.73 | 176.95 | 181.16 |
| Peak Node RSS (bytes) | 272,031,744 | 301,499,733 | 316,858,368 |
| Host CPU busy | 33.54% | 33.86% | 34.04% |
| Peak host memory used | 41.61% | 42.55% | 43.98% |

All three runs sent all 12,000 contacts, injected and recovered 600 retryable
sends, drained the queue, left no processing leases, and recorded no sustained
one-second stalls, deadlocks, serialization retries, PostgreSQL temporary files,
or temporary bytes. Peak PostgreSQL usage was seven connections and three
waiting locks in every run.

The measured application host had four logical Intel Xeon Platinum 8581C CPUs,
8,352,194,560 bytes of RAM, Linux 6.18.47 x64, and Node v24.13.0. PostgreSQL was
16.10 with 128 MB `shared_buffers`, 4 MB `work_mem`, 128 MB
`effective_cache_size`, and 112 maximum connections. The workload retained the
same four routes, four workers, 10 ms simulated-provider delay, 15-second
sustained assertion, and one retryable response per 20 contacts used by the
previous repeated study.

This raises the evidence-backed statement only to: the recorded application and
PostgreSQL path repeatedly completed a **12,000-contact simulated-provider
workload on this exact profile**. It does not establish a maximum campaign size,
a broad customer limit, provider throughput, or production capacity.

The prohibition remains unchanged: do not claim support for **10–20 million
contacts** or **1000 TPS** unless those values are directly measured. These runs
made no Meta requests and therefore provide no evidence about provider TPS,
acceptance, delivery, throttling, or network behavior.
