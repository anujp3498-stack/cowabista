---
name: Org-scoped mutation pattern and error shape in wabista-nexus
description: How pages get the active organizationId for generated mutations, and how to read structured error bodies since ApiError isn't exported.
---

Every wabista-nexus page needing `organizationId` for an org-scoped generated mutation (e.g. `useTransitionCampaign`, `useUpdateOrganization`, `useSyncWhatsAppResources`) uses the same pattern: `const { data: organizations } = useListOrganizations(); const activeOrg = organizations?.find(o => o.isActive) ?? organizations?.[0];` then passes `activeOrg.id`. No shared hook/context wraps this — it's copy-pasted per page (see integrations.tsx, settings.tsx, campaigns.tsx).

`lib/api-client-react`'s `ApiError` class (thrown by `customFetch` on non-2xx) is **not** re-exported from the package's public `index.ts` (only `setBaseUrl`/`setAuthTokenGetter`/`AuthTokenGetter` are). Code outside the lib cannot do `error instanceof ApiError`.

**Why:** the generated mutation's `onError` receives this error as an untyped/unknown value at the call site, so structured backend error bodies (e.g. a 409 `{ error, details: string[] }`) must be read via duck-typing: check `typeof error === "object"` and read `(error as any).data` / `.status`, rather than an instanceof check.

**How to apply:** when surfacing a specific backend error message/details array in the UI, write a small local helper that duck-types `error.data` instead of importing/using `ApiError`.
