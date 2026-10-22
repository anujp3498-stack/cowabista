---
name: Better Auth + Playwright E2E pattern (Wabista Nexus)
description: How the committed Playwright specs get a signed-in browser with public sign-up closed (Option 2a), seed data via drizzle and clean up; replaces the Clerk pattern from before 2026-10-21 and the sign-up pattern from before 2026-10-22.
---

- Public sign-up is closed (decision U2, Option 2a, 2026-10-22). The E2E API runs with `AUTH_PUBLIC_SIGN_UP`
  unset, exactly as production. Seed accounts the way the operator command writes them:
  `createAccount(name, email)` in `artifacts/wabista-nexus/test/e2e/auth-helpers.ts` inserts an unverified
  `auth_users` row and a `credential` `auth_accounts` row whose password is `hashPassword()` from
  `better-auth/crypto` (never a plaintext password in SQL). The random per-run password is never printed.
- Sign in from the page's own context so the session cookie lands in the browser:
  `signInViaApi(page, baseURL, email)` (`page.request.post('/api/auth/sign-in/email', ...)` with a trusted
  `Origin`; Better Auth refuses a POST without one), or through the form.
- Rate limits: all browser requests reach the API from one address (the Vite proxy appends it; `TRUST_PROXY=1`
  trusts only that hop), and Better Auth allows 3 sign-ins (and 3 change-passwords) per 10 s per address.
  Call `waitForSignInWindow(page)` before a burst of sign-ins.
- The local `users` row appears on the first authenticated API call; find it through `auth_user_links` by the
  Better Auth user id (`localUserFor`), then seed orgs/memberships with drizzle.
- Cleanup: `deleteAuthUsers(emails)` removes the local rows, their personal workspaces and the `auth_users`
  rows (sessions/accounts/links cascade).
- Drive the single origin that serves the SPA and proxies `/api` (the Vite dev server,
  `http://localhost:24902`, = `BETTER_AUTH_URL`), never the API port.
- UI test ids: `input-sign-in-*`, `button-sign-in-submit`, `auth-error`, `sign-in-no-account`,
  `sign-up-closed`, `button-change-password` (account menu), `input-current-password`, `input-new-password`,
  `input-confirm-password`, `button-change-password-submit`, `change-password-error`,
  `change-password-success`, `button-sign-out`. The sign-up form ids (`input-sign-up-*`) render only when
  `GET /api/auth-policy` says open (development with `AUTH_PUBLIC_SIGN_UP=open`).
