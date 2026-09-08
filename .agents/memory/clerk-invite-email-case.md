---
name: Clerk invite email matching must be case-insensitive
description: JIT org-linking by invited email fails intermittently unless both sides are lowercased before comparison.
---

When a multi-tenant app links a brand-new Clerk login to a pending org invite by matching email addresses, an exact-string-equality match is unreliable: Clerk preserves whatever casing the user typed at sign-up, so an invite sent to `Agent@Example.com` won't match a login as `agent@example.com` even though they're the same mailbox.

**Why:** found via end-to-end testing — inviting a member and then having them sign up with the same email (different case) landed them in their own new personal org instead of the inviter's org, because the DB `eq()` comparison was case-sensitive.

**How to apply:** normalize email to `.trim().toLowerCase()` on both write paths — when storing `invitedEmail` on invite creation, and when matching the newly-authenticated user's primary email during JIT provisioning/linking — plus wherever else emails are looked up (e.g. checking for an existing user by email before inviting).
