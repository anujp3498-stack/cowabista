---
name: Benchmark runtime lifecycle
description: Lifecycle requirements for temporary CampaignRuntime instances used by campaign benchmarks and diagnostics.
---

Any temporary CampaignRuntime created only to run recovery or setup work must be closed before the benchmark exits.

**Why:** Each runtime creates a transport worker pool, while dispatch metrics are process-global and keyed by shard ID. A leaked temporary runtime can continuously overwrite the real runtime's worker-status records (for example, replacing owned phone lists with empty lists) and can keep Node alive after the benchmark has already emitted its result.

**How to apply:** When tracing benchmark worker ownership, distinguish the workload runtime from setup/recovery runtimes. Close every temporary runtime before interpreting worker snapshots or treating a post-result hang as a workload failure.