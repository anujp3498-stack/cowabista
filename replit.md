# Wabista Nexus

Wabista Nexus is a professional multi-tenant messaging and WhatsApp Business API management platform: CRM-style contact management plus a campaign engine (the "Rocket Campaign Engine") that can split a campaign across multiple sending routes (phone number + WABA + template) for scale and reliability.

## Run & Operate

- `pnpm --filter @workspace/wabista-nexus run dev` — run the dashboard frontend (main app, served at `/`)
- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string; `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY`/`VITE_CLERK_PUBLISHABLE_KEY` — Clerk auth

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Auth: Clerk (`@clerk/express` server-side, `@clerk/react` client-side)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/wabista-nexus/src/pages/` — one file per route (contacts, phone-numbers, templates, campaigns, rocket-campaigns, team-roles, overview, home, auth, settings, etc.)
- `artifacts/wabista-nexus/src/lib/mock-data.ts` — still the source for Overview's decorative "Recent Activity" feed and for the intentionally out-of-scope pages (Inbox, Automations, Billing, API & Developers); everything else now reads real data
- `artifacts/api-server/src/routes/` — one Express router per resource (organizations, members, contacts, phone-numbers, templates, campaigns, campaign-routes, overview, me)
- `artifacts/api-server/src/middlewares/auth.ts` — `requireAuth`/`attachOrgContext`/`requireRole`: Clerk session check, JIT user + personal-org provisioning, active-org resolution, role enforcement
- `artifacts/api-server/src/lib/orgProvisioning.ts` — creates a personal organization + seeds its demo data on a user's first login
- `lib/db` — Drizzle schema (source of truth for tables/columns), including a `wabas` table (WhatsApp Business Accounts) and a `users.isPlatformAdmin` flag reserved for a future platform-admin area
- `lib/api-spec` — OpenAPI spec (source of truth for API contracts); run its `codegen` script after changing it to regenerate `lib/api-client-react`'s generated hooks/types
- `lib/api-client-react/src/generated/api.ts` — Orval-generated React Query hooks (`useList<X>`, `useCreate<X>`, ...) and matching `getList<X>QueryKey` helpers

## Architecture decisions

- Auth is Clerk; on first authenticated request `attachOrgContext` JIT-provisions a local `users` row and, if the user has no organization memberships yet, auto-creates a personal organization pre-seeded with demo data — so the app is never empty on first login. First-login provisioning is race-safe: it's guarded by a per-user Postgres advisory lock (`pg_advisory_xact_lock`) inside a transaction, so concurrent initial requests from the same brand-new user can't create duplicate personal orgs.
- Multi-tenancy: every domain table is scoped by `organizationId`; RBAC (`owner`/`admin`/`manager`/`agent`) is enforced server-side per route via `requireRole`, not just hidden in the UI.
- Invite linking matches emails case-insensitively (both sides normalized to lowercase) — see `.agents/memory/clerk-invite-email-case.md`.
- Every CRUD mutation must manually call `queryClient.invalidateQueries` with the matching `getList<X>QueryKey` in its `onSuccess` — Orval's generated hooks don't invalidate automatically. See `.agents/memory/react-query-orval-invalidation.md`.
- Switching the active organization (header workspace switcher) does a full page reload after activating, rather than relying on query-cache invalidation alone — the server resolves the active org from a cookie, and some pages' client-computed permission checks were observed to go stale otherwise. See `.agents/memory/org-switch-stale-cache.md`.
- WhatsApp integration settings are tenant-scoped and owner/admin protected. Administrators configure the external WABA ID; credentials remain in the authorized Replit connector and are never stored by the app. WABAs, phone numbers, and approved templates synchronize from Meta Graph v23.0.
- The deployment connector uses one shared authorization, so exactly one organization may claim real WhatsApp mode at a time. Only an owner can make or change that verified connector/WABA claim; all other organizations must use deterministic mock mode.
- Campaign dispatch uses the tenant's mock or real WhatsApp provider mode. Accepted provider message IDs and signed webhook delivery events are persisted idempotently; delivery/read/failure metrics advance monotonically.
- Explicitly out of scope for now: real-data wiring for Inbox/Automations/Billing/Analytics/API & Developers pages (these still read `mock-data.ts`).

## Product

Wabista Nexus is a real, database-backed multi-tenant app (not a demo): sign up/sign in via Clerk, land in an auto-provisioned workspace, manage Contacts/Phone Numbers/Templates/Campaigns/Campaign Routes with full CRUD, invite teammates with roles (RBAC enforced), switch between organizations, synchronize WhatsApp Business resources, and dispatch template campaigns. Automations, inbox, billing, and analytics are UI-only previews for now.

## User preferences

- Non-technical user, mixes Hindi/English; prefers work explained step by step and wants things actually implemented, tested, and verified — not just described.

## Gotchas

- `getOrCreateLocalUser`/invite flows: any future email comparison must lowercase both sides — see `.agents/memory/clerk-invite-email-case.md`.
- Any new CRUD mutation must call `invalidateQueries` on the matching list query key in `onSuccess`, or the list will look stale until an incidental refetch happens — see `.agents/memory/react-query-orval-invalidation.md`.
- Any new "switch active tenant" action driven by a server-side cookie/session should hard-reload rather than trust in-memory cache invalidation alone — see `.agents/memory/org-switch-stale-cache.md`.
- After editing `lib/api-spec`, re-run its `codegen` script; if the zod client version comes out broken, check `override.zod.version: 3` is still pinned in the orval config — see `.agents/memory/orval-zod-codegen-version.md`.
- There is currently no UI to create a second/additional organization (`useCreateOrganization` exists in the generated client but nothing calls it) — users only get the one auto-provisioned personal org plus any orgs they're invited into.
- Team invites require the invitee to already have signed in at least once (no email-delivery invite system yet); inviting an email with no matching account returns a 404.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
