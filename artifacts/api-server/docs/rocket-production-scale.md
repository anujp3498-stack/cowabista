# Rocket Campaign production-scale requirements

## What the current certification proves

The single-number certification uses the production campaign runtime, durable PostgreSQL leases, frozen templates, the phone-owned in-memory reservoir, fixed-rate phone scheduling, asynchronous batched outcomes, and a simulated provider transport.

It proves that one process can sustain at least 950 successful dispatch starts per second for a configured 1,000 TPS phone while preserving the measured rolling ceiling, bounded jitter, leases, fencing, idempotency, STOP suppression, and crash recovery.

It does **not** prove Meta network throughput, connector-account quotas, real template acceptance, webhook delivery capacity, or aggregate 10K–20K TPS.

## Required production topology for 10K–20K aggregate TPS

- The API/control plane prepares durable work but does not invoke providers. Dedicated transport worker threads are separate event loops; horizontally scaled runtime processes each host their own worker pool.
- Redis with high availability for cross-process phone-timeline ownership, atomic reservations, and fail-closed pacing. In-memory coordination is test-only.
- Multiple stateless dispatch processes use Redis TTL leases plus monotonic fencing tokens for phone ownership. Every provider dispatch carries the current token, and a transport worker refuses starts after token replacement or lease expiry.
- Redis is coordination infrastructure, not the compute load balancer. CPU/event-loop isolation comes from the independent transport execution workers and horizontally scaled runtime services.
- Enough CPU cores for independently scheduled phone lanes. Capacity planning must use real worker wakeup/jitter measurements rather than assuming every vCPU can pace an arbitrary number of 1,000 TPS lanes.
- PostgreSQL sized for bounded reservoir refill and set-based settlement, with PgBouncer or equivalent transaction pooling, monitored lock waits, WAL throughput, autovacuum, storage IOPS, and replica lag.
- Separate connection-pool budgets for API traffic, reservoir refill, outcome settlement, webhooks, and housekeeping so one workload cannot starve dispatch durability.
- Horizontally scaled webhook ingestion backed by a durable queue/outbox. Provider callbacks must be acknowledged quickly and processed idempotently.
- Durable observability for per-phone reservoir depth, refill latency, scheduled-versus-actual dispatch cadence, provider latency/errors, outcome backlog, lease age, fencing failures, Redis latency, database pool waits, lock waits, and WAL volume.
- Backpressure that stops refill before memory or outcome queues overflow. Backpressure may lower achieved TPS but must never release catch-up bursts.
- Regional placement close to Meta endpoints and the Redis/PostgreSQL primary, with failure-domain testing for process loss, Redis failover, database failover, and partial network partitions.

## Requirements for 10–20M contacts

- Stream imports and campaign execution; never materialize the contact set in application memory.
- Partition or otherwise lifecycle-manage very large campaign job/event tables, with indexes validated at production cardinality.
- Keep queue scans bounded by phone/route and eligible time. Benchmark query plans with tens of millions of queued rows, not only a small active set.
- Use bulk inserts, set-based lease transitions, set-based provider-intent arming, and batched outcomes/counters.
- Define retention and archival for completed jobs, provider events, audit history, and exports so active indexes remain bounded.
- Run restore drills and reconciliation tests at full data volume before claiming contact-scale readiness.

## Evidence still required before production claims

1. Repeat the single-number gate with the production Redis coordinator.
2. Test 2, 4, 8, and then 10–20 independently owned numbers while preserving each number's cadence and aggregate fairness.
3. Run long-duration soak tests, not only short certification windows.
4. Run queue-depth tests at 1M and then 10–20M contacts using production-shaped rows and query plans.
5. Run real-provider tests with Meta-approved numbers, measuring HTTP acceptance, throttling/error codes, connector quotas, and webhook reconciliation.
6. Prove process crash, Redis failover, database failover, STOP/pause/kill, and unknown-provider-outcome recovery under aggregate load.

Only the simulated-provider single-number gate is currently certified. Multi-number, contact-scale, and real-provider evidence must be reported separately and must not be inferred from this result.