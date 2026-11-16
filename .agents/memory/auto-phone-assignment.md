---
name: Automatic phone-to-cell assignment (V2-372)
description: How transport cells divide phones without static scopes, what keeps it duplicate-free, and the consume() concurrency trap found while building it
type: project
---
Added 2026-11-15 on `feature/v2-372-auto-phone-assignment` (base `ef8d32e`). Production defect: cells scoped `1-4`/`5-8` never sent new phone 9.

- `CAMPAIGN_TRANSPORT_ASSIGNMENT=auto` (no `CAMPAIGN_TRANSPORT_PHONE_IDS`, `CAMPAIGN_CELL` = cell name). Module `campaign-phone-assignment.ts`: Redis membership zset `campaign:cells:{campaign-cells}:members` (TTL on Redis TIME), pure plan (rendezvous hash + load bound 1.25x, by lane weight), assigned cell acquires at once, rank k after k x grace, handoff requests `campaign:ownership:{campaign-owner:o:p}:handoff`, holder hands off gracefully (no refill, drain, release).
- Safety argument: assignment never grants anything; `ensurePhoneOwnership` fenced lease is the only authority. Fence counter now `PERSIST` (tokens never restart); validity = local time before the request + TTL.
- **Trap:** `consume()` is called concurrently on one lane (serviceLane and runRefill). Any state retried across passes (V2-372 `lane.unadopted`) must be held exclusively per pass (`lane.adopting`) or a batch is queued and SENT TWICE. The two-cell failover test caught it; `test:stale-envelope-discard` O reproduces it.
- Crash ambiguity unchanged: a SIGKILLed cell's consumed work (about TPS x 3 s per phone) fails delivery-unknown, never re-sent.
- Tests: `test:phone-assignment` (pure), `test:auto-assignment` (two OS processes; needs CAMPAIGN_TEST_REDIS_URL), `test:assignment-runtime`, guard tests. Timings for tests via harness `WORKER_ASSIGNMENT_TIMINGS`.
- The cutover package (`deploy/cutover/package`, SHA256SUMS) is pinned: do not edit its scripts for this feature.
