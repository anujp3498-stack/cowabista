# Wabista Nexus V2: final production cutover sequence

**Release `<REL>`:** `2a2afe6a2890da949947112e514236bc823935f1` (branch `wabista-nexus-v2`). **Production today:**
`d22a8e43` (branch `claude/wabista-nexus-tps-regression-lqp5ap`, not merged, not changed). **Package `<PKG>`:** the
final commit of `wabista-nexus-v2` that carries `deploy/cutover/` (recorded in the change record; it differs from
`<REL>` only in documentation and `deploy/cutover/`; `package/README.md` "How to connect"). **Status:** everything
that can be prepared without production access is done; nothing has touched production.

This page is the single operator order for the window. Every step points to the runbook (`RUNBOOK.md`; P = before
the window, W = in the window) for the exact commands, and to the package (`package/`) for the SQL. The cutover
stops at the first failed gate. Commands never print a secret; values are typed at hidden prompts or live in
root-only files.

## 1. What must be true before the window is booked (owner actions)

| # | Item | How it is closed | State at commit time |
|---|---|---|---|
| B1 | **U1 topology evidence E1-E6** | Run the read-only kit `package/discovery/` (workstation M, cells C and D, nginx host N, Host S) plus the Replit and Meta dashboards, with the user's go-ahead for read-only production access. Record the outputs | **Owner action**: this preparation environment has no route to production (no SSH, Host S unreachable, public DNS blocked) |
| B2 | Inventories 01/11/12/13/15 | Same pass: in the package directory first `sha256sum -c SHA256SUMS` (every line OK, else STOP), then `discover-s.sh`, which checks the sums again and runs them | Owner action (same pass) |
| B3 | U3 path | Rule in §2 below, applied to inventory 11 | Rule fixed; recorded when B2 is done |
| B4 | Encryption key rule | §3 below, from inventory 15 | Recorded when B2 is done |
| B5 | Replit access removal plan | §4 below; its owner confirms who can change the Replit deployment and secrets | Plan ready; executed in the window (step 3) |
| B6 | S3 bucket and least-privilege key | §5 below; media smoke from C and D (runbook P6) | **Owner action**: provider not yet provisioned |
| B7 | Cell scopes | `<CELL1_PHONE_IDS>` / `<CELL2_PHONE_IDS>` from the existing `/etc/cowabista/cells.manifest` (`discover-cell.sh` prints it), checked against inventory 12's phone list | From B1 |
| B8 | Rehearsal on a restored production backup | `package/README.md` "Required before the window"; operator, isolated host, copy destroyed afterwards | **Owner action**. The synthetic dress rehearsal (same sequence, R2 and roll-forward included) passed on 2026-10-22 |
| B9 | Builds staged on C and D (P4), SPA on N, env staged (P5, `ENV-MANIFEST.md`), nginx and TLS (P7) | Runbook P4-P7 | Artifacts verified reproducible (§6); staging needs production hosts |
| B10 | Rollback readiness RP1-RP10 (P11), owner sign-off for `70_freeze_rc_down.psql` | Runbook rollback §2 | Owner action |
| B11 | Window time and notice (U7), reopen choice (U8) | Runbook P9, W13/W14 | Owner decision |

## 2. Clerk users (U3): decided by rule, no code

- **Path A** if inventory 11 shows `users_in_active_or_live_orgs = 0`, or the owner confirms every such person is
  internal or test: operator-created accounts start in new, empty workspaces; legacy workspaces stay unreachable.
- **Path B1 (default)** otherwise: after the window, per legacy workspace, the operator creates the owner's account
  (`dist/auth-admin.mjs create`) and runs `package/path-b/21_owner_reinvite.psql`; the owner accepts the link and
  then re-invites their team (removing each teammate's old member row first).
- **B2 is not needed.** A code review of `<REL>` and `d22a8e43` shows every access decision goes through
  `organization_members (user_id, role)`; no route checks who created a resource; the release's authorship columns
  live in tables the migration creates empty; nothing gates on `users.is_platform_admin`. B1 restores full owner
  rights; B2 would only keep the same user id, at the cost of new code, a security review and a new release.
  Details: runbook, Clerk-users section.

## 3. Encryption key rule

`package/inventory/15_credential_key_inventory_readonly.sql` prints counts and key versions only.
`KEY RULE: PRESERVE EXISTING KEY` means the existing `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` is copied byte-for-byte
to both cells (never replaced); `NEW KEY PERMITTED` (zero stored credentials) allows a new key, generated once.
`d22a8e43` has no `whatsapp_credentials` table, so a production still on that schema prints `NEW KEY PERMITTED`;
any other answer is checked against E2/E4 before P5. The rule is re-checked at T-24h, T-1h and in step 6.

## 4. Replit database-access risk (read-only finding; action in the window)

**Risk.** At `d22a8e43`, `.replit` declares an Autoscale deployment and a post-merge hook (`.replit:18-20`) that
runs `scripts/post-merge.sh` → `pnpm --filter db push` (`scripts/post-merge.sh:3-4`): an unguarded `drizzle-kit push`
of the old schema. Against the migrated database it would propose dropping every V2 and Better Auth table. A
published Replit deployment that still holds the production `DATABASE_URL` or Redis URL would also run the old
runtime next to the cells. E2 (Replit dashboards, read only) and E3 (`discover-s.sh` client map) show whether either
exists; any client address that maps to Replit is a no-go until removed.

**Exact action (operator with the Replit owner, step 3 of the window, after step 2 and before step 4):**
1. Replit deployment: **Shut down** the deployment (not idle, not just redeploy) so no instance runs; confirm in the
   Deployments view that no instance is active.
2. Replit **deployment secrets** and **workspace secrets**: remove `DATABASE_URL` and every Redis URL or password
   that points at Host S (copy them first into the owner's secret store if the rollback window may need them; never
   paste them anywhere else). Without `DATABASE_URL` the post-merge `drizzle-kit push` cannot connect.
3. Stop the workspace **Run**, and do not merge or pull into the Replit workspace until the rollback window closes.
4. Gate, on S: the runbook W3 client checks (`pg_stat_activity` no application rows; Redis `AUTH_OK`, `CLIENT LIST`
   count 1, 0 owner keys) and `discover-s.sh`'s client map shows no Replit address.
5. Optional hardening (a Host S change, owner decision): block Replit's egress at Host S's firewall during the
   window. Do **not** rotate the database role password inside the window or the rollback window (the RP2 copies,
   the staged `.env.next`, the operator's `~/.pgpass` and the owner's store all hold the current one). Rotate it only
   after the rollback window closes, as a short planned change in a quiet period: write the new value into both cell
   env files and the secret store (salted-fingerprint check again), change the role password, then restart
   `campaign-cell@cell-1` and `@cell-2` one at a time (`readyz` 200 each; the cells read `DATABASE_URL` only at
   start), and update the operator's `~/.pgpass`; the RP2 copies are retired by then.

**Rollback note.** Front A returns only per runbook rollback §10: first disarm the workspace post-merge hook (remove
`[postMerge]` from the workspace `.replit`, or reduce `scripts/post-merge.sh` to `exit 0`; no Agent task or merge
pending). Then restore `DATABASE_URL` and the Redis URL from the owner's store to the **deployment** secrets only
(never the workspace secrets) and re-publish at `d22a8e43`. Rollback §13 step 1 removes that access again before the
release restarts. Front B needs no Replit action.

## 5. Media storage: external S3-compatible provider (U4)

**Operations the release performs** (the only SDK commands it imports): PutObject, CreateMultipartUpload, UploadPart,
CompleteMultipartUpload (all `s3:PutObject`), AbortMultipartUpload, GetObject (preview and the planning-time
provider upload), DeleteObject. **No presigned URL** of any kind, no public URL, no CORS, no bucket creation, no
listing. The browser talks only to the API.

**Minimum policy** (AWS IAM syntax; translate for the chosen provider):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "CampaignMediaObjects", "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::<S3_BUCKET>/campaign-media/organizations/*" },
    { "Sid": "MissingKeyAnswers404", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<S3_BUCKET>" }
  ]
}
```
`s3:ListBucket` is never used to list; without it a missing object answers 403, which the app reports as
"storage unavailable" (503) instead of "not found". No admin, ACL, tagging, versioning or bucket-policy rights.

**Bucket settings:** dedicated, private (all public access blocked), general-purpose (not a directory bucket), no
CORS, no website hosting; SSE-S3 or provider default encryption (with a customer KMS key add `kms:GenerateDataKey`
and `kms:Decrypt`); Object Lock off; versioning optional; a lifecycle rule that aborts incomplete multipart uploads
after a day; never expire current objects. One bucket, prefix and key for both cells; https endpoint; clocks in sync.

**Settings** (`ENV-MANIFEST.md` §1): `CAMPAIGN_MEDIA_STORAGE=s3`, `CAMPAIGN_MEDIA_S3_ENDPOINT`,
`CAMPAIGN_MEDIA_S3_REGION`, `CAMPAIGN_MEDIA_S3_BUCKET`, `CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID`,
`CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY`, and `CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE` only if the provider requires it.

**Acceptance (three levels):**
1. Before the window, from C and from D: the media smoke (runbook P6, media section §8) with the staged env file
   passes: every line `OK` and exit 0 (put, get with content compared, anonymous GET refused, delete, never-written
   keys missing, multipart create/upload/complete/abort; `WARN outside-prefix` only for a provider whose keys cannot
   be prefix-scoped). The CLI fallback probe does not satisfy this.
2. In the window, step 27 (acceptance 1.14): upload a small PNG in Message Studio of a second Draft → preview shows
   it (bytes identical) → delete → preview answers 404 → the object is gone from the bucket (provider console or a
   read-only `head-object` with the app's key answering 404).
3. Journal: no `campaign media storage request failed` warning on either cell.

The rehearsal ran levels 2 and 3 against an S3-compatible test server: 201 → 200 (bytes identical) → 204 → 404, and
a direct bucket read went from 200 to 404 after the delete. **State: OWNER ACTION REQUIRED** (provider, bucket, key).

## 6. Release artifacts (built and verified; staged on the hosts in P4)

| Artifact | SHA-256 |
|---|---|
| `artifacts/api-server/dist/index.mjs` | `7dc7d56c3c172aca51772c2fd79747c4da7a396b87535f7cc0328d8d4d1e394e` |
| `artifacts/api-server/dist/auth-admin.mjs` | `d0951b7a9be5dc47478c3243eb0f1b31f69d3668d5ea64c68bb5a92e4279efce` |
| `artifacts/api-server/dist/campaign-transport-shard-worker.mjs` | `96f3ee918510a9772b55e2f58190a0cf54f47f26eaad1742cff79fcd41618237` |
| `artifacts/api-server/dist/pino-worker.mjs` | `6bb4cd5ea82ec06358ff64706938362b9a91879a7dd1fe10e8014e5b5b25fe6c` |
| `artifacts/api-server/dist/pino-file.mjs` | `b72511019c189719fee0e4126cb9dca7284e4da410f770243a1483b1483db248` |
| `artifacts/api-server/dist/pino-pretty.mjs` | `cfb34bd6bf4580424d866595c4f6e774eee3126cd5383c7ba0f87bc10b747e9e` |
| `artifacts/api-server/dist/thread-stream-worker.mjs` | `44286ceae07d2e89f8a5820fda394a5f2bca0bad037b25c1c393ae45eb20ca4b` |
| `artifacts/wabista-nexus/dist/public/index.html` | `4b9dff4b0f91b37edfebe3233c760a12fe299d74e7c26e0d85e24741fcff2a85` |
| SPA tree: `cd artifacts/wabista-nexus/dist/public && find . -type f \| LC_ALL=C sort \| xargs sha256sum \| sha256sum` (6 files) | `74744cd9701685c2a1c26e46f2851ab82de31d17ea25251044dd3d5960b278cd` |
| `pnpm-lock.yaml` | `e2f2d690e098fcaf3538524b71bde85b28ad9156dd8bf9d4732394d3a88f3512` |

**These hashes hold for any build directory and Node 22 release.** Built from clean checkouts of `<REL>` with
`pnpm install --frozen-lockfile` (pnpm 10.33.0) at three absolute paths (`/opt/cowabista.next` among them) and with
Node 22.22.2 and 22.23.3: every file byte-identical. Before `<REL>` this did not hold: esbuild-plugin-pino wrote the
absolute build directory into `index.mjs`, `auth-admin.mjs`, `pino-worker.mjs` and `pino-file.mjs` (and their maps), so
a `f967bd7` build at `/opt/cowabista.next` gives `index.mjs` `af9f27116f8b…` and `auth-admin.mjs` `12dd0e3e96b5…`
(reproduced exactly) instead of the reference values taken in another directory; that one string was the only
difference. A pre-`<REL>` build also could not start a pino transport after the W6 rename (non-production mode only:
production mode uses no transport). `test:build-relocatable` guards both. The SPA build was already path-independent.
The rehearsal's adaptation of `deploy/nginx/wabista.conf.example` passed `nginx -t` (nginx 1.24) and served the
release; the unit file is unchanged since `d22a8e43`; the guard ships in the checkout. Hosts build `<REL>` with Node 22
and pnpm 10.33.0 (P4) and compare every row above with `sha256sum`; any difference is a STOP until explained.

## 7. Operator account bootstrap (`dist/auth-admin.mjs`)

**No production account exists yet; none is created before step 15.**

- **Precondition, every time** (`create` and `reset-password`), as root or through `sudo` on C: the sudo I/O-logging
  check of runbook W9 prints exactly `exit=1`, `sudo -l | grep -ciE 'log_(output|input|tty|std)'` prints `0`, and
  the terminal is not recorded (no `script`, no tmux logging, no session recorder). Any other result: STOP.
- **Create** (step 15, the smoke/operator account `<SMOKE_EMAIL>`, an operator-owned mailbox):
  `cd /opt/cowabista/artifacts/api-server && sudo -u cowabista env NODE_ENV=production node --env-file=/etc/cowabista/cell-cell-1.env dist/auth-admin.mjs create --email '<SMOKE_EMAIL>' --name 'Cutover Smoke'`
  The temporary password (24 base64url characters) is printed **once, on the terminal only**: the command refuses
  with exit 2 when stdout is not a terminal (rehearsed), so it can never be redirected, piped or logged. Type it
  into the hidden prompt of the W9 sign-in block; never into a file, a chat or a ticket.
- **Change it immediately** (acceptance 1.2a): Account menu → Change password, 12+ characters; every other session
  ends (rehearsed: the second browser got 401).
- **Reset** (forgotten password, after an out-of-band identity check): `… dist/auth-admin.mjs reset-password --email '<EMAIL>'`;
  same terminal rule; every session ends twice (second sweep after about 5 s).
- **Revoke** (lost device, offboarding): `… dist/auth-admin.mjs revoke-sessions --email '<EMAIL>'`; no password
  involved; the session answers 401 at once (rehearsed).
- Values in single quotes only (`'\''` for an apostrophe); never `sh -c` or double quotes around a value someone else
  supplied. Log lines carry only the action, the Better Auth user id and the operator name.
- **People's accounts** (U3) are created after the window, one by one, with the same command; the temporary password
  goes to the person through a separate channel, and they change it at first sign-in.

## 8. The window, in order

Each step lists its runbook reference, its gate, and the rollback checkpoint that applies **if the gate fails or
anything after it fails**. `T0` is printed by step 7. The first production acceptance uses **no Send Now, no test
send and no real WhatsApp message**.

| # | Step | Runbook | Gate (stop if not met) | Checkpoint |
|---|---|---|---|---|
| 1 | Maintenance and freeze: notice posted (announced at T-24h), no new launches, schedules or imports; owners cancel per the disposition table | P9, W1, W2 | `12_connector_inventory_readonly.sql` exits 0 (`the window can start`) | **CP0**: nothing changed; end the window |
| 2 | Stop the old runtime: first any published Replit deployment that serves **or connects to** production (front A or B) is shut down and its workspace Run stopped; then `systemctl stop` + `disable` of `campaign-cell@cell-1` (C) and `cell-2` (D) | W3 | journals show `Shutting down API server`, no SIGKILL | **CP1**: re-enable the old cells / redeploy Replit; schema untouched |
| 3 | Remove old Replit database and Redis access | §4 above | W3 gate: no application rows in `pg_stat_activity`; Redis `AUTH_OK`, 1 client, 0 owner keys, no stream with `pending>0`, no live lease; no Replit address in the client map | CP1 (restore the Replit secrets from the owner's store if front A must return) |
| 4 | Database backup: `pg_dump -Fd -j 4`, globals, table count | W4 | dump lists `<BASELINE_TABLES>` tables | CP1 |
| 5 | Redis snapshot: `BGSAVE`, copy of `dump.rdb`/AOF; encrypted archive copied off-host; checkout SHAs and `/etc` archives on C, D, N | W4 | `NEW_SAVE_OK`, status ok, off-host copy present | CP1 |
| 6 | Preflight: `15` (same `KEY RULE` as at P8), `01` | W5 | both exit 0; `PREFLIGHT OK` | CP1 |
| 8 (runs before 7) | Media readiness: the P6 media smoke recorded OK for C and D (put, get with content compared, delete, a never-written key answering missing), run again now against the staged `.env.next` and the P4 build; bucket, key and the staged media block unchanged since P6 | P6 | media smoke passes on C and D (runbook media §8: every line `OK`, exit 0; `WARN outside-prefix` only for a provider whose keys cannot be prefix-scoped); the CLI fallback probe does not satisfy this gate | CP1 (schema still untouched) |
| 7 | Migration: `02_migrate.psql`, then `40_postcheck` | W5 | `MIGRATION COMMITTED` (note `T0`), `POSTCHECK OK`, state `transitional` | **R1**: application rollback only, no database change |
| 9 | Env install: `cell-cell-N.env.next` → `cell-cell-N.env` | W6, `ENV-MANIFEST.md` | `discover-cell.sh` names SET/UNSET as the manifest; salted fingerprints equal; manifest hash equal on C and D | R1 |
| 10 | Release install: `/opt/cowabista.next` → `/opt/cowabista` (old tree kept as `.prev-<TS>`) | W6 | `rev-parse HEAD` = `<REL>` on C and D; `dist/auth-admin.mjs` present; build hashes as §6 | R1 |
| 10a | Front B, or whenever N already proxies `/api` to C/D: on N add the W8 operator-only rule (server-level `allow <M_ADDR>; deny all;` plus the `location = /api/webhooks/whatsapp { allow all; access_log off; … }` block; if an HTTP proxy or CDN sits in front of N, also the `real_ip` lines of runbook P5 on N, so `allow`/`deny` sees real client addresses), `nginx -t && systemctl reload nginx` | W8 | from a non-allow-listed address with `--resolve <APP_DOMAIN>:443:<N_ADDR>`, `/` prints 403 **before any release cell starts**; with an outer proxy, the same curl through it (`--resolve <APP_DOMAIN>:443:<EDGE_ADDR>`) also prints 403 | R1 |
| 11 | CELL-1 start (`systemctl enable --now campaign-cell@cell-1`) | W7 | guard `OK … scope=<CELL1_PHONE_IDS> … commit=2a2afe6a2890`; `Campaign media storage` `s3`; `Campaign runtime started` | R1 |
| 12 | Health and readiness | W7 | `/api/readyz` 200 `ready`; `/api/healthz` 200; no `"level":50` line | R1 |
| 13 | CELL-2 start, same checks for `<CELL2_PHONE_IDS>` | W7 | as 11-12 on D | R1 |
| 14 | nginx and frontend switch (W8 only): operator-only rule (already in place from 10a in front B; added now in front A, before nginx routes to the cells), SPA `current` link, `nginx -t`, reload; checks with `--resolve <APP_DOMAIN>:443:<N_ADDR>` | W8 | through nginx `/` and `/api/readyz` 200 from M; from a non-allow-listed address 403 (with an outer proxy, also through it: `--resolve <APP_DOMAIN>:443:<EDGE_ADDR>`) | R1 |
| 15 | Better Auth operator account (`auth-admin create`, §7), then W9's M-side block (with `--resolve` in front A) | W9 | exit 0; sign-up POST 404; `auth-policy` `{"publicSignUp":false}`; sign-in 200 with `__Secure-wabista.session_token` | R1 (**this account cannot sign in on the old runtime**, §9) |
| 15a | Front A only: DNS and TLS switch to N | W10 | `dig +short <APP_DOMAIN> @1.1.1.1` and `@8.8.8.8` both return N; `openssl s_client` shows the new certificate; from a non-allow-listed address **without** `--resolve`, `/` and `POST /api/auth/sign-up/email` print 403; W9's M-side block re-run without `--resolve` (no second `create`) | R1 (DNS back to Replit per rollback §10) |
| 15b | Webhook checks; Meta callback URL changed **only** if the E6 host is not `<APP_DOMAIN>`: **[LIVE META]**, a separate approval by the app owner, same verify token | W11 | wrong token 403, unsigned POST 401 | R1 (callback URL back per rollback §12 step 8 / §10) |
| 16 | `/api/me` | W9, acceptance 1.2, 1.2a, 1.3 | 200 with the user; password changed; other session 401 | R1 |
| 17 | Organization access | 1.4 | personal workspace active, role Owner; Team & Roles opens | R1 |
| 18 | Number Center | 1.5, 1.6a | empty before the mock setup; after it `+15550000000` "Wabista Mock" Connected | R1 |
| 19 | Template sync | 1.6a (mock sync); 1.6 (Meta) is N/A on launch day | `wabista_mock` Approved, body "Hello {{1}}" | R1 |
| 20 | Campaign draft | 1.7 | Draft created | R1 |
| 21 | 3-row audience (append) | 1.8 | 3 valid, 0 invalid, session `Completed` | R1 |
| 22 | Message (mock number, `wabista_mock`, `{{1}}` mapped) | 1.9 | saved; preview renders | R1 |
| 23 | Delivery mode | 1.10 | saved, no problem listed | R1 |
| 24 | Review (preflight) | 1.11 | ready, no blocker | R1 |
| 25 | Schedule 30 days ahead (Schedule, never Launch now) | 1.12 | `Scheduled`, nothing queued | R1 |
| 26 | Cancel it | 1.13 | `Cancelled`, 0 sent | R1 |
| 27 | Media upload → preview → delete (second Draft) | 1.14, §5 | 201 → 200 image → 204; object gone; no storage warning | R1 |
| 28 | Zero-send verification: logout/login, no 5xx, no secrets in logs, check 14 | 1.15-1.19 | `/api/me` 401 then 200 same id; 0 5xx; every secret count 0; `ZERO-SEND CHECK OK` | R1 |
| 29 | **GO / NO-GO #1** (owner and operator) | W12a | GO recorded with time; U8 reopen choice recorded | NO-GO → **R1** |
| 30 | Finalize: `03_finalize.psql`, then acceptance phase 2 (replace audience with 3 different phones) | W12b | `FINALIZE COMMITTED … no row changed`; replace 202, new generation, count 3 | **R2** from here (60 OK → 61), **R3** if 60 fails |
| 31 | Final postcheck: `40` (`finalized`), check 14 since `T0` (2.4), `60_unfinalize_precheck_readonly.sql` result recorded | W12b, phase 2 | `POSTCHECK OK` finalized; `ZERO-SEND CHECK OK`; 60 OK (R2 available) | R2 / R3 |
| 32 | Reopen access: limited reopen (approved owners' addresses added above `deny all;`), `delivery_unknown` baseline; general reopen W14 only after L2's delivered status (or U8) | W13, W14 | from an owner address 200, elsewhere 403 (W13) | R2 / R3, plus rollback §5 freeze of campaigns users create |

**After step 32 and only with a separate approval:** L1 (owners reconnect numbers, **[LIVE META]**) and L2, the first
real send: one consenting, operator-owned test recipient, from a number connected and verified in Number Center,
Review showing exactly 1 recipient, no test send. Check 14 then runs with `-v approved_campaign_ids='{<L2 id>}'`.

## 9. Rollback: final check (R1 / R2 / R3)

| Path | When | Database | Application | Rehearsed (synthetic, 2026-10-22) |
|---|---|---|---|---|
| R1 | Step 7, then steps 9-29 (state `transitional`) | nothing | stop the release cells, restore `.prev-<TS>`, the RP2 env and manifest copies, the old SPA, or Replit (front A, under the §4 rollback-note preconditions); Redis gates 0-4 then `FLUSHDB` of db0 | the `d22a8e43` build started on the migrated, transitional database: healthy, imports work |
| R2 | After step 30, `60` prints `UNFINALIZE PRECHECK OK` | with every cell stopped: `61_unfinalize.psql`, then `40` = `transitional` | as R1 | yes, end to end: freeze (`70` dry run, commit), stop, Redis gates, 61 (0.46 s), `d22a8e43` on the result, check 14 and WQ1/WQ2, then the §13 roll-forward and finalize again |
| R3 | After step 30, `60` fails (two generations share a phone) | none possible without a data decision | prod runs, imports answer 400, affected campaigns stay frozen; prefer fixing forward | yes: after a replace that reused the same phones, `60` printed `UNFINALIZE PRECHECK FAILED` and listed the campaign; `61` refused (exit 3, index still `finalized`, nothing changed) |

**Checkpoints:** CP0 (step 1), CP1 (steps 2-6 and step 8, which runs before 7; schema untouched: re-enable the old
runtime), R1 (step 7, then steps 9-29),
R2/R3 (steps 30-32 and after reopen). Freeze before any old process starts (runbook rollback §5, Q-FREEZE;
`70_freeze_rc_down.psql` only with the owner's sign-off and all cells stopped). The roll-forward (rollback §13) needs
the same stop gates before `FLUSHDB`: in the rehearsal they caught an old runtime that was still running.

**Limitation (not hidden): Better Auth accounts cannot sign in on the old runtime.** `d22a8e43` authenticates only
through Clerk. Every account created after cutover (the operator account of step 15 and every person's account)
gets **401** from the old runtime, and its sign-in endpoint does not exist there (rehearsed: session 401,
`/api/auth/sign-in/email` 404). After a rollback, a Clerk user keeps a legacy workspace through their Clerk-era
member row only if it still exists (removals made for B1 re-invites are not undone). A Clerk user with no
membership left is not refused: on the first request the old app accepts every Pending invitation for their email,
release-era B1 invitations included (marking them Accepted, so they must be re-issued after a roll-forward), or else
creates a new personal workspace seeded with demo data (`d22a8e43` `middlewares/auth.ts`; runbook rollback §7).
Access also works in front B only once Clerk sign-in through the nginx origin works (runbook RP4). Personal workspaces created by Better Auth accounts are invisible to the old
app. Campaigns created under the release inside legacy (B1) workspaces stay visible to those workspaces' Clerk
members and must be frozen per rollback §5 (Q-FREEZE) before any old process starts. Existing Better Auth sessions become valid again after a
roll-forward (rehearsed: 200). Clerk users who sign up during a rollback need Path B afterwards.

## 10. Expected window

From the runbook's operator steps: about 100-130 min plus *D* (dump), *Mg* (migration), *B* (startup) and, for
front A, the DNS TTL. The synthetic rehearsal measured *D* 0.6 s, *Mg* 1.7 s and *B* 1-2 s per cell at 95 MB and
309,400 contacts; finalize 0.26 s, unfinalize 0.46 s. Production values come from the restored-backup rehearsal (B8)
and replace these before the window is booked.
