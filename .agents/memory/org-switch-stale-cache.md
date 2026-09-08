---
name: Org/workspace switch must hard-reload, not just clear the query cache
description: Multi-tenant apps with a cookie-resolved "active organization" need a full page reload on switch, or permission/role UI goes stale across pages.
---

When the server resolves the current tenant/organization from a cookie (not a URL param or route segment), switching the active org on the client and relying on TanStack Query's `queryClient.clear()`/`invalidateQueries()` is not sufficient — some already-mounted queries refetch with the new org context and some don't, so pages can render a mix of old- and new-org data for a beat.

**Why:** this is dangerous specifically when a page derives an authorization decision (e.g. "can this user manage members") from query data — a stale read can render Owner/Admin-only controls for a user who no longer holds that role in the newly active org, i.e. a visible (if transient) permission bypass rather than just a stale label.

**How to apply:** for any "switch active tenant/org" action driven by a server-side cookie/session, do a full hard reload (`window.location.reload()` / `window.location.href` navigation) after the switch request succeeds, instead of relying purely on in-memory query cache invalidation.
