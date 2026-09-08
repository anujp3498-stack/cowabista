---
name: Persisted reservoir fix still has warm gate
description: Benchmark behavior of the persisted reservoir implementation in the WabistaSpeed source archive.
---

The persisted fixed reservoir implementation still gates broker consumption on the lane warm-water threshold. It is not equivalent to an immediate consume-and-drain implementation.

**Why:** A four-phone, 1,000-TPS, 15-second run reached the existing no-progress gate after publishing work while each lane was below its low-water mark; no final benchmark JSON was emitted.

**How to apply:** Before treating an archived fixed source as the immediate-consume fix, compare the persisted source and patch directly. If the warm gate remains, report the certification run as failed rather than substituting a temporary checkout change or rerunning after tuning.