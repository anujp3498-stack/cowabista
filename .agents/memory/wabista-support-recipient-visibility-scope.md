---
name: Support/ops recipient visibility is within-org, not cross-tenant
description: Scope decision for "what will this campaign send" style features -- who gets to see it and how broad the view is.
---

When asked to let "support" see a frozen campaign plan's exact recipients/messages, this always means staff who are already members of the customer's own organization (an ops/support role on their team), not a cross-tenant/platform-staff access system. The codebase has no impersonation or staff-authorization layer (`isPlatformAdmin` exists on the user model but is an unused future seam) -- do not build one for this kind of request without being explicitly asked.

**Why:** confirmed directly with the user when scoping a "give support visibility into a frozen plan" feature; building a cross-tenant staff-access layer would have been out-of-scope, unrequested surface area.

**How to apply:** implement recipient-visibility features as an ordinary org-scoped read (same `organizationId` auth check as every other campaign-engine route). When the ask is "bulk" (browse/search the whole list) rather than "single" (look up one contact), add a paginated/searchable endpoint that reuses the exact same resolution core (template + mapping-snapshot resolution) the single-lookup and live-send paths already use, so bulk and single views can never disagree.
