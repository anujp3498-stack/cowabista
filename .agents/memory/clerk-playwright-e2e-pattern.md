---
name: Clerk + Playwright programmatic E2E pattern (Wabista Nexus)
description: How to write a real, committed Playwright test that signs in via Clerk without the UI and seeds data directly via drizzle, plus the pitfalls that make it silently fail.
---

## Programmatic Clerk sign-in
- `@clerk/testing/playwright` exposes `clerkSetup()` (call once in Playwright
  `globalSetup`; reads `CLERK_SECRET_KEY` + a publishable-key env var
  automatically) and `clerk.signIn({ page, emailAddress })`, which signs in
  via a sign-in-token/ticket strategy -- no password and no Clerk UI
  interaction needed.
- Create the test user first via `@clerk/backend`'s
  `clerkClient.users.createUser({ emailAddress: [email], skipPasswordRequirement: true, ... })`.
  Email addresses created this way are verified by default.
- Always delete the Clerk user (and any DB rows/orgs seeded for the test) in
  a `finally` block so the dev DB/Clerk instance doesn't accumulate test
  data across runs.

## Seeding directly via drizzle from a frontend package's test
- A frontend-only workspace package (e.g. a Vite app) can add `@workspace/db`
  and `drizzle-orm` as devDependencies to let its Playwright spec (a plain
  Node process) seed/assert rows directly, mirroring how backend integration
  tests seed tenants. `drizzle-orm` must be an **explicit** devDependency of
  that package too -- pnpm's strict node_modules isolation means importing it
  transitively through `@workspace/db` fails with "Cannot find package
  'drizzle-orm'" even though it resolves fine inside the db package itself.

## JIT-provisioning race: poll every dependent read, not just the first
- If a first-login flow provisions a user row and then, in a *separate*
  transaction, provisions org membership rows, a test that polls only for
  the user row and then does a single read for memberships can catch the
  window between the two and see zero memberships. Poll each dependent read
  with its own retry loop.

## baseURL must go through the shared reverse proxy, not localhost:port
- When two artifacts/services are multiplexed under one origin by Replit's
  path-based reverse proxy (e.g. a web app on one port, an API server on
  another port mounted at `/api`), Playwright's `baseURL` must be
  `https://$REPLIT_DEV_DOMAIN`, never `http://localhost:<port>`. Hitting the
  dev server directly bypasses the proxy, so relative `/api/*` fetches
  404-fall-through into the frontend dev server's own SPA/HTML fallback
  instead of reaching the API service. Symptom: a generated API client's
  list hook returns an HTML string body (200 OK, `content-type: text/html`)
  instead of JSON, and calling an array method on it throws something like
  `"<field>.find is not a function"` -- easy to misdiagnose as a zod/schema
  bug when it's actually a networking/proxy misconfiguration in the test.

## Headless Chromium on this Replit NixOS environment
- `npx playwright install --with-deps` fails here (tries to shell out to
  `apt`, which doesn't exist). Run `npx playwright install chromium`
  (browser binary only, no `--with-deps`), then separately install the
  missing shared libraries as Nix system dependencies via
  `installSystemDependencies` from the package-management skill:
  `glib, nss, nspr, dbus, atk, at-spi2-atk, at-spi2-core, cups, libdrm,
  expat, mesa, gtk3, pango, cairo, alsa-lib, libxkbcommon, xorg.libX11,
  xorg.libXcomposite, xorg.libXdamage, xorg.libXext, xorg.libXfixes,
  xorg.libXrandr, xorg.libxcb, xorg.libxshmfence, systemd, libgbm`. Note
  `libgbm` is its own top-level Nix package, not bundled inside `mesa`.
