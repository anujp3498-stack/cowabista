---
name: Campaign claim query scaled with queue depth, not work done
description: Why claim() throughput collapsed at high queue depth, the LATERAL-join fix, and how to benchmark/verify it without false alarms.
---

## The bug
`DatabaseJobQueue.claim()`'s candidate-discovery query ranked **all** eligible
`Queued` jobs per route with a window function before taking the top N. Cost
scaled with queue depth, not with work actually claimed: at ~85k queued rows
in one route's backlog, Postgres had to sort the entire per-route queue on
every single `claim()` call (disk-spilling sort), costing ~700ms/call. At low
queue depth this was invisible; it only surfaced under sustained load once
the backlog grew, which is why a short benchmark or a fresh/low-volume test
never caught it.

**Why:** a per-route "top 10 by availableAt/id" selection was expressed as
`ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY ...)` over the *entire*
eligible set, which requires materializing and sorting the whole partition
before the outer filter can discard the rest.

**How to apply:** any "top-N per group" query over an unbounded/growing table
must use a correlated `LATERAL` subquery with its own `ORDER BY ... LIMIT N`
per group (driven by an index covering that per-group ordering), never a
whole-table window-function rank filtered down afterward. This generalizes
beyond this one campaign-queue query — watch for the same window-function
anti-pattern anywhere jobs/rows are ranked per tenant/route/owner before
capping.

## The fix shape
Bounded `CROSS JOIN LATERAL` per active route (`ORDER BY available_at, id
LIMIT 10`, correlated on `route_id`), backed by a new partial index
`(route_id, available_at, id) WHERE status = 'Queued'`. Cost became O(active
routes × N) instead of O(queue depth). Measured via `EXPLAIN (ANALYZE,
BUFFERS)` against a preserved ~85k-row queued dataset: ~705ms/call →
~2.35ms/call (~300x).

## Verifying a fix like this without chasing ghosts
- This test suite (`campaign-rate-limit.test.ts`, `campaign-worker-crash-
  recovery.test.ts`) has real pre-existing flakiness independent of any
  query change: confirmed by running the **unmodified baseline** code
  head-to-head with the fix, several times each, before concluding a failure
  is a regression. Several tests here fail ~20-30% of the time on either
  baseline or fixed code (timing-window-dependent assertions), including one
  ("claim selection has a fixed candidate bound...") that is otherwise
  deterministic in isolation — cross-test interference in a shared-process
  sequential run, not a real bug.
- Always confirm the api-server workflow is stopped before running this
  suite or a benchmark — see `workflow-worker-races-tests.md`. Forgetting
  this produces failure rates indistinguishable from a real regression until
  you check with the workflow off.
- When choosing a benchmark's drain-timeout budget, measure observed
  sustained sends/sec first and size the timeout with real margin
  (observed-rate-derived ETA, not a guess) — a benchmark that fails on
  `queue must drain` after a container-enforced background-task cutoff can
  look exactly like a stall/regression but is just an undersized timeout.
  A background benchmark task can also be lost outright if the workspace
  container restarts mid-run; prefer a smaller row count that finishes in a
  few minutes when you just need a clean drain-to-zero PASS, and treat a
  longer partial run's steady per-second rate (sampled via direct DB status
  counts) as sufficient evidence on its own if a full run isn't practical.
