# Wabista Nexus: P6 production cutover runbook

**Release `<REL>`:** `2a2afe6a2890da949947112e514236bc823935f1` (branch `wabista-nexus-v2`): `e37ab27e` plus the approved Option 2a change (closed public sign-up, operator account command, change-password), the cell guard fix (`f967bd7`: the scope-overlap check now sorts both lists before `comm`, so overlaps between multi-digit phone ids are refused) and the relocatable build fix (`2a2afe6`: pino's worker files are resolved next to the running bundle, not from the build directory, so a build is byte-identical at any path and keeps working after cutover W6 renames the tree). No schema change, no Gate B file. Application source is unchanged since `f967bd7`; the build fix changes only the API build configuration (`build.mjs`, `build-pino.mjs`). **Production code:** `d22a8e43` (branch `claude/wabista-nexus-tps-regression-lqp5ap`).

**Status: preparation complete; production not touched.** Nothing here has been run against production, its database, `/etc/cowabista`, its services or Meta. All database scripts were exercised on disposable local lab databases, and the whole sequence (window, acceptance, finalize, rollback R2 with `d22a8e43` running, roll-forward) passed a synthetic dress rehearsal on 2026-10-22 (`package/README.md`; generated evidence files are not committed). Gate B's measured files and evidence are untouched. **The operator's single ordered checklist is `FINAL-SEQUENCE.md`; the environment is `ENV-MANIFEST.md`; the read-only production discovery kit is `package/discovery/`.**

## Decisions

| # | Decision | State | Where |
|---|---|---|---|
| U1 | Who serves production HTTP today, and which old runtimes run (Replit deployment and/or cells) | **Open: explicit read-only pre-cutover operator gate**, collected with `package/discovery/` (one pass on M, C, D, N and S). The repository cannot prove it (see "U1: evidence required" below). The release supports only nginx → cells; every old runtime, Replit included, stops in the window and stays stopped | Below; cutover P1; env §8 |
| U2 | Public sign-up (D4) | **Decided 2026-10-22: Option 2a, implemented in `<REL>`.** Public self sign-up is closed (`AUTH_PUBLIC_SIGN_UP` unset; `open` is refused in production). Accounts are created by an operator with `dist/auth-admin.mjs` (temporary password shown once on a terminal, never logged or stored in plaintext); users change it at Account menu → Change password, which ends every other session. No SMTP and no email verification in this release | Sign-up section |
| U3 | Existing Clerk users | **Decided 2026-10-22 by rule: Path A if inventory 11 shows no meaningful users, otherwise Path B1 (default). B2 is not needed** (no authorization depends on the user id beyond membership; Clerk-users section). The rule is applied when `inventory/11_user_inventory_readonly.sql` (counts only) has run in the authorized pre-cutover phase. No code either way | Clerk-users section |
| U4 | Media storage | **Decided 2026-10-22: an external S3-compatible provider for launch**, configured only through the vendor-neutral `CAMPAIGN_MEDIA_S3_*` settings (endpoint, bucket, region, access key, secret key, optional path-style flag). Not provisioned or connected yet; the owner provisions it before the window. MinIO stays an alternative or later option. Media upload is part of acceptance | Media section |
| U5 | Live connector campaigns still queued or scheduled | Each one is finished before the window or cancelled by its owner (inventory 12 must exit 0) | Connector section |
| U6 | Rehearsal on a restored production backup | Operator only, isolated host, your explicit approval, copy destroyed afterwards | `package/README.md` |
| U7 | Maintenance window time and user notice | About 100-130 min plus *D* (dump), *Mg* (migration) and *B* (startup backfill) from the rehearsal, plus the DNS TTL if the domain moves (cutover, "Expected durations"). Clerk sessions end and there is no password migration; people get operator-created accounts (U2) and their old workspaces per U3 | Cutover |
| U8 | When to reopen to everyone | **Default: limited reopen at W13 (approved owners only), general reopen at W14 after the first approved live send is delivered.** Alternative, approved explicitly at GO #1: reopen to everyone at W13. If no legacy number can be reconnected in scope (Path A, no live workspace, or L1/L2 deferred), the user chooses at GO #1 between U8 and W14 right after W13 | Cutover W13/W14; acceptance "Reopen" |

**Encryption key rule (mandatory).** If production holds encrypted WhatsApp credentials, the existing `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` is preserved byte-for-byte and never replaced. A new key is permitted only when `inventory/15_credential_key_inventory_readonly.sql` reports zero credentials needing the old key (it prints counts and key versions only, never a token or a decrypted value). Details: environment §7.

## U1: evidence required (read only; operator, with the user's go-ahead; collected in cutover P1)

What the repository already shows (no host was inspected):
- `d22a8e43:.replit` configures a Replit **Autoscale** deployment (`[deployment] deploymentTarget = "autoscale"`) and a post-merge hook that runs an unguarded `drizzle-kit push` (blocker 1a).
- At `d22a8e43` WhatsApp access goes through the Replit connector (`@replit/connectors-sdk`, `new ReplitConnectors()`); whether it works outside Replit is unknown (rollback Q4).
- `d22a8e43` also ships the systemd cell units and guard (`deploy/systemd/`), but no nginx front; `deploy/nginx/wabista.conf.example` is new in the release.
- The repository instructions name a production checkout `/opt/cowabista` and Host S (shared PostgreSQL and Redis). Whether that checkout runs, and what serves the public domain, is not recorded anywhere in the repository.

U1 is resolved only when all of these are recorded (values that are secrets are never recorded: hosts, ports, names and counts only):

| # | Evidence | Command or place |
|---|---|---|
| E1 | Where the public domain points | `dig +short <APP_DOMAIN>` (A/AAAA/CNAME), and whether it is a custom domain on Replit or a `*.replit.app` name |
| E2 | Whether a Replit deployment is published, its commit, type (Autoscale or other), instance limits, and the host:port/database of its `DATABASE_URL` and Redis URL (never the password); same for the Replit workspace secrets | Replit UI (deployment and workspace), read only |
| E3 | Every client of the production PostgreSQL and Redis, by address and application | On S: `pg_stat_activity` grouped by `client_addr, usename, application_name` (no query text); `redis-cli CLIENT LIST` addresses; distinct `campaign:ownership:*:owner` runtimes (cutover P1) |
| E4 | Whether cells run on C and D, at which commit and scope | On C and D: `systemctl list-units --all 'campaign-cell@*'`, `systemctl is-enabled`, `git -c safe.directory=/opt/cowabista -C /opt/cowabista rev-parse HEAD`, the guard `OK host=… scope=…` journal line, `ss -ltnp` for the cell port |
| E5 | Whether an nginx host (N) serves the domain, and where it proxies | On N: `nginx -T` (server_name, root, proxy_pass lines only) and the certificate subject for `<APP_DOMAIN>` |
| E6 | Where Meta sends webhooks today | Meta App Dashboard, read only: the Callback URL host |

Decision rule: every PostgreSQL and Redis client in E3 must map to a host found in E2/E4/E5 (an unknown client is a no-go). If E1/E6 point at Replit, the window follows **front A** (rollback §10; DNS move, P2/W10); if they point at N with cells behind it, **front B**. Any running old runtime (Replit Autoscale instances, cells at `d22a8e43`) is stopped in W3 and stays stopped. Record the answer in the change record before the window is booked.

## Cutover blockers (must be cleared before the window; none is an application defect)

1. **U1 evidence (E1-E6) recorded** and P1's client inventory maps every PostgreSQL and Redis client to a known host.
1a. **No Replit workspace or deployment can reach the production database by migration time.** At d22a8e43, `.replit` runs `scripts/post-merge.sh` after every merge, and that runs `pnpm --filter db push`: an unguarded `drizzle-kit push` of the old schema. Against the migrated database it would try to drop every V2 and Better Auth table. Remove that `DATABASE_URL` from the Replit secrets, or block the access, before W5 (verified at `d22a8e43:.replit:18-20`, `d22a8e43:scripts/post-merge.sh:3-4`).
2. **U3 recorded** from inventory 11 (counts only) with the rule above: A or B1. Neither needs code.
3. Inventory 12 exits 0 at window start (no live campaign with queued work or a schedule).
4. Secrets staged identically on both cells (`*.env.next`), checked by salted fingerprint only: `BETTER_AUTH_SECRET` is new; `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` follows the **encryption key rule** (inventory 15: preserve byte-for-byte, or new only with zero credentials); `META_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` carry over; `AUTH_PUBLIC_SIGN_UP` absent.
5. **U4 storage provisioned by the owner:** the external S3-compatible bucket and a least-privilege key exist, the media block is staged identically on both cells, and the media smoke check passes from each cell before the window (media section 8).
6. Rehearsal passed (U6) on `<REL>` on a restored production backup, with timings recorded. (The synthetic dress rehearsal of 2026-10-22 passed and does not replace it.)
7. Builds of `<REL>` staged on Host C and Host D (including `dist/auth-admin.mjs`), and the web build staged, before the window.
8. Backups taken inside the window before `02_migrate.psql` (database dump and Redis), encrypted, and copied off-host.
9. Rollback readiness (cutover P11 = rollback RP1-RP10, except RP6, which is taken at reopen, and RP8's Better Auth smoke account, which is created at W9) checked off, including the owner sign-off for `rollback/70_freeze_rc_down.psql`.
10. `git diff --stat e37ab27e <REL> -- lib/db` is empty (the 2a change has no schema change; verified at commit time).

## Map of the ten asks

| Ask | Section / file |
|---|---|
| 1. Migration package | `package/README.md`, `package/sql/*` (10/20/30 additive; 50 finalize is the only index drop, in the window, after GO) |
| 2. Clerk-user inventory, Path A/B | `package/inventory/11_user_inventory_readonly.sql`; Clerk-users section |
| 3. Public sign-up decision | Sign-up section (U2 = Option 2a, implemented) |
| 4. Media storage | Media section (U4 = external S3-compatible); `package/inventory/13_media_link_inventory_readonly.sql` |
| 5. Shared connector | `package/inventory/12_connector_inventory_readonly.sql`; connector section |
| 6. Environment contract | Environment section; encryption key rule with `package/inventory/15_credential_key_inventory_readonly.sql` |
| 7. Topology and cutover order | Cutover section (coexistence verdict: no rolling upgrade; short full-stop window); U1 evidence above |
| 8. Rollback | Rollback section (R1 / R2 / R3); `package/sql/60_*`, `61_*`; `package/rollback/70_freeze_rc_down.psql` |
| 9. Acceptance | Acceptance section; `package/inventory/14_zero_send_check_readonly.sql` |
| 10. Non-blockers | Non-blockers section |
| Final ordered sequence, Replit access removal, S3 policy, bootstrap, rollback checkpoints | `FINAL-SEQUENCE.md` |
| One-page environment manifest | `ENV-MANIFEST.md` |
| Read-only production discovery | `package/discovery/README.md` |


---

# Coexistence analysis

Citations: `@d22a8e43:<path>:<line>` means `git show d22a8e43bf0d36d1565c011aed77486767fb8318:<path>`. A path with no prefix is `e37ab27e` (outside the Option 2a auth files the code is identical in `<REL>`). A `…/` path is under `artifacts/api-server/src/`.

**Verdict:** d22a8e43 (Clerk) and HEAD (Better Auth) cannot run at the same time against database `cowabista` and the Host S Redis. Upgrading one cell at a time is not safe. The cutover needs a short maintenance window where everything stops. The order is:

1. Stop every old runtime wherever it runs. Stop the unscoped ones first.
2. Apply the additive migration.
3. Start only HEAD.

Sections (a) to (d) give the reasons.

## (a) `campaign_contacts` upsert and the unique-index change

| | d22a8e43 | HEAD |
|---|---|---|
| Unique index | `campaign_contact_idempotency_uq (campaign_id, idempotency_key)`, `@d22a8e43:lib/db/src/schema/campaign-engine.ts:65` | `(campaign_id, audience_generation, idempotency_key)`, `lib/db/src/schema/campaign-engine.ts:90`. New column `audience_generation NOT NULL DEFAULT 0` at `:79` |
| The only insert into the table (CSV import) | `ON CONFLICT (campaign_id, idempotency_key) DO NOTHING`, `@d22a8e43:…/routes/campaign-engine.ts:420-428` | `ON CONFLICT (campaign_id, audience_generation, idempotency_key) DO NOTHING`, `…/routes/campaign-engine.ts:511-520` |

**How PostgreSQL picks the conflict index.** For an `ON CONFLICT` statement, PostgreSQL uses as the "arbiter" every unique index whose columns are exactly the `ON CONFLICT` column list. Column order does not matter.
- If no index matches, the statement fails with 42P10.
- A unique index that is not an arbiter still raises 23505.

| Database state | d22a8e43 import | HEAD import |
|---|---|---|
| Production now (old index, no column) | works | fails: 42703 (column missing) |
| Finalized (new index only; after `03_finalize.psql`) | **fails with 42P10 on every import batch** | works |
| **Both indexes present: the package's transitional state after `02_migrate.psql`, until `03_finalize.psql` in W12b** | works. The old index is stricter, so any conflict on the new index is also a conflict on the old one. | Append works while all of a campaign's rows are in one generation. A *replace* import that re-stages a key from an older generation fails with 23505 on the old index. |

Every other `ON CONFLICT` target that both versions use keeps its index. For example, `campaign_jobs (organization_id, idempotency_key)` is the same at `@d22a8e43:…/services/campaign-planning.ts:373-375` and `…/services/campaign-planning.ts:564-566`. `campaign_jobs` has no schema change.

d22a8e43 planning and contact search have no generation filter (`@d22a8e43:…/services/campaign-planning.ts:228-233`, `@d22a8e43:…/routes/campaign-engine.ts:589-593`). Once HEAD activates a replace generation, old code would also plan rows that HEAD treats as superseded. That is a rollback hazard, not a startup failure.

## (b) Redis transport: keys, envelopes, ownership, pacing

These five files are byte-identical between d22a8e43 and HEAD (`git diff` is empty): `campaign-prepared-broker.ts`, `campaign-pacing-coordinator.ts`, `campaign-phone-scope.ts`, `campaign-shard-pacing.ts` and `campaign-phone-dispatch-scheduler.ts`. These files did change: `campaign-phone-reservoir.ts`, `campaign-queue.ts`, `campaign-transport-shards.ts` and `campaign-runtime.ts` (+4 lines, a test hook only). Both versions therefore use the same keys:

| Purpose | Key | Source (`…/services/`) |
|---|---|---|
| Prepared stream per phone | `campaign:prepared:{phone:<phoneId>}`, group `campaign-prepared-v1`, fields `phone fence dedupe payload` | `campaign-prepared-broker.ts:50,59-61,78-80` |
| Publish dedupe hash (24 h) | `campaign:prepared:{phone:<id>}:published`, dedupe value `<jobId>:<leaseToken>` | `campaign-prepared-broker.ts:62,66,183,187` |
| Ownership | `campaign:ownership:{campaign-owner:<orgId>:<phoneId>}:owner` (`PX 5000`) and `:fence` (TTL 100 s) | `campaign-pacing-coordinator.ts:218-219,309-311`, `campaign-phone-reservoir.ts:230` |
| Pacing | `campaign:pacing:{campaign-pacing:<orgId>:<phoneId>}:phone` and `:route:<routeId>` | `campaign-pacing-coordinator.ts:273-275` |

What this means:

- **Ownership.** An old cell and a new cell compete through the same fencing. With overlapping scopes one of them wins, which is safe. With disjoint scopes they never contend.
  - Nothing refuses a mixed-version fleet. The guard checks only this host: scope and manifest (`deploy/systemd/campaign-cell-guard.sh:13-43`) and one cell per host (`:45-50`).
  - It only prints the commit (`:68-69`).
- **Envelopes carry no version.** The payload is `JSON.stringify({job, preparedContext})` (`campaign-prepared-broker.ts:184`). HEAD adds `preparedContext.transportAuth` (`whatsapp-template-sender.ts:352-388`, `campaign-queue.ts:100-103`).
  - **An old envelope consumed by HEAD.** If its job lease is no longer live, HEAD discards it as stale (`campaign-queue.ts:1792-1809`). If the lease is still live, which happens in a mixed fleet:
    - it has no `transportAuth`, so in a real-mode workspace HEAD throws `credential_required` before any request (`whatsapp-template-sender.ts:595-597`, `whatsapp-provider.ts:264-282`);
    - the error is not retryable, so the job is marked Failed (`campaign-queue.ts:1271`);
    - nothing is sent twice, but those sends are lost.
  - **A HEAD envelope consumed by d22a8e43.**
    - The old serializer ignores `transportAuth` (`@d22a8e43:…/services/whatsapp-template-sender.ts:466-482`).
    - The old worker calls `providerClient(payload.mode)`, which for `"real"` (`@d22a8e43:…/services/campaign-transport-shard-worker.ts:109`) is the Replit connector (`@d22a8e43:…/services/whatsapp-provider.ts:2,154-158,221-222`).
    - Wherever that connector is reachable, the message is sent under the shared connector's identity. That bypasses HEAD's credential checks (`campaign-queue.ts:1767-1794`, `campaign-transport-shard-worker.ts:129-144`).
  - **Pending entries.** Entries left pending by a dead consumer are failed closed as delivery-unknown by the next owner (`deploy/README.md:127`). A graceful stop acknowledges only the entries it had already read (`campaign-phone-reservoir.ts:857-862`), so unread published entries can stay in a stream. W3 tells you how to judge them.
- **Global housekeeping runs in every runtime, whatever its scope:** metric flush, lease reaper, activation of due Scheduled campaigns, and throttle reactivation (`campaign-runtime.ts:187-263,273-301,311-345`).
  - In a mixed fleet both versions' rules apply to every campaign. Old code would execute plans frozen by HEAD (allocator-v2 lanes, delivery modes, media-asset mappings).
  - HEAD would activate old Scheduled plans, and their real-mode jobs would then fail:
    - with `credential_required` while the number has no workspace credential (`whatsapp-template-sender.ts:386`);
    - with "re-plan" once it has one, because an old plan freezes no credential and reads as `null` (`:283-289,356-359`).
- **Different coordinators.**
  - Coordinator selection is unchanged (`campaign-pacing-coordinator.ts:350-364`, `campaign-prepared-broker.ts:341-352`).
  - With `NODE_ENV=production`, both versions require `CAMPAIGN_COORDINATOR_MODE=redis` and a Redis URL, or they throw (`campaign-pacing-coordinator.ts:354-357`, `campaign-prepared-broker.ts:344-350`).
  - A runtime pointed at another Redis, or a development process with an in-memory coordinator, shares no ownership, pacing or streams with the cells. The same phone can then be owned and paced twice, with only the PostgreSQL job lease as a guard.
  - The at-most-once results (`docs/campaign-transport-operations.md:41-47`) were all measured with one shared Redis. Treat this as a double-send risk.
- **The Replit deployment.**
  - At d22a8e43 it runs the API on `/api` with `NODE_ENV=production` (`@d22a8e43:artifacts/api-server/.replit-artifact/artifact.toml:10,25-29,32`). The repository declares `deploymentTarget = "autoscale"` (`@d22a8e43:.replit:3-5`), which may mean several instances.
  - Every API process starts the runtime (`@d22a8e43:…/index.ts:28`). It owns every phone unless `CAMPAIGN_TRANSPORT_PHONE_IDS` is set (`docs/campaign-transport-operations.md:21-27`).
  - If that deployment serves HTTP, it must have Redis mode and a Redis URL, or the runtime constructor throws (`@d22a8e43:…/services/campaign-runtime.ts:98`). Which Redis it uses is the question.
  - The connector SDK it uses is Replit's. If real sends happen today, they most likely come from the Replit deployment. This is an inference that P1 must confirm.
  - **The Replit workspace can change the schema.** Its post-merge hook runs an unguarded `drizzle-kit push` against the workspace's `DATABASE_URL` (`@d22a8e43:.replit:18-20`, `@d22a8e43:scripts/post-merge.sh:3-4`, `@d22a8e43:lib/db/package.json:11`). If that variable points at production, a merge in that workspace after the migration (or after the expand step) would try to push the d22a8e43 schema back. What drizzle-kit applies without a terminal was not tested here. Treat it as a destructive risk.

## (c) Authentication on one public origin

- **d22a8e43:**
  - Clerk middleware plus a Clerk frontend-API proxy at `/api/__clerk` (`@d22a8e43:…/app.ts:6,107,119-125`, `@d22a8e43:…/middlewares/clerkProxyMiddleware.ts:27,56-64`).
  - Users are found by Clerk id (`@d22a8e43:…/middlewares/auth.ts:40-47`).
  - The SPA bundle embeds `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_CLERK_PROXY_URL` (`@d22a8e43:artifacts/wabista-nexus/src/App.tsx:37-45`).
- **HEAD:**
  - Better Auth answers four endpoints under `/api/auth/*` and everything else there returns 404 (`…/app.ts:91`, `…/middlewares/session.ts:9-25`).
  - The session cookie is `__Secure-wabista.session_token` when `BETTER_AUTH_URL` is https (`…/lib/auth.ts:20-21,61-62`). A session is resolved only when one of the two `wabista.session_token` names is present (`…/middlewares/session.ts:58-63`). Clerk cookies are never read.
  - `BETTER_AUTH_URL` must be the https public origin (`…/lib/auth-config.ts:61-66`). Host and protocol are pinned to it (`…/middlewares/session.ts:43-47`).
  - Sessions and rate limits live in PostgreSQL with no cookie cache (`…/lib/auth.ts:53,59`), so any cell can serve any request.
  - Passwords are 12 to 128 characters (`…/lib/auth.ts:47-48`).
  - The SPA needs no build variables and calls `/api/auth` on its own origin (`artifacts/wabista-nexus/src/lib/auth-client.ts:6-9`). `BASE_PATH` defaults to `/` (`artifacts/wabista-nexus/vite.config.ts:32`).
- **Cross-version behaviour:**
  - Old SPA with the HEAD API: there is no `/api/__clerk` route, so nobody can sign in. Browsers that still have the old SPA open must reload.
  - HEAD SPA with the old API: `/api/auth/*` does not exist, so nobody can sign in.
  - The only shared cookie is `wabista_active_org_id` (same name at `@d22a8e43:…/middlewares/auth.ts:13` and `…/middlewares/auth.ts:13`). HEAD honours it only for an existing membership (`…/middlewares/auth.ts:150-154`), so it is harmless.
- **One origin serves one SPA.** That is either the Replit path router (`@d22a8e43:artifacts/wabista-nexus/.replit-artifact/artifact.toml:7,11,19-20`) or the nginx root. The SPA and the API must switch together.
- **Every Clerk session ends at cutover.**
  - A legacy user is never linked by email (`…/middlewares/auth.ts:47-48,58-66`).
  - Their first authenticated request creates a new, empty personal workspace (`…/middlewares/auth.ts:115-147`, `…/lib/orgProvisioning.ts:80-99`).
  - So the public is kept out from W8 until the reopen steps (W13, W14) by an operator-only nginx rule. The rule is unconditional; W10 never removes it.

## (d) Other schema and behaviour d22a8e43 meets after the additive migration

- **New columns are all nullable, or `NOT NULL` with a constant default:**
  - `contact_import_sessions` (`lib/db/src/schema/campaign-engine.ts:52-54`), `campaign_contacts` (`:79`), `campaign_template_mappings.media_asset_id` (`:181`), `campaign_plans` (`:375,377`)
  - `campaigns` (`campaigns.ts:63-86`)
  - `campaign_routes` (`campaign-routes.ts:41,62`)
  - `phone_numbers` (`phone-numbers.ts:37-49`)
  - `wabas` (`wabas.ts:21,31-32`)

  Drizzle names columns explicitly, so old inserts receive the defaults and old reads never see the new columns.
  - Every raw `select *` at d22a8e43 reads a `jsonb_to_recordset` input, never a table: `@d22a8e43:…/services/campaign-queue.ts:332,640,845,1123,1286`, `…/services/template-resolution.ts:307` and `…/services/whatsapp-template-sender.ts:347,380,538`.
- **New unique index `campaign_org_creation_key_uq (organization_id, creation_key)`** (`campaigns.ts:95`): d22a8e43 inserts NULL there, so it never conflicts. This holds as long as the migration keeps the default NULLS DISTINCT.
- **New foreign keys** from new tables or columns to old tables are all `CASCADE` or `SET NULL`:
  - `campaign-engine.ts:133-144`, `message-studio.ts:28-111`, `template-drafts.ts:48-146`, `template-eligibility.ts:28-42`, `whatsapp-credentials.ts:28`, `lib/db/auth/src/index.ts:34-87`
  - plus `phone-numbers.ts:39,47`, `wabas.ts:21` and `campaign-routes.ts:41`.

  The deletes old code issues (campaigns, phone numbers, templates: `@d22a8e43:…/routes/campaigns.ts:178`, `…/routes/phone-numbers.ts:188`, `…/routes/templates.ts:120`) still succeed. The one `RESTRICT` (`campaign-engine.ts:181`) points only at rows that HEAD writes.
- **No triggers, CHECK constraints or enums** are defined in `lib/db/src` or `lib/db/auth/src`. Confirm that the migration package adds none.
- **The only hard break for d22a8e43 is the import error in (a).** The other issues are semantic and appear only once HEAD has written data, so they matter for rollback: old code ignores `sending_credential_id`, audience generations, allocator v2, delivery modes and media mappings.
- **HEAD cannot run before the migration.**
  - On start it runs the eligibility backfill (`…/index.ts:29-35`, `…/services/startup.ts:62-71`). That writes `template_eligibility` and `campaign_routes.waba_id` (`…/services/template-eligibility.ts:480-509`). If the backfill fails, the process exits with code 1.
  - systemd then restarts it every 2 s until it gives up after 10 starts in 300 s (`deploy/systemd/campaign-cell@.service:11-12,35-37`).
  - A malformed setting also stops it at start: media storage (`…/index.ts:21`), `CORS_ALLOWED_ORIGINS` or `TRUST_PROXY` (`…/app.ts:30,49`), and the Better Auth settings (`…/lib/auth.ts:111`, `…/lib/auth-config.ts:28-69`).

## Conclusion: a maintenance window, kept as short as possible

A rolling, cell-by-cell upgrade is unsafe, for four reasons:
- Old code fails imports after the index change.
- New code cannot start before the migration.
- In a mixed fleet, each version silently mishandles the other's envelopes and housekeeping.
- Authentication needs one SPA per origin.

This agrees with `deploy/README.md:115-116` ("Never run two different commits on the same scope at once") and §13 (`:237-244`). Inside the window, starting cell-1 and then cell-2 is fine because both run HEAD.

**Ways to shorten the window:**
- Do all builds, environment staging, TLS, nginx staging, the object-storage check and the inventories beforehand.
- Freeze campaigns at T-24h so the window has little to drain.
- Make the SPA switch an atomic symlink change.
- Lower the DNS TTL early.
- Measure the dump, migration and backfill times in a rehearsal on a restored backup.

**What the package already does.** The migration package uses this expand/contract shape inside the window:
- `02_migrate.psql` (expand) leaves both indexes in place, so the old code can still run and an abort needs no database change.
- `03_finalize.psql` (contract: one index drop plus a rename) runs after GO #1 and before users are let in.
- In the lab, 10/20/30 took about 4 s in total at 309k contacts through the guarded apply-sql (02 itself was not run there; the rehearsal measures it at production volume).

**Optional further step, only if the rehearsal shows *Mg* is long: move the expand part before the window.** Every part of the migration except the index swap is compatible with d22a8e43. That covers:
- the new tables and the Better Auth tables
- the defaulted columns
- foreign keys on the new, all-NULL columns (`NOT VALID`, then `VALIDATE`)
- the new non-unique indexes, built `CONCURRENTLY`
- the new unique index, built `CONCURRENTLY` under a temporary name.

That "expand" part could run before the window. The "contract" step inside the window would then shrink to two statements: drop `campaign_contact_idempotency_uq` and rename the temporary index.
- That is close to instant. It takes the `campaign_contacts` index builds, which are probably the longest part of the migration, out of the window.
- It needs its own backup, a `lock_timeout`, a rehearsal, and a check that no index is left invalid (`select indexrelid::regclass from pg_index where not indisvalid` must return no rows).
- **Precondition:** P1 must show that no Replit workspace can push the d22a8e43 schema to production. See (b) and P1.

## Runbook and config discrepancies to fix (configuration and docs only)

1. README §5 step 3 and §11 (`deploy/README.md:103-104,197`) use `KEYS '{campaign-owner:*:1}'` and `TTL '{campaign-owner:<org>:1}'`. Neither matches any key.
   - The real key is `campaign:ownership:{campaign-owner:<org>:<phone>}:owner`.
   - Its expiry is in milliseconds, so check it with `PTTL` and expect 0 to 5000.
   - Use `--scan`, not `KEYS`, and `REDISCLI_AUTH`, not `-u` with a password.
2. The env examples lack `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` and `WHATSAPP_APP_ID`. `CAMPAIGN_CELL_REQUIRED_ENV` (`deploy/systemd/cell-1.env.example:20`) lists neither, and neither appears in the README §4 table (`deploy/README.md:62-76`).
   - Real sending needs the key, with the same value on both cells (`…/services/credential-crypto.ts:6-10,19`; `docs/DEVELOPMENT.md:53`).
   - Template media needs the app id, also the same on both cells (`docs/DEVELOPMENT.md:54`).
3. The nginx example's root is `/opt/wabista/...` (`deploy/nginx/wabista.conf.example:39`) and its upstream is a single `127.0.0.1:8080` (`:17-21`). The target layout is two cells on Hosts C and D.
4. `CORS_ALLOWED_ORIGINS` held host names at d22a8e43 (`@d22a8e43:…/app.ts:31-39`), plus automatic `REPLIT_DOMAINS`. HEAD needs full origins (`…/lib/http-config.ts:13-21`). A value copied verbatim from Replit stops HEAD at startup.
5. The rate limiter exempts `/healthz` but not `/readyz` (`…/middlewares/rateLimit.ts:16,37`). Keep external probes of `/readyz` infrequent.
6. The unit's env file for instance `cell-1` is `/etc/cowabista/cell-cell-1.env` (`deploy/systemd/campaign-cell@.service:21`).
7. README §3 says Node 22, but the repository requires Node `>=22.12` and `pnpm@10.33.0` (`package.json` `engines` and `packageManager`).
8. README §5 and §11 check only `/healthz`. HEAD adds `/readyz` (`…/routes/health.ts:25-34`), and that is the readiness signal.
9. The guard passes the database and Redis URLs, passwords included, on the `pg_isready` and `redis-cli` command lines (`deploy/systemd/campaign-cell-guard.sh:62-63`). Local users on C and D can see them in the process list for up to 60 s.

# Production cutover order

**Hosts:**
- S: PostgreSQL 16 database `cowabista` and Redis 7.
- C: cell-1, phones `<CELL1_PHONE_IDS>` (the manifest scope; 1-4 was the benchmark layout).
- D: cell-2, phones `<CELL2_PHONE_IDS>`.
- N: the nginx host (may be C).
- M: the operator workstation.
- R: Replit, only if it still serves production or connects to it.

**Placeholders:** `<REL>` = `2a2afe6a2890da949947112e514236bc823935f1` (U2 = Option 2a, approved and implemented, plus the cell guard fix and the relocatable build fix; branch `wabista-nexus-v2`). U3 needs no code (B1 is the default, `deploy/cutover/FINAL-SEQUENCE.md` §2); if B2 were ever approved, `<REL>` would become the approved commit that adds the link option, and the P3 rehearsal and acceptance would run on that commit. Either way `git diff --stat e37ab27e <REL> -- lib/db` must be empty before this package is used. `<MIGRATION_PACKAGE>` = the `package/` directory of this runbook (see `package/README.md`, "How to connect"), `<APP_DOMAIN>`, `<TS>` (UTC timestamp), `<INVENTORY_SCRIPTS>`, `<OWNER_ROLE>`, `<N_ADDR>`, `<C_ADDR>`, `<D_ADDR>`, `<M_ADDR>`, `<BACKUP_HOST>`, `<SMOKE_EMAIL>`, `<ENDPOINT>`, `<BUCKET>`, `<PREFIX>` (default `campaign-media`), `<KEY_ID>`, `<REGION>`, `<ORG>`, `<ORGS>`, `<ID>`, `<PHONE>`, `<BASELINE_TABLES>` (from P8), `<CELL1_PHONE_IDS>` / `<CELL2_PHONE_IDS>` (the verified production scopes in `/etc/cowabista/cells.manifest`), `<P4 dir>` (the build directory chosen in P4), `<LAB_ADDR>` and `<LAB_CA_PEM>` (the rehearsal's lab nginx and its lab CA, P3), `<OWNER_ADDR>` (the approved owners' addresses, W13), `<PUBLIC_HOST>` = `<APP_DOMAIN>` (same value; the environment, acceptance, rollback, connector and Path B sections use this name), `<REDIS_HOST>` (Host S's Redis address), `<BACKUP_KEY_ID>` (the backup host's GPG public key, imported into root's keyring on S; check it with `gpg --list-keys <BACKUP_KEY_ID>` before P10).

**Handling secrets:**
- Enter secrets with `read -rs` and never echo them.
- Give redis-cli its password through `export REDISCLI_AUTH`, never through `-u` or `-a`.
- Generate each new secret **once**, into a root-only file, never onto the screen: on the admin machine `umask 077; mkdir -p /root/p6s; openssl rand -base64 32 > /root/p6s/ba`, and for the encryption key **only if inventory 15 printed `NEW KEY PERMITTED`** `openssl rand -hex 32 > /root/p6s/enc`. If it printed `PRESERVE EXISTING KEY`, write the existing production key into `/root/p6s/enc` from its current source without printing it, and never generate one (environment §7, "Encryption key rule"). Copy the files to C and D (`scp`). On each host, append them without printing: `printf 'BETTER_AUTH_SECRET=%s\n' "$(cat /root/p6s/ba)" >> <file>` and `printf 'WHATSAPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' "$(cat /root/p6s/enc)" >> <file>`. Put the offline copy into the secret store from the file, then `shred -u /root/p6s/*` everywhere. Both cells therefore get identical values.
- Do not put real WABA, phone, app or message ids in the change record.

**Approval:**
- The whole window is a production deployment and needs the user's explicit go-ahead.
- Steps marked **[LIVE META]** need separate explicit approval.
- Deployment is by SHA. Merging into the production branch is a separate decision for the user.
- **Every P, W, L and rollback step that touches Host S, C, D, N or R, the production database, `/opt/cowabista` or `/etc/cowabista` is run by the human operator after the user's explicit go-ahead for that step. An agent never runs them** (repository CLAUDE.md hard rules).

## Before the window (production hosts, no user-visible change; each step needs the user's go-ahead)

**P1. Settle the topology question (U1).** Operator on M, S, C, D, N and R; about 45 min. This collects the evidence E1-E6 listed in the summary ("U1: evidence required"); U1 is resolved only when all of it is recorded.
- `dig +short <APP_DOMAIN>`
- On C and D:
  - `systemctl list-units --all 'campaign-cell@*' --no-pager`
  - `git -c safe.directory=/opt/cowabista -C /opt/cowabista rev-parse HEAD`
  - `ls -ld /opt/cowabista`. Record the owner; W7 uses it.
  - `systemctl is-enabled campaign-cell@cell-N`, `journalctl -u campaign-cell@cell-N --no-pager | grep 'OK host=' | tail -1` (commit and scope) and `ss -ltnp | grep ':8080'` (replace 8080 if `PORT` differs).
- On N (if an nginx host exists): `nginx -T 2>/dev/null | grep -nE 'server_name|root |proxy_pass'` and `openssl x509 -noout -subject -dates -in <fullchain for APP_DOMAIN>`.
- On S, as postgres:
  ```
  psql -d cowabista -XAt -c "select client_addr, usename, application_name, count(*) from pg_stat_activity where datname='cowabista' and pid<>pg_backend_pid() group by 1,2,3"
  ```
- On S, with `REDISCLI_AUTH` exported:
  - `[ "$(redis-cli PING)" = PONG ] && echo AUTH_OK || echo 'STOP: redis-cli not authenticated'` must print `AUTH_OK` (add `-h <REDIS_HOST>` and `--tls` to every redis-cli call, as in W3, if Redis is not on S's loopback or uses `rediss://`).
  - `redis-cli CLIENT LIST`
  - The ownership keys and their owners. Values look like `api-<pid>-<uuid>` (`…/services/campaign-runtime.ts:60`); count the distinct runtimes.
    ```
    redis-cli --scan --pattern 'campaign:ownership:*:owner' | while read -r k; do echo "$k $(redis-cli GET "$k")"; done
    ```
- In the Replit UI, record:
  - The deployment type and instance count. The repository says Autoscale (`@d22a8e43:.replit:3-5`); confirm whether an idle deployment wakes on any request, Meta webhooks included.
  - For the deployment **and** the workspace, the non-secret parts of `DATABASE_URL` and `CAMPAIGN_REDIS_URL`/`REDIS_URL` (host, port and database only), and the values of `CAMPAIGN_COORDINATOR_MODE`, `CAMPAIGN_TRANSPORT_PHONE_IDS` and `CORS_ALLOWED_ORIGINS`.
  - Whether the workspace Run or Agent merges are active. The post-merge hook runs an unguarded `drizzle-kit push`; see (b).
  - Whether `<APP_DOMAIN>` is a custom domain or a `*.replit.app` domain.
- In the Meta App Dashboard (read-only, change nothing): record the webhook Callback URL host.
- U1 is resolved when E1-E6 are recorded and the summary's decision rule has been applied.

**Gate:**
- Every PostgreSQL and Redis client is mapped to a host. Any unknown client is a no-go.
- Any runtime that uses a Redis other than Host S's is a no-go until it is stopped.
- If any Replit workspace or deployment holds the production `DATABASE_URL`, that access must be removed before W5, or before the expand step if one is used. Either take it out of the workspace secrets (check in the Replit UI whether a running deployment keeps its value until it is redeployed) or block Replit's source address at S, with approval.

**P2. Lower the DNS TTL to 60-300 s** if the domain is moving from Replit. DNS admin, at least 48 h before the window.

**P3. Rehearsal.** Lab hosts only, about 4-6 h (with the rollback rehearsal), about T-3d.
- Isolation is mandatory:
  - a lab PostgreSQL and a lab Redis, never Host S;
  - no production secrets;
  - outbound access to `graph.facebook.com` blocked.

  The restored data uses production org and phone ids. A lab runtime on the production Redis would contend for ownership of production phones (`…/services/campaign-pacing-coordinator.ts:309-318`).
- Run by the operator only, with the user's explicit approval for this exact action. Never by an agent. The restored copy holds real personal data: restrict access, and destroy it afterwards.
- Restore the latest dump.
- Run the package in window order: `01` (exit 0) → `02` (exit 0, `MIGRATION COMMITTED`) → `40` (`transitional`).
- Start the `<REL>` build with test settings on the lab hosts. Run W7, W8 on the lab nginx only (it serves a lab-CA certificate for `<APP_DOMAIN>`, never the production key; the lab cells keep `BETTER_AUTH_URL=https://<APP_DOMAIN>`), W9 with `R="--resolve <APP_DOMAIN>:443:<LAB_ADDR> --cacert <LAB_CA_PEM>"` (the same options on W8's curls), the two webhook checks of the environment section §9 check 11 against `http://127.0.0.1:8080` on the lab hosts, W12 and acceptance phases 0-1 there. **Never run W10 (production DNS) or any Meta step in a rehearsal.**
- Then `03` (`FINALIZE COMMITTED`) → `40` (`finalized`) → acceptance phase 2 → `60` (exit 0) → `61` (`UNFINALIZE COMMITTED`) → `40` (`transitional`). This proves the rollback path R2 too.
- Then rollback RP7 (b) and (c) exactly as written in the rollback section §2, including `rollback/70_freeze_rc_down.psql` (dry run first, then `-v commit=yes`), on lab hosts only.

**Gate:** every package step above exits 0 with its expected message. Record the dump time *D*, the migration time *Mg*, the time until readyz *B* (the backfill), and the times of `03` and `61`. RP7 (b)/(c) results and every step's timing are recorded (rollback Q6).

**P4. Build.** root on C and D, 30-60 min per host; README §3 steps 1, 3 and 5. The build loads a live cell's dedicated 4 vCPUs, so build off-peak or on a separate build host and copy the result.
- Check `node --version` (≥ 22.12) and `pnpm --version` (10.33.0).
- Choose the directory: `/opt/cowabista` if no cell runs there, otherwise `/opt/cowabista.next`. For a new directory, `git clone <repo> <dir>` first.
- Build the API:
  ```
  git -c safe.directory=<dir> -C <dir> fetch origin && git -c safe.directory=<dir> -C <dir> checkout --detach <REL> && cd <dir> && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build
  chown -R "$(stat -c %U /opt/cowabista)":"$(stat -c %G /opt/cowabista)" <dir>   # same owner as the live checkout, so the guard's git works (W7)
  ```
- Build the web app on C or N:
  ```
  cd <dir> && BASE_PATH=/ pnpm --filter @workspace/wabista-nexus run build
  install -d /var/www/wabista/<REL> && cp -a artifacts/wabista-nexus/dist/public/. /var/www/wabista/<REL>/
  ```
  If you built on C and N is a different host, `rsync -a` the directory to N.

**Gate:**
- `rev-parse HEAD` returns `<REL>`.
- `artifacts/api-server/dist/index.mjs`, `dist/auth-admin.mjs` and `dist/campaign-transport-shard-worker.mjs` exist (`dist/auth-admin.mjs` proves the `<REL>` build ran: d22a8e43 has no such file).
- `/var/www/wabista/<REL>/index.html` exists on N.
- `diff /etc/systemd/system/campaign-cell@.service <dir>/deploy/systemd/campaign-cell@.service` is empty: the unit is unchanged since d22a8e43. The guard changed in `<REL>` (`f967bd7`, overlap check only); the unit runs it from the checkout (`ExecStartPre=/opt/cowabista/deploy/systemd/campaign-cell-guard.sh`), so installing the `<REL>` tree installs it and nothing under `/etc/systemd` changes.

**P5. Stage the environment.** root on C and D, about 30 min.
- Write `/etc/cowabista/cell-cell-1.env.next` on C and `cell-cell-2.env.next` on D, as `root:cowabista 0640`, from the environment section §9 templates (not the repository examples). Set:
  - `DATABASE_URL` and `CAMPAIGN_REDIS_URL`: Host S, identical on both cells.
  - `BETTER_AUTH_SECRET`: new, identical on both cells, at least 32 characters, from `openssl rand -base64 32` (`…/lib/auth-config.ts:46-59`). Changing it later signs everyone out.
  - `BETTER_AUTH_URL=https://<APP_DOMAIN>`.
  - `META_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: copied unchanged from current production.
  - `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY`: identical on both cells, **per the encryption key rule** (environment §7; inventory 15, first P8 run). `PRESERVE EXISTING KEY`: the current production key, byte-for-byte, never a new one. `NEW KEY PERMITTED` (zero stored credentials): new, exactly 64 hex characters (`openssl rand -hex 32`, see Handling secrets). One cell encrypts at connect time and the owning cell decrypts. Keep an offline copy; losing it makes every stored credential unreadable.
  - `WHATSAPP_APP_ID`: identical on both cells, listed in `CAMPAIGN_CELL_REQUIRED_ENV` (environment section §9).
  - `CAMPAIGN_MEDIA_STORAGE=s3` and `CAMPAIGN_MEDIA_S3_*` (endpoint, region, bucket, access key, secret key; `CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE` only if the provider needs it): identical on both cells. **Required** (U4: external S3-compatible provider, provisioned by the owner; media section 4).
  - `AUTH_PUBLIC_SIGN_UP`: absent (public sign-up closed, U2). `open` stops the process in production.
  - `TRUST_PROXY=1`, always (`…/lib/http-config.ts:59-66`): nginx on N appends the client address it sees to `X-Forwarded-For` and the cells trust that one hop. With an HTTP proxy or CDN in front of N, keep `1` and add `set_real_ip_from <EDGE_RANGES>; real_ip_header X-Forwarded-For;` to N's 443 server, so N sees (and appends) the real client address and N's `allow`/`deny` keeps working. An L4/TCP load balancer is fine only if it keeps the client source address (passthrough without source NAT; not the PROXY protocol: `proxy_protocol` on N's 443 `listen` makes every direct `--resolve <APP_DOMAIN>:443:<N_ADDR>` gate fail); a source-NAT balancer makes every user share one sign-in and API rate-limit bucket and must be changed before the window. Never `2`: a client could forge `X-Forwarded-For` and pick its own rate-limit key unless N's 443 were closed to all but the edge, and then the `--resolve` gates (W8, W9, rollback §13 step 6) cannot pass.
  - `CORS_ALLOWED_ORIGINS`: unset, or full origins only.
  - Remove every `CLERK_*` variable.
  - `CAMPAIGN_CELL_REQUIRED_ENV`: exactly the list in the environment section §9, with no quotes (media names included, U4).
- The file must **not** set any of these:
  - `NODE_ENV`, `CAMPAIGN_COORDINATOR_MODE`, `CAMPAIGN_CELL`, `CAMPAIGN_CELL_MANIFEST` or `CAMPAIGN_CELL_REPO` (the unit sets these; `CAMPAIGN_CELL_REQUIRED_ENV` is required above, and `CAMPAIGN_CELL_WAIT_SECONDS` is optional). systemd lets `EnvironmentFile=` override the unit's `Environment=` lines (`campaign-cell@.service:21-26`).
  - `BETTER_AUTH_SECRETS`, `BETTER_AUTH_TRUSTED_ORIGINS` or `BETTER_AUTH_TELEMETRY*`, which are refused at start (`…/lib/auth-config.ts:29-44`).
  - `CAMPAIGN_MEDIA_STORAGE_DIR` (`…/services/campaign-media-storage.ts:329`).
  - `CAMPAIGN_TEST_*`.
- Checks that print no secret:
  - Must print 0:
    ```
    grep -cE 'CHANGE_ME|^CLERK_|^NODE_ENV=|^CAMPAIGN_COORDINATOR_MODE=|^CAMPAIGN_CELL(_MANIFEST|_REPO)?=|^BETTER_AUTH_(SECRETS|TRUSTED_ORIGINS|TELEMETRY)|^CAMPAIGN_MEDIA_STORAGE_DIR=|^CAMPAIGN_TEST_|^AUTH_PUBLIC_SIGN_UP=open' <file>
    ```
  - The values must be identical on C and D: compare them with the environment section §9 pre-start check (a one-time **salted** fingerprint of the whole file, so no reusable hash of a secret is left in a terminal or record).
  - Must print 0 (no unencoded `@` in a URL password, which the guard's redaction would leak into the journal): `grep -cE '^(DATABASE_URL|CAMPAIGN_REDIS_URL|REDIS_URL)=[a-z]+://[^/]*@[^/]*@' <file>`.
  - `sha256sum /etc/cowabista/cells.manifest` must match on C and D.

**Gate:**
- The hashes match.
- The inventory shows that every real phone that must send has a `phone_numbers.id` inside a manifest scope. Scope means the phone id (`…/services/campaign-phone-scope.ts:17-19`, `…/services/campaign-phone-reservoir.ts:190-192`). A phone outside every scope is never sent, and its campaigns stay Running.

**P6. Object storage** (required: U4 = external S3-compatible provider; the owner provisions the bucket and the least-privilege key first, media sections 5-6). On C and on D, about 15 min.
- **Preferred:** the media section's smoke script (§8). It uses the app's own SDK, settings, user and CA, and it checks every operation the app needs. Before W6 the live env file has no media block and the live checkout no AWS SDK, so run it against the staged file and the P4 build:
  `systemd-run --wait --pipe --quiet --uid=cowabista --gid=cowabista -p EnvironmentFile=/etc/cowabista/cell-cell-1.env.next -p WorkingDirectory=<P4 dir>/artifacts/api-server /usr/bin/node /usr/local/lib/cowabista/media-smoke.cjs` (`cell-cell-2.env.next` on D).
- **Diagnostic only:** the CLI probe below, with the app's own key, to locate a failure; it does not pass P6 or sequence step 8.
- Match the app's settings:
  - The app uses path-style when `CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE=true`, or when that flag is unset and an endpoint is set; otherwise virtual-host (`…/services/campaign-media-storage.ts:340-344`). Set `addressing_style` under `s3` in the CLI profile to match: `path` in the first case, `virtual` otherwise.
  - **For AWS S3** (no `_ENDPOINT`): keep the default (virtual) addressing style and drop `--endpoint-url "$E"` from the commands below; `AWS_DEFAULT_REGION=<REGION>` selects the endpoint.
  - The app sends checksums only when required (`:368-369`).
```
read -rs AWS_SECRET_ACCESS_KEY; export AWS_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID=<KEY_ID> AWS_DEFAULT_REGION=<REGION>
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
E=<ENDPOINT>; K=s3://<BUCKET>/<PREFIX>/organizations/0/_cutover-probe-<TS>-$(hostname)   # inside the app key's allowed prefix; with an empty prefix: s3://<BUCKET>/organizations/0/...
aws --endpoint-url "$E" s3api head-bucket --bucket <BUCKET>   # needs s3:ListBucket (granted by the media section §6 policy; skip if your provider's key lacks it)
printf probe | aws --endpoint-url "$E" s3 cp - "$K"; aws --endpoint-url "$E" s3 cp "$K" -; aws --endpoint-url "$E" s3 rm "$K"   # never --recursive
unset AWS_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID
```
**Gate:** on both hosts the smoke script (media section §8) prints every line `OK` and exits 0 against the staged `.env.next` and the P4 build (`WARN outside-prefix` only for a provider whose keys cannot be prefix-scoped); the CLI probe alone does not pass this gate.
- The app parses this configuration only at start (`…/services/campaign-media-storage.ts:313-350`).
- It touches the bucket only on media upload, preview, delete, and when binding media to a sending phone (`…/routes/message-studio.ts:132-179`, `…/services/campaign-media-assets.ts:138,168,234`, `…/services/campaign-media-binding.ts:108`).
- So a bad bucket setting shows up only on first use.

**P7. nginx, TLS and network.** root on N, C and D; about 30 min.
- Adapt `deploy/nginx/wabista.conf.example`:
  - `server_name <APP_DOMAIN>`
  - `root /var/www/wabista/current`
  - upstream `server <C_ADDR>:8080; server <D_ADDR>:8080;`
  - Keep nginx's default `proxy_next_upstream`. Never add `non_idempotent`, or a POST such as an import or launch could be replayed on the second cell.
- Ingress:
  - Port 8080 on C and D open to N only. `TRUST_PROXY` relies on it.
  - Port 443 on N reachable from the Internet, for Meta webhooks.
- Egress from C and D:
  - Host S 5432 and 6379, and the S3 endpoint.
  - `graph.facebook.com:443`. HEAD calls Graph directly (`…/services/whatsapp-direct-sender.ts:11-12`, `…/services/whatsapp-manual-client.ts:19-22`); d22a8e43 went through the Replit connector.
  - Check firewall rules only. No Graph request is made before L1.
- If the domain is moving from Replit, pre-issue the certificate with a DNS-01 challenge.

**Gate:** `nginx -t` passes. `openssl x509 -noout -subject -dates -in <fullchain>` shows a valid certificate.

**P8. Read-only inventories.** `package/sql/01_preflight_readonly.sql` and `package/inventory/11_user_inventory_readonly.sql`, `12_connector_inventory_readonly.sql`, `13_media_link_inventory_readonly.sql` and `15_credential_key_inventory_readonly.sql` (package README, "How to connect").
- **First run (the authorized pre-cutover phase, with the user's go-ahead): days before the window, before P3, P4 and P5.** U3 is decided from this run's 11 (so a B2 choice still leaves time for its approved code change, the rehearsal and the builds), and the encryption key rule from its 15; P5 stages the key from that verdict.
- **Re-runs at T-24h and T-1h:** 15 must print the same `KEY RULE` (it must agree with the key staged in P5; otherwise STOP), and 11 must show no change that would alter the U3 decision.
- Together with P1 they cover:
- Clerk users (11, decides U3), shared-connector workspaces, phones and campaigns with their actions (12), media links (13), stored credentials and key versions (15, decides the encryption key rule);
- from `01` section 7: `baseline_tables` (record it as `<BASELINE_TABLES>`; 26 if production matches d22a8e43), `max_phone_id`, `database_size`, `imports_processing`;
- phone ids against the manifest (compare 12's phone list with `/etc/cowabista/cells.manifest`), plus `df -h` on S.

**P9. Freeze and announce at T-24h.**
- Announce the window.
- Tell users:
  - How they get access: public sign-up is closed (U2 = Option 2a), so an operator creates each account and sends a temporary password through a separate channel; they change it after signing in. What happens to existing workspaces depends on U3 (decided from inventory 11): under B1/B2 owners are re-attached after the window; under Path A legacy workspaces stay unreachable. Clerk passwords do not carry over; a forgotten password is reset by the operator (no email reset).
  - Until the general reopen (W14), only approved owners are let in.
  - Pages left open need a reload.
  - Live (real-mode) workspaces cannot send until the owner reconnects every number with their own credential (L1).
- No new launches, schedules or imports.
- Owners let running campaigns finish or cancel them.

**P10. Safety dump at T-2h.** Same commands as W4, tagged `pre`.

**P11. Rollback readiness** (rollback section §2, RP1-RP10). Done before the window; without it the rollback cannot run as written.
- RP1: P1, plus on each cell `journalctl -u campaign-cell@cell-N | grep 'OK host='`, on N `nginx -T | grep -nE 'server_name|root '`, `uname -m` and `ldd --version | head -1` on C, D and the build host, and the DNS records. RP3 = P2. RP10 = P10/W4. RP6 is taken at `T_OPEN` (W14, or W13 under U8), not before the window.
- RP2 env and manifest copies exist under `/etc/cowabista/rollback/` on C and D (checked by file name, never by value).
- `gpg --list-keys <BACKUP_KEY_ID>` on S shows the backup key (W4 encrypts with it).
- RP4 (front B only) the d22a8e43 SPA build exists and signs in; RP5 offline dependencies, or the `.prev` directory W6 keeps.
- RP7 rehearsal of the rollback (folded into P3, lab hosts only), RP8 accounts (the Clerk test account before the window; the Better Auth smoke account is created at W9 and its changed password stored at acceptance 1.2a), RP9 owner sign-off (including `rollback/70_freeze_rc_down.psql`).
**Gate:** each item is checked off in the change record (RP6 at `T_OPEN`; RP8's Better Auth part at W9 and acceptance 1.2a).

## In the window

**W1. Open the window.** About 5 min. Post the notice and review the T-1h inventory.

**W2. Campaign disposition.** About 5-15 min.
- Workspace owners or managers use the **old** UI. (No raw API call: the old API needs a Clerk session token, which must never go on a command line.)
- The path, the transitions and the manager role are the same in both versions (`@d22a8e43:…/routes/campaign-engine.ts:88-94,137-142`, `…/routes/campaign-engine.ts:124-130,173-178`).
- Cancellations cannot be undone, and an abort later does not reverse them.

| Status | Real-mode workspace | Mock workspace |
|---|---|---|
| Running or Paused **with** Queued/Processing jobs (action **A**) | **Cancel.** HEAD fails the remaining jobs with `credential_required` or "re-plan" (`…/services/whatsapp-template-sender.ts:356-359,386`). A Paused campaign cannot be re-planned (`…/services/campaign-planning.ts:60`). | Pause. The owner resumes it after regaining access (Path B1/B2) after reopening; never under Path A; the operator does not resume it |
| Running or Paused with **no** Queued/Processing job (action **B**) | Leave: nothing will send | Leave |
| Scheduled | **Cancel.** HEAD activates due campaigns on its first housekeeping pass (`…/services/campaign-runtime.ts:273-301`). | Leave |
| Ready with execution history (connector action **D2**) | **Cancel.** HEAD resumes the old frozen plan, which carries no credential (`…/services/campaign-launch.ts:112-121`). | Leave |
| Draft, or Ready with no history (action **D1**) | Leave. After the cutover, add the credential; HEAD launch re-runs preflight and re-plans (`…/services/campaign-launch.ts:128-131`). | Leave |

**Gate:** `package/inventory/12_connector_inventory_readonly.sql` exits 0 (`the window can start`). That is exactly: no live campaign in action A (Running/Paused with queued or processing jobs), C (Scheduled) or D2 (Ready with history); no Queued or Processing job in a live workspace; no contact import in progress in any workspace. Campaigns in B (nothing left to send) and D1 are allowed.

**W3. Stop every old runtime.** About 5-10 min. Stop unscoped runtimes first, so they cannot take over the cells' phones when the cells release them.
- On R: shut the deployment down (not just idle) and stop the workspace Run.
- Stop any other client found in P1.
- On C: `systemctl stop campaign-cell@cell-1 && systemctl disable campaign-cell@cell-1`. On D, do the same for `cell-2`.
  - Each stop takes at most 90 s (`campaign-cell@.service:34`).
  - The journal must show `Shutting down API server` (`@d22a8e43:…/index.ts:35`) and `Campaign runtime stopped` (`@d22a8e43:…/services/campaign-runtime.ts:184`).
  - It must not show `stop timed out` (`:181`) or SIGKILL.
- On S, check:
  - the P1 `pg_stat_activity` query returns no application rows;
  - Redis, **authenticated** (production Redis has `requirepass`; an unauthenticated scan fails with NOAUTH and would read as "0 keys"):
  ```
  read -rs REDISCLI_AUTH; export REDISCLI_AUTH; R="redis-cli -h <REDIS_HOST> -p 6379"            # add --tls for a rediss:// URL
  [ "$($R PING)" = PONG ] && echo AUTH_OK || echo 'STOP: redis-cli not authenticated'           # must print AUTH_OK
  $R CLIENT LIST | grep -c '^id='                                                                # must print 1 (only this client)
  $R --scan --pattern 'campaign:ownership:*:owner' > /root/own.txt && wc -l < /root/own.txt       # must print 0; no number = STOP
  $R --scan --pattern 'campaign:prepared:{phone:*}' | while read -r k; do echo "$k len=$($R XLEN "$k") pending=$($R XPENDING "$k" campaign-prepared-v1 | head -1)"; done
  unset REDISCLI_AUTH; rm -f /root/own.txt
  ```
- How to read the stream results:
  - **`pending>0`:** entries were handed to a consumer and never acknowledged, so they may have reached the provider. This is a **no-go** until it is reconciled (README §9).
  - **`len>0` with `pending=0`:** published but unread envelopes. A graceful stop leaves these (`…/services/campaign-phone-reservoir.ts:857-862`).
    - They are acceptable only once no `campaign_jobs` row is `Processing` with `lease_expires_at > now()`. Leases expire within 30 s.
    - HEAD then discards them as stale (`…/services/campaign-queue.ts:1792-1809`).
  - **Never** `XACK`, `XDEL`, `DEL` or `FLUSHALL` by hand.

**Gate:**
- No database writers.
- No Redis clients but yours.
- No ownership keys.
- No stream with `pending>0`.
- No job `Processing` with a live lease.

**Abort here** by re-enabling the old runtimes (or redeploying R). The schema is still untouched.

**W4. Final backups and records.** Run these in parallel. Time is *D* plus about 5 min.
- On S, as root and postgres:
```
B=/var/backups/cowabista/<TS>; install -d -m 0700 -o postgres -g postgres "$B"
sudo -u postgres pg_dump -d cowabista -Fd -j 4 -f "$B/cowabista.dir"
sudo -u postgres pg_dumpall --globals-only -f "$B/globals.sql"          # holds role password hashes: keep 0700, encrypt off-host
sudo -u postgres pg_restore --list "$B/cowabista.dir" | grep -c 'TABLE DATA'   # expect <BASELINE_TABLES>
# optional, whole cluster: sudo -u postgres pg_basebackup -D "$B/base" -Ft -z -X stream -c fast
read -rs REDISCLI_AUTH; export REDISCLI_AUTH
LS0=$(redis-cli LASTSAVE); redis-cli BGSAVE SCHEDULE
for i in $(seq 1 600); do [ "$(redis-cli LASTSAVE)" != "$LS0" ] && break; sleep 1; done
[ "$(redis-cli LASTSAVE)" != "$LS0" ] && echo NEW_SAVE_OK || echo 'NO NEW SAVE: no-go'
redis-cli INFO persistence | grep -E 'rdb_bgsave_in_progress|rdb_last_bgsave_status|aof_rewrite_in_progress|aof_last_write_status'   # NEW_SAVE_OK and 0, ok, 0, ok; anything else is a no-go
install -d -m 0700 /var/backups/redis/<TS>; cp -a /var/lib/redis/dump.rdb /var/lib/redis/appendonlydir /var/backups/redis/<TS>/
tar -C /var/backups -cf - cowabista/<TS> redis/<TS> | gpg --encrypt -r <BACKUP_KEY_ID> -o /var/backups/p6-<TS>.tar.gpg   # personal data and role hashes leave the host encrypted only
rsync -a /var/backups/p6-<TS>.tar.gpg <BACKUP_HOST>:/backups/
```
- On C and D, as root:
```
install -d -m 0700 /root/cutover-<TS>; tar -C / -czf /root/cutover-<TS>/etc-cowabista.tgz etc/cowabista etc/systemd/system/campaign-cell@.service
git -c safe.directory=/opt/cowabista -C /opt/cowabista rev-parse HEAD > /root/cutover-<TS>/checkout-sha.txt
```
- On N: `install -d -m 0700 /root/cutover-<TS>; tar -C / -czf /root/cutover-<TS>/etc-nginx.tgz etc/nginx`.
- On R: record the commit of the deployment.

**Gate:** the dump lists `<BASELINE_TABLES>` tables, the Redis save is ok, the copies are off-host, and the SHAs are recorded.

**W5. Additive migration.** Run from `<MIGRATION_PACKAGE>` on M or S as `<OWNER_ROLE>`, exactly as rehearsed. Connect directly, not through a pooler, with the password in `~/.pgpass`. Time is *Mg* plus 5 min.
```
psql -X -v ON_ERROR_STOP=1 -L logs/15-<TS>.log -f inventory/15_credential_key_inventory_readonly.sql; echo "exit=$?"    # 0, same KEY RULE as at P8 (else STOP: the staged key may be wrong)
psql -X -v ON_ERROR_STOP=1 -L logs/01-<TS>.log -f sql/01_preflight_readonly.sql; echo "exit=$?"    # 0, PREFLIGHT OK
psql -X -v ON_ERROR_STOP=1 -L logs/02-<TS>.log -f sql/02_migrate.psql;           echo "exit=$?"    # 0, MIGRATION COMMITTED; note t0_utc = T0
psql -X -v ON_ERROR_STOP=1 -L logs/40-<TS>.log -f sql/40_postcheck_readonly.sql; echo "exit=$?"    # 0, POSTCHECK OK, idempotency state transitional
```
- Exit 3 at any step means nothing was changed. Stop and read the log. Overrides (`-v allow_other_sessions=on`, `-v allow_schema_extras=on`) are used only after reviewing what the script listed.
- Never use `lib/db push`, `push-force`, `drizzle-kit` or the disposable-database commands, from any checkout.
- `40` verifies the release catalog (16 new tables over the baseline) and the transitional index pair, and it fails if any index is invalid.

**Gate:** three exits of 0. The schema is now the release schema in the **transitional** state. The old code (d22a8e43) can still import, so an abort until W12b needs no database change (rollback path R1).

**W6. Install the release.** root on C and D, about 5 min.
- `install -m 0640 -o root -g cowabista /etc/cowabista/cell-cell-1.env.next /etc/cowabista/cell-cell-1.env` (`cell-cell-2` on D).
- If P4 built into `/opt/cowabista.next`: `mv /opt/cowabista /opt/cowabista.prev-<TS> && mv /opt/cowabista.next /opt/cowabista`. The pnpm links are relative, so the move is safe.
- If P4 built in place in `/opt/cowabista`, there is nothing to move. Only if neither was done, fall back to README §5 "Rolling a new release" in place, which adds build time.

**Gate:** `rev-parse HEAD` returns `<REL>` on both hosts, and the P5 checks pass on the live files.

**W7. Start the cells, one at a time.** About 10 min plus *B*.
- On C:
```
systemctl enable --now campaign-cell@cell-1
journalctl -u campaign-cell@cell-1 -n 60 --no-pager
for i in $(seq 1 120); do c=$(curl -s -o /dev/null -w '%{http_code}' localhost:8080/api/readyz); [ "$c" = 200 ] && break; sleep 5; done; echo "$c"
curl -s localhost:8080/api/healthz; echo
```
  Size the loop from the rehearsal figure *B*.
- Expect, in order:
  - the guard line `OK … scope=<CELL1_PHONE_IDS> … commit=<first 12 characters of REL>`. The guard runs as `cowabista` (`campaign-cell@.service:16,27`), so `commit=unknown` can appear if git refuses a checkout owned by another user. Then confirm with `rev-parse` as root.
  - `Campaign media storage` reporting `s3` (`…/index.ts:48`). The warning at `…/index.ts:46` (no media storage) is a no-go: media is required at launch (U4).
  - `campaign startup initialization completed`, then `campaign runtime started after initialization` (`…/services/startup.ts:64,84`)
  - `Campaign runtime started` with `phoneScope` `<CELL1_PHONE_IDS>` (`…/services/campaign-runtime.ts:148`).
- `/api/healthz` must return 200 with `status ok`, `campaignRuntime.status ok` and `initialization.phase ready` (`…/routes/health.ts:14-19`).
- `/api/readyz` is new at HEAD. It returns 200 `{"status":"ready","database":"ok",…}` only when the database is reachable, the backfill has finished and the runtime has started; otherwise it returns 503 (`…/routes/health.ts:25-34`). It does not check Redis.
- Then repeat on D for `cell-2` and scope `<CELL2_PHONE_IDS>`.

**Gate:** both cells are active and `/readyz` returns 200 on both. Neither journal has a line with `"level":50` or higher.

**W8. SPA and nginx.** root on N, about 5 min.
- **Always** add the temporary operator-only rule to the 443 server **before** nginx can route any request to the cells (if N already proxies `/api` to the cells, add it before W7). It stays until W13/W14; W10 never removes it:
  - `allow <M_ADDR>; deny all;` at server level
  - plus `location = /api/webhooks/whatsapp { allow all; access_log off; …same proxy lines as /api/… }`, so status webhooks are not refused and the verify token in Meta's verification query never reaches the access log. Keep `access_log off` for this location after W14 too.
  - If an HTTP proxy or CDN sits in front of N, add the P5 `real_ip` lines on N, because `allow` would otherwise see only the proxy's address (an L4 balancer must keep the client address, P5).
- W9, W11 and acceptance run from M.
```
ln -sfn /var/www/wabista/<REL> /var/www/wabista/current.new && mv -Tf /var/www/wabista/current.new /var/www/wabista/current
nginx -t && systemctl reload nginx
curl -sS --resolve <APP_DOMAIN>:443:<N_ADDR> https://<APP_DOMAIN>/api/readyz; echo
curl -sS -o /dev/null -w '%{http_code}\n' --resolve <APP_DOMAIN>:443:<N_ADDR> https://<APP_DOMAIN>/
```
**Gate:** `/api/readyz` and `/` both return 200 through nginx from M, and from an address that is not allow-listed `curl -s -o /dev/null -w '%{http_code}\n' --resolve <APP_DOMAIN>:443:<N_ADDR> https://<APP_DOMAIN>/` prints 403 (`--resolve` tests N itself even while DNS still points elsewhere). If an outer proxy or load balancer sits in front of N, the same curl through it (`--resolve <APP_DOMAIN>:443:<EDGE_ADDR>`) must also print 403, as in rollback §13 step 6.

**W9. Better Auth smoke.** About 5 min. Public sign-up is closed (U2 = Option 2a).
- Use `--resolve` before the DNS switch.
- Sign-in allows 3 requests per 10 s per client address.
- `<SMOKE_EMAIL>` must be an operator-owned mailbox. The account and its workspace stay in production, because user deletion is disabled.
- Precondition for every `create` or `reset-password` run: as root or through `sudo`, `sudo grep -rhiE 'log_?(output|input)|log_(tty|std)(in|out)|log_stderr' /etc/sudoers /etc/sudoers.d/; echo "exit=$?"` must print exactly `exit=1` (no sudo I/O logging; any matched line, `exit=0`, `exit=2` (a file could not be read) or a sudo error means STOP), and `sudo -l | grep -ciE 'log_(output|input|tty|std)'` must print `0` (also covers sudo rules from SSSD or LDAP). The terminal must not be recorded either (script, tmux pipe-pane, session recording); otherwise the temporary password would be kept.
- First, on C as the service user, interactively on a terminal, create the smoke account (the temporary password is printed once; type it into `read -rs` on M below, never into a file or chat):
```
cd /opt/cowabista/artifacts/api-server && sudo -u cowabista env NODE_ENV=production node --env-file=/etc/cowabista/cell-cell-1.env dist/auth-admin.mjs create --email '<SMOKE_EMAIL>' --name 'Cutover Smoke'   # exit 0
```
- Put each value in single quotes and nothing else; write an apostrophe as `'\''` (for example `--name 'Anil D'\''Souza'`). Never use double quotes or `sh -c` around a value someone else supplied: the shell would expand it, and the service user can read every production secret.
- Then on M:
```
read -rs PW; J=$(mktemp); chmod 600 "$J"; O=https://<APP_DOMAIN>; R="--resolve <APP_DOMAIN>:443:<N_ADDR>"
curl -sS $R -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' -H "Origin: $O" --data '{"name":"x","email":"nobody@example.invalid","password":"not-a-real-password"}' "$O/api/auth/sign-up/email"   # 404 (sign-up closed)
curl -sS $R "$O/api/auth-policy"; echo                                                            # {"publicSignUp":false}
printf '{"email":"%s","password":"%s"}' '<SMOKE_EMAIL>' "$PW" | curl -sS $R -c "$J" -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' -H "Origin: $O" --data-binary @- "$O/api/auth/sign-in/email"   # 200
grep -c '__Secure-wabista.session_token' "$J"                                                     # 1
curl -sS $R -b "$J" -o /dev/null -w '%{http_code}\n' "$O/api/me"                                  # 200
curl -sS $R -b "$J" -c "$J" -o /dev/null -w '%{http_code}\n' -H "Origin: $O" -H 'Content-Type: application/json' --data '{}' "$O/api/auth/sign-out"   # 200
curl -sS $R -b "$J" -o /dev/null -w '%{http_code}\n' "$O/api/me"                                  # 401
shred -u "$J"; unset PW
```
- The temporary password must contain no `"` or `\` for the `printf` above: the command's passwords are base64url (letters, digits, `-`, `_`), so they never do. Change the smoke account's password in the browser during acceptance 1.2a.

**W10. DNS and TLS**, only if moving from Replit. DNS TTL plus about 5 min. The W8 operator-only rule must already be in place before the DNS switch; it stays until W13/W14. After the switch, from an address that is not allow-listed and without `--resolve`, both `curl -s -o /dev/null -w '%{http_code}\n' https://<APP_DOMAIN>/` and `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<APP_DOMAIN>/api/auth/sign-up/email` print 403.
- Confirm R is stopped and the domain is detached there. Then point the A/AAAA records at N.
- `dig +short <APP_DOMAIN> @1.1.1.1` and `@8.8.8.8` must both return N.
- `echo | openssl s_client -connect <APP_DOMAIN>:443 -servername <APP_DOMAIN> 2>/dev/null | openssl x509 -noout -subject -dates` must show the new certificate.
- If the certificate was not pre-issued, run `certbot --nginx -d <APP_DOMAIN>` now (2-5 min).
- Re-run only W9's M-side block, with `R=` (no `--resolve`). Do not re-run `auth-admin create`: the account exists and create would exit 1. At `read -rs PW` type the smoke account's temporary password again; if it is no longer at hand, run W9's command on C with `reset-password --email '<SMOKE_EMAIL>'` in place of `create … --name …` and use the new temporary password it prints. Re-run W11.

**W11. Webhook.** About 5 min.

The path does not change between versions: GET and POST `/api/webhooks/whatsapp` (`…/routes/whatsapp-webhook.ts:12,29`). That file is unchanged since d22a8e43. The raw-body mount is at `@d22a8e43:…/app.ts:111` and `…/app.ts:80`, and the variable names are the same. These checks reveal nothing:
- `curl -s -o /dev/null -w '%{http_code}\n' "https://<APP_DOMAIN>/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x"` must print 403. A 503 means the token is missing.
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' https://<APP_DOMAIN>/api/webhooks/whatsapp` must print 401. A 503 means the app secret is missing. A 400 means the Content-Type header was left off (`…/routes/whatsapp-webhook.ts:14-17,31-44`).

If the P1 callback host equals `<APP_DOMAIN>`, nothing changes at Meta. Otherwise the app owner updates the Callback URL in the Meta App Dashboard and keeps the same verify token **[LIVE META]**.

Caveat: one `META_APP_SECRET` verifies every signature, so only WABAs subscribed to that Meta app deliver status webhooks.

**W12. Acceptance phases 0 and 1.** About 30-40 min. Run the acceptance section exactly:
- phase 0: guard lines, readyz, media log line, `40` transitional, zero-send check;
- phase 1: public page, sign-in, `/api/me`, mock setup (1.6a), Draft, 3-row CSV, Message, Delivery, preflight, schedule +30 days, cancel, media upload/preview/delete (required, U4), logout/login, no 5xx, no secrets in logs, zero-send.
- **No Send Now, no test send, and no launch or resume in a live workspace.** The only launch is the mock-workspace schedule in 1.12, cancelled in 1.13.

**W12a. GO / NO-GO #1.** Owner and operator decide together.
- **NO-GO:** rollback path R1 (application only; no database change).
- **GO:** continue. From W12b on, an application rollback first needs `60` and `61` (path R2).

**W12b. Finalize the campaign_contacts index.** About 2 min. The cells keep running; users are still kept out.
```
psql -X -v ON_ERROR_STOP=1 -L logs/03-<TS>.log -f sql/03_finalize.psql;         echo "exit=$?"    # 0, FINALIZE COMMITTED (lock_timeout 5s: on exit 3, run it again)
psql -X -v ON_ERROR_STOP=1 -L logs/40b-<TS>.log -f sql/40_postcheck_readonly.sql; echo "exit=$?"   # 0, idempotency state finalized
```
Then run acceptance phase 2: a replace import with 3 *different* phones, and the zero-send check.

**Gate:** both exit 0, and phase 2 passes. "Replace audience" is now fully supported; while the old index existed, a replace that reused a phone failed.

**W13. Limited reopen** (default). About 5 min.
- Preconditions:
  - The sign-up policy (U2 = Option 2a, closed) is deployed: acceptance 1.2 passed.
  - The Clerk-user path (U3) was decided at the first P8 run from inventory 11. If U3 is B1 or B2, owner re-attachment runs from here, person by person (B2 only if its link option was approved and is in `<REL>`); nothing runs under Path A.
  - W12b passed (finalized).
- Record the `delivery_unknown` count (read-only `select count(*) from provider_messages where status = 'delivery_unknown'`; the L2 baseline). Under U8 only, also record `T_OPEN` and the RP6 snapshot here.
- Widen the W8 rule only to the addresses of the owners approved for L1/L2: insert `allow <OWNER_ADDR>;` lines **above** `deny all;` (order matters: the first match wins), then `nginx -t && systemctl reload nginx`. From one owner address `curl -s -o /dev/null -w '%{http_code}\n' https://<APP_DOMAIN>/` prints 200; from a non-listed address it still prints 403. No public notice yet.
- Until W14, owners must not launch, schedule, resume **or test-send** in any workspace that has a number connected with its own credential (Live **or** Test mode, including their new personal workspace), except the approved L2 send (policy; the app does not enforce it). Zero-send check 14 counts such workspaces as live and detects test sends through their audit row.
- **If no legacy live-workspace number will be reconnected with its existing in-scope id** (U3 = Path A, inventory 12 shows no live workspace, or the user defers L1/L2), W14 cannot wait for L2. The user then chooses at GO #1 between U8 (general reopen at W13) and W14 right after W13 without L2 (or a planned scope reconfiguration before L2). Record the choice; `T_OPEN` is that moment.
- **Alternative (decision U8, taken explicitly at GO #1):** reopen to everyone right here. Then every owner can connect numbers and send before L2, and T4's check 14 gives way to Q-UNEXPECTED/Q-REPEAT (rollback §3) at this moment instead of at W14. Remove the allow/deny lines as in W14 (the webhook location stays).

## After reopening

**L1. Number Center**, for each real workspace **[LIVE META]**. The owner, in Numbers:
- connects a credential (`POST …/whatsapp/manual/connect`)
- verifies, registers and activates sending for each number
- syncs templates.

These calls are at `…/routes/whatsapp-manual.ts:69,161-239`.

**Gate**, read-only on S:
- `select id, organization_id, status, setup_state, sending_credential_id is not null from phone_numbers where organization_id in (<ORGS>) order by id;`
- `select id, organization_id, status, revision, last_validated_at from whatsapp_credentials where organization_id in (<ORGS>);` Never select the `token_*` columns.
- Each phone must be `Connected`, have a sending credential, and keep the **same id**. The connect step updates the existing row by organization and provider phone id (`…/services/whatsapp-manual-connection.ts:290-291`). The id must be inside its manifest scope.
- A phone that got a new id is outside every scope. Changing scopes is a planned reconfiguration: stop both cells, update the manifest and both env files, then start. Never do it ad hoc.

**L2. First live send.** Separately approved **[LIVE META]**, about 30 min of observation.
- Record the L2 campaign id (rollback T4 and check 14 use it as `approved_campaign_ids` once L2 has launched).
- Before launch, the Review page shows **exactly 1** valid recipient, and it is the operator's test number. No test send on the L2 campaign: check 14 counts every test send.
- One recipient: a consenting test number owned by the operator.
- Delivery mode Conservative, on one phone inside a scope.
- Watch for:
  - `Workspace sending credential bound to transport` in the cell journal, and no `could not be bound` (`…/services/campaign-phone-reservoir.ts:285,302`)
  - exactly one `campaign:ownership:{campaign-owner:<ORG>:<PHONE>}:owner` key, with a `PTTL` between 0 and 5000 that keeps refreshing
  - the `provider_messages` row moving to sent, then to delivered through the webhook. A delivered status proves the app secret and the callback.
  - the `delivery_unknown` count staying unchanged.

**Gate:** a delivered status arrives.

**W14. General reopen.** About 2 min. Record `T_OPEN` and, at that same moment, the RP6 snapshot: `live_at_open` (the Running/Scheduled campaign ids now), the output of inventory 12 and the `delivery_unknown` count. Remove the server-level `allow …;` lines (M and the W13 owners) and `deny all;`; **keep** the `location = /api/webhooks/whatsapp` block with `access_log off`. `nginx -t && systemctl reload nginx`; from a non-allow-listed address `curl -s -o /dev/null -w '%{http_code}\n' https://<APP_DOMAIN>/` prints 200. Post the notice and monitor per README §11-12 for 24 h.

Until the rollback window closes, keep the Clerk instance, the stopped Replit deployment, `/opt/cowabista.prev-<TS>` and the W4 backups.

## Expected durations (replace with the P3 rehearsal figures)

| Part | Time |
|---|---|
| W1–W3 (open window, disposition, stop old runtimes) | 15–30 min |
| W4 (backups) | *D* + 5 min |
| W5 (preflight, migration, postcheck) | *Mg* + 5 min |
| W6–W8 (install, start cells, nginx) | 20 min + *B* |
| W9, W11 (smokes) | 10 min; can overlap the W10 TTL wait by using `--resolve` |
| W12-W12b (acceptance 0-2, GO, finalize) | 40-55 min (`03` is index-only; in the lab, 10/20/30 took about 4 s at 309k contacts through the guarded apply-sql) |
| W10 (DNS/TLS) | DNS TTL + 5 min, only if moving from Replit |
| **Total** | **about 100–130 min + *D* + *Mg* + *B*** |

With the optional expand step done before the window, *Mg* drops to a few seconds.

---


---

## Existing Clerk users: Path A / Path B decision tree

**Decision rule (2026-10-22): Path A if inventory 11 shows no meaningful users; otherwise Path B1, the default. B2 is not needed.** The rule is applied as soon as `inventory/11_user_inventory_readonly.sql` (counts only) has run on production in the authorized pre-cutover phase (cutover P8); nothing below accesses production before then. Why B1 is enough (code review of `<REL>` and `d22a8e43`, 2026-10-22): every access decision goes through `organization_members (user_id, role)` (`middlewares/auth.ts:106-113,163-164,176-207`; `routes/organizations.ts:26-42,75-83`); no route checks who created a resource (the `created_by`/`updated_by` columns are written, never read; `campaign_audit.actor_user_id` is only counted, never filtered); the seven authorship columns of the release live in tables that the migration creates empty; there are no per-user settings; and `users.is_platform_admin` gates nothing in either version. An owner re-attached under B1 therefore has full owner rights over every number, template, campaign and contact of the workspace. B2 would only add identity continuity (same user id, no duplicate member rows, no extra workspace) and would need new code, a security review and a new release. With public sign-up closed (U2, Option 2a), every person gets their Better Auth account from the operator command (`dist/auth-admin.mjs create`), whichever path is chosen:
- **Path A:** operator-created accounts only for the people who should have access; they start in a new, empty personal workspace. No code.
- **Path B1:** operator-created account first, then `path-b/21_owner_reinvite.psql` per legacy workspace (step 1 below uses the operator command, not self sign-up). No code.
- **Path B2 (not needed, not implemented):** would need one approved code addition: a `--link-user-id` option on the operator command (insert `auth_user_links` before the first sign-in, with the refusals listed below and in the sign-up section, section 5). It is kept here only as a documented option.

### Facts this rests on

- **The migration keeps every user exactly as it is.** No `users`, `organization_members`, `organization_invitations` or ownership row is changed or deleted. Integer `users.id`, `clerk_id`, roles and history stay intact. `02_migrate.psql` proves this inside its own transaction, two ways, before it commits:
  - PostgreSQL's own per-transaction counters (`pg_stat_xact_user_tables`) show zero rows inserted, updated or deleted in any table. This covers every column.
  - A data fingerprint (counts plus md5 over ids, roles and statuses; `clerk_id` only as md5) is identical before and after the DDL.

  In the lab the fingerprint was identical (`p6_prod` = `p6_mig`). The counter check detected a single test UPDATE (0 → 1).
- **No password migration.** Clerk password hashes are not available. Nobody can sign in with their Clerk password after the cutover.
- **The release never links an existing user automatically**, not even by email, because email ownership is not verified (`artifacts/api-server/src/middlewares/auth.ts:44-67`). A Clerk-era person who signs in with Better Auth gets a **new** local user (`clerk_id = better-auth:<id>`) and a new personal workspace. Their old user row, memberships and workspaces remain, but that new account cannot reach them.
- **Two safe ways to give access back already exist in the code:**
  - **Invitations.** Acceptance needs both the secret token **and** a signed-in email equal to the invited email (`artifacts/api-server/src/lib/orgProvisioning.ts:119-150`). An operator-created invitation row is accepted exactly like an app-created one (`invited_by_user_id` is nullable everywhere).
  - **`auth_user_links`.** This maps one Better Auth user to one integer user, strictly one-to-one (`auth_user_links_user_id_uq`). If a link to the legacy `users.id` exists **before** the person's first request, the app uses that legacy user, with all of its memberships (`middlewares/auth.ts:51-56`).

### Step 1: run the inventory (read only, counts only)

`inventory/11_user_inventory_readonly.sql`. It prints counts only, never an email, name or Clerk id. Look at:
- section 5, `users_in_active_or_live_orgs`, `owners_in_active_or_live_orgs` and `active_or_live_orgs`. "Active or live" means a non-sample campaign touched in the last 90 days, a provider message in the last 90 days, or a live (connector) workspace.
- section 7, `duplicate_email_groups` and `users_without_usable_email`.
- section 8, `orgs_needing_owner_reattach`.

### Step 2: decide

```
users_in_active_or_live_orgs = 0
  OR the owner confirms every such person is internal/test?
        └─ yes → PATH A
        └─ no  → PATH B1 (re-invite; no code change). This is the default.
                 B2 only if the owner states that the SAME user id is required for a reason B1 cannot meet
                 (none exists in this release, see the decision rule above) AND approves new code,
                 its tests, a security review and a new release before the window.
```

### Path A: nobody keeps old access

- **Action:** none on the database. Legacy rows stay (inert) for history. Nothing is deleted.
- **What people see:** they get an operator-created account (`dist/auth-admin.mjs create`; public sign-up is closed, U2) and start in a new personal workspace. Legacy workspaces, including their numbers and campaigns, are unreachable.
- **Correct only if** no real customer depends on a legacy workspace.

### Path B1: re-invite (no code change)

1. The person gets a Better Auth account with **their own email**, created by the operator (`dist/auth-admin.mjs create`; public sign-up is closed under U2 = Option 2a). If the person opens the app before accepting (step 3), that first visit creates a new, empty personal workspace (harmless); signing in from the invite link ("Sign in to join") and accepting first avoids it.
2. For each legacy organization in `orgs_needing_owner_reattach` that should come back:
   - The operator confirms the person's identity out of band.
   - The operator runs `psql -X -v ON_ERROR_STOP=1 -v org_id=<internal id> -f path-b/21_owner_reinvite.psql; echo "exit=$?"` from the package directory (no `-L`, no `tee`: the output holds the invite link) and types the person's sign-in email at the prompt, which keeps it out of shell history and `ps`.
   - Gates: the release schema exists, the org exists, it has no Better Auth owner yet, the email is a legacy owner email of that org (override `-v allow_other_email=on`), and no pending invitation exists.
   - The script writes one `organization_invitations` row (role `owner`) and shows the invite path once.
   - The operator sends `https://<PUBLIC_HOST>/invite/<token>` through a separate channel. **Do not tee or save the output.**
3. The person opens the link, signs in there with that email ("Sign in to join"), and accepts. They are now an owner of the old workspace, with its numbers, templates, campaigns, contacts and history.
4. That owner re-invites their team from **Team & Roles**; each teammate first gets an operator-created account (`dist/auth-admin.mjs create`), then opens the link signed in with the invited email and accepts. **First remove the teammate's old (Clerk-era) member row** in Team & Roles: while any user row with that email is still a member, the invite answers 409 "This user is already a member of the organization" (`routes/members.ts:97-123`), and the dialog shows only "Failed to invite member" (`pages/team-roles.tsx:99-114`). Removing the old row is allowed (it is not the signed-in user) and is not undone by a rollback.

Consequences:
- Each person gets a new integer user id.
- Old authorship and audit rows keep pointing at the old ids. Nothing is rewritten; history stays correct as history.
- Old member rows stay listed in Team & Roles until an owner removes them. They count toward the "at least one Owner" guard: never demote or remove the only owner who can sign in. A removed owner is re-invited as Owner from **Team & Roles** by the remaining owner, after first removing that person's legacy member row (step 4); `21_owner_reinvite.psql` refuses while any owner who can sign in remains. An invitation does not restore a demoted owner (acceptance keeps an existing member's role): if the only owner who can sign in demoted themselves, another admin first removes that membership, and then `21_owner_reinvite.psql` applies.
- A person gets one extra (new, empty) personal workspace only if they open the app before accepting the invitation; signing in through the invite link and accepting first avoids it. After any sign-out the app opens the earliest membership, which can be that empty workspace: switch organizations in the menu.
- `users.is_platform_admin` is not carried to the new user id; nothing reads it for authorization in either version (inventory 11 counts it).

### Path B2: operator-linked accounts (same user id; needs approval for new code)

- **Prerequisite:** the `--link-user-id` addition to the operator command `dist/auth-admin.mjs` (design in the sign-up section, section 5). The command itself exists in `<REL>`; the link option does not.
  - It creates the Better Auth account and credential with a random temporary password.
  - **Before the person's first sign-in**, it inserts `auth_user_links(auth_user_id, user_id = <legacy id>)`.
  - The temporary password is shown once on the operator's terminal and delivered through a separate channel. The person replaces it at Account menu → Change password (enabled in `<REL>`, U2), which also ends every other session.
- **Result:** the person signs in and *is* their legacy user. Same `users.id`, memberships, roles, ownership and history. No extra workspace, no re-invites.
- **Pairs with closed sign-up (2a, now in place):** nobody can register the person's email first.
- **Never link by matching emails automatically.** The operator chooses the legacy id per person after an identity check.

### Conditions that need a per-person decision (Path B)

| Inventory value | Meaning | Handling |
|---|---|---|
| `duplicate_email_groups > 0` | Two legacy users share one email (case-insensitive) | B1: the invitation is per organization, so invite to the right organization. B2: the operator picks the user id explicitly |
| `users_without_usable_email > 0` | The legacy row has no usable email. This includes the d22a8e43 fallback `<clerk id>@unknown.local`, stored when Clerk had no email | B1 needs `-v allow_other_email=on` with the person's real sign-in email, after the identity check. Or use B2, or skip |
| `pending_invitations > 0` | Legacy pending invites | They are no longer auto-accepted by email at first login, as they were under Clerk. Acceptance now needs the link (token) plus the same signed-in email, so an admin of that workspace must re-share the link. Owners may revoke stale ones |
| `live_mode` workspaces | Workspaces that sent through the shared connector | After access is restored, each number needs a workspace credential (see the connector section) |

### Timing

Path A and B need nothing inside the maintenance window. B1/B2 steps run after the window, person by person, starting with owners of active or live workspaces.


---

## Shared connector transition

### What changes

**Production today (d22a8e43):**
- A workspace in `provider_connections.mode = 'real'` sends through the **shared Replit connector**: one connector account, with the WABA configured on the connection.
- Numbers carry no credential of their own.

**The release (R-D1):**
- There is no shared connector any more.
- A live workspace sends only from numbers that carry their **own encrypted workspace credential** (Numbers → connect).
- **Without one, every send fails closed before any provider request.**
  - While the number has no sending credential (`route.sendingCredentialId === null`) and the workspace is not mock, the whole batch is refused with `noSendingCredentialError` (`whatsapp-template-sender.ts:380-387`).
  - Once a credential is added, a plan frozen at d22a8e43 is read as "no credential" (`:289`), so it is refused with "Route phone sending credential changed after planning; re-plan the campaign" (`:356-358`). A transport envelope prepared earlier is refused the same way (`:594-597`).
- Mock workspaces are unaffected.

**Consequence:** live-workspace campaigns that still have queued work or a schedule at cutover would not send under the release. They would fail job by job: safe (no double send, no Meta call), but noisy and confusing for the customer. **Resolve them before the window.**

### Inventory (read only; internal ids only)

`inventory/12_connector_inventory_readonly.sql` prints:
1. connections by mode, status and health;
2. one row per live workspace: WABAs, numbers, connected numbers, approved templates, open campaigns, queued and processing jobs, last message date;
3. every non-sample number in live workspaces (internal id, status, internal WABA id, whether it has a provider id, and how many open or draft campaign routes use it). After the migration it also counts numbers without a sending credential;
4. every open campaign in a live workspace (Scheduled, Running, Paused, Ready) with its required action;
5. totals.

It exits 0 with `CONNECTOR INVENTORY: the window can start` only when there is no live campaign in action A, C or D2, no Queued or Processing job in a live workspace, and no contact import in progress in any workspace. Otherwise it exits 3.

It never prints connector account ids, WABA or phone provider ids, phone numbers, names, tokens or content.

### Actions per campaign

| Action | Campaigns | When | What to do |
|---|---|---|---|
| **A** | Running or Paused, with Queued or Processing jobs | **Before the window** | Let it finish (resume a Paused one), **or** cancel it in the app. Queued jobs would fail closed under the release. Owner decision per campaign |
| **B** | Running or Paused, with no queued or processing jobs (production creates all jobs at launch, `d22a8e43 campaign-planning.ts:326-351`) | None | Nothing will send. It completes or stays as is |
| **C** | Scheduled | **Before the window** | Cancel it, or move the window after it has run and finished. After the cutover, recreate it once its numbers have credentials |
| **D1** | Ready with no execution history (no `campaign_jobs` row) | **After the cutover** | Add the number's credential, then launch: the release's launch re-runs preflight and re-plans (`services/campaign-launch.ts:128-131`). Until the number has a credential, preflight blocks it |
| **D2** | Ready **with** execution history (any `campaign_jobs` row) | **Before the window** | Cancel it in the app. The release would resume the old frozen plan (`services/campaign-launch.ts:112-121`), which carries no credential, and it cannot be reopened. Recreate it after the cutover |
| Draft | Draft in live workspaces | After the cutover | Nothing to undo. Planning is blocked by preflight until the numbers have credentials |

**Rules:**
- Cancelling is done **in the app by the workspace owner or operator**, never by SQL.
- The final inventory run at window start must exit 0 (`window can start`): actions A, C and D2 resolved, no queued or processing job in a live workspace, no import in progress.
- The migration gate refuses to run while any job holds a live lease (`02_migrate.psql`).

### Numbers after the cutover (what Number Center shows)

- Legacy numbers keep their rows, ids, WABA links and campaign routes.
- They now show **"Credential associated: No"**, **setup state `unknown`** and no sending credential (`artifacts/wabista-nexus/src/pages/phone-numbers.tsx:297-302`).
- **To make a number send again**, a workspace owner or admin connects the WABA's token in Numbers:
  - Discovery **reuses the existing row** (upsert on `(organization_id, provider_phone_id)`, `whatsapp-manual-connection.ts:274-290`), so routes and history stay attached.
  - Then the owner or admin completes the number setup and sending activation (the Number Center flow).
  - These steps call Meta. They happen only after the cutover, by the workspace owner or with the user's approval, never as part of acceptance with live numbers.
- **Preflight** shows the blocker "`<number>` is not covered by this workspace's WhatsApp connection" with the action "Finish connecting WhatsApp for this business account" (`campaign-preflight-issues.ts:80`, code `provider_not_ready`). If the credential is inactive, the issue is "connection is not active" (`credential_not_ready`).
- **Transport scope:** each number id must be in exactly one cell's `CAMPAIGN_TRANSPORT_PHONE_IDS` and in `/etc/cowabista/cells.manifest`. A number in no scope never sends. The inventory's phone list gives the ids to assign.

### Inbound webhooks for messages sent before the cutover

Delivery and read statuses for messages already sent through the connector keep arriving at Meta's callback URL. The release matches them by provider message id, so they are processed as long as:
- the callback URL is `https://<PUBLIC_HOST>/api/webhooks/whatsapp`. The path is the same at production and at the release; only the origin changes if production is served from somewhere else today. The user changes it in the Meta app dashboard;
- the verify token and app secret are carried over unchanged (environment section).

Until the callback is switched, statuses go to the old endpoint.


---

## Public sign-up security decision

**Decision U2 (2026-10-22): Option 2a, approved and implemented (first in `1ebc518`; `<REL>` = `2a2afe6a2890da949947112e514236bc823935f1` carries it unchanged).** D4 "open sign-up" is reversed. Sections 1-4 below are the analysis the decision was made on (they describe `e37ab27e` before the change); section 5 is the operator procedure.

What `<REL>` does (tests: `artifacts/api-server/test/auth-signup-closed.test.ts`, `auth-config.test.ts`, E2E `auth-flow.spec.ts`):
- **Sign-up closed.** `AUTH_PUBLIC_SIGN_UP` is closed when unset or `closed`; `open` is accepted only outside production (tests and local development opt in). `open` with `NODE_ENV=production`, or any other value, stops startup. Closed means Better Auth's `disableSignUp` (which also refuses server-side `auth.api.signUpEmail`) and a 404 for `POST /api/auth/sign-up/email` from `authRequestGuard`, before Better Auth's limiter (no rate-limit row). `GET /api/auth-policy` answers `{"publicSignUp":false}` (no-store); the SPA shows no sign-up link or form and fails closed.
- **Existing and operator-created users sign in** exactly as before (`POST /api/auth/sign-in/email`, 3 per 10 s per address, origin/CSRF checks unchanged and still forced on). Minimum password length stays 12 (maximum 128).
- **Operator command** `dist/auth-admin.mjs` (`src/auth-admin.ts`, `src/lib/auth-admin.ts`): `create --email --name`, `reset-password --email`, `revoke-sessions --email`. It uses Better Auth's own internal adapter and scrypt hasher (the sign-up endpoint's sequence), so no SQL ever carries a password. It accepts exactly the email addresses Better Auth's sign-in accepts (zod `z.email()`), so it cannot create an account that could never sign in. Accounts are created unverified. The temporary password is 24 random base64url characters, printed exactly once and only to a terminal (the command refuses with exit 2 when stdout is not a terminal); it is never an argument, an environment variable, a log field or a file. `reset-password` replaces the password, then ends every session twice (a second sweep after about 5 s catches a sign-in that read the old password just before the change). Log lines carry only the action, the Better Auth user id and the operator name.
- **Change password** at Account menu → Change password (`/account/password`, Better Auth `POST /api/auth/change-password`): needs a session, a trusted origin, the current password, 12-128 characters; 3 per 10 s per address. A `hooks.before` refuses it unless `revokeOtherSessions` is `true` (400 `REVOKE_OTHER_SESSIONS_REQUIRED`), so a password change always ends every other session; the browser that changed it gets a new session cookie.
- **Unchanged:** invitation token security (accept needs the token and the invited email; tested in closed mode), origin/CSRF and rate-limit settings, no mailer, no password reset by email, no email verification. Linking an account to a legacy (Clerk-era) user id is **not** implemented (Path B2 would add it, see the Clerk-users section).
- No schema change and no Gate B measured file: `measuredFilesSha256` is unchanged.

### 1. What HEAD does today

| Setting | HEAD value | Where |
|---|---|---|
| `emailAndPassword.disableSignUp` | `false` | `API/lib/auth.ts:46` |
| `requireEmailVerification` | `false`; `autoSignIn: true` (a session starts straight after sign-up) | `API/lib/auth.ts:49-50` |
| `emailVerification.*` | not set | `API/lib/auth.ts:38-108` (missing) |
| `sendResetPassword`, `resetPasswordTokenExpiresIn`, `revokeSessionsOnPasswordReset` | not set; there is no mailer | same |
| Disabled paths | include `/change-password`, `/request-password-reset`, `/reset-password`, `/verify-email`, `/send-verification-email`, and every session-management path | `API/lib/auth.ts:26-31,69` |
| `databaseHooks.user.create.before` | checks only the trimmed name length (1-100) and the email length (at most 254), and drops any client image | `API/lib/auth.ts:85-99` |
| `authRequestGuard` | allows only `POST sign-in/email`, `POST sign-up/email`, `POST sign-out` and `GET get-session` (exact method and path). Anything else gets 404 before Better Auth. Bodies must be JSON or form, otherwise 415 | `API/middlewares/session.ts:9-14,21-33` |
| Rate limits (Better Auth) | sign-in and sign-up each allow 3 requests per 10 s. The key is client address + path. Stored in the database and shared by all processes | `BA/api/rate-limiter/index.mjs:248,305-311`; `API/lib/auth.ts:59` |
| Rate limits (general limiter) | 600/min per IP, held **in memory per process**. One bucket covers `/api/auth` and every signed-out `/api` request from that IP. `API_RATE_LIMIT_MAX_PER_MINUTE` overrides it | `API/app.ts:91,95`; `API/middlewares/rateLimit.ts:21-25,27-49` |
| Sessions | last 7 days, extended once a day on use; no cookie cache, so revocation is immediate. Users cannot list or revoke their sessions | `API/lib/auth.ts:52-53,29` |

How Better Auth 1.7.10 behaves with this setup (from the installed source):

**`disableSignUp` also blocks server-side calls.**
- With `disableSignUp: true`, the `/sign-up/email` handler throws `EMAIL_PASSWORD_SIGN_UP_DISABLED` (`BA/api/routes/sign-up.mjs:145-148`). That includes `auth.api.signUpEmail()` called from a script.
- An operator script must therefore use `(await auth.$context)` (`BA/auth/base.mjs:58`) and call:
  - `internalAdapter.createUser(...)`, which lowercases the email and runs the database hooks (`BA/db/internal-adapter.mjs:141-170`).
  - Then `internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(pw) })` (`BA/db/internal-adapter.mjs:609-615`).
- This is the sign-up endpoint's own sequence (`sign-up.mjs:214-240`), which runs inside `runWithTransaction` (`sign-up.mjs:144`).
- This path skips the email-format check and the 12-128 password-length check (`sign-up.mjs:151-154`), so the script must enforce both itself.

**Signing up with an email that already has an account reveals that the account exists.**
- It returns 422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (`sign-up.mjs:192-204`). The SPA shows "An account with this email already exists" (`SPA/lib/auth-errors.ts:14-16`).
- This only reveals emails that already have a Better Auth account. Legacy Clerk-era users have none until they register.
- Sign-in gives the same 401 whether the email is unknown or the password is wrong (`BA/api/routes/sign-in.mjs:319-337`).
- A generic fake-success response replaces the 422 only when `requireEmailVerification` is true or `autoSignIn` is false (`sign-up.mjs:155-156,195-203`).

**Hooks can refuse a sign-up, but the duplicate check runs first.**
- `create.before` runs inside `createUser`, *after* the duplicate check (`sign-up.mjs:192` comes before `:217`).
  - Returning `false` aborts the create (`BA/db/with-hooks.mjs:18`). The endpoint then answers 400 `FAILED_TO_CREATE_USER` (`sign-up.mjs:224-228`).
  - A thrown `APIError` passes through unchanged (`sign-up.mjs:226-228`).
  - The hook's second argument is the endpoint context (`with-hooks.mjs:8,17`). `context?.path` and `context?.body` are therefore readable, including extra body keys. The body schema allows extra keys (`sign-up.mjs:22`), and they are never stored (`BA/db/schema.mjs:63-64`).
- `hooks.before` runs before the endpoint handler (`BA/api/dispatch.mjs:209-221`), so it can refuse before the 422 duplicate check.
- **A refusal must not use status 403.** When `requireEmailVerification` is on (or `autoSignIn` is off), a 403 thrown by `createUser` silently becomes the fake-success duplicate response (`sign-up.mjs:227`). Use 400.

**Verification** (`CORE/types/init-options.d.mts:618-680`):
- `sendOnSignUp` defaults to the value of `requireEmailVerification` (`sign-up.mjs:241`).
- The token is a stateless JWT signed with the secret, valid 3600 s by default (`BA/api/routes/email-verification.mjs:14-20`). It is not single-use until the email is verified (`:178-187,287-293`).
- Signing in while unverified with the correct password gives 403 `EMAIL_NOT_VERIFIED`. If `sendOnSignIn` is set, it also resends the email (`sign-in.mjs:338-351`).
- `autoSignInAfterVerification` creates a session for whoever opens the link (`email-verification.mjs:297-316`).
- `GET /verify-email` checks `callbackURL` against trusted origins (`email-verification.mjs:132`).
- `POST /send-verification-email` without a session mails any unverified account. It enforces a 500 ms floor and awaits the mail send directly, not through the background handler (`email-verification.mjs:32,98-118`).
- `get-session` never checks `emailVerified` (no match in `BA/api/routes/session.mjs`). **Sessions that already exist survive turning verification on.**

**Password reset** (`CORE/types/init-options.d.mts:720-782`):
- Reset is off unless `sendResetPassword` is set (`BA/api/routes/password.mjs:51-56`).
- The token is a random 24-character id stored in `auth_verifications`, valid 3600 s by default (`password.mjs:73-79`), and consumed once (`password.mjs:160-162`).
- `revokeSessionsOnPasswordReset` **defaults to false** (`init-options.d.mts:775-782`, `BA/utils/password.mjs:34`).
- A reset does **not** mark the email as verified (`BA/utils/password.mjs:31-46`).
- An unknown email only does a dummy lookup; a known email waits for the mail send (`password.mjs:60-71` vs `:82`). That timing difference reveals which emails exist, unless `advanced.backgroundTasks.handler` is set (`BA/context/create-context.mjs:212-225`). The same wait happens inside the sign-up transaction (`sign-up.mjs:144,245`).

**Change-password** (`BA/api/routes/update-user.mjs:80-95,160-193`):
- It needs the current password and a valid session read from the database (`sensitiveSessionMiddleware`, `BA/api/routes/session.mjs:304-311`). It does **not** need a recently created session.
- It can revoke the user's other sessions (`revokeOtherSessions`, `update-user.mjs:93,174`).
- It is limited to 3 requests per 10 s (`rate-limiter/index.mjs:308`).

**`disabledPaths` only applies to HTTP requests through the router** (`BA/api/index.mjs:166-168`). Server-side `auth.api.*` calls ignore it.

### 2. Threats from open, unverified sign-up in this app

**1. Account squatting.** Anyone can register `victim@company.com` with their own password and get a session at once (`sign-up.mjs:255-264`).

What the squatter **gets**:
- An empty personal workspace, created on their first `/api` request that passes `attachOrgContext` (`API/middlewares/auth.ts:115-147`, `API/lib/orgProvisioning.ts:80-99`).

What the squatter **does not get**:
- A legacy production `users` row with the same email. These are never linked by email (`API/middlewares/auth.ts:48,58-67`).
- Automatic acceptance of invitations sent to that email. That only happens for verified accounts, on their first provisioning (`API/middlewares/auth.ts:115,140`).
- Being added straight into a team. Unverified accounts only get a pending invitation (`API/routes/members.ts:125-131`).
- Joining through an invitation without its token. Acceptance needs the token and a matching email (`API/lib/orgProvisioning.ts:119-137`).
- The token itself:
  - It is `randomUUID()` (`members.ts:151,162`).
  - Only that workspace's admins see it (`API/routes/invitations.ts:23-27,37`; `members.ts:166-177`).
  - It is shared by hand, since there is no mailer (`SPA/pages/team-roles.tsx:179`).
  - `GET /api/invite-info/:token` needs the token and returns only workspace name, role, invited email and status (`invitations.ts:69-104`). The general limiter covers it, and a UUID cannot be guessed.

**2. A leaked invite link is enough to join.** Someone can get an invite link from a forwarded chat, a screenshot or a shared screen. If the invited email has no account yet, they can sign up as that email (`invite-info` shows it) and join with the invited role. That role can be admin, or owner if an owner sent the invite (`members.ts:90-95`).

The code already treats the token as a credential:
- Request logs replace the token with a placeholder (`API/lib/http-logging.ts:5-6,14`).
- nginx keeps it out of the access log and sets Referrer-Policy (`deploy/nginx/wabista.conf.example:77-90,116-130`).
- Revoking sets the status to Revoked, after which accepting fails with 409 (`invitations.ts:179-187`, `orgProvisioning.ts:132-134`).
- Re-inviting a pending invite rotates the token; a re-invite after a revoke creates a new token (`members.ts:143-164`).

Closing sign-up (2a) or requiring email verification (3) closes this threat. Under 2c it stays at the level D1 already accepts.

**3. The real owner is locked out.**
- When the real person tries to sign up, they get 422.
- "I already have an account" fails because the password is the squatter's.
- There is no password reset, email change or account deletion (`API/lib/auth.ts:27-28,55`).
- Their pending invitations can never be accepted, because the email must match (`orgProvisioning.ts:135-137`).

Only an operator editing the database can fix this. Deleting the `auth_users` row cascades to sessions, accounts and the link (`lib/db/auth/src/index.ts:34,45,86`). It leaves the squatter's local `users` row and personal workspace behind.

**4. The cutover-specific risk (the worst one).** All production users are Clerk-era rows. They are deliberately left unlinked (D2, `docs/ARCHITECTURE.md:69-70`), and the "decision on existing Clerk users" is still open (`docs/ARCHITECTURE.md:120-122`). While sign-up is open:
- Anyone can register a customer's email before the customer does.
- Once customers register, the 422 lets anyone check which emails have accounts, at 3 attempts per 10 s per IP.
- **If an operator later links Better Auth accounts to legacy rows by matching email, a squatter would receive the customer's real workspace**: live numbers, contacts and campaigns.

Rule: link legacy rows only to accounts the operator created after checking identity.

Production also holds legacy Pending invitations from the Clerk era. Those were accepted by email at first login (d22a8e43 `API/middlewares/auth.ts` used Clerk's verified email). At HEAD they need the link (token) and a matching signed-in email, so admins must re-share links.

**5. Workspace spam and abuse.**
- Each sign-up writes rows in 7 tables: `auth_users`, `auth_accounts` and `auth_sessions` at sign-up, then `users`, `auth_user_links`, `organizations` and `organization_members` on first use. It also adds rate-limit rows.
- The only limits are per IP, so rotating IPs removes any cap.
- A self-registered user is the owner of their workspace. They can:
  - connect their own Meta credentials (`API/routes/whatsapp-manual.ts:56,69`)
  - test-send (`API/routes/message-studio.ts:116`)
  - import contacts and upload media to S3
- So production hosts would make Graph calls for tenants nobody has vetted.
- Campaign transport only handles phone ids inside a cell's scope (`docs/campaign-transport-operations.md:13-14`). New tenants' numbers are not sent through the transport until an operator widens a scope.
  - This holds only if **every** process running HEAD is scoped.
  - Every HEAD API process also starts the campaign runtime (`API/index.ts:29-36,50`), and an unscoped one owns every phone (`docs/campaign-transport-operations.md:21-27`).

**6. No recovery.**
- A forgotten password, a typo in the email at sign-up, or a stolen session cannot be fixed by the user.
- Sessions last 7 days and keep extending with use.

**7. Topology (open question).** The sign-up policy applies wherever HEAD serves `/api/auth`: the cells, or a HEAD build on Replit if production HTTP stays there. (A d22a8e43 Clerk deployment has no Better Auth at all.)
- A policy setting must be closed when unset, so a process that misses it fails safe.
- `TRUST_PROXY` (default 1, `API/app.ts:43-49`, `API/lib/http-config.ts:59-66`) must be `1`: nginx on N is the one trusted hop; an HTTP proxy or CDN in front of N is handled with `real_ip` on N (cutover P5), never by raising the value.
  - Both limiters depend on it, because Better Auth reads the address from `req.ip` (`API/middlewares/session.ts:43-45`).
  - If it is wrong, either everyone shares one bucket, or clients can fake their IP to dodge the limit.
- The API port must be reachable only through nginx (`deploy/nginx/wabista.conf.example:10-12`).
- A HEAD process on Replit would also start an unscoped campaign runtime (see threat 5). The cutover-order section must settle that first.

### 3. Options, ranked by effort (lowest first; the recommendation is 2a)

Effort is rough developer-days including tests and docs, excluding deployment.

| # | Option | Effort | Product consequence | Security consequence |
|---|---|---|---|---|
| 1 | Launch as implemented (open, unverified) | 0 code; operator script still needed (~0.5 d) | Self-serve onboarding works | Every threat in section 2. Partial mitigation: pre-create accounts for every legacy production email before go-live. The 422 then confirms all of those emails |
| 2b | Sign-up only for emails with a pending invite, or on an operator allow-list (env), without a token | ~0.5-1 d | Some self-serve | Weaker: anyone who knows or guesses a listed email can squat it and lock the real person out. **Not recommended** |
| **2a** | **`disableSignUp: true` + operator-created accounts (+ change-password)** | **~1-1.5 d** | No self-serve: every owner and teammate needs an operator to create the account. Invite links still work once the account exists ("I already have an account") | Removes squatting, the email-existence check and spam workspaces. A leaked link is a risk only if the operator creates an account for the wrong person, so the operator must check identity out of band |
| 2c | Sign-up only with a valid invite token for that email (add-on to 2a; new owners still go through the operator) | +~1 d | Teammates can sign up from their invite link | Same risk D1 already accepts (the link is the credential). The check must run in `hooks.before`, otherwise the 422 duplicate check comes first and the existence check returns. An invitee who signs up but never accepts gets a personal workspace on first dashboard visit (`API/middlewares/auth.ts:143`) |
| 3 | Password reset + email verification over generic SMTP (can sit on top of 2a; reopening sign-up is a separate decision) | ~3-5 d, plus provider and DNS lead time (SPF/DKIM/DMARC) | Self-recovery; self-serve if sign-up is reopened | An unverified account gets no session from sign-up or sign-in (`sign-up.mjs:251-254`, `sign-in.mjs:338-351`). Duplicate sign-ups get the generic response. Verified users get direct add and, on first provisioning, automatic invite acceptance (`members.ts:130`, `API/middlewares/auth.ts:140`). **Remaining risk, pre-hijack:** a squatter signs up with the victim's email and their own password. Their own sign-up mails the victim a genuine verification link, and they can trigger it again (`sign-up.mjs:241-249`, `sign-in.mjs:340-349`, `email-verification.mjs:98-118`). If the victim clicks it, the account is verified while the squatter still knows the password (`email-verification.mjs:295`). Pending invites for that email then auto-accept. Other remaining risks: throwaway-mailbox spam, and SMTP becomes a production dependency |

**What 2a involves:**
- **Setting.** Add one strictly parsed setting, closed when unset, as a new `AuthEnv` field (`API/lib/auth-config.ts:9-15,28-69`).
  - It drives `disableSignUp` (`API/lib/auth.ts:46`) and whether `authRequestGuard` admits `POST /api/auth/sign-up/email` (`API/middlewares/session.ts:9-14`).
  - The two must follow the same value; tests and dev opt in to open.
  - Production either leaves it unset or sets it explicitly to closed and lists it in `CAMPAIGN_CELL_REQUIRED_ENV` (`deploy/systemd/cell-1.env.example:20`; the guard refuses an empty listed variable, `deploy/systemd/campaign-cell-guard.sh:64`). It cannot be both unset and required.
- **SPA.** Hide sign-up when it is closed and replace it with "ask your administrator":
  - route `SPA/App.tsx:157`
  - CTAs `SPA/pages/home.tsx:59,86,135`
  - sign-in footer `SPA/pages/auth.tsx:91`
  - sign-up page `:112-167`
  - invite button `SPA/pages/invite.tsx:111-118`
  - Also fix the stale copy "They'll join automatically … the moment they sign up" (`SPA/pages/team-roles.tsx:349,442`).
- **Change-password.**
  - Remove `/change-password` from `DISABLED_PATHS` (`API/lib/auth.ts:27`) and add `POST /api/auth/change-password` to the guard.
  - Add a settings form that sends `currentPassword`, `newPassword` and `revokeOtherSessions: true`. This gives users one self-service way to kill a stolen session.
  - It needs a valid session, not a recent one (section 1).
- **Operator script.** See section 5. Update the "Nothing else may import this module" comment (`API/lib/auth.ts:11-16`).
- **Docs.** Update D4 and the guard description (`docs/ARCHITECTURE.md:71,76-77`) and `docs/ARCHITECTURE.md:65`.
- **Tests.** This is a **deliberate contract change and must be disclosed**:
  - `artifacts/api-server/test/auth-session.test.ts:75-125,298-313` (`:301` asserts that change-password answers 404)
  - fixtures `artifacts/api-server/test/auth-http-fixtures.ts:67-69` (also used by `invitation-accept.test.ts`)
  - e2e `artifacts/wabista-nexus/test/e2e/auth-helpers.ts:19-27`, `auth-flow.spec.ts:30-38,78-83`, `workspace-switch-permission.spec.ts:46`
  - Add tests for the closed mode: 404 from the guard, and `EMAIL_PASSWORD_SIGN_UP_DISABLED` if it is reached.

**What 2c involves:**
- In `hooks.before` (a `createAuthMiddleware` that matches `ctx.path === "/sign-up/email"`; today only `hooks.after` exists, `API/lib/auth.ts:100-107`):
  - Require `ctx.body.inviteToken` to match a `Pending` `organization_invitations` row whose lowercased email equals the lowercased body email.
  - Refuse with one uniform **400** for every failure.
  - Repeat the check in `create.before` as defence in depth.
- In the SPA, send `inviteToken` from `?invite=` (read at `SPA/pages/auth.tsx:18-19`) in the sign-up body at `:129`.
- Add tests, including that an existing email without a valid token gets the same 400, not 422.

**What 3 involves:**
- **Mailer module:** a new pinned dependency (no mailer is installed today) or a provider HTTP API.
  - Strictly parsed env: `SMTP_HOST`, `SMTP_PORT` (465/587), `SMTP_USER`, `SMTP_PASSWORD=<SECRET>`, `MAIL_FROM`.
  - Required in production on every HTTP process. List them in `CAMPAIGN_CELL_REQUIRED_ENV`.
  - Outbound SMTP must be allowed from those hosts.
  - Never log the SMTP password, verification or reset URLs, or tokens.
  - Enqueue mail and return quickly. `send-verification-email` awaits the send directly, with only a 500 ms floor (`email-verification.mjs:32,105-117`).
- **`auth.ts` changes:**
  - `requireEmailVerification: true`
  - `emailVerification: { sendVerificationEmail, sendOnSignUp: true, expiresIn }`. Decide `sendOnSignIn` and `autoSignInAfterVerification` together with the pre-hijack mitigation below.
  - `sendResetPassword`: email the SPA URL built from the `token` argument (`password.mjs:82-86`), so `/reset-password/:token` never needs allowing.
  - `resetPasswordTokenExpiresIn` (e.g. 1800)
  - `revokeSessionsOnPasswordReset: true`
  - `onExistingUserSignUp`: tell the existing owner that someone tried to sign up with their email (`sign-up.mjs:201`).
  - `onPasswordReset`: set `emailVerified = true` through `(await auth.$context).internalAdapter.updateUser`, because the reset proves the person controls the mailbox. This is the self-service way back for a squatted email.
  - `advanced.backgroundTasks.handler`, so mail sending does not hold transactions open or reveal timing.
  - Remove `/request-password-reset`, `/reset-password`, `/verify-email` and `/send-verification-email` from `DISABLED_PATHS` (`auth.ts:28`). Keep `/verify-password` disabled.
- **Pre-hijack mitigation.** Recommended design: the sign-up form never sets a usable password. Create the account with a random password nobody sees, and mail a set-password (reset) link, so only the mailbox owner ever chooses the password. `onPasswordReset` then marks the account verified. Prove this in tests. Failing that, at minimum:
  - `autoSignInAfterVerification: false`
  - verification-mail wording ("if you did not create this account, do not click; use Forgot password")
  - the `onExistingUserSignUp` notice
- **Guard:** allow `POST /api/auth/request-password-reset`, `POST /api/auth/reset-password`, `GET /api/auth/verify-email` and `POST /api/auth/send-verification-email`.
  - Better Auth limits reset requests and verification-email requests to 3 per 60 s (`BA/api/rate-limiter/index.mjs:312-317`).
  - `reset-password` and `verify-email` fall under the default 100 per 10 s (`API/lib/auth.ts:59`).
- **nginx:** `/api/auth/` logs request lines including query strings today (`deploy/nginx/wabista.conf.example:65-75`), so the verification JWT would be logged. Add no-log locations with Referrer-Policy for `/api/auth/verify-email` and for the SPA reset (and any verify) page, like `/invite/`.
- **SPA:**
  - a "check your inbox" state, because sign-up no longer signs in (change `SPA/pages/auth.tsx:129-136`)
  - a resend option when sign-in returns `EMAIL_NOT_VERIFIED`
  - forgot-password and reset-password pages
  - new error codes in `SPA/lib/auth-errors.ts`
- **Tests:** use only a captured or fake mail transport (no real mail). Cover:
  - verify, reset and expiry
  - the reset revoking sessions
  - the same response for known and unknown emails
  - the guard changes; `auth-session.test.ts:303-304` currently asserts that the reset paths answer 404, so that contract changes
  - pre-hijack
  - e2e
- **At the switch:**
  - Every existing account is unverified: sign-up stores `false` (`sign-up.mjs:222`), and so does the operator script.
  - Each user's next sign-in returns 403 and sends mail, so mail must work first.
  - Existing sessions survive.
  - Decide in advance: mark operator-created, identity-checked accounts as verified (this enables direct add and auto-accept). Revoke the sessions of all remaining unverified accounts (every self-registered one, if Option 1 ran).

**Files and Gate B.**
- None of these options changes the schema.
- They touch `API/lib/auth*.ts`, `API/middlewares/session.ts`, new script and mailer files, `package.json` and the lockfile (Option 3), the nginx and env examples, docs, the SPA and the tests.
- None of those is a Gate B measured file (`artifacts/api-server/benchmark/campaign-benchmark.ts:144-159`). The auth tables sit outside `lib/db/src` (`lib/db/auth/src/index.ts:4-6`). So `measuredFilesSha256` does not change, as long as nothing edits `lib/db/src` or the listed services.

### 4. Recommendation

**Launch with 2a** (closed sign-up + operator script + change-password), once the user approves reversing D4. Add **2c** only if creating teammate accounts by hand becomes too much work before SMTP is ready. Ship **Option 3** (reset first, verification with the pre-hijack mitigation) as the next release, then decide separately whether to reopen sign-up.

Why 2a:
- The cutover needs an operator-controlled step for existing Clerk users anyway: linking legacy `users` rows, which depends on the open Clerk-user decision.
- 2a removes every new attack surface at the lowest cost.
- It never relies on an unproven email.

### 5. Operator procedure (implemented as `dist/auth-admin.mjs`)

The command below is the implementation of the design that follows. It is run **by an operator, with the user's explicit approval, against production**.

```bash
# On one cell host, as the service user, interactively on a terminal, after an out-of-band identity check:
cd /opt/cowabista/artifacts/api-server && sudo -u cowabista env NODE_ENV=production node --env-file=/etc/cowabista/cell-cell-1.env dist/auth-admin.mjs create --email 'person@example.com' --name 'Person Name'
# reset-password --email '<email>'   (new temporary password; every session ended)
# revoke-sessions --email '<email>'  (every session ended; password unchanged)
```
Put each value in single quotes and nothing else; write an apostrophe as `'\''` (for example `--name 'Anil D'\''Souza'`). Never use double quotes or `sh -c` around a value someone else supplied: the shell would expand it, and the service user can read every production secret.
Precondition for `create` and `reset-password`: as root or through `sudo`, `sudo grep -rhiE 'log_?(output|input)|log_(tty|std)(in|out)|log_stderr' /etc/sudoers /etc/sudoers.d/; echo "exit=$?"` must print exactly `exit=1` (no sudo I/O logging; any matched line, `exit=0`, `exit=2` (a file could not be read) or a sudo error means STOP), and `sudo -l | grep -ciE 'log_(output|input|tty|std)'` must print `0` (also covers sudo rules from SSSD or LDAP). The terminal must not be recorded either (script, tmux pipe-pane, session recording); otherwise the temporary password would be kept. Exit 0 done, 1 refused (duplicate or unknown email, bad input) or failed, 2 usage or not a terminal. Deliver the temporary password through a separate channel; the person signs in and changes it.

Design notes (as approved; `--link-user-id` below is **not** implemented: it belongs to Path B2). Agents and development machines never run it against the production database (CLAUDE.md hard rules).

**Where it runs.** On a host that has the production API environment:
- a cell's env file, `/etc/cowabista/cell-<cell>.env` (for example `/etc/cowabista/cell-cell-1.env`, `deploy/systemd/campaign-cell@.service:21`). The release runs only on the cells (summary U1).

**Environment it needs.**
- `DATABASE_URL` (`lib/db/src/index.ts:7-9`).
- `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`: importing `lib/auth.ts` validates both (`API/lib/auth.ts:111-114`, `API/lib/auth-config.ts:46-66`).
- `NODE_ENV=production`. The systemd unit sets it, not the env file (`campaign-cell@.service:23`).
- Load the env file without printing it.

**Safety.** Importing `lib/auth.ts` does not start the campaign runtime; only `src/index.ts` does (`API/index.ts:29-36,50`). Never run the script through `dist/index.mjs`.

| Command | What it does |
|---|---|
| `create --email --name [--link-user-id N]` | **Before running it, the operator checks identity out of band.** The script then: (1) validates the email format; (2) refuses if `findUserByEmail` finds the email; (3) generates the password; (4) runs `createUser({ email, name, emailVerified: false }, { method: "email-password" })` and then `linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(pw) })` (`BA/db/internal-adapter.mjs:141-170,609-615`; `sign-up.mjs:217-240`). Make the pair atomic. Either use `runWithTransaction(ctx.adapter, …)` from `@better-auth/core/context` (`sign-up.mjs:8,144`), which needs `@better-auth/core@1.7.10` added as a direct pinned dependency because it does not resolve from the API today. Or delete the new auth user if `linkAccount` fails (the delete cascades, `lib/db/auth/src/index.ts:45`). Optional `--link-user-id N` inserts `auth_user_links(auth_user_id, user_id=N)` **before the password is handed over**. Otherwise the first sign-in creates a placeholder row and a new workspace (`API/middlewares/auth.ts:51-67`). The link is keyed by `auth_user_id` and `user_id` is unique (`lib/db/auth/src/index.ts:86-89`). Link refusals: refuse if N is already linked, or if N's `clerk_id` starts with `better-auth:`. Require N's `users.email` to equal the account email (case-insensitive) unless the operator overrides after checking. Legacy rows may carry `<clerkId>@unknown.local` (d22a8e43 `API/middlewares/auth.ts:51-54`), and `users.email` is not unique. Leave `emailVerified` false unless ownership was proven, because true turns on direct add and automatic invite acceptance |
| `reset-password --email` | **Identity check out of band first**; otherwise the recovery desk becomes the attack. Steps (as implemented): `ctx.password.hash`, then `updateAccount(account.id, { password })` (or `linkAccount` if there is no credential account), then `deleteUserSessions(userId)`, and a second `deleteUserSessions` about 5 s later (it catches a sign-in that read the old hash), so no session survives on the old password |
| `revoke-sessions --email` | `deleteUserSessions` (users cannot do this themselves, except through change-password with `revokeOtherSessions` under 2a) |

Rules for the script:
- Generate temporary passwords of 12-128 characters from a cryptographic random source.
- Never take a password as a command-line argument or environment variable (shell history, `ps`).
- Show the password once on the operator's terminal only. Never log it, store it in a file or commit it.
- Deliver it through a separate channel, and tell the user to change it immediately. This is why change-password is part of 2a.
- Log the action, the Better Auth user id and the operator (never the email, never any secret); the journal timestamp gives the time.

**If Option 1 is chosen anyway:**
- Pre-create accounts for every legacy production email before go-live.
- Never link legacy rows to self-registered accounts.
- Add a `delete-account` command. It must also remove the leftover local `users` row and the personal workspace.


---

## Production media storage plan

**Decision U4 (2026-10-22): the initial production launch uses an external S3-compatible provider.** The application stays vendor-neutral (endpoint, region, bucket, keys and addressing style are configuration only). Nobody provisions or connects a real provider from this preparation work: the owner chooses the provider and creates the bucket and a least-privilege key, and the runbook uses placeholders only. MinIO on a dedicated host (R-D2) remains an alternative or a later option. Media upload is part of the production acceptance test (acceptance 1.14), so storage must be configured before the window.

This section covers where the campaign media bytes (Message Studio uploads) live in production for release `<REL>`, and how to set that up. Every code claim cites `path:line` at `e37ab27e` unless it says `d22a8e43:` (the media code is unchanged in `<REL>`). Paths are relative to `/home/user/cowabista`. Nothing in this plan changes a repository file, so it has no effect on the Gate B hash. If a later code change touches measured files, the hash changes and that must be stated.

Vendor facts marked *(verify)* come from general knowledge. They could not be checked here because this review had no network access. Confirm each one against the vendor's documentation during setup.

### 1. What the code needs from storage (facts)

- **One private S3-compatible bucket, used only by the API.**
  - The backend is selected explicitly by `CAMPAIGN_MEDIA_STORAGE` (`artifacts/api-server/src/services/campaign-media-storage.ts:18-28`; parser `:313-350`).
  - Nothing falls back to a public bucket or a URL (`campaign-media-storage.ts:27`).
  - There is no presigned-URL code. `git grep -i -E 'presign|getSignedUrl|s3-request-presigner|x-amz'` over `artifacts/` and `lib/` returns nothing.
  - The browser uploads raw bytes to the API (`artifacts/wabista-nexus/src/lib/message-studio-model.ts:94-98`). The API streams previews (`artifacts/api-server/src/routes/message-studio.ts:164-194`; URL `/api/organizations/:org/campaigns/:id/media/:mediaAssetId/content`, `lib/api-client-react/src/generated/api.ts:5097`).
  - The bucket therefore needs **no CORS and no public access** (`docs/DEVELOPMENT.md:175-176`).
- **The server generates the keys.**
  - Key shape: `organizations/<org>/campaigns/<campaign>/media/<uuid>` (`campaign-media-assets.ts:103`). Any other key is refused (`campaign-media-storage.ts:38-42`).
  - Object name: `<PREFIX>/<key>`, or `<key>` when the prefix is empty (`campaign-media-storage.ts:132-135`).
  - The database stores the key **without** the prefix (`campaign-media-assets.ts:103,160`). If `CAMPAIGN_MEDIA_S3_PREFIX` or the bucket changes after the first upload, every existing asset breaks unless the objects are copied first.
- **S3 operations used (complete list):**

  | Operation | Where | IAM action |
  |---|---|---|
  | `PutObject` (body < 8 MiB) | `campaign-media-storage.ts:178` | `s3:PutObject` |
  | `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload` (body ≥ 8 MiB; parts of exactly 8 MiB plus a final tail) | `:153`, `:159`, `:183`; part size `:95`; slicing `:168-174` | all covered by `s3:PutObject` *(verify for non-AWS)* |
  | `AbortMultipartUpload` (best effort, on any error after the multipart upload was created) | `:185-190` | `s3:AbortMultipartUpload` |
  | `GetObject` (planning or test-send read; preview stream) | `:199`, `:233` | `s3:GetObject` |
  | `DeleteObject` | `:258` | `s3:DeleteObject` |

  - The in-process fake S3 implements this subset plus `CreateBucket`, which only the tests use (`artifacts/api-server/test/fake-s3-server.ts:1-3`).
  - The code sends no ACL, no server-side-encryption header and no `ContentType`. Objects carry only `Cache-Control: private, no-store` (`:153`, `:178`).
  - When the API streams a file, it sets the content type from the database row (`routes/message-studio.ts:174`).
- **Client settings** (`campaign-media-storage.ts:361-373`):
  - The client uses explicit credentials only, never the default provider chain, so an EC2 instance role cannot be used (`:367`).
  - Flexible checksums are sent only when required (`:368-369`). This keeps non-AWS providers working.
  - `maxAttempts: 3` and a 5 s connection timeout (`:370-371`). The connection timeout aborts the request.
  - **The 60 s `requestTimeout` does not abort anything.** The pinned SDK (`@aws-sdk/client-s3@3.1154.0`, `pnpm-lock.yaml:403`) uses `@smithy/node-http-handler@4.12.1`. Without `throwOnRequestTimeout: true`, that handler only writes a console warning (`node_modules/.pnpm/@smithy+node-http-handler@4.12.1/node_modules/@smithy/node-http-handler/dist-cjs/index.js:83-99,385`).
  - The warning text is `@smithy/node-http-handler - [WARN] a request has exceeded the configured 60000 ms requestTimeout...` and it goes to stderr, so to the journal.
  - Consequence: a storage endpoint that accepts the connection and then stalls can hang an upload, a preview or a plan indefinitely. Planning holds the campaign lifecycle lock during that time (`campaign-planning.ts:302-306,326`). Monitor for this line (section 8).
- **Which code paths touch storage (management plane only):**
  - Upload, preview and delete (`routes/message-studio.ts:132-194`).
  - Planning and test send. They read the bytes once per asset per sending number when no reusable binding exists, then upload them to Meta in real mode (`campaign-media-binding.ts:85-123`). Callers: `campaign-planning.ts:326` (sequential loop, `:314-330`) and `message-test-send.ts:158`.
  - **Sending does not read storage.** Send preparation reads only the stored provider-media binding (`campaign-media-binding.ts:151-185`; callers `template-resolution.ts:263,375`). A storage outage blocks uploads, previews, and planning or test sends that use media. It does not stop running campaigns.
  - Bindings live 29 days and are reused at planning only while at least 7 days remain (`campaign-media-binding.ts:29-31,95`).
  - Send preparation needs an unexpired binding, otherwise the job fails closed (`:175,182`). This is independent of storage.
- **Limits and memory:**
  - Size caps: JPEG and PNG 5 MiB, MP4 and 3GPP 16 MiB, PDF 100 MiB (`campaign-media-assets.ts:25-31`).
  - An upload holds about one 8 MiB part in memory at a time (`campaign-media-storage.ts:115-120,164-175`).
  - The planning and test-send read buffers the whole object, up to 100 MiB (`campaign-media-storage.ts:195-227`), before the Meta upload. Keep this in mind against `MemoryMax=3584M` (`deploy/systemd/campaign-cell@.service:43`).
  - The upload body is not parsed by Express: only JSON and urlencoded parsers are global (`artifacts/api-server/src/app.ts:81-82`).
  - nginx streams `/api/` bodies: 6g limit, no request buffering, 300 s timeouts (`deploy/nginx/wabista.conf.example:57-60`). Those timeouts are inactivity timeouts, not a total limit, so 100 MiB uploads pass.
- **Error handling:**
  - Storage errors carry fixed messages that never include the endpoint, bucket, key or a credential (`campaign-media-storage.ts:27-28,109-113`).
  - The SDK error name and HTTP status go only to the WARN line `campaign media storage request failed`, with the fields `storage`, `operation`, `errorName` and `httpStatus` (`:111`).
  - A failed abort logs `campaign media multipart abort failed` (`:188`).
  - Only `NoSuchKey`, `NotFound` or a 404 count as a missing object. `NoSuchBucket`, 403 and redirects count as "unavailable" (`:102-107`). In that case:
    - uploads, planning and test send answer 503 `media_storage_unavailable` (`campaign-media-assets.ts:140`; `campaign-media-binding.ts:112`);
    - the preview answers 503 (`routes/message-studio.ts:185-186`);
    - delete still answers 204, because the byte removal error is swallowed (`campaign-media-assets.ts:234`) and the object stays as an orphan (section 9).
  - With no storage configured, uploads and planning with media answer 503 (`campaign-media-assets.ts:100-101`; `campaign-media-binding.ts:104-105`). The preview then answers 404 (`routes/message-studio.ts:169-170`).

### 2. Options compared

**Decision:** R-D2 (MinIO on the dedicated servers, `docs/ARCHITECTURE.md`, R-D2) is superseded for the initial launch by U4 (2026-10-22): an external S3-compatible provider. MinIO stays an alternative or later option (section 3). The comparison below is kept for that later choice.

| | MinIO on dedicated infrastructure (R-D2) | External S3-compatible provider | AWS S3 |
|---|---|---|---|
| Where it runs | A **new dedicated host** on the private network that Hosts C and D can reach. No such host exists in the current topology (`deploy/README.md:15-19`). **Not Host S** (CLAUDE.md hard rule; PostgreSQL and Redis have dedicated CPU and disk, `deploy/README.md:19`). **Not Host C or D** ("nothing else running", `deploy/README.md:17-18,55`). | Provider region close to Hosts C and D | AWS region close to Hosts C and D |
| TLS | Operator-run. With path-style addressing (the default when an endpoint is set, `campaign-media-storage.ts:344`), a certificate for the one hostname is enough. A private CA needs `NODE_EXTRA_CA_CERTS` (section 7). | Provider-managed public certificate | Provider-managed |
| Durability modes *(verify)* | Single node, single drive: durability equals the disk (use RAID1 or a ZFS mirror). Single node, multiple drives (erasure-coded): survives the loss of a drive, not of the host. Multi-node: survives the loss of a node. Because storage is management-plane only (section 1), one erasure-coded node plus off-host replication is enough. | Managed | Managed, multi-AZ |
| Credential scoping | IAM-style policy scoped to the bucket and the prefix | Varies by provider (table below) | IAM policy scoped to the bucket and the prefix |
| Backups | Operator: versioning (check which deployment modes support it *(verify)*), then `mc replicate` or `mc mirror` to an off-host target | Versioning plus an optional cross-provider copy | Versioning plus optional cross-region replication |
| Operator burden | Highest: host, OS patching, certificates, disks, monitoring, upgrades. MinIO community edition is AGPLv3, and its console and binary distribution changed in 2025 *(verify the licence and the install or patch channel)*. | Low | Low |
| Cost drivers | Hardware and operator time | Storage plus egress terms | Storage plus internet egress per GB *(verify)* |

Egress volume is small in every option. Reads happen only for previews, and once per asset per sending number when no reusable binding exists. Worst case: a 100 MiB PDF × 8 numbers ≈ 0.8 GiB per plan per asset.

**External provider notes** *(all verify)*:

- The endpoint must be the **regional origin, with no bucket name and no path**. The parser refuses a path (`campaign-media-storage.ts:303`).
- Do not copy a dashboard URL of the form `https://.../<bucket>`, or a virtual-host URL `https://<bucket>.<region>...`.

| Provider | `CAMPAIGN_MEDIA_S3_ENDPOINT` form | `_REGION` | Addressing | Key scoping | Caveats |
|---|---|---|---|---|---|
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (EU jurisdiction: `<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`) | `auto` | path-style OK | API token per bucket; no prefix scoping | No egress fees. Keep r2.dev and public bucket access **off**. Parts must be equal-sized except the last, which the code satisfies (`campaign-media-storage.ts:168-174`). |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004`, `eu-central-003` | path-style OK | Application key per bucket **and** name prefix | Keeps all versions by default. Set a lifecycle rule so that deletes free space. Free egress up to a multiple of the stored data. |
| Wasabi | `https://s3.<region>.wasabisys.com` | AWS-style, e.g. `eu-central-1` | path-style OK | Sub-user with an IAM-style policy (bucket and prefix) | Minimum storage duration (90 days) and a minimum monthly charge. Egress free under a fair-use policy. |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` | region slug, e.g. `fra1` | path-style OK | Per-bucket limited keys; no prefix scoping | Keep the CDN off and File Listing "Restricted". |
| Hetzner Object Storage | `https://<location>.your-objectstorage.com` | `fsn1`, `nbg1`, `hel1` | path-style OK | S3 credentials are **project-wide**: put the bucket in a **dedicated project** | EU only. Lowest latency if Hosts C and D are Hetzner machines. |
| AWS S3 | **leave unset** | the bucket's own region (a mismatch gives a redirect or a region error; the app treats both as "unavailable") | virtual-host (the default without an endpoint, `campaign-media-storage.ts:344`) | IAM user policy, bucket and prefix | Turn on Block Public Access and set Object Ownership to "Bucket owner enforced". Use IAM user access keys, not an instance role (`:361,367`). |

All region values above match the parser's rule `^[a-z0-9-]{1,32}$` (`campaign-media-storage.ts:332`). Use a bucket name **without dots**. The parser allows dots (`:335`), but with virtual-host addressing a dotted name breaks wildcard TLS certificates.

### 3. Decision and placement

1. **Decided (U4): an external S3-compatible provider for launch** (AWS S3, or another S3-compatible service such as Wasabi or Backblaze B2; the owner picks it).
   - It needs no new host, no Host S change and no private CA.
   - Prefer a provider whose keys can be limited to this bucket, ideally to the prefix.
   - Customer files (PDFs, images) are processed by that provider: data residency and the processor agreement are part of the owner's choice.
   - **Media is not deferred any more:** acceptance 1.14 uploads, previews and deletes a file, and the startup log must show `kind: "s3"` (acceptance 0.4).
   - `campaign_media_assets` ships empty, so the first configuration needs no data migration. Switching providers later is a copy plus a configuration change (section 9).
2. **Alternative or later: MinIO on a new dedicated host (R-D2).** It needs that host and operator-run TLS.
3. **Where the block goes:**
   - Put the same block on **every process that serves `/api`**. That means both cells (`deploy/systemd/cell-1.env.example:13-18`, `deploy/README.md:73`), because each cell is HTTP plus transport.
   - The transport side never touches storage.
   - The release runs only on the cells behind nginx (summary U1); it is never deployed to Replit.

### 4. Environment block (placeholders only)

The env file is named after the unit instance: `/etc/cowabista/cell-%i.env` with instance `cell-1` (`deploy/systemd/campaign-cell@.service:21`; `deploy/README.md:95`). That is **`/etc/cowabista/cell-cell-1.env`** on Host C and **`/etc/cowabista/cell-cell-2.env`** on Host D (`deploy/systemd/cell-1.env.example:1`). The file is root:cowabista 0640 (`deploy/README.md:51-54`). The media lines must be identical on every cell:

```
# --- Campaign media (external S3-compatible provider; MinIO uses the same block) ---
CAMPAIGN_MEDIA_STORAGE=s3
# S3 endpoint: the provider's https origin, no path. Leave this line out for AWS S3 itself.
CAMPAIGN_MEDIA_S3_ENDPOINT=https://<S3_ENDPOINT_HOST>[:<PORT>]
CAMPAIGN_MEDIA_S3_REGION=<REGION>
CAMPAIGN_MEDIA_S3_BUCKET=<BUCKET>
CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID=<ACCESS_KEY_ID>
CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY=<SECRET_ACCESS_KEY>
# Path-style option: only if the provider requires a specific addressing style. Default: path-style (true) when
# an endpoint is set, virtual-hosted (false) for AWS without an endpoint. Exactly true or false.
# CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE=<true|false>
# Only if the endpoint uses a private CA (section 7; not needed for a public provider):
# NODE_EXTRA_CA_CERTS=/etc/cowabista/media-ca.pem
# CAMPAIGN_CELL_REQUIRED_ENV: use the single canonical line from the environment section §9 unchanged. It already
# lists the media names and CAMPAIGN_MEDIA_S3_REGION next to the encryption key, TRUST_PROXY and WHATSAPP_APP_ID.
# Never write a second CAMPAIGN_CELL_REQUIRED_ENV line, and never replace it with a media-only list.
```

- `CAMPAIGN_MEDIA_S3_REGION` is always set explicitly when media is enabled (for MinIO: `us-east-1`), and it is in the env §9 required list, because the parser silently defaults it to `us-east-1` (`campaign-media-storage.ts:331`).
- Do not list `CAMPAIGN_MEDIA_S3_PREFIX`. The guard requires the listed names to be non-empty (`campaign-cell-guard.sh:64`), and an empty prefix is legitimate.
- `CAMPAIGN_MEDIA_S3_PREFIX` stays unset (default `campaign-media`). `CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE` stays unset unless the provider's documentation requires the other addressing style; then set it to exactly `true` or `false` on both cells (never list it in the env §9 required list).
- For AWS S3, delete the `_ENDPOINT` line (path style then defaults to false) and remove `CAMPAIGN_MEDIA_S3_ENDPOINT` from the env §9 list.
- Media is enabled at launch (U4), so the whole block and the `CAMPAIGN_MEDIA_*` names of the env §9 list are required. (Only if the owner later reverses U4 would the block and those names be left out.)

Parser rules (`parseCampaignMediaStorageConfig`, `campaign-media-storage.ts:313-350`). Values are trimmed, and a blank value counts as unset (`:290-293`):

| Rule | Line |
|---|---|
| Any `CAMPAIGN_MEDIA_S3_*` or `CAMPAIGN_MEDIA_STORAGE_DIR` set without the selector stops startup | `:315-317` |
| The selector must be exactly `local` or `s3` | `:328` |
| `local` is refused when `NODE_ENV=production` (the unit sets that, `campaign-cell@.service:23`) | `:321` |
| `CAMPAIGN_MEDIA_STORAGE_DIR` together with `s3` stops startup | `:329` |
| The endpoint must be a full `http(s)` origin: no path, no `?` or `#`, no `user:pass@`. It is normalised to the origin, so a trailing `/` is fine. **The parser accepts `http:`; the production rule is `https` only.** | `:295-307` |
| Region defaults to `us-east-1` and must match `^[a-z0-9-]{1,32}$` | `:331-332` |
| Bucket is required and must match `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$` | `:333-335` |
| Prefix: **unset** gives `campaign-media`; **set but empty** (`CAMPAIGN_MEDIA_S3_PREFIX=`) gives the bucket root. Segments must match `[A-Za-z0-9._-]+` and must not be `.` or `..`; no leading or trailing `/`. Leave it unset (default `campaign-media`), as the environment section does; never change it after the first upload. | `:336-339` |
| `FORCE_PATH_STYLE` must be `true` or `false`. Default: `true` when an endpoint is set, `false` when not (AWS virtual-host). | `:340-344` |
| The access key ID and the secret are both required | `:345-348` |

The store is created once per configuration and cached for the process (`:383-394`). Any change needs a restart of every API process, cell by cell (`deploy/README.md:114-116`).

### 5. Bucket creation

**Steps, for the day storage is enabled** (run by the operator; vendor commands marked *(verify)* against the vendor's current documentation; secrets typed with `read -rs` or written to 0600 files, never on a command line or screen):
- **MinIO (R-D2) on the new dedicated host** *(verify)*: install MinIO with TLS (section 7). With the admin alias configured from a 0600 config file:
  1. `mc mb --with-versioning <ALIAS>/<BUCKET>`
  2. `mc admin policy create <ALIAS> wabista-media <policy.json>` (the section 6 policy), then `mc admin user add <ALIAS> <ACCESS_KEY_ID>` (it prompts for the secret; never pass it as an argument) and `mc admin policy attach <ALIAS> wabista-media --user <ACCESS_KEY_ID>`
  3. `mc ilm import <ALIAS>/<BUCKET> < lifecycle.json` (the JSON below)
  4. Run the section 8 smoke script.
- **AWS S3** *(verify)*:
  1. `aws s3api create-bucket --bucket <BUCKET> --region <REGION> --create-bucket-configuration LocationConstraint=<REGION>` (for `us-east-1`, omit `--create-bucket-configuration`)
  2. `aws s3api put-public-access-block --bucket <BUCKET> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`
  3. `aws s3api put-bucket-ownership-controls --bucket <BUCKET> --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'`
  4. `aws s3api put-bucket-versioning --bucket <BUCKET> --versioning-configuration Status=Enabled`
  5. `aws s3api put-bucket-lifecycle-configuration --bucket <BUCKET> --lifecycle-configuration file://lifecycle.json`
  6. Create an IAM user with only the section 6 policy, and write its access key straight to a 0600 file (`(umask 077; rm -f key.json; aws iam create-access-key --user-name <USER> > key.json)`), never to the screen.
  7. Run the section 8 smoke script.
- **Other S3-compatible providers:** the same properties through the provider's console or API (section 2 table), then the smoke script.

- **Privacy:** use a dedicated bucket for this application and environment. Keep it private: no public ACL, no bucket policy with `"Principal":"*"`, no website hosting, no CDN or public domain. On AWS, enable all four Block Public Access settings and set Object Ownership to "Bucket owner enforced".
- **Encryption:** use the provider default (SSE-S3 or equivalent).
  - Do not require SSE-C: the code sends no customer-key headers (`campaign-media-storage.ts:153,178`).
  - Avoid SSE-KMS unless you also grant the KMS permissions.
- **CORS: none.** The browser never talks to the bucket (section 1).
- **Versioning: recommended.** It is what makes a database restore consistent (section 9). The app credential gets `s3:DeleteObject` but not `s3:DeleteObjectVersion`, so a leaked app key cannot purge history.
- **Lifecycle** (S3 JSON; on MinIO use `mc ilm import`). Replace `<PREFIX>/` with `organizations/` if `CAMPAIGN_MEDIA_S3_PREFIX` is empty:

```json
{ "Rules": [
  { "ID": "abort-incomplete-multipart", "Status": "Enabled", "Filter": { "Prefix": "<PREFIX>/" },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } },
  { "ID": "expire-old-versions", "Status": "Enabled", "Filter": { "Prefix": "<PREFIX>/" },
    "NoncurrentVersionExpiration": { "NoncurrentDays": <DAYS_AT_LEAST_DB_BACKUP_RETENTION> },
    "Expiration": { "ExpiredObjectDeleteMarker": true } }
] }
```

  - **Why the first rule exists:** the app's abort is best effort (`campaign-media-storage.ts:185-190`), and it never runs if the process is killed mid-upload.
  - **Why one day is safe:** an upload never spans more than one HTTP request (`routes/message-studio.ts:132-153`), so an incomplete multipart upload older than a day is abandoned. The nginx 300 s values are inactivity timeouts, not an upper bound on upload time.
  - **Never expire current objects.** Assets live as long as their database row, and frozen plans reference asset ids.

### 6. Least-privilege credential

Use this policy on AWS, MinIO and Wasabi. On B2, R2, DigitalOcean and Hetzner, use the closest scoping the provider offers (section 2):

```json
{ "Version": "2012-10-17",
  "Statement": [
    { "Sid": "CampaignMediaObjects", "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::<BUCKET>/<PREFIX>/organizations/*" },
    { "Sid": "MissingKeyIs404", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<BUCKET>" }
  ] }
```

- **Why `s3:ListBucket`:** the code never lists. The permission is there because AWS answers a `GetObject` on a missing key with 403 instead of 404 when the caller lacks ListBucket *(verify)*.
  - The app maps 403 to "storage unavailable" (503) instead of "file no longer available" (409 at planning, 404 at preview) (`campaign-media-storage.ts:102-107`; `campaign-media-binding.ts:111`; `routes/message-studio.ts:185-188`).
  - On a dedicated bucket, unconditional ListBucket reveals only this application's keys. The smoke check verifies the 404 (section 8).
- **One credential for all cells.** Keep the provider's root or admin keys off the application hosts. Do not pass secrets as command-line arguments: they end up in shell history and `ps`.
- **Clock:** SigV4 needs a synchronised clock. Hosts C and D run NTP (`deploy/README.md:44`). Clock skew shows up as 403, which the app reports as "unavailable".
- **Rotation:**
  1. Create the second key.
  2. Update the env file on every API process.
  3. Restart the cells one at a time (`deploy/README.md:114-116`), verifying each as in section 8.
  4. Revoke the old key.

### 7. TLS

- **Endpoint:** use `https://` only. With path-style addressing, the certificate needs only the endpoint hostname in its SAN (or an IP SAN if the endpoint is an IP address). Virtual-host addressing (`FORCE_PATH_STYLE=false`) needs a wildcard certificate and MinIO's `MINIO_DOMAIN` *(verify)*.
- **MinIO:** the simplest choice is a publicly trusted certificate for an internal name under a real domain (for example ACME DNS-01). Then nothing changes on the app side.
- **Private CA:**
  - The SDK's Node HTTP handler builds a default `https.Agent` (`@smithy/node-http-handler@4.12.1`, `dist-cjs/index.js:419-440`), so Node's default trust store applies, including `NODE_EXTRA_CA_CERTS`. Node reads that file **once at process start** and appends it to the bundled roots.
  - Set `NODE_EXTRA_CA_CERTS=/etc/cowabista/media-ca.pem` (the CA certificate only, 0644) in the cell env file. systemd exports it before `node` starts (`campaign-cell@.service:21,28`), and `ProtectSystem=full` leaves `/etc` readable (`:49`).
  - If the file is missing, Node prints `Warning: Ignoring extra certs from ...` and continues. Uploads then fail as "unavailable" and the smoke check shows a certificate error code, so check the journal for that warning.
  - Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### 8. Startup validation and the missing reachability check

- **What the API checks at startup:**
  - `describeCampaignMediaStorage()` runs at module load (`src/index.ts:21`), before the listener starts (`:38`) and before the crash handlers are installed (`:81`).
  - A malformed or half-configured block throws an error that names the variable and never echoes a value (`campaign-media-storage.ts:309-312,313-350`). The process exits non-zero.
  - Under systemd that exit is not 78. The unit restarts it every 2 s, re-running the guard each time, until 10 attempts in 300 s, then it fails (`campaign-cell@.service:11-12,27,35-37`). Read `journalctl -u campaign-cell@cell-1` to find the variable name.
  - With `CAMPAIGN_MEDIA_STORAGE` unset in production, the API logs WARN `No campaign media storage configured: media uploads answer 503` (`src/index.ts:45-46`). With the media names in `CAMPAIGN_CELL_REQUIRED_ENV`, a missing value becomes a guard refusal with exit 78 (`deploy/systemd/campaign-cell-guard.sh:11,64`).
  - Otherwise the API logs INFO `Campaign media storage` with `campaignMediaStorage: {kind, endpoint (or "aws"), region, bucket, prefix, forcePathStyle}`, without credentials (`src/index.ts:48`; `campaign-media-storage.ts:353-359`). **After every start, confirm that these values are identical on every cell.**
- **What it does not check:**
  - Nothing contacts the bucket at startup. `/healthz` and `/readyz` (`routes/health.ts:14,25`) have no storage reference.
  - Bad credentials, a wrong region, a TLS failure, clock skew or a missing bucket show up only on the first upload, preview, plan or test send. They appear as 503 plus the WARN line from `campaign-media-storage.ts:111`.
  - A stalled endpoint produces no error at all, only the smithy `requestTimeout` warning (section 1).
  - The repository's emulator test refuses non-local endpoints (`test/campaign-media-storage.test.ts:297-302`), so it cannot serve as a production check.
- **Operator smoke check.** Run it on **each cell host** before go-live and after any storage, credential or CA change. The operator runs it; it reads the checkout's `node_modules` and changes nothing in `/opt/cowabista`.
  - It uses the API's SDK (`@aws-sdk/*` is external to the bundle, `artifacts/api-server/build.mjs:63`, and a runtime dependency, `artifacts/api-server/package.json`), the same configuration rules, the same user and the same CA.
  - It writes and deletes only probe objects under organization `0`, which never exists (ids are `serial`).
  - It prints only step names, SDK error names, error codes and HTTP status codes. It never prints a credential, endpoint, bucket or key.
  - It also checks that an anonymous GET of a live probe object is refused.
  - Save it as `/usr/local/lib/cowabista/media-smoke.cjs` (root:root 0644):

```js
// Campaign media bucket smoke check. Same SDK, settings rules, user and CA as the API process.
// Prints only step names, SDK error names and HTTP status codes: never a credential, endpoint, bucket or key.
const { randomUUID } = require("node:crypto");
const s3 = require(require.resolve("@aws-sdk/client-s3", { paths: [process.cwd()] }));
const v = (name) => { const raw = (process.env[name] ?? "").trim(); return raw ? raw : undefined; };
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exitCode = 1; };
setTimeout(() => { console.log("FAIL timeout: storage did not finish within 180 s"); process.exit(1); }, 180_000).unref();
if (v("CAMPAIGN_MEDIA_STORAGE") !== "s3") { fail("config CAMPAIGN_MEDIA_STORAGE is not s3"); process.exit(1); }
for (const name of ["CAMPAIGN_MEDIA_S3_BUCKET", "CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID", "CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY"]) {
  if (!v(name)) { fail(`config ${name} is empty`); process.exit(1); }
}
const Bucket = v("CAMPAIGN_MEDIA_S3_BUCKET");
const endpoint = v("CAMPAIGN_MEDIA_S3_ENDPOINT") ? new URL(v("CAMPAIGN_MEDIA_S3_ENDPOINT")).origin : undefined;
const region = v("CAMPAIGN_MEDIA_S3_REGION") ?? "us-east-1";
const prefix = process.env.CAMPAIGN_MEDIA_S3_PREFIX === undefined ? "campaign-media" : process.env.CAMPAIGN_MEDIA_S3_PREFIX.trim();
const fps = v("CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE");
const forcePathStyle = fps === undefined ? endpoint !== undefined : fps === "true";
const client = new s3.S3Client({ region, endpoint, forcePathStyle,
  credentials: { accessKeyId: v("CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID"), secretAccessKey: v("CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY") },
  requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  maxAttempts: 3, requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 } });
const key = () => `${prefix ? `${prefix}/` : ""}organizations/0/campaigns/0/media/${randomUUID()}`;
const send = (command, input) => client.send(new s3[command](input));
const status = (e) => e?.$metadata?.httpStatusCode ?? "";
const why = (e) => `${e?.name ?? "Error"}${e?.code ? ` ${e.code}` : ""} ${status(e)}`.trim();
const step = async (name, run) => {
  try { const result = await run(); console.log(`OK   ${name}`); return result ?? true; }
  catch (e) { fail(`${name} ${why(e)}`); return undefined; }
};
// Same rule as the API (campaign-media-storage.ts:102-107): NoSuchBucket is a fault, not a missing file.
const isMissing = (e) => e?.name !== "NoSuchBucket" && (e?.name === "NoSuchKey" || e?.name === "NotFound" || status(e) === 404);
const expectMissing = async (name, Key) => {
  try { await send("GetObjectCommand", { Bucket, Key }); fail(`${name} object is still readable`); }
  catch (e) { if (isMissing(e)) console.log(`OK   ${name}`); else fail(`${name} ${why(e)}`); }
};
const objectUrl = (Key) => (endpoint
  ? (forcePathStyle ? `${endpoint}/${Bucket}/${Key}` : `${endpoint.replace("://", `://${Bucket}.`)}/${Key}`)
  : `https://${Bucket}.s3.${region}.amazonaws.com/${Key}`);
(async () => {
  const small = Buffer.alloc(1024, 7), part = Buffer.alloc(5 * 1024 * 1024, 1), K = key();
  const put = await step("put", () => send("PutObjectCommand", { Bucket, Key: K, Body: small, ContentLength: small.length, CacheControl: "private, no-store" }));
  if (put) {
    const got = await step("get", async () => Buffer.from(await (await send("GetObjectCommand", { Bucket, Key: K })).Body.transformToByteArray()));
    if (got && !got.equals(small)) fail("get content mismatch");
    try {
      const anonymous = await fetch(objectUrl(K), { redirect: "manual" });
      await anonymous.body?.cancel();
      if (anonymous.status === 200) fail("anonymous-get returned 200: the bucket or object is publicly readable");
      else console.log(`OK   anonymous-get refused ${anonymous.status}`);
    } catch (e) { fail(`anonymous-get could not be tried ${why(e)}`); }
    await step("delete", () => send("DeleteObjectCommand", { Bucket, Key: K }));
    await expectMissing("deleted-key-is-missing", K);
  }
  await expectMissing("never-written-key-is-missing", key());
  const M = key(), up = await step("create-multipart", () => send("CreateMultipartUploadCommand", { Bucket, Key: M, CacheControl: "private, no-store" }));
  if (up && !up.UploadId) fail("create-multipart returned no UploadId");
  if (up?.UploadId) {
    const abort = (name) => step(name, () => send("AbortMultipartUploadCommand", { Bucket, Key: M, UploadId: up.UploadId }));
    const p1 = await step("upload-part", () => send("UploadPartCommand", { Bucket, Key: M, UploadId: up.UploadId, PartNumber: 1, Body: part, ContentLength: part.length }));
    const p2 = p1 && await step("upload-part-tail", () => send("UploadPartCommand", { Bucket, Key: M, UploadId: up.UploadId, PartNumber: 2, Body: small, ContentLength: small.length }));
    const done = p1?.ETag && p2?.ETag && await step("complete-multipart", () => send("CompleteMultipartUploadCommand", { Bucket, Key: M, UploadId: up.UploadId, MultipartUpload: { Parts: [{ ETag: p1.ETag, PartNumber: 1 }, { ETag: p2.ETag, PartNumber: 2 }] } }));
    if (done) await step("delete-multipart-object", () => send("DeleteObjectCommand", { Bucket, Key: M }));
    else { if (p1 && p2 && !(p1.ETag && p2.ETag)) fail("upload-part returned no ETag"); await abort("abort-after-failed-multipart"); }
  }
  const A = key(), ab = await step("create-multipart-2", () => send("CreateMultipartUploadCommand", { Bucket, Key: A }));
  if (ab && !ab.UploadId) fail("create-multipart-2 returned no UploadId");
  if (ab?.UploadId) await step("abort-multipart", () => send("AbortMultipartUploadCommand", { Bucket, Key: A, UploadId: ab.UploadId }));
  const O = `wabista-smoke-outside-prefix/${randomUUID()}`;
  try {
    await send("PutObjectCommand", { Bucket, Key: O, Body: small, ContentLength: small.length });
    console.log("WARN outside-prefix put allowed (credential is not prefix-scoped)");
    await send("DeleteObjectCommand", { Bucket, Key: O }).catch((e) => fail(`outside-prefix cleanup ${why(e)}`));
  } catch (e) {
    if (e?.name === "AccessDenied" || status(e) === 403) console.log("OK   outside-prefix refused");
    else fail(`outside-prefix ${why(e)}`);
  }
})().catch((e) => fail(`unexpected ${why(e)}`));
```

Run it on Host C (on Host D use `cell-cell-2.env`):

- **Before W6** (the pre-window check, cutover P6): the staged file and the P4 build directory (the live d22a8e43 file has no media block, and its checkout has no AWS SDK):

```
systemd-run --wait --pipe --quiet --uid=cowabista --gid=cowabista \
  -p EnvironmentFile=/etc/cowabista/cell-cell-1.env.next -p WorkingDirectory=<P4 dir>/artifacts/api-server \
  /usr/bin/node /usr/local/lib/cowabista/media-smoke.cjs
```
  (`cell-cell-2.env.next` on Host D.)

- **After W6** (live files):

```
systemd-run --wait --pipe --quiet --uid=cowabista --gid=cowabista \
  -p EnvironmentFile=/etc/cowabista/cell-cell-1.env -p WorkingDirectory=/opt/cowabista/artifacts/api-server \
  /usr/bin/node /usr/local/lib/cowabista/media-smoke.cjs
```

  - **Pass:** every line is `OK` and the exit status is 0.
    - `WARN` on the last step is expected only on providers whose keys cannot be prefix-scoped. With versioning on, delete that probe's leftover version by hand, because it lies outside the lifecycle prefix.
    - A `FAIL never-written-key-is-missing ... 403` on AWS means ListBucket is missing (section 6).
    - Codes such as `ECONNREFUSED`, `ENOTFOUND` or `SELF_SIGNED_CERT_IN_CHAIN` point to network, DNS or CA problems.
    - The hosts need outbound access to the endpoint on 443.
  - **App-level check**, run by the operator through the public URL:
    - Use a **dedicated, clearly named internal workspace**. A workspace with no WhatsApp connection row is in mock mode (`services/template-eligibility.ts:197-201`).
    - Create a Draft campaign and open Message Studio as a manager or higher (`routes/message-studio.ts:132,155`).
    - Use a simple file name (`campaign-media-assets.ts:33`). Then:
      1. Upload a PNG: expect 201.
      2. Open its preview (content route): expect the image.
      3. Upload a PDF larger than 8 MiB (this exercises multipart through nginx): expect 201.
      4. Delete both: expect 204.
    - The journal must show no `campaign media storage request failed` line.
    - Upload, preview and delete make no provider call (`campaign-media-assets.ts:16-19`).
    - **Do not** plan or test-send with media in a real-mode workspace as part of this check. That uploads the file to Meta (`campaign-media-binding.ts:114-116`), and a test send delivers a real message.
    - This check writes rows to the production database: the test workspace, the campaign, and the asset rows, which stay as `deleted` (`campaign-media-assets.ts:230`). Do it only under the production-access rules.
  - **Ongoing monitoring:** alert on these lines in the cell journals:
    - `campaign media storage request failed` (`campaign-media-storage.ts:111`);
    - `campaign media multipart abort failed` (`:188`);
    - `@smithy/node-http-handler - [WARN] a request has exceeded the configured 60000 ms requestTimeout` (section 1);
    - `Ignoring extra certs from`.
    - Optionally run the smoke script hourly from a systemd timer on one host. With versioning, its probes leave noncurrent versions until the lifecycle rule expires them.
    - For MinIO, also monitor its health endpoint (`/minio/health/live`) and disk usage *(verify)*.

### 9. Retention, backups, restore consistency, orphans

- **What the rows hold:** database rows reference objects by `storage_key`, which is unique (`lib/db/src/schema/message-studio.ts:55,63`). The rows also hold `sha256` and `byte_length` (`:53,56`), so a copied or restored object can be verified against its row.
- **When the app removes objects** (all best effort, failures ignored):
  - after a refused or failed upload (`campaign-media-assets.ts:137-138`, `:167-168`);
  - after a soft delete commits (status `deleted`, `campaign-media-assets.ts:216-234`).
- **Orphan sources:**
  - The removals above can fail while the request still succeeds (`catch(() => undefined)`, `campaign-media-assets.ts:138,168,234`).
  - A process killed after the bytes are written (`:132`) but before the row is inserted (`:151-166`).
  - Incomplete multipart uploads (lifecycle rule, section 5).
  - **Campaign hard delete.** `DELETE /campaigns/:campaignId` (`routes/campaigns.ts:313-341`) cascades the asset rows (`message-studio.ts:50`, `onDelete: cascade`) but never calls the store.
  - Orphans are harmless but cost storage. No app feature removes them.
- **Optional periodic sweep:**
  - Run it from an ops machine with a **separate ops credential** that has List and Delete, not the app key.
  - Candidates are objects under `<PREFIX>/organizations/` whose key has **no row**, or whose row has `status = 'deleted'`.
  - Get the row keys with `SELECT storage_key, status FROM campaign_media_assets`, using a read-only role under the production-access rules.
  - Delete only after review.
- **Restore consistency:**
  - **Database restored to time T, bucket current:**
    - Assets uploaded after T become orphans (harmless).
    - Assets deleted after T come back as `ready` without bytes. Planning then fails "no longer available" (`campaign-media-binding.ts:111`) and the preview answers 404 (`routes/message-studio.ts:188`).
    - With versioning, recover those objects by removing the delete marker. This is why noncurrent-version retention must be at least the database backup or PITR window.
  - **Bucket restored to an older point than the database:** recent assets lose their bytes, with the same failure.
    - Back up the bucket at least as recently as the database: provider versioning or replication, `rclone` or `mc mirror` to a second location with separate credentials, or MinIO site replication.
  - **Check after any restore:** for every `campaign_media_assets` row with `status='ready'`, HEAD `<PREFIX>/<storage_key>` and compare the size with `byte_length`.
- **Changing provider later** (for example to MinIO):
  1. Copy everything under `<PREFIX>/`, preserving keys.
  2. Verify counts and sample `sha256` values.
  3. Do a final sync in a quiet window.
  4. Switch the env block on every API process and restart them one at a time. The configuration is cached per process (`campaign-media-storage.ts:383-394`).
  5. After the last restart, run the sync once more, copying only missing keys. This catches uploads that landed in the old bucket during the rolling restart.
  6. Keep the old bucket read-only for a rollback window.

  A different prefix requires copying into that prefix.

### 10. Replit media migration

- **d22a8e43 had only an unused upload route:**
  - `POST /organizations/:org/campaigns/:id/template-mapping-image-upload` returned a Replit-sidecar signed PUT URL and `objectPath: /objects/...` (`d22a8e43:artifacts/api-server/src/routes/campaign-media.ts:29-67`; `d22a8e43:artifacts/api-server/src/lib/object-storage.ts:3-22,40-72`). It used `PRIVATE_OBJECT_DIR` (`object-storage.ts:24-30`).
  - No front-end code at d22a8e43 calls it. A search of `artifacts/wabista-nexus` and `artifacts/mockup-sandbox` for the route name, `RequestCampaignImageUpload` and `uploadURL` finds nothing. Only the generated client in `lib/` declares it.
  - Nothing at d22a8e43 serves `/objects/*`: the only reference outside generated code is `object-storage.ts:70`.
  - HEAD removed both files. `PRIVATE_OBJECT_DIR` is ignored (`test/campaign-media-storage.test.ts:58`).
- **No database-referenced media exists in production:**
  - `campaign_media_assets` is absent from the d22a8e43 schema (`git grep campaign_media d22a8e43 -- lib/db/src` is empty), so the new table starts empty and nothing needs copying.
  - `docs/DEVELOPMENT.md` said "copy into the bucket under the same keys"; that never applied here (corrected in the commit that adds this package): the old keys (`.../template-images/<uuid>.<ext>`, `d22a8e43:campaign-media.ts:62-63`) do not match HEAD's key pattern (`campaign-media-storage.ts:38`), and no row could reference them.
  - The only way to get managed media is to re-upload it in Message Studio.
- **Links, not managed media:**
  - At d22a8e43 a media header is a mapping with `component='header'` and `variable='media'` (`d22a8e43:services/template-mapping.ts:30,71-72`), sent as `{link: value}` (`d22a8e43:services/whatsapp-template-sender.ts:118-120`).
  - HEAD still accepts `static` and `csv` values here (`services/message-studio.ts:234-268`) and still sends them as `link` (`whatsapp-template-sender.ts:134-137`).
  - A static value that points at a Replit-hosted URL breaks when Replit is retired. A relative `/objects/...` value never worked as a link, because Meta needs an absolute URL.
  - **Jobs resolve from their own frozen plan, not from the live mappings** (`d22a8e43:lib/db/src/schema/campaign-engine.ts:129-135,326-334`; `d22a8e43:services/template-resolution.ts:112`; HEAD `template-resolution.ts:116`). So for campaigns that are already planned, the frozen `campaign_plans.mappings_snapshot` is what will be sent.
  - Draft and Ready campaigns without execution history can switch to an uploaded file (`campaign-media-assets.ts:68-81`).
  - Scheduled, Running and Paused campaigns cannot (`:75-80`). For those, keep the old URL reachable until they finish, or accept failed media sends.
- **Read-only inventory:** run `package/inventory/13_media_link_inventory_readonly.sql` (package README, "How to connect"). It is the single maintained copy of these queries:
  1. live media-header mappings, counts only;
  2. live static mappings that point at Replit-hosted objects: campaign, status and host only;
  3. frozen plans of campaigns that can still send (jobs resolve from these): every media-header host;
  4. after the migration, the `managed_media_assets` count.
  - It uses only columns that exist at both d22a8e43 and HEAD, prints counts and host names only (never paths, query strings or `user:pass@` parts: signed URLs carry signatures), and guards against a non-array `mappings_snapshot`. Lab evidence: package README, "Lab validation".
  - **`csv`-sourced media headers:** their URLs come from imported contact data, in `campaign_contacts.data` under the column named by `source_value` (`d22a8e43:lib/db/src/schema/campaign-engine.ts:57`). These queries do not inspect them.
    - A non-zero `csv` count means those imports need a manual look.
    - Do not scan `campaign_contacts` on the production primary at peak. Use a bounded sample or a restored copy.
  - **Sanity check:** immediately after the migration, and before storage is enabled, `SELECT count(*) FROM campaign_media_assets;` (read-only) must return 0.

### 11. Open items

- **Provider choice (U4 decided: external S3-compatible).** The owner chooses the provider, region and data residency, creates the bucket and the least-privilege key (sections 5-6) and stages the values on both cells before the window. Confirm every *(verify)* vendor fact at setup. `docs/ARCHITECTURE.md` records U4 next to R-D2.
- **Storage call timeout.** The SDK `requestTimeout` only warns (section 1), so a stalled endpoint can hang uploads, previews and planning while the lifecycle lock is held. Bounding it (for example with `throwOnRequestTimeout: true`) is a code change for a later release, with normal review. If it touches measured files, the Gate B hash changes.
- **Missing-key status code.** If the smoke check's `never-written-key-is-missing` fails on the chosen provider, grant ListBucket as in section 6 (or the provider's equivalent) before enabling uploads. Otherwise users see a missing file reported as "storage unavailable".

---


---

## Production environment contract (both API cells)

Source: HEAD `e37ab27e` (branch `wabista-nexus-v2`), plus the Option 2a change (first in `1ebc518`) that adds `AUTH_PUBLIC_SIGN_UP` and the operator command `dist/auth-admin.mjs` (no other environment variable changed), the guard fix `f967bd7` and the relocatable build fix `2a2afe6` (= `<REL>`; it changes no environment variable). Guard line citations (`guard:N`, `campaign-cell-guard.sh:N`) in this runbook use the `d22a8e43` numbering; in `<REL>` every guard line from 40 on is 2 higher. Paths are relative to the repository root.

Library behaviour comes from the installed versions: better-auth 1.7.10, @better-auth/core 1.7.10, pg 8.22.0, pino 9.14.0, @aws-sdk/client-s3 3.1154.0 (with @smithy/core 3.36.0), @redis/client 6.2.1 and debug 4.4.3. Statements about systemd or the Node runtime come from their documentation, not from this repository, and are marked *(systemd)* or *(Node)*.

`deploy/systemd/campaign-cell@.service` has not changed since production `d22a8e43`. `campaign-cell-guard.sh` changed once, in `<REL>` (`f967bd7`): the scope-overlap check sorts both id lists before `comm`, so an overlap such as `9-12` against `12-14` is refused (at `d22a8e43` it passed with a `comm: … not in sorted order` warning). Outside `deploy/cutover/`, `git diff --stat d22a8e43 <REL> -- deploy/` lists only `README.md`, the nginx example, the two env examples and the guard.

### 1. How the environment reaches a cell

- **File name (blocker to fix in the runbook).** The unit reads `EnvironmentFile=/etc/cowabista/cell-%i.env` (`campaign-cell@.service:21`). The instance names are `cell-1` and `cell-2` (`cells.manifest.example:5-6`; `deploy/README.md:95`). So systemd opens **`/etc/cowabista/cell-cell-1.env`** and **`/etc/cowabista/cell-cell-2.env`**, which is what the example headers say (`cell-1.env.example:1`, `cell-2.env.example:1`).
  - A file named `/etc/cowabista/cell-1.env` is never read. Using that name needs a change to the unit.
  - Keep `%i`. `%I` (unescaped) would turn `-` into `/` *(systemd)*.
  - The directive has no `-` prefix, so a missing file fails the start before the guard runs *(systemd)*. That fails closed, but it blocks the cutover.
  - The file is read again at every start. After an edit, run `systemctl restart campaign-cell@cell-N`; no `daemon-reload` is needed *(systemd)*.
- **Unit-owned variables.** The unit sets `CAMPAIGN_CELL`, `NODE_ENV`, `CAMPAIGN_COORDINATOR_MODE`, `CAMPAIGN_CELL_MANIFEST` and `CAMPAIGN_CELL_REPO` itself (`campaign-cell@.service:22-26`).
  - Values from `EnvironmentFile=` override `Environment=` *(systemd)*, so none of these five may appear in the env file.
  - The guard re-checks `NODE_ENV` and the coordinator mode (`campaign-cell-guard.sh:55-56`). It does not re-check the manifest path.
- **No `.env` file.** ExecStart is `/usr/bin/node --enable-source-maps ./dist/index.mjs` (`campaign-cell@.service:28`), the same as the package `start` script (`artifacts/api-server/package.json:9`). Only `dev` passes `--env-file-if-exists=../../.env` (`package.json:7`). The bundle contains no dotenv loader. A repo-root `.env` is never read by a cell.
- **Runtime dependencies.**
  - `@aws-sdk/*` is external to the bundle (`artifacts/api-server/build.mjs:63`). It is loaded from `node_modules` at run time, so every cell checkout needs `pnpm install --frozen-lockfile` before the build (`deploy/README.md:46-49`).
  - Hosts need `/usr/bin/node` at version 22.12 or later (`package.json:13-14` at the root) and `pg_isready`, `redis-cli` and `git` (`deploy/README.md:44-45`).
  - Without `pg_isready`, the guard refuses after 60 s with a misleading "PostgreSQL … did not answer" (guard:61-62).
- **Shard threads.** The transport shard threads are created without an `env` option (`campaign-transport-shards.ts:79-81`), so they inherit the main process environment.
- **Schema first.** Every start writes to the production database. It upserts `template_eligibility` and fills `campaign_routes.waba_id` (`index.ts:30`; `template-eligibility.ts:480-507`). The HEAD schema must be in the database before the first cell starts. Otherwise initialization fails and the process exits 1 (`index.ts:34`; `startup.ts:65-71`) and keeps restarting.
- **One transport generation at a time.**
  - Every HEAD API process starts a campaign runtime (§8).
  - If a `d22a8e43` Replit deployment still runs (U1, evidence E2), it runs with `NODE_ENV=production` (`d22a8e43:artifacts/api-server/.replit-artifact/artifact.toml:21,29`), as an `autoscale` deployment (`d22a8e43:.replit:5`) in which each instance has an unscoped runtime. It is stopped in W3, before the first HEAD cell starts. Never let both generations claim jobs from the same database.
  - Real-mode jobs on phones that have no workspace credential fail closed and do not retry, with `credential_required` (`whatsapp-provider.ts:263-269`). Running real-mode campaigns therefore belong in the cutover order and must not be left to resume.
  - Open question: which Redis does current production use? `d22a8e43` also requires `CAMPAIGN_REDIS_URL` and `CAMPAIGN_COORDINATOR_MODE=redis` in production (`d22a8e43:artifacts/api-server/src/services/campaign-pacing-coordinator.ts:354-356`).

### 2. Startup outcome codes used below

| Code | Meaning |
|---|---|
| **G78** | The guard refuses with exit 78 and Node never starts (guard:6,11). The unit sets `RestartPreventExitStatus=78` to stop retries (`campaign-cell@.service:10,37`).<br>**This has not been verified under systemd.** systemd documents that setting for the main process's exit status, while `Restart=` also covers `ExecStartPre=` failures *(systemd)*. The guard was verified only as a script (commit `d0885a0`: "Verified locally"). Test it once on a non-production host.<br>If refusals are retried: instant refusals repeat every 2 s until 10 starts in 300 s (`:11-12,35-36`). The 60-s PostgreSQL/Redis waits take about 62 s per attempt, never reach that limit and keep retrying. Either way the app does not run. |
| **R1** | The app throws while loading, before it listens, and Node exits 1. `Restart=always` retries every 2 s until 10 starts in 300 s, then the unit is failed (`campaign-cell@.service:11-12,35-36`). After the fix, run `systemctl reset-failed campaign-cell@cell-N` *(systemd)*. |
| **R1i** | The app listens, initialization fails, and it exits 1 (`index.ts:34`; `startup.ts:65-71`). Restart behaviour is the same as R1. |
| **RT** | The app listens and initializes, then the `CampaignRuntime` constructor throws (`index.ts:31,50`; `startup.ts:81`; `campaign-runtime.ts:96-112,416-420`). The unhandled rejection goes to `shutdown()`, which exits 0 (`process-crash-handlers.ts:24-27`; `index.ts:54,81`). `Restart=always` restarts it, with the same start limit. |
| **LAZY** | The process starts. The feature fails at request or send time. |
| **SIL** | Silently accepted: either a default is substituted or the value is honoured. |
| **IGN** | Not read by HEAD code (checked in `src` and the built `dist/index.mjs`). `@aws-sdk/*` is not in the bundle (`build.mjs:63`); see §6. |

### 3. Variables in the cell env file (read by the API process or the guard)

"Same on both cells" means byte-identical on cell-1 and cell-2, and on any other HEAD process. **Never write an optional variable with an empty value (`NAME=`).** For several variables, an empty value behaves differently from leaving the variable out (rows marked ⚠).

| Variable | Category | Required / default | Same on both cells? | Secret | Production value | Missing or malformed | Code |
|---|---|---|---|---|---|---|---|
| `CAMPAIGN_TRANSPORT_PHONE_IDS` | transport | Required by the guard. In the app, unset means the process owns every phone it can see. | **Per cell, disjoint** | no | `<CELL1_PHONE_IDS>` / `<CELL2_PHONE_IDS>`: verified production `phone_numbers.id` values (1-4 and 5-8 were the benchmark layout). Must equal the manifest. | Unset, blank, malformed, different from the manifest or overlapping another cell: G78 (guard:15-17,22,36,41). App-only failures (for example more than 65 536 ids): RT (`campaign-phone-scope.ts:36-46`). | `campaign-phone-scope.ts:17-19,53-55`; `campaign-runtime.ts:96`; filter at `campaign-phone-reservoir.ts:190-191`. A phone in no scope is never sent from. |
| `PORT` | ports | Guard requires a positive integer; app default 8080 | Per host (use the same) | no | `8080` | Unset or not an integer: G78 (guard:59). Above 65535: R1 (`index.ts:15-17`). | `index.ts:11`. Listens on all interfaces (`index.ts:38`). |
| `DATABASE_URL` | PostgreSQL | Required | Identical | **yes** | `postgresql://cowabista:<DB_PASSWORD>@<HOST_S>:5432/cowabista` | Unset: G78 (guard:58) and R1 (`lib/db/src/index.ts:7-11`). Wrong password: the guard passes because `pg_isready` does not authenticate (guard:62), then R1i. Percent-encode reserved characters. An unencoded `@` in the password also leaks the rest of the password into the journal through the guard's redaction (guard:60,62,69). | `lib/db/src/index.ts:14`. Pools of 20 + 6 per process (`:21-39`). |
| `CAMPAIGN_REDIS_URL` | Redis | Required in production. `REDIS_URL` is a fallback; a non-empty `CAMPAIGN_REDIS_URL` wins. | Identical | **yes** | `redis://:<REDIS_PASSWORD>@<HOST_S>:6379` | Unset: G78 (guard:57) and RT (`campaign-pacing-coordinator.ts:354-355`; `campaign-prepared-broker.ts:344-350`). Not `redis://` or `rediss://`: RT (`campaign-pacing-coordinator.ts:234-237`; `campaign-prepared-broker.ts:148-151`). | `campaign-pacing-coordinator.ts:351`; `campaign-prepared-broker.ts:342` |
| `BETTER_AUTH_SECRET` | Better Auth | Required: at least 32 characters, no leading or trailing whitespace, not a placeholder or `CHANGE_ME`, estimated entropy at least 120 bits | **Identical** | **yes** | `<BETTER_AUTH_SECRET>`, generated once (`openssl rand -base64 32`) | R1 (`auth-config.ts:46-59`) | `auth.ts:42,111` |
| `BETTER_AUTH_URL` | URLs | Required: a full origin, https in production | **Identical** | no | `https://<PUBLIC_HOST>` | R1 (`auth-config.ts:61-66`; `http-config.ts:28-42`) | `auth.ts:40,113`; `session.ts:43-48` |
| `AUTH_PUBLIC_SIGN_UP` | Better Auth | Optional: unset or exactly `closed` means public sign-up is closed (U2, Option 2a); `open` with `NODE_ENV=production` (the unit sets it) or any other value stops startup | Identical | no | **leave it out** (or `closed`). Accounts are created with `dist/auth-admin.mjs` (signup section, "Operator command") | `open` or a malformed value: R1 (`auth-config.ts`, `parsePublicSignUp`) | Never in `CAMPAIGN_CELL_REQUIRED_ENV` (it is legitimately absent) |
| `CORS_ALLOWED_ORIGINS` | CORS | Optional; empty by default | Identical | no | **leave out** (single origin) | Bare host, path, `?`/`#`, `*` or credentials in an entry: R1 (`app.ts:30`; `http-config.ts:13-42`) | Each entry also becomes a Better Auth trusted origin (`auth-config.ts:67`). |
| `TRUST_PROXY` | proxy | Optional; default 1 (also when empty) | Identical | no | `1` | Not a non-negative integer: R1 (`http-config.ts:59-65`) | `app.ts:49`. Feeds `req.ip`, which the rate limiter (`rateLimit.ts:45-49`) and Better Auth (`session.ts:44`) use. |
| `LOG_LEVEL` | logging | Optional; default `info` | Identical | no | `info` | ⚠ Unknown **or empty**: R1 (`logger.ts:9`; pino `pino.js:165`, `lib/levels.js:175-194`). `silent` hides the verification log lines. | `logger.ts:9` |
| `META_APP_SECRET` | Meta webhooks | Needed for webhooks; not checked at startup | **Identical** | **yes** | `<META_APP_SECRET>`, carried over from current production | LAZY: POST answers 503 and processes nothing (`whatsapp-webhook.ts:29-34`) | `whatsapp-integration.ts:53` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Meta webhooks | Needed for webhooks; not checked at startup | **Identical** | **yes** | `<WHATSAPP_WEBHOOK_VERIFY_TOKEN>`, carried over | LAZY: GET verification answers 503 (`whatsapp-webhook.ts:12-17`) | `whatsapp-integration.ts:52` |
| `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` | credential encryption | Needed for any real sending; the app starts without it (`credential-crypto.ts:75-77`) | **Identical** | **yes** | `<WHATSAPP_CREDENTIAL_ENCRYPTION_KEY>`: 32 bytes as 64 hex characters. **New (`openssl rand -hex 32`) only if inventory 15 prints `NEW KEY PERMITTED`; otherwise the existing key, byte-for-byte (§7, "Encryption key rule")** | Missing **or malformed** (the guard checks presence only, guard:64): LAZY. "Connect number" answers 503 (`whatsapp-manual-connection.ts:128-130,172-177`); credential binding fails closed (`whatsapp-transport-credentials.ts:73-79`). | `credential-crypto.ts:19,53-73,79-82` |
| `WHATSAPP_APP_ID` | Meta (template media) | Needed for media template header examples | **Identical** | Identifier, not a secret; never record the real value | `<META_APP_ID>`, new | LAZY: 503 `media_not_configured` (`template-media.ts:86-89`). Changing it later makes existing uploads unusable at submission (`template-submission.ts:188-192`). | `template-media.ts:39,50-53` |
| `CAMPAIGN_MEDIA_STORAGE` | media S3 | Optional in code; `s3` in production | Identical | no | `s3` | Unset: SIL (kind "none", a warning only); uploads answer 503 (`campaign-media-storage.ts:316-318`; `campaign-media-assets.ts:100-101`; `index.ts:45-46`). `local`: R1 in production (`:321`). Any other value: R1 (`:328`). | `campaign-media-storage.ts:313-350` |
| `CAMPAIGN_MEDIA_S3_ENDPOINT` | media S3 | Leave out only for AWS itself; a full http(s) origin | Identical | no | `https://<S3_ENDPOINT_HOST>` (the provider's https origin, no path; leave the variable out for AWS S3 itself) | Malformed: R1 (`:295-306`). Any S3 variable without the selector: R1 (`:317`). Without it, `AWS_ENDPOINT_URL*` can redirect (§6). | |
| `CAMPAIGN_MEDIA_S3_BUCKET` | media S3 | Required with `s3` | Identical | no | `<MEDIA_BUCKET>` | Missing or invalid name: R1 (`:333-335`) | |
| `CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID` | media S3 | Required with `s3` | Identical | treat as secret | `<S3_ACCESS_KEY_ID>` | R1 (`:345-346`) | |
| `CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY` | media S3 | Required with `s3` | Identical | **yes** | `<S3_SECRET_ACCESS_KEY>` | R1 (`:347-348`) | |
| `CAMPAIGN_MEDIA_S3_REGION` | media S3 | Default `us-east-1` | Identical | no | `<REGION>`: always set when media is enabled (MinIO: `us-east-1`); listed in `CAMPAIGN_CELL_REQUIRED_ENV` (§9); required, because media is enabled at launch (U4) | Invalid: R1 (`:331-332`) | |
| `CAMPAIGN_MEDIA_S3_PREFIX` | media S3 | ⚠ Default `campaign-media` when absent; an **empty value means the bucket root** (`:336`) | Identical, and never changed after the first upload (applied at access time, `:132-135`) | no | leave out | Invalid: R1 (`:337-339`) | |
| `CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE` | media S3 | Default true when an endpoint is set | Identical | no | leave out | Not `true`/`false`: R1 (`:340-344`) | |
| `NODE_EXTRA_CA_CERTS` *(Node)* | TLS to MinIO | Only if MinIO's https certificate comes from a private CA | Identical | no (a file path) | `<PATH_TO_CA_PEM>` or leave out | Missing with a private CA: LAZY (media requests fail TLS) | Read by Node at process start. |
| `CAMPAIGN_PLATFORM_MAX_TPS` | rate limits | Default 1000 when absent or non-numeric; clamped to 1..10000 | Identical | no | **leave out** | ⚠ An **empty value or ≤ 0 is SIL, clamped to 1 msg/s** (`Number("")` is 0; `campaign-pacing-coordinator.ts:4,57-61`). | Planning (`campaign-delivery.ts:76,150`; `campaign-delivery-setup.ts:106,132`) and pacing (`campaign-pacing-coordinator.ts:85-88`) both use it, so it must match on every process. |
| `CAMPAIGN_TRANSPORT_SHARDS` | transport | Default 8, clamped to 1..16 | Identical | no | **leave out** | Non-numeric: SIL, **transport breaks**: no shard workers are created (`campaign-transport-shards.ts:75-78`) and routing divides by zero (`:222`). ⚠ An **empty value gives 1 shard** while the guard prints `shards=8` (guard:69). | Do not change without a measurement (`deploy/README.md:75`). |
| `API_RATE_LIMIT_MAX_PER_MINUTE` | rate limits | Test override; default 600 per key | — | no | **must be left out** | Invalid, empty or ≤ 0: falls back to 600; any positive value is honoured (`rateLimit.ts:18-25`) | No `store` is passed (`rateLimit.ts:27-51`), so counters are per cell. Better Auth's limits are shared through the database (`auth.ts:57-59`). |
| `CAMPAIGN_CELL_REQUIRED_ENV` | guard | Optional | Identical | no | see §9 | A listed name that is unset or empty: G78 (guard:64). Presence only; no format check. | Read only by the guard. |
| `CAMPAIGN_CELL_WAIT_SECONDS` | guard | Default 60 | Identical | no | leave out | Must be a positive integer (guard:61-63). | |

### 4. Fixed by the unit (never put these in the env file)

| Variable | Value | Read at |
|---|---|---|
| `CAMPAIGN_CELL` | `%i` (`cell-1` / `cell-2`) | unit:22; guard:8 |
| `NODE_ENV` | `production` | unit:23; guard:55. Effects below. |
| `CAMPAIGN_COORDINATOR_MODE` | `redis` | unit:24; guard:56; `campaign-pacing-coordinator.ts:352-360`; `campaign-prepared-broker.ts:343-349` |
| `CAMPAIGN_CELL_MANIFEST` | `/etc/cowabista/cells.manifest` | unit:25; guard:9 |
| `CAMPAIGN_CELL_REPO` | `/opt/cowabista` | unit:26; guard:67-68 (commit shown in the log only) |

What `NODE_ENV=production` changes at HEAD:
- Logs are JSON instead of pino-pretty (`logger.ts:4,36-46`).
- The active-workspace cookie gets the Secure flag (`organizations.ts:93`; `invitations.ts:128`).
- `BETTER_AUTH_URL` must be https (`auth-config.ts:64-66`).
- The Redis coordinator and broker become mandatory (`campaign-pacing-coordinator.ts:354-360`; `campaign-prepared-broker.ts:348-350`).
- `CAMPAIGN_MEDIA_STORAGE=local` is refused (`campaign-media-storage.ts:321`).
- `CAMPAIGN_TEST_GRAPH_BASE_URL` is ignored (`whatsapp-direct-sender.ts:18-21`).
- A missing media store produces a startup warning (`index.ts:45-46`).

### 5. SPA build (wherever `vite build` runs)

| Variable | Purpose | Production |
|---|---|---|
| `BASE_PATH` | Vite `base` (`vite.config.ts:32-35,59`). A value not starting with `/` fails the build. | `/`, or leave out (`docs/DEVELOPMENT.md:128`) |
| `WEB_PORT` | Dev and preview port only, but validated even during a build (`vite.config.ts:17-25,30`) | leave out |
| `API_PROXY_TARGET` | Dev and preview `/api` proxy only; validated during a build (`vite.config.ts:37-43`) | leave out |
| `WEB_ALLOWED_HOSTS` | Dev and preview host allow-list (`vite.config.ts:53-55`) | leave out |
| `NODE_ENV` | Any value other than `production` turns `vite build` into a non-production build (`.env.example:6-7`) | **leave out** |
| `VITE_*` | None is read at HEAD. Any `VITE_*` value can reach the public bundle. | **none** |

- **Where values come from.** The build reads the repo-root `.env*` files (`.env`, `.env.local`, `.env.production`, `.env.production.local`) plus the shell (`vite.config.ts:15,28,58`). Build from a checkout with none of them, at the same commit as the cells.
- **The build does not depend on the origin.** The auth client uses `window.location.origin` + `/api/auth` (`artifacts/wabista-nexus/src/lib/auth-client.ts:6-9`), so one build works on any origin.
- **Ignored now.** `PORT` is deliberately not read (`vite.config.ts:9-10`). `HARNESS_OUT` belongs to `vite.harness.config.ts` only.

### 6. Must NOT be set in production

| Variable | Behaviour at HEAD | Notes |
|---|---|---|
| `BETTER_AUTH_SECRETS` (non-empty) | **Refused**, R1 (`auth-config.ts:29-31`) | It would override the explicit secret (better-auth `dist/context/create-context.mjs:70`). |
| `BETTER_AUTH_TRUSTED_ORIGINS` (non-empty) | **Refused**, R1 (`auth-config.ts:32-34`) | Better Auth would append it (`dist/context/helpers.mjs:83-84`). |
| `BETTER_AUTH_TELEMETRY`, `BETTER_AUTH_TELEMETRY_DEBUG` (anything other than `""`, `0`, `false`) | **Refused**, R1 (`auth-config.ts:36-41`) | |
| `BETTER_AUTH_TELEMETRY_ENDPOINT` (non-empty) | **Refused**, R1 (`auth-config.ts:42-44`) | |
| `CAMPAIGN_MEDIA_STORAGE_DIR`, `CAMPAIGN_MEDIA_STORAGE=local` | **Refused**, R1 (`campaign-media-storage.ts:317,321,329`) | |
| `NODE_ENV` ≠ `production`, `CAMPAIGN_COORDINATOR_MODE` ≠ `redis` (override through the env file) | **Refused**, G78 (guard:55-56). The app refuses memory mode with RT (`campaign-pacing-coordinator.ts:353,360`). | |
| `CORS_ALLOWED_ORIGINS` in bare-host form (the semantics at d22a8e43) | **Refused**, R1 (`http-config.ts:28-42`) | d22a8e43 compared hosts (`d22a8e43:artifacts/api-server/src/app.ts:31-56`). |
| `CAMPAIGN_TEST_PROVIDER_DELAY_ONCE_MS`, `CAMPAIGN_TEST_PROVIDER_LOG` | **Silently honoured**, with no `NODE_ENV` check (`whatsapp-provider.ts:205-231`) | They run on every mock-mode send (`:257-259`), including inside shard workers (`campaign-transport-shard-worker.ts:3`). `_LOG` writes every payload (recipient and parameters) to disk. |
| `API_RATE_LIMIT_MAX_PER_MINUTE` | **Silently honoured** (`rateLimit.ts:18-25`) | Test override |
| `TEST` (any value except `""` and `false`; `TEST=0` counts as on) | Silently honoured by Better Auth's `isTest()` (@better-auth/core `dist/env/env-impl.mjs:27-29,36`). It skips Better Auth's own secret check (better-auth `create-context.mjs:41`). | The app's checks still run (`auth-config.ts`). The 127.0.0.1 IP fallback (@better-auth/core `dist/utils/ip.mjs:217`) applies only when no IP header resolves, and the app always sets one (`session.ts:44`; `auth.ts:66`). |
| `DEBUG`, `REDIS_EMIT_DIAGNOSTICS`, `REDIS_DEBUG_MAINTENANCE` | Silently honoured by libraries: debug 4.4.3 `src/node.js:221`; @redis/client 6.2.1 `dist/lib/client/enterprise-maintenance-manager.js:31,37` | They write internals to the journal. |
| `NODE_PG_FORCE_NATIVE` (non-empty) | pg loads its native client (pg `lib/index.js:41-47`). `pg-native` is external (`build.mjs:49`) and not installed, so the load fails: R1. | |
| `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_USE_ENV_PROXY` with `HTTP(S)_PROXY`/`NO_PROXY` *(Node)* | Change module loading, turn off TLS verification for Meta Graph and S3 calls, or route outbound calls through a proxy | The only `NODE_*` allowed in the file is `NODE_EXTRA_CA_CERTS` (§3). |
| `PG*` (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGPORT`, `PGSSLMODE`, `PGAPPNAME`, `PGOPTIONS`, `PGCONNECT_TIMEOUT`, `PGSSLNEGOTIATION`, `PGPASSFILE`) | Silently honoured: pg fills in anything `DATABASE_URL` omits (pg `lib/connection-parameters.js:9-22,25-38,83,104,119,127`; pgpass `lib/helper.js:57-67`). `PGSSLMODE=no-verify` turns off certificate checks (`:34-35`). | Put everything in `DATABASE_URL`. |
| `AWS_*` | Not "mostly no effect". Region, endpoint, credentials, path style, checksums and attempt count are explicit (`campaign-media-storage.ts:362-372`), but the SDK still reads the environment for retry mode, defaults mode, FIPS, dual-stack, ARN region, app id, S3 Express session auth, SigV4a region set and auth-scheme preference (`@aws-sdk/client-s3 dist-cjs/index.js:4831-4868`). **When `CAMPAIGN_MEDIA_S3_ENDPOINT` is left out (AWS), `AWS_ENDPOINT_URL_S3`/`AWS_ENDPOINT_URL`, or an `endpoint_url` in an `AWS_CONFIG_FILE`/`AWS_PROFILE` config, redirects every media request, with the bucket keys, to that endpoint** (@smithy/core `dist-cjs/submodules/endpoints/index.js:8-37,49-55,144-156`). | Keep all `AWS_*` unset. |
| `REDIS_URL` | Fallback name only (app and guard:57) | Set `CAMPAIGN_REDIS_URL` only. |
| `CAMPAIGN_TEST_GRAPH_BASE_URL` | **Ignored** when `NODE_ENV=production` (`whatsapp-direct-sender.ts:18-21`) | Remove it anyway. |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PROXY_URL` | **IGN** (read only at d22a8e43: `app.ts:123`, `clerkProxyMiddleware.ts:61`, SPA `App.tsx:39,45`) | The old example listed `CLERK_*` in `CAMPAIGN_CELL_REQUIRED_ENV` (`d22a8e43:deploy/systemd/cell-1.env.example:13`). Removing the variables but keeping that list gives G78. Keep the Clerk secrets in the secret store, not on the cells, until the rollback window to d22a8e43 closes. |
| `PRIVATE_OBJECT_DIR` | **IGN** (d22a8e43 `lib/object-storage.ts:25`) | |
| `REPLIT_DOMAINS`, `REPLIT_DEV_DOMAIN`, `REPL_ID`, Replit connector variables | **IGN** (d22a8e43 `app.ts:33-34`, SPA `vite.config.ts:37`, `@replit/connectors-sdk` in `whatsapp-provider.ts:2,154`; not in any HEAD `package.json`) | |
| `AUTH_SECRET`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `PUBLIC_BETTER_AUTH_URL`, `NUXT_PUBLIC_BETTER_AUTH_URL`, `NUXT_PUBLIC_AUTH_URL`, `BASE_URL`, `BETTER_AUTH_TELEMETRY_ID` | **Ignored**: the explicit `secret`, `baseURL` and `telemetry: false` win (`auth.ts:40,42,75`; better-auth `create-context.mjs:71`, `dist/utils/url.mjs:68-72`) | |
| Tooling-only: `WABISTA_DB_*`, `CAMPAIGN_TEST_REDIS_URL`, `CAMPAIGN_TEST_S3_ENDPOINT`, `CAMPAIGN_BENCHMARK_*`, `E2E_BASE_URL`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, `WORKER_LEASE_MS`, `WORKER_INTERVAL_MS`, `HARNESS_OUT` | Not read by the API process (only by `lib/db/scripts`, tests, benchmarks and `playwright.config.ts`) | Never put them in a cell file. |

### 7. Values that must be identical on both cells, and why

- **`BETTER_AUTH_SECRET`.**
  - Better Auth signs the session cookie with it (better-auth `dist/cookies/index.mjs:172`) and checks the signature on every session read and sign-out (`dist/api/routes/session.mjs:40`; `sign-out.mjs:42`).
  - Sessions live in the shared database, and nginx may send consecutive requests to different cells (`deploy/nginx/wabista.conf.example:17-21`). With different secrets, users are signed out at random.
  - Changing the secret signs everyone out (`docs/DEVELOPMENT.md:50`).
- **`BETTER_AUTH_URL`: one public https origin.**
  - Trusted origins are exactly `[BETTER_AUTH_URL] + CORS entries` (`auth-config.ts:67`). The origin and CSRF checks are forced on (`auth.ts:64-65`).
  - For `/api/auth` requests, `Host` and `X-Forwarded-Proto` are overwritten with this origin (`session.ts:43-48`).
  - The cookie `Secure` flag and `__Secure-` prefix follow https (`auth.ts:20-21,62`; `auth-config.ts:68`).
  - It must be a full origin with no path (`http-config.ts:38`). Users must reach the app on exactly this origin; redirect other host names at nginx.
- **`CORS_ALLOWED_ORIGINS`: full origins only.** Leave it out for the single-origin layout (`http-config.ts:6-12`). Every entry also becomes a Better Auth trusted origin.
- **`WHATSAPP_CREDENTIAL_ENCRYPTION_KEY`: a credential encrypted on one cell decrypts on the other only with the same key.**
  - Nothing host-specific goes into the encryption:
    - The key comes only from the environment: no default, no derivation, no per-process key (`credential-crypto.ts:5-10,79-82`).
    - AES-256-GCM with a random IV and the auth tag stored per row (`:105-116`).
    - The additional authenticated data is `provider:organizationId:kind` (`:93-95`).
    - Only key version 1 exists (`:20,80`).
  - Encryption happens in whichever process served "Connect number" (`whatsapp-manual-connection.ts:172`).
  - Decryption happens in two kinds of place:
    - On the owning cell at lane setup (`campaign-queue.ts:2275-2276` → `whatsapp-transport-credentials.ts:62-81`).
    - On whichever process serves template sync, template submission, test send, media binding, template media, phone setup or the in-process send path (`whatsapp-template-sync.ts:165`; `template-submission.ts:240,359`; `message-test-send.ts:110`; `campaign-media-binding.ts:77`; `template-media.ts:104`; `whatsapp-phone-setup.ts:137`; `whatsapp-template-sender.ts:556`).
  - With different keys, decryption fails (`credential-crypto.ts:133-136`) and the phone fails closed. The UI asks the user to reconnect (`whatsapp-phone-setup.ts:145-146`), and reconnecting through the other cell only moves the failure.
  - The app does not check the key at startup, and the guard checks presence only, so it belongs in `CAMPAIGN_CELL_REQUIRED_ENV` and in the format check in §9.
  - There is no rotation path (`credential-crypto.ts:75-78`). Losing or changing the key means every workspace must enter its tokens again.
  - **Encryption key rule (mandatory).** Run `inventory/15_credential_key_inventory_readonly.sql` (read only; counts and key versions only, never a token column, never a decrypted value) at P8 and again at W5 before the migration.
    - `KEY RULE: PRESERVE EXISTING KEY` (any stored `whatsapp_credentials` row, whatever its status): the existing production `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` must be preserved **byte-for-byte**. Copy it from its current source (the current production env file or secret store) into both cells without printing it, and prove equality with the §9 salted-fingerprint check against that source. **Never generate a replacement key in that situation.** If the current key cannot be found, STOP: a new key would make every stored credential undecryptable.
    - `KEY RULE: NEW KEY PERMITTED` (no `whatsapp_credentials` table, or zero rows, i.e. zero credentials requiring an old key): generate the key once (`openssl rand -hex 32`) and stage the same value on both cells. At `d22a8e43` production has no such table and no encryption code (verified in the repository), so this is the expected verdict, but only the inventory decides.
    - `STOP` (exit 3: a `key_version` other than 1): the release decrypts key version 1 only; do not cut over until it is explained.
- **`WHATSAPP_APP_ID`.** A template media upload is accepted at submission only when its stored app id equals the current one (`template-submission.ts:188-192`). An upload made through one cell and submitted through the other fails if the values differ.
- **Media S3 settings (`CAMPAIGN_MEDIA_STORAGE`, `CAMPAIGN_MEDIA_S3_*`).** Upload, preview and planning-time media binding may run on different cells (`campaign-media-assets.ts:100`; `routes/message-studio.ts:168`; `campaign-media-binding.ts:104`). The prefix is applied at access time (`campaign-media-storage.ts:132-135`). A different endpoint, bucket or prefix makes objects invisible to the other cell.
- **`META_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.**
  - They are read on every request (`whatsapp-webhook.ts:13,30`), and Meta's single callback URL may land on either cell.
  - A cell without them answers 503 and processes nothing from that delivery (`:14-17,31-34`; processing at `:52-55` never runs). Meta's redelivery behaviour is outside this repository.
  - Production already reads both names (`d22a8e43:artifacts/api-server/src/routes/whatsapp-webhook.ts:13,30`). Carry the current values over unchanged: the verify token must match the Meta dashboard.
  - Only one Meta app is supported: one app secret (signature check at `whatsapp-webhook.ts:41-43`) and one `WHATSAPP_APP_ID`. A workspace whose WABA delivers webhooks through another app gets 401 for every status.
  - If the public origin changes from the current production domain, the Meta callback URL must be repointed in the Meta dashboard (an operator action). Until then, statuses keep going to the old deployment.
- **`TRUST_PROXY=1` for one nginx hop** (`http-config.ts:53-66`; nginx example lines 10-12).
  - It is `1` (cutover P5): nginx on N is the one trusted hop. An HTTP proxy or CDN in front of N is handled with `real_ip` on N, not by raising the value; an L4 balancer is not a hop.
  - Cells listen on all interfaces (`index.ts:38`; `docs/DEVELOPMENT.md:164-166`). Firewall `PORT` so that only the nginx host can reach it; otherwise a client can forge `X-Forwarded-For`.
  - nginx-to-cell traffic is plain HTTP, so keep it on the private network.
- **`CAMPAIGN_PLATFORM_MAX_TPS`** (when set): planning and pacing both use it (§3).

### 8. U1: which runtime serves production today

The release runs only on the cells behind nginx (Option A). Option B below explains why HEAD is never deployed to Replit; it is not a supported choice.

U1 is resolved only by the read-only operator evidence listed in the summary ("U1: evidence required") and collected in cutover P1; the repository alone cannot prove which runtime serves production today.

- **Option A: cells behind nginx (the documented target).** Everything above applies. The nginx upstream lists `<HOST_C>:8080` and `<HOST_D>:8080` instead of the example's `127.0.0.1:8080`. The SPA build is served from the nginx host (the example root is `/opt/wabista/...`, `wabista.conf.example:39`; adjust it).
- **Option B: a separate deployment (for example Replit) keeps serving `/` and `/api`.**
  - **HEAD has no HTTP-only mode.** Every API process starts the campaign runtime (`index.ts:29-35,50`; `campaign-runtime.ts:416-420`).
  - With no scope set, that process owns every phone it can see (`campaign-phone-scope.ts:17-19`), so it becomes a third, unguarded transport runtime.
  - Even with a scope, housekeeping is global: it flushes metric deltas, reaps expired leases, activates due scheduled campaigns and reactivates throttled routes for all phones (`campaign-runtime.ts:311-338`).
  - **HEAD is not deployable to Replit as it stands.** `.replit` and `artifacts/*/.replit-artifact/artifact.toml` exist at d22a8e43 and not at HEAD. The d22a8e43 deployment is `autoscale` (`d22a8e43:.replit:5`), so it may run several instances, each a full API and runtime process.
  - In production mode it needs Host S Redis and PostgreSQL (`campaign-pacing-coordinator.ts:354-357`). The Host S access rule admits only `10.0.0.0/24` (`deploy/postgres/pg_hba.conf.example:3-4`), so this would need a Host S access change planned with the user.
  - Without production mode it falls back to an in-memory broker (`campaign-prepared-broker.ts:351`), and to an in-memory coordinator unless a Redis URL is set (`campaign-pacing-coordinator.ts:363`). Such a process must never point at the production database.
  - The only in-code lever to keep it off the cells' phones is a `CAMPAIGN_TRANSPORT_PHONE_IDS` naming a phone id that does not exist. That is unsupported, untested and still runs global housekeeping, and a future phone could receive that id.
  - **Option A is the only layout HEAD supports without a code or platform-config change.**

### 9. Copy-paste templates (placeholders only)

**Rules for these files:**
- Replace every `<...>`. No `CHANGE_ME` may remain (the app refuses it for the secret, `auth-config.ts:54`).
- No inline comments: systemd keeps them as part of the value *(systemd)*.
- No quotes.
- No backslashes in unquoted values; systemd treats them as escapes *(systemd)*. Check any carried-over value.
- No empty assignments (§3 ⚠) and no duplicate names (the last one wins).
- If a database or Redis password contains URL-reserved characters, percent-encode it. Hex passwords need none. Do not change the existing production database password just for this: that is a Host S change.

`CAMPAIGN_CELL_REQUIRED_ENV` checks only that each listed name is non-empty (guard:64), before Node starts. It covers both the variables the app tolerates when missing (webhooks, encryption key, app id, media selector) and those it refuses with R1:
```
CAMPAIGN_CELL_REQUIRED_ENV=BETTER_AUTH_SECRET BETTER_AUTH_URL TRUST_PROXY META_APP_SECRET WHATSAPP_WEBHOOK_VERIFY_TOKEN WHATSAPP_CREDENTIAL_ENCRYPTION_KEY WHATSAPP_APP_ID CAMPAIGN_MEDIA_STORAGE CAMPAIGN_MEDIA_S3_ENDPOINT CAMPAIGN_MEDIA_S3_REGION CAMPAIGN_MEDIA_S3_BUCKET CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY
```
Drop `CAMPAIGN_MEDIA_S3_ENDPOINT` only for AWS S3 itself. Media is enabled at launch (U4: external S3-compatible provider), so the media names stay listed.

**This is the single canonical list** (the media section and cutover P5 refer to it). `CAMPAIGN_MEDIA_S3_REGION` is always set explicitly when media is enabled (for MinIO `us-east-1`), because unset it silently defaults to `us-east-1` (`campaign-media-storage.ts:331`). Media storage is enabled at launch (decision U4), so every `CAMPAIGN_MEDIA_*` line above is required on both cells. `AUTH_PUBLIC_SIGN_UP` is never listed: production leaves it out (closed).

`/etc/cowabista/cell-cell-1.env` (root:cowabista, 0640):
```
# Cell 1 (Host C). Read by campaign-cell@cell-1. Identical to cell-2 except CAMPAIGN_TRANSPORT_PHONE_IDS.
# Never set here: NODE_ENV CAMPAIGN_CELL CAMPAIGN_COORDINATOR_MODE CAMPAIGN_CELL_MANIFEST CAMPAIGN_CELL_REPO
# Must equal this cell's line in /etc/cowabista/cells.manifest (production phone_numbers.id values)
CAMPAIGN_TRANSPORT_PHONE_IDS=<CELL1_PHONE_IDS>
PORT=8080
DATABASE_URL=postgresql://cowabista:<DB_PASSWORD>@<HOST_S>:5432/cowabista
CAMPAIGN_REDIS_URL=redis://:<REDIS_PASSWORD>@<HOST_S>:6379
BETTER_AUTH_SECRET=<BETTER_AUTH_SECRET>
BETTER_AUTH_URL=https://<PUBLIC_HOST>
TRUST_PROXY=1
LOG_LEVEL=info
META_APP_SECRET=<META_APP_SECRET>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<WHATSAPP_WEBHOOK_VERIFY_TOKEN>
WHATSAPP_CREDENTIAL_ENCRYPTION_KEY=<WHATSAPP_CREDENTIAL_ENCRYPTION_KEY>
WHATSAPP_APP_ID=<META_APP_ID>
CAMPAIGN_MEDIA_STORAGE=s3
CAMPAIGN_MEDIA_S3_ENDPOINT=https://<S3_ENDPOINT_HOST>
CAMPAIGN_MEDIA_S3_BUCKET=<MEDIA_BUCKET>
CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID=<S3_ACCESS_KEY_ID>
CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY=<S3_SECRET_ACCESS_KEY>
CAMPAIGN_MEDIA_S3_REGION=<REGION>
CAMPAIGN_CELL_REQUIRED_ENV=BETTER_AUTH_SECRET BETTER_AUTH_URL TRUST_PROXY META_APP_SECRET WHATSAPP_WEBHOOK_VERIFY_TOKEN WHATSAPP_CREDENTIAL_ENCRYPTION_KEY WHATSAPP_APP_ID CAMPAIGN_MEDIA_STORAGE CAMPAIGN_MEDIA_S3_ENDPOINT CAMPAIGN_MEDIA_S3_REGION CAMPAIGN_MEDIA_S3_BUCKET CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY
# Only if the provider requires the other addressing style (exactly true or false): CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE=<true|false>
# Only if the endpoint uses a private CA (MinIO alternative): NODE_EXTRA_CA_CERTS=<PATH_TO_CA_PEM>
# Leave out entirely (never NAME= with an empty value): CORS_ALLOWED_ORIGINS CAMPAIGN_PLATFORM_MAX_TPS CAMPAIGN_TRANSPORT_SHARDS
# API_RATE_LIMIT_MAX_PER_MINUTE CAMPAIGN_MEDIA_S3_PREFIX CAMPAIGN_CELL_WAIT_SECONDS REDIS_URL AUTH_PUBLIC_SIGN_UP (closed when absent)
```

`/etc/cowabista/cell-cell-2.env` (root:cowabista, 0640) is the same file with these two lines changed:
```
# Cell 2 (Host D). Read by campaign-cell@cell-2. Identical to cell-1 except CAMPAIGN_TRANSPORT_PHONE_IDS.
CAMPAIGN_TRANSPORT_PHONE_IDS=<CELL2_PHONE_IDS>
```

**Pre-start checklist.** Run as root. `F` is the cell's file. Every command prints variable names, counts or salted fingerprints only, never a value.

1. [ ] **Generate secrets once**, into root-only files, never onto the screen: on an admin machine `umask 077; mkdir -p /root/p6s; openssl rand -base64 32 > /root/p6s/ba`. For the encryption key apply the §7 "Encryption key rule" first: **only** if inventory 15 printed `NEW KEY PERMITTED`, `openssl rand -hex 32 > /root/p6s/enc`; if it printed `PRESERVE EXISTING KEY`, write the **existing** key into `/root/p6s/enc` from its current source without printing it (never generate one). Copy the files to both cells (`scp`), append them with `printf 'BETTER_AUTH_SECRET=%s\n' "$(cat /root/p6s/ba)" >> "$F"` and `printf 'WHATSAPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' "$(cat /root/p6s/enc)" >> "$F"`, store the offline copy in the secret store from the file, then `shred -u /root/p6s/*` everywhere. Never generate per host. Carry `META_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` over from the current production deployment's secrets. Never paste a value into a ticket or chat.
2. [ ] **Right file name.** `ls -l /etc/cowabista/cell-cell-<n>.env` shows `root cowabista -rw-r-----`. Nothing relies on `/etc/cowabista/cell-<n>.env`.
3. [ ] **One `NAME=value` per line, nothing else.** Each prints `0`: `grep -cvE '^([A-Z][A-Z0-9_]*=.*|[[:space:]]*(#.*)?)$' "$F"` (every other line is an upper-case name at column 0, no spaces around `=`), `grep -c $'\r' "$F"` (no CR), `grep -cE "^[A-Z][A-Z0-9_]*=[[:space:]]*[\"']" "$F"` (no quotes, so no multi-line value) `grep -c '\\$' "$F"` (no continuation backslash), `tr -cd '\000' < "$F" | wc -c` (no NUL byte) and `iconv -f UTF-8 -t UTF-8 "$F" >/dev/null 2>&1; echo $?` (valid UTF-8; otherwise systemd refuses the file and logs the offending value). **If any count is not 0, STOP** and fix the file before running anything below (show the offending lines by number only: `grep -nvE '^([A-Z][A-Z0-9_]*=.*|[[:space:]]*(#.*)?)$' "$F" | cut -d: -f1`); the commands below print the text before `=` and are name-safe only on a file that passes.
   **No placeholders left.** `grep -nE '^[A-Z][A-Z0-9_]*=.*(<[A-Za-z0-9_]+>|CHANGE_ME)' "$F" | cut -d= -f1` prints nothing (comment lines are not checked).
4. [ ] **No forbidden names.** This prints nothing:
   ```
   grep -nE '^(NODE_(ENV|OPTIONS|TLS_REJECT_UNAUTHORIZED|PG_FORCE_NATIVE|USE_ENV_PROXY|DEBUG)|CAMPAIGN_CELL|CAMPAIGN_CELL_MANIFEST|CAMPAIGN_CELL_REPO|CAMPAIGN_COORDINATOR_MODE|REDIS_URL|REDIS_EMIT_DIAGNOSTICS|REDIS_DEBUG_MAINTENANCE|CAMPAIGN_TEST_[A-Z_]*|CAMPAIGN_MEDIA_STORAGE_DIR|BETTER_AUTH_(SECRETS|TRUSTED_ORIGINS|TELEMETRY[A-Z_]*)|AUTH_SECRET|CLERK_[A-Z_]*|VITE_[A-Z_]*|REPLIT_[A-Z_]*|REPL_[A-Z_]*|PRIVATE_OBJECT_DIR|API_RATE_LIMIT_MAX_PER_MINUTE|TEST|DEBUG|AWS_[A-Z0-9_]*|PG[A-Z_]*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|no_proxy)=' "$F" | cut -d= -f1
   ```
5. [ ] **No empty values, duplicates or inline comments.** Each of these prints nothing:
   ```
   grep -nE '^[A-Z][A-Z0-9_]*=[[:space:]]*$' "$F" | cut -d= -f1
   grep -vE '^[[:space:]]*(#|$)' "$F" | cut -s -d= -f1 | grep -xE '[A-Z][A-Z0-9_]*' | sort | uniq -d
   grep -nE '^[A-Z][A-Z0-9_]*=.*[[:space:]]#' "$F" | cut -d= -f1
   ```
6. [ ] **Same values on both hosts, compared by salted fingerprint.** Enter the same one-time random salt on both hosts and discard it afterwards. The one-line outputs must match:
   ```
   read -rsp 'one-time salt: ' S; echo
   grep -vE '^[[:space:]]*(#|$)|^(CAMPAIGN_TRANSPORT_PHONE_IDS|PORT)=' "$F" | sort | { printf '%s\n' "$S"; cat; } | sha256sum | cut -c1-16
   ```
   If they differ, find the variable with:
   ```
   for v in $(grep -vE '^[[:space:]]*(#|$)' "$F" | cut -s -d= -f1 | grep -xE '[A-Z][A-Z0-9_]*' | sort -u); do printf '%s ' "$v"; { printf '%s\n' "$S"; sed -n "s/^$v=//p" "$F"; } | sha256sum | cut -c1-16; done
   ```
7. [ ] **Formats are valid.**
   - `grep -cE '^WHATSAPP_CREDENTIAL_ENCRYPTION_KEY=([0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?)$' "$F"` prints `1` (hex in either case, or base64 of 32 bytes: the two forms `credential-crypto.ts:53-73` accepts). A **preserved** key that fails this check is never replaced: STOP and investigate (§7, "Encryption key rule"); the salted-fingerprint check below proves it is byte-for-byte its source.
   - Preserved key only: the salted fingerprint of the `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` value (step 6 per-variable loop) equals the same salted fingerprint computed on its current source.
   - `grep -cE '^AUTH_PUBLIC_SIGN_UP=' "$F"` prints `0` (or the line is exactly `AUTH_PUBLIC_SIGN_UP=closed`).
   - `sed -n 's/^BETTER_AUTH_SECRET=//p' "$F" | tr -d '\n' | wc -c` prints at least 32 (44 for `openssl rand -base64 32`; the entropy rule, `auth-config.ts:57-58`, also applies).
   - `grep -E '^BETTER_AUTH_URL=' "$F"` shows `https://` and no path. This value is not a secret.
   - `grep -cE '^(DATABASE_URL|CAMPAIGN_REDIS_URL|REDIS_URL)=[a-z]+://[^/]*@[^/]*@' "$F"` prints `0`: no unencoded `@` in a URL password (the guard's redaction would leak the rest of the password into the journal).
8. [ ] **Manifest.**
   - `sha256sum /etc/cowabista/cells.manifest` is the same on Host C and Host D.
   - Each host column equals that host's `hostname` output (guard:10,34; the example uses `host-c`/`host-d`).
   - The scopes are the verified production `phone_numbers.id` sets, and every Connected sending phone is in exactly one scope.
9. [ ] **Host tools.** `command -v pg_isready redis-cli git` lists all three. `/usr/bin/node --version` is 22.12 or later.
10. [ ] **Network.**
    - The cell `PORT` is reachable only from the nginx host.
    - Host S PostgreSQL and Redis, and the external S3 endpoint (443), are reachable from both cells, and the `pg_hba` subnet covers the cells (`pg_hba.conf.example:3`).
    - PostgreSQL `max_connections` is at least 26 × (cells + 1) + 20 = 98 for two cells (`deploy/README.md:186-187`; `deploy/postgres/campaign.conf:8` sets 120). Add 26 for any other HEAD process.
11. [ ] **After start** (replace 8080 if `PORT` differs; `$PORT` is not set in the operator's shell):
    - `journalctl -u campaign-cell@cell-N -n 100 --no-pager | grep -E 'OK host=|REFUSING|Campaign runtime started|Campaign media storage|No campaign media storage'` shows the guard `OK` line with `scope=<scope>`. It then shows `Campaign runtime started` with the same `phoneScope` (`deploy/README.md:100-101`) and `Campaign media storage` with `kind: "s3"` and the expected bucket and prefix (media is required at launch, U4).
    - `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/readyz` prints `200`. Readiness requires initialization done and the runtime started (`routes/health.ts:25-33`). `/api/healthz` answers 200 even before that (`:14-19`); check that its `campaignRuntime.status` is `ok`.
    - Webhook settings, with no Meta call and no secret:
      - `curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8080/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=not-the-token&hub.challenge=x'` prints `403` (`503` means the token is missing).
      - `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:8080/api/webhooks/whatsapp` prints `401` (`503` means the app secret is missing). Nothing is processed (`whatsapp-webhook.ts:12-27,29-43`).

---


---

## Rollback plan

**Basis.** This section comes from reading three things: the code at the production commit (**prod**, `d22a8e43`), the release candidate (**rc**, `<REL>` = `2a2afe6`, i.e. `e37ab27` plus Option 2a, the cell guard fix `f967bd7` and the relocatable build fix `2a2afe6`; the guard fix touches only `deploy/systemd/campaign-cell-guard.sh`, the build fix only the API build configuration (`build.mjs`, `build-pino.mjs`), and the 2a change touches only `api/app.ts`, `api/lib/auth-config.ts`, `api/lib/auth.ts`, `api/middlewares/session.ts` and the new `api/auth-admin.ts` / `api/lib/auth-admin.ts`, so rc citations of other files hold for both), and the P6 database package. On 2026-10-22 the whole R2 path (§12 steps 1-9 and the §13 roll-forward) was rehearsed on a disposable, synthetic production-shaped copy (with `f967bd7`, which differs from `<REL>` only by the relocatable build fix), with `d22a8e43` actually started on the unfinalized database: every gate and script passed (pkg README, "Synthetic dress rehearsal"). It has not run on a restored production backup: the rehearsal in §2 RP7 must pass before this plan is used.

**Shorthands**
- To read a prod file: `git show d22a8e43bf0d36d1565c011aed77486767fb8318:<path>`.
- `api/` = `artifacts/api-server/src/`
- `spa/` = `artifacts/wabista-nexus/src/`
- `schema/` = `lib/db/src/schema/`
- `NN_*.sql` / `NN_*.psql` are scripts of the P6 package. "pkg README" is that package's README.
- Times are UTC, recorded with `date -u +%FT%TZ`. They have long names because `T0` and `TO` are easy to confuse.
  - `T_START`: window start, from the migrate log.
  - `T_OPEN`: reopen time.
  - `T_RB`: rollback start.
  - `T_PROD`: the moment just before the first prod process starts (§12 step 7).
  - `T_RF`: the moment just before the first rc cell starts again in a roll-forward (§13 step 6). In that roll-forward it replaces `T0`/`T_START` everywhere.
- `<PROD_SHA>`: the commit recorded in RP1. Expected value: `d22a8e43bf0d36d1565c011aed77486767fb8318`.
- `$PSQL` means `psql -X -v ON_ERROR_STOP=1`, connected the way pkg README "How to connect" describes:
  - connect directly to PostgreSQL on Host S, not through a pooler;
  - export `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGSSLMODE`;
  - keep the password only in `~/.pgpass` or in `PGPASSFILE` (mode 0600).
- Never put a connection URL or a password on the command line. `psql "$DATABASE_URL"` does exactly that.
- For package scripts:
  - log with `-L logs/<name>-$(date -u +%Y%m%dT%H%M%SZ).log`;
  - never pipe into `tee`, because the pipe hides psql's exit code;
  - check `echo "exit=$?"`. 0 means success. 3 means refused, and nothing changed.

### 1. What a rollback is

**It is all or nothing:**
- Every API process goes back to `<PROD_SHA>`, or is stopped and disabled (front A without pre-cutover cells, §10).
- The HTTP front and the cell env files go back to their pre-cutover copies.
- Redis is flushed.

**Auth cannot be rolled back on its own.**
- rc contains no Clerk package (no `@clerk` entry in rc's `pnpm-lock.yaml`) and makes no Clerk call.
- Clerk survives in rc only in comments and in the legacy `users.clerk_id` column, which rc fills with a placeholder (rc `api/middlewares/auth.ts:58-62`, rc `schema/users.ts:10`).
- prod authenticates only through Clerk (prod `api/app.ts:6-7,107,119-126`, prod `api/middlewares/auth.ts:2,47`).

**Not rolled back** (see §11):
- the additive schema;
- rows rc wrote;
- S3 media objects;
- Better Auth accounts;
- stored WhatsApp credentials.

**The main danger is wrong sends, not crashes.** prod reads rc's rows through its own Drizzle schema and mostly ignores them, but it would send some of them wrongly (§5). So campaigns that rc planned or executed are frozen before any prod process starts.

| Path | When | Database action |
|---|---|---|
| **R1** | Before `03_finalize.psql` committed. `40_postcheck` reports idempotency state `transitional`. | None. prod's index `campaign_contact_idempotency_uq (campaign_id, idempotency_key)` still exists. |
| **R2** | After `03_finalize.psql` (state `finalized`), and `60_unfinalize_precheck_readonly.sql` prints `UNFINALIZE PRECHECK OK`. | With every cell stopped, run `61_unfinalize.psql`. `40_postcheck` must then report `transitional`. Then continue as R1. |
| **R3** | After 03, and 60 fails because two audience generations share a phone. | None is possible without a data decision. prod runs, but every CSV import fails (§4), and the affected campaigns must stay frozen. Prefer fixing forward unless trigger T4 fired. |

**Never run a schema command from the prod checkout.**
- At prod, `lib/db` `push` is a bare `drizzle-kit push` (prod `lib/db/package.json:11`).
- Against the migrated database it would propose dropping every V2 and Better Auth table and column (pkg README, "Do not re-run, and never push from the old checkout").
- Replit's post-merge hook runs it too: prod `.replit:18-20` → prod `scripts/post-merge.sh:3-4` (`pnpm --filter db push`).
- The only schema command a rollback may run is `61_unfinalize.psql`, on path R2.

### 2. Prerequisites captured before cutover (without these there is no rollback)

| # | Item |
|---|---|
| RP1 | **Inventory.** On each cell host, record the guard line: `journalctl -u campaign-cell@cell-N \| grep 'OK host='`. Its `commit=` is the first 12 characters of the checkout HEAD (`deploy/systemd/campaign-cell-guard.sh:67-69`). It proves the checkout, not what was built. Record whether cells existed and served HTTP before the cutover (Q1). For any Replit deployment, record: whether it is published, its commit, its deployment type and instance count (prod `.replit:5` is `autoscale`), which database and Redis its secrets use, and its `CAMPAIGN_TRANSPORT_PHONE_IDS`. Record the app domain's DNS records. On the nginx host, record `nginx -T \| grep -nE 'server_name\|root '`. Record `uname -m` and `ldd --version \| head -1` on Host C, Host D and the build host. |
| RP2 | **Env copies** (root). On Host C: `install -D -m 0600 /etc/cowabista/cell-cell-1.env /etc/cowabista/rollback/cell-cell-1.env.<PROD_SHA>`. On Host D, the same for `cell-cell-2.env`. On both hosts, the same for `cells.manifest`. The rc env files are saved by §12 step 7 itself, as `/etc/cowabista/rollback/cell-cell-N.env.rc`, right before the prod copy replaces them, and so is the rc manifest (`cells.manifest.rc`) when it changed after cutover; §13 step 6 restores both. If RP1 shows that no cells existed before cutover, there is nothing to copy: the rollback then stops and disables the cells (§12 step 7). |
| RP3 | **DNS** (front A). Lower the TTL of the app record to 300 s or less, at least one current-TTL period before the window. |
| RP4 | **prod SPA build** (front B only). Build it in a separate clone, never in `/opt/cowabista`: `git clone /opt/cowabista /var/tmp/rb/src && git -C /var/tmp/rb/src checkout <PROD_SHA>`, then install. Build with `PORT` and `BASE_PATH=/` (prod `artifacts/wabista-nexus/vite.config.ts:8-28`), `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_CLERK_PROXY_URL` (prod `spa/App.tsx:37-45,57-59`). Copy `dist/public` to `/var/www/wabista/releases/<PROD_SHA>/`. §10's switch needs the installed vhost to use `root /var/www/wabista/current;` (a symlink). The repo example instead points into a checkout (`deploy/nginx/wabista.conf.example:39`), so the cutover must set it up this way, and RP1 must confirm it. Before cutover, prove that this build can sign in through the nginx origin (Q3). |
| RP5 | **Dependencies and platform.** prod builds only on linux-x64 with glibc: its overrides strip the linux-arm64 and x64-musl binaries of esbuild, rollup, lightningcss and tailwind (prod `pnpm-workspace.yaml:77-78,84,111,123`). On Host C and Host D, as the checkout owner (so the pnpm store is the one step 7 uses): `mkdir -p /var/tmp/rb/lock && for f in pnpm-lock.yaml pnpm-workspace.yaml .npmrc; do git -C /opt/cowabista show <PROD_SHA>:$f > /var/tmp/rb/lock/$f; done && (cd /var/tmp/rb/lock && pnpm fetch)`. In RP7, prove that `pnpm install --frozen-lockfile --offline` then succeeds. |
| RP6 | **Snapshot at `T_OPEN`.** Record `live_at_open`: the ids of campaigns that are Running or Scheduled at reopen. For live workspaces it is expected to hold only action-B campaigns (nothing left to send) and the L2 campaign. Also record the `12_connector_inventory_readonly.sql` output and the `delivery_unknown` count. |
| RP7 | **Rehearsal.** Use the package's required restored-backup rehearsal and its rules (pkg README, "Required before the window: one full rehearsal"): run by the operator only, with the user's explicit approval, on an isolated host with no route to Meta, and destroy the copy afterwards. For the prod build there must also be no route to Replit and no Replit connector identity in the environment. Order: **(a)** the package sequence 01 → 02 → 40 → start rc → 03 → 40 → 60 → 61 → 40. This is the only test of 61's success path. **(b)** Run 03 again. Then, in rc mock mode, create an allocator-v2 campaign, a Message Studio media mapping, and a replace import that reuses a phone. **(c)** On lab hosts only, run §12 steps 2-7 and 9 with the prod build; skip steps 1 and 8 (they touch production nginx, DNS, Replit and Meta). Use `<REDIS_HOST>` = the lab Redis and a lab env file, never the RP2 copies or any production secret. Run the prod build with a separate Clerk *development* instance's keys; if none exists, skip the prod UI click-through and record it as open (Q3). Confirm that 60 refuses, the mappings page answers 500 and a prod import answers 400 (R3). Run `rollback/70_freeze_rc_down.psql` as in §5: first with no flag (dry run, `FREEZE DRY RUN OK`), then with `-v commit=yes` (`FREEZE COMMITTED`). Time every step: this gives the execution budget. |
| RP8 | **Accounts.** One Clerk test account with membership in a mock-mode workspace (prod), checked before the window; keep its credentials in a root-only 0600 file. The Better Auth smoke account (rc) cannot exist before W5: it is created at cutover W9 with `dist/auth-admin.mjs create`, and its temporary password is never written to a file. After it is changed at acceptance 1.2a, keep the **changed** password (never the temporary one) only in the root-only 0600 `signin.json` that the T1 smoke uses. |
| RP9 | **Owner sign-off** on: `61_unfinalize.psql`; the freeze decisions in §5, including whether rc-planned Ready and Paused campaigns are cancelled in rc or left one click away from a wrong send; the rc-down data changes; and the decision rights in §3. |
| RP10 | **Pre-migration backup.** For disasters only (§11). |

### 3. Triggers and decision time

**Before reopen (acceptance phases 0-2).** If any acceptance item cannot be fixed inside the window, the decision is NO-GO and the path is R1 (R2 if step 2.1 already ran). This is cheap, because only acceptance accounts exist.

**After reopen:**

| # | Trigger | Threshold |
|---|---|---|
| T1 | Better Auth broken | The smoke below fails twice in a row, 5 min apart, through the public origin. Or `/api/auth/*` answers 5xx for 5 min. |
| T2 | API errors | 5xx above 2 % of requests in any 5 min with at least 100 requests, or above 0.5 % over 30 min. Count on both cells: `journalctl -u campaign-cell@cell-N --since '-5 min' -o cat \| grep -cE '"statusCode":5[0-9]{2}'` against `grep -c '"statusCode":'`. Also check the nginx error log. |
| T3 | Runtime not ok | Any one of these on either cell: `/api/healthz` not 200. `campaignRuntime.status` not `ok` for more than 2 min (it turns `stale` after 10 s without housekeeping, rc `api/services/campaign-runtime.ts:434-451`). `/api/readyz` not 200 five minutes after start (rc `api/routes/health.ts:25-34`). More than 3 restarts in 10 min (`systemctl show -p NRestarts campaign-cell@cell-N`). Guard exit 78. Ownership denials later than 30 s after start (`deploy/README.md:107-108`). |
| T4 | Unexpected send. **Zero tolerance.** | Before `T_OPEN` (cutover W14, or W13 when the user chose U8): `14_zero_send_check_readonly.sql -v since=<T_START>` (with `-v approved_campaign_ids='{<L2 campaign id>}'` only once L2 has launched; omit it before that and when there is no L2) fails (it counts live provider messages, claimed or sent jobs **and live test sends**, and lists them per campaign; only the recorded L2 campaign is excepted). From `T_OPEN` on: any row from Q-UNEXPECTED or Q-REPEAT below, or any report of a wrong template, a wrong recipient, or a message to a suppressed number. |
| T5 | Stall or unknown outcomes | A Running campaign with Queued jobs gets no new `provider_messages` for 5 min while its cell is healthy. Or `delivery_unknown` (`deploy/README.md:181`) rises by more than 10 in 15 min without a cell or Redis loss. |
| T6 | Data integrity | `40_postcheck` fails after reopen, or SQLSTATE 42P10 or 23505 repeats in the API log. |

**On T4, stop the damage first, without waiting for the decision.**
- Emergency-kill the campaign in the app (rc `api/routes/campaign-engine.ts:129`).
- If the source is unclear, stop both cells, which also stops HTTP. Then use the rc-down freeze in §5.

**Decision limits:**
- Decide within 15 min of a trigger during the first 2 h after `T_OPEN`, and within 30 min until `T_OPEN` + 24 h. If no proven fix exists by then, roll back.
- The operator and the owner decide together. The operator decides alone for T1-T4 if the owner is unreachable.
- **Horizon `T_OPEN` + 24 h.** After that, fix forward by default. Roll back only for T4 or T6, and only on the owner's decision. Every hour adds Better Auth users who would be locked out (§7) and rc campaigns that would have to be frozen (§5).

**T1 smoke.**
- Run it from the operator machine.
- Keep the password in a 0600 file and the cookie jar in a 0700 directory. Delete the jar afterwards and never paste it.
- Sign-in is limited to 3 per 10 s (rc `api/lib/auth.ts:60-62`).
```
O=https://<PUBLIC_HOST>; D=<0700-dir>
curl -s -o /dev/null -w '%{http_code}\n' -c $D/jar -H 'Content-Type: application/json' -H "Origin: $O" --data @$D/signin.json "$O/api/auth/sign-in/email"  # 200
curl -s -o /dev/null -w '%{http_code}\n' -b $D/jar "$O/api/me"                                                                                            # 200
curl -s -o /dev/null -w '%{http_code}\n' -b $D/jar -c $D/jar -H 'Content-Type: application/json' -H "Origin: $O" --data '{}' "$O/api/auth/sign-out"     # 200
curl -s -o /dev/null -w '%{http_code}\n' -b $D/jar "$O/api/me"                                                                                            # 401
rm -f $D/jar
```

**Q-UNEXPECTED and Q-REPEAT** (rollback queries; not the summary's U-decisions). Read only. Use them from `T_OPEN` on (cutover W14, or W13 under U8), every 15 min. They scan `provider_messages`.
```sql
-- $PSQL -v t_open='<T_OPEN>' -v live_at_open='{<ids from RP6>}' -f q_unexpected_repeat.sql
BEGIN TRANSACTION READ ONLY;
-- Q-UNEXPECTED: campaigns that sent since T_OPEN without a launch/execute/resume since T_OPEN and were not live at T_OPEN. Expected: no rows.
SELECT j.campaign_id, count(*) AS provider_messages
FROM provider_messages pm JOIN campaign_jobs j ON j.id = pm.campaign_job_id AND j.organization_id = pm.organization_id
WHERE pm.created_at >= :'t_open'::timestamptz AND NOT (j.campaign_id = ANY (:'live_at_open'::int[]))
  AND NOT EXISTS (SELECT 1 FROM campaign_audit a WHERE a.campaign_id = j.campaign_id
                  AND a.created_at >= :'t_open'::timestamptz AND a.action IN ('launch', 'executed', 'resume'))
GROUP BY j.campaign_id;
-- Q-REPEAT: one campaign messaged one recipient twice (send keys are unique per campaign and phone). Expected: no rows.
SELECT campaign_id, count(*) AS repeated_recipients FROM (
  SELECT j.campaign_id, pm.recipient_external_id
  FROM provider_messages pm JOIN campaign_jobs j ON j.id = pm.campaign_job_id AND j.organization_id = pm.organization_id
  WHERE pm.status <> 'rejected' AND j.campaign_id IN (
    SELECT j2.campaign_id FROM provider_messages p2 JOIN campaign_jobs j2 ON j2.id = p2.campaign_job_id
    WHERE p2.created_at >= :'t_open'::timestamptz)
  GROUP BY 1, 2 HAVING count(*) > 1) d
GROUP BY campaign_id;
ROLLBACK;
```

### 4. The one schema dependency: `campaign_contacts` uniqueness

**What prod needs.**
- prod's CSV import inserts with `ON CONFLICT (campaign_id, idempotency_key) DO NOTHING` (prod `api/routes/campaign-engine.ts:420-428`).
- It is prod's only INSERT into `campaign_contacts`.
- prod planning also writes to the table, but only UPDATEs `route_id` and `partition_key` (prod `api/services/campaign-planning.ts:268-273`), which needs no index.

**What the release changes.** rc keys contacts by `(campaign_id, audience_generation, idempotency_key)` (rc `schema/campaign-engine.ts:90`).

**What breaks without the old index.**
- PostgreSQL accepts an `ON CONFLICT` target only when a unique index exists on exactly those columns.
- Without it, every prod import fails on its first batch with SQLSTATE 42P10.
- The route then marks the session Failed and answers 400 (prod `api/routes/campaign-engine.ts:509-516`).
- This affects every campaign.

**Every other conflict target prod uses is backed by an unchanged unique key:**

| Table | Unique columns | prod source |
|---|---|---|
| `wabas` | `(organization_id, external_id)` | `api/services/whatsapp-sync.ts:96` |
| `phone_numbers` | `(organization_id, provider_phone_id)` | `whatsapp-sync.ts:123` |
| `templates` | `(organization_id, provider_template_id)` | `whatsapp-sync.ts:154` |
| `campaign_allocations` | `(campaign_id, contact_id)` | `api/services/campaign-planning.ts:258` |
| `campaign_jobs` | `(organization_id, idempotency_key)` | `campaign-planning.ts:374` |
| `suppressions` | `(organization_id, normalized_phone)` | `api/routes/suppressions.ts:64`, `api/services/whatsapp-webhook.ts:156-157` |
| `provider_messages` | `(organization_id, campaign_job_id)` | `api/services/whatsapp-template-sender.ts:396` |
| `campaign_metrics` | `campaign_id` (primary key) | `api/routes/campaign-engine.ts:499-500` |

**Target-less `ON CONFLICT DO NOTHING`.**
- These prod inserts accept any unique index: `whatsapp-sync.ts:22`, `whatsapp-webhook.ts:237`, `api/routes/whatsapp-integration.ts:113`, `campaign-engine.ts:387`, `api/services/campaign-queue.ts:301`.
- rc's diffs of `wabas.ts`, `phone-numbers.ts`, `campaigns.ts`, `campaign-routes.ts` and `campaign-engine.ts` only add columns and indexes. The one exception is the contacts index above.
- `templates.ts` and `provider-integration.ts` are unchanged.
- The only other new unique index on an existing table is `campaign_org_creation_key_uq` (rc `schema/campaigns.ts:95`), on a column prod never writes.

**Restoring the old index can fail.**
- An rc "replace" import stages a new generation (rc `api/services/campaign-import-lifecycle.ts:219-227`) and may insert the same key again (rc `api/routes/campaign-engine.ts:511-520`).
- After finalize, two rows can then share `(campaign_id, idempotency_key)`, and `61_unfinalize.psql` cannot rebuild the old index.
- In the transitional state this cannot happen: an rc replace that reuses a phone fails cleanly (package part 20).

**Read-only check.**
- It runs the same duplicate check as `60_unfinalize_precheck_readonly.sql`.
- It prints ids and counts only, never keys or phones.
- `replace_sessions` is informational only: acceptance step 2.3 always creates one replace session.
```sql
BEGIN TRANSACTION READ ONLY;
SELECT count(*) AS replace_sessions FROM contact_import_sessions WHERE operation = 'replace';
SELECT d.campaign_id, count(*) AS duplicated_keys, c.status, c.audience_generation AS active_generation
FROM (SELECT campaign_id, idempotency_key FROM campaign_contacts GROUP BY 1, 2 HAVING count(*) > 1) d
JOIN campaigns c ON c.id = d.campaign_id
GROUP BY d.campaign_id, c.status, c.audience_generation ORDER BY d.campaign_id;            -- expected: no rows
ROLLBACK;
```

**If it returns rows, take path R3.** Do not attempt the index. The data repair that would make those rows unique changes rc audience data, and it is not part of this plan.

### 5. rc data under prod: ignored, crash, or wrong send

| rc data | What prod does with it | Result | Action |
|---|---|---|---|
| **Allocator-v2 plans and their jobs** (`campaign_plans.allocator_version = 'v2'`, rc `api/services/campaign-planning.ts:367`; each job carries its recipient's template, :554) | Uses the route's frozen template first and the job's template only as a fallback (prod `api/services/whatsapp-template-sender.ts:266-273`, `api/services/template-resolution.ts:103-106`). A v2 route is a lane whose template is only a default (rc `schema/campaign-routes.ts:55-62`, rc `api/services/allocator-version.ts:8-12`). | **Wrong send.** Every recipient allocated to another template gets the lane default. | Freeze |
| **Scheduled campaigns launched by rc** (rc `api/services/campaign-launch.ts:139-147`) | Housekeeping executes due Scheduled campaigns (prod `api/services/campaign-runtime.ts:273-280`) with prod's execute, which stamps the route's template on every job (prod `api/services/campaign-planning.ts:362-363`). | **Wrong send** at the scheduled time | The owner cancels them. rc has no "unschedule" (rc `api/routes/campaign-engine.ts:124-130`). |
| **Running, Paused or Ready campaigns that rc planned or executed** | prod claims jobs only from Running campaigns whose kill switch is off (prod `api/services/campaign-phone-reservoir.ts:203-204`, `api/services/campaign-queue.ts:458-459`). One click turns a frozen campaign into a sender: resume (prod `api/routes/campaign-engine.ts:91`, which also clears the kill switch, :256), or execute, which accepts Ready (prod `api/services/campaign-planning.ts:37`). The send then starts within seconds, faster than WQ1 (§12 step 10) can catch it. | **Wrong send** through the other rows of this table | Pause Running campaigns before the stop. For Ready and Paused ones, the owner chooses (RP9): cancel in rc (safe, terminal) or leave them, with the rule that nobody resumes, schedules or executes them. Watch WQ1 (§12 step 10). |
| **Replace imports** (generation > 0: rc `schema/campaigns.ts:74`, `schema/campaign-engine.ts:79`; staged rows of failed replaces too) | Planning takes every Valid row of the campaign, whatever its generation (prod `api/services/campaign-planning.ts:226-233`). Imports under prod land in generation 0, the column default. | **Wrong send:** recipients removed by the replace are planned again. Rows imported under prod become invisible to rc later. | Freeze. No plan and no import under prod. |
| **Message Studio media mappings** (`media_asset_id`, rc `schema/campaign-engine.ts:181`; source `media_asset` whose value is an asset id, rc `api/services/message-studio.ts:253`) | A non-csv source is used as a literal (prod `api/services/template-resolution.ts:138`), and a media header value is sent as a link (prod `api/services/whatsapp-template-sender.ts:116-121`). Output validation only allows `csv` and `static` (prod `lib/api-zod/src/generated/api.ts:1100`; GET mappings at prod `api/routes/campaign-engine.ts:641`). | **Wrong send** (the asset id goes to Meta as an image link) **and crash** (500 on that campaign's mappings page) | Freeze |
| **Delivery and distribution settings** (rc `schema/campaigns.ts:80-85`, `schema/campaign-engine.ts:375-377`) | Not in prod's schema, so ignored. Rates already frozen into a plan still reach the jobs (prod `api/services/campaign-planning.ts:362`). | **Ignored.** A re-plan under prod silently drops the owner's choice. | Freeze |
| **Workspace credentials** (`whatsapp_credentials`; `phone_numbers.credential_id` and `sending_credential_id`, rc `schema/phone-numbers.ts:37-49`; `wabas.credential_id`) | No reader. prod sends live only through the Replit shared connector (prod `api/services/whatsapp-provider.ts:2,153-158`), and only for a workspace whose claim matches (one real claim per connector account or WABA: prod `lib/db/src/schema/provider-integration.ts:35-36`, `api/routes/whatsapp-integration.ts:97-106`). Other live workspaces fail with "Real WhatsApp workspace is not verified", non-retryable (prod `api/services/whatsapp-template-sender.ts:279-290`). | **Ignored.** Credential-only live workspaces fail closed; their jobs end Failed. | Freeze their campaigns. Keep the rows and the key (§9). |
| **Connection rows saved by rc** | rc clears `connector_account_id` on every save and `configured_waba_external_id` on every live-mode save (rc `api/routes/whatsapp-integration.ts:96-109`). | That workspace's sends fail under prod until an owner re-claims it in prod Settings. The re-claim is a live check through the shared connector (prod `api/routes/whatsapp-integration.ts:76-91`), so it is the owner's live action, never part of the smoke test. | Compare `12_connector_inventory` before and after. |
| **New template statuses written by rc** (`Removed`, `In appeal`, `Pending deletion`, `Deleted`, `Limit exceeded`, `Unknown` and humanised unknown values: rc `api/services/whatsapp-template-sync.ts:29-50`) | The templates list only allows Approved, Pending and Rejected (prod `lib/api-zod/src/generated/api.ts:434`, `api/routes/templates.ts:31`). prod's own sync already writes `Paused`, `Disabled`, `In_appeal` and similar (prod `api/services/whatsapp-sync.ts:42-45`). | **Crash:** 500 on that workspace's Templates page | Run Q-TPL. Accept it as known T2 noise. |
| **Tables prod has no schema for:** `template_drafts`, `template_submission_attempts`, `template_media_uploads`, `template_eligibility`, `campaign_media_assets`, `campaign_media_provider_bindings`, `campaign_message_setups`, `mapping_presets`, `contact_import_occurrences`, `auth_*` | Never read | Ignored | None |
| **Deletes made under prod** | prod deletes campaigns, phone numbers and templates without conditions (prod `api/routes/campaigns.ts:177-182`, `api/routes/phone-numbers.ts:187-192`, `api/routes/templates.ts:120`). The delete cascades into rc-only rows: message setups and media assets (rc `schema/message-studio.ts:29,50`), media bindings (:78), template eligibility (rc `schema/template-eligibility.ts:29`). A campaign with a media mapping may instead fail the delete, because of the restrict FK (rc `schema/campaign-engine.ts:181`). | **Data lost for roll-forward**: S3 objects lose their reference. Or a 500. | Owners delete nothing under prod. |
| **`provider_messages` left `pending` or `delivery_unknown` by rc** | Fails them closed and never re-sends (prod `api/services/whatsapp-template-sender.ts:413-419`) | Safe | Reconcile per `deploy/README.md` §9 |

**Why the rest does not crash.**
- Every column rc adds to an existing table is nullable or has a default (pkg README, "Why the migration is more than Better Auth"; for example rc `schema/campaigns.ts:63-86`, `schema/phone-numbers.ts:37-49`), so prod's inserts still work.
- Campaign statuses are identical in both versions (prod `schema/campaigns.ts:6-15`, rc :23-32).
- The phone statuses rc writes are `Connected` and `Pending`, both inside prod's enum (prod `lib/api-spec/openapi.yaml:1473`).
- This search was not exhaustive. The RP7 click-through covers what is left.

**Q-FREEZE: the campaigns to freeze.** Read only.
```sql
-- $PSQL -v t_start='<T_START>' -f q_freeze.sql
BEGIN TRANSACTION READ ONLY;
SELECT c.id, c.organization_id, c.status, c.scheduled_at, c.audience_generation, c.distribution_mode, c.delivery_mode,
       p.allocator_version, p.created_at AS active_plan_created_at,
       (SELECT count(*) FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status = 'Queued') AS queued_jobs
FROM campaigns c LEFT JOIN campaign_plans p ON p.campaign_id = c.id AND p.status = 'Active'
WHERE c.status IN ('Draft', 'Ready', 'Scheduled', 'Running', 'Paused')
  AND (c.distribution_mode IS NOT NULL OR c.delivery_mode IS NOT NULL OR c.delivery_settings IS NOT NULL OR c.audience_generation > 0
    OR EXISTS (SELECT 1 FROM campaign_plans p2 WHERE p2.campaign_id = c.id AND (p2.allocator_version <> 'v1' OR p2.created_at >= :'t_start'::timestamptz))
    OR EXISTS (SELECT 1 FROM campaign_audit a WHERE a.campaign_id = c.id AND a.created_at >= :'t_start'::timestamptz
               AND a.action IN ('planned', 'executed', 'launch', 'adjust-speed', 'delivery_setup_saved', 'message_setup_saved', 'reopen'))
    OR EXISTS (SELECT 1 FROM campaign_routes r WHERE r.campaign_id = c.id AND r.shared_phone_budget)
    OR EXISTS (SELECT 1 FROM campaign_template_mappings m WHERE m.campaign_id = c.id AND m.media_asset_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM campaign_message_setups s WHERE s.campaign_id = c.id)
    OR EXISTS (SELECT 1 FROM contact_import_sessions s WHERE s.campaign_id = c.id AND s.operation = 'replace'))
ORDER BY c.status, c.id;
ROLLBACK;
```
Where the audit action names come from:
- `planned`, `executed`: rc `api/services/campaign-planning.ts:463,599`
- `launch`: rc `campaign-launch.ts:120,135,147`
- `adjust-speed`: rc `campaign-adjust-speed.ts:99`
- `delivery_setup_saved`: rc `campaign-delivery-setup.ts:216`
- `message_setup_saved`: rc `message-studio.ts:693`
- `reopen`: rc `campaign-import-lifecycle.ts:411,470`

v2 lanes are `campaign_routes.shared_phone_budget` (rc `schema/campaign-routes.ts:55-62`).

**Q-TPL: templates prod cannot display.**
```sql
BEGIN TRANSACTION READ ONLY;
SELECT organization_id, status, category, count(*) FROM templates
WHERE status NOT IN ('Approved','Pending','Rejected') OR category NOT IN ('Marketing','Utility','Authentication')
GROUP BY 1, 2, 3;
ROLLBACK;
```

**Freeze rule.** Repeat Q-FREEZE until no row is Running or Scheduled.
- **Running:** the owner pauses it in rc.
- **Scheduled:** the owner cancels it in rc.
- **Ready and Paused:** as signed off in RP9.
- **rc already down** (for example after a T4 stop). Never hand-written SQL. With the owner's approval and all cells stopped, run the package script, first as a dry run:
  ```
  $PSQL -L logs/70_freeze-$(date -u +%Y%m%dT%H%M%SZ).log -v pause_ids='{<Running ids>}' -v cancel_ids='{<Scheduled, and signed-off Ready/Paused ids>}' -f rollback/70_freeze_rc_down.psql; echo "exit=$?"                 # dry run by default: FREEZE DRY RUN OK
  $PSQL -L logs/70_freeze-$(date -u +%Y%m%dT%H%M%SZ).log -v pause_ids='{<Running ids>}' -v cancel_ids='{<...>}' -v commit=yes -f rollback/70_freeze_rc_down.psql; echo "exit=$?"   # FREEZE COMMITTED
  ```
  - It is fail-closed: anything other than exactly `-v commit=yes` (no flag, a misspelled flag, `commit=no`) is a dry run.
  - It applies the transaction prod's own `pause` (Running → Paused; routes `Paused`, `current_tps 0`; an audit row) and `cancel` (→ Cancelled with `completed_at`; routes paused; Processing imports Failed; Queued jobs Cancelled with leases cleared; `campaign_metrics.queued` reduced; an audit row) commits, from prod `api/routes/campaign-engine.ts:250-296`, plus the route `queue_depth` its post-commit reconcile pass would set. The rest of that pass (metrics recount, deltas, a `reconciled` audit row) is not repeated.
  - **After a T4 stop**, with the owner's approval, put the Running campaigns of the affected live workspace(s) in `cancel_ids` (terminal, like the §3 emergency-kill); pause only the others.
  - Gates: release schema present, no other client session (listed by pid, role, application and address when it refuses: stop every application process listed; `-v allow_other_sessions=on` is only for your own psql or monitoring sessions), every id in the expected status, lists disjoint. Before commit it compares the per-table row counters of its transaction with the exact expected counts. Exit 3 means nothing changed.
  - Lab-validated (dry run, commit, every branch including jobs, metrics and imports, and every refusal): package README, "Lab validation".

**Messages.**
- Owners: "Campaigns marked frozen must not be resumed, scheduled, executed, re-planned, re-imported or deleted until we switch forward."
- Everyone: "Reload any open Wabista tab."

### 6. Redis

**Never run rc and prod at the same time.** This applies even on different scopes. `deploy/README.md:114-116` already forbids two commits on one scope.

**The key formats are identical.** `campaign-prepared-broker.ts` and `campaign-pacing-coordinator.ts` did not change between prod and rc.

**The envelopes are not.**
- rc's prepared envelopes carry an `auth` workspace-credential reference (rc `api/services/campaign-transport-shards.ts:12-24`, set at rc `api/services/whatsapp-template-sender.ts:592`).
- The prod worker ignores it and sends with `providerClient(payload.mode)` (prod `api/services/campaign-transport-shard-worker.ts:109`).
- For a live envelope that means the Replit shared connector: either a send under the wrong credential, or a failed provider call where that connector does not work.

**So, with all cells stopped:**
1. **Record the streams.** These are `campaign:prepared:{phone:N}` (`campaign-prepared-broker.ts:79`): their XLEN and their pending count in group `campaign-prepared-v1` (:50). Settled entries are XACK'd and XDEL'd (:229-230). Scan with the pattern `campaign:prepared:{phone:*}`: plain `campaign:prepared:*` also matches the `…:published` dedupe hashes (:66,187), and XLEN answers WRONGTYPE on those. A non-empty stream means envelopes that the flush discards. Their jobs come back through the lease reaper (below).
2. **Flush database 0 only (`FLUSHDB`, never `FLUSHALL`), gated as in §12 step 5**, on a rollback and on the roll-forward after it. The reason is narrow: d22a8e43 would send rc envelopes through the shared connector, and rc fails d22a8e43 envelopes closed. The *initial* forward cutover (cutover W3) does not flush: it waits until no live lease exists and lets HEAD discard stale envelopes. If any stop hit the 90 s timeout, SIGKILL was a hard loss (`deploy/systemd/campaign-cell@.service:29-34`), and the README §6 replacement rules apply.
3. **Reconcile `delivery_unknown`** (`deploy/README.md` §9).

**The same gated flush applies on the roll-forward after a rollback (§13).** Live-mode envelopes prepared by prod carry no `auth`, so rc would fail them with `credential_required` (rc `api/services/whatsapp-provider.ts:279-282`).

**After the flush.**
- Jobs left in Processing are reaped once their 30 s lease expires (prod `api/services/campaign-runtime.ts:103`).
- They go back to Queued if their campaign is Running or Paused and not killed. They are cancelled if the campaign is terminal (prod `api/services/campaign-runtime.ts:217-237`).
- prod claims only from Running campaigns with the kill switch off (§5). A frozen Paused campaign's requeued jobs therefore wait. That is why resume is forbidden.

**Correction to the deploy README.**
- The owner key is `campaign:ownership:{campaign-owner:<org>:<phone>}:owner`, next to a `…:fence` key (rc `api/services/campaign-pacing-coordinator.ts:309-311`).
- The `{campaign-owner:*:1}` and `{campaign-owner:<org>:1}` patterns in `deploy/README.md:103-104` (§5) and :197 (§11) match nothing.
- Use `--scan --pattern 'campaign:ownership:*:owner'`. The owner key's TTL is 5 s (rc `campaign-phone-reservoir.ts:230`), and a clean stop releases it.
- Fence keys stay for at least 60 s (`campaign-pacing-coordinator.ts:219`), so `campaign:ownership:*` is never empty right after a stop.

### 7. Auth

**Users created under Better Auth.** Each has:
- an `auth_users` row and an `auth_accounts` row;
- a `users` row with `clerk_id = 'better-auth:<id>'`;
- an `auth_user_links` row.

Sources: rc `api/middlewares/auth.ts:58-66`, `lib/db/auth/src/index.ts:84-89`.

**What they see after rollback:**
- The prod SPA shows Clerk's sign-in and sign-up pages (prod `spa/pages/auth.tsx:1-26`). Their Better Auth cookie is ignored.
- Clerk has no account for their email, so they cannot sign in.
- If the Clerk instance lets them sign up, prod creates a second `users` row for the new Clerk id (prod `api/middlewares/auth.ts:40-75`; `users.email` is not unique, prod `schema/users.ts:10-11`).
- On that first sign-in with no memberships, prod accepts every Pending invitation for that email, by email alone (prod `api/middlewares/auth.ts:125-149`, prod `api/lib/orgProvisioning.ts:177-190`). Invitations they accepted under rc are no longer Pending.
- Otherwise prod gives them a new personal workspace seeded with "(Sample)" records (prod `api/lib/orgProvisioning.ts:34-39,216-237`).
- Their real workspaces, campaigns and contacts are intact in the database, but they belong to the placeholder user and are invisible.

**Message to send them:** "Sign-in is temporarily back on the previous system. Do not create a new account. Your workspace and data are safe and will return when we switch forward. Reload any open Wabista tab."

**On roll-forward** they sign in with the same email and password (the operator-created temporary one, or the one they changed it to), as long as `BETTER_AUTH_SECRET` is unchanged (§9). prod never touches the `auth_*` tables or the links.

**Never delete `auth_*` rows or placeholder users.** rc links a local user only by Better Auth id (rc `api/middlewares/auth.ts:50-56`), so a returning user without a link would get a new, empty local user.

**Legacy Clerk users.** rc does not change their identity:
- The only `users` write in rc is the placeholder INSERT (rc `api/middlewares/auth.ts:62`).
- rc never links a legacy row by email (:47-48).
- rc makes no Clerk calls.
- Path B1 only adds an invitation row (`21_owner_reinvite.psql`). Path B2 adds `auth_users`, `auth_accounts` and `auth_user_links` rows. Neither changes `users`.

prod finds their original row by Clerk id (prod `api/middlewares/auth.ts:41-45`). Their memberships and roles are as rc left them: an owner may have changed a role or removed a member under rc (rc `api/routes/members.ts:209,273`). Other effects of the rc period:
- Changes they made inside shared workspaces under rc remain.
- Anything their rc-only Better Auth account created, such as a new personal workspace, stays with the placeholder user.
- Path B1 owner memberships remain as an extra, inert member row. (B2 creates none: the person *is* the legacy user.)

**Pending invitations created by rc.** Under prod they lose their token binding. A first Clerk sign-in with that email joins automatically (prod `api/middlewares/auth.ts:144-149`). Owners revoke the ones they do not want.

**Q-STRANDED.** Read only.
```sql
BEGIN TRANSACTION READ ONLY;
SELECT count(*) AS better_auth_users,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.id)) AS with_memberships
FROM users u WHERE u.clerk_id LIKE 'better-auth:%';
SELECT count(*) AS orgs_unreachable_under_clerk FROM (
  SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id
  GROUP BY 1 HAVING bool_and(u.clerk_id LIKE 'better-auth:%')) x;
ROLLBACK;
```

### 8. Media

- rc stores campaign media in S3 (`CAMPAIGN_MEDIA_STORAGE=s3`, `CAMPAIGN_MEDIA_S3_*`, rc `api/services/campaign-media-storage.ts:313-350`).
- It references objects by `campaign_media_assets.storage_key` (rc `schema/message-studio.ts:47-64`).
- prod has no reader for any of it. Its only media code is the template-mapping image upload through the Replit sidecar (prod `api/routes/campaign-media.ts:29-30`, `api/lib/object-storage.ts:3`).

**Rollback leaves media alone:**
- No deletion, and no lifecycle rule.
- Keep the bucket, the S3 service (MinIO, if that is the store) and the access keys.
- Campaigns that reference media are frozen (§5), and owners delete no campaign under prod: that delete cascades the asset rows (rc `schema/message-studio.ts:50`) and orphans their objects.
- Roll-forward finds everything unchanged.

Deleting media is a separate owner decision, taken only if rc is abandoned (§11).

### 9. Env

- Restore the RP2 copies whole; do not edit them in place.
- The unit file is identical in both commits, so no `daemon-reload` is needed. The guard differs only in the scope-overlap check (`f967bd7`); each tree runs its own guard from its checkout. The `d22a8e43` guard still refuses a manifest/env scope mismatch, but prints `comm: … not in sorted order` and can miss an overlap between multi-digit ids, so restore the RP2 manifest unchanged (§12 step 7a) and never edit scopes during a rollback.
- To compare files, compare names only, never values: `diff <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' A | sort) <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' B | sort)`.

| Variable | prod | rc |
|---|---|---|
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Required (prod `api/app.ts:119-126`, `api/middlewares/clerkProxyMiddleware.ts:61-64`; prod `deploy/systemd/cell-1.env.example:8-9`) | Unused |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Unused | Required. Keep them for roll-forward: a new secret ends all sessions. |
| `AUTH_PUBLIC_SIGN_UP` | Unused | Absent (public sign-up closed, U2); `open` stops the process in production |
| `CAMPAIGN_CELL_REQUIRED_ENV` | Lists the Clerk variables (prod `deploy/systemd/cell-1.env.example:13`) | Lists the Better Auth variables (`deploy/systemd/cell-1.env.example:20`). The guard refuses an empty listed variable (`campaign-cell-guard.sh:64`), so restore the file as a whole. |
| `CORS_ALLOWED_ORIGINS` | Bare host names, compared with `URL.host` and merged with `REPLIT_DOMAINS`/`REPLIT_DEV_DOMAIN` (prod `api/app.ts:31-39,49-56`) | Full origins only. A bare host stops startup (rc `api/lib/http-config.ts:7-42`). With one shared origin, leave it unset in both. |
| `TRUST_PROXY` | Not read; fixed at 1 hop (prod `api/app.ts:64`) | Hop count, default 1 (rc `api/lib/http-config.ts:53-66`) |
| `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` | Unused | Decrypts every stored credential (rc `api/services/credential-crypto.ts:19`). Losing it means reconnecting every number. Keep it in the rc copy. |
| `WHATSAPP_APP_ID` | Unused | Template media header examples (rc `api/services/template-media.ts:39`) |
| `CAMPAIGN_MEDIA_STORAGE`, `CAMPAIGN_MEDIA_S3_*` | Unused | Media store |
| `REPLIT_DOMAINS`, `REPLIT_DEV_DOMAIN`, `PRIVATE_OBJECT_DIR`, Replit connector identity | Read on Replit only (CORS, object storage, shared connector) | Unused |
| `PORT` | Required (prod `api/index.ts:7-13`) | Defaults to 8080 (rc `api/index.ts:10-11`) |

**Health probes.** prod serves only `/api/healthz` (prod `api/routes/health.ts:9`). Re-point any `/api/readyz` probe.

### 10. HTTP front and the Meta webhook

**Front A: Replit served HTTP before cutover.**
- rc has no Replit configuration. So the front is prod's own Replit deployment: SPA static at `/` and API at `/api` (both prod `.replit-artifact/artifact.toml`).
- **Never let the Replit workspace merge or pull while its `DATABASE_URL` is the production database.** The post-merge hook runs a bare `drizzle-kit push` (§1).
- If the deployment was stopped, re-publish it from the workspace at `<PROD_SHA>`, **only after** (1) the workspace post-merge hook is disarmed (remove the `[postMerge]` block from the workspace `.replit`, or reduce `scripts/post-merge.sh` to `exit 0`) and no Agent task or merge is pending, and (2) production database access is restored for the deployment only (its deployment secret, or the P1 Host S block lifted for it). The operator does both with the user's go-ahead; §13 step 1 removes that access again before rc starts. Point DNS back and wait out the TTL (RP3).
- Keep the keep-out rule until the old TTL has passed, then disable the vhost without deleting it (works for a link or a file): `mv /etc/nginx/sites-enabled/wabista.conf /root/rb-<TS>-wabista.conf.disabled && nginx -t && systemctl reload nginx`.
- **Watch the runtime count:**
  - Every process of that deployment also starts the campaign runtime (prod `api/index.ts:21-29`).
  - There is no off switch (`deploy/README.md:250`).
  - The runtime is unscoped unless the deployment's secrets set `CAMPAIGN_TRANSPORT_PHONE_IDS` (prod `api/services/campaign-phone-scope.ts:17-19`).
  - The deployment is `autoscale` (prod `.replit:5`), so its process count is not fixed (Q9).
  - Restore exactly the process set recorded in RP1, never one more runtime. If the cells were not part of it, they stay disabled: the unit has `Restart=always` and is enabled at boot (`deploy/systemd/campaign-cell@.service:35,54-55`).
  - Check that each `campaign:prepared:{phone:N}` stream has exactly one consumer.

**Front B: nginx served HTTP.**
- Switch the SPA: `ln -sfn /var/www/wabista/releases/<PROD_SHA> /var/www/wabista/current`. This works only if the vhost root is that symlink (RP1, RP4).
- The repo had no nginx config at prod: `deploy/nginx/wabista.conf.example` is new in rc.
- The rc vhost also serves prod:
  - it proxies all of `/api/` (:45-61), including `/api/__clerk` (prod `api/middlewares/clerkProxyMiddleware.ts:27`);
  - it sets `X-Forwarded-Host` and `X-Forwarded-Proto`, which the Clerk proxy uses;
  - it is the single proxy hop that prod's fixed `trust proxy 1` expects (prod `api/app.ts:64`).
- Remove the sign-up block from §12 step 1. After the step 9 smoke from M, also remove the server-level `allow`/`deny` lines (keep the webhook location with `access_log off`), `nginx -t && systemctl reload nginx`, and check that `curl -s -o /dev/null -w '%{http_code}\n' https://<APP_DOMAIN>/` prints 200 from a non-allow-listed address before announcing.

**Both fronts.**
- If the public origin changed at reopen, the user switches the Meta webhook callback URL back in the Meta dashboard.
- Webhook deliveries (statuses, STOP replies) that arrive while HTTP is down (§12 steps 4-9) are not processed by the app. Ask owners to report any STOP received in that gap.

### 11. Database rollback policy

**The additive schema is NOT rolled back by default.** No DROP of tables, columns or indexes, and no backup restore. The reasons:
- prod runs on it (§4, §5).
- Dropping it destroys what roll-forward needs: Better Auth accounts and links, encrypted credentials, V2 plans and settings, references to S3 objects, import audit.
- Production schema changes are planned with the user.

**The only schema change a rollback may make** is `61_unfinalize.psql` (path R2). It renames one index and creates one, and it commits only when PostgreSQL's per-transaction counters show that no row changed (61:22-23,27-32). Its success path has never been executed (pkg README, "Not executed in the lab, on purpose"), so RP7 must run it. It runs only with the owner's approval.

**Restoring the pre-migration backup is not a rollback tool.** It erases everything since `T_START`:
- STOP opt-outs written to `suppressions` by the webhook (prod `api/services/whatsapp-webhook.ts:150-159`), which risks messaging people who opted out;
- message history and statuses, including the record of what was already sent, so a campaign run again after the restore can message the same people again;
- every new account.

Use it only for catastrophic corruption, by owner decision, after exporting `suppressions` and `provider_messages` so they can be re-applied.

**Dropping the V2 or Better Auth schema is justified only when one of these is true:**
1. The owner decides, outside an incident, to abandon the release for good. Then: backup first, export what must be kept, and run the drop as a separately planned, lab-validated change.
2. A legal or security requirement forces a purge of stored credentials. Delete those rows. That is a purge, not a rollback.
3. The migration itself failed part-way. `02_migrate.psql` runs in one transaction and rolls back on any failed gate, so this case should not arise.

### 12. Procedure

Run as root on the host named, except the checkout commands. Log each step's output: ids and counts only. Connect to PostgreSQL only as in the shorthands.

1. **Declare.**
   - Record `T_RB`.
   - Tell owners: no launches, imports, edits or deletes.
   - At nginx, put back the cutover W8 operator-only rule (`allow` lines for the operator and the owners who will do the freeze, above `deny all;`; the `/api/webhooks/whatsapp` location stays open with `access_log off`); they need rc's UI in step 3. After step 3 (or at once if T4 forced the cells down), remove the owners' `allow` lines so only `allow <M_ADDR>;` remains (optionally `error_page 403 /maintenance.html` with an exempt `location = /maintenance.html`). This is the "maintenance page" below.
   - Stop sign-ups: rc already refuses them (U2 = Option 2a, `AUTH_PUBLIC_SIGN_UP` closed); as a belt-and-braces rule whatever process answers, add `location = /api/auth/sign-up/email { return 503; }` to the server block, then `nginx -t && systemctl reload nginx`. Create no accounts with `dist/auth-admin.mjs` during the rollback.
2. **Inventory (read only).**
   - `$PSQL -L logs/40_postcheck-$(date -u +%Y%m%dT%H%M%SZ).log -f sql/40_postcheck_readonly.sql; echo "exit=$?"` prints the idempotency state. If it is `finalized`, run `sql/60_unfinalize_precheck_readonly.sql` the same way: OK means R2, FAILED means R3.
   - Run Q-FREEZE, Q-TPL, Q-STRANDED, `inventory/12_connector_inventory_readonly.sql`, and `select count(*) from provider_messages where status = 'delivery_unknown';`.
3. **Freeze** per §5 while rc still runs. If T4 fired, emergency-kill first. Re-run Q-FREEZE: no row may be Running or Scheduled. Then narrow the keep-out rule to the operator (step 1).
4. **Stop rc.** On Host C `systemctl disable --now campaign-cell@cell-1`; on Host D `systemctl disable --now campaign-cell@cell-2`. Disabling keeps a reboot from starting rc again; step 7 re-enables. Then on each host:
   - `systemctl is-active campaign-cell@cell-N` must print `inactive`.
   - `journalctl -u campaign-cell@cell-N -n 30 --no-pager` must show `Shutting down API server` (rc `api/index.ts:57`), and no stop timeout or SIGKILL.
   - Front A: confirm from RP1 that no Replit runtime is using this database or Redis.
   - `$PSQL -c "select application_name, client_addr, count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() group by 1, 2"` must show no application connection.
   - From here until step 9, HTTP is down.
5. **Redis** (Host S or M):
   ```
   read -rs REDISCLI_AUTH; export REDISCLI_AUTH                   # password stays out of argv and history
   R="redis-cli -h <REDIS_HOST> -p 6379"                          # add --tls for a rediss:// URL
   [ "$($R PING)" = PONG ] && echo AUTH_OK || echo 'STOP: redis-cli not authenticated'   # GATE 0: AUTH_OK (unauthenticated scans fail and would read as 0)
   $R CLIENT LIST | grep -c '^id='                                # GATE 4: must print 1 (only this client: no rc or prod process is still connected); otherwise STOP
   $R INFO keyspace                                               # GATE 1: only db0 (the database in CAMPAIGN_REDIS_URL) may be listed; otherwise STOP
   $R -n 0 --scan --pattern '*' | grep -vc '^campaign:'           # GATE 2: must print 0 (db0 holds transport keys only); otherwise STOP
   for k in $($R -n 0 --scan --pattern 'campaign:prepared:{phone:*}'); do echo "$k $($R -n 0 XLEN "$k") $($R -n 0 XPENDING "$k" campaign-prepared-v1 | head -1)"; done   # record; non-zero = discarded envelopes (§6)
   $R -n 0 --scan --pattern 'campaign:ownership:*:owner' > /root/own.txt && wc -l < /root/own.txt   # GATE 3: must print 0; no number = STOP
   ```
   Optionally take a fresh `BGSAVE` copy first, as in cutover W4. Then, as a separate command, only after GATES 0-4 passed:
   ```
   $R -n 0 FLUSHDB && $R -n 0 DBSIZE                              # 0. Never FLUSHALL.
   unset REDISCLI_AUTH; rm -f /root/own.txt
   ```
6. **Database.**
   - **R1:** nothing. Step 2 already showed `transitional`.
   - **R2:** get owner approval, then `$PSQL -L logs/61_unfinalize-$(date -u +%Y%m%dT%H%M%SZ).log -f sql/61_unfinalize.psql; echo "exit=$?"`. It must exit 0 and print `UNFINALIZE COMMITTED`. Exit 3 means nothing changed; on a lock timeout, run it again. Then `40_postcheck` must report `transitional`.
   - **R3:** nothing. Record that imports will answer 400.
7. **Application.** First record `T_PROD` (in front A, the first prod process starts when step 8 re-publishes the Replit deployment). Only if RP1 shows that prod cells ran before cutover; otherwise leave the cells disabled and go to step 8 (front A). Host C first, then Host D:
   - **If `/opt/cowabista.prev-<TS>` exists (cutover W6), swap it back instead of rebuilding** (as root): `mv /opt/cowabista /opt/cowabista.rc-<TS> && mv /opt/cowabista.prev-<TS> /opt/cowabista`. Then check that `git -c safe.directory=/opt/cowabista -C /opt/cowabista rev-parse HEAD` prints `<PROD_SHA>` and that `/opt/cowabista/artifacts/api-server/dist/index.mjs` exists. Keep `.rc-<TS>` for the roll-forward.
   - Only when no `.prev` directory exists: rebuild in place as the directory's current owner, using the RP5 offline store: `sudo -u "$(stat -c %U /opt/cowabista)" -H sh -c 'cd /opt/cowabista && git checkout <PROD_SHA> && pnpm install --frozen-lockfile --offline && pnpm --filter @workspace/api-server run build'`.
   - **7a. Settings files, on Host C and on Host D (nothing starts yet).** The env file and the fleet manifest come from the RP2 copies (cutover P11).
     - If an RP2 copy is missing, restore **that copy** first from the W4 tarball: one member, into a private directory, never over `/` (the tarball's `cell-cell-N.env` is the pre-W6 prod file and would replace the live rc file before it is saved): `install -d -m 0700 /root/rb-<TS> && tar -C /root/rb-<TS> -xzf /root/cutover-<TS>/etc-cowabista.tgz etc/cowabista/rollback/cell-cell-1.env.<PROD_SHA> && install -m 0600 /root/rb-<TS>/etc/cowabista/rollback/cell-cell-1.env.<PROD_SHA> /etc/cowabista/rollback/cell-cell-1.env.<PROD_SHA>`. The same pattern for `cells.manifest.<PROD_SHA>`. If that member is absent too, use `etc/cowabista/cell-cell-1.env` or `etc/cowabista/cells.manifest` (the pre-W6 prod files) as the source. This writes only the missing RP2 copy, never a live file, so the lines below then run unchanged.
     - These lines are safe to re-run (for example after the guard refuses and the cause is fixed): the env is saved only while the live file is still the rc file (only rc's env has `BETTER_AUTH_SECRET`), and the manifest only while it differs from the prod copy.
   ```
   grep -q '^BETTER_AUTH_SECRET=' /etc/cowabista/cell-cell-1.env && install -D -m 0600 /etc/cowabista/cell-cell-1.env /etc/cowabista/rollback/cell-cell-1.env.rc   # save the rc file first (secrets for the roll-forward); a re-run saves nothing
   cmp -s /etc/cowabista/cells.manifest /etc/cowabista/rollback/cells.manifest.<PROD_SHA> || install -D -m 0600 /etc/cowabista/cells.manifest /etc/cowabista/rollback/cells.manifest.rc   # save the rc manifest only if it changed after cutover (L1 scope reconfiguration)
   ls -l /etc/cowabista/rollback/cell-cell-1.env.rc                                                     # must exist; if not, the roll-forward falls back to .env.next (§13 step 6)
   install -m 0640 -o root -g cowabista /etc/cowabista/rollback/cell-cell-1.env.<PROD_SHA> /etc/cowabista/cell-cell-1.env
   install -m 0644 -o root -g root /etc/cowabista/rollback/cells.manifest.<PROD_SHA> /etc/cowabista/cells.manifest
   ```
   - **7b. Compare.** After both hosts finished 7a: `sha256sum /etc/cowabista/cells.manifest` must print the same hash on C and D. Otherwise STOP.
   - **7c. Start, Host C first, then Host D** (`cell-2` on D):
   ```
   systemctl enable --now campaign-cell@cell-1
   journalctl -u campaign-cell@cell-1 -n 50 --no-pager | grep -E 'OK host=|Campaign runtime started'   # commit=<first 12 of PROD_SHA>, scope <CELL1_PHONE_IDS>
   curl -s -w '\n%{http_code}\n' http://127.0.0.1:<PORT>/api/healthz                                    # 200, "status":"ok", campaignRuntime "ok"
   ```
   - Never run `lib/db` `push` or any `drizzle-kit` command from this checkout (§1).
   - Ownership keys appear only for phones that have a Running campaign.
8. **Front** per §10, plus the Meta webhook URL if the origin changed.
9. **Smoke prod. No sends.**
   - The Clerk test account signs in in a browser, and `GET /api/me` answers 200 in devtools. Never copy the cookie.
   - In the mock test workspace, import a 3-row CSV into a new Draft. The import must be `Completed`. Under R3, expect 400 and record it.
   - Run `inventory/14_zero_send_check_readonly.sql -v since=<T_PROD>`. It must pass.
     - Use `T_PROD`, not `T_RB`, because rc's own sends before the stop would fail it.
     - Check 14 fails only on send activity in a live workspace: provider messages created, or jobs claimed or sent.
     - Jobs that only became `Failed` or `Cancelled` print a `WARNING`, not a failure. The freeze's cancellations and the reaper's are expected there; anything else must be explained.
   - Remove the maintenance page and announce, using the messages in §5 and §7.
10. **Watch** every 5 min for 2 h, then hourly until roll-forward.
    - **WQ1** (the frozen campaigns stay frozen) and **WQ2** (no sends since `T_PROD` for frozen campaigns) run together from one read-only file, `wq.sql`, with the frozen list recorded at §12 steps 2-3. Run it only with `-f` as shown: psql does not substitute `:'frozen'` in a `-c` string. Both SELECTs must return no rows, and a psql ERROR is a failed check, not a pass.
    - Do not re-run Q-FREEZE for WQ1: every campaign prod plans or executes after `T_START` matches it too. Those are owners' legitimate prod campaigns; they are never killed on that basis, and §13 step 0 handles them before a roll-forward.
      ```sql
      -- $PSQL -v t_prod='<T_PROD>' -v frozen='{<ids from Q-FREEZE>}' -f wq.sql
      BEGIN TRANSACTION READ ONLY;
      -- WQ1
      SELECT id, status FROM campaigns WHERE id = ANY (:'frozen'::int[]) AND status IN ('Running', 'Scheduled');
      -- WQ2
      SELECT j.campaign_id, count(*) FROM provider_messages pm
      JOIN campaign_jobs j ON j.id = pm.campaign_job_id AND j.organization_id = pm.organization_id
      WHERE pm.created_at >= :'t_prod'::timestamptz AND j.campaign_id = ANY (:'frozen'::int[])
      GROUP BY 1;
      ROLLBACK;
      ```
    - T2 and T3 apply to prod as well, with `/api/healthz` only. prod request logs carry only method and path (prod `api/app.ts:90-96`). So exclude known 500s by path (`GET /api/templates`, the frozen campaigns' `/template-mappings`), not by organization.
    - Any WQ1 or WQ2 row (frozen ids only) means: emergency-kill that campaign in the prod UI (prod `api/routes/campaign-engine.ts:93`). This is terminal and cancels its Queued jobs (:276-282).

### 13. Roll-forward after a rollback

0. **While prod still serves.** Tell owners: no launches, schedules or imports. Run `12_connector_inventory_readonly.sql` and Q-FREEZE. Every action-A/C/D2 campaign, and every live Queued or Processing job, that is **not** on the Q-FREEZE list recorded at §12 step 2 is live work prod created during the rollback (rc would fail it closed): its owner cancels it (or lets it finish) in the prod UI. Wait until `import_sessions_processing_any_workspace` is 0. Repeat until only Q-FREEZE campaigns remain.
1. **Stop every prod process.** `systemctl disable --now` the cells. In front A, also shut the Replit deployment down (not idle), every instance, and remove its production database access again (summary blocker 1a).
   **Gate (as in §12 step 4 and cutover W3):** `systemctl is-active campaign-cell@cell-N` prints `inactive` on C and D; on S the P1 query (cutover P1), or §12 step 4's query, shows no application rows; then the **authenticated** Redis block of cutover W3: `AUTH_OK`, `CLIENT LIST | grep -c '^id='` prints 1, and the owner-key count prints 0. On any miss (or no number), STOP.
2. **Redis.** Repeat §12 step 5 (GATES 0-4, then `FLUSHDB` on db0).
3. **Connector inventory (re-check).** Re-run `12_connector_inventory_readonly.sql`. It may exit 3 only because of Q-FREEZE campaigns (a pause keeps their Queued jobs; step 7 handles them). If any other A/C/D2 row or an import in progress still appears (all cells are now stopped), cancel it only with the owner's approval through `rollback/70_freeze_rc_down.psql -v pause_ids='{}' -v cancel_ids='{<ids>}'`, first as a dry run, then with `-v commit=yes`. Never hand-written SQL. An import still `Processing` with no process left: STOP and decide with the owner. Then re-run 12.
4. **Index state: change nothing yet.** `40_postcheck` shows `transitional` after R1 or R2, and `finalized` after R3.
5. **Superseded generations.** Check that no prod import went into a superseded generation:
   ```
   printf '%s\n' "BEGIN TRANSACTION READ ONLY; select count(*) from campaign_contacts cc join campaigns c on c.id = cc.campaign_id where cc.created_at >= :'t_rb'::timestamptz and cc.audience_generation <> c.audience_generation; ROLLBACK;" | $PSQL -v t_rb='<T_RB>'
   ```
   If it is not 0, those rows are invisible to rc, and their owners re-import them under rc.
6. **Start rc, users kept out.**
   - Record `T_RF` (`date -u +%FT%TZ`) after the step 1 gate and before enabling any rc cell. In this roll-forward, use `T_RF` wherever acceptance says `<T0>` (0.1, 0.6, 1.17-1.19, 2.4) and wherever T4 says `<T_START>`, with no `approved_campaign_ids` until a new L2 is recorded. Whether L2 is repeated is decided at GO #1, as in the no-L2 case of cutover W13. At the reopen, record a new `T_OPEN` and RP6 snapshot.
   - Put up the cutover W8 operator-only rule before enabling any rc cell. **Front A:** first move the vhost back (`mv /root/rb-<TS>-wabista.conf.disabled /etc/nginx/sites-enabled/wabista.conf`; if it is missing, extract only that vhost from `/root/cutover-<TS>/etc-nginx.tgz` into `/root/rb-<TS>`, never over `/`; the W4 archive predates W8, so add the W8 rule to it before installing it), keep the W8 rule, remove the §12 step 1 sign-up block unless the sign-up policy keeps it, `nginx -t && systemctl reload nginx`, and pass the W8 403 check with `--resolve <APP_DOMAIN>:443:<N_ADDR>` before enabling any cell and before switching DNS (then W10's check after the switch). **Front B:** add the W8 server-level `allow <M_ADDR>; deny all;` lines back on N (§10 removed them; the webhook location with `access_log off` stays), plus the outer-proxy rule or `real_ip` setting if W8 used one, then `nginx -t && systemctl reload nginx`.
   - **Keep-out gate, both fronts, before enabling any rc cell.** From an address that is not allow-listed, `curl -s -o /dev/null -w '%{http_code}\n' --resolve <APP_DOMAIN>:443:<N_ADDR> https://<APP_DOMAIN>/` and `curl -s -o /dev/null -w '%{http_code}\n' --resolve <APP_DOMAIN>:443:<N_ADDR> -X POST https://<APP_DOMAIN>/api/auth/sign-in/email` must both print 403 (this tests N's own rule, which W8 always sets). If an outer proxy or load balancer sits in front of N, run both curls through it as well (`--resolve <APP_DOMAIN>:443:<EDGE_ADDR>`, or without `--resolve` once DNS points to it); each must print 403. A 200 or 502 means the rule is not active: STOP. (Better Auth sessions from the first rc period are still valid, so an open front would let those users straight back in.)
   - The rc tree, as root: **only if** `/opt/cowabista.rc-<TS>` exists (§12 step 7 swapped it out): `mv /opt/cowabista /opt/cowabista.prev-<TS> && mv /opt/cowabista.rc-<TS> /opt/cowabista`. If §12 step 7 was skipped (front A, no cells before cutover), leave the tree as it is. If step 7 rebuilt in place, check out and build `<REL>` in place as the directory owner. In every case `git -c safe.directory=/opt/cowabista -C /opt/cowabista rev-parse HEAD` must print `<REL>`.
   - The rc manifest, on C and on D: if `/etc/cowabista/rollback/cells.manifest.rc` exists (§12 step 7 saved it because the manifest changed after cutover), `install -m 0644 -o root -g root /etc/cowabista/rollback/cells.manifest.rc /etc/cowabista/cells.manifest`; otherwise leave the restored manifest as it is. Then `sha256sum /etc/cowabista/cells.manifest` must match on C and D.
   - The rc env, if §12 step 7 replaced it: `install -m 0640 -o root -g cowabista /etc/cowabista/rollback/cell-cell-1.env.rc /etc/cowabista/cell-cell-1.env` (`cell-cell-2` on D). Fallback if `.env.rc` is missing: `/etc/cowabista/cell-cell-N.env.next` if it is still on disk (W6 copied it and left it in place); otherwise extract only that member from the W4 tarball into `/root/rb-<TS>` as in §12 step 7a, never over `/`. `.env.next` predates any L1 scope change: if `cells.manifest.rc` was installed above, set its `CAMPAIGN_TRANSPORT_PHONE_IDS` to this cell's scope in that manifest before starting (the guard refuses a mismatch). Then run the cutover P5 checks and the environment §9 salted-fingerprint match (the same `BETTER_AUTH_SECRET` and `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` as before the rollback).
   - `systemctl enable --now` the cells. Switch the front back (SPA release or DNS).
   - If §12 step 8 changed the Meta callback URL, the app owner sets it back to `https://<APP_DOMAIN>/api/webhooks/whatsapp` with the same verify token **[LIVE META]**, together with the front switch. The operator then re-runs cutover W11's two checks. Ask owners to report any STOP received while webhooks went to the old origin.
   - Rerun acceptance phases 0-1 (0.5 expects `transitional`, or `finalized` after R3). Take GO #1.
   - Unless the state is already `finalized` (R3), run cutover W12b (`03_finalize.psql`, `40` = `finalized`, acceptance phase 2).
   - Then cutover W13/W14 (reopen).
7. **Owners review their frozen campaigns** before launching. Users who signed up with Clerk during the rollback have no Better Auth account, and what they created belongs to their Clerk-era user, which needs Path B.

### 14. Open questions that change this plan

- **Q1.** Who serves production HTTP today: the Replit deployment or the cells? This decides front A or B, and whether step 7 starts prod cells at all.
- **Q2.** Does the Replit deployment run the campaign runtime against the Host S database and Redis, and with which scope?
- **Q3.** Do the Replit-managed Clerk keys and the Clerk proxy work on a non-Replit origin? Front B depends on it.
- **Q4.** Does the Replit connectors SDK work from Host C and Host D? If not, prod on the cells can only send in mock mode, and live sending under a rollback exists only on Replit.
- **Q5.** Is Clerk sign-up open? This decides whether stray Clerk workspaces can appear (§7).
- **Q6.** How long do `61_unfinalize.psql` and the step-7 install and build take at production volume? Measure in RP7.
- **Q7.** `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` is missing from `deploy/systemd/cell-1.env.example`. The env section must add it, and the rollback must preserve it.
- **Q8.** Are Host C, Host D and the SPA build host linux-x64 with glibc? prod cannot build elsewhere (RP5).
- **Q9.** How many instances does the `autoscale` Replit deployment run, can it scale to zero (which stalls its runtime), and can its process set be pinned? Does its custom-domain link survive the DNS switch?
- **Q10.** Which host runs nginx, and is the installed vhost root `/var/www/wabista/current` (RP1, RP4)?

---


---

## Post-cutover acceptance checklist

**Ground rules:**
- **No "Send Now" in initial acceptance.** No test send, launch or resume in a **live** workspace.
- The campaign flow is exercised in a **mock-mode acceptance workspace**: the personal workspace a new account gets (the acceptance account is created by the operator command, U2 = Option 2a). It starts **empty** (`artifacts/api-server/src/lib/orgProvisioning.ts:76-98`), and step 1.6a gives it one mock number and one approved mock template from the deterministic mock provider. A mock workspace never calls Meta while it holds no workspace credential, and its new number is in no cell's transport scope, so it cannot send at all. Never connect a real credential to the acceptance workspace.
- Steps marked **(Meta)** read from Meta. Run them only with the user's go-ahead for that step.
- Record the window start time `T0`: the `t0_utc` line that `02_migrate.psql` prints. The rollback section calls it `T_START`. Every check below is "since T0". After a roll-forward, `T0` means `T_RF` (rollback §13 step 6).
- No secret is ever printed: secret checks below print **counts only**.

### Phase 0: infrastructure (users still kept out by the cutover W8 operator-only rule)

| # | Check | Pass |
|---|---|---|
| 0.1 | `journalctl -u campaign-cell@cell-1 -n 100` (and `cell-2`) | Guard `OK host=… scope=…` equals the manifest. `Campaign runtime started` with the same `phoneScope`. No error lines: `journalctl -u campaign-cell@cell-N --since "<T0>" -o cat \| grep -cE '"level":(50\|60)'` prints 0 (production logs are pino JSON with numeric levels) |
| 0.2 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/healthz` on each cell host, then `https://<PUBLIC_HOST>/api/healthz` | 200 everywhere |
| 0.3 | `/api/readyz`, the same three ways | 200 `ready`: database ok and initialization `ready` (`routes/health.ts:25-30`) |
| 0.4 | Startup log `Campaign media storage` | `kind: "s3"` with the expected bucket and prefix. The "No campaign media storage" warning is a fail (media is required, U4) |
| 0.5 | `40_postcheck_readonly.sql` | `POSTCHECK OK`, idempotency state `transitional`, Better Auth tables present |
| 0.6 | `14_zero_send_check_readonly.sql -v since=<T0>` | `ZERO-SEND CHECK OK` |

### Phase 1: functional (transitional index; everything except "replace audience")

| # | Check | Pass |
|---|---|---|
| 1.1 | Public page: open `https://<PUBLIC_HOST>/` in a private browser window | The landing page renders, assets load (no 404 in devtools), and there is no Clerk script or Clerk domain request |
| 1.2 | Closed sign-up (U2 = Option 2a): the landing page and the sign-in page show no sign-up link; `/sign-up` shows "Accounts are created by your administrator"; `GET /api/auth-policy` answers `{"publicSignUp":false}`; a `POST /api/auth/sign-up/email` answers 404. Then sign in with the operator-created acceptance account (`dist/auth-admin.mjs create`, temporary password typed from the operator's terminal, never pasted into chat) | Sign-up refused everywhere; signed in. The cookie is `__Secure-wabista.session_token` (Secure, HttpOnly, SameSite=Lax) |
| 1.2a | Change password: Account menu → Change password; a wrong current password, then the right one with a new 12+ character password. A second browser signed in to the same account beforehand | Wrong current password: "Your current password is incorrect." Success message; the second browser is signed out (its next page load asks for sign-in); this browser stays signed in; the old password no longer signs in |
| 1.3 | `GET /api/me`, checked in the browser's devtools Network tab. Never copy the session cookie into a terminal, a log or chat | 200 with the user (`id`, `email`, `name`, `isPlatformAdmin`, `createdAt`; no organization field). The active organization is the `isActive: true` entry of `GET /api/organizations` (1.4) |
| 1.4 | Organization access: the personal workspace is present and active; Team & Roles opens and shows the account as Owner. (Legacy workspaces are not reachable yet; if U3 is B1 or B2 they come back after the window, under Path A they stay unreachable) | No 401 or 403 where the role allows |
| 1.5 | Number Center (acceptance workspace, before 1.6a) | Empty list, no error |
| 1.6 | Template sync **(Meta)**: only in a workspace that already has a working workspace credential, and only with approval. On launch day no workspace has one, so mark N/A | Templates refresh with no 5xx |
| 1.6a | Mock setup (no Meta call): **Integrations → WhatsApp**, keep **Mock** mode, set the WABA ID `acceptance-mock`, save, then **Sync** (`services/whatsapp-sync.ts:70-85`) | Number Center shows `+15550000000` "Wabista Mock" with status Connected. Templates shows `wabista_mock` (Approved, body "Hello {{1}}"). Both come from the deterministic mock provider (`services/whatsapp-provider.ts:237-256`) |
| 1.7 | Campaign draft: create a Draft in the acceptance workspace | Created, with its revision shown |
| 1.8 | 3-row upload: a CSV with 3 phones (append) | 3 valid, 0 invalid. The import session is `Completed` |
| 1.9 | Message: choose the mock number and the `wabista_mock` template, and map `{{1}}` (static text or a CSV column) | Saved. The preview renders |
| 1.10 | Delivery: choose a delivery mode | Saved |
| 1.11 | Preflight / Review | Ready, with no blocker. Sample rows would be blocked (`phone_sample`, `template_sample`); the mock-synced rows are not samples |
| 1.12 | Schedule: in Review & Launch choose **Schedule**, pick a date **30 days ahead**, confirm. Never "Launch now". (Scripted equivalent, rehearsal only: action `launch` **with** `scheduledAt`, which refuses a past time. Never `plan` + `schedule` by hand: `schedule` accepts a past or null time, and the runtime then executes the campaign) | Status `Scheduled`, `queuedNew: 0` |
| 1.13 | Cancel: cancel that campaign | Status `Cancelled`. Nothing was claimed or sent: the zero-send check stays OK, and the mock workspace shows 0 sent |
| 1.14 | Media upload (**required**, U4: external S3-compatible provider): in another Draft, Message Studio, upload a small PNG → open its preview → delete it. Do it once through each cell if the nginx upstream lets you choose, otherwise twice | 201 → 200 image → 204. No `campaign media storage request failed` warning in the journal. The media smoke script passed once per cell beforehand (P6) |
| 1.15 | Logout → `/api/me` | 401. The SPA shows signed-out |
| 1.16 | Login again | 200. Same user id as before (`/api/me`) |
| 1.17 | No 5xx: `journalctl -u campaign-cell@cell-N --since "<T0>" -o cat \| grep -cE '"statusCode":5[0-9]{2}'` on both cells, plus the nginx error log | 0. Investigate any non-zero count before GO |
| 1.18 | No secrets in logs (counts only; see the script below) | Every count 0. No variable may print `unset` (media is required, U4) |
| 1.19 | No unexpected sends: `14_zero_send_check_readonly.sql -v since=<T0>` | `ZERO-SEND CHECK OK`: in live workspaces, 0 provider messages and 0 jobs claimed or sent. A `WARNING` about Failed or Cancelled live jobs is not a send, but it must be explained before GO |

Secret-leak count. Run it on each cell host as root, and the same value loop over `/var/log/nginx/*.log` on N (values typed with `read -rs`, never on the command line). On N also count `hub.verify_token=` in the access log: it must be 0 (the cutover W8 webhook location sets `access_log off`, so the verify token in Meta's verification query is never logged). It prints names and counts only, never values. Each value goes to grep through a file descriptor, never through the command line, so it never appears in `ps` or audit logs. Surrounding quotes are stripped the way systemd strips them, and an unset optional variable is reported as `unset`:

```bash
CELL=cell-1                                   # cell-2 on Host D
F=/etc/cowabista/cell-$CELL.env
T0='<T0 as YYYY-MM-DD HH:MM:SS UTC>'
LOG=$(mktemp); chmod 600 "$LOG"; journalctl -u "campaign-cell@$CELL" --since "$T0" -o cat > "$LOG"
for v in BETTER_AUTH_SECRET WHATSAPP_CREDENTIAL_ENCRYPTION_KEY META_APP_SECRET WHATSAPP_WEBHOOK_VERIFY_TOKEN CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY DB_PASSWORD REDIS_PASSWORD; do
  case $v in
    DB_PASSWORD)    val=$(sed -n 's#^DATABASE_URL=[^:]*://[^:]*:\([^@]*\)@.*#\1#p' "$F" | tail -n 1) ;;
    REDIS_PASSWORD) val=$(sed -n 's#^CAMPAIGN_REDIS_URL=[^:]*://[^:]*:\([^@]*\)@.*#\1#p' "$F" | tail -n 1) ;;
    *)
  val=$(sed -n "s/^$v=//p" "$F" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/") ;;
  esac
  if [ -z "$val" ]; then echo "$v unset"; continue; fi
  printf '%s ' "$v"; grep -cFf <(printf '%s\n' "$val") "$LOG"
done
unset val
printf 'token-shaped ' ; grep -cE 'session_token=|Bearer [A-Za-z0-9]|EAA[A-Za-z0-9]{20}' "$LOG"
printf 'url-redaction-leak ' ; grep 'OK host=' "$LOG" | grep -cE '(db|redis)=[a-z]+://[^ ]*@[^ ]*@'   # must be 0: the guard's redaction leaks a password that contains an unencoded @
rm -f "$LOG"
```

### GO / NO-GO decision #1 (end of phase 1)

- **NO-GO:** take the rollback path R1 (application only, no database change).
- **GO:** continue.

### Phase 2: finalize, then the one remaining check

| # | Step | Pass |
|---|---|---|
| 2.1 | `03_finalize.psql` | Exit 0 and `FINALIZE COMMITTED: … no row changed` (it commits only when the per-transaction row counters are 0) |
| 2.2 | `40_postcheck_readonly.sql` | `POSTCHECK OK`, idempotency state `finalized` |
| 2.3 | Replace audience: on a new acceptance Draft with 3 rows, upload a **replace** CSV with 3 **different** phones | 202, the new generation is active, the count is 3 |
| 2.4 | `14_zero_send_check_readonly.sql -v since=<T0>` | OK |

Why 2.3 uses different phones: it proves the generation switch without creating two generations that share a phone, so `61_unfinalize.psql` stays possible if a rollback is still needed after GO. Phone overlap in a replace import is covered by `test:audience`, which passes 13/13 on the finalized schema (lab).

### Reopen (cutover W13, then W14)

- **W13, limited reopen:** widen the operator-only rule to the owners approved for L1/L2 only. No public notice. The Meta callback URL was already switched in cutover W11 (or again in rollback §13 step 6 after a rollback), if the origin changed.
- **Until W14**, owners must not launch, schedule, resume **or test-send** in any workspace that has a number connected with its own credential (Live or Test mode, including their new personal workspace), except the approved L2 send (policy; the app does not enforce it; check 14 counts such workspaces as live).
- **L1/L2:** those owners connect their numbers in Number Center **(Meta)**. **The first live send happens only after a separate, explicit approval.** It goes to an owner-controlled test recipient, from a number whose credential was connected and verified in Number Center. Record the L2 campaign id.
- **W14, general reopen:** only after L2's delivered-status gate: remove the allow/deny lines (the webhook location stays, with `access_log off`) and announce. Decision U8 can move the general reopen to W13; it must be taken explicitly at GO #1. If no legacy number can be reconnected in scope (Path A, no live workspace, or L1/L2 deferred), the user chooses at GO #1 between U8 and W14 right after W13 (cutover W13).
- Keep watching 1.17 and 1.18 for the first hours. Run 1.19 (check 14) with `-v approved_campaign_ids='{<L2 campaign id>}'` once L2 has launched; from `T_OPEN` on, use rollback T4's queries instead.


---

## Non-blockers (none of these delays the launch)

| Item | Why it is not a blocker | Follow-up |
|---|---|---|
| **Raw Better Auth `console.error` lines** (rate-limit and internal errors carry only ids and limits) | As accepted at A5, they carry ids and limits only: no secret, cookie, password or email. They are noise in the journal, not leakage. The acceptance secret-count check (1.18) re-verifies this on production logs | Route through the pino logger with fixed fields (small) |
| **375 px table overflow** (some tables scroll horizontally on narrow phones) | Cosmetic. Every action stays reachable by scrolling | Responsive table pass |
| **Doc cleanup:** `docs/DEVELOPMENT.md` (campaign media paragraph) said "copy Replit media into the bucket under the same keys", but production has no managed media to copy (media section 10). `deploy/README.md §13` says a rollback needs no schema change. That is true until `03_finalize.psql` runs; this runbook's rollback section supersedes it | Text only | Corrected in the commit that adds this package (docs only; no Gate B effect) |
| **V2-07** | Planned next milestone, not part of this release's contract | As planned |
| **Unexpected DB error text in the CSV-import response** (found during P6). If an import fails on an *unexpected* database error, the 400 body, the session's stored `error` and the warning log carry the raw driver message, including SQL parameters (the uploaded phone numbers) (`routes/campaign-engine.ts:628-637`) | It only happens on unexpected database failures. The data goes back to the same workspace that uploaded it. The one known trigger (the transitional index) is removed by `03_finalize.psql` before users get in. No other tenant's data is involved | Map non-CSV errors to a fixed message and log only the error code (small; needs approval as a code change) |
| **Better Auth rate-limit table growth** (`auth_rate_limits`) | Rows are small and keyed per client and path | Optional periodic cleanup later |


---
