---
name: Campaign readiness needs two separate template steps
description: Why "Plan" can fail with "template is not selected" even after a route already has a template picked.
---

In Wabista Nexus, a campaign route (`POST .../campaign-routes`) lets you pick a template per-route, but that alone does not satisfy `validateCampaignReady`. Campaign readiness also requires a **separate** campaign-level template selection + variable mapping step (`GET/PUT .../campaigns/:campaignId/template-mappings`, backed by `campaign-preflight.ts` and `template-mapping.ts`). Confirmed via e2e testing: adding a route with a template, then clicking Plan, fails with "Route N template M is not selected" — the route-level template choice and the campaign-level template-mappings selection are independent state.

**Why:** the backend was built with a plan/execute lifecycle where template variable mapping (header/body/button -> contact field or fixed value) is validated and frozen at plan time, so it needs its own explicit selection step distinct from which template a route sends.

**How to apply:** when building or debugging any UI/feature that touches campaign readiness or the Plan action, remember both steps must be completed (route's template AND campaign's template-mappings selection) or Plan will correctly reject with a specific readiness error — this is expected backend behavior, not a bug. As of 2026-08-28 the template-mappings step has a UI (`TemplateMappingDialog` in `campaigns.tsx`) plus a `CampaignReadinessChecklist`, so do not assume this step is still unbuilt — verify current UI state in the codebase before treating it as a gap.
