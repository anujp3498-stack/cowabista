---
name: Campaign job lease fencing
description: Durable rules for safe pause, cancel, shutdown, and crash recovery in the campaign worker.
---

Do not bulk-change in-flight `Processing` jobs back to `Queued` when pausing a campaign. Each claim must have a unique lease token, owner, and expiry; every success, retry, abort, or requeue must settle only under that exact lease.

**Why:** Requeueing while a provider call is already in flight can send the same message twice after resume. A process crash can also leave unfenced `Processing` jobs stuck forever. Provider aborts alone are insufficient because a response can race with the lifecycle transition.

**How to apply:** Keep provider calls abort-aware, time-bounded, and idempotent by stable job key. Pause/kill should signal active workers rather than overwrite their leases. Reap expired leases on startup and periodically, then reconcile persisted metrics and route depths from authoritative job state.