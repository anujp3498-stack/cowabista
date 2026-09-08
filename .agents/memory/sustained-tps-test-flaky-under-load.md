---
name: Sustained per-number TPS test is flaky under container load
description: campaign-sustained-per-number-tps.test.ts can fail on its own, unrelated to code changes -- check before assuming a regression.
---

`campaign-sustained-per-number-tps.test.ts` ("three phone numbers with different configured TPS each sustain close to their own cap...") asserts a real wall-clock send rate (e.g. "high phone must reach ~18/s") over a several-second run. It failed reproducibly (~9-10/s instead of ~18/s) on both a commit that touched campaign-runtime code and the commit immediately before it, with no code difference explaining the drop -- i.e. it is sensitive to how much CPU/IO contention the container has at the moment it runs, not just to correctness.

**Why:** it measures actual throughput against a fixed numeric threshold instead of a relative/mocked clock, so anything that slows down wall-clock scheduling (other processes, a busy sandbox, concurrent test suites) can push it under the threshold with zero functional regression.

**How to apply:** if this test fails, re-run it in isolation (and ideally re-run it against the prior commit too) before concluding a change broke per-number TPS enforcement. A single failure here, with everything else green, is not strong evidence of a real bug on its own.
