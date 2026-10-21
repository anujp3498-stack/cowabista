---
name: Pre-signup team invitations design
description: How Wabista Nexus lets an admin add a teammate by email before that person has an account, and how the invitee joins (token-bound since the Better Auth move, 2026-10-21).
---

Inviting an email with no matching account does not fail (no 404). It creates
a Pending row in `organization_invitations` (email stored lowercased, a random
token) instead of an organization membership. Re-inviting refreshes the role
and issues a new token, so an older shared link stops working.

**Since 2026-10-21 (Better Auth, decision D1):** email/password sign-up does
not verify email ownership, so an email match alone must never grant
membership (anyone could sign up as an invited address, owner role included).
- `POST /members` adds an existing account immediately only when its Better
  Auth email is verified (`auth_users.email_verified`, none are yet); every
  other case, including legacy Clerk-era rows, gets a Pending invitation.
- The invitee joins with `POST /invitations/accept {token}` while signed in
  with the invited email (403 `invitation_email_mismatch` otherwise, 404 unknown
  token, 409 not Pending). The route deliberately skips `attachOrgContext`, so
  a brand-new invitee's first call does not create a personal workspace first.
  It takes the same per-user advisory lock as first-login provisioning and
  locks the invitation row, so concurrent accepts create one membership; an
  existing member keeps their role.
- `attachOrgContext` still calls `acceptPendingInvitations` (email match,
  case-insensitive) on the zero-membership path, but only for verified
  accounts. Today that never happens: a new sign-up with an invited email gets
  a personal workspace and the invitation stays Pending until accepted.
- SPA: the admin copies the link from Team & Roles; `/invite/:token` offers
  sign-up/sign-in (`?invite=` brings them back) and then "Join <org>".

**Why:** teams are usually assembled before everyone has an account, and the
token (shared by the admin) plus the invited email is the proof available
without an email provider.

A partial unique index (`organization_id, email` where `status = 'Pending'`)
allows re-inviting the same address after a prior invite was revoked or
accepted, while still preventing duplicate simultaneous Pending rows -- the
invite endpoint upserts (refreshes role and token) rather than erroring on a
repeat invite to the same still-Pending address.

Tests: `artifacts/api-server/test/invitation-accept.test.ts` (HTTP),
`team-invitations.test.ts` (handlers), E2E `auth-flow.spec.ts`.
