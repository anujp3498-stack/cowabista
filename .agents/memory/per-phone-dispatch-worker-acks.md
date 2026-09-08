---
name: Per-phone dispatch worker acknowledgements
description: Correctness rules for isolated high-TPS phone schedulers, provider-boundary acknowledgements, and lease-safe prefetch.
---

Use one isolated pacing timeline per phone number. A scheduler “ready” message is not a send: the main thread must acknowledge at the exact provider-call boundary, and the worker must not advance from Promise release alone.

**Why:** Main-thread microtasks and provider preparation can delay or cluster the actual call after a worker grants a permit. Advancing on permit delivery makes telemetry look paced while real request initiation compresses. Conversely, leasing a scheduled slot too close to lease expiry lets recovery reap valid waiting work.

**How to apply:** Keep the per-phone rolling ceiling in the pacing worker, acknowledge immediately before the provider invocation, reset rather than replay after large stalls, and bound reservation lookahead so every leased slot retains a dispatch safety margin.

At 1,000 TPS, instrument worker-ready → provider-start separately from inter-send timing before blaming database continuity. A tiny handoff p99 with ~1.07 ms actual intervals means OS wake scheduling inside the pacing worker is the remaining ceiling; more DB prefetch cannot fix it.