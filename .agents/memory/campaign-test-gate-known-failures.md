---
name: Three known campaign test-gate failures (none are production defects as far as proven)
description: dispatch-scheduler cancellations, lifecycle 13, and the intermittent failure-settlement H fail for documented harness/expectation/timing reasons; read this before treating any of them as a regression.
---

Verified against `111e0fe` (last `src/` change). Do not change production transport behaviour to make these green.

**1. `test:phone-dispatch-scheduler` (3 tests "cancelledByParent", "Promise resolution is still pending but the event loop has already resolved").**
Cause, proven by reproduction: `PhoneDispatchScheduler` unrefs its pacing worker after wiring the listeners, and pending
`wait()` promises resolve from that worker's messages. A bare `tsx --test` process has nothing else keeping the event
loop alive, so Node exits about 100 ms in. Repro: 300 waits on one lane resolve 0 of 300 without a keep-alive and
300 of 300 in about 500 ms with `setInterval(() => {}, 1000)` running. In production the HTTP listener and the runtime
tick keep the loop alive, and the WhatsApp sender uses the shard transport path, so this scheduler paces only the
fallback path. Test-harness liveness; a test-only keep-alive handle fixes it. Cancelled in every recorded run since P9.

**2. `test:lifecycle` test 13 "200ms PostgreSQL claim latency is hidden behind prepared broker watermarks".**
Failing assertion: `reservoirStarvationEvents == 0` (observed 2) for 768 jobs at 1,000/s with a 200 ms artificial
claim latency. Reservoir starvation events are normal for the current supply design (one claim cycle per refill
slot): isolated single-cell controls record 81 to 206 events per run at 3.6K to 3.9K TPS with per-phone throughput
at 98 percent of the ceiling. The test's zero-starvation expectation predates that design (it fails in the earliest
recorded verification, P4). Stale expectation, not a data-integrity issue; the threshold needs an owner's decision.

**3. `test:failure-settlement` test H "STOP / kill-switch aborts never enter the failure queue" (intermittent: 2 of 4
runs on 2026-09-13, 1 of 3 earlier; also in the P4, P9 and P13 records).**
Failing assertion: `dispatchAll`'s "every job must have been claimed and dispatched: 0 !== 1". The failing runs leave
the second fixture's single job Queued with attempts 0 and `available_at = created_at`, so the claim never took it
within the helper's 50 x 20 ms window; the campaign is Running, the route Active with configuredTps 1000, the phone
Connected with tpsLimit 1000, and no other claimer exists.
Exact reproduction (no suite load): run test H's sequence 12 times in one process (fixture, claim, prepare, abort the
campaign, dispatch the aborted envelope, create a fresh fixture, claim it): the fresh fixture's FIRST claim returned
empty in 8 of 12 rounds even though every claim predicate held at that instant (probe: job Queued, available_at 8 to
11 ms before the JS and database clocks, route Active), and the second claim 20 to 40 ms later succeeded every time
(0 failures in 12 rounds). Under suite load the same gap evidently exceeds the helper's one-second bound. The job is
never lost or corrupted; a later claim always takes it. What produces the empty first claim after route creation was
NOT isolated: the claim's SQL predicates all hold, and nothing time-gated was found in the candidate query, the
phone-fair quota, or the in-memory pacing reservation in the reading done so far. Treat as claim-latency timing
(P2, tracked); a wider helper wait is the release-gate action if accepted, not a production change.
