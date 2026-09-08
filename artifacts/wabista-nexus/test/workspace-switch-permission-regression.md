# Workspace-switch permission regression check (Task #7)

> **Superseded by an automated spec.** This check now runs as a real,
> committed Playwright test:
> `artifacts/wabista-nexus/test/e2e/workspace-switch-permission.spec.ts`
> (`pnpm --filter @workspace/wabista-nexus run test:e2e`). It signs in a real
> Clerk test user programmatically (`@clerk/testing` + `@clerk/backend`, no
> UI), seeds Org A/Org B plus one distinguishable member per org directly via
> `@workspace/db`, and drives the actual workspace switcher in both
> directions -- asserting both permission-UI staleness (Invite button / role
> selects) and cross-tenant member-data leakage. It cleans up everything it
> creates. Re-run it any time `WorkspaceSwitcher`, `attachOrgContext`, or the
> member/role-gating logic in `team-roles.tsx` changes. The manual
> testing-subagent plan below is kept as history/fallback documentation only.

## Why this exists

Manual testing once found a real bug: switching the active workspace left
`Team & Roles` (`src/pages/team-roles.tsx`) showing a stale, more-privileged
role -- the "Invite Member" button and editable role `<Select>` dropdowns
stayed visible to a Manager -- until `WorkspaceSwitcher.handleSwitch`
(`src/components/layout/shell.tsx`) was changed to clear the React Query
cache **and** force a full page reload on every org switch, instead of
relying on cache invalidation alone.

The root cause is entirely client-side (a stale React Query cache surviving
an org switch), so it cannot be caught by a backend-only test that calls
Express route handlers directly -- it requires driving the real rendered
frontend through an actual org switch. There is no Playwright/Vitest harness
in this workspace yet, so this check is codified as a fully-specified
testing-subagent plan instead of a committed spec file. Re-run it verbatim
(via the `testing` skill's `subagent` callback with `config: { $kind:
"testing" }`) any time `WorkspaceSwitcher`, `attachOrgContext`, or the
member/role-gating logic in `team-roles.tsx` changes -- especially any change
that reintroduces "just invalidate a few queries" instead of a full reload on
switch.

## Test plan (paste verbatim as the subagent `task`)

```
This app (Wabista Nexus) uses Clerk Auth. Sign in programmatically -- do not
use Clerk's sign-in UI.

Context: guarding against a specific regression -- switching the active
workspace must immediately reflect the new organization's role in the UI,
never a stale/more-privileged role from the previous org. The fix lives in
WorkspaceSwitcher.handleSwitch (artifacts/wabista-nexus/src/components/layout/shell.tsx),
which clears the React Query cache and does a full page reload on switch.
The permission-gated UI under test is on the Team & Roles page
(artifacts/wabista-nexus/src/pages/team-roles.tsx): the "Invite Member"
button (data-testid="button-invite-member") and per-row editable role
selects (data-testid="select-role-<memberId>") should only render for an
Owner/Admin of the *currently active* organization.

Relevant schema (Postgres, via drizzle):
- `organizations` (id serial pk, name text, slug text unique)
- `organization_members` (id serial pk, organization_id int fk, user_id int fk, role text -- one of 'owner'|'admin'|'manager'|'agent')
- `users` (id serial pk, clerk_id text unique, email text, name text)
The active org for a request is resolved from the `wabista_active_org_id` cookie (falls back to the user's first membership by id).

1. [New Context] Create a new browser context
2. [Clerk Auth] Sign in as {firstName: "Switch", lastName: "Tester", email: `switch-test-${nanoid(6)}@example.com`}. Note the email as <login_email>.
3. [Browser] Let onboarding create the user's personal workspace (Org A). Note its name and id as <org_a_name>/<org_a_id>. This user is Owner of Org A.
4. [DB] Find this user's id in `users` by `clerk_id`/`email`, then insert a second organization ("Org B", any unique name/slug) and an `organization_members` row for this same user in Org B with `role = 'manager'`. Note Org B's id/name as <org_b_id>/<org_b_name>.
5. [Browser] Navigate to Team & Roles (path: /team-roles) while Org A (Owner) is active.
6. [Verify] Assert "Invite Member" (data-testid="button-invite-member") is visible, and note that editable role selects are usable for other members if any exist.
7. [Browser] Use the workspace switcher (data-testid="button-workspace-switcher") to switch to Org B (data-testid="option-workspace-<org_b_id>", or select by visible name <org_b_name>).
8. [Verify]
   - Assert the workspace switcher now shows <org_b_name> as active.
   - Navigate to /team-roles if not already there.
   - Assert "Invite Member" (data-testid="button-invite-member") is ABSENT (a manager cannot invite).
   - Assert no editable role <Select> (data-testid="select-role-*") is rendered for any member row -- only plain role text.
9. [Browser] Switch back to Org A (data-testid="option-workspace-<org_a_id>" or by <org_a_name>).
10. [Verify] Assert "Invite Member" is visible again on /team-roles (Owner permissions restored for Org A).

Report explicitly whether at any point after a switch the UI showed
permissions from the PREVIOUS org (the specific bug this test guards
against), and include a screenshot of the Team & Roles page immediately
after switching to Org B as evidence.
```

## Last verified

- 2026-08-28: ran verbatim via the testing subagent (with the `[DB]` step
  creating Org B directly rather than through an API/UI flow) -- verdict
  `success`. Org A (Owner) showed "Invite Member"; after switching to Org B
  (manager), "Invite Member" and all editable role selects were absent; after
  switching back to Org A, Owner permissions were restored. No stale
  permissions from the previous org were observed at any point.
