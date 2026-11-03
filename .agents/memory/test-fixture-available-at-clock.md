---
name: Test fixtures must set available_at from the app clock
description: A job inserted with the available_at default (PostgreSQL now(), microseconds) and claimed at once with an app Date (milliseconds) can look 0-999 µs in the future and is skipped; set availableAt: new Date() in fixtures.
---

The claim predicate is `available_at <= $now`, with `now` an app `Date` (millisecond precision, truncated). A fixture
that inserts campaign jobs with the column default (`now()`, microseconds) and claims them immediately can land in
the same millisecond: the last-inserted job then reads as not yet available and the claim returns one job short
(CI on 2026-11-03: `test:suppression-batch-scope` F, "fixture jobs must all be claimable: 5 !== 6"). Reproduced
deterministically: a claim at the same millisecond as the last insert missed it 20/20 times with the default and
0/20 with an app-written available_at; 93.5% of statements here read a now() later than the app Date taken right
after they return.

**Why:** precision mismatch between the database default and the app clock, not a product defect (in production
the job is claimed on the next pass).

**How to apply:** in a test fixture whose jobs are claimed one-shot with an app `now` right after creation, write
`availableAt: new Date()` explicitly (seven suites were fixed this way). Suites that claim in retry loops or at
`now + 1 s` are immune. A similar trap: two unscoped `processOne()` workers race on `FOR UPDATE SKIP LOCKED`, so
never assert which worker recovers which job (campaign-worker-crash-recovery.test.ts).
