---
name: Four-phone benchmark supply ceiling
description: Current Replit PostgreSQL profile under-feeds a four-phone 1,000-TPS target before transport safety limits are reached.
---

The production-shaped four-phone benchmark can complete and drain 63,600 simulated sends safely, but the current host/profile does not sustain 950 TPS per phone: the 256-job refill profile measured about 2,780 aggregate TPS. Increasing refill batches to 512 or 1,024 caused the startup progress gate to stall instead of improving throughput. The clean reproduction used the in-memory pacing coordinator, so it diagnoses single-process supply/refill behavior but does not benchmark Redis pacing latency.

**Why:** PostgreSQL claim/template preparation and refill startup latency, not provider-call safety, are the observed limiting boundary; larger batches amplify the initial refill delay.

**How to apply:** Treat this profile as a reliability result only until supply-side pacing is improved and repeated per-phone throughput gates pass. Do not call a benchmark process exit success a 1,000-TPS certification.