---
name: Better Auth + Playwright E2E pattern (Wabista Nexus)
description: How the committed Playwright specs sign in with Better Auth (no external service), seed data via drizzle and clean up; replaces the Clerk pattern from before 2026-10-21.
---

- Sign up from the page's own context so the session cookie lands in the
  browser: `page.request.post('/api/auth/sign-up/email', { data: { name, email,
  password }, headers: { Origin: <baseURL origin> } })` (helper `signUpViaApi`
  in `artifacts/wabista-nexus/test/e2e/auth-helpers.ts`). Better Auth refuses a
  POST without a trusted Origin. Passwords are random per run, never printed.
- The local `users` row appears on the first authenticated API call; find it
  through `auth_user_links` by the returned Better Auth user id
  (`localUserFor`), then seed orgs/memberships with drizzle as before.
- Cleanup: `deleteAuthUsers(emails)` removes the local rows, their personal
  workspaces and the `auth_users` rows (sessions/accounts/links cascade).
- Drive the single origin that serves the SPA and proxies `/api` (the Vite dev
  server, `http://localhost:24902`, = `BETTER_AUTH_URL`), never the API port.
- Rate limits: all browser requests reach the API from one address (the Vite
  proxy appends it; `TRUST_PROXY=1` trusts only that hop), and Better Auth
  allows 3 sign-ups and 3 sign-ins per 10 s per address. Keep specs within it.
- UI flows (`auth-flow.spec.ts`) use the form test ids `input-sign-up-*`,
  `input-sign-in-*`, `button-sign-*-submit`, `auth-error`, `button-sign-out`.
