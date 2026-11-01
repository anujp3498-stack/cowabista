# Campaign modules: Normal and Rocket campaigns

Branch `feature/campaign-modules-normal-rocket` (from `wabista-nexus-v2` at `6d6c27f`). Not deployed and not merged.

## What the user sees

| | Normal campaigns | Rocket campaigns |
|---|---|---|
| Sidebar | Campaigns | Rocket Campaigns |
| List | `/campaigns` (Normal campaigns only) | `/rocket-campaigns` (Rocket campaigns only) |
| New | "New campaign", `/campaigns/new` | "New Rocket campaign", `/rocket-campaigns/new`: created directly, never picks an existing campaign |
| Step 1 | Audience: upload a CSV | Audience: upload a CSV (its own audience) |
| Step 2 | Message: **one** number, **one** template, variables, header media, preview, test send | Message: **several** numbers, **several** templates (rotated automatically), variables, header media |
| Step 3 | (none) | Delivery: speed per number (TPS, preselected at each number's maximum), automatic audience distribution (equal by numbers, or equal by templates) |
| Last step | Review & Launch, with a **Sending speed** choice (Fastest safe, Balanced, Conservative); send now or schedule | Review & Launch; send now or schedule |
| Campaign page | `/campaigns/:id`: progress, messages, setup; pause, resume, stop. Before launch: a link to Review & Launch | `/rocket-campaigns/:id`: the same, plus **Change speed** while running or paused |
| Advanced settings | n/a | Collapsed by default: the sending routes (read-only) on the Delivery step and the campaign page; on the Rocket list, the old route tools for campaigns created before types |

Opening a campaign under the other module (for example `/rocket-campaigns/12` for a Normal campaign), or a step
its module does not have (`/campaigns/12/delivery`), redirects to the campaign's own page.

A campaign created before types keeps the full historical builder (Audience, Message, Delivery, Review) and Plan/Execute
wherever it is opened; it is never redirected between modules.

A typed campaign is launched only from Review & Launch: its page never offers Plan or Execute, so a scheduled campaign
cannot be started early (Stop is still available). Creating needs the manager role or higher: agents do not see "New",
and a direct visit to a "new" page explains the role instead of offering a retry.

## How it works

Both modules run on the one existing engine: imports, message setup, delivery setup, structured preflight,
Launch (send now or schedule), allocator v2, adjust-speed and the unchanged runtime. Nothing in planning,
allocation, launch, pacing, sending or the zero-send safeguards changed.

- **Type.** `campaigns.campaign_type` (`standard` | `rocket` | NULL), set once by `POST /api/campaigns`
  (`campaignType`) and never changed (PATCH ignores it).
- **Starting setup.** A Normal campaign starts with distribution `equal_numbers` and speed `balanced` (it has no
  Delivery step). A Rocket campaign starts with `equal_numbers` and no speed (chosen in its Delivery step).
- **Normal rule.** A Normal campaign's message setup accepts one number and one template (400
  `campaign_type_limit` otherwise).
- **Always allocator v2.** A typed campaign cannot go back to allocator v1: message setup refuses
  `distributionMode: null` (400 `distribution_invalid`).
- **Routes.** A typed campaign's routes are the allocator-v2 sender lanes derived from its numbers, templates and
  speed. Manual route create, update and delete, and the legacy `rocket-setup`, are refused for typed campaigns
  (409 `campaign_type_mismatch`) and keep working for campaigns created before types.
- **Lists.** `GET /api/campaigns/list?type=standard|rocket`. Every campaign response carries `campaignType` and
  `campaignTypeInferred`.
- **Replays.** `creationKey` replays stay per type: a key first used for the other type answers 409
  `creation_key_conflict`, and the page then starts a new draft. Each module keeps its own pending key in the
  browser.
- **Live speed change** (Rocket). The engine changes speed only while a campaign is Paused (V2-06C). The
  Change speed dialog reads the campaign's current status, then runs the existing actions in order: pause,
  then `adjust-speed`, then resume. A Paused campaign gets `adjust-speed` only and stays paused.
  - The pause answer carries `alreadySettled`. When it is true (someone else had already paused the campaign),
    the dialog saves the new speed and leaves the campaign paused.
  - The dialog's pause and resume carry `purpose: "speed_change"`. A plain pause sent by anyone while that hold is
    in place is recorded as a pause of its own. The speed-change resume is then refused (409
    `paused_by_someone_else`), so their pause stands. Plain pauses, resumes and retries behave exactly as before:
    an idempotent retry still writes no audit row.
  - Campaigns launched without a distribution (allocator v1) never show the button.
  - If the server refuses the new speed, the campaign is left paused (never resumed at the old speed) and the
    dialog says so.
  - Queued messages get the new per-number rate. Messages already in flight, the frozen plan and the template
    assignments do not change.

## Existing records

The column is nullable and has no default, so no existing row is rewritten. A campaign created before types
keeps NULL. It is listed with Rocket campaigns when it has more than one route, otherwise with Normal campaigns,
and it keeps every legacy behaviour:
- no default distribution or speed, and no one-number rule;
- the legacy route tools and `rocket-setup` still work;
- Plan and Execute stay available on its campaign page.

## Production (planned with the owner, never applied from here)

The only schema change is `deploy/campaign-modules/campaign_type_additive.sql`:
`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type text` plus a column comment.

- **Lock and data.** On PostgreSQL 11+ it is metadata-only: it holds the ACCESS EXCLUSIVE lock only for the
  catalog update and rewrites no row.
- **Validated.** `apply-sql --check` accepts both statements. On a disposable database pushed from `6d6c27f`,
  applying the file and then running the guarded `push --verbose --strict` printed no `campaign_type`
  statement. Only the drizzle-kit re-emits listed in `docs/DEVELOPMENT.md` remained (11 foreign keys, 4
  defaults, 6 trigram indexes).
- **Cutover package.** The release cutover package (`deploy/cutover/package`, release `830d274`) does not
  contain this column. Shipping this branch needs either a new release of the package (its schema check and
  checksums updated), or this file applied as a separate, planned additive step before the new code starts.
  Old code ignores the column, so the column may be added before the code.
- **Gate B.** `lib/db/src/schema/campaigns.ts` changed, so the Gate B measured-files hash changes (see the
  report). No measured service file changed.

## Tests

| What | Where |
|---|---|
| API (types, defaults, replay, lists, Normal rule, typed route refusals, Normal launch and schedule, Rocket rotation, per-number speed, pause, adjust, resume, legacy campaigns) | `artifacts/api-server/test/campaign-modules.test.ts` (`pnpm --filter @workspace/api-server run test:campaign-modules`) |
| Browser, both modules end to end on a mock workspace | `artifacts/wabista-nexus/test/e2e/campaign-modules.spec.ts` |
| Module paths and steps, live speed sequence, per-module keys, Rocket speed defaults | `artifacts/wabista-nexus/test/unit/*.test.ts` |
