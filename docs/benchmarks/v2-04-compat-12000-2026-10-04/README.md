# V2-04 comparable benchmark record (2026-10-04)

Purpose: Appendix A requires a benchmark at the last retained profile before an engine-touching
milestone. The retained single-host record is `docs/benchmarks/wabista-next-tier-12000-2026-08-27`
(12,000 rows, 4 routes, 4 workers, 10 ms simulated provider delay, one retryable response per 20
contacts, 15-second sustained assertion). This record compares the V2-04 head against its base
commit on the same container with the same harness and parameters.

## Profile actually run (and why it deviates)

| Parameter | Retained 2026-08-27 | This record |
| --- | --- | --- |
| rows / routes / workers | 12,000 / 4 / 4 | 12,000 / 4 / 4 |
| phones | 1 (routes stacked on one number) | 4 (one route per number) |
| sendDelayMs / retryEvery / sustainedSeconds | 10 / 20 / 15 | 10 / 20 / 15 |
| provider TPS limit / configured route TPS | unlimited (pre-pacing harness) | 180 / 180 |

Deviations are forced by the current harness, not chosen: it now (a) requires
`rows >= phoneTps x phones x sustainedSeconds x 1.05` (15,750 at the 1,000 TPS platform ceiling,
so a cap of 180 TPS per phone keeps the retained 12,000 rows), and (b) asserts the durable
per-phone pacing invariant, which four routes stacked on one phone violate by construction
(see `.agents/memory/rocket-one-route-per-number.md`), so one route per phone is used.

## Profile arithmetic

The harness requires `rows >= providerTpsLimit x phones x sustainedSeconds x 1.05`. With 4 phones at
180 TPS for 15 s that is 180 x 4 x 15 x 1.05 = 11,340 rows, which 12,000 satisfies; the theoretical
aggregate ceiling of this profile is 4 x 180 = 720 simulated sends/s. (A first attempt with the
retained 1-phone layout at 700 TPS satisfied the row minimum, 700 x 1 x 15 x 1.05 = 11,025, but
stacked four routes on one phone and failed the per-phone pacing assertion as described above; its
output was discarded.)

## Result

Both runs completed the whole workload (12,000 sent, 12,600 attempted including the 600 injected
retries, queue drained) and then failed the SAME verification assertion:
`phone N reserved slots must be at least 5.5456ms apart` (floating tolerance 0.01 ms). The base
commit `7d4c127` fails it (`base-7d4c127-run-1.json`, phone 6) and the V2-04 head `847a1c2` fails
it (`head-847a1c2-run-1.json`, phone 2). Because the harness stops at verification, the summary
metrics it computes afterwards (claim p95, processOne p95, peak RSS) were not produced for either run.

What this record supports: (1) the workload completes on both commits; (2) the same verification
assertion fails on both commits; (3) a limited comparison of the harness's own one-second progress
samples, below. What it does not establish: the cause of the assertion failure (the shared container
is a plausible factor, but no measurement here isolates it from the harness or the code), or a
statistical noise interval (one run per commit, no repeats).

| Metric (progress samples, 2 s to 15 s) | base 7d4c127 | head 847a1c2 |
| --- | ---: | ---: |
| Steady simulated sends/s, mean | 627.4 | 680.7 |
| Steady simulated sends/s, min / max | 311.9 / 685.4 | 677.5 / 686.7 |
| Sent at 15.06 s | 9,302 | 9,958 |
| Total sent / attempted | 12,000 / 12,600 | 12,000 / 12,600 |
| Claim calls | 103 | 108 |

The head's samples are not lower than the base's (the base has one sample dipping to 311.9/s); with a
single run per commit this is an observation, not a within-noise determination. It is a same-container
comparison between two commits, not a reproduction of the retained 2026-08-27 numbers (which predate
the shard transport and per-phone pacing) and not production-scale proof; the prohibition in
`docs/bulk-campaign-reliability-validation.md` on claiming 10 to 20 million contacts or 1,000 TPS
stands. No pacing assertion or production pacing behaviour was changed to obtain a passing run.

## Open item for the release gate

A benchmark run that passes the harness's verification phase on this profile has not been produced
on either commit. The dedicated-host run (see `docs/campaign-distributed-baseline-runbook.md`) remains
an open broadcasting-release gate and has not been started; it requires authorization for that
environment.
