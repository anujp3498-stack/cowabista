---
name: Shared campaign Plan/Execute lifecycle
description: Plan/Execute/readiness-dialog logic for campaigns is a shared hook+component, not per-page code, because multiple screens call the same backend contract.
---

The Plan/Execute campaign-transition mutation, the "not ready" 409-readiness-error dialog, and the status→badge-variant/plan-execute-gating rules are extracted into shared code (`use-campaign-lifecycle` hook, `CampaignNotReadyDialog` component, `campaign-status` helpers in the Wabista Nexus frontend) rather than implemented per-page.

**Why:** The backend's campaign lifecycle contract (`POST .../campaigns/:id/actions`, readiness details in the 409 body) is keyed only by organizationId/campaignId — it is not tied to any one frontend screen. The Campaigns page and the Rocket Engine screen both need to let a manager Plan/Execute and see the same readiness errors. Implementing this twice risks the two screens drifting (e.g. one page's gating rule falls out of sync with the backend's actual rule, or a bug fix lands in only one copy).

**How to apply:** Any new screen that needs to trigger a campaign transition (Plan/Execute/Schedule/Pause/Resume/Cancel) should reuse this shared hook/dialog/status-helper trio instead of re-deriving the gating logic or re-parsing the error shape inline.
