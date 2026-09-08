---
name: Production-shaped campaign benchmarks
description: Conditions required for campaign throughput measurements to represent the real Plan→Execute send path.
---

Campaign throughput evidence is only comparable when generated jobs carry the frozen plan identifier, frozen template and TPS fields used by production Execute, the API/runtime workers are stopped for database-compute isolation, the recorded source hash is clean, and the harness drives the same adaptive runtime loop used in production.

**Why:** Directly inserted legacy jobs exercise a slower template-resolution path, a live API worker can contend with the benchmark database, and direct `processBatch()` loops bypass adaptive lane/tick behavior; any of these can invalidate conclusions about production runtime performance.

**How to apply:** Treat worker count, routes, phones, provider delay/cap, database profile, sustained window, and source cleanliness as part of every result. Do not extrapolate a staged result to million-contact capacity or provider TPS.