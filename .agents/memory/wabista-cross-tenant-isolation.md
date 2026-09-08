---
name: Cross-tenant isolation regression pattern
description: How Wabista Nexus guards and tests every org-scoped route against one tenant touching another tenant's rows, including after a workspace switch.
---

Every mutation that fetches a resource by ID under `req.organizationId`, then
mutates it in a second statement, must repeat the `organizationId` predicate
on the WRITE itself (`update(...).where(and(eq(id, x), eq(organizationId,
req.organizationId)))`), not rely solely on the preceding SELECT having
already proven ownership.

**Why:** a read-then-write-by-id-only split is safe today but is exactly the
kind of invariant a future refactor (e.g. someone extracts the fetch into a
shared helper, or reorders statements) can silently break without any type
error. Several routes (`members.ts` PATCH/DELETE, `invitations.ts` DELETE,
one branch of `campaign-routes.ts` PATCH) had this weaker "safe in practice,
fragile by construction" shape and were hardened to the atomic form.

**How to apply:** when adding or reviewing any org-scoped mutation, check
that the final DB write's WHERE clause includes `organizationId` alongside
the row id -- never id alone, even if an earlier ownership check already ran
in the same handler.

The backend resolves the active org fresh on every single request
(`attachOrgContext` re-reads the `wabista_active_org_id` cookie and
re-queries membership each time; there is no per-user server-side cache), so
a "stale permission after switching workspaces" bug is structurally
prevented on the backend by that statelessness rather than by anything
switch-specific. The regression coverage for this whole bug class lives in
`artifacts/api-server/test/cross-tenant-isolation.test.ts`: it builds two
full tenants with matching resources (contact, campaign, template, phone,
route, member, invitation) and asserts every mutation route 404s (never a
silent no-op or a leak) against a *real* resource id that belongs to the
other org, plus a same-request-shape "switch" test that flips
`organizationId`/`role` between calls and checks zero bleed both ways. Add a
new resource type to that file's `setUpTenant` fixture and repeat the
pattern when a new org-scoped table/route is introduced.
