---
name: testing-subagent-as-committed-regression
description: How to get durable, re-runnable regression coverage for a frontend-only bug when the workspace has no Playwright/Vitest harness installed.
---

## The situation

A bug that only manifests in client-side behavior (e.g. a stale cache surviving a navigation/state transition, not reproducible by calling backend route handlers directly) needs regression coverage, but the frontend package has no test runner at all, and standing one up (installing Playwright/Vitest, wiring browsers, adding CI scripts) is disproportionate to a single regression check.

## The fix

Write the test as a fully-specified, deterministic testing-subagent task plan and commit it as a markdown file next to the feature it guards (e.g. `artifacts/<app>/test/<bug-name>-regression.md`), including:
- Why the check exists and exactly which code path it guards (file + function names).
- The full numbered `[New Context]/[Clerk Auth]/[Browser]/[DB]/[API]/[Verify]` step list, ready to paste verbatim into a `subagent({ config: { $kind: "testing" } })` call.
- Any schema/data details the tester needs (table/column names) so it doesn't have to explore first.
- A "Last verified" line updated each time it's actually re-run, with the verdict and date.

Prefer a `[DB]` step over trying to reconstruct awkward state through the UI/API when the app has no natural flow for it (e.g. giving the same test user a second organization membership with a specific role) — it's faster and more reliable than working around missing app-level affordances.

**Why:** this is a real, literally re-runnable regression check (any future agent can paste the plan and get the same verdict) without the cost of introducing a whole new test framework for one check. The task itself may explicitly sanction this ("via the testing subagent flow") as an acceptable "automated test."

**How to apply:** when asked for "automated" or "regression" coverage for a UI-only behavior and the project has no e2e test harness, default to this pattern rather than bootstrapping Playwright/Vitest from scratch — unless the user asks for CI-integrated testing specifically, in which case build the real harness instead.
