---
name: Not-started work is requeued with its attempt returned
description: Phase 0 cross-cell safety (2026-11-04): anything the runtime knows never reached the provider is requeued, attempt refunded, intent rejected; a not-started outcome is never a failure or delivery_unknown. The intent revoke is fenced to the caller's lease.
---

Before Phase 0, a lane drop on another cell (a cross-cell pause leaving a phone with no Running campaign)
cancelled the shard worker's paced backlog before start. The parent registration was not aborted, so
`dispatchReservoirEnvelope` treated the cancel as a plain error and settled the job **Failed** ("Send aborted
before provider start"): 45 to 47 of 240 jobs per run in the two-cell test. Similar paths recorded
`delivery_unknown` for calls never made:
- the shard parent refusing a hand-off;
- a cancel inside `invoke`;
- an ownership lapse between the worker's two start checks, which posted no outcome at all.

**Rule now** (`docs/CROSS_CELL_DISPATCH_AUTHORIZATION.md` section 4.1): when the runtime *knows* a send did not
start, the job is requeued, the claim's attempt is returned in the same exact-lease UPDATE, and the intent is
rejected. The paths:
- `cancelledBeforeStart` outcomes;
- shard refusals;
- aborts before transport;
- envelopes published but never consumed at a lane drop or stop.

Anything that may have started keeps the old semantics.

**Why:** an unstarted message must stay deliverable after resume. Refunding the attempt keeps pause and resume
cycles from exhausting `maxAttempts`, and the rejected intent lets the next preparation re-arm it instead of
failing for manual reconciliation.

**How to apply:**
- A new abort or refusal path in transport must post a not-started outcome (`cancelledBeforeStart: true`),
  never reject or report a provider error, whenever it is certain no provider call happened.
- Settle such paths with `settleAborted(..., { notStarted: true })` / `settleAbortedBatch(..., { notStarted:
  true })`, and pass the caller's exact `leaseToken` to `revokePrepared`. Revoke while still holding the lease,
  before the fenced requeue: the template sender rejects only while the job is `Processing` under that exact
  lease. A late revoke does nothing, because the pending intent may be a later lease's whose call started;
  allowing it was a duplicate path found in review.
- Broker reclaim is lease-aware (Decision 8): never fail a reclaimed delivery whose job is still Processing
  under its live lease (defer), never write anything for one whose job left the lease (acknowledge), and fence
  the delivery-unknown intent write to the exact lease (`settleUnknownPrepared`, forwarded by every wrapper like
  `revokePrepared`). Ambiguous deliveries are still never re-sent.
- A dropped lane must stay inert (`lane.dropped`): no service, drain or adoption. Settling a lane's published
  envelopes as requeued is safe only because nothing can still adopt and send them under that lane.
- **Every `ProviderSender` wrapper must forward `leaseToken`** (`DelegatingWhatsAppSender`, the runtime's sender;
  the benchmark's production wrapper; test wrappers). TypeScript accepts a forwarder that drops the optional
  argument. Without the token the fence treats the caller's own live lease as another holder's and silently
  skips the revoke, which brings back manual-reconciliation failures for requeued work. Found in review before
  commit; `test:not-started-settlement` runs the fence through both senders.
- Still unfixed without schema work: a job whose lease is gone before its revoke ends in manual
  reconciliation (never a duplicate).
