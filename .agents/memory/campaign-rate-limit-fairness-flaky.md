---
name: Rate-limit fairness test intermittently flaky
description: "multiple queues share route and phone throughput atomically" fails ~1/3 runs even in full isolation, unrelated to recent code changes.
---

The test `"multiple queues share route and phone throughput atomically"` (campaign-rate-limit.test.ts) asserts that 2 concurrently-claiming routes both receive claims (`both routes must share the phone limiter`). Confirmed by running it 3x in a row, in full isolation (no other workflow/process touching the DB, no code changes to campaign-queue.ts in that session), with 1 failure out of 3 runs.

**Why:** the test fires two waves of 24 concurrent `Promise.all` claims against a durable-scheduling-cursor design (`campaignRoutesTable.updatedAt` as rotation cursor) that is inherently timing-sensitive under real wall-clock/connection-pool contention; occasionally both waves converge on the same route before the cursor rotates instead of splitting across both routes.

**How to apply:** if this specific test fails, re-run it 2-3 times in isolation before concluding it's a regression. Only treat it as a real bug if it fails consistently (not ~1-in-3) or if you changed claim/candidate-selection logic in `campaign-queue.ts` in the same session.
