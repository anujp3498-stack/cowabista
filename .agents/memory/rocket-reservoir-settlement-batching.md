---
name: Rocket reservoir settlement batching
description: Why a DB-free transport loop can still starve if route capacity is released through per-message settlement.
---

Release route and reservoir transport capacity at provider completion, then persist the provider outcome and campaign settlement in a tracked asynchronous, exact-lease task. Batching settlement is necessary but not sufficient: the supply feeder must also avoid repeated empty PostgreSQL claims.

**Why:** Detaching settlement materially improved four-phone provider starts, but a feeder issuing mostly empty per-phone claims still accumulated sustained reservoir starvation. Redis and transport-worker CPU were not limiting; the claim/refill loop remained bursty.

**How to apply:** Track DB claim rate/idle ratio, settlement drain rate, provider-start rate, and starvation separately. Keep exact leased jobs recoverable, release transport capacity before settlement, and drive claims from durable queue demand rather than a polling loop that repeatedly returns empty.