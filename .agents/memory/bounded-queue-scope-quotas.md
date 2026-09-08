---
name: Bounded queue scans need scope quotas
description: Why a bounded global queue prefix can starve otherwise eligible work behind a saturated limiter scope.
---

A bounded claim scan must limit how many candidates each throttling scope can contribute before applying the global bound. For shared provider limits, preserve both route-level and phone-level quotas.

**Why:** Ordering by age and taking a fixed global prefix is bounded but not work-conserving: one old backlog on a saturated phone can occupy every candidate slot and hide eligible work on another phone indefinitely.

**How to apply:** When queue work has hierarchical limits, rank candidates within the narrow scope first, then within the shared scope, and only then apply the global candidate limit. Include a regression with more blocked jobs than the global limit and eligible work behind them.