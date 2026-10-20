# Wabista Nexus: notes for coding agents

Multi-tenant WhatsApp Business messaging and campaign platform: a pnpm monorepo with an Express 5 API
(`artifacts/api-server`), a React/Vite SPA (`artifacts/wabista-nexus`) and a Drizzle/PostgreSQL schema
(`lib/db`). Read `docs/ARCHITECTURE.md` for decisions and gotchas and `docs/DEVELOPMENT.md` for setup,
environment, commands and tests. Topic notes from earlier work are in `.agents/memory/` (index:
`.agents/memory/MEMORY.md`); notes dated before 2026-10-20 may describe the former Replit setup.

## User preferences

- Non-technical user, mixes Hindi/English; prefers work explained step by step and wants things actually implemented, tested, and verified — not just described.

## Hard rules

Production and shared infrastructure
- Never connect to, read from or write to the production database, never change Host S (the shared
  PostgreSQL/Redis host), never touch the production checkout `/opt/cowabista`, and never deploy, publish or
  merge into the production branch unless the user explicitly asks for that exact action.
- No force push, rebase or reset of shared branches. No pull request unless asked.

Database
- Schema work goes only through the guarded commands in `lib/db` (`push`, `apply-sql`,
  `reset-disposable-local`) against a disposable local database with `WABISTA_DB_TARGET=disposable-local`.
  Never bypass the guard: no bare `drizzle-kit`, no hand-made `WABISTA_DB_GUARD_STAMP`, no raw DDL through
  `psql` or another client against any shared, benchmark or production database.
- `push-force` exists only for the benchmark flow (`artifacts/api-server/benchmark`). Never use it for
  migrations, and never reset or drop a benchmark database unless the user runs that flow.
- Production schema changes are additive and are planned with the user; they are never pushed from here.

WhatsApp / Meta
- No live Meta or WhatsApp calls from development, tests or scripts. Use mock-mode workspaces and the tests'
  fake Graph server. Do not change Graph API versions or campaign runtime semantics without approval.

Secrets and identifiers
- Never commit `.env` or real keys; `.env.example` holds placeholders only.
- Never print or record secrets: Clerk keys, database passwords, tokens, signatures. Do not write real WABA,
  phone number, app, media, message (wamid) or upload-session ids into docs, logs, tests or commits.

Evidence and tests
- `docs/benchmarks/**` and `attached_assets/**` are frozen history; do not edit them. The Gate B
  measured-files hash (`measuredFilesSha256`, computed by `artifacts/api-server/benchmark/campaign-benchmark.ts`
  over that file, the measured services and `lib/db/src`) changes whenever those files change: say so
  whenever a change touches them.
- Do not change tests to hide regressions; change a test only when its contract changes on purpose, and say so.
- Verify before claiming: typecheck, the relevant builds and suites, and report failures with their output.
