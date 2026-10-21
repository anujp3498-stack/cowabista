# Local development

How to run Wabista Nexus on a normal machine (Linux, macOS or WSL) without any hosting platform. Architecture
and product decisions are in `docs/ARCHITECTURE.md`; rules for coding agents are in `CLAUDE.md`.

## Layout

| Path | What it is |
|---|---|
| `artifacts/api-server` | Express 5 API, everything under `/api`. Bundled with esbuild to `dist/index.mjs`. |
| `artifacts/wabista-nexus` | React SPA (Vite). Calls the API with relative `/api/...` URLs. |
| `lib/db` | Drizzle schema (source of truth for tables) and the guarded schema commands in `lib/db/scripts`. |
| `lib/api-spec`, `lib/api-client-react` | OpenAPI spec and the Orval-generated client (`pnpm --filter @workspace/api-spec run codegen`). |
| `deploy/` | Production configuration: systemd cells, PostgreSQL/Redis settings, `nginx/wabista.conf.example`. |

## Prerequisites

- Node.js 24 (`.nvmrc`; at least 22.12, see `engines` in `package.json`).
- pnpm 10.33.0: `corepack enable && corepack prepare pnpm@10.33.0 --activate`.
- PostgreSQL 16 with the contrib extensions (`pg_trgm`), running locally.
- Optional: Redis 7 (only for production mode and the Redis-backed test suites), Python 3 (benchmark
  analysers only), Chromium for browser tests (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` or Playwright's own browser).

```bash
pnpm install --frozen-lockfile
cp .env.example .env        # then edit .env; it is git-ignored and must never be committed
```

## Environment

The repository-root `.env` holds local settings. It is read by the API dev script (`node --env-file-if-exists`),
by `vite.config.ts` (`envDir` is the repository root), by `playwright.config.ts`, and by the guarded `push`,
`apply-sql` and `reset-disposable-local` commands. A variable already set in the shell always wins. Other
commands read only the shell: the API `start` script and the API test suites (`test:*`). For those, export the
file first, for example `set -a && . ./.env && set +a`. `.env.example` lists the development variables with
placeholders only.

| Variable | Used by | Default / notes |
|---|---|---|
| `DATABASE_URL` | API, tests, database commands | Required. A disposable **local** database (see below). |
| `WABISTA_DB_TARGET` | database commands | Must be `disposable-local` for `push`, `apply-sql`, `reset-disposable-local`. Give it per command (below); it is commented out in `.env.example` on purpose. |
| `PORT` | API | `8080`. If you change it, set `API_PROXY_TARGET` to match. |
| `LOG_LEVEL` | API | `info`. |
| `CORS_ALLOWED_ORIGINS` | API | Empty. Comma-separated **full origins** (`https://app.example.com`, `http://localhost:24902`); a malformed entry (a bare host name, a path, a `*` wildcard) stops the server at startup. Not needed when the SPA and API share an origin. Before 2026-10-20 bare host names were accepted: convert any existing value before deploying. |
| `TRUST_PROXY` | API | `1` (one reverse-proxy hop: nginx or the Vite proxy). `0` when clients connect directly. |
| `WEB_PORT` | web dev server / preview | `24902`. |
| `BASE_PATH` | web build | `/`. |
| `API_PROXY_TARGET` | web dev server / preview | `http://localhost:8080` (it does not follow `PORT`); where `/api` is proxied. |
| `WEB_ALLOWED_HOSTS` | web dev server | Empty (localhost and IP addresses are accepted). |
| `BETTER_AUTH_SECRET` | API, E2E | Required: at least 32 random bytes (`openssl rand -base64 32`); the API refuses to start without it, with a short or placeholder value, or with `BETTER_AUTH_SECRETS` set. Changing it signs everyone out. |
| `BETTER_AUTH_URL` | API, E2E | Required: the browser origin of the app, `http://localhost:24902` in development (open the app on exactly that origin). https in production. `BETTER_AUTH_TRUSTED_ORIGINS` and a truthy `BETTER_AUTH_TELEMETRY` are refused; extra browser origins go in `CORS_ALLOWED_ORIGINS`. |
| `API_RATE_LIMIT_MAX_PER_MINUTE` | API | Optional; the limiter's default applies when unset. |
| `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` | API | Optional. 32 bytes, base64 or hex (`openssl rand -base64 32`). Without it the manual "Connect number" flow answers 503. |
| `WHATSAPP_APP_ID` | API | Optional. Only for media template header examples; without it the template-media endpoint answers 503 `media_not_configured`. |
| `CAMPAIGN_MEDIA_STORAGE` | API | Optional; unset means no media storage (uploads answer 503). `local` uses `CAMPAIGN_MEDIA_STORAGE_DIR` (an absolute directory; refused with `NODE_ENV=production`); `s3` uses an S3-compatible bucket (MinIO on the dedicated servers). A DIR or S3 setting without the selector, or a half-configured `s3` block, stops the API at startup. Since R1b (2026-10-21) an `.env` that set only `CAMPAIGN_MEDIA_STORAGE_DIR` also needs `CAMPAIGN_MEDIA_STORAGE=local`. |
| `CAMPAIGN_MEDIA_S3_BUCKET`, `CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID`, `CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY` | API | Required with `CAMPAIGN_MEDIA_STORAGE=s3`. Explicit credentials only (the AWS default credential chain is never used). |
| `CAMPAIGN_MEDIA_S3_ENDPOINT`, `CAMPAIGN_MEDIA_S3_REGION`, `CAMPAIGN_MEDIA_S3_PREFIX`, `CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE` | API | Optional with `s3`: a full origin without a path (omit for AWS), region `us-east-1`, prefix `campaign-media` (empty for the bucket root), path-style on whenever an endpoint is set. |
| `CAMPAIGN_COORDINATOR_MODE`, `CAMPAIGN_REDIS_URL` (fallback `REDIS_URL`) | API | In-memory coordinator by default; Redis is required only with `NODE_ENV=production`. |
| `E2E_BASE_URL`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | browser tests | See Tests. |

`NODE_ENV` is deliberately not in `.env`: the API dev script sets `NODE_ENV=development` itself, and a
`NODE_ENV` in `.env` would leak into `vite build`.

Authentication: Better Auth (email and password) runs inside the API against your local database, so signing
up and signing in locally need no external service. Create an account at http://localhost:24902/sign-up
(passwords: 12 to 128 characters). Development accounts are disposable; Clerk (used until 2026-10-21) is gone
and its users are not migrated. Invitations: the admin copies the invite link from Team & Roles; the invitee
opens it, signs in or signs up with the invited email, and accepts.

## Database

Schema work only ever targets a **disposable local** database. The guard in
`lib/db/scripts/assert-safe-database.mjs` runs in front of every schema command and refuses:

- `NODE_ENV=production`, or `WABISTA_DB_TARGET` not set to `disposable-local`;
- the production database (`cowabista`), `campaign_benchmark`, any name containing `bench`, `postgres`,
  `template*`, and anything in `WABISTA_DB_DENY_NAMES`;
- Host S (`host-s`, `10.0.0.4`, or any host name resolving to it) and anything in `WABISTA_DB_DENY_HOSTS`,
  even if also approved;
- any non-loopback host not listed in `WABISTA_DB_APPROVED_DEV_HOSTS`;
- `PGSERVICE`, `PGSERVICEFILE`, `PGHOSTADDR`, multi-host URLs, Unix-socket URLs and URL query parameters other
  than the TLS/`application_name`/`connect_timeout` ones (they can redirect a connection);
- after connecting: a different `current_database()` than requested, a non-loopback or denied server address,
  or a database without the comment `wabista:disposable-local`.

`lib/db/drizzle.config.ts` refuses any drizzle-kit run that loads it unless the guarded `push.mjs` started it,
so `drizzle-kit push` (or `npx drizzle-kit ...`) with the config fails before connecting. drizzle-kit skips the
config entirely when credentials are given on its command line (`--url`, `--dialect`, ...): never run
drizzle-kit directly. Guard refusals in `push`, `apply-sql` and `reset-disposable-local` exit with code 2; a
`drizzle.config.ts` refusal exits non-zero through drizzle-kit. Neither prints a password.

Limit: an SSH tunnel or port-forward that ends on another server's own loopback (`ssh -L
5432:localhost:5432 host`) looks local to every check. Existing databases there lack the disposable marker, so
they are never pushed to or dropped, but `reset-disposable-local` could create a new database on that server.
Never run these commands through a tunnel.

First-time setup (the `DATABASE_URL` role needs `CREATEDB`; `.env` has
`DATABASE_URL=postgresql://wabista:<password>@localhost:5432/wabista_dev`):

```bash
WABISTA_DB_TARGET=disposable-local pnpm --filter @workspace/db run reset-disposable-local   # creates (or drops and re-creates) wabista_dev and marks it disposable
WABISTA_DB_TARGET=disposable-local pnpm --filter @workspace/db run push                     # guarded drizzle-kit push; also creates pg_trgm
```

`reset-disposable-local` works on loopback servers only and never drops a database that lacks the disposable
marker. To start over, run it again, then `push`.

| Command | Purpose |
|---|---|
| `pnpm --filter @workspace/db run push` | Push the Drizzle schema (`lib/db/src/schema` and the Better Auth tables in `lib/db/auth/src`) to the disposable local database. No `--force`: drizzle-kit aborts instead of asking about renames or data loss without a terminal. On a database that already has the schema it re-emits the same statements every time (drop and re-create of the six `gin_trgm_ops` indexes and of eleven foreign keys whose names exceed PostgreSQL's 63-character limit, and four column defaults) and prints "Changes applied"; that is drizzle-kit 0.31 behaviour, not a schema change. `pnpm --filter @workspace/db run push -- --verbose --strict` prints the statements and asks before applying (without a terminal it applies nothing); compare them with that set. |
| `pnpm --filter @workspace/db run apply-sql -- <file.sql>` | Apply hand-written **additive** SQL (CREATE TABLE/INDEX/SEQUENCE, CREATE TYPE ... AS ENUM, CREATE EXTENSION IF NOT EXISTS pg_trgm or pgcrypto, ALTER TABLE ... ADD, ALTER TYPE ... ADD VALUE, COMMENT ON) in one transaction, one statement at a time. DROP, TRUNCATE, DELETE, UPDATE, RENAME, REPLACE, SELECT, INSERT, MERGE and other query forms, INHERITS, PARTITION OF, side-effecting built-in functions (`pg_*`, `dblink`, `lo_*`, ...), DO blocks, dollar quoting, `U&` and `E''` escapes and block comments are refused. `--check` validates without connecting. It guards against accidents on a disposable database; it is not a sandbox for untrusted SQL. |
| `pnpm --filter @workspace/db run reset-disposable-local` | Create or re-create the marked local database. |
| `pnpm --filter @workspace/db run push-force` | **Benchmark flow only** (`artifacts/api-server/benchmark/run.mjs`, `benchmark/distributed/prepare.sh`): requires `DATABASE_URL` equal to `CAMPAIGN_BENCHMARK_DATABASE_URL`, a database name with a bench/benchmark segment and `CAMPAIGN_BENCHMARK_CONFIRM` set to that name, and refuses `NODE_ENV=production`. It cannot reach any other database and is never used for migrations. `prepare.sh` drops and re-creates its database (and flushes Redis) before calling it, so before running `prepare.sh` set `CAMPAIGN_BENCHMARK_CONFIRM` (as `benchmark/distributed/README.md` says) and use a name with a bench/benchmark segment such as `campaign_benchmark`; that is stricter than `prepare.sh`'s own `*bench*` check. |
| `pnpm --filter @workspace/db run test:guard` | Unit tests for the guard (no database needed). |

None of these commands is for production: they refuse the production database and production mode.

## Run

```bash
pnpm --filter @workspace/api-server run dev     # builds, then serves the API on http://localhost:8080 (reads .env)
pnpm --filter @workspace/wabista-nexus run dev  # SPA on http://localhost:24902; /api is proxied to API_PROXY_TARGET
```

Open http://localhost:24902. Only `/api` and `/api/...` are proxied: `/api-developers` is an SPA route.
`pnpm --filter @workspace/wabista-nexus run build` writes `artifacts/wabista-nexus/dist/public`, and
`pnpm --filter @workspace/wabista-nexus run serve` previews that build with the same `/api` proxy. A production
build needs no authentication variables; `BASE_PATH` stays `/` for the nginx layout.

Other commands: `pnpm run typecheck`, `pnpm run build` (typecheck + every package build),
`pnpm --filter @workspace/api-spec run codegen` after changing the OpenAPI spec.

## Tests

| What | Command | Needs |
|---|---|---|
| Typecheck | `pnpm run typecheck` | nothing |
| SPA unit tests | `pnpm --filter @workspace/wabista-nexus run test:unit` | nothing |
| Render harness | `HARNESS_OUT=<absolute dir> pnpm --filter @workspace/wabista-nexus exec vite build --config vite.harness.config.ts`, then `HARNESS_OUT=<same dir> node artifacts/wabista-nexus/test/harness/render-<name>.mjs` (an absolute directory: the two steps resolve a relative one differently) | Chromium (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` or Playwright's browser) |
| API unit tests | `pnpm --filter @workspace/api-server run test:unit` | nothing (placeholder `DATABASE_URL`) |
| API CORS / proxy settings | `pnpm --filter @workspace/api-server run test:cors` | any `DATABASE_URL` value (no connection is made) |
| DB-backed API suites | `pnpm --filter @workspace/api-server run test:<name>` | a disposable local database in an exported `DATABASE_URL` (the suites do not read `.env`); some suites also `CAMPAIGN_TEST_REDIS_URL` |
| Database guard | `pnpm --filter @workspace/db run test:guard` | nothing |
| Browser end-to-end | `pnpm --filter @workspace/wabista-nexus run test:e2e` | a disposable database, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`, Chromium |

Run DB-backed suites one at a time against a database you can throw away; several suites create and delete
their own rows and some measure timing. Never point any test at a shared, benchmark or production database.

End-to-end tests: with `E2E_BASE_URL` unset, Playwright starts the API (`PORT`, default 8080) and the web dev
server (`WEB_PORT`, default 24902), reusing ones already listening, and drives `http://localhost:24902`. With
`E2E_BASE_URL` set it starts nothing and drives that deployment. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects a
Chromium binary; otherwise install Playwright's own with
`pnpm --filter @workspace/wabista-nexus exec playwright install --with-deps chromium`. The specs create their
own Better Auth accounts (random passwords, never printed) and delete them afterwards; Better Auth allows 3
sign-ups and 3 sign-ins per 10 seconds per client address, so keep new specs within that.

No test, script or development flow may call Meta or WhatsApp for real. Use mock-mode workspaces, and the fake
Graph server the test suites start (`CAMPAIGN_TEST_GRAPH_BASE_URL`, tests only).

## Reverse proxy and servers

The browser must see the SPA and the API on one origin. `deploy/nginx/wabista.conf.example` serves the built SPA
at `/` with history fallback to `index.html` and proxies `/api/` (prefix kept) to the API on port 8080. With
that layout no `CORS_ALLOWED_ORIGINS` entry is needed and `TRUST_PROXY=1` is correct. The API listens on all
interfaces, so keep its port unreachable from outside (firewall or private network): with `TRUST_PROXY=1` a
client that reaches it directly could set its own `X-Forwarded-For` and pick its rate-limit bucket. The
campaign transport cells are described in `deploy/README.md`; their environment files take
`CORS_ALLOWED_ORIGINS` in the full-origin form above.

## Campaign media storage

Campaign media bytes (Message Studio uploads) go to the backend chosen by `CAMPAIGN_MEDIA_STORAGE` (table above).
Locally, `CAMPAIGN_MEDIA_STORAGE=local` with `CAMPAIGN_MEDIA_STORAGE_DIR` is enough. Production uses `s3`
against a private MinIO (or AWS) bucket; where MinIO runs, its TLS and its credentials are operator decisions
for the cutover and are not in this repository. The bucket needs no public access and no CORS: the API is the
only client (upload, read for the provider upload at planning, streamed preview, delete). The previous
platform's object-storage sidecar (`PRIVATE_OBJECT_DIR`) is no longer read, and this repository does not copy
objects stored there: any production media still needed must be copied into the bucket under the same keys (or
re-uploaded) during the cutover. The store tests run against an in-process fake S3;
`CAMPAIGN_TEST_S3_ENDPOINT=http://127.0.0.1:<port>` additionally runs the same contract against a local S3
emulator such as moto or MinIO (`pnpm --filter @workspace/api-server run test:media-storage`).
