---
name: High-TPS route lock convoys
description: Durable locking and next-step guidance for scaling one WhatsApp number beyond the per-message PostgreSQL ceiling.
---

Claims for one high-throughput number must not take exclusive locks on its route or phone configuration rows. Frozen Plan→Execute jobs also should not re-lock the route row: their validated route TPS is already on the job, while settlement and observability still need to write that route. Keep the provider-cap phone row share-locked; legacy jobs that fall back to live route configuration must retain the route share lock.

Do not have every lane write a route-level “Throttled” status when a one-second rate window fills. The atomic database-clock rate-window reservation is the hard ceiling; repeated route updates create an exclusive-lock convoy that can consume much of the next window.

**Why:** Strict one-number/one-route simulations exposed lock-upgrade deadlocks and lease expiry when frozen claims held route SHARE locks while per-message settlement and current-TPS housekeeping needed route writes. Removing unnecessary frozen-route locks preserved rate-limit, lifecycle, and provider-cap tests, but hot per-message metrics/settlement writes remain the next ceiling.

**How to apply:** Do not try to reach 1000 TPS by adding lanes alone. The next architecture step must batch claim/token reservations and reduce or shard hot campaign/route counters, while keeping lease-token fencing and exact database-clock rate limits.

A final provider-start sequencer should preserve ideal cadence after ordinary event-loop delay, but bound catch-up with a minimum inter-send interval. Resetting its cursor from every late wake-up permanently converts timer jitter into lost throughput; unrestricted catch-up converts the same jitter into bursts. Route-status/lease fence refreshes must not synchronously occupy that final pacing interval: refresh a short-lived, fail-closed status view ahead of dispatch instead.

**Why:** Three isolated 15-second runs per stage proved one-number simulated throughput through 1000 configured TPS, but the same build failed the first 2-number/1000-TPS stage with high variance and repeated idle gaps. Increasing in-flight headroom did not help; synchronous fence refresh did, showing that ready-work continuity—not configured capacity—is critical. The failed scaling stage is evidence that 4/8-number and large-contact readiness remain blocked, not a reason to relax the gate.

**How to apply:** Treat rare-gap percentage and p99 interval as pacing quality signals alongside achieved provider-start TPS and hard one-second windows. Require repeated 2-number success before running 4/8-number studies; never extrapolate a passing single-number mean to aggregate scale.

Queue same-campaign settlement work before acquiring a PostgreSQL connection; otherwise transactions waiting on the shared campaign aggregate row consume the whole pool and starve claims. Do not coalesce settlements from multiple routes into one large transaction while that transaction also locks route rows: the longer route-lock hold blocks fresh claims and can reduce throughput further.

**Why:** Isolated diagnostics reduced pool occupancy from 20 connections/18 waiters to roughly 13/2 and cut ordinary settlement latency to tens of milliseconds, while a 1,024-job cross-route coalescing experiment increased claim latency above one second and collapsed throughput.

**How to apply:** Serialize unavoidable campaign aggregate updates outside the pool, keep exact-lease job updates bounded, and remove claim-time locks on mutable route/campaign rows for frozen jobs. Optimize shared counters without extending route-lock duration.

Batch candidate fairness must reserve a bounded quota per phone, not use one global prefix. Return only the active quota from PostgreSQL: materializing the full eight-lane ceiling for one route shifts the bottleneck into row decoding and event-loop delay. Lease a claimed batch with one fenced set-based update rather than one SQL round trip per job.

**Why:** A global 256-row prefix split two hot routes into roughly 128 candidates each and held aggregate throughput near one number's rate. Per-phone quotas plus a set-based lease update removed schedule holes and made reserved slots continuous, but over-fetching all 2,048 possible rows reduced single-route throughput.

**How to apply:** Cap each phone at the requested batch size and cap the aggregate at the runtime's maximum route count. Preserve organization, campaign, route, queued-status, and lease-token predicates in the set-based transition.

The final in-process pacer should queue future waiters per route and enforce each job's database-reserved slot as a hard not-before time. Do not expose only one waiter through a Promise tail, create one timer per job before the central pacer, or reset the global pump when appending a follower whose route already has a head waiter.

**Why:** Removing those three event-loop handoffs raised two-number simulated throughput from roughly 1,480 to a five-run mean near 1,720 TPS with balanced routes. One run still fell below the 850-TPS-per-number and jitter gates when event-loop and settlement tails rose, so 2×1,000 is improved but not certified.

**How to apply:** Equal-rate routes may align their initial phase to share scheduler wake-ups, but each route must retain its own cursor, bounded catch-up, and database hard-window reservation. Never classify the current result as a passed scaling gate until every required repeat passes.

Successful provider settlement must use a bounded queue that releases route in-flight capacity before campaign aggregate updates finish. Run at most one settlement task per campaign at a time, use available workers for different campaigns, and yield to the dispatch scheduler between same-campaign transactions instead of chaining them in one microtask turn.

**Why:** Merely detaching settlement raised the two-number mean, but starting several same-campaign workers left followers blocked on one Promise tail and let each follower resume immediately. Explicit campaign-aware scheduling plus an event-loop yield produced a strict five-repeat 2×1,000 simulated-provider pass; four numbers then exposed claim capacity as the next ceiling.

**How to apply:** Keep exact leases recoverable, include settlement tasks in shutdown/idle draining, and apply bounded backpressure rather than unbounded buffering. For four-number scaling, improve claim throughput or batch size; do not add pacer lanes or weaken jitter gates.