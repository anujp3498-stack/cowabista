---
name: Scale-safe search filtering and paginated-list counting
description: Two patterns for hardening an offset-paginated list/search endpoint against "millions of rows" scale without changing its request/response contract.
---

## Pattern 1: replace a cross-table OR-ILIKE with a UNION of per-column trigram lookups

A single `WHERE ... AND (a.col ILIKE '%x%' OR b.col ILIKE '%x%' OR c.col
ILIKE '%x%')` spanning columns on different LEFT/INNER JOINed tables cannot
be driven by any one index, even if each column individually has a trigram
GIN index. Postgres has to materialize the join for every row in scope
(e.g. every job in a campaign) before it can evaluate the OR as a
post-join filter -- so search cost scales with the total row count in
scope, not with how selective the search term is.

Fix: run one small `SELECT id FROM ... WHERE scope AND col ILIKE term`
query per searchable column (each can use its own single-table trigram
index combined with the scope filter via BitmapAnd), then combine the
matching ids with `union(...)` (from `drizzle-orm/pg-core`), and feed that
into the outer query as `inArray(idColumn, unionQuery)`. Now search cost
scales with how many rows match the term, not with total rows in scope --
a selective search (a phone number, an error string) stays fast regardless
of how large the table has grown.

**How to apply:** any paginated search endpoint whose `search` filter is
an OR across columns from more than one joined table, once the base table
is expected to reach large row counts (log-style tables: delivery logs,
audit logs, message history).

## Pattern 2: merge count(*) + select into one windowed query

Running a separate `SELECT count(*) ... WHERE X` and `SELECT ... WHERE X
LIMIT/OFFSET` on every page request executes the same (possibly expensive,
joined) filter twice. Instead, add `count(*) OVER()::int AS total` as a
column on the main paginated select -- one query does both jobs.

Caveat: the window function only appears on rows that are actually
returned. If the page is empty (offset past the end of the matching set,
or truly zero matches), there is no row to carry the total, so that one
edge case must fall back to a plain `count(*)` query. This preserves exact
existing response semantics (`total` is always correct) while cutting the
common (non-empty-page) case from two scans/joins to one.

**How to apply:** any list/search endpoint that returns `{ total, limit,
offset, items }` and currently issues two separate queries for count and
rows.
