---
name: RBAC checks must be audited across every mutation on a resource, not just one
description: A permission rule enforced on one mutation (e.g. update) is easy to forget on sibling mutations (delete, invite) for the same resource.
---

When a resource has multiple mutation endpoints (create/invite, update, delete) and one of them encodes a rank-sensitive rule — e.g. "only an Owner can change/remove another Owner" — that rule is commonly implemented on the update route (role changes) but silently omitted from the delete route, because they're written and reviewed separately and a generic `requireRole("admin")` gate on the route looks sufficient at a glance.

**Why:** this produces a real privilege-escalation hole (a lower-privileged Admin can delete/remove a higher-privileged Owner even though they can't change that Owner's role) that typecheck, generic RBAC-scoping review, and even most manual e2e passes miss, because the sibling endpoint "looks protected" via its coarse role-rank middleware.

**How to apply:** whenever you add or find a fine-grained actor-vs-target rank check on one mutation for a resource with a role/rank hierarchy, explicitly re-check every other mutating endpoint for that same resource (create/invite, update, delete, bulk actions) for the identical actor-vs-target condition, and mirror both the server-side check and the corresponding UI affordance (e.g. hide the "Remove" control from users who couldn't actually perform it).
