---
name: Benchmark preflight versus reproduction
description: How to classify benchmark attempts when setup validation fails before runtime.
---

Only a run that completes setup and enters the benchmark workload should be counted as a reproduction. Database-name validation, missing disposable databases, schema setup, clean-source checks, and build/typecheck failures are preflight outcomes and must be reported separately.

**Why:** Treating setup rejections as benchmark runs obscures whether runtime telemetry actually exists and can lead to blind reruns or false conclusions about the blocking subsystem.

**How to apply:** Record each preflight rejection independently, then count and analyze only the bounded run that reaches the worker-progress or certification logic.