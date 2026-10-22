# Wabista Nexus P6: production database package

**Release:** `<REL>` = `f967bd719acac2b9392124e95b7c6995c3d90ffc` (branch `wabista-nexus-v2`; `e37ab27e` plus Option 2a and the cell guard fix, the runbook header's `<REL>`). Its schema is identical to `e37ab27e085c9cdc4b72d9add4b4b38f81ca55b5` (`git diff --stat e37ab27e <REL> -- lib/db` is empty), which is why the SQL headers and the `wabista:p6-migration:e37ab27e085c` marker name that commit. Rehearse and deploy `<REL>`. **Production schema it applies to:** branch `claude/wabista-nexus-tps-regression-lqp5ap` at `d22a8e43` (identical schema at `111e0fe`).

**Nothing in this package has been run against production.** Every script was exercised on disposable local lab databases only, and the whole sequence ran end to end in a synthetic dress rehearsal (below). Production runs happen in the approved cutover window, by the operator, with the user's explicit go-ahead for that exact action.

## Why the migration is more than "Better Auth"

The release needs the whole V2 schema delta, not only the auth tables. With only the six Better Auth tables, the API fails at startup: initialization writes `template_eligibility` (`artifacts/api-server/src/index.ts:30`), and campaign, number and credential code reads the new columns.

| File | Statements | What it creates |
|---|---|---|
| `sql/10_v2_schema_additive.sql` | 92 | 10 tables (`whatsapp_credentials`, `template_drafts`, `template_media_uploads`, `template_submission_attempts`, `template_eligibility`, `campaign_media_assets`, `campaign_media_provider_bindings`, `campaign_message_setups`, `mapping_presets`, `contact_import_occurrences`); 23 columns on existing tables; 39 foreign keys; 20 indexes |
| `sql/20_contact_idempotency_transition.sql` | 1 | The generation-aware unique index `campaign_contact_idempotency_gen_uq`, created alongside the existing one |
| `sql/30_better_auth_additive.sql` | 20 | 6 tables (`auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`, `auth_rate_limits`, `auth_user_links`), 4 foreign keys, 10 indexes |

**What 10/20/30 (applied by `02_migrate.psql`) do not contain:** no DROP, TRUNCATE, DELETE, UPDATE, INSERT, RENAME, type change or `SET NOT NULL`. A pattern check found zero hits.

**Why the old code (d22a8e43) keeps working on the migrated schema:**
- Each of the 23 new columns on existing tables is nullable or has a constant default.
- Each new foreign key **on an existing table** sits on one of those new nullable columns.
- The two new unique indexes on existing tables are satisfied by existing rows by construction:
  - `creation_key` is NULL on all existing rows, and the old code never writes it;
  - the 3-column key is a superset of the old 2-column key, which keeps its old `ON CONFLICT` arbiter.

So an application rollback needs no database change, until `03_finalize.psql` runs.

**The one non-additive step is `sql/50_finalize_contact_idempotency.sql`**, run only through `03_finalize.psql`. It is one `DROP INDEX` plus one `ALTER INDEX … RENAME`: an index only, never a table, column or row. The release needs it before users are let in:
- While the old 2-column index exists, a "replace audience" import that repeats a phone fails.
- Lab proof: `test:audience` passed 12/13 on the transitional schema (failing "replace stages a new generation…" with `400 !== 202`) and 13/13 on the finalized schema.

It runs inside the window after the GO decision. It is reversible with `61_unfinalize.psql` while no campaign has two audience generations sharing a phone.

## How to connect (operator)

- **Connect directly to PostgreSQL on Host S, not through a pooler.** The session settings made before `BEGIN` must apply to the same server connection.
- **Use the database owner role the application uses.** A superuser or a member of `pg_read_all_stats` also sees other roles' session details. Without that, those sessions are still counted (the preflight prints `sees_all_sessions`).
- **Keep the password out of the command line**: no URL on the command line, no password in argv. Put it in `~/.pgpass` (mode 600) or a `PGPASSFILE`, and export the rest:
  ```
  export PGHOST=<HOST_S> PGPORT=5432 PGDATABASE=cowabista PGUSER=<owner role> PGSSLMODE=<as configured>
  mkdir -p logs
  psql -X -v ON_ERROR_STOP=1 -L logs/01_preflight-$(date -u +%Y%m%dT%H%M%SZ).log -f sql/01_preflight_readonly.sql; echo "exit=$?"
  ```
- **Copy and verify the package first.** Take it from the release commit (`git archive <REL> deploy/cutover/package | tar -x`), then in the package directory `sha256sum -c SHA256SUMS`: every line must print `OK`. A changed or missing file is a STOP.
- **Exit codes:** 0 = success. **3 = refused or failed; nothing was changed.**
- **Never pipe into `tee`.** The pipe hides psql's exit status. `-L` writes the log and keeps the exit code.
- The exception is `path-b/21_owner_reinvite.psql`: run it without `-L`, because its output contains an invite link.

## Files and order

| Step | File | Writes? | When |
|---|---|---|---|
| I1 | `inventory/11_user_inventory_readonly.sql` | read only | First run days before the window (cutover P8, before P3/P4/P5): U3 is decided from it. Re-run at T-24h and T-1h: no change that would alter U3 |
| I2 | `inventory/12_connector_inventory_readonly.sql` | read only | Days before (plan actions A/C/D2). At window start it must exit 0 (`window can start`): no live campaign in A, C or D2, no queued or processing live job, no import in progress |
| I3 | `inventory/13_media_link_inventory_readonly.sql` | read only | Days before |
| I5 | `inventory/15_credential_key_inventory_readonly.sql` | read only | First run days before the window (cutover P8, before P5): decides the key rule. Re-run at T-24h, T-1h and in the window before 02 (W5): same `KEY RULE` or STOP. Counts, statuses and key versions of `whatsapp_credentials` only; never a token column, never decrypts. Last line: `KEY RULE: NEW KEY PERMITTED` (no table, or zero rows) or `KEY RULE: PRESERVE EXISTING KEY` (keep the current `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` byte-for-byte). Exit 3 (STOP) on a `key_version` other than 1 |
| 01 | `sql/01_preflight_readonly.sql` | read only | Days before, and at window start. Exit 0 = ready. Section 7 prints the baseline facts for the change record (`baseline_tables`, `max_phone_id`, `database_size`, `imports_processing`) |
| 02 | `sql/02_migrate.psql` (runs 10, 20, 30) | **schema, one transaction** | In the window, with all API cells stopped. Prints T0 |
| 40 | `sql/40_postcheck_readonly.sql` | read only | After 02, after the rollout, after 03. Fails on an incomplete schema **or any invalid index** |
| 14 | `inventory/14_zero_send_check_readonly.sql -v since=<T0> [-v approved_campaign_ids='{<L2 id>}']` | read only | During and after acceptance, and until reopen. A workspace counts as live when its mode is not mock **or it holds any workspace credential**. Fails on: provider messages or claimed/sent jobs in live workspaces outside the approved campaigns; more than one recipient per approved campaign; **any** live test send (seen through its `test_send_requested` audit row; never excepted). Lists activity per campaign. Failed or Cancelled live jobs give a warning |
| 03 | `sql/03_finalize.psql` (runs 50) | **one index drop + rename** | In the window, after GO #1, before reopening |
| 60 | `sql/60_unfinalize_precheck_readonly.sql` | read only | Only if rolling back after 03 |
| 61 | `sql/61_unfinalize.psql` | **one index create + rename** | Only if rolling back after 03, with all cells stopped |
| 70 | `rollback/70_freeze_rc_down.psql` (`-v pause_ids='{…}' -v cancel_ids='{…}'`; a dry run unless exactly `-v commit=yes`) | **the transaction d22a8e43's own pause/cancel commits, plus route `queue_depth`** | Only in a rollback when the release is already down, with the owner's approval and all cells stopped |
| B1 | `path-b/21_owner_reinvite.psql` | one invitation row | After the cutover, Path B1 only, per approved owner |
| D | `discovery/discover-{m,cell,n,s}.sh` | read only | Before the window is booked: U1 evidence E1-E6, client map of PostgreSQL and Redis, and inventories 01/11/12/13/15 in one pass (`discovery/README.md`) |

**Common to every script:**
- `ON_ERROR_STOP` is set, so any failure exits 3.
- Read-only scripts run in `BEGIN TRANSACTION READ ONLY`. Writing scripts roll back on any failed gate, so a refusal leaves nothing behind.
- They print only counts, object names and definitions, md5 fingerprints, internal ids and link host names. Never emails, names, Clerk ids, tokens, credentials, phone numbers, provider ids or message content.
- The one exception is `21_owner_reinvite.psql`, which shows the invite path once, by design.

## Gates built into the writing scripts

### `02_migrate.psql`

**Before any DDL, it requires all of these:**
- The schema equals the d22a8e43 catalog: columns, constraints and indexes (303/84/80), nothing missing and nothing extra. An extra object is accepted only with `-v allow_schema_extras=on`, after reviewing the listed objects.
- None of the 16 tables, 23 columns, 47 indexes and 59 constraints it creates exists yet.
- No other client session is on the database, including sessions of other roles. Override with `-v allow_other_sessions=on` only after checking the list.
- No job holds a live lease.

**After the DDL, in the same transaction, it requires:**
- PostgreSQL's per-transaction counters (`pg_stat_xact_user_tables`) show 0 rows inserted, updated or deleted in any table.
- The data fingerprint is unchanged.
- The schema equals the release catalog: 514 columns and 143 constraints, nothing missing or extra; indexes equal apart from the transitional pair.

If everything holds, it writes the marker `COMMENT ON TABLE auth_user_links` = `wabista:p6-migration:e37ab27e085c` and commits. Otherwise it rolls back.

### `03_finalize.psql`

- **Gate:** release schema present, state `transitional`.
- **Before commit:** state `finalized`, and the per-transaction counters show 0 row changes. This proof is scan-free, so the short exclusive lock is held only for the DDL, and it is unaffected by what the running cells commit meanwhile.
- `lock_timeout` is 5 s. On a timeout nothing changed; run it again.

### `61_unfinalize.psql`

- **Gate:** release schema present, state `finalized`.
- **Before commit:** state `transitional`, and 0 row changes.

### Overrides

`-v x=on` enables an override. `-v x=off`, or not passing it, keeps the gate. This is tested.

### Do not re-run, and never push from the old checkout

- **Never re-run `02_migrate.psql` once it has committed** (postcheck OK, marker present). Its absent-objects gate refuses anyway. Continue from the rollout.
- **Never run `lib/db` `push` (or any `drizzle-kit` command) from the d22a8e43 checkout against the migrated database.** At d22a8e43, `push` is a bare `drizzle-kit push` (`d22a8e43:lib/db/package.json:11`), and it would propose dropping every V2 and Better Auth table and column. An application rollback needs no schema command at all.

## Lab validation (disposable local PostgreSQL 16; never production)

**Lab databases:** all built with the guarded `lib/db` push from the respective commit's schema, with a synthetic production-shaped seed (44 users, 30 organizations, 309,400 campaign contacts, 360 jobs):
- `p6_prod`: the production schema;
- `p6_mig`: the production schema plus 10/20/30, applied through the guarded `apply-sql` (one transaction, additive-only filter);
- `p6_head`: the release schema.

The saved outputs (synthetic data only; invite tokens masked) are generated lab files and are **not committed** with this package; the results are summarised below. Inventory 15 was added on 2026-10-22 and run on disposable local databases created through the guarded `reset-disposable-local` + `push` (release schema) and an empty database (no release schema, as production at `d22a8e43`).

| Check | Result |
|---|---|
| 10/20/30 through guarded `apply-sql` | All 113 statements accepted as additive. 2.1 s / 1.0 s / 0.6 s on 309k contacts |
| Drizzle dry-run on `p6_mig` vs the release schema | Only known Drizzle noise (6 trigram indexes re-created, long FK names, 4 SET DEFAULT) plus the index finalization |
| Catalogs | `p6_prod` vs the d22a8e43 catalog: 0 missing, 0 extra. `p6_mig` and `p6_head` vs the release catalog: 0 missing, 0 extra (idempotency pair excluded) |
| Data fingerprint `p6_prod` vs `p6_mig` | Identical |
| Row-change counter | 0 on read-only runs. 0 → 1 after a single test UPDATE (rolled back), so it detects changes |
| `01_preflight` | `p6_prod` exit 0 `PREFLIGHT OK`. `p6_mig` / `p6_head` exit 3 |
| `40_postcheck` | `p6_mig` exit 0 (`transitional`). `p6_head` exit 0 (`finalized`). `p6_prod` exit 3 |
| `02_migrate` gates (it now lists the other sessions it refuses on: pid, role, application, address; no query text) | Refused, exit 3, nothing changed, on: `p6_mig` (objects present); `p6_mig` with both overrides `=off`; `p6_prod` with a second session open; the same with `allow_other_sessions=off`. Sessions were forced read-only as a safety net |
| `02_migrate` verification block on `p6_mig` (read only) | `data_unchanged=t release_ok=t verify_ok=t` |
| `03_finalize` | Refused on `p6_head` (already finalized) and `p6_prod` (not migrated). Verification block on `p6_head` (read only): `data_unchanged=t release_ok=t finalized verify_ok=t` |
| `61_unfinalize` | Refused on `p6_mig` (already transitional) |
| `60_unfinalize_precheck` | `p6_mig` / `p6_head` exit 0. `p6_prod` exit 3 |
| Inventories 11/13 | Exit 0 on both schemas, counts only |
| Inventory 12 | Exit 3 on the seed (it has live Running, Scheduled and Ready campaigns), with the per-campaign actions A/B/C/D1/D2 listed |
| Inventory 14 | Prod schema: `since=now` exit 0; `since=2000` exit 3; no `since` exit 3 (usage). Migrated schema, each case planted inside a transaction that the check's own ROLLBACK undoes (nothing left behind): one live send not approved → exit 3; the same send with its campaign approved → exit 0; two recipients on the approved campaign → exit 3; a live job cancelled → exit 0 with a WARNING; a live test send `sent`, even on the approved campaign → exit 3; a test send `failed` → exit 0; a `sent` test send with transport `workspace_credential` in a mock workspace → exit 3; a send in a mock workspace **that holds a credential** → exit 3; the same send in a mock workspace without one → exit 0 |
| Inventory 15 | Empty database (no `whatsapp_credentials`, as `d22a8e43`): exit 0, `NEW KEY PERMITTED`. Release schema with 0 rows: exit 0, `NEW KEY PERMITTED`. Two planted rows (one revoked; placeholder ciphertext): exit 0, `PRESERVE EXISTING KEY`, counts by key version, status and kind only. One row with `key_version = 2`: exit 3, `STOP`. No token column appears in any output |
| Inventory 13 frozen-plan query | A plan planted with a credential-bearing, signed link (rolled back) is reported with its host only |
| `21_owner_reinvite` | Creates one invitation on `p6_mig`. Refuses (exit 3): a second pending invitation, a non-owner email, a non-owner email with `allow_other_email=off`, an empty prompt, an un-migrated schema |
| `test:audience` | Transitional 12/13 (expected failure, see above). Finalized 13/13 |
| `70_freeze_rc_down` (final revision) | Fail-closed: no flag, `commit=no` and a misspelled `-v comit=yes` all ran as dry runs (nothing changed); only `commit=yes` committed. Pause + cancel commit: route `queue_depth` reconciled (`70_freeze_commit_yes_queue_depth_route_state_mig.txt`: 4 with 4 queued jobs for the paused campaign, 0 for the cancelled one). All-branches cancel: campaign Cancelled with `completed_at`, 3 jobs Cancelled, metrics `queued` 5 → 2, in-progress import → Failed with d22a8e43's message, route Paused/0 TPS/queue depth 0, one audit row; per-table counters equal the expected counts. Refused (exit 3, nothing changed): a pause id not Running, overlapping lists, empty lists, an un-migrated schema, another client session (listed by pid, role, application and address), an already-frozen campaign. (An earlier revision with a `dry_run` flag was also tested on 18 and 120-job sets; superseded.) |

Note: the lab databases are disposable; `70` ran its commit tests on `p6_mig` after every other script's evidence was captured.

### Not executed in the lab, on purpose

In the lab above, the **success paths** of `02_migrate.psql`, `03_finalize.psql` and `61_unfinalize.psql` were not run: their DDL content was applied through the guard (10/20/30) and their verification logic was exercised read-only. They were then run, on the user's instruction for the final preparation (2026-10-22), in the synthetic dress rehearsal below, against a disposable local database only.

## Synthetic dress rehearsal (2026-10-22; disposable local databases; never production)

**What it was:** the full window, rollback R2 and roll-forward, with the release `<REL>` and the production build `d22a8e43` actually running, on a **synthetic** production-shaped database (the seed above: 95 MB, 309,400 contacts, 26 tables). No production host, database, Redis, secret or Meta endpoint was used; this machine cannot reach them. It does **not** replace the restored-backup rehearsal below: it proves the procedure and the scripts, not production's data or timings.

**Set-up:** source database built with the guarded `reset-disposable-local` + `push` of the `d22a8e43` schema and the seed; backed up with `pg_dump -Fd -j4` and restored into a separate disposable database, the "isolated copy". Two release cells (scopes `1-12` and `13-24`, `NODE_ENV=production`, Redis coordinator, password-protected Redis, systemd-style env loading, the guard run as `ExecStartPre`), nginx 1.24 from `deploy/nginx/wabista.conf.example` with TLS, the SPA staged under `/var/www/…/<REL>` with a `current` link, the W8 keep-out rule, and an S3-compatible test server for media. Every package file was checked against the commit (`sha256sum`) before use.

| Step | Result | Time |
|---|---|---|
| Backup *D*: `pg_dump -Fd -j4`; restore into the isolated copy | OK | 0.6 s; restore 2.5 s |
| `01_preflight`, inventories 11, 13, 15 | `PREFLIGHT OK`; counts only; `NEW KEY PERMITTED` (no stored credential) | seconds |
| Inventory 12 | Exit 3 (4 A, 4 C, 6 B, 6 D1 campaigns), then exit 0 after the owners' cancels (simulated with d22a8e43's cancel transition) | |
| `02_migrate.psql` (*Mg*) | `MIGRATION COMMITTED`, data fingerprint unchanged; `40` `POSTCHECK OK`, `transitional` | 1.7 s |
| Cells start (guard `OK … commit=f967bd719aca`), readiness (*B*) | `readyz` 200; media storage `s3`; runtime scopes `1-12` / `13-24`; 0 error lines | 1.1-2.1 s per cell |
| Front | SPA, deep link and assets 200; `auth-policy` `{"publicSignUp":false}`; sign-up 404; webhook wrong token 403, unsigned POST 401; from a non-allow-listed address `/` and sign-in 403, webhook reachable | |
| W9 operator account | sudo I/O-logging precondition; `auth-admin create` on a terminal (password shown once, never logged); sign-in, `/api/me` 200; change password ends the other session (401) | |
| Acceptance 1.3-1.16 (API sequence of the UI steps) | 35/35 PASS: mock sync (`+15550000000`, `wabista_mock`), Draft, 3-row CSV, Message, Delivery, preflight/review ready, schedule +30 days, cancel (0 sent), media upload 201 → preview 200 (bytes identical) → delete 204 → object gone from the bucket, sign-out 401, sign-in again same user id | 1.5 s scripted |
| 1.17 / 1.18 / 1.19 | 0 5xx; every secret and token count 0 (cell logs, guard log, nginx logs); `ZERO-SEND CHECK OK` | |
| `03_finalize.psql`, `40` | `FINALIZE COMMITTED … no row changed`; `finalized`; 2.3 replace with 3 different phones 202 (generation 1); 2.4 OK | 0.26 s |
| Rollback R2 (§12) | Q-FREEZE and Q-TPL; cells stopped cleanly ("Shutting down API server", no SIGKILL), 0 application sessions; `70_freeze_rc_down` dry run then `commit=yes` (Ready v2 campaign cancelled); Redis gates 0-4 and `FLUSHDB` of db0; `60` `UNFINALIZE PRECHECK OK`; `61_unfinalize.psql` `UNFINALIZE COMMITTED`; `40` `transitional` | stop 3-4 s; 70 0.06 s; 61 0.46 s |
| `d22a8e43` on the unfinalized database | Both cells healthy in 1.2 s, runtime ok, 0 errors; its import insert (`ON CONFLICT (campaign_id, idempotency_key) DO NOTHING`) inserts 3 rows and absorbs the repeat (in a rolled-back transaction); check 14 since `T_PROD` OK; WQ1/WQ2 0 rows. **A Better Auth session gets 401 from `d22a8e43`** and `/api/auth/sign-in/email` is 404 there | |
| Roll-forward (§13) | Gates (0 sessions, Redis `AUTH_OK`, 1 client, 0 owner keys) then `FLUSHDB`; 12 exit 0; `transitional`; 0 superseded rows; keep-out 403; release cells ready; the existing Better Auth session is valid again (200); acceptance 33/33 PASS (1.5 skipped: workspace already set up); check 14 since `T_RF` OK; `03_finalize` again; 2.3/2.4 OK | ready 1.5 s; finalize 0.24 s |
| Operator command | `reset-password` with stdout not a terminal: exit 2, nothing written; `revoke-sessions` ends every session (401); sign-in again 200 | |
| R3 detection | On the finalized copy, a replace import that reused the same 3 phones (allowed by the release): `60` exit 3 `UNFINALIZE PRECHECK FAILED` listing that campaign; `61_unfinalize.psql` exit 3 at the index build, nothing changed, state still `finalized` | 61 0.1 s |

**What it found and what changed:**
- **Cell guard (fixed in `<REL>`, commit `f967bd7`):** with multi-digit phone ids the overlap check fed `comm` numerically sorted lists, so an overlap such as `9-12` against `12-14` passed with a `comm: … not in sorted order` warning. Test first (`test:cell-guard`), then the fix. `d22a8e43`'s guard still has it: never change scopes during a rollback.
- **Roll-forward gate caught a still-running old runtime.** In the rehearsal harness a stop helper first signalled a wrapper instead of the node process; §13 step 1's gate (application sessions, Redis clients) showed it immediately. On the hosts, `systemctl disable --now` stops the whole control group, but the gate must be read and obeyed before `FLUSHDB` (FINAL-SEQUENCE checkpoint R-RF).
- **Seeded mock campaigns:** at the first start the release failed closed 40 queued jobs of two *mock-workspace* Running campaigns whose synthetic contacts were not tenant-owned ("Campaign contact is missing or not tenant-owned"); no send. Production mock-workspace Running campaigns, if any, keep running on the local mock transport.

**Estimated window from these timings:** the fixed operator steps of the cutover section (about 100-130 min) dominate; *D* + *Mg* + *B* added under 10 s at this size. Production's *D*, *Mg* and *B* scale with its database and must come from the restored-backup rehearsal below.

### Required before the window: one full rehearsal

**Sequence:** 01 → 02 → 40 → start the release → 03 → 40 → 60 → 61 → 40 (the synthetic dress rehearsal above ran the full window, R2 and the roll-forward around it), on a **restored copy of the latest production backup**. It also measures the real index-build and scan times at production volume.

**Rules for the rehearsal:**
- **Run by the operator only, with the user's explicit approval for that exact action.** An agent never runs it.
- On an **isolated non-production host**, with no route to Meta. Start the release there in mock-only fashion, or not at all, and never with production secrets.
- The restored copy holds real personal data (emails, phone numbers). Restrict access to it, and **destroy it afterwards**.
