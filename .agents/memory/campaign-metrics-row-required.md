---
name: Campaign metrics row is not auto-created
description: campaign_metrics updates from plan/execute/claim/settle are silent no-ops without a pre-existing row for the campaign.
---

`campaign_metrics` has no trigger or implicit creation tied to `planCampaign`/`executeCampaignPlan`/claim/settle. Every one of those code paths does a plain
`UPDATE campaign_metrics SET ... WHERE campaign_id = ...`, which matches zero rows and raises no error if the row doesn't exist yet.

**Why:** in production the row is created during real CSV import completion. A test fixture that bypasses real import (e.g. inserting `contact_import_sessions` directly and skipping the metrics insert) can drive a campaign all the way through plan → execute → claim → send with everything appearing to work, right up until an assertion reads `campaign_metrics` and gets `undefined`/all-zero — which looks like a completion-tracking bug but is actually a missing test fixture row.

**How to apply:** any integration test that plans/executes/sends without going through the real import pipeline must explicitly `db.insert(campaignMetricsTable).values({ organizationId, campaignId, total, valid })` before calling `planCampaign`.
