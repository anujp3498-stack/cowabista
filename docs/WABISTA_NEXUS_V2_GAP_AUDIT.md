# Wabista Nexus V2 — Gap Audit

Status: V2-00 deliverable
Baseline audited: branch `wabista-nexus-v2` at `d22a8e43bf0d36d1565c011aed77486767fb8318`
Companion documents: `WABISTA_NEXUS_V2_MASTER_SPEC.md`, `WABISTA_NEXUS_V2_UX_BLUEPRINT.md`, `WABISTA_NEXUS_V2_IMPLEMENTATION_PLAN.md`

Every statement below was checked against repository code on this baseline. File references use these prefixes:

- `api/` = `artifacts/api-server/src/`
- `ui/` = `artifacts/wabista-nexus/src/`
- `db/` = `lib/db/src/schema/`
- `spec` = `lib/api-spec/openapi.yaml`

Classification key:

| Class | Meaning |
|---|---|
| **REAL** | Backed by real persistence and real API behaviour |
| **PARTIAL** | Real core with significant missing pieces, or real data mixed with placeholder/demo behaviour |
| **MOCK** | Reads `ui/lib/mock-data.ts` or hardcoded values presented as data |
| **UI ONLY** | Controls rendered with no handler or no backend |
| **MISSING** | Does not exist in code |

Risk level = risk of breaking the proven engine while making the required change (Low / Medium / High).

---

## 0. Summary matrix

| # | Area | Class | Risk to change |
|---|---|---|---|
| 1 | Navigation / app shell / design system | REAL (shell) + UI ONLY (search, bell) | Low |
| 2 | Dashboard (Overview) | PARTIAL | Low |
| 3 | Inbox → Smart Inbox | MOCK + UI ONLY | Medium (new subsystem) |
| 4 | Chat management | MISSING | Medium |
| 5 | Contacts + Do-Not-Contact | REAL (basic) | Low |
| 6 | Campaigns (list, CRUD, lifecycle) | REAL | Low–Medium |
| 7 | Rocket (setup + page) | REAL (engine) / PARTIAL (product) | Medium |
| 8 | Template mapping (variables, media) | REAL with restrictions | Medium |
| 9 | Templates | PARTIAL | Medium |
| 10 | Numbers | PARTIAL | Medium |
| 11 | WhatsApp integration (connection) | PARTIAL | High (credential model) |
| 12 | Embedded Signup | MISSING | High |
| 13 | Monitoring → Flight Deck | PARTIAL | Medium |
| 14 | Analytics | REAL (unbounded queries) | Medium |
| 15 | Export | PARTIAL | Low–Medium |
| 16 | Webhooks (inbound Meta) | REAL (statuses + STOP) / MISSING (inbound messages, template/quality events) | Medium |
| 17 | Organizations / workspace | REAL (basic) | Low |
| 18 | RBAC | REAL (4 roles) | Low |
| 19 | CSV ingestion | REAL | Low |
| 20 | Frozen planning | REAL | High (do not weaken) |
| 21 | Failover | PARTIAL (cell failover REAL, route failover MISSING) | High |
| 22 | Recovery | MISSING (data exists) | Medium |
| 23 | delivery_unknown | REAL semantics / MISSING UI + endpoint | Medium |
| 24 | Redis | REAL | High (do not change semantics) |
| 25 | Realtime / SSE | MISSING (polling) | Medium |
| 26 | Automations / Flows | MOCK + UI ONLY | Low (nothing to preserve) |
| 27 | White Label | MISSING | Low |
| 28 | Authentication | REAL (Clerk) | Low |
| 29 | Billing | MOCK + UI ONLY | Low |
| 30 | Developer / API keys / outbound webhooks | MOCK + UI ONLY | Low |

---

## 1. Navigation, app shell and design system

**Current state.** A fixed 256px dark sidebar with two groups, "Operations" (10 items) and "Administration" (5 items), rendered by `ui/components/layout/shell.tsx:46-65`. The header has a workspace switcher (real), a search input with no state or handler (`shell.tsx:306-311`), and a notifications bell with a hardcoded blue dot and no handler (`shell.tsx:313-319`). No role-aware hiding: every member sees all 15 links. Mobile uses a `Sheet` for the sidebar (`shell.tsx:278-286`). Rocket Engine carries a "PRO" pill (`shell.tsx:110-114`).

Design tokens live in `ui/index.css`: Plus Jakarta Sans and JetBrains Mono (`:121-123`), blue-600 primary (`:104`), radius 0.5rem (`:124`), full dark-mode block (`:144-190`) with no toggle anywhere in the app. `index.html:17` also loads Inter, which nothing uses. The viewport meta sets `maximum-scale=1`.

Fifteen pages repeat the same page-header markup by hand (`text-3xl font-bold tracking-tight` h1). There is no shared PageHeader, no shared empty/loading/error component usage: `ui/components/ui/empty.tsx`, `skeleton.tsx`, `spinner.tsx`, `tabs.tsx`, `command.tsx`, `chart.tsx`, `form.tsx`, `input-otp.tsx` exist and have zero importers. Pages ignore `isError` from list hooks. Six ad-hoc status→badge-variant maps exist (campaign, route, phone, template, contact, job).

**Classification.** REAL (shell, switcher, routing) · UI ONLY (header search, bell) · Design system PARTIAL.

**Relevant files.** `ui/components/layout/shell.tsx`, `ui/App.tsx`, `ui/index.css`, `ui/index.html`, `ui/lib/campaign-status.ts`, `ui/components/ui/*`.

**Relevant functions.** `NavContent`, `WorkspaceSwitcher`, `UserCard`, `Shell`, `DashboardRouter`.

**Backend routes/services.** `GET /organizations`, `POST /organizations/:id/activate` (cookie `wabista_active_org_id`, `api/middlewares/auth.ts:13`), `GET /me`.

**Frontend components.** shadcn kit (in use: button, card, badge, input, dialog, label, select, table, alert-dialog, dropdown-menu, scroll-area, checkbox, separator, progress, radio-group, sheet, textarea, tooltip, toast).

**Reusable pieces.** The entire shadcn kit, the workspace switcher with hard-reload semantics (required by the cookie-resolved org, see `.agents/memory/org-switch-stale-cache.md`), `ErrorBoundary`, `use-toast`, the `success/warning/info` badge variants.

**Problems.**
- Sidebar is flat and engineering-shaped (Rocket Engine as a separate destination, Do-Not-Contact as a top-level item, Integrations separate from Numbers).
- Decorative controls (search, bell) violate the no-fake-UI rule.
- No `useActiveOrganization` hook: the `organizations?.find(o => o.isActive) ?? organizations?.[0]` lookup is copied in 5 files (`shell.tsx:200`, `pages/campaigns.tsx:221`, `pages/settings.tsx:19`, `pages/rocket-campaigns.tsx:669`, `pages/integrations.tsx:35`).
- Three different API-error extraction helpers (`ui/lib/api-errors.ts`, `rocket-campaigns.tsx:101-108`, `suppressions.tsx:142-144`).

**UX problems.** Console feel (dark sidebar, dark hero, PRO pill); no role awareness; tables overflow on mobile with no card fallback; 9-button action row on Rocket does not wrap.

**Scale risks.** None.

**Required changes.** New IA per UX Blueprint §5; `PageHeader`, `StatStrip`, `TechnicalDetails`, `DataTable` with card fallback; `useActiveOrganization`; one `statusChip` helper; remove decorative controls until real; theme toggle; remove Inter; remove `maximum-scale=1`.

**DB impact.** None. **API impact.** None. **Frontend impact.** Shell rewrite, page-header refactor across all pages. **Risk level.** Low.

---

## 2. Dashboard (Overview)

**Current state.** `ui/pages/overview.tsx` reads `useGetOverviewStats` and `useListCampaigns` (real) and renders `activityFeed` from `ui/lib/mock-data.ts:44-50` under the label "Sample data — activity logging isn't wired up yet" (`overview.tsx:122`), plus a promo card titled "STATUS: DEMO PIPELINE" stating that sending is "a visual demonstration in this milestone" (`overview.tsx:149-154`), which is no longer true.

Backend `GET /overview/stats` (`api/routes/overview.ts:14-69`) sums denormalised `campaigns.sent/delivered` and `campaign_routes.currentTps`. Line 27 filters `campaigns.status = "Active"`, a value that does not exist in the enum (`db/campaigns.ts:6-15`), so `activeCampaigns` is always 0. Because `seedDemoData` (`api/lib/orgProvisioning.ts:40-166`) inserts a sample campaign with `sent 96, delivered 90, read 61, failed 4` and a route with `currentTps 42`, a brand-new workspace's dashboard shows 96 messages sent, 93.8% delivery and 42 TPS of fabricated activity.

**Classification.** PARTIAL (real stats endpoint with a bug + mock feed + stale demo copy + seeded fake counters).

**Relevant files.** `ui/pages/overview.tsx`, `api/routes/overview.ts`, `api/lib/orgProvisioning.ts`, `ui/lib/mock-data.ts`.

**Relevant functions.** `getOverviewStats` handler, `seedDemoData`, `provisionPersonalOrganization`.

**Backend routes/services.** `GET /overview/stats`.

**Frontend components.** Stat cards, running campaigns list, activity feed.

**Reusable pieces.** `useListCampaigns` filtered to Running with progress bars; stat-card layout.

**Problems.** Wrong status filter; fake counters from sample data; mock activity feed; misleading copy; `currentTps` is never measured by the engine (see §13) so "TPS overall" is meaningless.

**UX problems.** Does not answer "what needs attention / what can I do now"; no action center; no onboarding checklist; no inbox summary.

**Scale risks.** Low today (reads denormalised counters). A "Today" strip needs a daily rollup, not a scan of `provider_messages`.

**Required changes.** New Home per UX Blueprint §9: quick actions, action center, today strip, running campaigns (from monitoring aggregates), WhatsApp health, onboarding checklist. Stop seeding fake counters (see §17). Fix the `Active` filter. Delete `activityFeed` usage.

**DB impact.** Optional `daily_message_rollups` (org, day, sent, delivered, read, failed, replies) maintained by the metric flusher/webhook path; or compute "today" from `campaign_metrics` deltas. **API impact.** New `GET /home/summary` (or extend overview) returning today counts, running campaigns, inbox counts, health alerts, onboarding state. **Frontend impact.** Replace page. **Risk level.** Low.

---

## 3. Inbox → Smart Inbox

**Current state.** `ui/pages/inbox.tsx` renders `threads` from `ui/lib/mock-data.ts:9-15`; the conversation pane is hardcoded (`inbox.tsx:86-130`), the composer, Send, Resolve, Profile and search have no handlers, and the thread pane is `hidden md:flex` so nothing opens on mobile. Backend: inbound WhatsApp messages are parsed only for opt-out keywords (`api/services/whatsapp-webhook.ts:88-124`, `OPT_OUT_KEYWORDS` at `:80`) and otherwise discarded. There is no conversations, inbound messages or outbound free-form messages table (`db/index.ts:1-12` exports none). The provider client has no free-form `text` send, only template send (`api/services/whatsapp-provider.ts:83-89`, `send()` posts whatever payload it is given; only `buildMetaTemplatePayload` exists in the sender, `whatsapp-template-sender.ts:106-148`).

**Classification.** MOCK + UI ONLY (frontend) · MISSING (backend).

**Relevant files.** `ui/pages/inbox.tsx`, `ui/lib/mock-data.ts`, `api/services/whatsapp-webhook.ts`, `api/routes/whatsapp-webhook.ts`, `api/services/whatsapp-provider.ts`.

**Relevant functions.** `parseWhatsAppOptOuts`, `processWhatsAppOptOut`, `parseWhatsAppStatuses`, `processWhatsAppStatus`.

**Backend routes/services.** `POST /webhooks/whatsapp` (raw body 2 MB, HMAC verified, `api/app.ts:111`, `api/routes/whatsapp-webhook.ts:29-44`).

**Frontend components.** None reusable beyond layout ideas.

**Reusable pieces.** Webhook receiver with signature verification and idempotent `provider_events`; per-message advisory lock pattern; `provider_messages` linking a wamid to a campaign job (this is what makes campaign attribution of replies possible: an inbound `context.id` referencing a wamid can be joined to `provider_messages.providerMessageId`).

**Problems.** Nothing inbound is stored; STOP handling resolves the tenant by `phone_numbers.providerPhoneId` with `limit(1)` and no org predicate (`whatsapp-webhook.ts:133-135`); manual numbers (null `providerPhoneId`) cannot receive at all; no 24-hour session window tracking; no free-form send; no media download.

**UX problems.** A fully fake inbox is the largest violation of the no-fake-data rule in the product.

**Scale risks.** Conversations must be keyset-paginated per org and per number; message bodies must not be loaded in bulk; inbound media must go to object storage, never inline.

**Required changes.** New subsystem: `conversations`, `messages` (inbound + outbound free-form + campaign-originated), `conversation_assignments`, `conversation_notes`, `conversation_tags`; webhook branch storing every inbound message with contact resolution, originating number, WABA, campaign/template attribution via `context.id → provider_messages`; free-form send path with 24-hour window check; session-window tracking; agent reply-from locked to the conversation's number.

**DB impact.** New tables (see Master Spec §10). **API impact.** New `/inbox/*` endpoints (list with keyset, get, send, assign, tag, snooze, resolve, notes). **Frontend impact.** New three-pane page. **Risk level.** Medium (new subsystem; must not touch campaign send path except reading `provider_messages`).

---

## 4. Chat management (Chat Manager)

**Current state.** Nothing exists. No assignment model, no team model, no agent presence.

**Classification.** MISSING.

**Relevant files.** None. Roles come from `organization_members.role` (`db/organization-members.ts:14-21`, four roles: owner, admin, manager, agent).

**Reusable pieces.** Members list and role model; `requireRole` middleware.

**Problems.** No teams; no per-number routing; no agent inbox.

**Required changes.** `teams`, `team_members`, `number_assignments` (number → team/agent, mode manual), conversation assignment fields, internal notes, priority, snooze. Auto-assignment modes deferred.

**DB impact.** New tables. **API impact.** New endpoints. **Frontend impact.** Chat Manager tab in Smart Inbox. **Risk level.** Medium.

---

## 5. Contacts and Do-Not-Contact

**Current state.** `ui/pages/contacts.tsx` is real: server-side pagination (25/page, `useListContacts({search, limit, offset})`), 300 ms debounced search, create/edit/delete. Backend `GET /contacts` (`api/routes/contacts.ts:25-82`) clamps `limit` to 100, uses trigram GIN indexes on name/phone/email (`db/contacts.ts:39-44`) and `count(*) over()` for totals. Fields: name, phone, email, tags[], status (Active/Inactive/Unsubscribed), source, lastContactedAt, isSample. Phone is not normalised on create. There is no bulk import into `contacts` (the only CSV import is campaign-scoped, §19), no custom fields, no segments, no campaign/conversation history, no bulk actions.

Suppressions (`ui/pages/suppressions.tsx`, `api/routes/suppressions.ts`): real, offset paginated, but search fires per keystroke (no debounce) and the backend has no trigram index on `normalized_phone` and runs a separate count query. STOP replies write to `suppressions`, not to `contacts.status`.

**Classification.** REAL (basic CRM) · MISSING (custom fields, segments, history, bulk import).

**Relevant files.** `ui/pages/contacts.tsx`, `ui/pages/suppressions.tsx`, `api/routes/contacts.ts`, `api/routes/suppressions.ts`, `db/contacts.ts`, `db/campaign-engine.ts:81-87` (suppressions).

**Relevant functions.** `listContacts`, `createContact`, `normalizePhone` (`api/services/contact-processing.ts:3-14`).

**Backend routes/services.** `/contacts` CRUD, `/suppressions` CRUD.

**Frontend components.** Contacts table, `ContactFormDialog`, suppressions table.

**Reusable pieces.** Pagination + trigram search pattern (`.agents/memory/list-page-scale-pattern.md`), `normalizePhone`, suppression upsert semantics.

**Problems.** No normalised phone on `contacts` (dedupe against campaign recipients is impossible today); no link from `campaign_contacts` to `contacts`; no custom fields; suppression search unindexed.

**UX problems.** No import CTA on the Contacts page (import lives only inside Rocket); no bulk actions; no contact drawer with history.

**Scale risks.** Offset pagination on `contacts` degrades at millions of rows; must move to keyset for deep pages. Suppressions ILIKE without trigram index is a sequential scan.

**Required changes.** Add `normalized_phone` (unique per org), `custom_fields jsonb`, `opted_out_at`; global streaming import reusing the campaign CSV parser; keyset pagination; contact drawer with campaign/conversation history (joins on `campaign_contacts.normalizedPhone` and `conversations.contact_id`); bulk tag/suppress/export; trigram index on suppressions.

**DB impact.** Columns on `contacts`, `contact_import_sessions` generalised to org-level, `contact_fields` definitions table, index on suppressions. **API impact.** `POST /contacts/imports` (streaming), keyset params, bulk endpoints. **Frontend impact.** Contacts page with tabs and drawer. **Risk level.** Low.

---

## 6. Campaigns (list, CRUD, lifecycle)

**Current state.** `ui/pages/campaigns.tsx` lists all campaigns with client-side name filtering and no pagination (`useListCampaigns()` with no params). The create/edit dialog lets a user type Status (all 8 values, `campaigns.tsx:123-130`) and Sent/Delivered/Read/Failed counters (`:158-202`); the backend rejects status changes via PATCH ("Use the campaign actions endpoint", `api/routes/campaigns.ts:132-135`) but accepts the counters. Lifecycle actions (Plan, Execute, Pause, Resume, Cancel, emergency-kill) go through the shared `useCampaignLifecycle` hook (`ui/hooks/use-campaign-lifecycle.ts`) and `POST …/actions` (`api/routes/campaign-engine.ts:137`). The readiness checklist is only on the Rocket page; the Campaigns page shows readiness errors after the fact via `CampaignNotReadyDialog`. Contact import is reachable only from the Rocket page (`rocket-campaigns.tsx:1264-1269`).

Lifecycle is robust: transitions are serialised by a session-level advisory lock (`api/services/campaign-planning.ts:67-80`), retry-safe (settled-state no-op, `campaign-engine.ts:106-112, 222-225`), scheduled campaigns start from housekeeping (`api/services/campaign-runtime.ts:273-301`), completion is detected by `completeIfDrained` (`api/services/campaign-queue.ts:881-931`), and every transition writes `campaign_audit`.

**Classification.** REAL (engine and lifecycle) · PARTIAL (product surface).

**Relevant files.** `ui/pages/campaigns.tsx`, `ui/hooks/use-campaign-lifecycle.ts`, `ui/lib/campaign-status.ts`, `ui/components/campaigns/*`, `api/routes/campaigns.ts`, `api/routes/campaign-engine.ts`, `api/services/campaign-planning.ts`, `api/services/campaign-runtime.ts`.

**Relevant functions.** `transitionCampaign` handler, `withCampaignLifecycleLock`, `planCampaign`, `executeCampaignPlan`, `activateDueCampaigns`, `completeIfDrained`, `reconcileCampaignJobs`.

**Backend routes/services.** `/campaigns` CRUD, `POST …/actions`, `GET …/readiness`, `GET …/plan`, `POST …/plan/preview`, `POST …/plan/recipients`.

**Frontend components.** `CampaignFormDialog`, `CampaignPlanDialog`, `CampaignNotReadyDialog`, `CampaignMessagesDialog`, `TemplateMappingDialog`, `ContactImportDialog`.

**Reusable pieces.** All of the lifecycle backend; the shared hook + dialog trio (`.agents/memory/wabista-shared-campaign-lifecycle.md`); `CampaignPlanDialog` content as the "Details" tab; the audit table.

**Problems.** Editable runtime counters and status in a form; no server pagination; "Plan" and "Execute" are exposed as two user-facing buttons; no clone; no campaign detail page (everything is dialogs); `campaigns.sent/delivered/read/failed` are denormalised copies that reconciliation overwrites (`api/services/campaign-reconciliation.ts:83-84`).

**UX problems.** Campaign is not a place; it is a row with 10 menu items. No progress, ETA, or speed in the list.

**Scale risks.** Unpaginated list; per-row `routesCount` join is fine.

**Required changes.** Campaign detail page with tabs; single Launch action that runs plan then execute; server pagination + filters; remove counter/status inputs; clone endpoint (copies routes, selections, mappings, delivery settings; not contacts unless asked).

**DB impact.** `campaigns` gains `delivery_mode`, `distribution_mode`, `timezone`, `cloned_from_id`, `preset_id` (nullable). **API impact.** `GET /campaigns` paged envelope; `POST …/clone`; `launch` action (server-side plan+execute under the same lock). **Frontend impact.** New list + detail pages. **Risk level.** Low–Medium (the lock and transition map must not change).

---

## 7. Rocket (setup and page)

**Current state.** `ui/pages/rocket-campaigns.tsx` (1,301 lines) is a single scrolling page, not a wizard: a static hero ("1.2M Contacts" hardcoded at `:852`, "LIVE" claim at `:845`), campaign cards with readiness, monitoring and nine action buttons, route cards, and dialogs. `RocketSetupDialog` (`:269-494`) selects a campaign, Connected numbers with a per-number TPS input capped at `tpsLimit`, Approved templates, and priority; it requires numbers ≥ templates (`:298`) and auto-opens the mapping dialog on success (`:771`). `RouteFormDialog` (`:496-663`) exposes raw inputs for `currentTps` and `queueDepth`.

Backend `PUT …/rocket-setup` (`api/routes/campaign-routes.ts:238-461`): validates unique numbers/templates, `numbers.length >= templates.length` (`:263-267`), Connected phones with a WABA and TPS ≤ cap, Approved templates; creates **one route per number**, rotating templates `templateIds[(index + offset) % T]` and skipping templates whose `wabaId` differs from the phone's (`:366-377`); 409 if a number has no compatible template or a template is left unused; deletes and recreates routes and selections; resets campaign to Draft. It does not create mappings; `PUT …/template-mappings` replaces selections again from its own `templateIds` (`campaign-engine.ts:712-726`).

**Classification.** REAL (setup endpoint, routes, readiness) · PARTIAL (product: no wizard, no audience step, no delivery modes, no preflight page).

**Relevant files.** `ui/pages/rocket-campaigns.tsx`, `api/routes/campaign-routes.ts`, `api/services/campaign-preflight.ts`, `api/services/campaign-planning.ts`.

**Relevant functions.** `configureRocketCampaign` handler, `validateCampaignReady`, `planCampaign`, `assignRoute`, `partitionFor`.

**Backend routes/services.** `PUT …/rocket-setup`, `/campaign-routes` CRUD, `GET …/readiness`.

**Frontend components.** `RocketSetupDialog`, `RouteFormDialog`, `CampaignReadinessChecklist`, `CampaignMonitoringPanel`.

**Reusable pieces.** Setup validation rules (Connected, WABA present, TPS ≤ cap, Approved); readiness polling; the one-route-per-number invariant (`.agents/memory/rocket-one-route-per-number.md` explains why a Cartesian product would multiply TPS).

**Problems.**
- `numbers >= templates` and template rotation make "equal by templates" impossible and force the number of templates to be at most the number of numbers.
- No sender→eligible-template model: compatibility is a `wabaId` equality with a null bypass (§20).
- Routes and setup are frozen once any import exists (`campaign-routes.ts:293-307`), so the wizard order must be setup before import, the opposite of a natural Audience→Message flow.
- `campaign_routes.priority` is written but never read by the claim path; `campaigns.priority` is the tie-breaker (`campaign-queue.ts:517`).
- Users can edit `currentTps`/`queueDepth` through `PATCH /campaign-routes` (`CampaignRouteUpdate`, spec `:1623-1633`).

**UX problems.** Not a wizard; TPS is the primary vocabulary; the hero is fake; nine buttons per campaign; setup and mapping are two dialogs that both own "template selection".

**Scale risks.** None in setup itself.

**Required changes.** Rocket V2 wizard (Audience → Message → Delivery → Review) built on the existing endpoints plus: a compatibility endpoint, distribution mode, delivery mode, and a `launch` action. Relax the "import before setup" ordering by allowing setup changes while Draft even after import, provided allocations are recomputed at plan time (they already are: plan supersedes and re-allocates, `campaign-planning.ts:197-276`), while keeping the freeze after Plan. Remove `currentTps`/`queueDepth` from the update schema.

**DB impact.** See §6 and §20. **API impact.** `GET /campaigns/:id/compatibility`, extended rocket-setup body, `launch` action. **Frontend impact.** New wizard. **Risk level.** Medium.

---

## 8. Template mapping (variables and media)

**Current state.** Mapping records are `{templateId, component: header|body|button, variable, source: csv|static, sourceValue, optional, fallbackValue}` (`api/services/template-mapping.ts:7-18`; unique per campaign/template/component/variable, `db/campaign-engine.ts:105`). Required variables come from `describeTemplate` (`template-mapping.ts:25-43`): positional `{{n}}` only, `header:media` for image/video/document headers, `header:n`, `button:idx:n`.

`PUT …/template-mappings` (`campaign-engine.ts:645-744`) runs `expandCompatibleMappings` (`template-mapping.ts:91-140`): for every requirement key shared by two or more selected templates (including `header:media` via `expandSharedMediaMapping`, `:45-79`), all supplied mappings must be identical or the request fails with "Compatible templates must use one shared mapping for body:1" / "Compatible media templates must use one shared header media mapping". The frontend mirrors this with one row per requirement key across all selected templates (`ui/components/campaigns/template-mapping-dialog.tsx:133-143`).

Preflight rejects campaigns whose selected templates have more than one non-`none` header kind (`api/services/campaign-preflight.ts:68-69`): image + video, image + document and image + text-header are all blocked; image + no-header is allowed. The mapping report's `compatible` flag is this header-kind rule, not WABA compatibility (`campaign-engine.ts:620-625`).

Header media is sent as `{type: "image", image: {link}}` only (`api/services/whatsapp-template-sender.ts:116-121`). The value is whatever the `header:media` mapping resolves to. The dialog asks for a URL string ("Header media (image/video/document URL)", `ui/lib/template-variables.ts:58`). The image upload endpoint (`api/routes/campaign-media.ts`, signed GCS PUT via the Replit sidecar, `api/lib/object-storage.ts`) returns an `objectPath` of `/objects/...` that no route serves and no UI code calls (repository grep: only the generator and the generated client).

**Classification.** REAL (mapping, resolution, shared media) with **unnecessary restrictions** · PARTIAL (media upload orphaned).

**Relevant files.** `api/services/template-mapping.ts`, `api/services/template-resolution.ts`, `api/services/campaign-preflight.ts`, `api/routes/campaign-engine.ts:598-744`, `api/routes/campaign-media.ts`, `api/lib/object-storage.ts`, `ui/components/campaigns/template-mapping-dialog.tsx`, `ui/lib/template-variables.ts`.

**Relevant functions.** `describeTemplate`, `extractVariables`, `expandSharedMediaMapping`, `expandCompatibleMappings`, `resolveTemplateVariables`, `resolveJobTemplates`, `mappingReport`, `buildMetaTemplatePayload`.

**Backend routes/services.** `GET/PUT …/template-mappings`, `POST …/template-mapping-image-upload`.

**Frontend components.** `TemplateMappingDialog`.

**Reusable pieces.** Everything about resolution: the frozen `mappingsSnapshot`, the pure `resolveTemplateVariables` core shared by live send and plan preview (`.agents/memory/wabista-support-recipient-visibility-scope.md`), optional/fallback semantics, CSV column validation against the latest completed import (`campaign-preflight.ts:83-96`).

**Problems (restrictions to lift).**
1. **Forced sharing by positional key.** Template A `{{1}}` = first name and template B `{{1}}` = city cannot coexist. The rule is a convenience default that became a hard constraint.
2. **Mixed header kinds blocked.** Image + video templates cannot share a campaign even though each has its own `header:media` mapping.
3. **Media is a URL string.** No upload from the wizard; the upload endpoint is dead; the object path is not publicly fetchable, so it could not be used as `link` anyway.
4. Only `link` media; no Meta media id (`/{phone}/media`) path, which is needed for private media and for template creation (`h:` handle).
5. Named parameters, LOCATION headers, currency/date_time, quick-reply payloads, copy-code, carousel and Flow buttons are unsupported by `buildMetaTemplatePayload`.

**UX problems.** No WhatsApp-style preview; mapping is a flat list keyed by `body:1`; "Used by: T1, T2" is the only hint that a value is shared.

**Scale risks.** None.

**Required changes.**
- Mapping model: keep the shared default but make it an explicit "shared mapping group" with per-template overrides; drop the "must be identical" throw and instead store one row per (template, component, variable) as today, populated from shared groups by the client.
- Preflight: replace the single-header-kind rule with "every selected media template has a media mapping of its own kind".
- Media: a `campaign_media` (or `media_assets`) table; upload through the existing signed-URL flow; serve or proxy the object publicly (or upload to Meta `/media` and send by id); one asset reusable by all compatible templates in the campaign; media kind validated against template header kind.
- Payload builder: named params, LOCATION, quick-reply/copy-code buttons as needed by Template Studio.

**DB impact.** `media_assets` table; mapping table gains `media_asset_id` (nullable). **API impact.** Mapping PUT accepts `mediaAssetId`; new media asset endpoints; preflight rule change. **Frontend impact.** Message Studio in Rocket step 2. **Risk level.** Medium (touches preflight and the sender payload builder; must keep the frozen snapshot contract).

---

## 9. Templates

**Current state.** `ui/pages/templates.tsx` is local CRUD: name, category, language (free text), **status select with Approved/Pending/Rejected** (`:136-149`), body textarea; no components editing, no sync button, raw-body preview. Backend `api/routes/templates.ts` is local CRUD too; `TemplateInput`/`TemplateUpdate` accept `status` (spec `:1527-1543`) and the routes persist it verbatim (`templates.ts:49, 73`). `PATCH` does `.set(body.data)` wholesale, so a synced template's name/language/body can be rewritten locally. `DELETE` is fenced only against `campaign_allocations` references (`:110-117`).

Sync (`api/services/whatsapp-sync.ts:139-166`) upserts on `(organizationId, providerTemplateId)` with `wabaId, name, language, category, status, body, components`. The Graph call requests `id,name,language,category,status,components` (`api/services/whatsapp-provider.ts:207`), not `rejected_reason` or `quality_score`. `templateStatus()` title-cases whatever Meta returns (`whatsapp-sync.ts:42-45`), producing `Paused`, `Disabled`, `In_appeal`, `Pending_deletion`, while the API response schema is a strict enum `[Approved, Pending, Rejected]` (spec `:1513`) parsed on every `GET /templates` (`templates.ts:31`), so one PAUSED template makes the whole list endpoint fail. There is no template create/submit/delete to Meta, and `message_template_status_update` webhooks are not handled.

**Classification.** PARTIAL (sync REAL; authoring MISSING; status integrity broken).

**Relevant files.** `ui/pages/templates.tsx`, `api/routes/templates.ts`, `api/services/whatsapp-sync.ts`, `api/services/whatsapp-provider.ts`, `db/templates.ts`, `spec :1505-1545`.

**Relevant functions.** `syncWhatsApp`, `templateStatus`, `category`, `listTemplates`, `describeTemplate`.

**Backend routes/services.** `/templates` CRUD, `POST …/whatsapp/sync`.

**Frontend components.** `TemplateFormDialog`, template cards.

**Reusable pieces.** Sync upsert keyed by provider id; raw `components` storage; `describeTemplate`; the `campaign_allocations` delete fence; `templatesSnapshot` freezing (so template edits after plan cannot change sends, tested by `test/campaign-frozen-template-mutation.test.ts`).

**Problems.** Fake approval is possible; strict enum vs. title-cased Meta statuses; no rejection reason; no authoring; sync never deletes; `body` column can diverge from `components`; manual templates have null `wabaId` (bypasses affinity, §20).

**UX problems.** Status dropdown invites users to lie to the engine; no preview; no "which numbers can send this".

**Scale risks.** None.

**Required changes.** Template Studio: status is read-only and Meta-owned; `status` accepted as Meta's raw enum incl. PAUSED/DISABLED/IN_APPEAL; `rejected_reason` and `quality_score` fetched; `POST /{waba}/message_templates` create/submit, delete, with resumable media upload for header samples; drafts table; library; per-number eligibility derived from `wabaId` (§20); webhook `message_template_status_update` handled; local-only templates flagged `source = local` and never Approved by hand.

**DB impact.** `templates` gains `rejected_reason`, `quality_score`, `source (meta|local|draft)`, `submitted_at`; new `template_drafts`, `template_library_items`. **API impact.** Status enum widened; create/submit/delete-to-Meta endpoints; local status write removed. **Frontend impact.** Template Studio. **Risk level.** Medium (status enum change touches the send gate at `whatsapp-template-sender.ts:301`).

---

## 10. Numbers

**Current state.** `ui/pages/phone-numbers.tsx` form asks for Phone, Display Name, WABA ID (placeholder `waba_9x8a7b`), Quality (select), Status (select Connected/Flagged/Pending), Provider (free text), TPS Limit (`:108-196`). Backend `POST /phone-numbers` (`api/routes/phone-numbers.ts:80-110`) calls no provider API; `providerPhoneId` cannot be set; a manually added number therefore has `providerPhoneId = null` and every real-mode send throws "Sending phone number has no synchronized provider ID" (`whatsapp-template-sender.ts:456-458`). `tpsLimit > 50` needs a synced `approvedTpsLimit` (`phone-numbers.ts:20, 91-96, 135-147`). Sync (`whatsapp-sync.ts:99-138`) upserts on `(organizationId, providerPhoneId)` with quality (RED→Low, YELLOW→Medium, else High), status (`Connected` iff `code_verification_status === "VERIFIED"` else `Pending`), and `providerMetadata {qualityRating, verificationStatus, throughputLevel, approvedTpsLimit}`. **The Graph request omits `throughput`** (`whatsapp-provider.ts:203`), so `throughputLevel` is always `STANDARD` and the approved cap is pinned at 80 in real mode; a HIGH-tier number can never unlock 1000.

No verification (`request_code`/`verify_code`), no registration (`/register` with PIN), no display-name status, no `messaging_limit_tier`, no per-number disconnect from Meta. Route cards on the Rocket page show `WABA: <external id>`.

**Classification.** PARTIAL (sync REAL; onboarding and state machine MISSING).

**Relevant files.** `ui/pages/phone-numbers.tsx`, `api/routes/phone-numbers.ts`, `api/services/whatsapp-sync.ts`, `api/services/whatsapp-provider.ts`, `db/phone-numbers.ts`, `db/wabas.ts`.

**Relevant functions.** `syncWhatsApp`, `approvedTpsLimitFor`, `resolveWabaId`, `listPhoneNumbers` (provider).

**Backend routes/services.** `/phone-numbers` CRUD, `POST …/whatsapp/sync`, `GET …/whatsapp/wabas`.

**Frontend components.** `PhoneNumberFormDialog`, numbers table.

**Reusable pieces.** Sync upsert with metadata rewrite each sync (the fix from `.agents/memory/wabista-phone-tps-approved-cap.md` is present at `whatsapp-sync.ts:130-134`); the approved-cap gate; `wabas` table; `phone_numbers_org_provider_id_uq`.

**Problems.** Manual add is useless in real mode; throughput never fetched; status/quality are user-editable facts; duplicate rows when a manual number is later synced; `Flagged` is user-only; dead schema file `db/whatsapp-business-accounts.ts` (not exported, duplicate symbol names).

**UX problems.** Asks for a WABA ID up front; exposes status/quality/provider/TPS as inputs; no setup guidance; no health.

**Scale risks.** None.

**Required changes.** Number setup state machine (`setup_state`), discovery from phone + token (per-org credential, §11), verification and registration flows calling `request_code`, `verify_code`, `register`; fetch `throughput`, `name_status`, `messaging_limit_tier`, `status`; remove user-editable status/quality; Technical Details drawer; Connect Number dialog with two paths.

**DB impact.** `phone_numbers` gains `setup_state`, `setup_error`, `name_status`, `messaging_limit_tier`, `last_health_at`, `credential_id`; `is_sample` remains. **API impact.** `POST /phone-numbers/discover`, `POST /phone-numbers/:id/request-code`, `/verify-code`, `/register`, `/sync`, `/disconnect`; PATCH loses status/quality. **Frontend impact.** Number Center. **Risk level.** Medium.

---

## 11. WhatsApp integration (connection and credentials)

**Current state.** There is exactly one credential: the Replit connector named `whatsapp-business`, used through `@replit/connectors-sdk` proxy calls (`api/services/whatsapp-provider.ts:154-158`). `provider_connections` (`db/provider-integration.ts:17-37`) has no token column; it stores `mode (mock|real)`, `connectorAccountId` (the Graph `/me` id of the shared token), `configuredWabaExternalId`, status/health/lastError. Partial unique indexes on `(provider, connectorAccountId)` and `(provider, configuredWabaExternalId)` where `mode='real'` mean **only one workspace in the deployment can be in real mode**; enabling it is owner-only (`api/routes/whatsapp-integration.ts:68-74`). `replit.md:44` documents this as intentional for the Replit deployment.

Connect flow: Integrations page → mode Real + typed WABA External ID → backend verifies by `identity()`, `listPhoneNumbers(waba)`, `listTemplates(waba)` → `wabas` row → user clicks Sync Resources → all numbers and templates of that one WABA are imported. Health = `GET /me` succeeds (`whatsapp-integration.ts:130-152`); webhook health = env-var presence. No periodic sync or health.

**Classification.** PARTIAL (real Graph integration, but single-tenant credential model).

**Relevant files.** `api/routes/whatsapp-integration.ts`, `api/services/whatsapp-provider.ts`, `api/services/whatsapp-sync.ts`, `db/provider-integration.ts`, `ui/pages/integrations.tsx`.

**Relevant functions.** `RealWhatsAppProviderClient.request/identity/health/listPhoneNumbers/listTemplates/send`, `providerClient(mode)`, `getOrCreateProviderConnection`, `syncWhatsApp`.

**Backend routes/services.** `GET/PATCH …/whatsapp/integration`, `GET …/whatsapp/health`, `POST …/whatsapp/sync`, `GET …/whatsapp/wabas`.

**Frontend components.** Integrations page (mode select, WABA id input, health card, sync, WABAs table).

**Reusable pieces.** `WhatsAppProviderClient` interface and error classification (`classifyProviderError`, `ProviderRequestError` with `retryable`), paging helper, redaction, the mock client, the real-mode claim check inside the sender (`whatsapp-template-sender.ts:287-304`), the `wabas` table.

**Problems.** Multi-tenant SaaS is impossible with one shared token; no per-org/per-WABA credential storage; no token encryption layer; no token expiry/refresh tracking; `/v23.0` hardcoded in three places; no `app_secret_proof`; no `subscribed_apps` management.

**UX problems.** Users type a WABA ID; mode "mock/real" is exposed as a product concept; health is a token ping.

**Scale risks.** None.

**Required changes.** Per-workspace credentials: `whatsapp_credentials` (org, waba external id, encrypted token, token type system-user/embedded-signup, scopes, expires_at, status, last_verified_at). Provider client factory keyed by credential instead of a global connector; keep the Replit connector as one credential source for the existing deployment (migration path). Encryption via a KMS-style envelope key from env (name only). Health per credential and per number, run periodically by a lightweight scheduler in the API process (not the transport cell), storing `last_health_at`. Remove the single-real-org uniqueness once credentials are per org.

**DB impact.** New `whatsapp_credentials`; `provider_connections` retained for mock/real mode per org but decoupled from the shared connector; `wabas.credential_id`; `phone_numbers.credential_id`. **API impact.** Credential endpoints (create from token, replace, revoke), health endpoints. **Frontend impact.** Connect Number flows; Meta Health page. **Risk level.** High (the sender's real-mode claim check and every Graph call depend on the client factory; must be done behind an interface with the existing tests kept green).

---

## 12. Embedded Signup

**Current state.** Absent. Repository-wide search for Facebook SDK, `FB.login`, `connect.facebook.net`, OAuth code exchange or `/oauth/access_token` finds nothing (only Clerk's own OAuth for user login and comment links to Meta docs).

**Classification.** MISSING.

**Required changes.** Frontend: Facebook JS SDK loader + `FB.login` with `config_id` for WhatsApp Embedded Signup, receiving `code` and the session-info `waba_id`/`phone_number_id` message event. Backend: exchange `code` for a business token via Graph `/oauth/access_token` (app id + app secret from env, names only), store as a `whatsapp_credentials` row, `subscribed_apps` on the WABA, discover all WABAs and numbers, return the selection list. Selection screen owned by Wabista (multi-select), then per-number registration as needed.

**DB impact.** `whatsapp_credentials`, `embedded_signup_sessions` (state nonce, org, status). **API impact.** `POST /whatsapp/embedded-signup/start` (returns config + state), `POST /whatsapp/embedded-signup/complete` (code exchange + discovery), `POST /whatsapp/embedded-signup/select` (connect chosen numbers). **Frontend impact.** Connect with Meta path. **Risk level.** High (new external auth surface; must be built after §11).

---

## 13. Monitoring → Flight Deck

**Current state.** `GET …/monitoring` (`api/routes/campaign-engine.ts:1021-1139`) returns the `campaign_metrics` row plus `pending`, `delayedRetries`, `staleLeases`, `deliveryUnknown`, `throttledRoutes`, `reconciliationRuns`, `effectiveConfiguredTps`, `estimatedCompletionAt`, and `routes[]` with `configuredTps, currentTps, queueDepth, status, sent, failed, errorReasons`. The `routes[]` block is computed by scanning every job of the campaign per call (`:1034-1069`). Counters are fed by append-only `campaign_metric_deltas` (`db/campaign-engine.ts:259-276`) flushed every 200 ms (`campaign-runtime.ts:316-323`) and by webhook increments (`whatsapp-webhook.ts:258-271`).

`currentTps` is never measured: the engine only ever writes 0 (`campaign-engine.ts:259`, `campaign-routes.ts:390`) and PATCH can set it. Route status `Throttled`/`Error` has no production writer (only read at `campaign-runtime.ts:335` and `campaign-engine.ts:1085,1131`), so `throttledRoutes` is always 0 unless PATCHed. `pending = valid − sent − failed` double-counts webhook failures (a job that is `Sent` and later fails by webhook increments `failed` again), and reconciliation later discards webhook failures because it sets `failed = count(status='Failed')` (`campaign-reconciliation.ts:39-70, 83-84`). In-process dispatch metrics (`campaign-dispatch-metrics.ts`, `runtime.phoneLaneMetrics()`) are not exposed over HTTP.

Frontend `CampaignMonitoringPanel` polls every 4 s while Running (`rocket-campaigns.tsx:128-137`) and shows settled/valid, queued, delivered, failed, effective TPS, throttled routes, stale leases and top-2 error reasons. It does **not** render `routes[]` or `estimatedCompletionAt`. There is no charts, no per-number view, no ETA, no elapsed time.

**Classification.** PARTIAL.

**Relevant files.** `api/routes/campaign-engine.ts:1021-1139`, `api/services/campaign-dispatch-metrics.ts`, `api/services/campaign-runtime.ts`, `api/services/campaign-reconciliation.ts`, `ui/pages/rocket-campaigns.tsx:116-199`.

**Relevant functions.** `getCampaignMonitoring` handler, `flushCampaignMetricDeltas`, `reconcileCampaignJobs`, `phoneLaneMetrics`.

**Backend routes/services.** `GET …/monitoring`, `GET /healthz`.

**Frontend components.** `CampaignMonitoringPanel`.

**Reusable pieces.** The metrics-delta design (hot path never touches the aggregate row); `campaign_metrics` as the aggregate source; `estimatedCompletionAt` formula; `errorReasons` histogram; the monitoring regression test (`test/campaign-monitoring.test.ts`).

**Problems.** No actual TPS; `routes[]` full scan; failure double-count; no separation of job failures vs. delivery failures vs. delivery unknown in one model; no time series.

**UX problems.** Engineering metrics (stale leases) are the headline; no ETA/elapsed; no per-number lanes; no pause/resume in context; no charts.

**Scale risks.** `routes[]` scan on every poll at 20M jobs is a multi-second query; polling at 4 s × N open tabs multiplies it.

**Required changes.** Measured throughput: have the runtime publish per-phone/per-campaign 1-second counters (provider starts, successes, failures) into Redis (short TTL) or a `campaign_throughput_samples` ring, aggregated for the API; route stats from per-route counters in `campaign_metric_deltas` (add `route_id` and `delivered/read/unknown` deltas) instead of scanning jobs; separate `failed_send`, `failed_delivery`, `delivery_unknown`, `retrying` counters; ETA from measured rate with a fallback to configured rate; SSE (§25).

**DB impact.** `campaign_metric_deltas` gains `route_id`, `delivered_delta`, `read_delta`, `unknown_delta`; new `campaign_throughput_samples` (campaign, route, second, starts, sent, failed) with retention. **API impact.** Monitoring response gains `actualTps`, `elapsedMs`, `series[]`, per-route `actualTps/health`; new SSE endpoint. **Frontend impact.** Flight Deck. **Risk level.** Medium (adds writes to the hot path; must be batched exactly like existing deltas, see `.agents/memory/hot-ledger-parent-fk-locks.md`).

---

## 14. Analytics

**Current state.** Real, contrary to `replit.md:46,50` and the comment in `ui/lib/mock-data.ts:6-7`. `ui/pages/analytics.tsx` uses `useGetAnalyticsSummary`, `useGetDeliveryTrends({days: 30})`, `useGetRouteHealth` and renders recharts with hardcoded hex colours (`:117-120,149`), ignoring the `--chart-*` tokens and the `ui/chart.tsx` wrapper.

Backend (`api/routes/analytics.ts`): `summary` counts every `provider_messages` row for the org with no date bound (`:31-39`); `delivery-trends` groups `provider_messages` by day and `provider_events` by day and event type over the last N days (1..90); `provider_events` has no `organization_id` index (`db/provider-integration.ts:84-85` define only `(provider, providerEventId)` and `(provider, providerMessageId)`), so that leg is a sequential scan of the events table per request; `route-health` runs two four-way joins over all history. No caching, no rollups. `test/analytics.test.ts` exists but is not wired into any package script.

**Classification.** REAL (unbounded).

**Relevant files.** `api/routes/analytics.ts`, `ui/pages/analytics.tsx`, `db/provider-integration.ts`.

**Relevant functions.** `getAnalyticsSummary`, `getDeliveryTrends`, `getRouteHealth` handlers.

**Reusable pieces.** Endpoint shapes; `provider_events` as the delivery/read source of truth; the test file.

**Problems.** Full-history scans; missing org/time index on `provider_events` and `(organization_id, accepted_at)` on `provider_messages`; business analytics and operational analytics are one page; no template performance; no replies (no inbound storage).

**UX problems.** Page is a chart dump; no date range picker; hardcoded colours break dark mode.

**Scale risks.** High at the engine's target scale: every dashboard load re-aggregates millions of rows.

**Required changes.** Daily rollup table maintained incrementally (`analytics_daily`: org, day, campaign_id, template_id, phone_number_id, sent, delivered, read, failed, replies) fed by the metric flusher and webhook processors; indexes on raw tables for ad-hoc drill-down; date range param; separate Operations tab (Admin+) sourced from monitoring/throughput samples; charts via `ui/chart.tsx` tokens.

**DB impact.** `analytics_daily`; indexes `provider_events(organization_id, occurred_at)`, `provider_messages(organization_id, accepted_at)`. **API impact.** `from/to` params; `/analytics/templates`, `/analytics/numbers`, `/analytics/campaigns`; `/analytics/operations`. **Frontend impact.** Analytics V2. **Risk level.** Medium (rollup writes must stay out of the claim/settle hot path).

---

## 15. Export

**Current state.** `GET …/messages/export.csv` (`api/routes/campaign-engine.ts:916-999`) streams the whole campaign synchronously with keyset paging (2000 rows/page, job id ascending), no filters, no size limit. Columns: `job_id, contact_phone, phone_number, template_name, job_status, attempts, max_attempts, job_error_reason, provider_status, provider_error_reason, provider_message_id, accepted_at, last_status_at` (`:933-937`). **Original CSV columns from `campaign_contacts.data` are not included.** `template_name` comes from the live `templates` table (null after deletion). The rejected-rows download (`:521-570`) does include original columns for Invalid and Suppressed rows but not Duplicates (duplicates are never stored as rows; they are counted at insert time, `:426`). The frontend export is a plain `<a download>` inside `CampaignMessagesDialog` (`campaign-messages-dialog.tsx:147-154`) that ignores the current search/status filter. No export history, no background jobs, no object-storage results.

**Classification.** PARTIAL.

**Relevant files.** `api/routes/campaign-engine.ts:521-570, 916-999`, `api/services/contact-processing.ts:29-36` (`csvField`, `csvRow`), `ui/components/campaigns/campaign-messages-dialog.tsx`, `api/lib/object-storage.ts`.

**Relevant functions.** `exportCampaignMessages`, `downloadRejectedImportRows`, `csvRow`, `getSignedUploadUrl` (object storage).

**Reusable pieces.** Streaming keyset writer; RFC-4180 helpers; import session `columns` (the ordered original header, `db/campaign-engine.ts:35`); `campaign_contacts.data`; object storage client; `test/campaign-messages-export.test.ts`.

**Problems.** No original columns; no filters; synchronous for millions of rows (request timeouts, memory pressure on proxies); no history; no duplicate export.

**UX problems.** Export is hidden in a dialog; no size estimate; no "ready" notification.

**Scale risks.** A 20M-row synchronous CSV over HTTP through a load balancer will be cut off.

**Required changes.** Export Center: filter set (All/Sent/Delivered/Read/Failed/Pending/Invalid/Duplicate/Suppressed/Delivery unknown/Retry eligible); column sets (original CSV columns always for All, plus outcome, sender, template, timestamps, technical); small exports stream directly, large exports (threshold by estimated rows) become `export_jobs` processed by a background worker in the API process, written to object storage, listed in history with expiry. Duplicates need a durable record: store duplicate rows in `campaign_contacts` with status `Duplicate` (they already have a status column and idempotency key; today they are dropped by `onConflictDoNothing`) or a `campaign_contact_duplicates` side table.

**DB impact.** `export_jobs` (org, campaign, filter, columns, status, row_count, object_key, expires_at, error); optional `Duplicate` status rows. **API impact.** `POST …/exports`, `GET …/exports`, `GET …/exports/:id/download`; export.csv gains filter params. **Frontend impact.** Export tab. **Risk level.** Low–Medium (import path change for duplicates must be measured; it adds rows).

---

## 16. Webhooks (inbound Meta)

**Current state.** `GET /webhooks/whatsapp` verifies `hub.verify_token` (`api/routes/whatsapp-webhook.ts:12-27`). `POST` requires `META_APP_SECRET`, raw body, `x-hub-signature-256` HMAC verified with `timingSafeEqual` (`:29-44`, `api/services/whatsapp-webhook.ts:16-23`). Only `statuses[]` with `sent|delivered|read|failed` are processed (`:34-69`), idempotent on `provider_events(provider, providerEventId)`, monotonic transitions (`:192-205`), per-message advisory lock (`:209`), updating `provider_messages`, `campaign_metrics` and `campaigns` (`:248-271`) but never `campaign_jobs`. `messages[]` are consumed only for STOP keywords (§3). `message_template_status_update`, `phone_number_quality_update`, `account_update`, `messaging_handshakes` are ignored. The handler processes serially inside the request; a thrown error returns 500 and Meta retries. No inbound queue, no event log per org, no last-received timestamp.

**Classification.** REAL (delivery statuses, STOP) · MISSING (inbound messages, template/quality/account events, durable queue).

**Relevant files.** `api/routes/whatsapp-webhook.ts`, `api/services/whatsapp-webhook.ts`, `api/app.ts:111`.

**Relevant functions.** `verifyWebhookSignature`, `parseWhatsAppStatuses`, `processWhatsAppStatus`, `statusTransition`, `parseWhatsAppOptOuts`, `processWhatsAppOptOut`.

**Reusable pieces.** All of it. The status pipeline is correct and tested (`test/phase4.test.ts`, `test/campaign-webhook-failure-backfill.test.ts`).

**Problems.** Everything not a status is dropped; STOP tenant resolution is not org-scoped and depends on `providerPhoneId`; processing is inline (a slow DB makes Meta retry and duplicate work, which idempotency absorbs but at cost); no observability.

**Scale risks.** At high volume, inline processing under one request ties webhook latency to DB latency; the production-scale doc lists a durable webhook queue as required.

**Required changes.** Persist every raw event first (`webhook_events`: org resolved by phone id, field, payload, received_at, processed_at, error), acknowledge fast, process from a bounded in-process queue in the API tier (not the transport cell); add handlers for inbound messages (→ Smart Inbox), template status updates (→ Template Studio), phone quality updates (→ Meta Health, `phone_numbers.quality`), account updates; expose `last_event_at` per number for webhook health.

**DB impact.** `webhook_events`. **API impact.** None public; internal processing. **Frontend impact.** Meta Health webhook status. **Risk level.** Medium (the status path must remain exactly as-is; new handlers are additive).

---

## 17. Organizations / workspace

**Current state.** `GET /organizations`, `POST /organizations/:id/activate` (sets the cookie), `PATCH /organizations/:id` (name only, admin+). No create or delete org endpoint; users get one auto-provisioned personal workspace plus invited ones. `provisionPersonalOrganization` (`api/lib/orgProvisioning.ts:216-237`) unconditionally calls `seedDemoData`, which inserts 1 WABA, 2 Connected sample numbers, 3 contacts, 2 Approved sample templates, 1 sample campaign in status **Running** with fabricated counters, and 1 route with `currentTps 42, queueDepth 18`. There is no purge. `organizations` has only `name, slug` (`db/organizations.ts`); no timezone, logo, default country code, retention or branding.

**Classification.** REAL (basic).

**Relevant files.** `api/routes/organizations.ts`, `api/lib/orgProvisioning.ts`, `db/organizations.ts`, `ui/pages/settings.tsx`.

**Reusable pieces.** Cookie-resolved active org; advisory-locked first-login provisioning; slug generator.

**Problems.** Seeded fake data contradicts the no-fake-data rule and pollutes the dashboard and analytics; a seeded "Running" campaign without a plan is visible to the runtime's discovery; no workspace settings beyond name.

**Required changes.** Stop seeding sample rows (keep the personal org creation); add a one-time "remove sample data" migration/endpoint for existing workspaces (`isSample = true` rows); workspace settings fields; create-workspace endpoint (owner of the new org); optional delete with confirmation and cascade (already cascades by FK).

**DB impact.** `organizations` gains `timezone`, `default_country_code`, `logo_url`, `retention_days`; sample purge script. **API impact.** `POST /organizations`, `DELETE /organizations/:id`, `POST /organizations/:id/remove-sample-data`. **Frontend impact.** Workspace settings. **Risk level.** Low.

---

## 18. RBAC

**Current state.** Four roles, ranked `owner 4 > admin 3 > manager 2 > agent 1` (`api/middlewares/auth.ts:15-20`), enforced server-side per route with `requireRole`; `requireActiveOrganization` for `:organizationId` routes. Reads are open to any member except invitations and WhatsApp integration (admin); mutations are manager+; member/invitation management is admin+ with owner-only rules (touch an owner, promote to owner, last-owner protection, `api/routes/members.ts:230-257, 323-354`). `users.isPlatformAdmin` is a dormant seam. No role-aware navigation on the frontend. The role column has no DB check constraint.

**Classification.** REAL.

**Reusable pieces.** Everything; `test/cross-tenant-isolation.test.ts`; `.agents/memory/rbac-mutation-symmetry.md`.

**Problems.** The four roles do not map to the V2 personas (Campaign Manager vs. Inbox Agent vs. Analyst are all either `manager` or `agent`); `agent` today can read campaigns, plans and exports, which an inbox-only agent should not.

**Required changes.** Introduce role set `owner, admin, campaign_manager, inbox_agent, analyst` with a compatibility mapping (`manager → campaign_manager`, `agent → inbox_agent`) and a permission matrix (capability strings) instead of pure rank comparison, so an analyst can read analytics and exports but not the inbox, and an inbox agent can use the inbox but not campaigns. Keep `requireRole` for coarse gates and add `requireCapability`.

**DB impact.** `organization_members.role` values migrated; optional `role_permissions` table for white-label custom roles later. **API impact.** `/me` returns capabilities; role enums widened. **Frontend impact.** Role-aware nav and buttons. **Risk level.** Low (additive; rank checks remain for existing routes until each is re-annotated).

---

## 19. CSV ingestion

**Current state.** `POST …/imports` (`api/routes/campaign-engine.ts:334-519`) streams the raw `text/csv` body through an incremental RFC-4180 parser (`api/services/contact-processing.ts:39-86`) in 500-row batches, up to 6 GB, with headers `idempotency-key`, `x-file-name`, `x-phone-column` (required), `x-default-country-code`. Rows are normalised to E.164, deduplicated per campaign by `sha256(campaignId:phone)` with `ON CONFLICT DO NOTHING`, checked against `suppressions`, and stored in `campaign_contacts` with every column in `data jsonb`. Progress is persisted per batch and polled via `GET …/imports`. The session is fenced (`campaign-import-lifecycle.ts:31-56`): campaign must be Draft, session Processing; cancelling mid-import fails the import cleanly. A Failed session is resumable by the same idempotency key. **Only one import session per campaign is allowed, ever** (`campaign-import-lifecycle.ts:109-119`). Phone column detection is client-side only (first 64 KB, regex `/phone|mobile|whatsapp|number/i`, `contact-import-dialog.tsx:40-58, 177`). Duplicates are counted, not stored. Benchmarks: ~4.1–5.5K rows/s on the dev profile (`docs/bulk-campaign-reliability-validation.md`).

**Classification.** REAL.

**Relevant files.** `api/routes/campaign-engine.ts:315-570`, `api/services/campaign-import-lifecycle.ts`, `api/services/contact-processing.ts`, `ui/components/campaigns/contact-import-dialog.tsx`, `db/campaign-engine.ts:26-79`.

**Relevant functions.** `streamContactImport` handler, `parseCsv`, `normalizePhone`, `stableContactKey`, `beginContactImport`, `assertContactImportWritable`.

**Reusable pieces.** All of it. This is the audience engine for Rocket step 1 and should also back global contact import.

**Problems.** One import per campaign (no append, no replace); no server-side column detection; no sample preview endpoint; duplicates not downloadable; the request must stay open for the whole upload (fine for the streaming design, but a mobile client cannot resume a partial upload except by re-sending with the same key).

**UX problems.** Import is a dialog inside Rocket; no audience summary page; duplicate export missing.

**Scale risks.** None new; keyset everywhere.

**Required changes.** Allow additional import sessions on a Draft campaign (append) and a "replace audience" that clears rows and allocations; server-side header sniff endpoint (first N KB) for column detection and sample preview; store duplicates as `Duplicate` rows (or side table) for export; reuse for global contacts and segments as sources; keep the header-based protocol.

**DB impact.** Possibly `Duplicate` rows. **API impact.** `POST …/imports/sniff`; multi-session semantics. **Frontend impact.** Audience step. **Risk level.** Low.

---

## 20. Frozen planning (plan → execute)

**Current state.** `campaign_plans` (`db/campaign-engine.ts:288-341`) freezes `routes[]` (routeId, phoneNumberId, templateId, configuredTps, providerTpsLimit, phone, displayName), `templateIds`, `templatesSnapshot` (full content), `mappingsSnapshot`, `partitionCount`, `allocatorVersion`; `campaign_allocations` stores the deterministic (contact → partition → route → template) result; `campaign_jobs` copies `planId`, `templateId`, `routeId`, `configuredTps` at execute time (`campaign-planning.ts:350-375`). Resolution reads the job's own plan (`template-resolution.ts:79-114`) with a 10-minute cache, never the live tables (legacy fallback only for jobs without a plan). Every mutating path that touches plan inputs takes the same session-level advisory lock. Tests: `campaign-planning.test.ts`, `campaign-frozen-template-mutation.test.ts`, `campaign-lifecycle-races.test.ts`, `campaign-lifecycle-bypass.test.ts`.

Live reads that remain at send time (`whatsapp-template-sender.ts:276-304`): the live `templates` row for existence and `status === "Approved"` (documented as an intentional provider-side gate), the live route/phone for `providerPhoneId` and WABA, the live claim-time gates (`campaign-queue.ts:445-464`: route Active, campaign Running, killSwitch false, and `coalesce(job.configuredTps, route.configuredTps) <= phone.tpsLimit`). `prepareBatch` loads every `campaign_plans` row for the campaign on each batch (`:277`), uncached.

Allocation is hash-modulo per route, unweighted (`contact-processing.ts:20-27`), so a 1000-TPS number and an 80-TPS number receive equal shares and jobs never move between routes.

**Classification.** REAL (core guarantee to preserve).

**Relevant files.** `api/services/campaign-planning.ts`, `api/services/template-resolution.ts`, `api/services/contact-processing.ts`, `db/campaign-engine.ts:278-360`.

**Relevant functions.** `planCampaign`, `executeCampaignPlan`, `withCampaignLifecycleLock`, `frozenTemplateForJob`, `resolveJobTemplates`, `partitionFor`, `assignRoute`.

**Reusable pieces.** Everything. The V2 affinity and distribution work must be expressed as additional frozen fields and a new allocator version, never as live lookups.

**Problems.** No `wabaId`/eligibility evidence on frozen routes; no compatible fallback pool; no distribution mode; allocator ignores TPS; the live "template must be Approved" gate turns a Meta pause after launch into non-retryable failures for every remaining job of that template (arguably correct as a safety gate, but it should be a retryable hold and surface in Recovery); lowering a phone's cap below the frozen TPS strands jobs silently.

**Required changes (design, see Master Spec §17–21).** Freeze per route: `wabaExternalId`, `eligibilityEvidence` (template ids verified available for that WABA at plan time, source and timestamp), `compatibleFallbackRouteIds`. Add `distributionMode` (`equal_by_numbers | equal_by_templates`), `deliveryMode`, and `allocatorVersion = v2`. Allocator v2: for equal-by-numbers, partition contacts across senders (as today) and choose a template for each sender from its eligible set (rotation within the sender's eligible templates so a sender can carry several templates); for equal-by-templates, partition contacts across template buckets first, then assign each bucket's contacts to the eligible senders of that template proportionally to configured TPS. Since one route today equals one (sender, template) pair, allocator v2 needs routes to be (sender, template) lanes that share a per-sender TPS budget; that is exactly the "campaign-number shared TPS budget" the memory note (`rocket-one-route-per-number.md`) says is the prerequisite for letting every number send every template. Job-level fields already carry `templateId`, so the runtime only needs routes to represent senders and jobs to carry templates; the pacing coordinator already has a per-phone cursor above the per-route cursor (`campaign-pacing-coordinator.ts:184-206`).

**DB impact.** `campaign_plans.routes[]` JSON gains fields (additive, no migration of existing rows required); `campaign_plans` gains `distribution_mode`, `delivery_mode`; `campaign_routes` gains `waba_id` (denormalised, validated) and `shared_phone_budget` semantics. **API impact.** Plan summary exposes eligibility evidence and fallback pools. **Frontend impact.** Review step and Details tab. **Risk level.** High. Must ship behind `allocatorVersion` with the existing tests unchanged and new tests for v2.

---

## 21. Failover

**Current state.** Two different things are called failover today:

1. **Cell/process failover (REAL).** Phone ownership is a Redis lease with a fencing token (5 s TTL, `campaign-phone-reservoir.ts:217-222`, `campaign-pacing-coordinator.ts:207-225`); a replacement cell with the same scope takes over after the lease expires, reclaims the dead consumer's pending stream entries with `XAUTOCLAIM` and fails them closed as `delivery_unknown` (`campaign-queue.ts:2130-2174`), re-validates unread entries, and the lease reaper returns claimed-but-unpublished jobs after 30 s (`campaign-runtime.ts:187-263`). Measured: takeover ≈5 s, sending resumes 5.5–6.5 s, 14 kills with zero duplicates (`docs/campaign-transport-operations.md` §2).
2. **Route/sender failover (MISSING).** When a route is not Active, nothing sends on it and its jobs stay Queued with their frozen `routeId`. There is no reassignment of work to another sender anywhere in the engine. `Throttled`/`Error` route statuses are never produced by the engine. Phone health (status, quality) is checked only at plan/schedule/resume, never at claim.

**Classification.** PARTIAL.

**Relevant files.** `api/services/campaign-phone-reservoir.ts`, `api/services/campaign-prepared-broker.ts`, `api/services/campaign-pacing-coordinator.ts`, `api/services/campaign-queue.ts:2130-2174, 811-879`, `api/services/campaign-runtime.ts:187-263, 334-338`.

**Relevant functions.** `recoverAbandoned`, `abandonBrokerEnvelopes`, `settleAbortedBatch`, `reapExpiredLeases`, `dropLane`.

**Reusable pieces.** All of the cell failover. Do not change lease TTLs, fencing or reclaim semantics.

**Problems.** No compatible sender failover; no "hold" state for stranded work; a paused/unhealthy number silently stalls a share of the campaign until an operator notices.

**Required changes.** Compatible failover as a **re-plan of unsent work**, not a runtime-level reroute: a `reroute` lifecycle action (Paused campaign, or automatic when a sender enters a terminal-unavailable state) that, under the lifecycle lock, moves only `Queued` jobs of the unavailable route to a compatible route from the frozen `compatibleFallbackRouteIds` (same template available on the target sender's WABA), recording a `campaign_reroutes` audit and bumping `queueDepth` on both routes; jobs with no compatible target move to a new job status `Held` (or stay Queued on a route marked `Held`) and appear in Recovery as "Sender unavailable". Runtime detection of sender unavailability (repeated 131xxx/133xxx errors, quality RED, registration lost) sets route status `Error` with a reason; `Throttled` becomes a real, engine-written state derived from pacing denials. Rerouting must never touch `Processing` jobs (lease fencing) and must never resend `delivery_unknown`.

**DB impact.** `campaign_routes.status_reason`, `held_at`; `campaign_reroutes` audit; optional job status `Held`. **API impact.** `reroute` action; monitoring exposes `held`. **Frontend impact.** Flight Deck "safe route adjustment", Recovery bucket. **Risk level.** High (touches claim eligibility and job status transitions; must be gated by tests equivalent to `campaign-lifecycle-races.test.ts`).

---

## 22. Recovery

**Current state.** No Recovery UI or endpoints. The data exists: `campaign_jobs.status/errorReason/attempts`, `provider_messages.status/errorReason`, `provider_events.errorCode/errorReason`, `campaign_metrics.errorReasons` histogram, and `campaign_contacts.status/invalidReason`. There is no internal failure taxonomy: `errorReason` is free text (engine strings such as "Missing mapping body:1 for template 7", "Provider send timed out after 8000ms", "Recipient is on the suppression list (…)", or Meta's redacted message). No retry-failed, requeue, clone or create-from-failed endpoint exists (`api/routes/` grep). `execute` cannot recreate Failed jobs because their idempotency key already exists; `plan` requires Draft/Ready. The ops doc's prescribed path is export + re-import as a new campaign.

**Classification.** MISSING (with REAL underlying data).

**Relevant files.** `api/services/campaign-queue.ts:1229-1300` (failure settlement), `api/services/whatsapp-provider.ts:32-81` (classification), `api/services/whatsapp-webhook.ts:248-263`, `api/routes/campaign-engine.ts:824-914` (messages search).

**Reusable pieces.** `messages/search` filters and trigram indexes; `errorReasons` histogram; `classifyProviderError` retryable set; the idempotency-key design (a retry campaign gets new keys because it is a new campaign; an in-place retry must reuse the same job with `attempts` reset).

**Problems.** No taxonomy; no grouping endpoint; no safe in-place retry; no create-from-failed.

**Required changes.** Failure taxonomy column `failure_class` on `campaign_jobs` (and derivable for `provider_messages`), assigned at settlement from provider code/HTTP status/engine error type: `retry_eligible, permanent, invalid_recipient, template_unavailable, template_account_mismatch, rate_limited, auth, permission, media, sender_unavailable, delivery_unknown, reconciliation_required`. Endpoint `GET …/recovery` returning counts per class with sample rows; actions: `retry` (in place: only classes marked retryable and never `delivery_unknown`; resets `attempts`, sets Queued, re-validates template/sender at claim), `create-from-failed` (new Draft campaign pre-filled with the group's recipients and original columns, reusing the CSV rows without re-upload), `change-template-and-retry`, `change-sender-and-retry` (both go through the reroute/replan path from §21), `download`.

**DB impact.** `campaign_jobs.failure_class`, `provider_messages.failure_class`, index `(campaign_id, failure_class)`; `campaign_recovery_actions` audit. **API impact.** New recovery endpoints. **Frontend impact.** Recovery tab. **Risk level.** Medium (retry must reuse lease/idempotency semantics; classification is additive).

---

## 23. delivery_unknown

**Current state.** `provider_messages.status` takes `pending | sent | rejected | delivery_unknown` from `settlePreparedTransport` (`whatsapp-template-sender.ts:498-516`): a `ProviderRequestError` → `rejected`, anything else (8 s timeout, abort, network) → `delivery_unknown`. Broker reclaim after consumer loss also writes `delivery_unknown`. On the next prepare, a prior `pending` or `delivery_unknown` intent is refused with a non-retryable "Provider delivery is unknown; manual reconciliation is required" (`:413-419`), so the job becomes Failed and is never auto-retried. A pause that aborts an in-flight HTTP call produces the same outcome on resume. Monitoring exposes a `deliveryUnknown` count (`campaign-engine.ts:1105-1112`). The ops doc references a "delivery-unknown endpoint" that does not exist. Reconciliation (`campaign-reconciliation.ts`) never touches `provider_messages`. There is no Graph-side reconciliation (Meta has no message-status query API; reconciliation must rely on late webhooks and operator judgement).

**Classification.** REAL semantics · MISSING surface.

**Reusable pieces.** The at-most-once guarantee; `provider_messages.requestKey` uniqueness; the duplicate-send guard tests (`test/campaign-provider-duplicate-send-guard.test.ts`).

**Problems.** No list endpoint; no operator workflow; late webhooks for a `delivery_unknown` message do arrive (the wamid is unknown, so `processWhatsAppStatus` returns `unmatched`) — meaning a message that was actually accepted can never be reconciled automatically because the local row has no wamid; abort-on-pause is classified the same as a real timeout.

**Required changes.** Keep "never auto-resend". Add: `GET …/delivery-unknown` list with keyset; `resolve` action per row or per group (`mark_failed_permanent` → eligible for create-from-failed, or `mark_sent` when the operator has evidence); for pause-induced aborts, distinguish "aborted before provider start" (safe to retry, the shard worker already knows whether the provider call started, `campaign-transport-shard-worker.ts:152-166`) from "aborted after start" (unknown); surface in Recovery as its own bucket with the explanation text.

**DB impact.** `provider_messages.resolved_by`, `resolved_at`, `resolution`. **API impact.** List + resolve endpoints. **Frontend impact.** Recovery bucket. **Risk level.** Medium (classification refinement touches the sender's outcome path; must be proven by the duplicate-send guard tests).

---

## 24. Redis

**Current state.** node-redis (`redis` ^6.2.1), two usage sites: `campaign-pacing-coordinator.ts` (Lua reservation of per-phone/per-route send slots; ownership leases with fencing tokens) and `campaign-prepared-broker.ts` (per-phone Streams with a consumer group, idempotent publish by `jobId:leaseToken`, `XAUTOCLAIM` reclaim, ACK/DEL). Production requires `CAMPAIGN_COORDINATOR_MODE=redis` and a URL; dev falls back to in-memory implementations. Redis holds no durable state that Postgres does not also hold; Redis loss is handled by stop → `FLUSHALL` → restart → reconcile delivery-unknown (`deploy/README.md`). `maxmemory-policy noeviction` is required. No pub/sub is used.

**Classification.** REAL.

**Reusable pieces.** All. V2 may add read-only aggregate keys for Flight Deck (short-TTL counters) and a pub/sub channel per campaign for SSE fan-out, in separate key namespaces, without changing the existing Lua scripts or stream names.

**Problems.** None functionally. The API tier and the transport tier share one Redis; SSE fan-out must not compete with pacing latency (use a separate connection, optionally a separate Redis).

**Required changes.** None to existing semantics. Additive: `campaign:live:{campaignId}` hash for 1-second aggregates written by the runtime's metric flusher; `campaign:events` pub/sub for SSE.

**DB impact.** None. **API impact.** None. **Risk level.** High if touched; Low if only additive namespaces are used.

---

## 25. Realtime / SSE

**Current state.** None. No `text/event-stream`, WebSocket or socket.io anywhere in the API or frontend. Clients poll: monitoring every 4 s while Running, readiness every 5 s while Draft/Ready, import progress every 1.2 s. Overview, analytics and route lists never auto-refresh.

**Classification.** MISSING.

**Reusable pieces.** `campaign_metric_deltas` flusher as the natural event producer; monitoring response shape as the event payload.

**Required changes.** SSE endpoint `GET …/campaigns/:id/stream` (and `GET /stream` for workspace-level events: inbox counts, health alerts, export ready) in the API tier: authenticated with the same Clerk cookie; heartbeat every 15 s; `Last-Event-ID` cursor with a bounded replay buffer per campaign (Redis list, 60 entries); reconnect handled by `EventSource`; per-org isolation by deriving the channel from `req.organizationId`; backpressure by coalescing to at most one aggregate event per campaign per second and dropping intermediate states; stale connection cleanup on `close`; max connections per user. Producer: the runtime publishes aggregate snapshots (not per-recipient events) after each delta flush and each webhook batch.

**DB impact.** None. **API impact.** New SSE endpoints. **Frontend impact.** Flight Deck, Home, Inbox counts. **Risk level.** Medium (new long-lived connections on the API process; must be excluded from the rate limiter like webhooks and must not run on transport cells).

---

## 26. Automations and Flows

**Current state.** `ui/pages/automations.tsx` renders `automations` from mock data; "Create Rule" and row menus have no handlers. No backend tables, routes or services (repository grep for `automation`, `flow` in the API and schema finds nothing). Nothing to preserve.

**Classification.** MOCK + UI ONLY.

**Required changes.** V2-00 defers the engine. Until then the page is removed from navigation (honest empty state if reached). Long-term model: trigger → conditions → actions with an event bus fed by the webhook processor (inbound message, delivery status, campaign events) and a durable `automation_runs` log; Flows as a visual builder over the same engine; WhatsApp Flows (Meta) supported first as a template button type in Template Studio.

**DB impact (later).** `automations`, `automation_versions`, `automation_runs`, `flows`, `flow_nodes`. **Risk level.** Low (greenfield).

---

## 27. White Label

**Current state.** Nothing: `organizations` has `name, slug` only; no branding columns, no custom domain handling beyond Clerk's per-host publishable key (`api/app.ts:119-126`), no template library.

**Classification.** MISSING.

**Required changes (deferred to the last milestone).** `workspace_branding` (logo, colours, product name, support email, custom domain, email sender), a `system` vs `workspace` vs `partner` template library scope, partner-level workspaces (a parent org that can create child orgs), and theme tokens applied at runtime from branding.

**DB impact.** New tables; `organizations.parent_organization_id`. **Risk level.** Low.

---

## 28. Authentication

**Current state.** Clerk on both sides (`@clerk/express`, `@clerk/react`), publishable key resolved per host, a production-only Frontend-API proxy at `/api/__clerk`, JIT user provisioning, cookie-based active org, membership re-query per request. Invite acceptance is email-match on first login (case-insensitive), invite links are informational (`/invite/:token`), and `GET /invite-info/:token` is public and returns the invitee email. Rate limiting is 600/min per user, in-memory per process. No API keys, no CSRF token (SameSite=lax + Clerk), Helmet without CSP (JSON API), CORS allowlist from env.

**Classification.** REAL.

**Reusable pieces.** Everything.

**Problems.** No API key auth for the Developer section; in-memory rate limiter is not shared across cells; invite preview leaks the email to anyone with the link.

**Required changes.** API keys (hashed, scoped, per org) for the Developer section with `requireApiKey` as an alternative to `requireAuth`; Redis-backed rate limiter store when running multiple API replicas; mask the email in the public invite preview.

**DB impact.** `api_keys`. **API impact.** Key management endpoints; `Authorization: Bearer` support. **Risk level.** Low.

---

## 29. Billing

**Current state.** `ui/pages/billing.tsx` shows a hardcoded "Enterprise Tier $4,500/mo", 8.5M/10M usage, a fake card "•••• 4242", and mock invoices; buttons have no handlers. No backend (repository grep for `stripe`, `billing`, `invoice` in API and schema: nothing; `pnpm-workspace.yaml` only excludes `stripe-replit-sync` from the release-age check).

**Classification.** MOCK + UI ONLY.

**Required changes.** Remove from navigation until a billing provider exists. When built: usage metering from `campaign_metrics`/rollups, plan limits enforced at preflight (recipients per month, numbers), invoices from the provider.

**Risk level.** Low.

---

## 30. Developer: API keys and outbound webhooks

**Current state.** `ui/pages/api-developers.tsx` renders mock `apiKeys` and `webhooks`; Generate/Copy/Revoke/Add Endpoint/Edit have no handlers. Backend has neither API keys nor outbound webhooks (§28, §16). The OpenAPI spec exists (45 paths, 62 operations, no security schemes declared).

**Classification.** MOCK + UI ONLY.

**Required changes.** API keys (§28); outbound webhooks (`webhook_endpoints`, `webhook_deliveries` with retries and signing secret) fed by the same event bus as automations; published OpenAPI with security schemes; an event log page.

**Risk level.** Low.

---

## 31. Cross-cutting findings

1. **Stale documentation.** `replit.md` says Analytics is mock (it is real) and that inviting an unknown email returns 404 (it creates a pending invitation). `docs/campaign-transport-operations.md` references a delivery-unknown endpoint that does not exist. Fix in V2-01 docs pass.
2. **Dead code.** `db/whatsapp-business-accounts.ts` (not exported, duplicate symbols); `campaign_rate_limit_windows` / `campaign_rate_limit_schedules` tables (no references in `api/`); ~35 unused shadcn files; unused deps (`framer-motion`, `react-hook-form`, `zod` in the frontend, `date-fns`); Inter font.
3. **Latent bugs to fix early.** Template status enum vs. Meta statuses (500 on PAUSED); `throughput` not fetched (cap pinned at 80); `overview.ts:27` "Active"; STOP tenant resolution not org-scoped; `pending` double count and reconciliation wiping webhook failures; mock provider deterministic wamid collision on identical resend.
4. **API envelope inconsistency.** Ten list endpoints return bare arrays; contacts/suppressions/messages use `{total, limit, offset, items}`; campaign contacts use keyset `{items, nextCursor}`. V2 standardises new endpoints on keyset `{items, nextCursor, total?}` and leaves existing ones untouched until each page is rebuilt.
5. **Process model.** Every API replica is also a transport cell (no HTTP-only mode). V2 features that add long-lived connections (SSE), background jobs (exports, rollups, health polling) and inbound processing (inbox) need an `API_ROLE=web|cell|all` switch so the web tier can scale without owning phones. This is the tracked P1 gap in `docs/campaign-transport-operations.md` and is a prerequisite for V2-07 onward.
6. **Scale claims.** Certified: one isolated cell ≈3,940 simulated provider starts/s. Not proven: 10–20M contacts, 1000 TPS against real Meta, multi-host scaling. V2 product copy must not claim numbers the benchmarks do not support.
