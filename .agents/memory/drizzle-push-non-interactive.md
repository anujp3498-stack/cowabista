---
name: drizzle-kit push without a terminal, and the database guard
description: How schema pushes behave without a TTY, and why every schema change must go through the guarded lib/db commands (never a direct DDL client).
---

**Current rule (since 2026-10-20, Replit exit R1a).** Schema changes reach a database only through the guarded
commands in `lib/db`, against a disposable local database (`WABISTA_DB_TARGET=disposable-local`, created by
`pnpm --filter @workspace/db run reset-disposable-local`):

- `pnpm --filter @workspace/db run push` runs `drizzle-kit push` behind `lib/db/scripts/assert-safe-database.mjs`.
  `drizzle.config.ts` refuses any drizzle-kit run that the guard did not start, so a bare `drizzle-kit push` or
  `npx drizzle-kit ...` fails before connecting. `push-force` is for the benchmark flow only.
- Hand-written additive DDL goes through `pnpm --filter @workspace/db run apply-sql -- <file.sql>` (one
  transaction; DROP/TRUNCATE/DELETE/UPDATE/RENAME/REPLACE refused).
- Never apply DDL with `psql`, a database console or any other direct client, and never against a shared,
  benchmark or production database. Production schema changes are planned with the user.

Without a TTY, `drizzle-kit push` aborts with `Interactive prompts require a TTY terminal` whenever it has to ask
(possible renames, data loss), and in that case it has executed nothing (the prompt comes before execution).
The guarded `push` never adds `--force`. On a database that already has the schema it still re-emits the same
statements every time (drop and re-create of the six `gin_trgm_ops` indexes and of eleven foreign keys whose
names exceed 63 characters, plus four column defaults) and prints "Changes applied"; that is drizzle-kit 0.31
behaviour, not a schema change. `push -- --verbose --strict` prints the statements and applies nothing without
a terminal.

**Why:** an unguarded push or a direct DDL client is how a development change reaches the wrong database. The
guard refuses production (`cowabista`), benchmark databases, Host S, non-loopback hosts that are not approved,
production mode and unmarked databases.

**How to apply:** if a push aborts on a prompt, the disposable database can simply be re-created
(`reset-disposable-local`, then `push`); for additive changes that drizzle-kit cannot apply non-interactively,
write the DDL derived from the schema diff (`IF NOT EXISTS`, the Drizzle names) and run it through `apply-sql`,
then check with a guarded `push -- --verbose --strict`.

History: before 2026-10-20 this note recommended applying derived DDL through the Replit database tool's
`executeSql`. That path no longer exists and must not be recreated with another client.
