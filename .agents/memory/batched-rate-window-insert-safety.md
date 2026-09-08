---
name: Batched rate-window insert safety
description: Why grouped token reservations must validate insert amounts before relying on conflict predicates.
---

Reject a grouped token reservation when its requested amount exceeds the current route or provider limit before attempting the rate-window insert.

**Why:** An `ON CONFLICT ... DO UPDATE ... WHERE` ceiling only protects an existing window. A new window can accept the oversized initial value unless the application checks it first, allowing the first batch in a second to exceed a low-number cap.

**How to apply:** Any batched limiter that inserts-or-increments a counter must enforce the ceiling on both paths: validate the initial insert amount and retain the atomic conditional increment for conflicts.