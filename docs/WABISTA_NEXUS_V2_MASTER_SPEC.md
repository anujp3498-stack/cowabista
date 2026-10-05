# Wabista Nexus V2 — Master Specification

Status: Authoritative V2 specification (V2-00 deliverable)
Baseline: branch `wabista-nexus-v2` at `d22a8e43bf0d36d1565c011aed77486767fb8318`
Companion documents:
- `WABISTA_NEXUS_V2_GAP_AUDIT.md` — evidence for every "today" statement in this document
- `WABISTA_NEXUS_V2_UX_BLUEPRINT.md` — page-level layouts, states and vocabulary
- `WABISTA_NEXUS_V2_IMPLEMENTATION_PLAN.md` — milestone breakdown and order

Conventions: "today" means the audited baseline. "V2" means the target. File references use `api/` = `artifacts/api-server/src/`, `ui/` = `artifacts/wabista-nexus/src/`, `db/` = `lib/db/src/schema/`. Nothing in this document changes runtime code; V2-00 produced only the four documents.

---

## 1. Executive summary

Wabista Nexus already contains a validated, high-throughput WhatsApp campaign engine: streaming CSV ingestion, a frozen plan → execute lifecycle serialised by advisory locks, deterministic allocation, per-phone pacing with database-clock rate windows, Redis-coordinated phone ownership with fencing tokens, per-phone Redis Streams, worker-thread transport shards, lease-fenced settlement, crash and cell failover recovery that fails closed into `delivery_unknown`, idempotent webhook processing, tenant isolation asserted on every write, and a benchmark and test corpus that documents exactly what has and has not been proven.

What it lacks is a product around that engine. Today the interface is an engineering console: raw WABA IDs in forms, TPS as the primary vocabulary, status dropdowns that let users fake Meta approval, a fake inbox, fake automations, fake billing, seeded demo counters on the dashboard, and a Rocket page that is a list of routes rather than a way to launch a campaign.

V2 turns the engine into a premium WhatsApp business operating platform for non-developers without rewriting the engine. The work is organised around six product identities:

| Identity | Meaning | Built on |
|---|---|---|
| **Rocket** | Launch a campaign in four steps | `rocket-setup`, CSV import, template mappings, plan/execute |
| **Flight Deck** | Watch and control a live campaign | `monitoring`, lifecycle actions, metric deltas, new SSE |
| **Recovery** | Fix affected campaign data safely | `campaign_jobs`, `provider_messages`, new failure taxonomy |
| **Smart Inbox** | One conversation workspace across all numbers | webhook receiver, new conversations model |
| **Meta Control** | Numbers, templates and health with minimal Meta complexity | sync, provider client, new credentials + state machine |
| **Template Studio** | Real Meta templates, drafts and a library | template sync, new authoring |

The two hardest engineering additions are (a) per-workspace WhatsApp credentials with Embedded Signup, replacing the single shared connector, and (b) sender-template affinity and distribution modes inside the frozen plan, which requires an allocator v2 and a shared per-sender TPS budget. Both are designed here as additive changes gated by versions and feature flags so the existing guarantees and tests stay intact.

---

## 2. Target users

Primary: entrepreneurs, MSMEs, startups, small and medium businesses, marketing, sales, support and operations teams, agencies managing many client workspaces, and larger businesses using the WhatsApp Business (Cloud) API.

Personas and their constraints are in the UX Blueprint §1. The governing rule: the default experience is designed for a business owner or marketer who has never opened the Meta developer console. Developers and operators are served by **Advanced**, **Technical Details** and the **Developer** section.

Roles (§40): Owner, Admin, Campaign Manager, Inbox Agent, Analyst/Viewer.

---

## 3. Jobs to be done

1. Connect my WhatsApp number(s) and know they are ready to send.
2. Send a message to a list, at a speed that is fast but safe, and see exactly what will happen before launch.
3. Watch a campaign live, pause it, slow it down, stop it.
4. Fix what failed without sending anything twice.
5. Reply to customers from the correct number, with campaign context, as a team.
6. Keep templates approved and know which numbers can use them.
7. Understand results: delivered, read, replied, by campaign, template and number.
8. Export everything with the original data intact.
9. Run all of the above for several clients from one login (agencies) and brand it (white label).

---

## 4. Product vision

"Connect WhatsApp. Manage customers. Launch campaigns. Track everything. Fix problems. Grow the business."

Wabista is the operating platform a business opens every morning to run WhatsApp: the day's numbers, what needs attention, the inbox, the campaigns in flight. It is not a Meta console, a bulk sender, or an infrastructure dashboard. Technical power is a click away, never in the way.

---

## 5. Product identity

- **Name in product:** Wabista. "Nexus" stays as the platform/codebase name.
- **Voice:** calm, precise, business-first. Sentence case. No engineering vocabulary outside Advanced/Technical Details (see UX Blueprint §43).
- **Visual:** professional, modern, minimal; strong typography (Plus Jakarta Sans, JetBrains Mono for numerics), clear hierarchy, generous spacing, subtle depth, meaningful status colours. No gradients-as-decoration, no glassmorphism, no gaming look, no console dark heroes, no "PRO" pills.
- **Signature elements:** the Action Center on Home, the Preflight card in Rocket, the Flight Deck progress header, the locked reply-from chip in Smart Inbox.

---

## 6. UX principles (non-negotiable)

1. Simple by default; advanced behind Advanced / More / Technical Details.
2. Business language; technical payloads expandable, never the headline.
3. One primary CTA per page.
4. Never ask for an ID the backend can discover.
5. Progressive disclosure.
6. No fake product data: no fake messages, activity, metrics, statuses, Meta health, campaign data. If a capability is not real, it is not shown as real.
7. Mobile matters for inbox, campaign status, pause/resume, alerts, number status, templates, basic analytics.
8. Premium, clean, modern.
9. Contextual intelligence: prevent mistakes before submit (incompatible templates unselectable, exact next action on incomplete numbers, failures auto-grouped in Recovery, replies carry campaign attribution).

Consequences already decided by these principles: the seeded sample campaign with fabricated counters is removed; the Inbox, Automations, Billing and API pages are removed from navigation until real; the header search and bell are removed until real; template status is never user-editable; campaign counters are never form inputs.

---

## 7. Existing foundation to preserve

The following is validated work and is **not** to be rewritten. V2 adds around it.

| Component | What it guarantees | Where |
|---|---|---|
| Streaming CSV ingestion | 6 GB files, 500-row batches, E.164 normalisation, per-campaign dedupe, suppression check, resumable by idempotency key, original columns preserved in `data` | `api/routes/campaign-engine.ts:334-519`, `api/services/contact-processing.ts`, `api/services/campaign-import-lifecycle.ts` |
| Frozen plan → execute | Immutable snapshot of routes, templates (content), mappings and per-contact allocation; execute is idempotent; every job carries its plan id | `api/services/campaign-planning.ts`, `db/campaign-engine.ts:278-360` |
| Lifecycle lock | Every mutating transition and every config write that feeds a plan takes the same session-level advisory lock; retries against a settled state are no-ops | `campaign-planning.ts:67-80`, `campaign-engine.ts:137-312` |
| Frozen resolution | Template variables resolve from the job's own plan snapshot, cached, never from live tables; batch resolution with lease-fenced set-based update | `api/services/template-resolution.ts` |
| Per-phone pacing | Database-clock rate windows and Redis Lua slot reservation per phone and per route; provider-approved cap per phone; platform max TPS | `api/services/campaign-pacing-coordinator.ts`, `campaign-queue.ts:398-700` |
| Claim path | LATERAL per-route candidate lookup on a partial index, per-phone quotas, set-based lease update | `campaign-queue.ts`, `.agents/memory/campaign-claim-query-queue-depth-bottleneck.md` |
| Phone ownership | Redis lease with fencing token per phone; transport refuses stale tokens | `campaign-phone-reservoir.ts`, `campaign-transport-shard-worker.ts` |
| Prepared broker | Per-phone Redis Streams, idempotent publish by job+lease, XAUTOCLAIM reclaim, fail-closed abandonment | `campaign-prepared-broker.ts`, `campaign-queue.ts:2130-2174` |
| Transport shards | Worker threads with per-phone cadence, bounded catch-up, 8 s provider timeout, settlement backpressure | `campaign-transport-shards.ts`, `campaign-shard-pacing.ts` |
| Settlement | Batched, per-campaign serialised, exact-lease; metric deltas kept off the hot row | `campaign-queue.ts:1084-1400`, `db/campaign-engine.ts:259-276` |
| Pause/resume/cancel/kill | Signal, don't overwrite leases; abort in-flight; reconcile after | `campaign-engine.ts:248-312`, `campaign-queue.ts:749-879` |
| Crash and cell recovery | Lease reaper, broker reclaim, delivery_unknown fail-closed, zero-duplicate evidence | `campaign-runtime.ts:187-263`, `docs/campaign-transport-operations.md` |
| delivery_unknown | At-most-once: a prior pending/unknown intent is never resent automatically | `whatsapp-template-sender.ts:413-419` |
| Suppression fencing | Advisory lock across recheck + reservation; STOP webhook aborts armed envelopes | `whatsapp-template-sender.ts:325-407`, `whatsapp-webhook.ts:132-182` |
| Webhook processing | HMAC verified, idempotent events, monotonic status transitions | `api/services/whatsapp-webhook.ts` |
| Tenant isolation | `organizationId` in every write predicate; cross-tenant regression suite | `test/cross-tenant-isolation.test.ts` |
| Provider client | Interface, error classification with a retryable set, redaction, mock client | `api/services/whatsapp-provider.ts` |
| Reconciliation | Recount from job state, fold deltas, rewrite route depths | `api/services/campaign-reconciliation.ts` |
| Monitoring aggregates | `campaign_metrics` + deltas; ETA formula; error histogram | `campaign-engine.ts:1021-1139` |
| Deployment | systemd cells with a fail-closed scope guard; PG and Redis tuning; runbooks | `deploy/` |
| Benchmarks and tests | 52 test files, multi-process crash tests, benchmark kit with provenance | `artifacts/api-server/test`, `benchmark/` |

Rules for V2 engineering:
- New engine behaviour ships behind a version (`allocatorVersion`), a plan field, or an env flag; the old path stays the default until the new one passes the same test gates.
- Hot-path writes stay batched and FK-free where the existing deltas are (`.agents/memory/hot-ledger-parent-fk-locks.md`).
- No new synchronous full scans of `campaign_jobs` in request handlers.
- Existing tests are not modified to pass; new behaviour gets new tests.

---

## 8. Information architecture

Target sidebar (role-filtered; details in UX Blueprint §5):

```
Home
MESSAGING   Smart Inbox · Campaigns · Contacts
GROW        Automations · Flows · Segments
WHATSAPP    Numbers · Templates · Meta Health
INSIGHTS    Analytics · Exports
DEVELOPER   API & Webhooks
SETTINGS    Workspace · Team & Roles · Billing · White Label
```

Rocket, Flight Deck and Recovery live inside Campaigns:

```
Campaigns
  → New Campaign  → Rocket (4-step wizard page)
  → Campaign detail
       Flight Deck · Messages · Recovery · Export · Details
```

Routes (frontend):

| Path | Page |
|---|---|
| `/` | Home |
| `/inbox`, `/inbox/:conversationId` | Smart Inbox |
| `/campaigns` | Campaign list |
| `/campaigns/new`, `/campaigns/:id/edit` | Rocket |
| `/campaigns/:id` (+ `?tab=`) | Campaign detail |
| `/contacts`, `/contacts/segments`, `/contacts/do-not-contact` | Contacts |
| `/automations`, `/flows` | Grow (hidden until real) |
| `/numbers`, `/numbers/:id` | Number Center |
| `/templates` (+ tabs) | Template Studio |
| `/meta-health` | Meta Health |
| `/analytics`, `/exports` | Insights |
| `/developer` | API & Webhooks (hidden until real) |
| `/settings/workspace`, `/settings/team`, `/settings/billing`, `/settings/white-label` | Settings |

Pages that are not real are not linked. `/rocket-campaigns`, `/phone-numbers`, `/integrations`, `/suppressions`, `/overview` become redirects during migration (§52).

---

## 9. Home / business dashboard

Answers three questions: what is happening, what needs attention, what can I do now. Layout in UX Blueprint §9.

**Quick actions.** New Campaign, Smart Inbox, Connect Number, Create Template, Import Contacts (role-filtered).

**Action Center.** Items generated server-side from real state, each with one action:
- numbers with `setup_state != Connected` → "N numbers need registration/verification"
- templates with status PAUSED/REJECTED/DISABLED → "Template X was paused/rejected"
- campaigns with `retry_eligible > 0` or `delivery_unknown > 0` → "Campaign X has N retryable failures / N delivery-unknown messages"
- inbox: unassigned count, oldest waiting
- credential health: token invalid/expiring, webhook silent for > N minutes while numbers are connected

**Today.** Sent, Delivered, Read, Failed, Replies for the workspace day (workspace timezone) from `analytics_daily` (§37) plus intraday deltas.

**Running campaigns.** From monitoring aggregates: progress, actual speed, ETA, status, Pause/Resume.

**Smart Inbox.** Unread, assigned to me, unassigned, campaign replies (hidden until Smart Inbox ships).

**WhatsApp health.** Per-number one-liners; template problems; incomplete registrations; quality warnings.

**Onboarding checklist** replaces the strip and panels for a new workspace (§45).

Data: one endpoint `GET /home` returning all of the above, computed from indexed aggregates only. Nothing on Home scans `campaign_jobs`, `provider_messages` or `provider_events` directly.

Removed: `activityFeed` mock, "DEMO PIPELINE" card, sample counters, the `Active` status filter bug (`api/routes/overview.ts:27`).

---

## 10. Smart Inbox

### 10.1 Scope

All connected numbers feed one unified conversation workspace with sections Inbox, Campaign Replies, Team Queue and Chat Manager; filters All / My chats / Unassigned / Snoozed / Resolved / Number / Agent / Tag / Search.

### 10.2 Data model (new)

```
conversations
  id, organization_id, phone_number_id (originating Wabista number), waba_id,
  contact_id (nullable until resolved), customer_phone (E.164), customer_name,
  state (open|snoozed|resolved), assigned_user_id, assigned_team_id, priority,
  unread_count, last_inbound_at, last_outbound_at, last_message_preview,
  session_expires_at (24h window), snoozed_until, resolved_at,
  first_campaign_id, last_campaign_id, tags text[], created_at, updated_at
  UNIQUE (organization_id, phone_number_id, customer_phone)
  INDEX (organization_id, state, last_inbound_at DESC)
  INDEX (organization_id, assigned_user_id, state)
  INDEX (organization_id, phone_number_id, state)

messages
  id, organization_id, conversation_id, direction (in|out),
  kind (text|template|image|video|document|audio|sticker|location|contacts|interactive|reaction|unknown),
  body text, media_asset_id, provider_message_id (wamid), reply_to_wamid,
  campaign_id, campaign_job_id, template_id (attribution),
  status (received|sent|delivered|read|failed), error_code, error_reason,
  sent_by_user_id, occurred_at, created_at
  UNIQUE (organization_id, provider_message_id) WHERE provider_message_id IS NOT NULL
  INDEX (conversation_id, id)            -- keyset per thread
  INDEX (organization_id, occurred_at)   -- rollups

conversation_notes (id, conversation_id, user_id, body, created_at)
conversation_events (id, conversation_id, type, actor_user_id, payload, created_at)  -- assign, resolve, snooze, tag
```

### 10.3 Ingestion

The webhook processor (§16 of the Gap Audit, extended) stores every inbound `messages[]` entry:
1. Resolve tenant and number by `metadata.phone_number_id` **scoped by org** (fix the current `limit(1)` lookup).
2. Upsert conversation by (org, number, customer phone); set `session_expires_at = occurred_at + 24h`.
3. Insert the message; download media to object storage asynchronously.
4. Attribution: if `context.id` is present, join `provider_messages.provider_message_id` → campaign job → campaign/template; also match by customer phone against the most recent `campaign_contacts` send within 7 days as a fallback, labelled "likely".
5. Keep the STOP handling exactly as today, additionally marking the conversation and contact opt-out.
6. Publish an inbox event for SSE.

Outbound free-form messages use a new `sendConversationMessage` path in the provider client (text/media/interactive), separate from the campaign sender, with its own `provider_messages`-style row on `messages` and the same webhook status updates.

### 10.4 Rules

- **Reply-from is locked** to `conversations.phone_number_id`. The API rejects a send whose `phoneNumberId` differs; the UI never offers a choice. Starting a conversation from another number is an explicit action that creates a new conversation.
- Outside the 24-hour window, only template sends are allowed; the composer switches mode.
- Every conversation retains org, contact, originating number, WABA, assignee, state, tags, campaign and template attribution.
- Conversation lists are keyset-paginated by `(last_inbound_at, id)`; thread messages by `id`.

### 10.5 API (new)

`GET /inbox/conversations` (filters, keyset), `GET /inbox/conversations/:id`, `GET /inbox/conversations/:id/messages` (keyset), `POST …/messages` (text/media/template), `POST …/assign`, `POST …/state` (snooze/resolve/reopen), `POST …/tags`, `POST …/notes`, `GET /inbox/counts`, SSE `GET /stream` events `inbox.conversation.updated`.

---

## 11. Chat Manager

First release: manual assignment, number→team, number→agent, priority, tags, snooze, resolve/reopen, internal notes, contact and campaign history, collision awareness (viewing/typing presence via SSE).

```
teams (id, organization_id, name, created_at)
team_members (team_id, user_id)
number_assignments (id, organization_id, phone_number_id, team_id, user_id, mode = 'manual', created_at)
```

Assignment rules resolve in order: explicit conversation assignment → number→agent → number→team (queue) → workspace queue. Future modes (round robin, least busy, keyword, VIP) are added as `mode` values with an assignment worker; they are not shown as controls until implemented.

Permissions: Admin+ manage teams and rules; Inbox Agents see their team queues and their own chats; Campaign Managers see all chats read-only unless also in a team.

---

## 12. Campaign replies

A reply to a broadcast is never an unexplained conversation. The conversation header shows a pinned context card: campaign, template, sender number, recipient, sent/delivered/read/replied times, and the rendered template that was sent (from the job's resolved parameters in `campaign_jobs.payload.resolvedParameters` and the frozen template snapshot). The Campaign Replies section lists conversations whose `last_campaign_id` is set; the campaign detail Messages tab links to the conversation for any job that has a reply.

---

## 13. Campaigns

### 13.1 List

Server-paginated (`GET /campaigns?status&numberId&search&cursor`), server-searched, with progress, actual speed, delivered %, failed %, and time. Row actions: Open, Clone, Pause/Resume, Stop, Export, Delete (Draft only).

### 13.2 Detail

Tabs: Flight Deck (§22), Messages (delivery log: `messages/search` with keyset instead of offset for deep pages), Recovery (§24), Export (§25), Details (frozen plan summary, audience, delivery settings, audit history, "what will this contact receive").

### 13.3 Lifecycle (unchanged core, one addition)

Statuses stay `Draft, Ready, Scheduled, Running, Paused, Completed, Cancelled, Failed`. Actions stay `plan, schedule, execute, pause, resume, cancel, emergency-kill`. V2 adds:
- `launch` = plan + execute in one call under the same lifecycle lock (server-side sequence; identical semantics to calling both), returning the plan summary and the first monitoring snapshot. The UI never exposes Plan and Execute separately.
- `reroute` (§21).
- `retry` (§24).

Display labels are in UX Blueprint §36.

### 13.4 Campaign record additions

`campaigns` gains: `distribution_mode`, `delivery_mode`, `delivery_settings jsonb` (per-number overrides for Advanced), `timezone`, `cloned_from_id`, `preset_id`, `audience_source (csv|segment|contacts)`, `segment_id`. The denormalised counters `sent/delivered/read/failed` remain for now but are never user inputs; the CRUD update schema drops them.

### 13.5 Clone

`POST /campaigns/:id/clone` copies name (+ " copy"), routes as sender selections, template selections, mappings, media asset references, distribution and delivery settings; audience is not copied unless `includeAudience` is set (then the CSV rows are copied into a new import session server-side without re-upload).

---

## 14. Rocket V2

A four-step wizard page (`/campaigns/new`), autosaving a Draft after step 1:

1. **Audience** — name, source (CSV upload / segment / contacts filter), streaming import with summary.
2. **Message** (Message Studio) — senders, templates, variables, media, preview, test send.
3. **Delivery** — distribution mode, delivery mode, schedule.
4. **Review & Launch** — preflight, "what will be sent", Launch.

Users never see queues, workers, routes or plans. Internally the wizard drives the existing endpoints:

| Step | Backend |
|---|---|
| Audience | `POST …/imports` (stream), `GET …/imports`, new `POST …/imports/sniff`, new segment materialisation |
| Message | `PUT …/rocket-setup` (extended), `PUT …/template-mappings`, new `GET …/compatibility`, new media asset endpoints |
| Delivery | `PATCH /campaigns/:id` (`distribution_mode`, `delivery_mode`, `delivery_settings`, `scheduled_at`) |
| Review | `GET …/readiness` (extended into preflight), `GET …/plan` (after plan), `POST …/actions {launch}` |

Ordering constraint today: routes/setup are frozen once an import session exists (`api/routes/campaign-routes.ts:293-307`). V2 relaxes this for Draft campaigns: setup and mappings may change after import while the campaign is Draft or Ready, because planning re-allocates from scratch and supersedes the prior plan (`campaign-planning.ts:197-276`). The freeze moves to "after Plan/Launch" (a Ready campaign that changes setup returns to Draft, which the setup endpoint already does at `campaign-routes.ts:428-436`). The import-time fence that a campaign must be Draft stays.

---

## 15. Audience

- Huge CSV uploads through the existing streaming import; nothing beyond the first 64 KB sample and counters is ever in browser memory.
- Automatic phone-column detection: server-side `POST …/imports/sniff` (first 256 KB) returns headers, a five-row sample, the guessed phone column (regex + E.164 density) and a guessed country code; the client confirms.
- Counts: valid, invalid, duplicates, suppressed; original rows preserved in `campaign_contacts.data`.
- Export invalid and suppressed: existing `rejected.csv`. Export duplicates: new; requires duplicates to be stored (`campaign_contacts.status = 'Duplicate'` rows inserted with a session-scoped idempotency key so the unique index is not violated, counted separately in `campaign_metrics.deduplicated`, excluded from allocation which filters `status = 'Valid'`).
- Multiple import sessions per Draft campaign (append) and "replace audience" (delete rows + allocations under the lifecycle lock, only in Draft).
- Segment and contacts-filter sources materialise into `campaign_contacts` through the same batch writer, so planning and export are identical for all sources.
- Advanced: dedupe scope (this campaign / against sends in the last N days via `provider_messages` join), encoding.

---

## 16. Message Studio

Supports N senders × M templates, image and non-image templates together, arbitrary variables (header, body, button), CSV and static mappings, fallbacks, shared mappings with per-template overrides, WhatsApp-style preview, mapping presets, test send.

### 16.1 Media

One uploaded header image (or video/document) is reusable by every compatible template in the campaign. New `media_assets`:

```
media_assets (id, organization_id, campaign_id nullable, kind image|video|document, content_type,
              size, object_key, public_url nullable, meta_media_id nullable, meta_media_phone_number_id nullable,
              sha256, created_by, created_at)
```

Upload uses the existing signed-URL flow (`api/routes/campaign-media.ts`, `api/lib/object-storage.ts`), extended to video/document with size limits per kind. Delivery to Meta: preferred path is uploading to Meta's `/{phone_number_id}/media` at plan time per sender WABA and sending by `id`; fallback is a public, expiring, signed GET URL served by the API (`GET /media/:id` → redirect) used as `link`. The mapping row stores `media_asset_id`; resolution turns it into `{id}` or `{link}` at prepare time. The current "paste a URL" path remains available under Advanced.

### 16.2 Mapping model

Today's forced sharing (Gap Audit §8) becomes: a **shared mapping group** per requirement key is the default authoring convenience; the stored rows remain one per (template, component, variable). The PUT endpoint accepts both shared groups and explicit per-template rows and no longer throws when two templates map the same positional key differently. `expandCompatibleMappings` is replaced by a pure "fill missing rows from shared groups" step.

### 16.3 Preview

Rendered from the template components snapshot with sample contact data (first valid row or a chosen row) using the same `resolveTemplateVariables` core as sending, so preview equals send. Media previews come from the asset's signed URL.

### 16.4 Mixed media

Preflight rule "all non-none header kinds must be equal" is removed. Replacement rule: each selected template with a media header must have a media mapping whose asset kind matches its header format. Image and text-header templates coexist; image and video templates coexist.

### 16.5 Presets

`mapping_presets (id, organization_id, name, template_ids[], mappings jsonb, created_by)`; applied to a campaign by copying rows, then editable.

---

## 17. Sender-template compatibility (affinity)

### 17.1 Definition

A template T is **eligible** for sender S when T exists, is APPROVED (or in a sendable state), and belongs to the WABA that owns S's phone number. Wabista maintains both directions:

- sender → eligible templates
- template → eligible senders

### 17.2 Today

Compatibility is `template.wabaId === phone.wabaId` with a null-bypass, checked at route create/update, Rocket setup rotation, preflight, and send time in real mode only (Gap Audit §20). Templates created locally have null `wabaId` and bypass every check.

### 17.3 V2 model

```
template_eligibility (organization_id, template_id, phone_number_id, waba_id,
                      status (eligible|ineligible|unknown), reason, verified_at, source (sync|webhook|probe))
  PRIMARY KEY (template_id, phone_number_id)
```

Populated by template sync per WABA (every template of WABA W is eligible for every number of W), updated by template status webhooks, and optionally verified by a cheap probe (`GET /{waba}/message_templates?name=` per WABA) before launch. Local/draft templates are ineligible everywhere until synced from Meta. `templates.waba_id` becomes NOT NULL for `source = meta`.

### 17.4 Enforcement points

1. **UI selection** — Message Studio marks ineligible templates unselectable per selected sender set and shows the sender × template matrix under Advanced.
2. **Preflight** — a launch blocker if any selected sender has no eligible selected template, or any selected template has no eligible selected sender; the null-bypass is removed.
3. **Frozen planning** — allocator v2 only produces (sender, template) pairs from the eligibility table; the frozen plan stores the eligibility evidence used (`verifiedAt`, `source`) per route.
4. **Before send** — the prepare step keeps its live check that the template is sendable and, in all modes, that `templateWabaId === senderWabaId` (today only in real mode).
5. **Failover** — reroute targets only from the frozen compatible pool (§21).

This prevents the avoidable "template does not exist" (Meta 132001) failures.

---

## 18. Distribution modes

Two explicit modes; both allow arbitrary N senders × M templates and neither requires `N = M` or `N ≥ M`.

**Equal by numbers.** Recipients are partitioned equally across selected senders (as today: SHA-256 partition → sender). Each sender then rotates through its own eligible selected templates by partition, so a sender may carry several templates and several senders may carry the same template.

**Equal by templates.** Recipients are partitioned equally across selected templates (template buckets). Each bucket is executed only by senders eligible for that template, split among them proportionally to their configured rate (so a bucket with one eligible sender goes entirely to it).

Both modes require the route model to change from "one route = one (sender, template) pair" to "one route = one sender lane with a shared per-sender TPS budget, and jobs carry their template". This is the prerequisite named in `.agents/memory/rocket-one-route-per-number.md`. Concretely:

- `campaign_routes` remains one row per sender per campaign (as Rocket setup creates today); `templateId` on the route becomes the sender's *default* template, kept for backwards compatibility with legacy jobs.
- `campaign_allocations.template_id` and `campaign_jobs.template_id` (both already exist) carry the per-recipient template.
- `frozenTemplateForJob` (`template-resolution.ts:103-114`) currently prefers `plan.routes[].templateId` over `job.templateId`; allocator v2 flips that precedence for plans with `allocatorVersion = v2` (job template first, route template as fallback). Legacy plans are unaffected.
- The pacing coordinator already enforces a per-phone ceiling above per-route budgets, so multiple templates on one sender share that sender's budget without multiplication.

Allocation stays deterministic: same inputs → same (partition, sender, template) for each recipient. Allocator v2 records `distributionMode` in the plan.

**Smart capacity** (future, §R of the brief): weighted by health, quality, approved cap, actual throughput, throttling and route state; a third mode that never replaces the two explicit ones. Not in this release; the UI shows it disabled, not as a fake toggle.

---

## 19. Delivery modes

| Mode | Rule (per sender) | User copy |
|---|---|---|
Effective ceiling (per sender) = min(approved cap, platform max), where platform max is the pacing coordinator's `CAMPAIGN_PLATFORM_MAX_TPS`.

| Mode | Rule (per sender) | User copy |
|---|---|---|
| Fastest safe | rate = effective ceiling | Use the maximum capacity currently allowed on these numbers. |
| Balanced | rate = max(1, floor(60% of effective ceiling)) — a **fixed** target for V2 (no warm-up ramp) | Spread load with emphasis on stability. |
| Conservative | rate = min(effective ceiling, max(5, floor(25% of effective ceiling))) | Use reduced sending pressure. |
| Advanced | per-number rate table, validated against the effective ceiling, never clamped | Set the speed for each number. |

**Decision (V2-06C):** Balanced in V2 is a constant 60% planned rate. The earlier "warm-up ramp over the first 2 minutes" is **not** part of V2: it would require new hot-path pacing behaviour, and V2 keeps the proven pacing/claim/shard code unchanged. Adaptive or ramped capacity may be considered later together with Smart Capacity / Flight Deck; it is not part of V2-06.

Delivery mode is resolved to the per-lane `configuredTps` at plan time and frozen (and copied onto every job); the runtime's TPS enforcement is unchanged. "TPS" appears only in technical details; the UI says "speed" and "messages per second". Changing speed after launch is the `adjust-speed` action, allowed only while the campaign is Paused: under the lifecycle lock it re-resolves the speed for the active plan's sender lanes and updates the Queued jobs' `configuredTps` in bulk (no replan; allocations, templates and in-flight work unchanged); the user resumes afterwards with the existing `resume` action.

---

## 20. Preflight

`GET …/preflight` (supersedes readiness, which remains for compatibility) returns a structured report:

```
recipients { total, valid, invalid, duplicate, suppressed }
senders    [{ id, phone, displayName, setupState, quality, approvedRate, plannedRate, eligibleTemplateIds[] }]
templates  [{ id, name, status, headerKind, eligibleSenderIds[], missingVariables[] }]
compatibility { valid: boolean, problems[] }
estimate   { messagesPerSecond, durationSeconds }
health     { credential, webhookLastEventAt, numbers[] }
media      [{ assetId, kind, ready }]
provider   { mode, ready }
warnings   [{ code, message, action }]
blockers   [{ code, message, action }]
```

Business copy per UX Blueprint §14.4. Codes map to human messages centrally (§43 notifications and UX Blueprint §40). Existing `validateCampaignReady` becomes one contributor to `blockers`; its engineering strings move under Technical Details.

---

## 21. Frozen execution plan

Preserve everything in §7. Additions per frozen route:

```
routes[]: { routeId, phoneNumberId, wabaExternalId, configuredTps, providerTpsLimit, phone, displayName,
            templateId (default), eligibleTemplateIds[], eligibilityVerifiedAt, eligibilitySource,
            compatibleFallbackRouteIds[] }
plan:     { distributionMode, deliveryMode, allocatorVersion: "v2" }
allocations: unchanged columns; template_id now varies within a route under v2
```

Guarantees maintained: immutability after plan; jobs stamped with plan id; resolution from the job's plan; lifecycle lock across every mutation; retry-safe actions; idempotent execute. Superseded plans stay for audit.

Sender-template affinity integrates at plan time only through the eligibility table; the runtime never consults eligibility (it trusts the frozen pair), except the existing provider-side safety checks at prepare.

---

## 22. Flight Deck

Primary metrics: Total, Waiting (queued), Sending (processing), Sent, Delivered, Read, Failed, Retrying, Delivery unknown, Actual speed, Target speed, ETA, Elapsed.

Charts: speed over time (actual vs target), delivery funnel, queue depth, error trend, sender health.

Per-number view: number, state, actual/target speed, waiting, sent, delivered, read, failed, health, throttling.

Controls: Pause, Resume, Emergency stop, Reduce speed, safe route adjustment (reroute, §21).

Advanced: queue depth per route, stale leases, throttled routes, reconciliation state, cell ownership, event cursor, provider latency, webhook lag.

Data sources:
- Aggregates from `campaign_metrics` as today, with the delta table extended by `route_id`, `delivered_delta`, `read_delta`, `unknown_delta`, `held_delta` so per-route stats never scan jobs.
- Actual speed from `campaign_throughput_samples` (campaign, route, second, provider_starts, sent, failed), written by the runtime's existing metric flusher in the same batched transaction cadence (200 ms) and retained 24 hours; the API reads the last 15 minutes for charts and the last 10 seconds for "actual".
- `Throttled` becomes real: the reservoir marks a route Throttled when pacing denials exceed a threshold for a window and Active when they stop; `currentTps` is replaced by the samples (the column is kept, no longer PATCHable).
- Failure accounting fix: `pending` excludes webhook-reported failures on already-sent jobs; reconciliation preserves delivery failures by counting them from `provider_messages`/`provider_events` rather than only job status.

---

## 23. Realtime / SSE

Pipeline: runtime/provider/webhook events → durable processing (Postgres) → Redis aggregate + pub/sub → API SSE → browser.

Requirements:
- Aggregated updates only: one event per campaign per second at most; never per recipient.
- `GET …/campaigns/:id/stream` and `GET /stream` (workspace events: inbox counts, health alerts, export ready, campaign state changes).
- Heartbeat comment every 15 s; client reconnect with `Last-Event-ID`; server keeps a 60-entry replay ring per channel in Redis; on cursor miss send a full snapshot.
- Tenant isolation: channel derived from `req.organizationId`; the campaign stream verifies campaign ownership before subscribing.
- Backpressure: coalesce to latest snapshot per tick; drop intermediate states; cap connections per user; disconnect idle tabs after 30 minutes with a resumable cursor.
- Stale connection cleanup on socket close and on org switch.
- Runs only in the API/web role, not on transport cells (§49).
- Polling remains as the fallback when SSE is unavailable; the UI shows "Live" with last-updated time.

---

## 24. Recovery Center

Buckets (from `failure_class`): Retry Eligible, Permanent Failure, Invalid Recipient, Template Unavailable, Template/Account Mismatch, Rate Limited, Authentication Problem, Permission Problem, Media Error, Sender Unavailable, Delivery Unknown, Reconciliation Required.

Classification is assigned at settlement (job failure) and at webhook failure (delivery failure) from Meta error code, HTTP status and engine error type; a central `classifyFailure(code, status, engineError)` replaces free-text matching. Existing `errorReason` text is kept for Technical Details.

Actions:
- **Retry eligible** — in-place: reset `attempts`, set `Queued`, `availableAt = now`, keep idempotency key; runs through the normal claim path (which re-validates route, campaign, cap). Never for Delivery Unknown.
- **Create campaign from failed** — new Draft with the group's recipients and original columns copied server-side.
- **Change template & retry** / **Change compatible sender & retry** — a scoped reroute (§21) for the group, limited to compatible options, then retry.
- **Download group** — filtered export (§25).

Invariants: never automatically resend `delivery_unknown`; the duplicate-prevention semantics of `provider_messages.request_key` are preserved (a retried job reuses its request key, so a prior accepted send is reused, not repeated).

Sender Unavailable: jobs held because their sender is unavailable and no compatible sender exists surface here with "Waiting for +91 … to recover, or move to a compatible number".

---

## 25. Export Center

Filters: All, Sent, Delivered, Read, Failed, Pending, Invalid, Duplicate, Suppressed, Delivery Unknown, Retry Eligible.

**Export All preserves all original CSV columns** (from the import session `columns` order and `campaign_contacts.data`), then appends: sender number, template, message/job status, attempts, provider message id, provider error, internal error, failure class, timestamps (queued, sent, delivered, read, failed), route id, campaign id/name/plan version.

Small exports (estimated < 50k rows, threshold configurable) stream directly as today. Large exports become `export_jobs` processed by a background worker in the web role, written to object storage as gzip CSV, listed in history, downloadable via a signed URL, expiring after 7 days, with an SSE/notification on completion.

```
export_jobs (id, organization_id, campaign_id nullable, kind (campaign_messages|contacts|recovery_group),
             filter jsonb, columns jsonb, status (queued|running|ready|failed|expired), row_count,
             object_key, size_bytes, error, requested_by, created_at, completed_at, expires_at)
```

The existing streaming writer (`campaign-engine.ts:916-999`) is reused for both paths with a pluggable sink (HTTP response or object-storage stream).

---

## 26. Numbers (Number Center)

Cards show business-useful information: number, display name, connection status (setup state), quality, account name, template count, current health, campaign activity, inbox state, speed available where meaningful. Actions: Open Inbox, Templates, Complete Setup, Sync, Disconnect, More. Raw IDs live in Technical Details.

`phone_numbers` additions: `setup_state`, `setup_error`, `name_status`, `messaging_limit_tier`, `throughput_level` (promoted from metadata), `last_health_at`, `credential_id`, `platform_type`. `status` and `quality` are no longer accepted by the update endpoint; they are Meta facts. Sync fetches `throughput`, `name_status`, `messaging_limit_tier`, `status`, `platform_type`, `is_official_business_account` in addition to today's fields, fixing the missing `throughput` request.

Mock mode: numbers are labelled "Test number"; the page states the workspace is in test mode in one line.

---

## 27. Manual number onboarding

Inputs in the normal path: **Phone number** and **Access token**. Backend `POST /whatsapp/discover`:
1. Validate the token (`/me`, `debug_token` where possible; capture scopes and expiry).
2. Enumerate businesses and WABAs reachable by the token (`/me/businesses` → `/{business}/owned_whatsapp_business_accounts` and `client_whatsapp_business_accounts`), then each WABA's phone numbers.
3. Match the typed phone number; return the WABA, phone number id, verified name, verification status and registration hints.
4. If exactly one match: connect. If several WABAs contain a matching number or none is reachable: ask the user to pick a WABA (list) with an Advanced "I know the WABA ID" input. Only then is a WABA ID requested.

Never asked in the normal path: Phone Number ID, Business ID, App ID, System User ID, Webhook ID. The token is stored encrypted as a `whatsapp_credentials` row and never shown again.

---

## 28. Embedded Signup

Frontend loads the Facebook JS SDK on demand (Connect with Meta only), calls `FB.login` with the WhatsApp Embedded Signup `config_id`, and posts the returned `code` plus the session-info `waba_id`/`phone_number_id` to `POST /whatsapp/embedded-signup/complete`. Backend exchanges the code for a business token, stores the credential, subscribes the app to the WABA (`/{waba}/subscribed_apps`), discovers all WABAs and numbers, and returns the selection list. The user then selects one or more numbers (multi-select is default) and each is connected and taken through registration as needed. App id and secret come from environment variables (names only in docs). The Meta modal is only the credential step; Wabista owns the selection screen.

```
whatsapp_credentials (id, organization_id, kind (system_user|embedded_signup|replit_connector),
                      business_id, token_ciphertext, token_key_id, scopes text[], expires_at,
                      status (active|invalid|expired|revoked), last_verified_at, last_error, created_by, created_at)
embedded_signup_sessions (id, organization_id, state_nonce, status, result jsonb, created_at, completed_at)
```

The existing single shared Replit connector becomes one credential row of kind `replit_connector` for the one workspace that uses it today, so nothing breaks at migration (§52).

---

## 29. Number state machine

```
Discovered → VerificationRequired → Verified → RegistrationRequired → Connected
             (side states) MetaApprovalPending · ActionRequired · Error
```

Transitions and Graph calls:
- Discovered: number found on a WABA reachable by the credential.
- VerificationRequired: `code_verification_status != VERIFIED` → `POST /{phone_number_id}/request_code {code_method: SMS|VOICE, language}` → `POST /{phone_number_id}/verify_code {code}` → Verified.
- RegistrationRequired: verified but not registered for Cloud API → `POST /{phone_number_id}/register {messaging_product: whatsapp, pin}` → Connected. The PIN is the two-step verification PIN (6 digits), distinct from the verification code; the UI and copy keep them separate (UX Blueprint §21).
- MetaApprovalPending: display name or business verification pending (`name_status`, WABA review status).
- ActionRequired: quality RED, messaging limit reduced, display name rejected, token permission missing.
- Error: last Graph call failed; `setup_error` holds the human message and Technical Details hold the raw error.

The backend performs every Graph request; the user never needs Postman. Today's `status` values map: Connected → Connected, Pending → Discovered/VerificationRequired (resolved on first V2 sync), Flagged → ActionRequired.

---

## 30. Templates (Template Studio)

Sections: Meta Templates, Drafts, Template Library.

Meta Templates: sync (all WABAs of all credentials), create, submit, real Meta status (APPROVED, PENDING, REJECTED, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION), rejection reason, delete, clone, filter/search, preview, category, language, header, body, footer, buttons (quick reply, URL, phone, copy code), media headers (with resumable upload for the sample), and supported Flow/catalog button types where the payload builder supports them.

Rules:
- `templates.status` is written only by sync and by the `message_template_status_update` webhook. The create/update API loses the `status` field. Users cannot fake approval.
- The API status enum is widened to Meta's set; the list endpoint no longer fails on PAUSED.
- `templates.source` = `meta | local | draft`; `waba_id` NOT NULL for `meta`; local templates (mock mode, tests) are labelled and ineligible for real senders.
- `rejected_reason`, `quality_score`, `previous_category` fetched on sync.
- Sync marks templates missing from Meta as `deleted_at` rather than leaving stale rows.
- The `body` column stays as a derived copy of the BODY component and is rewritten whenever components change.

---

## 31. Template Library

Reusable starting points by category: Account Confirmation, Order Update, Appointment, Lead Follow-up, Payment Reminder, Promotional Offer, Support Follow-up.

```
template_library_items (id, scope (system|workspace|partner), organization_id nullable, partner_id nullable,
                        category, name, language, components jsonb, sample_values jsonb, tags text[], created_at)
```

"Use this" creates a Draft in the workspace. System items are seeded only with genuinely useful, compliant starting points; the page is not padded with filler. Workspace items are saved from Drafts or approved templates. Partner scope is reserved for white label.

---

## 32. Meta Health

A human-readable operations layer over numbers, WABAs, quality, display-name state, registration, templates, webhooks, tokens/permissions, Embedded Signup, account health, compliance where relevant, and billing/credit line where the token has access.

Sources: periodic health job (web role, every 15 minutes per credential; every 5 minutes per number while campaigns run): `debug_token`, WABA fields (`account_review_status`, `ownership_type`, `business_verification_status` where available), number fields (§26), template statuses; webhook events `phone_number_quality_update`, `account_update`, `message_template_status_update`; webhook liveness (`last_event_at` per number, `webhook_events` errors).

Alerts (`health_alerts`: org, kind, severity, subject type/id, message, action, opened_at, resolved_at) drive the Action Center and the Meta Health page. Copy examples: "Number quality decreased.", "Template has been paused.", "Number setup is incomplete.", "WhatsApp connection requires attention.", "Webhook events are delayed." Raw payloads under Technical Details.

---

## 33. Contacts

Import (global streaming import reusing the campaign parser), search (trigram), custom fields, tags, deduplication, suppression, opt-out, campaign history, conversation history, engagement history. Scales to millions: keyset pagination on `(created_at, id)`, trigram search, bulk actions as background jobs above a threshold.

`contacts` additions: `normalized_phone` (unique per org, backfilled from `phone` with `normalizePhone`), `custom_fields jsonb`, `opted_out_at`, `last_inbound_at`, `last_outbound_at`, `last_campaign_id`. `contact_fields` defines custom field keys, labels and types per workspace. Do Not Contact = `suppressions` with a reason column shown, a trigram index and debounced search.

History joins: campaigns via `campaign_contacts.normalized_phone`; conversations via `conversations.contact_id`.

---

## 34. Segments

Smart/dynamic segments: Delivered but unread, Read but no reply, Replied, Failed, Recently active, Campaign-specific, Tag-based, Custom-field based, Engagement based.

```
segments (id, organization_id, name, definition jsonb, kind (dynamic|static), last_count, last_counted_at, created_by)
segment_members (segment_id, contact_id)   -- static snapshots only
```

Definitions compile to SQL over `contacts`, `campaign_contacts`, `provider_messages`, `provider_events` and `conversations` with a bounded count query (cached). Used directly in Rocket step 1: materialisation writes `campaign_contacts` rows through the import batch writer.

---

## 35. Automations

Not built in V2-00. The current page is mock and is removed from navigation. Long-term model: Trigger → Conditions → Actions over an event bus fed by the webhook processor and campaign lifecycle (incoming message, delivery status, campaign completed, tag added, segment entered), with a durable `automation_runs` log and idempotent actions (assign, tag, send template, wait, webhook). Examples: Incoming message → campaign = X → assign Sales; Read but no reply → wait → follow-up; New lead → add tag → assign agent.

---

## 36. Flows

Visual Flow Builder over the automation engine with nodes Trigger, Condition, Delay, Send WhatsApp, Send Template, Assign Agent, Add Tag, Webhook/API, Branch, End. WhatsApp Flows (Meta's in-chat forms) are supported first as a template/button capability in Template Studio and as a trigger source (flow completion webhook) later.

---

## 37. Analytics

Business analytics are primary: sent, delivered, read, failed, replies, campaign performance, template performance, number performance, trends. Operational details (actual vs target speed, queue depth, throttling, retry rate, provider latency, webhook latency, reconciliation, delivery unknown, route health) live under an Operations tab for Admin+ and are collapsed by default.

```
analytics_daily (organization_id, day, campaign_id, template_id, phone_number_id,
                 sent, delivered, read, failed, replies, PRIMARY KEY (...))
```

Maintained incrementally by the metric flusher (sent/failed), webhook processor (delivered/read/failed by day of event) and inbox ingestion (replies). Raw tables get `provider_events(organization_id, occurred_at)` and `provider_messages(organization_id, accepted_at)` indexes for drill-down. Date range parameters on every endpoint; no unbounded aggregates in request handlers.

---

## 38. Developer / API / Webhooks

API keys (hashed, scoped, per workspace) with `Authorization: Bearer`; outbound webhooks (`webhook_endpoints`, `webhook_deliveries` with retries, signing secret, event log); a published OpenAPI with security schemes. Events: `message.received`, `message.status`, `campaign.status`, `campaign.completed`, `contact.created`, `contact.opted_out`, `template.status`. Fed by the same event bus as automations. Hidden from navigation until implemented.

---

## 39. Workspace

Settings: name, logo, timezone, default country code, contact custom fields, data retention. Create additional workspaces (owner of the new one), agency parent/child structure (later, with white label). Sample data is no longer seeded; a one-time cleanup removes `is_sample` rows from existing workspaces.

---

## 40. RBAC

Roles: Owner, Admin, Campaign Manager, Inbox Agent, Analyst/Viewer.

| Capability | Owner | Admin | Campaign Manager | Inbox Agent | Analyst |
|---|---|---|---|---|---|
| Billing, white label, credentials claim | ✓ | – | – | – | – |
| Team, workspace settings, numbers, templates, Meta health | ✓ | ✓ | read | – | – |
| Campaigns create/launch/pause/recover | ✓ | ✓ | ✓ | – | read |
| Contacts import/edit | ✓ | ✓ | ✓ | notes/tags | read |
| Smart Inbox reply/assign | ✓ | ✓ | read | ✓ (own/team) | – |
| Analytics, exports | ✓ | ✓ | ✓ | – | ✓ |
| Developer | ✓ | ✓ | – | – | – |

Implementation: keep rank-based `requireRole` for coarse gates; add capability strings resolved from role (and later from custom roles) exposed by `/me`; migrate `manager → campaign_manager`, `agent → inbox_agent`; add `analyst`. Role-aware navigation on the frontend; server remains the enforcement point.

---

## 41. White label

Deferred to the final milestone. `workspace_branding` (product name, logo, colours, favicon, support email, custom domain, email sender), partner workspaces (`organizations.parent_organization_id`), partner-scoped template library, runtime theme tokens from branding, and Clerk per-host keys (already supported by `publishableKeyFromHost`).

---

## 42. Billing

Deferred. Metering from `analytics_daily`; plan limits (recipients/month, numbers, seats) enforced at preflight and at number connection; provider integration (Stripe or regional) for invoices. Until then the Billing page is not linked.

---

## 43. Notifications

`notifications (id, organization_id, user_id nullable, kind, severity, title, body, action_url, read_at, created_at)` produced by: campaign completed/failed/paused by system, export ready, template status change, number health change, credential problem, inbox assignment, mention in a note. Delivered in-app (bell + drawer, SSE), email (later), push (later). The bell is only rendered once this exists.

A central message catalogue maps codes to human text (`api/lib/messages/*`), shared by preflight, recovery, health alerts and notifications, with Technical Details carrying the raw source.

---

## 44. Audit log

Today: `campaign_audit` only. V2: `audit_log (id, organization_id, actor_user_id, actor_kind (user|system|api_key), action, subject_type, subject_id, before jsonb, after jsonb, ip, created_at)` written by member/role changes, credential changes, number connect/disconnect, template submit/delete, campaign lifecycle (mirroring `campaign_audit`), recovery actions, exports, settings changes. Read-only page under Settings for Admin+, keyset-paginated, filterable by subject.

---

## 45. Onboarding

Guided checklist on Home until complete or dismissed: 1 Connect WhatsApp, 2 Add/Connect Number, 3 Sync Templates, 4 Import Contacts, 5 Launch First Campaign, 6 Open Smart Inbox. Completion derived from real state; sample rows never count. Each step deep-links to the exact action. New workspaces never see a blank dashboard.

---

## 46. Productivity features

Clone Campaign (§13.5), Autosave Draft (Rocket steps), Campaign Presets (`campaign_presets`: senders, templates, mappings, distribution, delivery), Mapping Presets (§16.5), Saved Sender Groups (`sender_groups`), Saved Segments (§34), Test Send (`POST …/test-send` to a workspace-verified number using the frozen preview resolution; counted separately, never in campaign metrics), Recent Actions (from `audit_log`), Search and Command Palette (`⌘K`: navigate, find contact by phone, campaign, template; run actions with confirmation).

---

## 47. Design system

Audit result: the shadcn kit under `ui/components/ui` is complete and only partly used; tokens in `ui/index.css` are sound (fonts, primary, radius, dark mode) but the dark mode has no toggle and pages hardcode colours in places. Reuse the kit; add the missing product-level components rather than replacing anything.

V2 conventions (full detail in UX Blueprint §3, §8, §41):

| Area | Convention |
|---|---|
| Typography | Plus Jakarta Sans UI; JetBrains Mono for numerics/IDs; page title `text-2xl font-semibold` |
| Spacing | Page `p-4 sm:p-6 lg:p-8`; sections `space-y-6`; cards `p-5`; dense rows 44px |
| Radius | `--radius: 0.5rem` scale as today |
| Page headers | Shared `PageHeader` (title, subtitle, status chip, one primary CTA, `⋯` secondary) |
| Cards | Border, no shadow at rest; summary strips instead of card grids |
| Tables | `DataTable` with server pagination, sticky header, stacked-card fallback below `md` |
| Filters | One filter row: search + selects + date; debounced 300 ms; URL-synced |
| Drawers | `Sheet` right, 480px, full-screen mobile, URL-addressable |
| Dialogs | Decisions and short inputs only |
| Buttons | One primary per page; destructive = red outline + confirm dialog with typed name for campaigns |
| Badges | `statusChip(kind, value)` single source of truth |
| Destructive actions | AlertDialog with consequence sentence and the exact object name |
| Loading | `Skeleton` rows/tiles; in-button spinners |
| Empty states | `Empty` component with one line and 1–2 actions |
| Mobile tables | Cards with 3–4 fields and a `⋯` sheet |
| Navigation | Grouped sidebar, role-filtered; bottom tab bar on mobile |
| Responsive | Wrap action rows; hide charts behind toggles; sticky primary controls |
| Charts | `ui/chart.tsx` + `--chart-*` tokens; recharts under the hood |
| Notifications | Toast limit 3, 6 s auto-dismiss; persistent items in the notification drawer |

Removals: Inter font, `maximum-scale=1`, PRO pill, dark hero blocks, hardcoded hex colours, three duplicated error helpers, five duplicated active-org lookups (replaced by `useActiveOrganization`).

---

## 48. Mobile UX

Business owners must be able to do these from a phone: Smart Inbox (two-level), campaign status (Flight Deck summary), pause/resume/stop, alerts (Action Center, notifications), number status and Complete Setup (OTP/PIN entry), template status and preview, basic analytics. Tables become cards; drawers full-screen; sticky controls; 16px inputs; 44px targets; no pinch-zoom lock. Authoring (large CSV, template drafts, white label) shows a "best on desktop" banner but is not blocked.

---

## 49. Performance and scale

Rules (from the brief, confirmed against the engine):
- No millions of rows in React state; no giant browser arrays; no recipient-level SSE; no unbounded memory queues; no huge synchronous exports; no OFFSET pagination on hot datasets when keyset is better; no repeated full-table scans in critical loops.
- Prefer streaming, server filtering, keyset pagination, aggregates, bounded memory, background jobs, Redis for coordination and short-lived aggregates, durable Postgres state, object storage, indexed access, SSE aggregation.

Specific commitments:
- Monitoring `routes[]` stops scanning jobs (per-route deltas).
- Analytics moves to `analytics_daily`; raw tables get org+time indexes.
- Messages, contacts, conversations, audit and exports use keyset pagination.
- Exports above a threshold are background jobs to object storage.
- Health polling, rollups, export workers, SSE and inbound processing run in the **web role**; transport cells stay dedicated. New `API_ROLE = web | cell | all` (default `all` to preserve today's behaviour); the guard script requires `cell` on transport hosts.
- Rate limiter uses a Redis store when more than one web replica exists.
- Every new hot-path write is batched like `campaign_metric_deltas` and avoids parent FKs.
- Capacity claims in product copy follow `docs/bulk-campaign-reliability-validation.md`: no numbers the benchmarks have not produced.

---

## 50. Security

Keep: Clerk sessions, per-request org resolution, org predicate on writes, HMAC webhook verification, Helmet, CORS allowlist, pino redaction, rate limiting, systemd hardening, supply-chain release-age rule.

Add: encrypted credential storage with a key id and rotation procedure (envelope encryption; key from env, name only); `debug_token` verification and scope recording; API keys hashed (argon2/sha256+salt) and scoped; outbound webhook signing; audit log; masked invite preview; CSRF double-submit token for state-changing requests from non-Clerk clients (API keys use bearer only); media served through signed, expiring URLs; SSE excluded from the rate limiter like webhooks but capped per user; request-id propagation in logs.

Never: print tokens; expose credential rows beyond status/scopes/expiry; let a Viewer trigger exports containing phone numbers without the export capability.

---

## 51. Tenant isolation

Unchanged rule: every write predicate includes `organizationId`; `requireActiveOrganization` on `:organizationId` routes; `test/cross-tenant-isolation.test.ts` extended with every new table (conversations, messages, media assets, credentials, export jobs, segments, teams, notifications, audit log, eligibility). Webhook tenant resolution is by credential/WABA/number **with org predicates**, fixing today's `limit(1)` lookup. SSE channels are derived from the server-resolved org, never from client input. Object keys are prefixed by org id and never guessable. Partner/child workspaces (white label) get an explicit parent check, never implicit cross-org reads.

---

## 52. Migration strategy

Principles: additive schema changes; dual-read where a field moves; no data loss; every step reversible; the production branch untouched by V2 work until each milestone is reviewed and merged through the normal process.

Steps by milestone (details in the plan):
1. Navigation: old routes redirect to new ones for one release.
2. Sample data: stop seeding; one-time cleanup script removes `is_sample` rows and their dependents; dashboards read real data.
3. Credentials: create `whatsapp_credentials`; the existing real-mode workspace gets a `replit_connector` credential row; provider client factory resolves credential → client; the shared connector path stays until every call site is migrated; then the partial unique "one real org" indexes are dropped.
4. Numbers: backfill `setup_state` from `status` + `providerMetadata.verificationStatus` on the first V2 sync.
5. Templates: widen the status enum first (stops the PAUSED 500), then remove local status writes, then add `source`/`waba_id NOT NULL` for meta rows.
6. Eligibility: backfill `template_eligibility` from `(templates.waba_id, phone_numbers.waba_id)`.
7. Allocator v2: new plans use v2; in-flight v1 plans continue to resolve as today; `frozenTemplateForJob` precedence keyed by `allocatorVersion`.
8. Monitoring: add delta columns; reconciliation extended; UI reads new fields when present.
9. Exports: keep the streaming endpoint; add jobs.
10. Inbox: greenfield tables; webhook branch additive.
11. Roles: value migration with a compatibility map; capabilities computed server-side.

---

## 53. Testing strategy

- Keep the existing 52-file `node:test` corpus green; never edit a test to pass (memory: known flaky gates are documented and not to be "fixed" by changing production behaviour).
- Every milestone adds: unit tests for pure logic (classification, allocator v2, mapping fill, preflight rules, state machine), integration tests against Postgres for new endpoints (org isolation cases in `cross-tenant-isolation.test.ts`), and one race test where a lock is involved (pattern from `campaign-lifecycle-races.test.ts`).
- Engine-touching milestones (affinity, allocator v2, reroute, throughput samples, retry) must pass: planning, frozen-template-mutation, lifecycle races, rate-limit, duplicate-send-guard, failure-settlement, crash-recovery, and a benchmark run with the same profile as the last retained result showing no regression beyond noise.
- Webhook changes: fixtures for every Meta event type handled; idempotency and ordering tests.
- Frontend: Playwright e2e per milestone for the primary flow (connect number in mock mode, launch a campaign, pause/resume, recovery retry, inbox reply), using the existing Clerk programmatic sign-in pattern (`.agents/memory/clerk-playwright-e2e-pattern.md`); component tests for `statusChip`, `PageHeader`, `DataTable` card fallback.
- Contract: OpenAPI updated first, codegen re-run, zod schemas asserted in tests; list envelopes standardised for new endpoints.
- Wire `analytics.test.ts` into the test chain.

---

## 54. Risks

| Risk | Mitigation |
|---|---|
| Weakening frozen-plan guarantees while adding affinity/distribution | Allocator v2 behind `allocatorVersion`; new tests; precedence change keyed by version; no live lookups in the runtime |
| Credential model change breaks the one real workspace | `replit_connector` credential kind; client factory adapter; migrate call sites one by one with the sender tests green |
| Hot-path regressions from new metrics/samples | Same batched delta mechanism; FK-free; benchmark gate |
| Reroute creating duplicates | Only `Queued` jobs move; lease-fenced; never `delivery_unknown`; duplicate-send-guard tests extended |
| Embedded Signup app review and Meta configuration | Manual token path ships first; signup behind a flag |
| Inbox volume overwhelming the web tier | Persist-then-process queue; keyset everything; media async |
| Scope creep in Automations/Flows/White label | Explicitly deferred; navigation hides them |
| Mock mode confusion | Clear "test mode" labelling; local templates ineligible for real senders |
| Documentation drift | Each milestone updates `replit.md` and the ops docs it touches |

---

## 55. Delivery phases

The recommended order (rationale in the Implementation Plan) is:

V2-01 Product shell → V2-02 Numbers onboarding + state model (manual path) → V2-03 Template Studio + real sync → V2-04 Sender-template compatibility → V2-05 Rocket Audience + Message Studio → V2-06 Distribution + Preflight (allocator v2) → V2-07 Flight Deck realtime → V2-08 Recovery + Export → V2-09 Smart Inbox → V2-10 Chat Manager → V2-11 Contacts + Segments → V2-12 Meta Control (Embedded Signup, health) → V2-13 Analytics V2 → V2-14 Automations + Flows → V2-15 White Label/SaaS polish.

Two deviations from the brief's suggested order: Meta Control (health + Embedded Signup) is placed after Recovery/Inbox because the manual credential path in V2-02 unblocks everything else and Embedded Signup needs Meta app review; Contacts + Segments come before Analytics because segments feed Rocket and inbox history.

---

## 56. Definition of done (per milestone)

- Acceptance criteria in the plan met and demonstrated in mock mode and, where applicable, against a real WABA in a staging workspace.
- No fake data introduced; every new UI element is backed by a real endpoint or hidden.
- OpenAPI updated, codegen run, types compile (`pnpm run typecheck`).
- New tests added; the existing test chain passes (known documented flakes excluded by name only).
- Cross-tenant test extended for every new table/route.
- Engine-touching milestones: benchmark run recorded under `docs/benchmarks/` with provenance.
- Docs updated: `replit.md`, ops docs, this spec's section for the area.
- Reviewed as a PR against `wabista-nexus-v2`; never merged into the production branch by the V2 work itself.

---

## 57. Deferred work

- Smart Capacity distribution mode.
- Auto-assignment modes (round robin, least busy, keyword, VIP).
- Automations engine and Flow Builder (designed, not built).
- WhatsApp Flows authoring beyond template buttons.
- Billing provider integration and plan limits.
- White label, partner workspaces, custom domains.
- Push and email notification channels.
- Platform admin area (`isPlatformAdmin` seam).
- HTTP-only/cell role split beyond the `API_ROLE` switch (PgBouncer, partitioning, retention automation listed in `rocket-production-scale.md`).
- Multi-host throughput certification (the distributed runbook remains unrun).
