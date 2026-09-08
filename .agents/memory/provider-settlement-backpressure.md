---
name: Provider settlement backpressure fencing
description: Durable rules for bounding provider outcome and broker ACK debt without losing lease or retry semantics
---

Reserve a bounded success-settlement slot before starting provider I/O. If no slot is available, do not call the provider and requeue the exact leased job without consuming a delivery attempt. Release the slot only when the success settlement is queued, or when the prepared send is revoked or fails before a successful outcome.

Broker ACK debt must also count against each phone lane's capacity. Retry ACK batches with bounded exponential backoff, and drain provider completions before closing the broker during shutdown.

**Why:** Letting transport run ahead of durable outcome capacity either retains unbounded detached waiters or turns capacity pressure into fake provider failures, exhausting attempts and obscuring the real cause.

**How to apply:** Any new transport path, provider sender, or broker consumer must participate in the same reservation/release and ACK-debt accounting before it is used for throughput validation.