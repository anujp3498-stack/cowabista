---
name: Pre-signup team invitations design
description: How Wabista Nexus lets an admin add a teammate by email before that person has an account, and how it's reconciled on first login.
---

Inviting an email with no matching account does not fail (no 404). It creates
a Pending row in `organization_invitations` (email stored lowercased) instead
of an organization membership. Inviting an email that *does* match an
existing user still adds them immediately, unchanged from before invitations
existed.

**Why:** the earlier behavior forced whoever provisions a team to wait for
every teammate to sign up first; teams are usually assembled before everyone
has an account.

**How to apply:** the acceptance hook lives in `attachOrgContext`'s
zero-membership branch (a brand-new user's very first authenticated
request), inside the same per-user advisory-locked transaction that already
guards against double-provisioning a personal org. It calls
`acceptPendingInvitations(user, tx)` *before* falling back to
`provisionPersonalOrganization`: if the new user's email (compared
case-insensitively, per the `clerk-invite-email-case` lesson) matches any
Pending invitations, all of them are accepted (membership created per
invitation, row marked Accepted) and a personal workspace is *not* also
created. Only a user with zero matching invitations gets the old
personal-workspace-on-first-login behavior. If someone is invited to
multiple orgs before ever signing up, they join all of them on that first
login; the earliest invitation's org becomes their default active org.

A partial unique index (`organization_id, email` where `status = 'Pending'`)
allows re-inviting the same address after a prior invite was revoked or
accepted, while still preventing duplicate simultaneous Pending rows -- the
invite endpoint upserts (refreshes role) rather than erroring on a repeat
invite to the same still-Pending address.
