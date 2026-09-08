---
name: Benchmark recovery gate isolation
description: Interpreting duplicate replacement attempts in the benchmark's abandoned-lease recovery check.
---

The abandoned-lease recovery fixture must be isolated from any competing runtime or claimant; an expected two attempts becoming three is a recovery/lifecycle failure, not throughput evidence.

**Why:** The single four-phone benchmark completed its 100,000-job workload, then failed the existing recovery assertion with three attempts instead of the expected two before result serialization.

**How to apply:** Preserve the exact recovery gate and treat any duplicate replacement attempt as a failed run. Do not rerun or tune the throughput path until the claimant isolation/lifecycle cause is separately investigated.