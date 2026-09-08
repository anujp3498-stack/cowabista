---
name: Drizzle chained .where() TypeScript error
description: Why a shared query-builder helper that pre-applies .where() breaks callers, and the fix.
---

A helper function that builds a Drizzle query and already calls `.where(...)` on it produces a TypeScript error (or the wrong runtime query) if a caller then chains another `.where(...)` on the result — Drizzle's builder types don't support re-narrowing an already-filtered query that way.

**Why:** Drizzle's fluent query builder changes its TS return type after `.where()` is applied; that returned type doesn't expose a compatible second `.where()` for further narrowing.

**How to apply:** expose a bare, unfiltered base query builder function (e.g. `baseQuery()`) from the shared helper, and require every caller to supply its own full condition via a single `.where(and(...))` call. Do not have the helper pre-apply any `.where()`.
