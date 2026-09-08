---
name: Multi-phone main-thread handoff ceiling
description: Why independent pacing workers can still lose throughput when every provider start and completion converges on one Node event loop.
---

Provider starts must be owned by stable phone-to-transport shards: pacing, the provider invocation, and completion handling stay on that shard's execution plane rather than crossing a shared main-thread ACK rendezvous.

**Why:** Phase staggering fixed synchronized two-lane wakeups but four lanes still collapsed when every provider start and completion converged on one main event loop. Redis does not provide compute isolation: it coordinates exclusive phone leases, fencing, and rate reservations while independent transport event loops execute sends.

**How to apply:** Require a Redis TTL lease plus monotonic fencing token before assigning a phone to a transport worker; reject starts after lease expiry/token replacement. Keep provider invocation shard-local and ACK outcomes only after PostgreSQL persistence.