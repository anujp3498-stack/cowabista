---
name: Background workflow worker races test suites sharing the dev DB
description: A live campaign-runtime worker (or any long-running workflow worker) polling for leaseable/queued rows can race and intermittently fail integration tests that create rows in the same states, in any test file -- not just one.
---

Confirmed (again) across two different test files (a campaign-lifecycle test and, separately, `campaign-rate-limit.test.ts`): when the API server's workflow is running, its background `CampaignRuntime` worker continuously polls the shared dev database for "Queued"/leaseable rows under "Running" campaigns. If an integration test creates rows in exactly those states as fixtures (even under an unrelated campaign/org), the live worker can claim/lease/mutate them mid-test, causing a flaky, non-deterministic test failure that has nothing to do with the code under test.

**Why:** tests and the dev workflow's worker share one Postgres database in this environment; there is no test-only DB isolation. Any test whose fixtures resemble "real work available to claim" is a candidate for this race, regardless of which test file it's in.

**How to apply:** if a backend integration test fails intermittently in a way that doesn't reproduce on isolated re-runs, stop the relevant workflow (e.g. the API server) before re-running the test suite to confirm it's this race rather than a real regression, then restart the workflow afterward. Don't chase a fix in the test/business logic based on a single flaky run without first ruling this out.

**Update 2026-10-20 (Replit exit, R1a):** there are no Replit workflows any more. The same race happens with any
API process that runs the campaign runtime against the same `DATABASE_URL`: a local
`pnpm --filter @workspace/api-server run dev`, or the API that Playwright starts. Stop it before DB-backed
suites, or give the suites their own disposable database (`DATABASE_URL` with another name, then
`pnpm --filter @workspace/db run reset-disposable-local` and `push`).
