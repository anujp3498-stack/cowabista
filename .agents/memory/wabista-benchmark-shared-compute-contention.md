---
name: Benchmark DB shares compute with dev DB
description: A dedicated benchmark Postgres database on the same server as the dev DB still contends for compute with the live api-server workflow, silently invalidating throughput results unless the workflow is paused first.
---

## The issue

Provisioning a separate, dedicated database (e.g. `wabista_benchmark`) on the same
Postgres *server* as the app's dev database (`heliumdb`) isolates the *data* but not
the *compute*. Both databases share the same underlying Postgres instance's CPU/IO.

If the live `api-server` workflow is running while a benchmark executes, its
CampaignRuntime background worker (polling every 100ms) and normal request traffic
compete for that shared compute, even though they never touch the benchmark
database's tables directly (no row-level contention, no locks shared).

Measured impact: a tier that reliably passed before (12,000 contacts, ~28-30
sends/sec) dropped to ~5-10 sends/sec with the live workflow running, causing the
benchmark's own `drainTimeoutSeconds` (600s) to trip and fail the
`benchmark queue must drain` assertion — even though nothing in the application
code had regressed. The exact same run size passed cleanly (~26-28 sends/sec,
matching historical baseline) once the api-server workflow was stopped for the
duration of the run.

**Why:** managed Postgres compute in this environment is a single shared instance
per project; there is no separate compute tier to provision without an external
decision. The dedicated database only isolates data/cleanup, not throughput.

## How to apply

Before running `pnpm run benchmark:campaign` (or the stepped variant) at any tier,
stop the `artifacts/api-server: API Server` workflow first (`stopWorkflow` via
CodeExecution), run the benchmark, then restart the workflow afterward and verify
it comes back up cleanly. Do this even for tiers that previously passed — a failure
at a previously-safe tier is a strong signal to check for this contention before
concluding the app hit a real capacity ceiling.

Confirmed again at larger scale: a 100k-row run left with the workflow running
stalled to ~5.4 sends/sec after 48 minutes (never finished); the identical 100k
config, workflow properly stopped, completed cleanly at ~42 sends/sec in ~40
minutes with zero deadlocks/serialization retries. `benchmark/run.mjs` now has a
preflight check (`checkForContendingWorkflow`) that greps for a running
`dist/index.mjs` process and throws with a clear error instead of letting this
mistake silently produce a multi-hour false stall again.

Also watch for a **stray leftover benchmark process** after a run: it does not
always exit cleanly, and left running it is itself a compute-contention source
that can make unrelated wall-clock-timing tests (e.g. sustained-per-number-TPS)
fail. Check `ps aux | grep benchmark` and kill any lingering
`campaign-benchmark.mjs` process before trusting a subsequent test run.
