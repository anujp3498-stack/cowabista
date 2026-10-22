# Wabista Nexus

> Moved from `replit.md` on 2026-10-20 (Replit exit, R1a). Local setup, environment and commands are in
> `docs/DEVELOPMENT.md`; rules for coding agents are in `CLAUDE.md`. Dated history elsewhere in `docs/`
> and `.agents/memory/` still describes the Replit-era setup as it was at the time.

Wabista Nexus is a professional multi-tenant messaging and WhatsApp Business API management platform: CRM-style contact management plus a campaign engine (the "Rocket Campaign Engine") that can split a campaign across multiple sending routes (phone number + WABA + template) for scale and reliability.

## Run & Operate

Moved to `docs/DEVELOPMENT.md`: prerequisites, the `.env` model (`.env.example`), the API (port 8080) and web
(port 24902, `/api` proxied to the API) dev servers, the guarded database commands, tests and the reverse-proxy
layout (`deploy/nginx/wabista.conf.example`).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Auth: Better Auth 1.7.10, email and password (`better-auth/minimal` with the Drizzle adapter server-side, `better-auth/react` client-side; tables in `lib/db/auth`). Clerk was removed on 2026-10-21.
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM bundle, `artifacts/api-server/dist/index.mjs`)

## Where things live

- `artifacts/wabista-nexus/src/pages/` — one file per route (contacts, phone-numbers, templates, campaigns, rocket-campaigns, team-roles, overview, home, auth, settings, etc.)
- There is no mock-data module any more. Home (`pages/overview.tsx`) reads only real overview stats and campaigns; the Inbox, Automations, Billing and API & Webhooks routes are honest "not available in this release" placeholders (unlinked from navigation) until their V2 milestones land
- `artifacts/api-server/src/routes/` — one Express router per resource (organizations, members, contacts, phone-numbers, templates, campaigns, campaign-routes, overview, me)
- `artifacts/api-server/src/lib/auth.ts` (Better Auth instance, served at `/api/auth/*`), `lib/auth-config.ts` (strict startup check of `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`), `middlewares/session.ts` (resolves the session cookie for every `/api` request; client IP for Better Auth)
- `artifacts/api-server/src/middlewares/auth.ts` — `requireAuth`/`attachOrgContext`/`requireRole`: session check, JIT user (linked through `auth_user_links`) + personal-org provisioning, active-org resolution, role enforcement. Only `lib/auth.ts` and `middlewares/session.ts` import Better Auth, so route-handler tests need no auth settings
- `artifacts/api-server/src/lib/orgProvisioning.ts` — creates an empty personal organization (organization + owner membership only) on a user's first login; no demo data is seeded
- `lib/db` — Drizzle schema (source of truth for tables/columns), including a `wabas` table (WhatsApp Business Accounts) and a `users.isPlatformAdmin` flag reserved for a future platform-admin area
- `lib/api-spec` — OpenAPI spec (source of truth for API contracts); run its `codegen` script after changing it to regenerate `lib/api-client-react`'s generated hooks/types
- `lib/api-client-react/src/generated/api.ts` — Orval-generated React Query hooks (`useList<X>`, `useCreate<X>`, ...) and matching `getList<X>QueryKey` helpers

## Architecture decisions

- Auth is Better Auth (email and password; see "Better Auth" below); on first authenticated request `attachOrgContext` JIT-provisions a local `users` row (linked to the Better Auth user through `auth_user_links`) and, if the user has no organization memberships yet, auto-creates an empty personal organization (no sample numbers, contacts, templates or campaigns; Home shows an honest getting-started state instead). First-login provisioning is race-safe: it's guarded by a per-user Postgres advisory lock (`pg_advisory_xact_lock`) inside a transaction, so concurrent initial requests from the same brand-new user can't create duplicate personal orgs.
- Multi-tenancy: every domain table is scoped by `organizationId`; RBAC (`owner`/`admin`/`manager`/`agent`) is enforced server-side per route via `requireRole`, not just hidden in the UI.
- Invitations are token-bound (decision D1): signing up with an invited email never joins by itself, because email/password sign-up does not verify the address. The invitee accepts with `POST /api/invitations/accept` (token in the body) while signed in with the invited email; emails compare lowercased on both sides — see `.agents/memory/wabista-pending-invitations.md`.
- Every CRUD mutation must manually call `queryClient.invalidateQueries` with the matching `getList<X>QueryKey` in its `onSuccess` — Orval's generated hooks don't invalidate automatically. See `.agents/memory/react-query-orval-invalidation.md`.
- Switching the active organization (header workspace switcher) does a full page reload after activating, rather than relying on query-cache invalidation alone — the server resolves the active org from a cookie, and some pages' client-computed permission checks were observed to go stale otherwise. See `.agents/memory/org-switch-stale-cache.md`.
- WhatsApp integration settings are tenant-scoped and owner/admin protected. Since R1b (R-D1, 2026-10-21) the Replit shared connector is gone and the settings only choose **mock** (deterministic test provider for numbers without a credential) or **live** (`real`): every live number sends with its own encrypted workspace credential (Numbers, `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY`), and a number without one cannot send, sync or upload (`credential_required`, fail closed, no fallback). Only an owner can switch between mock and live, in either direction; any number of workspaces can be live. Only the exact stored mode `mock` counts as mock. WABAs, phone numbers and approved templates synchronize per business account through the workspace credential (Meta Graph v23.0 management plane; sending uses v25.0).
- The workspace-level sync (`POST …/whatsapp/sync`) is mock-only. Workspaces that were live on the retired connector keep their `configured_waba_external_id` as a marker the Integrations page explains; connecting that business account in Numbers is the migration path, and saving the settings clears it. Running or scheduled campaigns on such numbers fail their remaining jobs closed. `provider_connections.connector_account_id`, the two `mode = 'real'` partial unique indexes and the evidence label `legacy_connector` remain in `lib/db/src` unchanged (Gate B hashed); the label now means "connector-less mock sync".
- Campaign dispatch uses the tenant's mock or real WhatsApp provider mode. Accepted provider message IDs and signed webhook delivery events are persisted idempotently; delivery/read/failure metrics advance monotonically.
- Analytics reads real data (`routes/analytics.ts`: summary, delivery trends, route health). Inbox/Automations/Billing/API & Webhooks have no backend yet and render honest unavailable states. Overview stats exclude rows flagged `isSample` (legacy demo rows in older workspaces are left in place, not deleted) and count campaigns in the real `Running` state.

## Product

Wabista Nexus is a real, database-backed multi-tenant app (not a demo): sign up/sign in with email and password, land in an auto-provisioned workspace, manage Contacts/Phone Numbers/Templates/Campaigns/Campaign Routes with full CRUD, invite teammates with roles (RBAC enforced), switch between organizations, synchronize WhatsApp Business resources, and dispatch template campaigns. Analytics is real; automations, inbox, billing and the developer API are not available yet and say so instead of showing sample data.

## User preferences

Moved to `CLAUDE.md`.

## Gotchas

- `getOrCreateLocalUser`/invite flows: any future email comparison must lowercase both sides, and email equality alone never proves ownership (no verification yet) — see `.agents/memory/wabista-pending-invitations.md`.
- Any new CRUD mutation must call `invalidateQueries` on the matching list query key in `onSuccess`, or the list will look stale until an incidental refetch happens — see `.agents/memory/react-query-orval-invalidation.md`.
- Any new "switch active tenant" action driven by a server-side cookie/session should hard-reload rather than trust in-memory cache invalidation alone — see `.agents/memory/org-switch-stale-cache.md`.
- After editing `lib/api-spec`, re-run its `codegen` script; if the zod client version comes out broken, check `override.zod.version: 3` is still pinned in the orval config — see `.agents/memory/orval-zod-codegen-version.md`.
- There is currently no UI to create a second/additional organization (`useCreateOrganization` exists in the generated client but nothing calls it) — users only get the one auto-provisioned personal org plus any orgs they're invited into.
- Manual WhatsApp credentials (`whatsapp_credentials`) are ciphertext only and bound to their organization by AAD; a discovered number is stored with `status = "Pending"` and `setupState = "discovered"` and is NOT sendable until verification (V2-02B). Guided setup (verify by SMS/voice, then register with a 6-digit PIN) ends at `setupState = "registered_transport_pending"` and still leaves `status` untouched; the verification code and PIN are never stored. `sendingCredentialId` (not `credentialId`) decides transport auth per phone: null means no workspace credential (sends only in a mock workspace, otherwise `credential_required`), set means the owning transport shard must hold a `credential-bind` for that phone (installed by the reservoir at lane setup from the main process; never through the broker, a job payload or a frozen plan) and sends directly to Graph with a Bearer header. Shard workers must never import `@workspace/db` or Redis. Activation (`activate-sending`) is the only step that sets it; revocation clears it and demotes the phone to Pending/action_required. Templates for a credential-backed WABA are synced with that WABA's own credential (`whatsapp-template-sync.ts`); rows Meta stops returning become `status = "Removed"` and are never deleted, template status is read-only in the UI, a sync reserves a per-WABA generation before fetching and never overwrites a newer applied one, and the apply transaction locks the credential row FOR SHARE and the WABA row FOR UPDATE (lock order: advisory, credential, WABA, phone/template rows) so revocation or reconnection cannot interleave with a validated sync. Generic template PATCH/DELETE lock the row FOR UPDATE, refuse provider-backed rows (409 provider_backed) and refuse referenced local rows (409 referenced). Set `CAMPAIGN_TEST_GRAPH_BASE_URL` only in tests to point the direct sender at a fake Graph server (ignored in production). Template authoring (V2-03B) is management-plane only: drafts live in `template_drafts` (never in `templates`), every write needs `expectedRevision`, owner/admin is enforced by `requireRole("admin")`, and a draft becomes a Meta template only through `POST …/template-drafts/:id/submit`, which claims a `template_submission_attempts` row (DB-enforced single active attempt per draft) in a short transaction, sends exactly one `POST /{waba}/message_templates` outside any transaction with the WABA's own decrypted credential, and records the outcome in a second short transaction. Timeouts, 5xx and replies without an id leave the draft `reconcile_required`; nothing resubmits automatically, and reconciliation links a provider template only on name + language + content evidence (a same-name template with different content is reported, never attached). Approval status is read from Meta (post-submission sync, `refresh-status`, or the regular sync) and never set locally. Media examples are uploaded from the authenticated request body only (bounded sizes, JPEG/PNG/MP4/PDF) and the provider handle never leaves the server. Status refresh of a submitted draft is the hardened per-WABA sync itself (never a direct `templates.status` write) and answers 409 `sync_superseded` when a newer sync applied first; a draft linked to a synced row displays that row's status. The submission claim locks credential → WABA → draft (advisory lock first), matching sync and the credential lifecycle writers. Reconciliation links only on exact name, language, component sequence, texts and button destinations (media headers by format only, stated in the note), is fenced by `attemptId`, and never discards an unknown outcome into a retry: such a draft stays locked and its name stays reserved. Late provider replies are persisted on the attempt (`late_*` columns) without overwriting a settled state. Deleting a draft detaches its attempts rather than erasing them. Sender-template compatibility (V2-04) is ONE shared decision in `template-eligibility.ts` (`decidePair` on loaded state) used by route create/update, Rocket setup, readiness, planning, the compatibility endpoints and send preparation: a template is the exact synced row of its WABA; a workspace-credential phone needs an active, tenant-owned sending credential bound to its WABA, a provider phone id and Connected status; the template must be provider-backed, Approved, not Removed and verified by a `template_eligibility` evidence row (one row per provider template, written only by an APPLIED sync inside its transaction or by the idempotent startup backfill; never per phone x template); the explicit local/mock exception (mock connection, no sending credential) lets local templates and unbound test numbers pair only when their WABA references agree and can never authorise a credential send. `campaign_routes.waba_id` is server-derived and re-verified at readiness. Rocket setup pairs numbers to templates deterministically (augmenting-path matching in request order, then least-loaded template) and writes nothing when coverage is impossible; allocator v1 is unchanged. Frozen routes carry `wabaId`, `wabaExternalId`, `eligibleTemplateIds`, `eligibilityVerifiedAt`, `eligibilitySource` from one evaluation at planning; older plans lack them and that grants nothing; preparation always re-checks live eligibility on the frozen template id and blocks rather than rerouting. Startup order (V2-04 correction, `services/startup.ts`): listener up → eligibility backfill to completion → campaign runtime started once, only on success; a failed backfill never starts the runtime and exits the process with code 1; shutdown during the backfill never starts it afterwards. `/healthz` is liveness (unchanged), `/readyz` is readiness for campaign operations and is the production startup health path. Template listings go through one validated, cursor-complete, bounded page walk (the workspace-credential client; the connector client was removed in R1b); the connector-less mock sync writes templates and evidence only after a complete validated listing and leaves everything unchanged on any listing failure. Termination follows Meta's SDK: a page without `paging.next` is terminal even when `cursors.after` is present; `next` requires a usable `after`; the page cap is 200 (terminal page at the cap accepted). Meta's documentation pages are egress-blocked here; the create/list/upload-session parameters were verified against Meta's official Python Business SDK, while the chunk-upload request (OAuth header, `file_offset`, `{h}` reply), handle lifetime and the creation reply shape remain unverified and must be confirmed before the first production submission (details in `docs/WABISTA_NEXUS_V2_IMPLEMENTATION_PLAN.md`). Rocket Audience (V2-05A): `/campaigns/new` creates one Draft per `creationKey` and moves to the resume URL `/campaigns/:id/audience` (registered before `/campaigns/:campaignId`); campaign PATCH accepts `revision` and refuses a stale one (409 `stale_revision`). `POST …/imports/sniff` is bounded (256 KB, 200 rows, 20 sampled) and never guesses a country code. Imports append (default) or replace (`x-import-operation`): a replace stages a new `audience_generation` and activates it atomically on completion; planning, search and counts read only `campaigns.audience_generation`. Canonical contacts keep `stableContactKey`; duplicate rows are kept in `contact_import_occurrences` (identity session + row) and downloadable as `duplicates.csv`. The parser decodes UTF-8 across chunks and `normalizeHeaders` keeps empty/repeated headers as `column_N` / `name_2`. Action `reopen` moves Ready → Draft only with no jobs, superseding the plan; any job freezes the audience and setup; Paused is never reset. Setup (routes, Rocket setup) may change after import while Draft/Ready with no jobs, superseding a Ready plan. Rotating several templates per sender is V2-06 (allocator v2), not V2-05.
- Team invites: `POST /api/members` adds an existing account immediately only when its email is verified (none are yet); otherwise it creates (or refreshes, with a new token) a pending invitation (`organization_invitations`). The admin shares the invite link (`/invite/:token`); the invitee joins there after signing in with that email and accepting. There is no email delivery yet.

## Better Auth (2026-10-21)

Replaces Clerk. Decisions (D1–D7, approved): token-bound invitation acceptance (D1); development accounts are
disposable, nothing is linked or migrated, production users are untouched (D2); passwords 12–128 characters
(D3); open sign-up (D4, **reversed 2026-10-22 by decision U2, Option 2a: public sign-up is closed**, see
below); sign-in/sign-up rate limits stored in the database (`auth_rate_limits`) so every API process shares
them (D5); sessions last 7 days and are extended once a day on use (D6); `better-auth` pinned to exactly
1.7.10 (D7).

- **Closed public sign-up (U2, Option 2a).** `AUTH_PUBLIC_SIGN_UP` (`lib/auth-config.ts`) is closed when
  unset or `closed`; `open` is accepted only outside production (tests and local development opt in) and any
  other value, or `open` with `NODE_ENV=production`, stops startup. Closed means Better Auth's
  `disableSignUp` (which also refuses server-side `auth.api.signUpEmail`) and a 404 from `authRequestGuard`
  for `POST /api/auth/sign-up/email`, before Better Auth's limiter. `GET /api/auth-policy` answers
  `{ publicSignUp }` (no-store) and the SPA shows no sign-up link or form unless it says open (it fails
  closed). Accounts come from the operator command `dist/auth-admin.mjs` (`src/auth-admin.ts`,
  `src/lib/auth-admin.ts`): `create`, `reset-password` (also ends every session) and `revoke-sessions`. It
  uses Better Auth's own internal adapter and hasher (the sign-up endpoint's sequence; no SQL carries a
  password), creates accounts unverified, generates a random 24-character temporary password and prints it
  exactly once and only to a terminal (refuses with exit 2 when stdout is not a TTY); it is never an
  argument, environment variable, log field or file. Users change it at `/account/password` (Better Auth
  `POST /api/auth/change-password`: session, trusted origin, current password, 12–128 characters, 3 per
  10 s); a `hooks.before` refuses the change unless `revokeOtherSessions` is `true` (400
  `REVOKE_OTHER_SESSIONS_REQUIRED`), so a password change always ends every other session. No mailer, no
  password reset or email verification in this release; invitations are unchanged (token + matching email).
  Linking a Better Auth account to a legacy (Clerk-era) user id is not implemented (Path B2 would add it).

- Mounting (`app.ts`): `/api/auth/*splat` after CORS and the body parsers and before the API router.
  `authRequestGuard` admits only the endpoints the SPA uses (`POST sign-in/email`, `POST sign-out`,
  `GET get-session`, `POST change-password`, and `POST sign-up/email` only while public sign-up is open;
  everything else is 404 before Better Auth, whose limiter would otherwise store a row per unknown path) and only bodies the 100 kb JSON/form parsers
  consumed (415 otherwise: Better Auth would read any "JSON-looking" content type itself, unbounded). The
  general `/api` limiter also counts these requests per client address. An empty body (`Content-Length: 0`)
  counts as no body. Right before Better Auth, `Host` and `X-Forwarded-Proto` are pinned to
  `BETTER_AUTH_URL`: better-call builds the URL it routes on from them, so a crafted Host (`x\api\auth\other?`)
  could otherwise move Better Auth to a path the guard never admitted. `onAPIError.throw` sends unexpected
  endpoint errors to the Express error handler (redacting serializers, 500 JSON) instead of better-call's
  raw `console.error`, which would print a Drizzle error's bound values (session token, password hash). One
  raw `console.error` remains inside `@better-auth/core` (a failed fallback join, e.g. the user of a
  session or the accounts of a user; its bound values are ids and limits, not tokens or hashes): native
  joins would need Drizzle relations on the `db` instance, which is defined in the Gate B-hashed
  `lib/db/src/index.ts`. The central error handler logs a failure after the response started itself and
  closes the connection (Express's default handler would print the raw stack). Every other `/api` request first resolves the session cookie
  (`resolveAuthSession`, never rejects by itself; a refreshed cookie is forwarded) and is then keyed by user.
- Configuration is strict in every environment (`lib/auth-config.ts`): `BETTER_AUTH_SECRET` (at least 32
  characters, not a placeholder, not low-entropy) and `BETTER_AUTH_URL` (a full origin; https in production)
  are required; `BETTER_AUTH_SECRETS`, `BETTER_AUTH_TRUSTED_ORIGINS` and a truthy `BETTER_AUTH_TELEMETRY` are
  refused. Trusted origins are `BETTER_AUTH_URL` plus `CORS_ALLOWED_ORIGINS`. The origin and CSRF checks are
  forced on (`NODE_ENV=test` cannot switch them off); telemetry is off.
- Cookies: `wabista.session_token` (`__Secure-` prefix and `Secure` when `BETTER_AUTH_URL` is https),
  HttpOnly, SameSite=Lax, Path=/, no Domain, no cookie cache (revocation is immediate). Sign-out also expires
  `wabista_active_org_id`.
- Unused endpoints are also listed in `disabledPaths` (social sign-in, profile/email/password changes,
  account deletion and linking, session management, token endpoints) as a second layer behind the guard.
  An invitation token is an acceptance credential (with the invited email): the request log and the error
  handler's `path` field replace it in `/api/invite-info/<token>` (case-insensitively); the SPA sends only
  its origin as Referer (`<meta name="referrer" content="strict-origin">`); the nginx example serves
  `/invite/...` and the `?invite=` sign-in/sign-up pages without logging them, adds the same
  `Referrer-Policy`, keeps `/api/invite-info/` out of the access log (its error log still records a failed
  upstream request line: restrict it like the access log) and gives `/api/auth/` a 64 KB body limit. The SPA shows a retry state, not the sign-in page,
  when the session check fails for a reason other than 401 (`lib/session-view.ts`; the public landing page
  still shows). Client IP for Better Auth comes from Express `req.ip`
  (`TRUST_PROXY`) through a private header that always overwrites a client value.
- Schema (Option H): the auth tables live in `lib/db/auth/src/index.ts`, outside the Gate B-hashed
  `lib/db/src`, and `drizzle.config.ts` loads both schema paths. A local `users` row is linked 1:1 through
  `auth_user_links`; `users.clerk_id` stays NOT NULL UNIQUE (hashed file) and new rows carry the placeholder
  `better-auth:<auth user id>`, also the race-safe insert key. This deviates from the R0 sketch
  (`users.auth_user_id` plus a nullable `clerk_id`) only to keep the Gate B hash; the guarantees are the
  same. The comments in `lib/db/src/schema/users.ts` (column name) and `organization-invitations.ts`
  (Clerk email matching) are stale and are left unedited for the same reason.
- `last_request` in `auth_rate_limits` is read in number mode: better-auth 1.7.10 only converts a JS bigint,
  and node-postgres returns int8 as a string (the Retry-After arithmetic would become string concatenation).
- Production cutover is NOT done and is planned separately in the reviewed P6 package
  (`deploy/cutover/RUNBOOK.md`, `deploy/cutover/package/`): the auth tables (additive) on the production
  database, `BETTER_AUTH_SECRET` (identical on every API process) and `BETTER_AUTH_URL` in the cell
  environment files, and a decision on existing Clerk users (U3: Path A, B1 or B2, decided only after the
  counts-only production inventory runs in the authorized pre-cutover phase).

## Replit exit (2026-10-20)

Decisions approved for leaving Replit (R0 audit; implemented in R1a and R1b):

- R-D1: retire the shared Replit WhatsApp connector (done in R1b).
- R-D2: S3-compatible storage (MinIO) for production campaign media on the dedicated servers (done in R1b: `S3MediaStore`, single PutObject below 8 MiB, multipart above, aborted on any error). Superseded for the initial launch by U4 (2026-10-22): an external S3-compatible provider, configured only through the vendor-neutral `CAMPAIGN_MEDIA_S3_*` settings; MinIO stays an alternative or later option.
- R-D3: remove the unused template-mapping image-upload route and its OpenAPI operation (done in R1b).
- R-D4: delete `artifacts/mockup-sandbox` (done in R1a).
- R-D5: `CORS_ALLOWED_ORIGINS` takes full origins only; a malformed value stops startup (R1a).
- R-D6: drop the linux-x64-only development overrides (R1a).
- R-D7: keep `attached_assets/` unchanged.
- R-D8: Node 24 preferred, minimum 22.12 (R1a: `.nvmrc`, `engines`).

## Pointers

- Workspace structure, TypeScript setup and package details: `pnpm-workspace.yaml`, `tsconfig.base.json` and `docs/DEVELOPMENT.md`
- Message Studio (V2-05B): `/campaigns/:id/message` after Audience. `GET/PUT …/message-setup` (revision-fenced, `assertSetupEditable`) stores senders in `campaign_message_setups`; routes are written only when allocator v1 can run the selection (one template per number), otherwise the selection is saved without routes and readiness explains it (multi-template per number is V2-06). Mappings are per template and component-scoped (`csv`, `static`, `media_asset`); shared defaults only fill empty slots. Campaign media lives in `campaign_media_assets` (bytes behind `CampaignMediaStore`, chosen explicitly by `CAMPAIGN_MEDIA_STORAGE`: `s3`, an S3-compatible bucket such as MinIO and the production backend, or `local` disk outside production; unset answers 503; storage errors carry fixed messages, never the endpoint, bucket or key); provider media ids are cached per asset and sending number in `campaign_media_provider_bindings`, created at planning or test send, never returned to the browser or frozen in plans. `resolveTemplateParameters` is the single resolver for send preparation, previews and test send. Test send creates no job/allocation/metric and writes one `test_send_requested` audit row. Presets (`mapping_presets`) are copied, never linked. Meta's media endpoint shape is unverified here (docs egress-blocked).
- Allocator v2 (V2-06A): `campaigns.distribution_mode` (nullable, no default) selects the allocator: null = v1 (`partitionFor` → `assignRoute` → route template, unchanged), `equal_numbers` / `equal_templates` = v2 (`campaign-allocator-v2.ts`, pure, SHA-256 per-recipient hashing with separate domains, no counters). Set only through `PUT …/message-setup` (same lifecycle/revision fence); `allocatorVersion` is derived, never writable. Under v2 one `campaign_routes` row (`shared_phone_budget = true`) is one sender lane per number; the recipient's template lives in `campaign_allocations.template_id` and `campaign_jobs.template_id`; the route `templateId` is only the lane default. Template precedence is one version-gated helper (`effectiveFrozenTemplateId`: v1 route first, v2 job first). Frozen pairs are never reassigned at runtime; live checks fail closed. Delivery modes, Preflight, Review & Launch, `launch` and `adjust-speed` are V2-06B/C.
- Delivery step (V2-06B): `/campaigns/:id/delivery` after Message; `GET/PUT …/delivery-setup` saves `distribution_mode` + `delivery_mode` (`fastest_safe` | `balanced` | `conservative` | `advanced`) + `delivery_settings.perNumberRates` under the lifecycle lock, `assertSetupEditable` and the Message Studio revision (shared, because distribution decides sender lanes), re-deriving lanes through the shared `deriveSetupRoutes`. `services/campaign-delivery.ts` is the only rate authority (ceiling = min(phone `tps_limit`, `CAMPAIGN_PLATFORM_MAX_TPS`); balanced 60%, conservative max(5, 25%) capped; advanced validated, never clamped); planning freezes the resolved rate as the lane `configuredTps` (= allocator weight = job rate); null delivery keeps route rates. `collectReadinessIssues` is the one readiness rule set (legacy strings + stable codes); `GET …/preflight` is a read-only structured report using it plus audience/distribution/speed requirements and the catalogue in `campaign-preflight-issues.ts`. Balanced is a fixed 60% in V2 (no warm-up ramp).
- Review & Launch (V2-06C): Step 4 `/campaigns/:id/review` reads the structured preflight, `GET …/review` (approximate projection) and `POST …/review/preview` (one recipient, Planning's own allocator inputs; read-only). The product action is `POST …/actions {action:"launch", scheduledAt?, timezone?}`: ONE lifecycle lock around the exported `planCampaignLocked` + `executeCampaignPlanLocked` (send now → Running) or plan + Ready → Scheduled (the runtime activation executes it when due); modern preflight must pass; retries are idempotent (`already_running`, `already_scheduled`) and a launch whose execute already began resumes the SAME plan (never re-plans). `action:"adjust-speed"` works only while Paused: the shared resolver's rate is copied onto Queued jobs; plan/allocations/in-flight work unchanged. Engineering plan/execute/schedule actions are unchanged.
