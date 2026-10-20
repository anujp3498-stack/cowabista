---
name: pgcrypto extension not enabled on Replit Postgres
description: gen_random_bytes()/gen_random_uuid() fail on this project's database; use md5(random()::text || clock_timestamp()::text) instead for DB-generated random tokens/defaults.
---

Calling `gen_random_bytes(...)` (or `gen_random_uuid()`) in a Postgres DDL/DML statement fails with `function gen_random_bytes(integer) does not exist` on this project's database — the `pgcrypto` extension is not enabled, and `CREATE EXTENSION` was not attempted/available in this flow.

**Why:** these functions live in `pgcrypto`, which isn't installed by default here. Reaching for them (e.g. to backfill a new unique random column, or as a column `DEFAULT`) breaks non-interactively with an opaque "function does not exist" error that looks like a typo, not a missing extension.

**How to apply:** for a random-token backfill or column default that doesn't need cryptographic strength (e.g. an invite-link token, a filler unique key), use `md5(random()::text || clock_timestamp()::text || <row-identifying-column>::text)` instead — built-in, no extension required, and unique enough for non-security-critical tokens. Reserve app-level `randomUUID()` (Node `node:crypto`) for values that actually need cryptographic randomness; only fall back to the SQL-side `md5(...)` expression for DB defaults/backfills that must be generated inside Postgres itself.

**Update 2026-10-20 (Replit exit, R1a):** this was observed on the former Replit-managed database. On the
self-managed PostgreSQL 16 used now, `gen_random_uuid()` is built in (core since PostgreSQL 13; verified on a
local PostgreSQL 16), while `gen_random_bytes()` still needs the `pgcrypto` contrib extension, which the schema
does not create (only `pg_trgm`, created by the guarded push). Keep the existing `md5(...)` defaults, such as
`organization_invitations.token`, unless a schema change is planned for them.
