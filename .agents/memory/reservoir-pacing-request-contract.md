---
name: Reservoir pacing request contract
description: The bounded request-size invariant shared by reservoir refills and the pacing coordinator.
---

The reservoir's maximum claim batch must remain at or below the pacing coordinator's maximum reservation request.

**Why:** The coordinator validates the requested slot count before doing any database work. If the reservoir grows its claim cap independently, a refill rejects immediately and can retry indefinitely without producing useful queue work.

**How to apply:** When changing reservoir batch limits, import and reuse the coordinator's exported request bound. Add a test that exercises the real reservoir-to-worker-to-coordinator path; stubbed reservoir tests do not catch this mismatch.