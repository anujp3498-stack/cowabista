# Wabista Nexus V2 — Implementation Plan

Status: V2-00 deliverable
Baseline: branch `wabista-nexus-v2` at `d22a8e43bf0d36d1565c011aed77486767fb8318`
Companion documents: `WABISTA_NEXUS_V2_MASTER_SPEC.md` (what), `WABISTA_NEXUS_V2_GAP_AUDIT.md` (why), `WABISTA_NEXUS_V2_UX_BLUEPRINT.md` (how it looks)

Rules that apply to every milestone:

- Work happens on `wabista-nexus-v2` (or feature branches off it). The production branch `claude/wabista-nexus-tps-regression-lqp5ap` is never modified, merged into, rebased, force-pushed or deployed by V2 work.
- Each milestone is a set of small, reviewable PRs with the commit boundaries listed. No PR mixes schema, engine and UI unless the boundary says so.
- Existing tests are not edited to pass. Known flaky gates (`.agents/memory/campaign-test-gate-known-failures.md`) are reported by name, not "fixed" by changing production behaviour.
- Every schema change is additive and applied through `lib/db` (drizzle-kit push in dev; DDL derived from the schema diff where a TTY is unavailable, per `.agents/memory/drizzle-push-non-interactive.md`).
- OpenAPI first, then codegen, then handlers, then UI.
- Nothing fake ships: a UI element without a real endpoint is hidden.
- Complexity: Small (≤ 3 PRs, one area), Medium (4–8 PRs, two areas), Large (> 8 PRs or engine-touching).

---

## 0. Recommended order and why

| Order | Milestone | Why here |
|---|---|---|
| V2-00 | Audit, spec, UX blueprint, plan | This document set |
| V2-01 | Product shell, navigation, design-system cleanup, honest data | Everything else lands on this shell; removes fake data first so nothing later is built on it |
| V2-02 | Numbers onboarding + state model (manual credential path) | Per-workspace credentials unblock real multi-tenant sending, Template Studio, eligibility and health; the manual path does not need Meta app review |
| V2-03 | Template Studio + real synchronisation | Fixes the PAUSED 500 and fake approval; provides the eligibility inputs |
| V2-04 | Sender-template compatibility model | Needs credentials (02) and real template sync (03); prerequisite for Rocket and allocator v2 |
| V2-05A | Rocket Audience | Real Audience step (sniff, append/replace, duplicates, reopen); no engine change; allocator v1 untouched |
| V2-05B | Message Studio, mappings, media, preview | Uses eligibility for selection; lifts mapping/media restrictions; still on allocator v1 (shipped with V2-05A; V2-05 complete) |
| V2-06 | Rocket Distribution + Preflight (allocator v2, delivery modes, launch) | The engine-touching milestone, isolated on purpose after the UI and eligibility exist |
| V2-07 | Flight Deck realtime | Needs per-route deltas and throughput samples; SSE requires the web/cell role split |
| V2-08 | Recovery + Export Center | Needs failure classification (added in 06/07 settlement paths) and the export job worker (web role) |
| V2-09 | Real Smart Inbox | Needs credentials (02), org-scoped webhook resolution (02), SSE (07) |
| V2-10 | Chat Manager / team routing | Builds on 09 |
| V2-11 | Contacts + Segments | Uses the global import (from 05's audience work) and inbox history (09) |
| V2-12 | Meta Control Center (Embedded Signup, health, alerts) | Signup needs Meta app configuration; health alerts need numbers (02), templates (03), webhooks (09) |
| V2-13 | Analytics V2 | Needs rollups fed by 07/09 and replies from 09 |
| V2-14 | Automations + Flows | Needs the event bus from 09/12 |
| V2-15 | White Label / SaaS polish, billing hooks, developer surface | Last; nothing depends on it |

Dependency graph (arrows = "must land before"):

```
01 → 02 → 03 → 04 → 05 → 06 → 07 → 08
              02 ─────────────→ 09 → 10 → 11 → 13
                   03,02,09 ──→ 12 → 14 → 15
```

---

## V2-00 — Deep audit, spec, UX blueprint, implementation plan

**Goal.** Establish the authoritative V2 documents without touching runtime code.
**Business value.** Shared understanding; prevents rebuilding the engine; sequences risk.
**Exact scope.** The four documents in `docs/`.
**What the user will see.** Nothing in the product.
**Backend / Frontend / DB / API impact.** None.
**Likely files.** `docs/WABISTA_NEXUS_V2_*.md`.
**Tests required.** None (validation: branch, status, diff shows only docs).
**Acceptance criteria.** Four documents exist; every "today" claim cites a file; one commit; pushed to `wabista-nexus-v2`.
**Regression risks.** None.
**Dependencies.** None.
**What must NOT change.** Any runtime, schema, config, deploy or production branch.
**Commit boundaries.** One commit: `docs: define Wabista Nexus V2 architecture and UX blueprint`.
**Complexity.** Small.

---

## V2-01 — Product shell, navigation, design-system cleanup, honest data

**Goal.** Replace the console-style shell with the V2 information architecture, shared page components and role-aware navigation; remove fake data and dead UI.

**Business value.** The product immediately feels coherent and trustworthy; every later milestone lands in its final place; no user sees demo counters or decorative controls.

**Exact scope.**
1. Sidebar with grouped IA (Home, Messaging, Grow, WhatsApp, Insights, Developer, Settings); role-filtered items; mobile bottom tab bar; `More` sheet.
2. Shared components: `PageHeader`, `StatStrip`, `ActionItem`, `TechnicalDetails`, `DataTable` (server pagination + card fallback), `statusChip`, `EmptyState` wrapper over `ui/empty.tsx`, skeleton loading rows, page-level error card.
3. `useActiveOrganization()` hook; one `apiError` helper; theme toggle (system/light/dark); remove Inter font, `maximum-scale=1`, PRO pill, dark hero blocks.
4. Honest data: stop seeding sample rows (`seedDemoData` no longer called); one-time cleanup script/endpoint that deletes `is_sample` rows (contacts, phones, templates, campaigns, routes, sample WABA) for existing workspaces; Home replaces Overview with real tiles only (fix the `Active` status bug); remove `activityFeed`, "DEMO PIPELINE" copy, header search and bell; unlink Inbox, Automations, Billing, API pages (routes remain, render an honest "not available in this release" state).
5. Campaign list with server pagination and search; remove counter/status inputs from the campaign form; campaign detail page skeleton with tabs (Flight Deck = existing monitoring panel moved; Messages = existing messages dialog content; Details = existing plan dialog content; Recovery/Export tabs show honest empty states until 08).
6. Old routes redirect: `/overview→/`, `/rocket-campaigns→/campaigns`, `/phone-numbers→/numbers`, `/integrations→/numbers`, `/suppressions→/contacts/do-not-contact`.
7. Docs: fix `replit.md` stale statements.

**What the user will see.** New navigation, Home with real numbers and quick actions, campaign list and detail pages, no fake pages, consistent headers, loading skeletons, dark mode.

**Backend impact.** `GET /campaigns` gains `cursor/limit/search/status` (paged envelope; keep the bare-array response behind `?legacy=1` for one release or add a new `GET /campaigns/list`); `GET /home` (today counts from existing `campaign_metrics`, running campaigns from monitoring, numbers needing attention from `status != Connected`); `POST /organizations/:id/remove-sample-data`; overview bug fix.

**Frontend impact.** Shell rewrite, 15 page headers, campaigns list/detail, home.

**DB impact.** None required. Optional: nothing.

**API changes.** As above; OpenAPI + codegen.

**Likely files.** `ui/components/layout/shell.tsx`, `ui/App.tsx`, `ui/index.css`, `ui/index.html`, `ui/pages/home.tsx` (new dashboard), `ui/pages/campaigns.tsx`, new `ui/pages/campaign-detail.tsx`, `ui/components/app/*` (new), `ui/hooks/use-active-organization.ts`, `api/routes/campaigns.ts`, `api/routes/overview.ts` (→ `home.ts`), `api/routes/organizations.ts`, `api/lib/orgProvisioning.ts`, `lib/api-spec/openapi.yaml`, `replit.md`.

**Tests required.** API: campaigns pagination/search; home summary; sample cleanup (org-scoped, cross-tenant case). Frontend: Playwright smoke for navigation by role; component tests for `DataTable` card fallback and `statusChip`.

**Acceptance criteria.**
- A new workspace shows an onboarding checklist and zero counters, no sample rows.
- Every sidebar item leads to a real page; hidden pages are not linked.
- Campaign list paginates server-side; a campaign opens as a page with tabs.
- No `mock-data.ts` import remains anywhere (file deleted).
- Typecheck and the existing test chain pass.

**Regression risks.** Removing sample seeding changes first-login state (tests that rely on seeded rows must set up their own fixtures; check `orgProvisioning` consumers). Route redirects must keep the e2e workspace-switch spec green.

**Dependencies.** V2-00.

**What must NOT change.** Any engine service; lifecycle endpoints; the cookie-resolved org switch with hard reload.

**Commit boundaries.** (1) design tokens + shared components; (2) shell + navigation + redirects; (3) home endpoint + page; (4) campaigns list pagination + detail page; (5) sample-data removal + cleanup endpoint; (6) delete mock pages/data + docs.

**Complexity.** Medium.

---

## V2-02 — Numbers onboarding + state model (manual credential path)

**Goal.** Per-workspace WhatsApp credentials, discovery from phone number + access token, the number setup state machine with verification and registration performed by the backend, and a Number Center that never asks for IDs.

**Business value.** Any workspace can connect real numbers (today only one workspace in the deployment can); non-technical users complete registration in-app; the throughput cap bug is fixed so HIGH-tier numbers can reach 1000.

**Exact scope.**
1. `whatsapp_credentials` table with envelope encryption; kinds `system_user`, `replit_connector` (migration row for the current real workspace).
2. Provider client factory keyed by credential; `RealWhatsAppProviderClient` takes a token source; the Replit connector path implemented as one token source. All call sites (`whatsapp-sync.ts`, `whatsapp-integration.ts`, `whatsapp-template-sender.ts`) resolve the client through the factory. Real-mode claim check in the sender changes from "connector identity matches" to "credential active and WABA belongs to credential".
3. Discovery endpoint (`POST /whatsapp/discover`): token check, business/WABA enumeration, phone match, WABA choice fallback.
4. Number state machine columns and transitions; endpoints `request-code`, `verify-code`, `register`, `sync`, `disconnect`; sync fetches `throughput`, `name_status`, `messaging_limit_tier`, `status`, `platform_type`.
5. Remove `status`, `quality`, `provider`, `tpsLimit` from the number create/update API (tpsLimit stays readable; it is derived from the approved cap and delivery mode later).
6. Webhook STOP tenant resolution becomes org-scoped through the number's credential/WABA.
7. Number Center UI with Connect Number dialog (Connect with Meta shown as "coming soon" but disabled and unlinked until 12; Connect manually real), Complete Setup flow with OTP and PIN screens, Technical Details drawer.
8. Drop the "one real workspace" partial unique indexes once no code depends on `connectorAccountId`.

**What the user will see.** Numbers page with status cards, "Connect Number → Connect manually → phone + token → discovered → Complete setup (verify / PIN) → Connected".

**Backend impact.** New credential service; provider factory; number setup service with Graph calls; sync extension; webhook resolution fix.

**Frontend impact.** Number Center, Connect dialog, setup stepper (uses `ui/input-otp.tsx`).

**DB impact.** `whatsapp_credentials`; `phone_numbers` + `setup_state`, `setup_error`, `name_status`, `messaging_limit_tier`, `throughput_level`, `platform_type`, `last_health_at`, `credential_id`; `wabas.credential_id`; `provider_connections` keeps `mode`; indexes dropped at the end.

**API changes.** `POST /whatsapp/credentials` (from token), `GET /whatsapp/credentials` (status only), `DELETE …`; `POST /whatsapp/discover`; `POST /phone-numbers/connect`; `POST /phone-numbers/:id/request-code|verify-code|register|sync|disconnect`; number schema changes.

**Likely files.** `api/services/whatsapp-provider.ts`, new `api/services/whatsapp-credentials.ts`, new `api/services/whatsapp-number-setup.ts`, `api/services/whatsapp-sync.ts`, `api/routes/phone-numbers.ts`, `api/routes/whatsapp-integration.ts`, `api/services/whatsapp-template-sender.ts:280-310`, `api/services/whatsapp-webhook.ts:127-140`, `db/provider-integration.ts`, `db/phone-numbers.ts`, new `db/whatsapp-credentials.ts`, `ui/pages/numbers.tsx`, `ui/components/numbers/*`.

**Tests required.** Credential encryption round-trip; factory selects the right client per credential; discovery with mocked Graph responses (one WABA, many WABAs, none); state transitions with mocked `request_code/verify_code/register` including error paths; sync writes `throughput_level` and rewrites metadata every sync (extend `phone-number-tps-ceiling.test.ts`); sender real-mode check with credential; STOP resolution org-scoped (extend `campaign-suppression.test.ts`); cross-tenant cases for credentials and number actions; Playwright: connect manually in mock mode.

**Acceptance criteria.**
- Two workspaces can each hold a real credential and send (integration test with the mock client per credential).
- A number can be taken from Discovered to Connected entirely in the UI against a Graph mock.
- No form asks for WABA ID, Phone Number ID, Business ID, App ID, System User ID or Webhook ID in the normal path.
- Existing sender tests (`campaign-send-template-fidelity`, `campaign-multi-template-send-fidelity`, `campaign-provider-duplicate-send-guard`) pass unchanged.

**Regression risks.** The sender's real-mode gate and the sync upsert are on the send path; a factory bug would fail every real send. Mitigate with the adapter approach and feature flag `WHATSAPP_CREDENTIALS_V2=off` defaulting to the old connector for one release.

**Dependencies.** V2-01 (shell).

**What must NOT change.** Send payload builder, request-key idempotency, suppression fencing, webhook status processing, claim/settlement.

**Commit boundaries.** (1) credentials table + encryption + factory with connector adapter (no behaviour change); (2) migrate call sites behind the flag; (3) discovery service + endpoint; (4) state machine columns + setup endpoints; (5) sync field extension + tps cap fix; (6) number API schema cleanup + webhook org scoping; (7) Number Center UI; (8) drop legacy indexes + docs.

**Complexity.** Large.

**Progress (V2-02A, shipped).** Delivered the credential foundation and manual discovery as the first slice of this milestone: `whatsapp_credentials` (AES-256-GCM, org-bound AAD, key from `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY`, fails closed), `wabas.credential_id`, `phone_numbers.setup_state/setup_error/credential_id`, a direct token-backed Meta client (`whatsapp-manual-client.ts`, discovery only, no send), `POST /organizations/:id/whatsapp/manual/connect` with the structured `waba_id_required` outcome, credential list/revoke endpoints, and the Number Center redesign with the Connect dialog. Deliberately NOT done yet: OTP/verify/register (V2-02B), binding workspace credentials into the sending transport (V2-02C: the sender and transport worker still use the shared connector), the Replit-connector migration row, dropping the one-real-workspace indexes, and the number create/update API cleanup (item 5).

**Progress (V2-02B, shipped).** Guided setup for manually discovered numbers: `POST …/whatsapp/numbers/:id/verification/request` (SMS or VOICE, locale default en_US), `…/verification/verify` and `…/register`, all owner/admin only, credential resolved server-side from the phone row and decrypted only for the single Meta call. `ManualMetaClient` gained management-only POST helpers (`requestVerificationCode`, `verifyCode`, `registerPhone`, `getPhoneNumber`) that fail closed unless Meta answers `{success: true}`. Setup states: `discovered → verification_code_sent → registration_required → registered_transport_pending`, with `action_required` as a side state; transitions are persisted under a per-phone advisory lock (`whatsapp-phone-setup:<org>:<phoneId>`) with a monotonic rank so a late provider response can never regress a row. Numbers whose persisted Meta `verificationStatus` is VERIFIED skip straight to registration. The verification code and the registration PIN are never persisted, logged or echoed. **Successful registration does not change the engine-facing `status`:** a new manual number stays Pending (`registered_transport_pending`, shown as "Registered · Sending activation pending") and a legacy Connected number keeps Connected. Not done: `/deregister`, two-step PIN management, data-localization/migration handling (a Meta register error for those surfaces as a redacted `setupError`), `sync` field extension, number API cleanup, connector migration row, index drops.

**Progress (V2-02C, shipped).** Workspace credentials now reach the proven transport. Schema: `phone_numbers.sending_credential_id` (the credential campaign transport MUST use; distinct from `credential_id`, which only records discovery/setup) and `whatsapp_credentials.revision`. `POST …/whatsapp/numbers/:id/activate-sending` (owner/admin) validates registration, credential/WABA ownership, decryptability and a read-only Meta phone lookup, then under the phone setup lock sets `sendingCredentialId`, `status = Connected`, `setupState = active`. Planning freezes `sendingCredentialId` per route (never a token); readiness refuses an inactive sending credential or a WABA not linked to it. Send preparation (`whatsapp-template-sender.ts`) resolves credential state and WABA linkage set-based per batch and emits a non-secret `transportAuth` reference (`{kind: "workspace_credential", organizationId, credentialId, credentialRevision}`); legacy routes keep `{kind: "legacy_connector"}` and the unchanged connector path. Credential resolution and decryption happen only in the main process (`whatsapp-transport-credentials.ts`) at lane setup: the reservoir binds the credential to the phone's deterministic shard through a dedicated `credential-bind` control message and waits for `credential-bound` before the lane exists; the worker keeps `Map<phoneId, binding>` in memory, clears it on `ownership-revoked`, and sends directly to Graph `v23.0/{phone}/messages` with the token only in the Authorization header (`whatsapp-direct-sender.ts`). Steady state adds no DB query, decrypt or control round trip per message. Reservoir discovery now requires `phone_numbers.status = 'Connected'`; revocation flips sending phones to Pending/action_required and clears `sendingCredentialId` in one transaction, so the next discovery drops the lane, revokes shard ownership and clears the binding; broker adoption re-validates phone status, live sending credential, credential activity and revision. Failover re-binds on the new runtime; delivery_unknown, pacing, fencing and settlement are untouched. Not done: Template Studio (V2-03), sender-template compatibility (V2-04), a control-plane reconciler that marks a number action_required after a code-190 send failure (the worker returns a permanent provider failure; settlement is unchanged), `/deregister`, the connector migration row, index drops.



---

## V2-03 — Template Studio + real synchronisation

**Goal.** Templates reflect Meta truth: real statuses, rejection reasons, per-credential sync, create/submit/delete to Meta, drafts, no fake approval.

**Business value.** Campaigns stop failing on paused/rejected templates; users can author and submit templates without the Meta console; the list endpoint stops breaking on PAUSED.

**Exact scope.**
1. Widen `templates.status` handling and the API enum to Meta's set; add `rejected_reason`, `quality_score`, `source`, `deleted_at`; `waba_id NOT NULL` for `source = meta`.
2. Remove `status` from create/update APIs; local templates get `source = local` and are ineligible for real senders.
3. Sync per credential/WABA with `rejected_reason`, `quality_score`; mark missing templates deleted.
4. Handle `message_template_status_update` webhook events.
5. Create/submit (`POST /{waba}/message_templates`), delete, clone; resumable upload for media header samples; drafts table.
6. Template Studio UI: Meta Templates list/drawer with WhatsApp-style preview, Drafts editor, Library tab (empty until 15 except workspace-saved items).
7. Preview component shared with Rocket (renders components + sample values).

**What the user will see.** Template Studio with real statuses, reasons, "Available on N numbers" (populated fully in 04), Create Template → Draft → Submit.

**Backend impact.** Sync changes; new template service; webhook handler; draft CRUD.

**Frontend impact.** Template Studio pages; preview component.

**DB impact.** `templates` columns; `template_drafts`; `template_library_items` (schema only).

**API changes.** Status enum widened; `POST /templates/drafts`, `POST /templates/drafts/:id/submit`, `DELETE /templates/:id` (to Meta when `source = meta`), `POST /templates/:id/clone`; `POST /templates/sync`.

**Likely files.** `api/services/whatsapp-sync.ts`, `api/services/whatsapp-provider.ts` (template create/delete, media upload), new `api/services/template-studio.ts`, `api/routes/templates.ts`, `api/services/whatsapp-webhook.ts`, `db/templates.ts`, `ui/pages/templates.tsx` (→ studio), `ui/components/templates/*`.

**Tests required.** Sync with PAUSED/DISABLED/IN_APPEAL fixtures (list endpoint no longer 500s); status webhook idempotency; create/submit with Graph mocks; clone; draft validation (variables sequential, sample values); the send-time gate accepts only Meta-sendable statuses; frozen-template-mutation tests unchanged.

**Acceptance criteria.**
- No UI or API path can set a template to Approved locally.
- A PAUSED template shows "Paused by Meta" and is unselectable in Rocket.
- A draft can be submitted and its status arrives via sync or webhook.

**Regression risks.** The send-time approval gate string check (`status !== "Approved"`) must be replaced by a sendable-status set carefully; Rocket setup's Approved filter likewise.

**Dependencies.** V2-02 (credentials).

**What must NOT change.** `templatesSnapshot` freezing; `describeTemplate` requirement keys (extend, don't rename).

**Commit boundaries.** (1) status enum + columns + sync fields; (2) remove local status writes + `source`; (3) webhook handler; (4) create/submit/delete/clone; (5) drafts; (6) Studio UI; (7) preview component.

**Complexity.** Medium.

**Progress (V2-03A, shipped).** Per-workspace template synchronisation. `ManualMetaClient.listTemplates` follows every Graph page of `/{waba}/message_templates` (same field list as the connector client). `whatsapp-template-sync.ts` syncs each WABA whose `credentialId` points at an active workspace credential: resolve and decrypt in the main process, fetch the complete listing, then one short transaction under `whatsapp-template-sync:<org>:<wabaId>` that re-checks the association, upserts on `(organization_id, provider_template_id)` with the faithful `components` snapshot and the raw provider status in `metadata.providerStatus`, and marks previously synced rows Meta no longer returns as `status = "Removed"` (`metadata.providerMissing`, `statusBeforeRemoval`) instead of deleting them. A WABA without a credential keeps the legacy `syncWhatsApp` connector path; the two are never substituted. `POST …/whatsapp/templates/sync` (owner/admin, no body) reports per WABA and continues past failures. `GET /templates` gained optional filters and returns WABA, source, provider status and missing flags; its status is now a free string (Paused/Disabled rows previously violated the enum). Template Center rebuilt: Sync templates as primary CTA, read-only provider status, sample rows hidden, preview with header/body/footer/buttons and variables, IDs under Technical details; Rocket no longer offers sample templates. Hardening (V2-03A.1): `TemplateInput`/`TemplateUpdate` no longer carry `status`; POST creates a Pending local row (`metadata.source = "local"`) and PATCH answers 409 for any provider-backed row (provider id or synced source) and only edits name/body/category/language on local rows. `listTemplates` fails closed on a missing cursor, a repeated cursor, the page cap with pages remaining, or a malformed row, so a partial listing can never mark templates Removed. Before committing a sync the transaction re-reads the WABA association and the credential (organization, kind, provider, active, revision captured before the fetch) and refuses the snapshot if any changed. Hardening (V2-03A.2, concurrency): **Sync ordering.** Each WABA sync reserves `wabas.template_sync_generation + 1` in one statement before its provider fetch; the apply transaction (advisory `whatsapp-template-sync:<org>:<wabaId>`, then credential row `FOR SHARE`, then WABA row `FOR UPDATE`, then templates) applies only if `template_sync_applied_generation` is not higher than its own generation and then advances it. The rule is "never overwrite a newer *applied* snapshot", not latest-started-wins: a failed newer request leaves an older valid snapshot free to apply; a superseded sync reports `status: superseded` with nothing written. `lastSyncedAt` is not an ordering token. The legacy connector sync refuses a WABA that carries a workspace credential. **Credential window.** The credential is read `FOR SHARE` and the WABA `FOR UPDATE` inside the apply transaction, so `revokeCredential` (an UPDATE of the credential row) and `connectManualNumber` (credential row, then WABA row) either commit before the sync revalidates, in which case the sync fails, or wait until the sync commits; a validated snapshot can no longer commit after a revocation. Lock order everywhere: advisory locks, credential row, WABA row, phone/template rows. **Template CRUD.** PATCH and DELETE run in one transaction with the row locked `FOR UPDATE` and the organization in every predicate; provider-backed rows answer 409 `provider_backed`; DELETE refuses rows referenced by selections, mappings, routes, jobs or allocations with 409 `referenced` and the counts, and the row lock blocks the KEY SHARE every FK insert takes, so a concurrent reference cannot slip past the check. Only unreferenced local rows can be deleted. Remaining limit: the apply hook `hooks.beforeApply` exists only for tests and is never reachable from HTTP. Not done: template creation/submission (V2-03B), compatibility routing (V2-04), per-template sync, local draft editing.

**Progress (V2-03B, shipped).** Template drafts, authoring, media examples and submission through workspace credentials. **Storage.** New tables `template_drafts` (organization-scoped; `content` jsonb with header / body + examples / footer / buttons; `revision` for optimistic concurrency; `state` draft → submitting → submitted | failed | reconcile_required; `provider_template_id`, `provider_status`, `provider_status_checked_at`, `template_id` link to the synced row; unique `(organization_id, waba_id, name, language)`), `template_submission_attempts` (the immutable provider request body per attempt, `state` requested | succeeded | failed | uncertain, provider reply fields, `reconcile_note`; partial unique index `template_submission_attempts_active_uq` on `draft_id` where state in (requested, uncertain) so the database, not process memory, allows at most one active attempt) and `template_media_uploads` (Resumable Upload sessions; the provider handle is stored server-side only and never serialised). Drafts are never rows in `templates`; sync never creates drafts. **API** (`routes/template-drafts.ts`, contract in `openapi.yaml`): `GET …/template-authoring/wabas` (credential-backed WABAs with `authoringSupported`; the legacy connector WABA is listed with a reason and is not usable), `GET/POST …/template-drafts` (keyset paging), `GET/PATCH/DELETE …/template-drafts/:id` (PATCH and submit require `expectedRevision`; stale → 409 `stale_revision`; a submitting/submitted/reconcile_required draft refuses edits with 409), `POST …/:id/submit`, `POST …/:id/reconcile` (optional `discardUnconfirmed`), `POST …/:id/refresh-status`, `POST …/template-media` (raw body, bounded). Reads need membership; every write runs through `requireRole("admin")` (owner/admin) server-side. Error bodies carry a stable `code` and per-field `fields`. **Validation** (`template-authoring.ts`): MARKETING/UTILITY only; name `^[a-z0-9_]+$`; header text ≤ 60 with at most `{{1}}` + example, or image/video/document with an uploaded example; body ≤ 1024 with sequential `{{n}}` each needing an example; footer ≤ 60, no variables; ≤ 10 buttons, ≤ 2 URL (one trailing `{{1}}` + example), ≤ 1 phone (E.164), quick replies grouped. Incomplete drafts save; submission validates for completeness. `buildTemplateCreatePayload` is the single place the provider body is built (HEADER `example.header_text` / `example.header_handle`, BODY `example.body_text`, FOOTER, BUTTONS QUICK_REPLY / URL with `example` / PHONE_NUMBER). **Media** (`template-media.ts`): bytes come only from the authenticated request body (no remote URL fetching); JPEG/PNG ≤ 5 MB, MP4 ≤ 16 MB, PDF ≤ 16 MB; requires the server setting `WHATSAPP_APP_ID` (otherwise 503 `media_not_configured` with an actionable message, `mediaSupported: false` on the WABA options, and text-only authoring stays usable); session `POST /{app-id}/uploads?file_length&file_type&file_name` with Bearer, then `POST /{session-id}` with `Authorization: OAuth`, `file_offset: 0` and the bytes, single chunk; the WABA and its credential must belong to the organization; a draft may reference an upload only of the same organization, same WABA and same kind; a conservative 30-day local expiry blocks submission with a field error. **Submission** (`template-submission.ts`): tx1 under the WABA's advisory lock (credential `FOR SHARE`, WABA `FOR SHARE`, draft `FOR UPDATE`) validates, builds the payload, inserts the attempt (`requested`) and moves the draft to `submitting`; commit; the WABA→credential binding is re-read, the credential decrypted and `POST /{waba}/message_templates` sent exactly once outside any transaction; tx2 locks the attempt and records the outcome: confirmed `id` → `succeeded`/`submitted` with Meta's status; definitive 4xx → `failed` (draft editable again, history kept; code 190/401 → `credential_inactive`); timeout, network error, 5xx or a reply without an id → `uncertain`/`reconcile_required`. Meta documents no idempotency key for template creation, so an uncertain attempt is never retried automatically; two concurrent submits produce one POST and the loser receives the existing attempt. After a confirmed creation the hardened per-WABA sync runs and the draft is linked to the synced row. **Reconciliation** reads `GET /{waba}/message_templates?name=` and links a template only when name, language, body text and button count match the recorded payload; a same-name template with different content or language is reported in `reconcile_note` and never attached; with nothing at Meta the attempt stays uncertain until the person chooses "Discard if not at Meta", which marks it failed and makes the draft editable. An attempt still `requested` after `STALE_REQUESTED_MS` (2 min, the crash window) may be reconciled the same way; a younger one answers `attempt_in_progress`. A late provider outcome arriving after reconciliation settled the attempt is noted, not applied. **Status refresh** is one bounded `GET /{template-id}` that updates the draft and the synced row; approval is never set locally. **UI.** Template Center has tabs Meta templates · Drafts. Drafts tab: keyset "Load more", state chips (Draft / Submitting to Meta / Submitted / Refused by Meta / Outcome unknown), Meta's status chip next to submitted drafts, Edit/View/Delete, Refresh status, Reconcile (with explicit "Discard if not at Meta"), polling every 5 s only while a submission is in flight and the tab is visible. Editor dialog: name, language, category, business account chosen by internal id from the server's options (legacy/inactive shown disabled with the reason), header kind (media kinds disabled until `WHATSAPP_APP_ID` is set), header example, body with one example per variable, footer, quick-reply/URL/call buttons, inline field errors from the server, live preview through the shared `TemplatePreview` (also used by the Meta template dialog) plus a "with your examples" preview, Save draft and a separate Submit to Meta; every write carries the loaded revision and a conflict is explained; mobile shows the preview with "Edit on desktop". Sync toast fixed: a superseded WABA is reported as "Already up to date", never counted as a synced account, so "0 templates from 0 accounts" no longer appears as success. **Config.** `WHATSAPP_APP_ID` (Meta app id the workspace tokens were issued for) enables media examples. **Meta documentation.** The developer docs could not be fetched from this environment (egress blocked); payload shapes follow the documented Business Management API and Resumable Upload API and must be verified against https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/ , …/message-templates/components and https://developers.facebook.com/docs/graph-api/guides/upload/ before production use. Assumptions recorded in `template-authoring.ts` and `template-media.ts`. **Tests.** `template-drafts.test.ts` (validation, payload exactness, CRUD, paging, tenant isolation, WABA eligibility, incomplete save vs refused submit, stale revision, edit/delete during submission, submitted never locally Approved, HTTP 401 through the real app, handler-level role check, secret-free responses, static UI assertions), `template-submission.test.ts` (one POST with the exact payload, definitive refusal, timeout after acceptance → reconcile links by evidence, network/5xx/malformed → uncertain → discard, name conflict never linked, two concurrent submits → one POST, partial unique index, crash-window reconciliation, credential revoked / WABA re-associated before the request → no POST, status refresh, sync interaction), `template-media.test.ts` (two-step upload with OAuth header and server-side handle, bounds, missing config, cross-tenant/cross-WABA/kind mismatch, expired upload, provider failures). Remaining V2-03 items (not done): provider-side template deletion and clone, editing an existing provider template, `message_template_status_update` webhook handling (status arrives via sync or refresh only), `rejected_reason`/`quality_score` columns, the Library tab and `template_library_items`, carousel/authentication/catalog template types, multi-chunk uploads, a sweeper for expired media uploads, sender-template compatibility (V2-04).

**Progress (V2-03B safety correction, shipped).** Five failure modes corrected. **Status refresh is the sync.** `refresh-status` no longer reads one template and writes `templates.status` on its own; it calls `syncWabaTemplates` for the draft's WABA (generation reserved before the fetch, complete bounded listing outside any transaction, credential organization/kind/provider/activity/revision and WABA association revalidated under `FOR SHARE`/`FOR UPDATE`, apply only if no newer generation was applied, missing templates marked Removed with `providerMissing`/`statusBeforeRemoval`). The draft then shows the APPLIED row's status: serialisation derives `providerStatus`/`providerStatusCheckedAt` from the linked `templates` row whenever one exists, so a regular sync that pauses or removes the template is reflected without any draft write. A failed sync answers its mapped error; a superseded one answers 409 `sync_superseded` and the draft already shows the newer result. Tests: delayed Approved listing versus a newer applied Removed and Paused snapshot (the stale refresh is reported superseded; status, raw provider status and removal metadata stay consistent), credential revoked while the refresh's listing is in flight (fails closed, nothing written). **Lock order.** The submission claim now takes the advisory WABA lock, then the credential row `FOR SHARE`, then the WABA row `FOR SHARE`, then the draft `FOR UPDATE`: the same order as the sync apply transaction and compatible with `connectManualNumber` (credential row, then WABA row) and `revokeCredential` (credential row, then phones). An unlocked lookup identifies the WABA and credential; the association is re-checked after the locks are held. Test: a reconnect (`connectManualNumber`, same token) and a revocation started while the claim holds its locks both finish without deadlock; the attempt keeps the credential that was active at the claim, and a revocation that wins before the request means no POST. Locks are never held across the Meta request. **Reconciliation evidence** (`compareTemplateEvidence`): exact name and language, same component sequence and types, header format and text (TEXT), body and footer text, and every button's position, type, label and URL or phone destination (phone compared by digits only). Examples and category are ignored (Meta omits examples from listings and may reassign the category). Missing or malformed data is "insufficient", never a match. A media header is compared by format only and the link note states that the media bytes could not be compared. One exact match links; several matches, a match beside an incomparable row, a mismatch or an empty listing leave the attempt unresolved with the reason recorded. `findTemplatesByName` reuses the full listing's complete, bounded, fail-closed pagination (cursor checks, page cap, malformed-row refusal); a broken listing answers 502 `provider_unavailable` and changes nothing. **Unknown outcomes stay unknown.** `discardUnconfirmed` is gone from the API and UI: an empty listing, incomparable evidence or an elapsed timeout never proves the POST failed, so an uncertain attempt is never converted into a retryable failure. Such a draft cannot be edited, deleted or resubmitted; the drafts unique index `(organization_id, waba_id, name, language)` also blocks an identical submission under a new draft. Reconciliation is fenced by attempt identity: the request names the `attemptId`, a newer attempt answers 409 `stale_attempt`, and a settled attempt converges idempotently (concurrent reconciliations end on one linked template, no second provider request afterwards). **Late evidence and fencing.** Before its POST a submit re-reads its attempt without locks and makes no request if a reconciliation already settled or re-examined it (stalled submit resumed after reconciliation: no POST, reconciled state stands). `recordOutcome` never overwrites a settled attempt: a late outcome is persisted in `late_provider_template_id`, `late_outcome`, `late_outcome_at` and the note, except that a confirmed provider id still settles an attempt that is merely uncertain (that is the missing proof). The boundary is stated honestly: the fence is a local check followed by an HTTP call, so a process that passes the check and stalls can still POST later; Meta offers no idempotency key, so exactly-once creation is not promised, only that such a POST is recorded as late evidence and never duplicated by a second local attempt. **Contracts.** `revision` is the content revision (PATCH only); submit carries `expectedRevision`; reconcile carries `attemptId`; refresh-status carries nothing and never changes the revision; DELETE accepts `expectedRevision` (409 `stale_revision` on mismatch) and is refused for submitting/reconcile_required drafts. Deleting a draft detaches its attempts (`draft_id` set null) instead of erasing them: organization, WABA, payload and provider outcome stay as evidence. Every draft/attempt mutation carries the organization in its predicate. **Meta contract verification.** `developers.facebook.com` and Postman remain egress-blocked. Verified from Meta's official Python Business SDK on GitHub (generated from the Graph API spec, `facebook_business/adobjects/whatsappbusinessaccount.py` and `application.py`): `POST /{waba-id}/message_templates` accepts `name`, `language`, `category` (AUTHENTICATION/MARKETING/UTILITY), `components` (list of maps) and `allow_category_change`; `GET /{waba-id}/message_templates` accepts `name`, `status`, `language`, `category` filters; `POST /{app-id}/uploads` accepts `file_length`, `file_name`, `file_type`, `session_type`. Still unverified: the chunk upload request to `POST /{upload-session-id}` (the `Authorization: OAuth <token>` header form, the `file_offset` header, the `{ "h": ... }` reply), the handle lifetime, whether the `name` filter is exact or prefix (the code compares the name again, so either works), and the exact `{ id, status, category }` shape of the creation reply. These remain a release limitation to confirm against the live documentation before the first production submission.

---

## V2-04 — Sender-template compatibility model

**Goal.** A first-class eligibility model (sender → templates, template → senders) enforced in UI, preflight, planning and before send.

**Business value.** Eliminates avoidable "template does not exist" failures and makes N × M campaigns safe.

**Exact scope.**
1. `template_eligibility` table populated by sync and template webhooks; backfill from `waba_id` pairs.
2. `GET /whatsapp/compatibility?numberIds&templateIds` and `GET /campaigns/:id/compatibility` returning the matrix and problems.
3. Preflight/readiness: remove the null-WABA bypass; add "sender has no eligible template" and "template has no eligible sender" blockers.
4. Rocket setup and route endpoints validate against eligibility instead of raw `wabaId` equality.
5. Prepare step: WABA match check in all modes (not only real).
6. Frozen route JSON gains `wabaExternalId`, `eligibleTemplateIds`, `eligibilityVerifiedAt`, `eligibilitySource` (additive; allocator unchanged).
7. Number Center and Template Studio show "Available on / Can send" lists.

**What the user will see.** Template cards say which numbers can send them; number cards say how many templates; Rocket (in 05) disables incompatible choices.

**Backend impact.** Eligibility service; preflight rules; setup validation.

**Frontend impact.** Availability lists; compatibility matrix component (used in 05).

**DB impact.** `template_eligibility`; `campaign_routes.waba_id` (denormalised, validated).

**API changes.** Compatibility endpoints; preflight blockers; plan summary fields.

**Likely files.** new `api/services/template-eligibility.ts`, `api/services/campaign-preflight.ts:33-50`, `api/routes/campaign-routes.ts:124-133, 366-399`, `api/services/campaign-planning.ts:133-161`, `api/services/whatsapp-template-sender.ts:302-304`, `api/services/whatsapp-sync.ts`, `db/campaign-engine.ts` (new table), `ui/components/campaigns/compatibility-matrix.tsx`.

**Tests required.** Eligibility backfill; matrix endpoint; preflight blockers (X has TX1/TX2, Y has TY1, Z has TZ1/TZ2 fixture: Y→TX1 impossible); setup rejects incompatible pairs; planning snapshot includes evidence; sender rejects mismatch in mock mode; cross-tenant.

**Acceptance criteria.** With the X/Y/Z fixture, no endpoint can produce a Y→TX1 route or plan; the matrix endpoint returns exactly the eligible pairs.

**Regression risks.** Preflight becomes stricter: existing campaigns with null-WABA local templates in mock mode need `source = local` templates to be eligible for local/test numbers only. Provide that rule explicitly.

**Dependencies.** V2-02, V2-03.

**What must NOT change.** Allocation algorithm (still v1); job/lease semantics.

**Commit boundaries.** (1) table + backfill + sync population; (2) compatibility endpoints; (3) preflight + setup validation; (4) sender check in all modes; (5) frozen evidence fields; (6) UI availability lists.

**Progress (V2-04, shipped).** One shared, tenant-scoped eligibility decision (`template-eligibility.ts`: `decidePair` on already-loaded state, `loadCompatibilityState` batched loader, `buildCompatibilityMatrix`, `pairSendersToTemplates`, `recordAppliedTemplateEvidence`, `backfillTemplateEligibility`) now answers every sender-template question for route create/update (`assertOwnedByOrg`), Rocket setup, readiness/preflight (`validateCampaignReady`), planning (`planCampaignLocked`), the two compatibility endpoints and send preparation (`prepareBatch`, final gate after the transport checks, every mode). **The model.** A. Identity: a template id is the exact synced row of its WABA; a phone belongs to a WABA; nothing is inferred from name/language/body (a logical template family across WABAs is future work, not built). B. Transport: `workspace_credential` (phone has `sendingCredentialId`), `legacy_connector` (no credential, connection mode real) or `local_mock` (no credential, connection mode mock). C. State: provider evidence (`template_eligibility`) plus LIVE phone, WABA and credential state; cached evidence never outranks live state. D. Campaign rules stay in preflight (selection, mappings, header kinds, imports, per-route and aggregate per-phone TPS). Workspace-credential rule: phone Connected, non-sample, with provider phone id and a tenant WABA whose `credentialId` equals the phone's active, tenant-owned sending credential (credential state reused from `loadSendingCredentialStates`, never decrypted for a matrix); template non-sample, provider-backed (`providerTemplateId`), Approved, not provider-missing/Removed, with a `sendable` evidence row for the same WABA; same WABA by internal id. Legacy real connector: both sides on the claimed WABA (`configuredWabaExternalId`), provider-backed Approved template; a workspace-credential WABA never goes through the shared connector (transport is decided by the phone's credential first). Local/mock exception, explicit and isolated: mock connection AND no sending credential; local (non-provider) templates and unbound test numbers may pair when their WABA references agree (both null counts only here); a null WABA on one side alone is `waba_mismatch`; the branch is unreachable for a credential or real-connector transport. Stable reason codes: `eligible`, `eligible_local_mock`, `not_found`, `phone_sample`, `phone_not_connected`, `phone_no_provider_identity`, `phone_no_waba`, `credential_inactive`, `credential_unbound`, `legacy_waba_not_claimed`, `template_sample`, `template_not_provider_backed`, `template_not_approved`, `template_removed`, `evidence_missing`, `evidence_not_sendable`, `waba_mismatch`. **Evidence storage.** `template_eligibility` has one row per provider-backed template (unique `(organization_id, template_id)`, index `(organization_id, waba_id, sendable)`), never a phone x template materialisation: a phone's compatibility is derived at read time from its WABA and live state, so the table is O(templates) and live invalidation is structural (revoked credential, disconnected phone, Paused/Removed templates row). Columns: `waba_id`, `provider_template_id`, raw `provider_status`, normalised `status`, `provider_missing`, `sendable` (present at Meta and Approved), `evidence_source` (`workspace_credential` | `legacy_connector` | `backfill`), `verified_at`, `sync_generation`, `credential_id`. Written only inside an APPLIED sync transaction (credential sync: after generation ordering and credential/WABA revalidation under the row locks, with the generation and credential id; legacy sync: same transaction as its upsert) and by the backfill; templates the listing no longer returns lose `sendable` and gain `provider_missing` in the same transaction. Failed and superseded syncs write no evidence (tested). Backfill: one idempotent `INSERT ... ON CONFLICT DO UPDATE WHERE evidence_source = 'backfill'` from non-sample templates with a provider id and a WABA (local and sample rows never promoted; sync-written rows never overwritten), plus one statement filling `campaign_routes.waba_id` from the route's phone where null; runs at API start and in fixtures. `campaign_routes.waba_id` is derived server-side from the phone on create/update/setup and re-verified at readiness ("configured for a different WABA than its phone now belongs to"), never client-authoritative. **Endpoints.** `POST /organizations/{id}/whatsapp/compatibility` (body `numberIds`/`templateIds`, each at most 50, deduplicated; one side may be omitted and is derived from the other side's WABAs, bounded to 200) and `GET /organizations/{id}/campaigns/{campaignId}/compatibility` (routed numbers x selected templates). Response: per number (transport, eligible template ids, own verdict), per template (eligible number ids, evidence source and verification time, verdict), incompatible pairs with codes, `numbersWithoutTemplate`, `templatesWithoutNumber`, `evaluatedAt`. Membership read; cross-tenant ids come back `not_found` with empty labels; no provider request. **Rocket pairing** (setup only; allocator v1, recipient hashing, partitioning, idempotency keys and execution untouched): `pairSendersToTemplates` finds a template-saturating matching with augmenting paths (templates in request order; for each, a still-free eligible number in request order first, then re-routing), then gives every remaining number the eligible template with the fewest numbers, ties by request order; the same inputs always give the same routes, a feasible combination the old rotating greedy pass rejected now succeeds, and an impossible one answers 409 with the uncovered templates/stranded numbers and their reasons, writing nothing. **Frozen evidence.** Each frozen route gains `wabaId`, `wabaExternalId`, `eligibleTemplateIds` (selected templates that phone could send), `eligibilityVerifiedAt` and `eligibilitySource`, all from ONE compatibility evaluation taken inside the planning lock; a route whose pair is not eligible at that instant cannot be frozen. Plans made before V2-04 lack the fields (plan summary returns null/[]); absence grants nothing and is never backfilled. Jobs keep their exact `planId`; send preparation re-evaluates live eligibility on the frozen template id (provider approval, ownership, credential binding, WABA) and blocks with the existing permanent-failure handling, never rerouting, substituting a template or reallocating. **Sender change** is the one shared decision computed from the batch's already-loaded rows plus one evidence query per batch; no per-message queries, decryption, provider calls or transport changes. **UI.** Rocket setup calls the compatibility endpoint for the current selection (query keyed by workspace and exact ids, so stale responses are discarded), shows which selected numbers can send each template and the problems, and disables Save while a template is uncovered or a number stranded; Number Center shows "Can send" (templates derived per business account, one request per 50 numbers); the Template Center preview shows "Available on" with evidence time and source. Rendered check: `artifacts/wabista-nexus/test/harness` mounts the real `RocketSetupDialog`, `TemplatePreviewDialog` and `CompatibilityMatrix` with the API mocked at the network layer (Playwright, 1280 and 375 px, no horizontal overflow); this validates the components and states, not the authenticated page chrome, which needs Clerk and could not be booted here. **V2-04 versus V2-06.** V2-04 pairs numbers to templates at setup time; V2-06 is the recipient allocator rewrite (shares, delivery modes, launch) and must build on `pairSendersToTemplates` + `decidePair`, not re-derive WABA rules. **Not done / carried forward.** Template status webhooks (deferred V2-03 item; evidence arrives through sync/backfill only), logical template families across WABAs, header-kind mapping restrictions (V2-05 owns them; unchanged), the V2-03B Meta contract items (chunk upload request, handle lifetime, creation reply shape) and full-page browser validation remain open. **Benchmark.** `docs/benchmarks/v2-04-compat-12000-2026-10-04/README.md`: the retained 12,000-row profile was run on base and head in this container (one route per phone, 180 TPS cap, forced by the current harness); both completed the workload with head within noise of base, and both fail the same per-phone pacing verification assertion in this container, so a verification-passing run on the dedicated host profile is still owed before the broadcasting release.

**Progress (V2-04 acceptance correction, shipped).** **Startup sequencing** (`services/startup.ts`, used by `src/index.ts`): the listener comes up for liveness, then required initialization (the idempotent eligibility backfill, which never overwrites sync-written evidence) runs to completion, and only a SUCCESSFUL initialization starts the campaign runtime, exactly once. A failed initialization never starts the runtime: the state becomes `failed`, `/readyz` answers 503 with the error, and the entry point shuts down cleanly with exit code 1 (runtime stop is a no-op, listener closed, pools ended). A shutdown requested while initialization is in flight waits for it to settle and then skips the runtime start, so a late-resolving backfill can never start consumption after SIGTERM. `/healthz` stays liveness (database only; runtime heartbeat and initialization phase are informational), `/readyz` is readiness for campaign operations (200 only in phase `ready` with the database healthy); the production startup health check in `.replit-artifact/artifact.toml` now points at `/api/readyz`. The sender's `evidence_missing` refusal is unchanged; no evidence is synthesized. Other `CampaignRuntime` constructors (`benchmark/campaign-benchmark.ts`, `benchmark/distributed/*`) seed their own mock-mode data and do not consume upgraded production rows, so the prerequisite is the API entry point's. Tests (`startup-orchestration.test.ts`, driving the same orchestrator the entry point builds): pending backfill means no runtime and 503; success starts it once after initialization and 200; failure never starts it and reports; shutdown during initialization never starts it; an upgrade-shaped database (synced template, queued job, no evidence rows) is prepared only after the real backfill completed and is never rejected as `evidence_missing`. **Legacy listing completeness** (`collectValidatedPages` in `whatsapp-provider.ts`, shared with the workspace-credential client, which now also uses it): every page must carry an array `data` whose rows pass `isMetaTemplateRow`; continuation by cursor (keeping the request's own fields/limit) or by the next link's path and query only; a repeated page state, a next link without a usable target, a non-200 page or the 200-page cap with pages remaining refuses the WHOLE listing (`bad_listing` / `incomplete_listing`, messages never carry a paging URL). The legacy `syncWhatsApp` therefore applies templates and evidence only after a complete validated listing; any failure leaves templates, evidence and removal flags unchanged and records a safe `unhealthy` connection state; a genuine complete `data: []` still marks the WABA's evidence unsendable and provider-missing (recovery on the next valid listing). Credential source unchanged: the legacy path still goes through the shared connector proxy (a constructor `transport` and a `syncWhatsApp` `client` option exist only as test seams); workspace credentials keep their own client; provider requests stay outside transactions; manual-credential generation ordering, revalidation and failed/superseded no-write guarantees are untouched (the concurrent-sync test now uses deterministic barriers: the earlier-reserved generation applies first and the later one still applies). Known gap recorded, not changed: the legacy sync has never rewritten the `templates` row of an absent template to Removed (only the credential sync does); the shared decision fails closed on the evidence row. **Benchmark statement corrected** (`docs/benchmarks/v2-04-compat-12000-2026-10-04/README.md`): the record supports workload completion on both commits, the same verification assertion failing on both, and a limited progress-sample comparison; it does not establish the cause of the failure or a noise interval. Profile arithmetic recorded (180 TPS x 4 phones x 15 s x 1.05 = 11,340 rows). The dedicated-host verification-passing run remains an open release gate and has not been started. **Pagination termination (V2-04 close-out).** `collectValidatedPages` follows Meta's own SDK rule (facebook-python-business-sdk, `facebook_business/api.py`, `Cursor.load_next_page`: "'after' will always exist even if no more pages are available"; continuation requires `paging.next`): a validated page whose `next` is omitted, null or "" is terminal even if it still carries `cursors.after`; a non-empty string `next` is a continuation that requires a usable `after`, followed on the original trusted request path (own fields/limit; the provider URL is never copied into a request or an error); `next` present but not a string, or malformed `paging`, refuses the listing; an empty `data` with a continuation is not terminal; a repeated continuation state refuses; the walk is capped at 200 pages, accepting a terminal page exactly at the cap and refusing a page at the cap that still advertises `next`. Covered by `provider-pagination.test.ts` through the helper, the connector client and the workspace-credential client with fakes that fail on any request after the terminal page, plus terminal-cursor apply cases in the legacy and credential sync suites.

**Complexity.** Medium.

---

## V2-05 — Rocket Audience + Message Studio

**Milestone split (recorded at V2-05A).** V2-05 is delivered in two parts, and one acceptance item moves to V2-06:

- **V2-05A: Audience.** Scope items 1 and 2 below (the Audience step, its URL and autosave, sniff, duplicates, append/replace, setup edits before execution).
- **V2-05B: Message Studio, mappings, media and preview.** Scope items 3, 4 and 5, plus presets and test send.
- **V2-06: versioned allocator and arbitrary N × M execution.** Scope item 6 (a template set independent of the number count, rotating several templates per sender) and the acceptance criterion "A 1-number × 3-template campaign and a 3-number × 1-template campaign both plan and send in mock mode" move to V2-06. Dependency: under allocator v1 each route freezes exactly one template and `assignRoute` maps a recipient to a route, so rotating several templates on one sender changes what a v1 plan means. That is the allocator-v2 change V2-06 is built for (version-gated precedence, v1 plans resolving identically). V2-05A/B therefore do not change v1 semantics; Rocket setup keeps the V2-04 pairing.

**Goal.** The four-step Rocket wizard with a real Audience step and a Message Studio that supports N senders × M templates, image and non-image templates together, media upload reuse, shared and per-template mappings, preview and test send. Delivery and Review steps ship in 06; in 05 the wizard ends with the existing readiness + Plan/Execute behind a single Launch button.

**Business value.** Non-technical users can build a campaign end to end without understanding routes, mappings keys or queues; the mixed-media and forced-sharing restrictions are lifted.

**Exact scope.**
1. Wizard page `/campaigns/new` with autosave (create Draft on step 1), stepper, resume on reload.
2. Audience: server-side sniff endpoint (headers, sample, phone-column guess, country guess); upload through the existing streaming import; audience summary; invalid/suppressed download; duplicates stored as `Duplicate` rows and downloadable; multiple sessions on a Draft (append/replace); relax the setup-after-import freeze for Draft/Ready.
3. Message Studio: sender selection (eligible/health shown), template selection (disabled with reason when ineligible for the selected senders), shared variable groups with per-template overrides, `media_assets` upload (image/video/document) with one asset reusable across compatible templates, WhatsApp-style preview from the same resolver as sending, mapping presets, test send.
4. Mapping PUT accepts explicit per-template rows; remove the "must be identical" throws; preflight header-kind rule replaced by per-template media-kind validation.
5. Media delivery: Meta `/media` upload per sender WABA at plan time with `id` in the payload, fallback to a signed public link served by `GET /media/:id`.
6. Rocket setup endpoint extended: accepts template set independent of number count (drop `numbers >= templates`; rotation stays for v1 allocator but rotates within each sender's eligible set and allows a template on several senders).

**What the user will see.** New Campaign → Audience (drop CSV, counts) → Message (pick numbers and templates, map variables, upload one image, preview) → Launch.

**Backend impact.** Sniff endpoint; duplicate rows; media assets; mapping model change; setup relaxation; test send.

**Frontend impact.** Wizard, Message Studio, preview, upload.

**DB impact.** `media_assets`; `campaign_template_mappings.media_asset_id`; `mapping_presets`; `campaign_contacts` Duplicate rows; `campaigns.audience_source`.

**API changes.** `POST …/imports/sniff`; `GET …/imports/:id/duplicates.csv`; `POST …/audience/replace`; media asset endpoints; mapping PUT schema; rocket-setup body; `POST …/test-send`.

**Likely files.** `api/routes/campaign-engine.ts:334-570, 598-744`, `api/services/campaign-import-lifecycle.ts:100-125`, `api/services/template-mapping.ts:45-140`, `api/services/campaign-preflight.ts:60-69`, `api/services/whatsapp-template-sender.ts:106-148`, `api/routes/campaign-media.ts`, `api/lib/object-storage.ts`, `api/routes/campaign-routes.ts:238-461`, new `ui/pages/rocket/*`, `ui/components/campaigns/message-studio/*`.

**Tests required.** Sniff on quoted/UTF-8/BOM files; duplicate rows counted and exported; append/replace under the lifecycle lock (race test); mapping PUT with differing per-template values succeeds; image + video templates pass preflight with per-template media; media id payload and link fallback; test send does not touch campaign metrics; setup with 1 number × 3 templates and 3 numbers × 1 template; frozen-template-mutation and plan-to-send suites unchanged.

**Acceptance criteria.** (V2-05B) One uploaded image is used by every image template; preview equals sent parameters for a sampled contact. (V2-05A) See the V2-05A progress note below. The 1-number × 3-template / 3-number × 1-template mock-mode criterion moved to V2-06 (see the milestone split).

**Regression risks.** Import path change (duplicate rows) affects row counts and metrics (`deduplicated` semantics must stay: count of duplicates); relaxing the setup freeze must keep plan supersession correct (covered by planning tests). Sender payload builder change for media ids.

**Dependencies.** V2-03, V2-04.

**What must NOT change.** Streaming parser; idempotency keys of Valid rows; frozen snapshot contract; resolver core.

**Commit boundaries.** (1) sniff + wizard shell + autosave; (2) duplicates + multi-session + freeze relaxation; (3) media assets + upload UI + Meta media id; (4) mapping model change + preflight rule; (5) Message Studio UI + preview; (6) setup relaxation; (7) presets + test send.

**Complexity.** Large.

**Progress (V2-05A, shipped; V2-05 as a whole is NOT complete).** **Routes.** `/campaigns/new` creates one Draft with a client `creationKey` (unique per organization, kept for the tab session) and replaces the URL with `/campaigns/:id/audience`, the stable resume URL; both are registered before `/campaigns/:campaignId`. A retried, reloaded or double-clicked create replays the same Draft (200) instead of creating another. The campaign name autosaves with `revision` (PATCH refuses a lower revision with 409 `stale_revision` and returns the current row; the page sends only the newest request's result to state and rebases a stale save once). Legacy clients that send no revision keep last-write-wins. A browser file selection does not survive a reload and the page says so; choosing the same file with the same settings reuses its idempotency key, so the server resumes the stopped upload. Nothing on the page plans, executes or sends; it ends at "Continue to setup". **Sniff.** `POST …/imports/sniff` (membership read, nothing persisted) reads at most 256 KB, 200 data rows and 500 columns, returns 20 sample rows clipped to 512 characters per field, and reports `truncated` (a prefix cut mid-field by the cap is not invalid; a genuinely unterminated quote inside the prefix is 400 `invalid_csv`; an empty body is 400 `empty_csv`). It returns the ordered, disambiguated column names the import will use, a phone-column suggestion only when exactly one header looks like a phone column and its samples look like numbers, and a country-code decision (`not_needed` when every sampled number is international, `required` when any is national, `unknown` without a suggestion); no code is ever guessed. **Parser.** One streaming `TextDecoder` across chunks (a UTF-8 character split between chunks is reassembled; previously each Buffer was decoded alone), BOM dropped; otherwise the RFC-4180 state machine is unchanged. `normalizeHeaders` replaces `Object.fromEntries` on raw headers: an empty header becomes `column_N`, a repeated one `name_2`, `name_3`... so no column is silently dropped; sniff and import share it. **Duplicates.** The canonical row per recipient keeps `stableContactKey(campaignId, normalizedPhone)` unchanged (so `send:` job keys are unchanged); every non-canonical occurrence is stored in `contact_import_occurrences` with its original columns, session, row number, classification (`duplicate_in_import` / `duplicate_of_existing`) and the canonical row it repeats. Identity is (session, row number) with ON CONFLICT DO NOTHING, and a resumed stream skips rows already written, so retries never double-count. Classification precedence: Invalid rows (no normalized phone) are never duplicates; otherwise a row whose key already exists in the active generation is a duplicate whatever the canonical row's status (a repeated suppressed number is one Suppressed row plus duplicates, counted once as suppressed); otherwise Suppressed or Valid. Only canonical Valid rows of the active generation are planned. `duplicates.csv` and `rejected.csv` stream keyset by id with socket backpressure and are tenant-scoped. **Append / replace.** `x-import-operation: append` (default; old clients unchanged) writes into `campaigns.audience_generation`; `replace` stages generation max+1 and the completion transaction activates it atomically (the prior audience stays the audience until then, and remains after a failed or cancelled upload). The canonical-key unique index is scoped per (campaign, generation); older generations are kept for plan history. Batches stay short transactions; each re-checks a fence (campaign Draft FOR UPDATE, session Processing, generation still writable), so a stale batch after a replace activated is refused (409 `fenced`). Initialization runs under the campaign lifecycle lock (never held across the upload) and serializes with plan, execute, reopen and other imports. An idempotency key reused with another campaign or another phone column, country code or operation is 409 `idempotency_mismatch`. Metrics and `audienceSize` are recomputed from the active generation's completed sessions. `contacts/search` pages by contact id over the active generation (rowNumber restarts per session). **Lifecycle.** New action `reopen`: Ready → Draft only when no job exists, superseding the active plan (plans and allocations kept, audited); Draft is a no-op; Scheduled/Running/Paused are never reset. Imports into a Ready campaign answer `reopen_required`; any job (also on a Draft) answers `execution_history`; Paused and other states answer `not_draft`. Route create/update/delete and Rocket setup now allow edits after an import while Draft or Ready with no execution history and no import processing; a Ready campaign is moved to Draft with its plan superseded in the same transaction; imported recipients are untouched. V2-04 eligibility and TPS checks, allocator v1, route-template precedence, `job.planId` and idempotency keys are unchanged. **Compatibility.** Existing single-import campaigns are generation 0 append sessions; their rows, counts and downloads read the same; `deduplicated` still counts duplicate rows. Clients that only send the original headers keep working, now appending a second file instead of getting 409. **Tests.** `campaign-audience.test.ts` (13 cases, listed in its header) plus all 51 suites of the aggregate script green on a disposable Postgres. **Rendered check.** `test/harness/render-audience.mjs` mounts the real `AudienceWorkspace` with the API mocked at the network layer at 1280 and 375 px (flow, reopen, locked; raw CSV bodies, headers, stale-save rebase, no horizontal overflow). It does not boot Clerk or the API, so the authenticated page and a real upload end to end were not browser-checked. **Still open.** Dedicated-host benchmark, Meta authoring/media contract verification, full-page authenticated browser checks; V2-05B (Message Studio, mappings, media, preview, presets, test send).

**V2-05A close-out (creation key).** `/campaigns/new` no longer clears its creation key right after a successful create. The key records the campaign it created and is retired only when `/campaigns/:id/audience` has mounted for that campaign, so a reload or crash between the API answer and the navigation resends the same key and the server replays the same Draft; a later, intentional visit gets a new key and a new Draft. Server-side `(organization, creationKey)` replay is unchanged. Regression: `artifacts/wabista-nexus/test/unit/new-campaign-key.test.ts` (`pnpm --filter @workspace/wabista-nexus run test:unit`, 3 cases, the 9-step sequence included).

**Progress (V2-05B, shipped; V2-05 complete on its 05A + 05B acceptance criteria; V2-06 not started).** **Flow.** New Campaign → Audience (`/campaigns/:id/audience`) → Message (`/campaigns/:id/message`, registered before `/campaigns/:id`). The step indicator shows only those two steps; the Message step ends with "Save message setup" and never plans, executes or sends (the only provider action is the explicit test send). The campaign setup tab links to Message Studio; the legacy mapping dialog is read-only for campaigns whose templates carry their own values or a media file. **State.** `campaign_message_setups` holds the selected senders and an optimistic revision; templates stay in `campaign_template_selections`, mappings in `campaign_template_mappings` (new nullable `media_asset_id`). `GET/PUT …/message-setup` returns senders (non-sample org numbers, bounded 200) and provider-backed, non-sample templates (bounded 200; selected ones always shown) with the V2-04 verdicts (`describePhone`, `decidePair`), the selected templates each number can send, the senders each template works with, requirements per template, mappings, active-audience columns, media files and the execution summary. **Save.** Under the campaign lifecycle lock and `assertSetupEditable` (Draft, or Ready with no execution history whose active plan is superseded and which returns to Draft in the same transaction; refused after any job, during an import, for Paused/Running/Scheduled, never reset), with the revision fence (409 `stale_revision`). Senders and templates outside the workspace answer 404; unusable numbers 400 `sender_unusable`; local drafts, samples, non-approved or removed templates 400 `template_unusable`. Every save, route write, Rocket setup and legacy mapping PUT bumps the revision. **Allocator v1 unchanged.** Routes are derived only when v1 can run the selection (`pairSendersToTemplates`: one template per number, every template covered); matching routes are kept, others removed, TPS of a known number preserved, a new number starts at its provider cap. A selection v1 cannot run (`needs_multi_template`, e.g. 1 number x 2 templates, or `incompatible`) is saved WITHOUT routes, never silently dropped, and readiness says why ("Message setup: …"). No allocator-v2 field, precedence or rotation was introduced; `ALLOCATOR_VERSION` is still `v1` and frozen plans resolve as before. **Mappings.** Per template, component-scoped (`header:1`, `body:2`, `button:<index>:<n>`, `header:media`), sources `csv`, `static`, `media_asset`; unknown, duplicate, wrong-component or not-selected mappings and media of the wrong kind fail at save (400 `invalid_mappings` / `media_kind_mismatch`); incomplete drafts save and readiness/planning refuse them. The "templates must share identical mappings" rule is gone: `applySharedDefaults` (legacy PUT) and the UI's "Use for others" fill only empty matching slots, an explicit per-template mapping always wins, and nothing is inherited when explicit mappings disagree; results are persisted as explicit rows. `expandCompatibleMappings` keeps its documented behaviour for its callers. **Audience columns.** Mappings use the ACTIVE generation's columns: the ordered union of its completed uploads, each `all` (every upload has it) or `some`. Rule: a required CSV mapping must use an `all` column; a `some` or absent column blocks readiness unless the mapping is optional with a fallback; no value is ever fabricated. **Media.** `campaign_media_assets` (org, campaign, file name, type, size, kind, server-generated storage key, sha256, status, creator); upload streams the raw body (JPEG/PNG 5 MB, MP4/3GPP 16 MB, PDF 100 MB) checked by declared type and leading bytes with a safe file name, Draft/Ready without jobs only; storage is private object storage (`PRIVATE_OBJECT_DIR`) or, outside production only, a local directory (`CAMPAIGN_MEDIA_STORAGE_DIR`); without either uploads answer 503. Content is served tenant-scoped, inline, `nosniff`, `private, no-store`. A referenced file cannot be deleted; deletion is a soft state change. One upload can be assigned to every template with a matching header. Template Studio's `template_media_uploads` is untouched. **Provider media.** `campaign_media_provider_bindings` caches the provider media id per (asset, sending number), pinned to credential revision and bytes, 29-day expiry, reused at preparation only with 7 days left. Planning creates/reuses every binding the frozen routes need inside the lifecycle lock before freezing (outside any transaction) and refuses the plan on any failure; frozen plans keep the asset id only. Send preparation (`resolveJobTemplates`) reads bindings in one query per batch and fails the job closed when one is missing; the payload builder sends `{ "image": { "id": … } }`. Uploads use `POST /{phone-number-id}/media` (multipart: `messaging_product`, `type`, `file`) with the number's own workspace credential; the local mock gets a deterministic id; the shared legacy connector cannot upload (readiness blocker and test-send refusal). No signed public-link fallback was built (provider ids cover every supported transport; a public link would add a new exposure surface). Pre-V2-05B link mappings (static/CSV URL) still send as before. **Resolver parity.** `resolveTemplateParameters` is the one core for send preparation, plan preview, Message Studio preview and test send; `resolveTemplateVariables` keeps its exact error texts. `message-preview-parity.test.ts` asserts, for every job of a 12-contact, 2-number, 2-template plan (image header + body CSV/static + URL button; text header static + body CSV), that preview parameters equal the prepared parameters, that the job carries its own sender's media id, and the exact provider components; a missing value is unresolved in preview and fails resolution with the same key. **Presets.** `mapping_presets` (workspace, unique name, slot → CSV column or fixed text; no media, ids or secrets). Applying (`POST …/apply-preset`, revision-fenced) copies entries into empty slots of the selected templates (or overwrites on request) and saves through the same path; the campaign never references the preset afterwards. **Test send.** `POST …/message-setup/test-send`: only a saved number and template; checks ownership, number and credential state, the V2-04 pair decision, a provider-backed sendable template, the recipient (audience contact or explicit E.164 number, opted-out numbers refused), resolved mappings and media kind, all before any provider request; payload from the real resolver and builder; one request through the number's own transport (workspace credential direct, shared connector, or local mock); timeouts reported as unknown and never retried. It creates no job, allocation or provider-message row, changes no metric, status or plan, and records one `test_send_requested` audit row (ids, transport, result; no payload or token). **Preflight.** Per-template media validation replaces the single-header-kind rule; added: select at least one template, Message Studio selection not runnable, missing/unavailable/mismatched media, media on the shared connector, active-generation columns. Existing blockers (routes, TPS caps, V2-04 decision, coverage, mappings) are unchanged. **Legacy mapping PUT.** Keeps its historic lifecycle contract (any status; executed jobs are protected by their frozen plan, as `campaign-frozen-template-mutation` and `campaign-lifecycle-races` assert), now with the revision bump, media validation and shared defaults. Known gap carried forward: a legacy PUT on a Ready campaign does not supersede its plan (the product UI no longer uses it). **Tests (new, disposable Postgres, sequential).** `campaign-message-studio` 7, `template-mapping-v2` 5, `campaign-media` 3, `message-preview-parity` 2, `campaign-test-send` 3, frontend unit 3. Full aggregate api-server script (`pnpm run test` suite list, run one suite at a time on a disposable Postgres): 56 suites, 335 tests, all passing with exit 0, including campaign-audience, lifecycle races, planning, plan preview, plan-to-send, frozen mutation, send and multi-template fidelity, duplicate-send guard, TPS ceiling and sustained TPS, credential binding/runtime, sending activation, template sync/routes/drafts/submission/media/compatibility, suppression and cross-tenant. Codegen, repo typecheck, API build and frontend build pass; there is no lint gate. **Rendered check.** `test/harness/render-message.mjs` and `render-audience.mjs` mount the real `MessageWorkspace` / `AudienceWorkspace` with the API mocked at the network layer at 1280 and 375 px (sender reasons, incompatible template, upload, media assignment, mapping editor, preview substitution, validation error, save revision, shared copy, test-send dialog, locked and multi-template states; no horizontal overflow). Clerk was not booted: the authenticated page, a real save and a real send were not browser-checked. **Meta contract.** developers.facebook.com is blocked by this environment's egress policy (HTTP 403 from the proxy); the media upload shape (`POST /{phone-number-id}/media`, multipart `messaging_product`/`type`/`file`, reply `{ id }`), the 30-day media lifetime and the `{ id }` header parameter follow Meta's Cloud API reference (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media, https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates) but were NOT verified live and must be confirmed before production use, together with the open V2-03B authoring items. **Still open.** Dedicated-host V2-04 benchmark (not run; status unchanged), Meta media/authoring contract verification, full-page authenticated browser checks, the legacy-PUT Ready-plan gap above. V2-06 (allocator v2, multi-template per sender, delivery modes, Review & Launch) has not started.

---

## V2-06 — Rocket Distribution + Preflight (allocator v2, delivery modes, launch)

**Goal.** Equal-by-numbers and equal-by-templates distribution over arbitrary N × M, delivery modes, a structured preflight, and a single Launch action, all frozen in the plan.

**Business value.** Users choose how to split load in business terms; preflight shows exactly what will happen; TPS disappears from the default path.

**Exact scope.**
1. Route model: one route per sender lane with a shared per-sender budget; `campaign_jobs.template_id` is authoritative under `allocatorVersion = v2`; `frozenTemplateForJob` precedence keyed by version.
2. Allocator v2 (`api/services/campaign-allocator-v2.ts`): equal-by-numbers (sender partition → template rotation within eligible set) and equal-by-templates (template bucket → eligible senders proportional to rate); deterministic; unit-tested against the X/Y/Z fixture.
3. Delivery modes resolved to per-route TPS at plan time; Advanced per-number table; `adjust-speed` action (Paused-only for now, bulk update of Queued jobs' `configuredTps` under the lock).
4. Preflight endpoint with the structured report and central message catalogue; readiness kept.
5. `launch` action = plan + execute under one lock; schedule uses the same.
6. Review & Launch step UI; Delivery step UI.
7. Plan summary exposes distribution/delivery and per-sender/template counts ("what will be sent").

**What the user will see.** Delivery step (distribution, speed, schedule), Review with preflight and counts, Launch.

**Backend impact.** Allocator v2; plan fields; delivery mode resolution; preflight; launch/adjust-speed actions.

**Frontend impact.** Two wizard steps; Details tab additions.

**DB impact.** `campaign_plans.distribution_mode`, `delivery_mode`; `campaigns.distribution_mode`, `delivery_mode`, `delivery_settings`, `timezone`; `campaign_routes.shared_phone_budget boolean`.

**API changes.** `GET …/preflight`; actions `launch`, `adjust-speed`; campaign PATCH fields; rocket-setup `distributionMode`.

**Likely files.** `api/services/campaign-planning.ts:133-292`, new `api/services/campaign-allocator-v2.ts`, `api/services/template-resolution.ts:103-114`, `api/services/campaign-preflight.ts`, `api/routes/campaign-engine.ts:137-312`, `api/services/campaign-queue.ts` (only if `configuredTps` bulk update needs a helper), `db/campaign-engine.ts:288-341`, `ui/pages/rocket/delivery.tsx`, `ui/pages/rocket/review.tsx`.

**Tests required.** Allocator v2 determinism and share accuracy for both modes (300k synthetic recipients, 3 senders, 3 templates, mixed eligibility); plan → execute → claim → resolve → send with v2 plans (extend `campaign-multi-template-plan-to-send.test.ts`); v1 plans still resolve identically; rate-limit suite with multiple templates on one sender (budget not multiplied); adjust-speed race with claim; launch idempotency; preflight report contents; benchmark run at the last retained profile.

**Acceptance criteria.** Moved from V2-05: a 1-number × 3-template campaign and a 3-number × 1-template campaign both plan and send in mock mode (rotating multiple templates per sender is introduced here, version-gated, without changing v1 plans). Equal by numbers: 300k / 3 senders ≈ 100k each with only compatible templates; equal by templates: 300k / 3 templates ≈ 100k each sent only by compatible senders; no route or job ever pairs an ineligible sender/template; throughput per sender never exceeds its cap with several templates.

**Regression risks.** Highest in the plan: touches planning, resolution precedence and TPS. Mitigate by version gating, unchanged v1 tests, and the benchmark gate.

**Dependencies.** V2-04, V2-05.

**What must NOT change.** Lease fencing; claim query shape; settlement; pacing coordinator Lua; delivery_unknown semantics.

**Commit boundaries.** (1) plan/campaign columns + resolver precedence by version (no behaviour change for v1); (2) allocator v2 + unit tests; (3) planning integration + plan-to-send tests; (4) delivery modes + adjust-speed; (5) preflight endpoint + message catalogue; (6) launch action; (7) wizard steps UI; (8) benchmark record + docs.

**Complexity.** Large.

---

## V2-07 — Flight Deck realtime

**Goal.** Live campaign control with measured speed, ETA, per-number lanes, charts and SSE; honest "Throttled"; failure accounting fixed; web/cell role split.

**Business value.** Users trust what they see and can act (pause, slow down, stop) from desktop or phone.

**Exact scope.**
1. `API_ROLE = web | cell | all`; SSE, exports, health polling and inbox processing only in `web`/`all`; guard script requires `cell` on transport hosts.
2. `campaign_metric_deltas` + `route_id`, `delivered_delta`, `read_delta`, `unknown_delta`, `held_delta`; monitoring `routes[]` from deltas (no job scan); reconciliation extended to preserve delivery failures.
3. `campaign_throughput_samples` written by the flusher; actual speed and 15-minute series in monitoring; ETA from measured rate.
4. Engine-written `Throttled` (pacing denial window) and `Error` (sender unavailable reason) route statuses; `currentTps` no longer PATCHable.
5. SSE endpoints with heartbeat, cursor replay ring in Redis, tenant-derived channels, coalescing, connection caps.
6. Flight Deck UI: progress header, outcomes strip, charts, numbers table, problems panel, controls (Pause/Resume/Emergency stop/Reduce speed), Advanced accordion; mobile layout; polling fallback with "Live" indicator.

**What the user will see.** Flight Deck tab updating live.

**Backend impact.** Role switch; delta schema; samples; SSE; route status writers; monitoring rewrite.

**Frontend impact.** Flight Deck; `useCampaignStream` hook.

**DB impact.** Delta columns; `campaign_throughput_samples` (+ retention job); `campaign_routes.status_reason`.

**API changes.** Monitoring response extended; `GET …/stream`, `GET /stream`; route update schema loses `currentTps/queueDepth/status`.

**Likely files.** `api/index.ts`, `api/app.ts`, new `api/lib/role.ts`, `deploy/systemd/campaign-cell-guard.sh` (doc + check), `api/services/campaign-queue.ts:182-250, 686-691, 1176-1183, 1350-1358`, `api/services/campaign-reconciliation.ts`, `api/services/campaign-phone-reservoir.ts` (throttle signal), `api/routes/campaign-engine.ts:1021-1139`, new `api/routes/stream.ts`, new `api/services/live-events.ts`, `db/campaign-engine.ts`, `ui/pages/campaign-detail/flight-deck.tsx`.

**Tests required.** Delta folding with route id; monitoring equals reconciliation after churn (extend `campaign-metric-reconciliation.test.ts`); samples written at flush cadence without extra locks (settlement-route-locks suite unchanged); Throttled set/cleared under pacing denial; SSE auth, tenant isolation, cursor replay, heartbeat, coalescing; role switch: `cell` never serves SSE, `web` never starts the reservoir; benchmark run.

**Acceptance criteria.** Flight Deck shows actual speed within 10% of the simulated provider rate; pause/resume/stop from the page; per-number lanes visible; no monitoring request scans `campaign_jobs`; a cell host with `API_ROLE=cell` serves no SSE.

**Regression risks.** Hot-path deltas and samples add write volume; must stay batched. Role split affects deploy units and the guard script (docs and example env updated; no production change by V2 itself).

**Dependencies.** V2-06 (plan fields), V2-01 (detail page).

**What must NOT change.** Claim/lease/settlement semantics; Lua scripts; stream names; failover timings.

**Commit boundaries.** (1) role switch + guard doc; (2) delta columns + monitoring from deltas + reconciliation; (3) throughput samples + ETA; (4) route status writers + schema cleanup; (5) live-events + SSE endpoints; (6) Flight Deck UI; (7) benchmark record.

**Complexity.** Large.

---

## V2-08 — Recovery + Export Center

**Goal.** Turn failures into actionable business groups with safe actions, and make exports complete (original columns), filterable and background-capable.

**Business value.** Operators fix campaigns without spreadsheets; management gets complete data; nothing is resent twice.

**Exact scope.**
1. `failure_class` on `campaign_jobs` and `provider_messages`, assigned by a central `classifyFailure` at settlement and webhook failure; backfill script for historical rows using existing error text and codes.
2. `GET …/recovery` (counts + samples per class), actions `retry` (in place, never delivery_unknown), `create-from-failed`, `change-template-and-retry`, `change-sender-and-retry` (through a scoped reroute), `download`.
3. Reroute action for Paused campaigns and Held state (Queued-only, lease-safe, compatible pool from the frozen plan); sender-unavailable detection sets route `Error` with reason; Held jobs appear in Recovery.
4. `delivery_unknown` list and resolve endpoints; abort-before-provider-start classified as retryable.
5. Export Center: filters, column sets including original CSV columns, `export_jobs` worker (web role) to object storage with signed downloads and expiry, history, SSE/notification on ready; small exports stream as today.
6. UI: Recovery tab, Export tab, Messages tab drawer with status timeline.

**What the user will see.** Recovery groups with one-click actions; Export with filters and history.

**Backend impact.** Classification; recovery service; reroute; export worker.

**Frontend impact.** Two tabs.

**DB impact.** `failure_class` columns + index; `campaign_reroutes`; `campaign_recovery_actions`; `export_jobs`; `provider_messages.resolution*`; optional job status `Held` (or `campaign_routes.held_at`).

**API changes.** Recovery endpoints; actions `retry`, `reroute`; delivery-unknown endpoints; export job endpoints; export.csv filter params.

**Likely files.** new `api/services/failure-classification.ts`, `api/services/campaign-queue.ts:1229-1300` (call classifier), `api/services/whatsapp-webhook.ts:248-263`, new `api/services/campaign-recovery.ts`, new `api/services/campaign-reroute.ts`, new `api/services/export-jobs.ts`, `api/routes/campaign-engine.ts:824-999`, `db/campaign-engine.ts`, `db/provider-integration.ts`, `ui/pages/campaign-detail/recovery.tsx`, `ui/pages/campaign-detail/export.tsx`.

**Tests required.** Classifier table-driven tests over every known engine string and Meta code; retry reuses request key and never touches delivery_unknown (extend duplicate-send-guard); reroute moves only Queued jobs, updates depths, refuses ineligible targets, races with claim (lifecycle-races pattern); create-from-failed copies rows without re-upload; export All contains original columns in header order plus outcome columns; large export job lifecycle and expiry; cross-tenant for every new endpoint.

**Acceptance criteria.** For a campaign with mixed failures, Recovery shows correct groups; retrying "Retry eligible" resends only those; delivery_unknown never resends; Export All of a 1M-row campaign completes as a background job and the file has every original column.

**Regression risks.** Settlement path gains a classifier call (pure function, no I/O); reroute is a new lifecycle action under the existing lock.

**Dependencies.** V2-06, V2-07.

**What must NOT change.** At-most-once semantics; request-key uniqueness; lease fencing.

**Commit boundaries.** (1) classifier + columns + backfill; (2) recovery read endpoint + UI; (3) retry action; (4) reroute + Held; (5) delivery-unknown endpoints; (6) export jobs + worker; (7) export UI + filters on streaming endpoint.

**Complexity.** Large.

---

## V2-09 — Real Smart Inbox

**Goal.** Store every inbound message, unify conversations across numbers, reply from the correct number, keep campaign attribution.

**Business value.** Sales and support teams work replies in Wabista; the biggest fake surface becomes real.

**Exact scope.**
1. Tables: `conversations`, `messages`, `conversation_notes`, `conversation_events`, `webhook_events` (persist-then-process).
2. Webhook processor: store raw event, ack fast, process inbound messages in a bounded in-process queue (web role): tenant/number resolution scoped by org, conversation upsert, message insert, media download to object storage, campaign/template attribution via `context.id → provider_messages`, 24-hour window tracking, STOP behaviour unchanged plus contact opt-out.
3. Outbound conversation send (text/media/template) via a new provider method; status updates from the existing webhook path by wamid.
4. Inbox API with keyset lists, counts, assign/state/tags/notes; SSE events.
5. UI: three-pane inbox, sections and filters, pinned campaign context card, locked reply-from, template mode outside the window, mobile two-level navigation, contact side panel.

**What the user will see.** A working inbox across all numbers.

**Backend impact.** Webhook branch; inbox service; provider send for conversations.

**Frontend impact.** Inbox page.

**DB impact.** New tables and indexes (Master Spec §10.2); `contacts.last_inbound_at/last_outbound_at`.

**API changes.** `/inbox/*`; `/media/:id`; SSE inbox events.

**Likely files.** `api/services/whatsapp-webhook.ts` (additive branch), new `api/services/inbox/*`, `api/services/whatsapp-provider.ts` (`sendMessage`), new `api/routes/inbox.ts`, `db/inbox.ts` (new), `ui/pages/inbox/*`.

**Tests required.** Webhook fixtures for text/image/interactive/reaction/location; attribution via context id; window expiry; reply-from lock enforced server-side (reject mismatched number); keyset pagination; org isolation (two orgs, same customer phone, different numbers); STOP still suppresses and now marks conversation; SSE event emission.

**Acceptance criteria.** An inbound message to any connected number appears in the inbox within seconds with the right number and campaign context; a reply is sent from that number only; nothing is fabricated when there are no conversations.

**Regression risks.** Webhook handler is on the delivery-status path; the inbound branch must be additive and wrapped so an inbox error never fails status processing.

**Dependencies.** V2-02, V2-07.

**What must NOT change.** Status processing, STOP fencing, provider_messages semantics.

**Commit boundaries.** (1) tables + webhook persistence; (2) inbound processing + attribution; (3) outbound send; (4) inbox API; (5) UI list/thread; (6) mobile + side panel; (7) SSE events.

**Complexity.** Large.

---

## V2-10 — Chat Manager / team routing

**Goal.** Teams, number-to-team and number-to-agent assignment, team queues, manual assignment, priority, snooze, resolve/reopen, notes, collision awareness.

**Business value.** Support teams share the inbox without stepping on each other.

**Exact scope.** `teams`, `team_members`, `number_assignments`; assignment resolution order; Team Queue and Chat Manager tabs; agent presence via SSE; permissions for Inbox Agent vs Manager.

**What the user will see.** Chat Manager tab with rules, queue, agents; assignment controls in threads.

**Backend / Frontend / DB / API impact.** Small additive service; UI tab; three tables; `/inbox/teams`, `/inbox/assignments`.

**Likely files.** `api/services/inbox/assignment.ts`, `api/routes/inbox.ts`, `db/inbox.ts`, `ui/pages/inbox/chat-manager.tsx`.

**Tests required.** Resolution order; permissions; cross-tenant.

**Acceptance criteria.** A number assigned to Sales routes new conversations to the Sales queue; agents see only their team's queue; auto-assignment controls are not rendered.

**Regression risks.** None to the engine.

**Dependencies.** V2-09.

**What must NOT change.** Reply-from lock.

**Commit boundaries.** (1) tables + resolution; (2) endpoints; (3) UI.

**Complexity.** Medium.

---

## V2-11 — Contacts + Segments

**Goal.** A CRM-grade contacts area with import, custom fields, tags, dedupe, suppression, history; smart segments reusable in Rocket.

**Exact scope.** `normalized_phone` (backfill + unique), `custom_fields`, `contact_fields`, opt-out fields; global streaming import reusing the CSV parser; keyset pagination; bulk actions as jobs above a threshold; contact drawer with campaign/conversation history; Do Not Contact tab with reason, trigram index, debounce; `segments` with rule builder, counts, static snapshots; Rocket audience source = segment (materialisation through the import batch writer).

**What the user will see.** Contacts with tabs and a rich drawer; Segments list and editor; "Use in campaign".

**Backend / Frontend / DB / API impact.** Contacts service extension; segment compiler; tables above; `/contacts/imports`, `/contacts/bulk`, `/segments/*`, `POST …/audience/from-segment`.

**Likely files.** `api/routes/contacts.ts`, new `api/services/contacts-import.ts` (wrapping `parseCsv`), new `api/services/segments.ts`, `db/contacts.ts`, `db/segments.ts`, `ui/pages/contacts/*`.

**Tests required.** Backfill normalisation; import dedupe by normalized phone; segment compiler for each rule type with bounded count; materialisation equals a CSV import of the same set; cross-tenant.

**Acceptance criteria.** 1M contacts import and paginate without offset scans; "Delivered but unread" for a campaign yields the right set and launches as a new audience.

**Regression risks.** None to the engine; contacts list envelope change (keep offset params for one release).

**Dependencies.** V2-05 (import reuse), V2-09 (history).

**Commit boundaries.** (1) columns + backfill; (2) global import; (3) drawer + history; (4) bulk + suppressions polish; (5) segments compiler; (6) segments UI + Rocket source.

**Complexity.** Medium.

---

## V2-12 — Meta Control Center (Embedded Signup, health, alerts)

**Goal.** Connect with Meta via Embedded Signup with multi-number selection; periodic health; human-readable alerts feeding Home.

**Exact scope.** FB SDK loader and `FB.login` flow behind `EMBEDDED_SIGNUP_ENABLED`; code exchange, credential storage, `subscribed_apps`, discovery, selection screen; health job (web role) per credential and number; `health_alerts`; webhook handlers for quality/account updates; Meta Health page; Action Center integration.

**What the user will see.** Connect with Meta → pick numbers → connected; Meta Health page with alerts.

**Backend / Frontend / DB / API impact.** Signup service; health scheduler; alerts; `embedded_signup_sessions`, `health_alerts`; `/whatsapp/embedded-signup/*`, `/meta-health/*`.

**Likely files.** new `api/services/whatsapp-embedded-signup.ts`, new `api/services/whatsapp-health.ts`, `api/services/whatsapp-webhook.ts` (quality/account events), `api/routes/whatsapp-integration.ts`, `ui/pages/numbers/connect-with-meta.tsx`, `ui/pages/meta-health.tsx`.

**Tests required.** Code exchange with mocked Graph; state nonce validation; selection connects only chosen numbers; health job writes alerts idempotently; webhook quality update changes number quality and opens/closes alerts; cross-tenant.

**Acceptance criteria.** A workspace connects three numbers from one signup and each shows its true setup state; a quality drop appears on Home within one health cycle.

**Regression risks.** None to the engine; external dependency on Meta app review (manual path remains).

**Dependencies.** V2-02, V2-03, V2-09.

**Commit boundaries.** (1) signup backend behind flag; (2) selection UI; (3) health job + alerts; (4) webhook events; (5) Meta Health page + Home integration.

**Complexity.** Large.

---

## V2-13 — Analytics V2

**Goal.** Business analytics first, operations second, from rollups.

**Exact scope.** `analytics_daily` fed by flusher/webhook/inbox; raw indexes; date-range endpoints for campaigns, templates, numbers; Operations tab from monitoring/samples; charts via `ui/chart.tsx`; wire `analytics.test.ts` into the chain.

**Backend / Frontend / DB / API impact.** Rollup writer (batched, off hot row); indexes; `/analytics/*` v2; Analytics page.

**Likely files.** `api/routes/analytics.ts`, new `api/services/analytics-rollups.ts`, `db/analytics.ts`, `ui/pages/analytics.tsx`.

**Tests required.** Rollup correctness vs raw counts; date bounds; index usage (`EXPLAIN` in a test comment or a bounded-time assertion); cross-tenant.

**Acceptance criteria.** Analytics loads from rollups only; no request handler aggregates raw tables without a date bound.

**Dependencies.** V2-07, V2-09.

**Commit boundaries.** (1) rollup table + writers; (2) indexes; (3) endpoints; (4) UI.

**Complexity.** Medium.

---

## V2-14 — Automations + Flows

**Goal.** Trigger → Conditions → Actions engine with a durable run log; visual Flow Builder; WhatsApp Flows as template capability.

**Exact scope.** Event bus (webhook processor, campaign lifecycle, inbox); `automations`, `automation_versions`, `automation_runs`; actions assign/tag/send template/wait/webhook; builder UI; examples from the brief as templates.

**Tests required.** Idempotent action execution; wait/resume across restarts; cross-tenant.

**Acceptance criteria.** "Incoming message → campaign = X → assign Sales" runs end to end; runs are visible.

**Dependencies.** V2-09, V2-12.

**Commit boundaries.** (1) event bus; (2) engine + tables; (3) actions; (4) builder UI; (5) Flows.

**Complexity.** Large.

---

## V2-15 — White Label / SaaS polish, billing hooks, developer surface

**Goal.** Branding, partner workspaces, template library scopes, notifications drawer, audit log page, API keys and outbound webhooks, billing hooks.

**Exact scope.** `workspace_branding`, `organizations.parent_organization_id`, theme tokens from branding, partner library; `notifications` + bell; `audit_log` + page; API keys + outbound webhooks + event log; usage metering from rollups; Billing page only when a provider is integrated.

**Tests required.** Branding isolation per host; partner/child access rules; API key auth and scopes; webhook delivery retries and signing; cross-tenant.

**Acceptance criteria.** A partner can create a child workspace with its own branding; API key can list campaigns; outbound `message.received` delivered with signature.

**Dependencies.** Everything above.

**Commit boundaries.** (1) branding + theme; (2) partner workspaces; (3) notifications; (4) audit log; (5) API keys; (6) outbound webhooks; (7) billing hooks.

**Complexity.** Large.

---

## Appendix A — Cross-milestone checklists

**Before any engine-touching PR (V2-04, 06, 07, 08):**
- Stop the local api-server workflow before running the campaign suites (`.agents/memory/workflow-worker-races-tests.md`).
- Run: planning, frozen-template-mutation, lifecycle-races, lifecycle-bypass, rate-limit, duplicate-send-guard, failure-settlement, settlement-route-locks, crash-recovery, monitoring, plan-to-send, send-fidelity, suppression, cross-tenant.
- Record a benchmark with the same profile as the last retained result; compare within noise.

**Before any UI milestone PR:**
- No `mock-data.ts`; no control without a handler; every list has empty/loading/error states; mobile check at 375px; role check for hidden items.

**Before merging any milestone:**
- OpenAPI diff reviewed; codegen committed; `pnpm run typecheck` green; `replit.md` and affected ops docs updated; Definition of Done in Master Spec §56 satisfied.

## Appendix B — Assumptions requiring confirmation

1. The Replit connector remains the credential source for the currently real workspace during migration (V2-02 adapter).
2. Meta Embedded Signup app configuration (app id, config id, secret) will be provisioned by the operator; V2-12 is gated on it.
3. Object storage remains GCS via the Replit sidecar for media and exports; a public-link fallback is acceptable when Meta media upload is unavailable.
4. Roles may be renamed (`manager → campaign_manager`, `agent → inbox_agent`) with a compatibility map.
5. Removing sample data from existing workspaces is acceptable (rows are marked `is_sample`).
6. The `API_ROLE` split may change deploy units and the guard script in a later, separately approved deployment change; V2 only adds the switch and documentation.
7. Duplicate CSV rows may be stored (small storage cost) to make them exportable.
8. "Launch" combining plan and execute is acceptable as the only user-facing action.
