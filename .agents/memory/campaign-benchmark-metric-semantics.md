---
name: Campaign benchmark metric semantics
description: Rules for keeping campaign capacity measurements distinct, reproducible, and safe to cite.
---

Count every queue claim call and every successful claim at the queue boundary. Report provider-send attempts and successful sends separately. A progress/liveness interval is not proof that a target throughput or worker-utilization level was sustained.

Enforce provider TPS ceilings against request-initiation timestamps, not response-completion timestamps. Provider latency can reorder or cluster acknowledgements even when outbound attempts are correctly paced; completion timing is useful telemetry but not an admission-control boundary.

**Why:** Post-claim send attempts can numerically resemble successful claims while excluding idle and failed claim work. Conflating them overstates queue throughput and makes a capacity report unsafe to cite.

**How to apply:** For every retained campaign benchmark, preserve the measured source/schema digest and profile, label each counter by its actual boundary, assert rolling ceilings at request initiation, and limit documentation claims to values directly present in that result.