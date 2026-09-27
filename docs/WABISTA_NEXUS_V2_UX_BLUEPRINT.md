# Wabista Nexus V2 — UX Blueprint

Status: V2-00 deliverable (design authority for V2-01 onward)
Companion documents: `WABISTA_NEXUS_V2_MASTER_SPEC.md`, `WABISTA_NEXUS_V2_GAP_AUDIT.md`, `WABISTA_NEXUS_V2_IMPLEMENTATION_PLAN.md`
Scope: product UX only. No runtime code was changed to produce this document.

---

## 0. How to read this document

Every important page is described with the same hierarchy so that engineers can implement it without reinterpreting the design:

```
PAGE HEADER        title, subtitle, breadcrumb, status chip
PRIMARY CTA        exactly one
PRIMARY CONTENT    what the user came for
SECONDARY CONTENT  supporting lists / panels
ADVANCED CONTENT   behind "Advanced" or "Technical Details"
MOBILE BEHAVIOR    what collapses, what moves, what is hidden
```

Wireframes are ASCII. Widths are relative, not pixel specs. Where the current codebase already has a usable component, it is named so it can be reused instead of rebuilt (see §41).

Terms:

- **Workspace** = an organization row (`organizations` table). Users say "workspace"; code says "org".
- **Number** = a WhatsApp phone number connected to the workspace (`phone_numbers`).
- **Account** = a WhatsApp Business Account (`wabas`). Users almost never need to see this word.
- **Sender** = a Number used in a campaign.
- **Rocket** = the campaign creation wizard.
- **Flight Deck** = live campaign control.
- **Recovery** = fixing what failed.
- **Smart Inbox** = unified conversations across all numbers.

---

## 1. Personas

| Persona | Who they are | Device | What they must never have to learn |
|---|---|---|---|
| **Priya, owner of a 12-person D2C brand** | Runs promos to 200k customers monthly. Set up WhatsApp herself with help from an agency. | Laptop + phone | WABA IDs, Phone Number IDs, TPS, queues, workers |
| **Marcus, marketing manager at a mid-size retailer** | Launches 3–5 campaigns/week, several numbers, several templates. Owns campaign results. | Laptop | Graph API errors, route ownership, Redis |
| **Aisha, support agent** | Answers replies all day. Works from a queue. Must reply from the right number. | Laptop, sometimes phone | Anything except conversations, contacts, quick replies |
| **Dev, agency operator** | Manages 15 client workspaces, connects numbers, syncs templates, fixes registration problems. | Laptop | Nothing technical is off-limits, but wants it out of the way |
| **Ravi, ops/analyst** | Watches delivery, exports, reconciles failures, reports to management. | Laptop | Internal job states, lease tokens |
| **Sam, developer (rare)** | Integrates CRM via API/webhooks. | Laptop | Nothing; wants raw IDs, payloads and logs in one place |

Design rule: the default experience is built for Priya, Marcus and Aisha. Dev, Ravi and Sam get what they need behind **Advanced**, **Technical Details** and the **Developer** section, not in the main flow.

---

## 2. Jobs To Be Done

| Job | Persona | Success looks like |
|---|---|---|
| Connect my WhatsApp number so I can send | Priya, Dev | Number shows **Connected** with a green check; no Postman, no IDs typed unless discovery genuinely fails |
| Send this offer to this list, safely, fast | Marcus | 4 steps, a preflight I trust, a launch button, then a live view |
| Know what's happening right now | Marcus, Priya | Flight Deck answers "how far, how fast, what's wrong" in five seconds |
| Fix what failed without re-sending what already went | Ravi | Recovery groups failures into business buckets with one-click safe actions |
| Reply to customers from the right number | Aisha | Smart Inbox pins the originating number; reply-from is never a choice she can get wrong |
| Give management a report | Ravi | Export with original CSV columns plus outcomes, as a background job with history |
| Get templates approved and know their status | Marcus, Dev | Template Studio shows real Meta status, rejection reason, and which numbers can use it |
| Don't break Meta rules | Everyone | Quality warnings, paused templates and incomplete registrations are surfaced in plain language before they cost money |

---

## 3. Design language

### 3.1 Direction

"Premium WhatsApp business operating platform." Professional, modern, minimal, trustworthy. The current palette comment in `index.css` reads "Fintech/NOC"; V2 keeps the fintech calm but drops the NOC/console feel (dark hero panels, "PRO" pills, "STATUS: DEMO PIPELINE" copy, hardcoded "1.2M Contacts").

Keep:
- Plus Jakarta Sans (already loaded) for UI; JetBrains Mono for phone numbers, IDs, code, and tabular numerics.
- Blue-600 primary, slate neutrals, emerald/amber/red/blue status colours already defined as `success`, `warning`, `destructive`, `info` badge variants.
- Radius 0.5rem base with the existing sm/md/lg/xl scale.
- Light sidebar on a dark surface is acceptable but V2 should switch the sidebar to a light surface with a subtle border (the dark sidebar plus dark hero cards is the main source of the "console" feel).

Remove:
- Inter font import in `index.html` (loaded, never used).
- `PRO` feature pill on Rocket Engine nav item.
- Hardcoded marketing numbers inside product pages.
- Gradient/dark "hero" blocks inside operational pages.
- `maximum-scale=1` in the viewport meta (blocks pinch-zoom on mobile).

### 3.2 Tokens (V2 conventions, built on existing `index.css` variables)

| Token | Value / rule |
|---|---|
| Typography scale | `text-2xl font-semibold` page title (down from `text-3xl font-bold`); `text-base font-medium` section title; `text-sm` body; `text-xs text-muted-foreground` meta |
| Numerics | `font-mono tabular-nums` for all counts, TPS, phone numbers, IDs |
| Spacing | Page padding `p-4 sm:p-6 lg:p-8` (keep); section gap `space-y-6`; card padding `p-5`; dense table row height 44px; comfortable list row 56px |
| Radius | Cards `rounded-lg`; inputs/buttons `rounded-md`; chips `rounded-full` |
| Elevation | Cards: border only, no shadow at rest; `shadow-sm` on hover for clickable cards; drawers/dialogs `shadow-lg` |
| Status colours | success = emerald, warning = amber, danger = red, info = blue, neutral = slate. Never use colour alone: every status chip has text |
| Dark mode | Tokens already exist. V2-01 adds a system/light/dark toggle in the user menu and stops hardcoding `bg-gray-50` in `not-found.tsx` and `error-boundary.tsx` |
| Max content width | `max-w-6xl` for lists/settings (keep); Flight Deck and Smart Inbox use full width (`max-w-none`) |

### 3.3 Page header (new shared component `PageHeader`)

Today every page repeats the same `h1` markup (15 files). V2 introduces one component:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Breadcrumb (optional)                                                │
│ Title                       [status chip]        [secondary] [PRIMARY]│
│ Subtitle in muted text                                                │
└──────────────────────────────────────────────────────────────────────┘
```

Rules: one primary button, right-aligned; on mobile the primary button becomes full-width under the subtitle; secondary actions collapse into a `⋯` menu.

---

## 4. Interaction principles

1. **Simple by default.** Every screen shows the minimum needed to act. Anything the persona table marks as "never has to learn" goes behind Advanced or Technical Details.
2. **Business language first.** Status chips, alerts and errors are written for a business reader. The raw payload is one click away, never the headline.
3. **One primary CTA per page.** Numbers → Connect Number. Templates → Create Template. Campaigns → New Campaign. Contacts → Import Contacts. Inbox → no CTA (the list is the action).
4. **Never ask for an ID the backend can discover.** Manual connection asks for phone number and token. WABA ID is asked only when discovery reports it cannot pick one safely.
5. **Prevent, don't scold.** Incompatible templates are unselectable with a reason on hover, not rejected after submit. Preflight blockers link to the exact fix.
6. **No fake data.** If a feature is not real, show an honest empty state or hide the page. No sample activity feeds, no demo invoices.
7. **Summary → Details → Advanced.** Top of every operational page is a summary strip. Details below. Advanced collapsed.
8. **Mobile is a first-class read/act surface**, not a full authoring surface. Mobile does: inbox, campaign status, pause/resume, alerts, number status, template status, basic analytics. Mobile does not: build a campaign from a 2M-row CSV, edit template components.
9. **Drawers for context, dialogs for decisions.** Viewing a contact, a message, a number's details = drawer (keeps list context). Confirming a destructive action, entering a code = dialog.
10. **Keyboard-friendly.** Command palette (`⌘K`), `/` focuses search, `Esc` closes drawers, `J/K` in inbox lists.

---

## 5. Desktop navigation

### 5.1 Sidebar (target IA)

```
┌ Wabista ──────────────┐
│ [Workspace ▾]         │
│                       │
│ Home                  │
│                       │
│ MESSAGING             │
│  Smart Inbox     (12) │
│  Campaigns            │
│  Contacts             │
│                       │
│ GROW                  │
│  Automations          │
│  Flows                │
│  Segments             │
│                       │
│ WHATSAPP              │
│  Numbers          (!) │
│  Templates            │
│  Meta Health          │
│                       │
│ INSIGHTS              │
│  Analytics            │
│  Exports              │
│                       │
│ DEVELOPER             │
│  API & Webhooks       │
│                       │
│ SETTINGS              │
│  Workspace            │
│  Team & Roles         │
│  Billing              │
│  White Label          │
│                       │
│ ─────────────────     │
│ [avatar] Name    ⋯    │
└───────────────────────┘
```

Mapping from current nav (`shell.tsx`):

| Current item | V2 location |
|---|---|
| Overview | Home |
| Campaigns | Messaging → Campaigns |
| Rocket Engine (PRO) | Campaigns → New Campaign (wizard); removed from sidebar |
| Contacts | Messaging → Contacts |
| Do-Not-Contact | Contacts → "Do Not Contact" tab (suppressions) |
| Phone Numbers | WhatsApp → Numbers |
| Templates | WhatsApp → Templates (Template Studio) |
| Inbox | Messaging → Smart Inbox |
| Automations | Grow → Automations |
| Analytics | Insights → Analytics |
| API & Webhooks | Developer → API & Webhooks |
| Integrations | WhatsApp → Numbers (connection lives with numbers) + Meta Health |
| Billing | Settings → Billing |
| Team Roles | Settings → Team & Roles |
| Settings | Settings → Workspace |

Badges in the sidebar are counts that demand attention only: unread inbox, numbers needing action. Nothing else gets a badge.

### 5.2 Role-aware visibility

| Section | Owner | Admin | Campaign Manager | Inbox Agent | Analyst/Viewer |
|---|---|---|---|---|---|
| Home | ✓ | ✓ | ✓ | ✓ (inbox-focused) | ✓ |
| Smart Inbox | ✓ | ✓ | ✓ | ✓ | read-only |
| Campaigns | ✓ | ✓ | ✓ | – | read-only |
| Contacts | ✓ | ✓ | ✓ | read + notes | read-only |
| Grow | ✓ | ✓ | ✓ | – | – |
| Numbers / Templates / Meta Health | ✓ | ✓ | read-only | – | – |
| Insights | ✓ | ✓ | ✓ | – | ✓ |
| Developer | ✓ | ✓ | – | – | – |
| Settings: Workspace, Team | ✓ | ✓ | – | – | – |
| Settings: Billing, White Label | ✓ | – | – | – | – |

Hidden means not rendered in the sidebar, and the route shows a friendly "You don't have access to this area" page (not a 403 JSON). The server still enforces roles; this is about not distracting Aisha with Billing.

### 5.3 Header

```
[≡ mobile]  [Workspace ▾]        [⌘K Search…]        [🔔 3]  [avatar ▾]
```

- Search opens the command palette (navigate, find contact by phone, find campaign, find template, run actions like "Pause campaign X").
- Bell opens a notification drawer (real notifications only: campaign completed, template paused, number needs registration, export ready). Until a real notification model exists, the bell is not rendered.
- Workspace switcher keeps the hard-reload behaviour (server resolves org from cookie).

---

## 6. Mobile navigation

Bottom tab bar with five items, chosen by role:

```
┌────────────────────────────────────────────┐
│ [Home] [Inbox •] [Campaigns] [Numbers] [More] │
└────────────────────────────────────────────┘
```

- Inbox Agent: Home, Inbox, Contacts, Me, More.
- Everyone else: Home, Inbox, Campaigns, Numbers, More.
- "More" opens the full grouped list from §5.1.
- Page headers on mobile: title only; primary CTA becomes a floating action button (FAB) bottom-right when the page has one.
- Tables become stacked cards (see §38).

---

## 7. Global page hierarchy template

Every page in §9–§27 follows this. If a section is empty for a page, it is omitted, not left blank.

```
PAGE HEADER
PRIMARY CTA
PRIMARY CONTENT
SECONDARY CONTENT
ADVANCED CONTENT
MOBILE BEHAVIOR
```

---

## 8. Common patterns

### 8.1 Summary strip

A single row of 4–6 stat tiles. Each tile: label (xs, muted), value (2xl, mono), optional delta or sub-label. Tiles are not cards; they sit on one bordered container to avoid "dozens of cards".

```
┌────────────┬────────────┬────────────┬────────────┬────────────┐
│ Sent       │ Delivered  │ Read       │ Failed     │ Replies    │
│ 128,401    │ 121,930    │ 84,003     │ 1,204      │ 3,310      │
│ today      │ 94.9%      │ 65.4%      │ 0.9%       │            │
└────────────┴────────────┴────────────┴────────────┴────────────┘
```

### 8.2 List page

Filters row → table (desktop) / cards (mobile) → pagination footer. Server-side search with 300 ms debounce everywhere (today Suppressions searches per keystroke; Campaigns filters client-side with no pagination).

### 8.3 Detail drawer

Right-side sheet, 480px desktop, full-screen mobile. Header with title + status chip + `⋯`. Tabs when needed. Footer with actions. Reuses `ui/sheet.tsx` (already present, used once for mobile nav).

### 8.4 Status chip

`Badge` with the existing `success | warning | destructive | info | secondary | outline` variants plus text. One shared `statusChip(kind, value)` helper replaces the six ad-hoc status→variant maps that exist today (campaign, route, phone, template, contact, job).

### 8.5 Action Center item

```
[!] 2 numbers need registration.                    [Complete setup →]
```

Icon by severity, one sentence, one action.

### 8.6 Technical Details block

A collapsed accordion at the bottom of a drawer or page:

```
▸ Technical Details
   Phone Number ID   1234567890        [copy]
   WABA ID           9876543210        [copy]
   Last webhook      2m ago
   Raw provider payload  {…}           [copy]
```

Mono font, copy buttons, never editable here.

---

## 9. Home (Business Dashboard)

Answers: What is happening? What needs attention? What can I do now?

```
PAGE HEADER
  "Good morning, Priya"    subtitle: "Acme Retail · 3 numbers connected"

PRIMARY CTA
  New Campaign  (Campaign Manager+)   /  Open Smart Inbox (Inbox Agent)

PRIMARY CONTENT
  ┌ Quick actions ───────────────────────────────────────────────┐
  │ [+ New Campaign] [Smart Inbox] [Connect Number] [Create Template] [Import Contacts] │
  └──────────────────────────────────────────────────────────────┘
  ┌ Action Center ───────────────────────────────────────────────┐
  │ [!] 2 numbers need registration.                 Complete setup → │
  │ [!] Template "promo_sept" was paused by Meta.    View template → │
  │ [i] Campaign "Diwali Teaser" has 812 retryable failures. Open Recovery → │
  │ [i] 48 chats are unassigned.                     Open Team Queue → │
  └──────────────────────────────────────────────────────────────┘
  ┌ Today ───────────────────────────────────────────────────────┐
  │ Sent 128,401 │ Delivered 94.9% │ Read 65.4% │ Failed 0.9% │ Replies 3,310 │
  └──────────────────────────────────────────────────────────────┘

SECONDARY CONTENT
  ┌ Running campaigns ─────────────────┐ ┌ Smart Inbox ─────────────────┐
  │ Diwali Teaser   ▓▓▓▓▓▓░░ 71%       │ │ Unread          126          │
  │ 560 TPS · ETA 37m · Sending        │ │ Assigned to me    9          │
  │ [Pause] [Open Flight Deck]         │ │ Unassigned       48          │
  │ Sept Winback    ▓▓░░░░░░ 22%       │ │ Campaign replies 310         │
  └────────────────────────────────────┘ └──────────────────────────────┘
  ┌ WhatsApp health ───────────────────────────────────────────────┐
  │ ● +91 98… Connected · Quality High     ● +91 87… Registration required │
  │ 1 template paused · 0 quality warnings                               │
  └────────────────────────────────────────────────────────────────┘

ADVANCED CONTENT
  none on Home

MOBILE BEHAVIOR
  Quick actions become a horizontal scroll of chips; Action Center first; Today strip 2×3 grid; running campaigns as cards with Pause/Resume; health as a single line per number.
```

Empty state for a brand-new workspace: the onboarding checklist (§28) replaces Action Center + Today.

Data rule: every tile comes from a real aggregate endpoint. The current `activityFeed` mock and "DEMO PIPELINE" card are removed. If replies are not yet stored (Smart Inbox not built), the Replies tile and Smart Inbox panel are hidden, not zero-filled.

---

## 10. Smart Inbox

Three-pane on desktop, two-level navigation on mobile.

```
PAGE HEADER
  none (the inbox is full-height; a compact toolbar replaces it)

PRIMARY CTA
  none

PRIMARY CONTENT
┌ Sections ─────┬ Conversations ───────────────────┬ Conversation ───────────────────────┐
│ Inbox     126 │ [Search…] [All ▾][Number ▾][Tag ▾] │ Sarah Jenkins · +1 415 555 2671     │
│ Campaign      │ ─────────────────────────────────  │ via +91 98xx (Sales)  ● Open        │
│  replies  310 │ ● Sarah Jenkins            2m      │ Assigned: Aisha ▾   [Snooze][Resolve]│
│ Team queue 48 │   Yes, please update my…           │ ─────────────────────────────────── │
│ Snoozed     4 │   via +91 98xx · Campaign: Diwali  │ ┌ Campaign context ───────────────┐ │
│ Resolved      │ ○ Elena Rodriguez        15m       │ │ Diwali Teaser · promo_sept       │ │
│ ───────────── │   Gracias! I will check…           │ │ Sent 10:41 · Delivered 10:41     │ │
│ My chats    9 │ ● David Okafor            1h       │ │ Read 10:52 · Replied 10:55       │ │
│ Unassigned 48 │   Can someone help me…             │ └──────────────────────────────────┘ │
│ ───────────── │                                     │  [template bubble]                  │
│ Numbers       │                                     │           [customer reply bubble]   │
│  +91 98xx  80 │                                     │ ─────────────────────────────────── │
│  +91 87xx  46 │                                     │ Replying from +91 98xx (locked)     │
│ Tags          │                                     │ [Type a message… ] [Quick reply ▾] [Send] │
│  VIP  Lead    │                                     │ ▸ Contact · Notes · History        │
└───────────────┴────────────────────────────────────┴─────────────────────────────────────┘

SECONDARY CONTENT
  Right-side contact panel (collapsible): contact fields, tags, campaign history, conversation history, internal notes.

ADVANCED CONTENT
  ▸ Technical Details on a message: provider message id, status timeline, raw webhook payload.

MOBILE BEHAVIOR
  Level 1: sections + conversation list (one screen). Level 2: conversation full-screen with back arrow. Contact panel via "i" button. Reply-from number shown as a locked chip above the composer.
```

Rules:
- **Reply-from is derived from the conversation's originating number and cannot be changed in the composer.** If an agent wants to contact the customer from another number, that is an explicit "Start new conversation from…" action with a confirmation, never a dropdown in the reply box.
- 24-hour window: if the customer's last inbound is older than 24h, the composer switches to "Send a template" mode with an explanation line.
- Campaign replies keep the campaign context card pinned at the top of the thread.
- Collision awareness: "Aisha is viewing" / "Marcus is typing" indicator in the thread header.

---

## 11. Chat Manager

A tab inside Smart Inbox for admins and team leads: `Inbox · Campaign Replies · Team Queue · Chat Manager`.

```
PRIMARY CONTENT
┌ Assignment rules ──────────────────────────────────────────────────┐
│ Number +91 98xx (Sales)     → Team: Sales     Mode: Manual  [Edit]  │
│ Number +91 87xx (Support)   → Team: Support   Mode: Manual  [Edit]  │
│ Default                     → Team queue                            │
└────────────────────────────────────────────────────────────────────┘
┌ Team queue ────────────────────────────────────────────────────────┐
│ 48 unassigned    [Assign to me] [Assign… ▾]   Oldest waiting 42m   │
│ ○ +49 151 … STOP                       3h   via +91 87xx  [Assign ▾]│
│ ○ Maria Garcia  I haven't received…     5h   via +91 98xx  [Assign ▾]│
└────────────────────────────────────────────────────────────────────┘
┌ Agents ────────────────────────────────────────────────────────────┐
│ Aisha    Online   9 open   avg first reply 4m                       │
│ Ben      Away     3 open   avg first reply 11m                      │
└────────────────────────────────────────────────────────────────────┘

ADVANCED CONTENT
  Future assignment modes (round robin, least busy, keyword, VIP) appear here as an "Auto-assignment (coming in a later release)" disabled card only once the engine exists — never as fake toggles.
```

First release supports: manual assignment, number→team, number→agent, priority, tags, snooze, resolve/reopen, internal notes. Auto-assignment modes are deferred.

---

## 12. Campaign list

```
PAGE HEADER
  Campaigns  ·  subtitle "Broadcasts sent through your connected numbers"

PRIMARY CTA
  [+ New Campaign]  → Rocket

PRIMARY CONTENT
  Filters: [Search…] [Status ▾ All/Draft/Ready/Scheduled/Sending/Paused/Completed/Stopped/Failed] [Number ▾] [Date ▾]
  ┌────────────────────────────────────────────────────────────────────────┐
  │ Name              Status      Progress            Delivered  Failed  When│
  │ Diwali Teaser     ● Sending   ▓▓▓▓▓▓░░ 71% 560tps  94.1%      0.8%   now │
  │ Sept Winback      ● Paused    ▓▓░░░░░░ 22%         93.0%      1.2%   2h  │
  │ Aug Reminder      ✓ Completed ▓▓▓▓▓▓▓▓ 100%        95.4%      0.6%   Aug 28│
  │ New Launch        ○ Draft     —                    —          —      Sep 1│
  └────────────────────────────────────────────────────────────────────────┘
  Row click → Campaign detail. Row `⋯` → Clone, Pause/Resume, Stop, Export, Delete (Draft only).
  Server-side pagination (25/page), server search.

SECONDARY CONTENT
  none

ADVANCED CONTENT
  none

MOBILE BEHAVIOR
  Cards: name, status chip, progress bar, "94% delivered · 0.8% failed", Pause/Resume button for running/paused.
```

Removed from the current Campaigns page: the create/edit form that lets users type Status, Sent, Delivered, Read and Failed values. Those are runtime facts, not inputs. The only editable campaign fields outside Rocket are name and schedule.

---

## 13. Campaign detail

```
PAGE HEADER
  ← Campaigns / Diwali Teaser        ● Sending
  Subtitle: "3 numbers · 2 templates · started 10:41 · ETA 37m"

PRIMARY CTA
  [Pause]  (or [Resume] / [Launch] depending on state)

Tabs:  Flight Deck · Messages · Recovery · Export · Details

MOBILE BEHAVIOR
  Tabs become a horizontal scroll; Flight Deck is default; Recovery/Export show summaries with "Open on desktop for bulk actions" where needed.
```

- **Flight Deck** → §15
- **Messages** → the delivery log (today's `CampaignMessagesDialog`) as a full tab: search, status filter, keyset pagination, row drawer with status timeline + Technical Details.
- **Recovery** → §16
- **Export** → §17
- **Details** → frozen plan summary (today's `CampaignPlanDialog` content): numbers, templates, mappings, "What will this contact receive?" preview, audit history.

---

## 14. Rocket (New Campaign wizard)

Four steps, left stepper on desktop, top progress on mobile. Autosaves a Draft after step 1.

```
┌ Steps ───────┬ Content ────────────────────────────────────────────────┐
│ 1 Audience ● │                                                          │
│ 2 Message  ○ │   (step content)                                         │
│ 3 Delivery ○ │                                                          │
│ 4 Review   ○ │                                                          │
│              │   [← Back]                                   [Continue →]│
└──────────────┴──────────────────────────────────────────────────────────┘
```

### 14.1 Step 1 — Audience

```
PRIMARY CONTENT
  Campaign name  [Diwali Teaser            ]
  Audience source:  (•) Upload CSV   ( ) Segment   ( ) Contacts filter
  ┌ Drop CSV here or browse ─────────────────────────────────────────┐
  │  customers_sept.csv · 1.2 GB                                      │
  │  Phone column  [phone ▾]  (auto-detected)   Country code [+91]    │
  │  ▓▓▓▓▓▓▓▓▓▓░░░░░ 64% · 812,000 rows processed                      │
  └──────────────────────────────────────────────────────────────────┘
  ┌ Sample (first 5 rows) ─────────────────────────────────────────────┐
  │ name        phone         city      order_id                        │
  └────────────────────────────────────────────────────────────────────┘
  ┌ Audience summary ──────────────────────────────────────────────────┐
  │ Valid 1,244,300 │ Invalid 3,100 [Download] │ Duplicate 2,600 [Download] │ Do-not-contact 1,000 │
  └────────────────────────────────────────────────────────────────────┘

ADVANCED CONTENT
  ▸ Advanced: dedupe scope (this campaign only / against last 30 days), keep original row order, encoding.

MOBILE BEHAVIOR
  Upload allowed but the sample preview collapses; summary tiles stack 2×2.
```

The upload uses the existing streaming import (header-based POST, idempotency key, progress polling). Nothing in the browser holds more than the first 64 KB sample and the counters.

### 14.2 Step 2 — Message (Message Studio)

```
PRIMARY CONTENT
┌ Senders ─────────────────────────┐ ┌ Preview ───────────────────────┐
│ [x] +91 98xx  Sales   ● Quality High │ │  ┌──────────────────────────┐ │
│ [x] +91 87xx  Support ● Quality High │ │  │ [image]                  │ │
│ [ ] +91 76xx  Ops     ⚠ Registration │ │  │ Hi {{name}}, your Diwali │ │
│      required — not selectable       │ │  │ offer is live…           │ │
└──────────────────────────────────────┘ │  │ [Shop now]               │ │
┌ Templates ───────────────────────────┐ │  └──────────────────────────┘ │
│ [x] promo_sept_img   Marketing · en  │ │  Preview as: [promo_sept_img ▾]│
│     Available on: +91 98xx, +91 87xx │ │  Sample contact: [row 1 ▾]    │
│ [x] promo_sept_txt   Marketing · hi  │ └────────────────────────────────┘
│     Available on: +91 98xx           │
│ [ ] festive_video    ⚠ Not available on any selected sender │
└──────────────────────────────────────┘
┌ Variables ───────────────────────────────────────────────────────────┐
│ Header image   [Upload image] or [CSV column ▾]   ✓ shared by 2 image templates │
│ {{1}} name     [CSV: name ▾]         fallback [there]        (2 templates)  │
│ {{2}} offer    [Fixed: 20% off  ]                              (promo_sept_img) │
│ Button URL {{1}} [CSV: order_id ▾]                              (promo_sept_txt) │
│ ▸ Map variables per template (advanced)                                        │
└──────────────────────────────────────────────────────────────────────┘
  [Save as mapping preset ▾]   [Send test to my number]

ADVANCED CONTENT
  ▸ Per-template mapping overrides (when two templates should not share a value for the same position)
  ▸ Template compatibility matrix (sender × template grid with ✓ / — and the reason)

MOBILE BEHAVIOR
  Preview moves below the selectors; variables list stacks; upload allowed.
```

Rules:
- A template that is not available on any selected sender is shown but disabled with the reason.
- A sender with no compatible selected template gets a warning line ("+91 87xx has no template it can send; it will be skipped or pick a template it supports").
- One uploaded header image is reused by every selected image template. Mixed image and text templates are allowed in one campaign. Image and video templates in one campaign are allowed as long as each media kind has its own media mapping (the current "all media headers must be the same kind" rule is lifted; see spec §16–17).
- Shared mapping is the default; per-template override is the advanced path.

### 14.3 Step 3 — Delivery

```
PRIMARY CONTENT
  Distribution
    (•) Equal by numbers      Each selected number sends an equal share.
    ( ) Equal by templates    Each selected template gets an equal share, sent by numbers that support it.
    ( ) Smart capacity        (disabled, "coming later") — never a fake toggle

  Speed
    (•) Fastest safe   Use the maximum capacity Meta currently allows on these numbers.
    ( ) Balanced       Spread load with emphasis on stability.
    ( ) Conservative   Reduced sending pressure.
    ( ) Advanced       Set a rate per number.

  Schedule
    (•) Send now   ( ) Schedule for [date/time]   Timezone: Asia/Kolkata

ADVANCED CONTENT
  ▸ Advanced: per-number rate table (number · Meta ceiling · rate), retry policy, priority.

MOBILE BEHAVIOR
  Radio groups stack; advanced hidden behind a sheet.
```

The word "TPS" appears only inside Advanced. Elsewhere it is "speed" and "messages per second" in the estimate.

### 14.4 Step 4 — Review & Launch (Preflight)

```
PRIMARY CONTENT
┌ Preflight ─────────────────────────────────────────────────────────┐
│ Recipients 1,250,000   Valid 1,244,300   Invalid 3,100   Duplicate 2,600   Do-not-contact 1,000 │
│ Numbers 3              Templates 2       Compatibility ✓ Valid                                  │
│ Speed ~560 msg/s       Estimated duration ~37m                                                   │
│ ─────────────────────────────────────────────────────────────────── │
│ ✓ Number health        3 connected, quality High                    │
│ ✓ Template readiness   2 approved                                   │
│ ✓ Variables            all mapped (2 with fallback)                 │
│ ✓ Media                header image ready                           │
│ ✓ WhatsApp connection  healthy, webhook receiving                   │
│ ⚠ Warning              +91 87xx quality decreased to Medium         │
│ ✗ Launch blocker       none                                         │
└────────────────────────────────────────────────────────────────────┘
┌ What will be sent ─────────────────────────────────────────────────┐
│ +91 98xx  → promo_sept_img  ~415,000   +91 87xx → promo_sept_img ~415,000   +91 76xx → promo_sept_txt ~414,300 │
│ [Preview a recipient: phone or row ▾]                                                                           │
└────────────────────────────────────────────────────────────────────┘

PRIMARY CTA
  [🚀 Launch campaign]   (disabled with the blocker listed if any)   ·  [Save draft]  [Send test]

ADVANCED CONTENT
  ▸ Technical Details: frozen plan version, route table, allocator version.

MOBILE BEHAVIOR
  Preflight stacks; Launch button sticky at bottom.
```

Launch = Plan + Execute in one action (the two backend steps stay separate internally; the user never sees "Plan" and "Execute" as two buttons).

---

## 15. Flight Deck

```
PAGE HEADER (campaign detail header, see §13)

PRIMARY CTA
  [Pause]   secondary: [Reduce speed ▾] [Emergency stop] (red, confirm dialog)

PRIMARY CONTENT
┌ Progress ──────────────────────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ 71%     Sent 887,400 of 1,244,300               │
│ Speed 560/s (target 600/s)   ETA 37m   Elapsed 26m   Sending ●        │
└────────────────────────────────────────────────────────────────────┘
┌ Outcomes ──────────────────────────────────────────────────────────┐
│ Waiting 356,900 │ Sending 1,200 │ Sent 887,400 │ Delivered 831,020 │ Read 540,200 │ Failed 7,100 │ Retrying 812 │ Unknown 14 │
└────────────────────────────────────────────────────────────────────┘

SECONDARY CONTENT
┌ Speed (last 15 min) ─────────────┐ ┌ Delivery funnel ────────────────┐
│  ~~~~ line chart actual vs target │ │ Sent ▓▓▓▓▓▓▓▓▓▓ 100%             │
│                                   │ │ Delivered ▓▓▓▓▓▓▓▓▓ 93.6%        │
│                                   │ │ Read ▓▓▓▓▓▓ 60.9%                │
└───────────────────────────────────┘ └──────────────────────────────────┘
┌ Numbers ──────────────────────────────────────────────────────────┐
│ Number     State     Speed     Waiting   Sent     Delivered  Failed  Health │
│ +91 98xx   Sending   210/220   118,000   296,000  93.9%      0.7%    ● High │
│ +91 87xx   Sending   200/220   119,000   295,000  93.4%      0.9%    ● High │
│ +91 76xx   Rate-limited 150/160 119,900  296,400  93.5%      0.8%    ⚠ Medium│
└───────────────────────────────────────────────────────────────────┘
┌ Problems ─────────────────────────────────────────────────────────┐
│ Invalid recipient 4,100 · Rate limited 812 (retrying) · Template unavailable 0 · Unknown 14 │
│ [Open Recovery →]                                                                            │
└───────────────────────────────────────────────────────────────────┘

ADVANCED CONTENT
  ▸ Advanced: queue depth per route, stale leases, throttled routes, reconciliation state, cell/transport ownership, last event cursor, provider latency, webhook lag.

MOBILE BEHAVIOR
  Progress + Pause/Resume sticky at top; Outcomes as 2×4 grid; charts hidden behind "Charts" toggle; Numbers as cards; Problems as a list.
```

Live updates come from an aggregate stream (SSE), one event per campaign per second at most, never per recipient (spec §23). Until SSE exists, the existing 4-second polling stays but the UI shows a "Live" dot with last-updated time so staleness is honest.

Controls:
- Pause / Resume / Emergency stop map to existing lifecycle actions.
- Reduce speed opens a small sheet: choose Balanced / Conservative or set per-number rates (only while Paused for topology changes; rate changes allowed while Paused per backend rules).
- Route adjustment (add a compatible sender) is an Advanced action with a preflight re-check.

---

## 16. Recovery

```
PRIMARY CTA
  [Retry eligible (812)]

PRIMARY CONTENT
┌ Failure groups ─────────────────────────────────────────────────────┐
│ Group                       Count    Action                           │
│ Retry eligible              812      [Retry] [Download]               │
│ Invalid recipient           4,100    [Download] [Add to Do-not-contact]│
│ Template unavailable        0                                        │
│ Template/account mismatch   0                                        │
│ Rate limited                (folded into Retry eligible)             │
│ Permission problem          0                                        │
│ Media error                 0                                        │
│ Sender unavailable          0        [Change sender & retry]         │
│ Permanent failure           2,188    [Download] [Create campaign from failed] │
│ Delivery unknown            14       [Download]  (never auto-resent; reconcile first) │
│ Reconciliation required     0                                        │
└─────────────────────────────────────────────────────────────────────┘
Row click → drawer with sample recipients, the human-readable reason, ▸ Technical Details (provider code, raw error).

SECONDARY CONTENT
  "Create campaign from failed" pre-fills a new Rocket draft with the selected group's recipients and original CSV columns.
  "Change template & retry" / "Change compatible sender & retry" open a compact chooser that only lists compatible options.

ADVANCED CONTENT
  ▸ Technical Details: error code histogram, retry attempts distribution, lease/settlement diagnostics.

MOBILE BEHAVIOR
  Groups as cards with count and a single primary action; downloads allowed; bulk retry allowed with confirm.
```

Rule shown in the UI: "Delivery unknown means we could not confirm whether Meta accepted the message. These are never resent automatically."

---

## 17. Export

```
PRIMARY CTA
  [Export]

PRIMARY CONTENT
  Include: (•) All  ( ) Sent ( ) Delivered ( ) Read ( ) Failed ( ) Pending ( ) Invalid ( ) Duplicate ( ) Do-not-contact ( ) Delivery unknown ( ) Retry eligible
  Columns: [x] Original CSV columns (always on for "All")  [x] Outcome  [x] Sender  [x] Template  [x] Timestamps  [ ] Technical (provider id, error codes, route)
  Size estimate: ~1.25M rows · ~180 MB → "This export runs in the background. We'll notify you when it's ready."

SECONDARY CONTENT
┌ Export history ───────────────────────────────────────────────────┐
│ Sep 27 10:12  All · 1.25M rows  ✓ Ready   [Download] (expires in 7d) │
│ Sep 26 18:40  Failed · 7,100    ✓ Ready   [Download]                 │
│ Sep 26 18:39  All               ⏳ 42%                                │
└───────────────────────────────────────────────────────────────────┘

MOBILE BEHAVIOR
  Same form stacked; downloads open in browser.
```

Small exports (under a threshold the backend decides) stream immediately as today. Large ones become background jobs with object-storage results and history (spec §25).

---

## 18. Number Center

```
PAGE HEADER
  Numbers · "WhatsApp numbers connected to this workspace"

PRIMARY CTA
  [+ Connect Number]

PRIMARY CONTENT
┌────────────────────────────────────────────────────────────────────┐
│ ● +91 98765 43210   Acme Sales          Connected · Quality High     │
│   Account: Acme Retail WABA · 14 templates · Sending in 1 campaign  │
│   Inbox: 80 open                      [Open Inbox] [Templates] [⋯]  │
│ ⚠ +91 87654 32109   Acme Support        Registration required        │
│   Account: Acme Retail WABA · 14 templates                            │
│   Next step: enter your 6-digit PIN    [Complete setup] [⋯]           │
│ ○ +91 76543 21098   Acme Ops            Verification required        │
│   Next step: verify with SMS or voice  [Complete setup] [⋯]           │
└────────────────────────────────────────────────────────────────────┘
  ⋯ menu: Sync, Disconnect, Technical Details

SECONDARY CONTENT
  Summary strip above the list: Connected 1 · Needs action 2 · Quality warnings 0 · Total speed available 240 msg/s

ADVANCED CONTENT
  Drawer per number → tabs Overview · Templates · Health · Technical Details (Phone Number ID, WABA ID, throughput level, last sync, raw provider metadata).

MOBILE BEHAVIOR
  Cards as above, primary action full-width; Technical Details accessible; no editing of raw fields.
```

Removed from the current Phone Numbers page: the manual form with WABA ID / Quality / Status / Provider / TPS Limit inputs. Status and quality are facts from Meta, not user inputs. If the workspace is in mock mode, the page says so in one line and offers "Add test number" clearly labelled as a test.

---

## 19. Connect Number flow

Click **Connect Number** → dialog with two large choices:

```
┌ Connect a WhatsApp number ───────────────────────────────────────┐
│                                                                  │
│  ┌───────────────────────────┐  ┌───────────────────────────┐  │
│  │  Connect with Meta         │  │  Connect manually          │  │
│  │  Recommended. Sign in with │  │  Use an access token from  │  │
│  │  Facebook and pick numbers.│  │  your Meta Business.       │  │
│  │  [Continue]                │  │  [Continue]                │  │
│  └───────────────────────────┘  └───────────────────────────┘  │
│                                                                  │
│  Not sure? → "Which should I choose?" (help drawer)              │
└──────────────────────────────────────────────────────────────────┘
```

### 19.1 Connect manually

```
Step 1 of 2 — Details
  Phone number     [+91 98765 43210        ]
  Access token     [••••••••••••••••••••••••] (i) Where do I find this?
  [Discover]

Step 2 of 2 — Confirm
  We found:
    Number       +91 98765 43210 · "Acme Sales"
    Account      Acme Retail WABA
    Status       Verified · Registration required
  [Connect]
```

If discovery finds more than one WABA and cannot choose safely:

```
  We found several WhatsApp accounts for this token. Pick the one that owns this number:
    ( ) Acme Retail WABA (3 numbers)
    ( ) Acme Wholesale WABA (1 number)
  ▸ I know the WABA ID  [                ]
```

Never shown in the normal path: Phone Number ID, Business ID, App ID, System User ID, Webhook ID.

### 19.2 After connect

The number lands in the list with its real setup state and, if needed, a **Complete setup** button that opens §21.

---

## 20. Embedded Signup flow

```
[Connect with Meta] → Meta popup (Facebook login, business selection, number selection)
        ↓ returns code
Backend exchanges code → token, discovers WABAs and all phone numbers
        ↓
┌ Choose numbers to connect ───────────────────────────────────────┐
│ Acme Retail WABA                                                  │
│ [x] +91 98765 43210  Acme Sales     Connected                     │
│ [x] +91 87654 32109  Acme Support   Registration required         │
│ [ ] +91 76543 21098  Acme Ops       Pending Meta review           │
│ Acme Wholesale WABA                                               │
│ [ ] +91 65432 10987  Wholesale      Connected                     │
│                                                    [Connect 2]    │
└───────────────────────────────────────────────────────────────────┘
```

Multi-select is the default. The Meta modal is only the credential step; Wabista owns the selection screen so the user is never limited to what the modal happened to show.

---

## 21. Number registration flow (Complete setup)

Two distinct concepts that the UI must never blur:

| Concept | What it is | UI wording |
|---|---|---|
| Verification code | One-time code Meta sends by SMS or voice to prove you own the number | "Verify your number" · "Send code by SMS / voice" · "Enter the code we sent" |
| Two-step PIN | A 6-digit PIN you set to register the number for Cloud API | "Set your 6-digit PIN" · "Register" |

```
Complete setup — +91 87654 32109

  ✓ Discovered
  ✓ Verified                     (skipped when Meta reports already verified)
  ● Registration required
      Enter the 6-digit two-step verification PIN for this number.
      If you have never set one, choose any 6 digits — you'll need it again if you move the number.
      PIN  [ _ _ _ _ _ _ ]
      [Register]
  ○ Connected

Verification step (only when required):
      We need to verify you own this number.
      (•) Send code by SMS   ( ) Call me with the code
      [Send code]
      Code [ _ _ _ _ _ _ ]   [Verify]
```

Uses `ui/input-otp.tsx` (already present, unused). Errors are human-readable with the Meta code under Technical Details (see §40).

Setup states shown as a vertical stepper: Discovered → Verification required → Verified → Registration required → Connected, with side states Meta approval pending, Action required, Error rendered as a chip on the relevant step.

---

## 22. Template Studio

```
PAGE HEADER
  Templates · "Message templates approved by Meta for your numbers"

PRIMARY CTA
  [+ Create Template]     secondary: [Sync]

Tabs: Meta Templates · Drafts · Library

PRIMARY CONTENT (Meta Templates)
  Filters: [Search…] [Status ▾ Approved/Pending/Rejected/Paused/Disabled] [Category ▾] [Language ▾] [Number ▾]
┌────────────────────────────────────────────────────────────────────┐
│ promo_sept_img     Marketing · en_US   ✓ Approved                    │
│   Image header · 2 variables · 1 button · Available on 2 numbers    │
│ order_update_v2    Utility · hi         ⏳ Pending review             │
│ festive_video      Marketing · en_US    ✗ Rejected — "Promotional content in utility category" │
│ promo_aug          Marketing · en_US    ⏸ Paused by Meta             │
└────────────────────────────────────────────────────────────────────┘
Row click → drawer: WhatsApp-style preview, components, variables, which numbers/accounts can send it, status history, [Clone] [Delete] · ▸ Technical Details (template id, WABA id, raw components JSON).

Drafts: templates being authored in Wabista, not yet submitted. Editor with header (none/text/image/video/document), body with {{n}} insertion, footer, buttons (quick reply / URL / phone), language, category, sample values for review. [Submit to Meta].

Library: reusable starting points (system, workspace, white-label). Card grid by category. [Use this] → creates a Draft.

ADVANCED CONTENT
  ▸ Technical Details in the drawer only.

MOBILE BEHAVIOR
  List and preview drawer work; the draft editor is read-only on small screens with "Edit on desktop".
```

Rule: the status chip is always Meta's status. There is no status dropdown anywhere. Manually created local templates (mock mode, tests) are labelled "Local" and can never be marked Approved by hand.

---

## 23. Contacts

```
PAGE HEADER
  Contacts

PRIMARY CTA
  [Import Contacts]

Tabs: All · Segments · Do Not Contact

PRIMARY CONTENT
  Filters: [Search…] [Tag ▾] [Status ▾] [Source ▾] [Last activity ▾]
  Table: Name · Phone · Tags · Last message · Last campaign · Status
  Server pagination (keep 25/page, debounced search).
  Row click → contact drawer: fields, custom fields, tags, opt-out, campaign history, conversation history, notes.
  Bulk: select → Add tag / Add to Do-not-contact / Export.

SECONDARY CONTENT
  none

ADVANCED CONTENT
  Custom fields management under Settings → Workspace → Contact fields.

MOBILE BEHAVIOR
  Cards (name, phone, tags); drawer full-screen; import allowed for small files, large imports prompt "best on desktop".
```

Do Not Contact tab = today's Suppressions page with debounce added and a reason column.

---

## 24. Segments

List of saved filters with live counts (counts computed server-side, cached):

```
Delivered but unread (Diwali Teaser)   84,300   [Use in campaign] [Edit]
Replied in last 7 days                  3,310   [Use in campaign]
Tag: VIP                                1,204   [Use in campaign]
```

Editor: rule builder with AND groups: campaign outcome, tag, custom field, engagement window. Reusable in Rocket step 1.

---

## 25. Analytics

```
PAGE HEADER
  Analytics · date range [Last 30 days ▾]

PRIMARY CONTENT
  Summary strip: Sent · Delivered % · Read % · Failed % · Replies
  Trend chart (sent/delivered/read/failed by day)
  Tabs: Campaigns · Templates · Numbers
    Campaigns: table with delivered/read/failed/replies per campaign
    Templates: performance per template (read rate, reply rate, failure rate)
    Numbers: performance and quality trend per number

ADVANCED CONTENT
  ▸ Operations: actual vs target speed, queue depth, throttling, retry rate, provider latency, webhook lag, reconciliation, delivery unknown, route health. Rendered only for Admin+ and collapsed by default.

MOBILE BEHAVIOR
  Summary + trend; tables become cards.
```

Charts use the existing `ui/chart.tsx` wrapper and `--chart-*` tokens instead of hardcoded hex values.

---

## 26. Meta Health

```
PAGE HEADER
  Meta Health · "Status of your WhatsApp connection"

PRIMARY CONTENT
┌ Connection ───────────────────────────────────────────────────────┐
│ ✓ WhatsApp connected     ✓ Webhook receiving (last event 8s ago)   ✓ Token valid │
└───────────────────────────────────────────────────────────────────┘
┌ Alerts ───────────────────────────────────────────────────────────┐
│ ⚠ Number quality decreased      +91 87xx · Medium since Sep 25      [View number] │
│ ⚠ Template paused by Meta        promo_aug                          [View template] │
│ ! Number setup incomplete        +91 76xx · Registration required   [Complete setup] │
└───────────────────────────────────────────────────────────────────┘
┌ Numbers ─────────────────┐ ┌ Accounts ────────────────┐ ┌ Templates ───────────────┐
│ 2 healthy · 1 needs action│ │ 1 account · OK           │ │ 12 approved · 1 paused   │
└──────────────────────────┘ └──────────────────────────┘ └──────────────────────────┘

ADVANCED CONTENT
  ▸ Technical Details: raw health payloads, token scopes, webhook subscription fields, last sync log.

MOBILE BEHAVIOR
  Connection line + alerts list; details on tap.
```

---

## 27. Settings

```
Settings
  Workspace      name, logo, timezone, default country code, contact custom fields, data retention
  Team & Roles   members, pending invitations, roles (Owner, Admin, Campaign Manager, Inbox Agent, Analyst/Viewer)
  Billing        plan, usage, invoices (only when a billing provider is integrated; otherwise this page is not rendered)
  White Label    brand name, logo, colours, custom domain, email sender, template library override (Owner only, only once implemented)
Developer
  API & Webhooks  keys, outbound webhooks, event log (only once implemented)
```

Settings pages use a two-column layout on desktop: section nav left, form right. Forms use `ui/form.tsx` + react-hook-form + zod (already installed, unused) instead of hand-rolled `useState` objects.

---

## 28. First-use onboarding

Home shows a checklist card until every step is complete or dismissed:

```
┌ Get started with Wabista ───────────────────────────────────────┐
│ ✓ 1. Connect WhatsApp                                            │
│ ● 2. Connect a number                       [Connect Number]     │
│ ○ 3. Sync templates                                              │
│ ○ 4. Import contacts                                             │
│ ○ 5. Launch your first campaign                                  │
│ ○ 6. Open Smart Inbox                                            │
│                                                   [Dismiss]      │
└──────────────────────────────────────────────────────────────────┘
```

Each step's completion is derived from real data (a Connected number exists, templates count > 0, contacts > 0, a campaign reached Sending, the inbox was opened). Demo/sample rows do not count.

---

## 29. Empty states (catalog)

Use the existing `ui/empty.tsx` (present, unused today). Each has an icon, one line of copy, and one or two actions.

| Page | Copy | Actions |
|---|---|---|
| Numbers | "No WhatsApp numbers connected yet." | [Connect with Meta] [Connect manually] |
| Templates | "No templates available yet." | [Sync Templates] [Create Template] |
| Campaigns | "Launch your first campaign." | [New Campaign] |
| Contacts | "No contacts yet. Import a CSV or add one manually." | [Import Contacts] [Add contact] |
| Smart Inbox | "No conversations yet. Replies to your campaigns and messages to your numbers will appear here." | [View numbers] |
| Recovery | "Nothing to fix. All messages were accepted." | — |
| Export history | "No exports yet." | [Export] |
| Meta Health alerts | "No alerts. Everything looks healthy." | — |
| Segments | "Create a segment to reuse an audience." | [New Segment] |
| Automations / Flows (until real) | Page not linked; if reached: "Automations are not available in this release." | — |
| Search results | "No matches for '…'." | [Clear search] |

---

## 30. Loading states

- Lists: 5 skeleton rows (`ui/skeleton.tsx`, present, unused today), never "Loading contacts…" text.
- Summary strips: skeleton tiles.
- Drawers: skeleton header + 3 lines.
- Buttons: spinner inside the button, label unchanged, button disabled.
- Flight Deck: first paint from the last known aggregate; "Live" dot turns grey with "Reconnecting…" while the stream is down.
- Rocket upload: progress bar with bytes processed and rows seen (already implemented in the import dialog; keep).

---

## 31. Error states

Every error answers two questions: What happened? What should I do next?

```
┌ Couldn't load campaigns ─────────────────────────────┐
│ The server didn't respond. Your data is safe.         │
│ [Try again]                          ▸ Technical Details │
└──────────────────────────────────────────────────────┘
```

- Page-level fetch errors: inline card as above (today pages ignore `isError`).
- Mutation errors: toast with the human message; if the backend returned `details[]`, the toast has "View details" opening a dialog (reuse `CampaignNotReadyDialog` pattern).
- Preflight blockers: never a toast; always an inline list on the Review step with a link per item.
- 403: "You don't have access to this area. Ask an admin for the Campaign Manager role." (not the raw JSON).
- Global crash: keep `ErrorBoundary`, restyle with tokens.

---

## 32. Drawer strategy

Use a right-side sheet (`ui/sheet.tsx`) for anything that is "look at / lightly edit one item while keeping the list": contact, message, number, template, failure group, export job, notification. Width 480px desktop, full-screen mobile, URL-addressable (`?drawer=contact:123`) so links and back button work.

## 33. Modal strategy

Use a dialog for a decision or a short input: confirm stop/delete, enter OTP/PIN, choose Connect method, send test message, quick create (segment name). Never for multi-step editing; Rocket is a page, not a modal.

## 34. Advanced strategy

"Advanced" is a collapsible section inside a form or page that reveals expert controls (per-number rates, per-template mapping overrides, dedupe scope). It is closed by default, remembers its open state per user, and never contains the only way to complete a common task.

## 35. Technical Details strategy

"Technical Details" is a read-only accordion at the bottom of drawers and detail pages. It shows raw IDs, provider payloads, internal states and timestamps in mono with copy buttons. It exists so support and developers never need the database, and so normal screens never need to show an ID.

---

## 36. Status vocabulary

Internal values are the ones in the database/API today. Display labels are what the UI shows. Colours use the chip variants from §3.2.

### 36.1 Campaign (`campaigns.status`)

| Internal | Display | Variant |
|---|---|---|
| Draft | Draft | outline |
| Ready | Ready to launch | info |
| Scheduled | Scheduled | info |
| Running | Sending | success |
| Paused | Paused | warning |
| Completed | Completed | secondary |
| Cancelled | Stopped | destructive |
| Failed | Failed | destructive |

### 36.2 Message / job (`campaign_jobs.status` + provider status)

| Internal | Display | Variant |
|---|---|---|
| Queued | Waiting | secondary |
| Processing | Sending | info |
| Throttled | Rate-limited, will retry | warning |
| Sent (provider: sent) | Sent | success |
| provider: delivered | Delivered | success |
| provider: read | Read | success |
| Failed | Failed | destructive |
| Cancelled | Cancelled | outline |
| Failed with provider intent `delivery_unknown` | Delivery unknown | warning |
| V2 `Held` (sender unavailable, no compatible sender) | On hold | warning |

Note: `delivery_unknown` is a `provider_messages.status` value today, not a job status; the job itself is `Failed`. The UI derives the "Delivery unknown" label from the provider intent so operators never see it as an ordinary failure.

### 36.3 Number setup state (V2 model)

| State | Display | Next action shown |
|---|---|---|
| Discovered | Discovered | Continue setup |
| VerificationRequired | Verification required | Send code |
| Verified | Verified | Register |
| RegistrationRequired | Registration required | Enter PIN |
| Connected | Connected | — |
| MetaApprovalPending | Pending Meta review | — |
| ActionRequired | Action required | (specific) |
| Error | Error | View details |

Current `phone_numbers.status` values Connected / Pending / Flagged map to Connected / Discovered / ActionRequired until the V2 state column exists.

### 36.4 Quality (`phone_numbers.quality`)

High → "Quality High" (success) · Medium → "Quality Medium" (warning) · Low → "Quality Low" (destructive) · Unknown → "Quality unknown" (outline)

### 36.5 Template (`templates.status`, Meta values)

APPROVED → Approved (success) · PENDING → Pending review (info) · REJECTED → Rejected + reason (destructive) · PAUSED → Paused by Meta (warning) · DISABLED → Disabled (destructive) · local-only → Local (outline)

### 36.6 Route / sender lane (`campaign_routes.status`)

Active → Sending · Throttled → Rate-limited · Paused → Paused · Error → Problem

### 36.7 Import row (`campaign_contacts.status`)

Valid → Valid · Invalid → Invalid number · Duplicate → Duplicate · Suppressed → Do-not-contact

### 36.8 Conversation (V2)

Open · Snoozed · Resolved · (Unassigned is a filter, not a state)

---

## 37. Role-aware UX

- Navigation per §5.2.
- Buttons the user cannot use are not rendered (not greyed), except when hiding would confuse (e.g. "Stop campaign" for a Viewer shows a tooltip "Ask a Campaign Manager").
- Owner-only areas (Billing, White Label, connector claims) show an "Owner only" chip in the settings nav.
- Inbox Agent home is inbox-centric: My chats, Unassigned, today's replies; no campaign tiles.

---

## 38. Mobile behavior

| Pattern | Rule |
|---|---|
| Tables | Become stacked cards below `md`; each card shows 3–4 key fields and the status chip; row actions in a `⋯` sheet |
| Drawers | Full-screen with a back arrow |
| Wizards | Allowed but with a "best on desktop" banner for large CSVs and template authoring |
| Charts | Hidden behind a toggle; summary numbers always visible |
| Sticky controls | Pause/Resume/Stop sticky at the top of Flight Deck; Launch sticky at the bottom of Review |
| Inbox | Two-level navigation; composer with locked reply-from chip |
| Forms | Full-width inputs, 16px font (prevents iOS zoom), FAB for the primary action |
| Zoom | Remove `maximum-scale=1` |
| Overflow | Action rows wrap (`flex-wrap`); today's 9-button Rocket row does not |

---

## 39. Technical data that stays hidden by default

| Data | Where it may appear |
|---|---|
| Phone Number ID, WABA ID, Business ID, App ID, System User ID | Technical Details only |
| Access tokens | Never displayed after entry; "Replace token" action only |
| Route IDs, job IDs, lease tokens, plan versions, allocator version | Technical Details / Advanced |
| Queue depth, stale leases, throttled routes, cell ownership | Flight Deck → Advanced |
| Redis, worker, shard, broker, reservoir | Never in the UI (ops docs only) |
| Raw Meta error JSON | Technical Details under a human-readable line |
| Provider message ID | Message drawer → Technical Details; Export "Technical" columns |
| Webhook payloads | Meta Health → Technical Details; Developer → event log |
| Throughput level (STANDARD/HIGH) | Shown as "Speed available: up to 80 msg/s" in normal UI; raw value in Technical Details |

---

## 40. Human-readable errors (examples)

Headline is what the user sees. The raw code stays under Technical Details.

| Situation (Meta / internal) | Headline | Next step line |
|---|---|---|
| Template does not exist for this phone's WABA (Meta 132001) | Template unavailable on this number | Pick a template this number can send, or re-sync templates. |
| Template paused (Meta 132015) | Template paused by Meta | Edit and resubmit the template, or choose another. |
| Phone not registered (Meta 133010) | Registration required | Enter your 6-digit PIN to register this number. |
| Invalid/expired access token (Meta 190) | WhatsApp connection needs attention | Reconnect with Meta or replace the access token. |
| Missing permission (Meta 10/200) | Permission problem | The connected account can't send from this number. Reconnect with an admin account. |
| Rate limit hit (Meta 130429 / 80007) | Rate limited | We'll retry automatically at a safer speed. |
| Invalid recipient (Meta 131026 / 131030) | Invalid recipient | The number can't receive WhatsApp messages. Download and clean the list. |
| Media download failed (Meta 131053) | Media error | Re-upload the header image. |
| Parameter mismatch (Meta 132012) | Variables don't match the template | Check the variable mapping for this template. |
| Provider timeout after send attempt | Delivery unknown | We couldn't confirm delivery. These are held, not resent. |
| Sender lane paused/throttled internally | Sender unavailable | Waiting for +91 87xx to recover, or move to a compatible number. |
| CSV column missing at plan time | A variable points to a column that isn't in your file | Map "{{2}}" to another column or set a fixed value. |
| Route template WABA mismatch (current preflight text) | Template not available on this number | Choose a template this number supports. |

The current preflight strings ("Route 12 template 7 is not selected", "Route 12 template WABA does not match its phone number WABA") are engineering messages; V2 keeps them in Technical Details and adds the headline layer above.

---

## 41. Component conventions and reuse map

| Need | Reuse today | V2 change |
|---|---|---|
| Buttons, inputs, selects, checkbox, radio, textarea, label | `ui/*` shadcn (in use) | none |
| Badge/status chip | `ui/badge.tsx` with success/warning/info variants | add `statusChip` helper, remove per-page maps |
| Dialog / AlertDialog | in use | keep for decisions only |
| Sheet | in use for mobile nav | becomes the standard drawer |
| Tabs | `ui/tabs.tsx` (present, unused) | campaign detail, inbox, templates, contacts |
| Command palette | `ui/command.tsx` (present, unused) | header search |
| Empty | `ui/empty.tsx` (present, unused) | all empty states |
| Skeleton | `ui/skeleton.tsx` (present, unused) | all loading states |
| Input OTP | `ui/input-otp.tsx` (present, unused) | verification code and PIN |
| Progress | `ui/progress.tsx` (in use) | campaign progress |
| Chart | `ui/chart.tsx` (present, unused) | Flight Deck and Analytics |
| Form | `ui/form.tsx` + react-hook-form + zod (installed, unused) | settings, template drafts, connect flows |
| Toast | `use-toast` (in use, limit 1) | raise limit to 3, shorten remove delay |
| Page header | none | new `PageHeader` |
| Summary strip | none | new `StatStrip` |
| Action Center item | none | new `ActionItem` |
| Technical Details | none | new `TechnicalDetails` accordion |
| Org context | 5 duplicated lookups | new `useActiveOrganization()` hook |
| Responsive table | none | new `DataTable` with card fallback |

---

## 42. Accessibility

- Every icon-only button gets an `aria-label` (today most `⋯` buttons and the bell have none).
- Status is never colour-only; chips always carry text.
- Focus order follows visual order in wizards; `Esc` closes drawers and dialogs; focus returns to the trigger.
- Tables have proper headers; card fallbacks use `dl` lists.
- Minimum touch target 44px on mobile.
- Respect `prefers-reduced-motion` for the page-entry animations used today.

---

## 43. Copy guidelines

- Sentence case for buttons and titles ("Connect number", not "Connect Number" in body copy; nav labels may use Title Case).
- Numbers formatted with locale separators; percentages one decimal.
- Time: relative for under 24h ("2m ago"), absolute otherwise, workspace timezone.
- Avoid: "job", "route", "worker", "queue", "TPS", "WABA", "Graph API", "payload" outside Advanced/Technical Details.
- Prefer: "number", "sender", "template", "speed", "waiting", "sending", "account", "connection".
