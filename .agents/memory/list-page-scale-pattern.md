---
name: list-page-scale-pattern
description: How to scale an org-scoped list page (e.g. a contacts/address-book screen) from unbounded client-side filtering to server-side pagination and search.
---

## The problem

A list page that started small often fetches the entire table for the org and does client-side `.filter()`/substring search in the browser, with no `limit`/`offset` and no backend index beyond a possible `organization_id` btree. This degrades linearly as the table grows and eventually ships megabytes of JSON per page load.

## The fix

1. **Server-side pagination**: add `limit`/`offset` (or cursor) query params to the list endpoint, clamp `limit` to a sane max (e.g. 100), and return a paged envelope `{ total, limit, offset, <items> }` instead of a bare array. Order by an indexed column (e.g. `(organization_id, created_at DESC)`).
2. **Server-side search needs `pg_trgm`, not just a btree**: a plain btree index can't accelerate `ILIKE '%term%'` (leading wildcard). Enable the `pg_trgm` Postgres extension and add `GIN` trigram indexes on the searched text columns (name/phone/email, etc.) — only then does substring search stay fast at scale.
3. **Debounce search input** on the frontend (e.g. 300ms) so a large indexed table doesn't get a full round-trip query per keystroke.
4. **Update the OpenAPI/zod contract** for the new query params and the new paged response shape, regenerate the client, and audit every existing test that asserted the old bare-array response shape (e.g. cross-tenant isolation tests) — changing a list endpoint's response envelope is a breaking contract change for any test/consumer using array methods like `.some()` directly on the response body.

**Why:** this is the exact shape Task #23 ("keep the contacts list fast as an org's address book grows") took in Wabista Nexus — the existing `suppressions.ts`/`suppressions.tsx` list already implemented this pattern, so it was cloned rather than invented from scratch.

**How to apply:** whenever asked to make a list/table page scale, check whether a sibling paginated list already exists in the codebase and mirror its envelope shape, param names, and test conventions before inventing a new one.
