---
name: Post-publish consume must drain
description: The coupled handoff requirements for prepared broker work after publication.
---

After prepared work is published, the reservoir must call both consume and drain immediately; removing only the warm-state guard can leave valid envelopes queued with no provider start.

**Why:** A regression test caught the intermediate failure where consume ran below low-water but the adjacent drain call had been removed with the conditional block. The lane showed one queued envelope and zero provider starts.

**How to apply:** Treat post-publish consume and drain as one handoff unit. Regression coverage should assert both broker consumption and provider transport start while broker depth remains below low-water.