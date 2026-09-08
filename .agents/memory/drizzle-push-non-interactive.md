---
name: drizzle-kit push fails non-interactively in this environment
description: "Interactive prompts require a TTY terminal" when running `drizzle-kit push` (or the package's `push`/`push-force` script) from the agent shell, and what to do instead.
---

`drizzle-kit push` needs an interactive terminal whenever it has to disambiguate schema changes (e.g. "is this a brand-new table/column, or a rename of an existing one") — even for purely additive changes (new nullable columns, new tables) with no plausible rename candidate. In this agent's shell (no TTY), it always fails with `Interactive prompts require a TTY terminal`, and piping input (`yes | ...`) does not help because the failure is `stdin.isTTY`/`stdout.isTTY` being false, not a missing keystroke.

**Why:** this makes it look like schema changes merged from elsewhere (e.g. a task-agent's new tables/columns) never reached the dev database, when the real issue is just that the push tool can't run here.

**How to apply:** when `pnpm run push` / `drizzle-kit push` fails with the TTY error, diff the schema file against git history (or the last known-good commit) to get the exact set of new/changed tables and columns, then apply the equivalent DDL directly via the database skill's `executeSql` (e.g. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, matching index/constraint names from the Drizzle schema) as a single multi-statement script. Keep it strictly additive/idempotent (`IF NOT EXISTS` everywhere) so it's safe to re-run. This is a dev-database workaround only — production schema changes still go through the Publish flow per the database skill, never a hand-written migration script.
