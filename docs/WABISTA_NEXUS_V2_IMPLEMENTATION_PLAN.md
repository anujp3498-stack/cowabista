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
| V2-05 | Rocket Audience + Message Studio | Uses eligibility for selection; lifts mapping/media restrictions; still on allocator v1 |
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

**Complexity.** Medium.

---

## V2-05 — Rocket Audience + Message Studio

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

**Acceptance criteria.** A 1-number × 3-template campaign and a 3-number × 1-template campaign both plan and send in mock mode; one uploaded image is used by every image template; preview equals sent parameters for a sampled contact.

**Regression risks.** Import path change (duplicate rows) affects row counts and metrics (`deduplicated` semantics must stay: count of duplicates); relaxing the setup freeze must keep plan supersession correct (covered by planning tests). Sender payload builder change for media ids.

**Dependencies.** V2-03, V2-04.

**What must NOT change.** Streaming parser; idempotency keys of Valid rows; frozen snapshot contract; resolver core.

**Commit boundaries.** (1) sniff + wizard shell + autosave; (2) duplicates + multi-session + freeze relaxation; (3) media assets + upload UI + Meta media id; (4) mapping model change + preflight rule; (5) Message Studio UI + preview; (6) setup relaxation; (7) presets + test send.

**Complexity.** Large.

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

**Acceptance criteria.** Equal by numbers: 300k / 3 senders ≈ 100k each with only compatible templates; equal by templates: 300k / 3 templates ≈ 100k each sent only by compatible senders; no route or job ever pairs an ineligible sender/template; throughput per sender never exceeds its cap with several templates.

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
