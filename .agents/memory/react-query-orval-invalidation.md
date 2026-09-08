---
name: React Query + Orval mutations need manual invalidation
description: Orval-generated create/update/delete hooks never auto-invalidate list queries; every CRUD page must do it explicitly.
---

Orval-generated `useCreate<X>` / `useUpdate<X>` / `useDelete<X>` mutation hooks do not know about, and never invalidate, the corresponding `useList<X>` query cache. Without explicit invalidation, a create/update/delete can appear to silently no-op in the UI — the mutation succeeds (toast fires) but the list doesn't reflect it until something else happens to trigger a refetch (e.g. an incidental window-focus refetch), which makes the bug look intermittent/flaky rather than a hard failure.

**Why:** discovered via end-to-end testing — one CRUD page "worked" only because a focus event happened to trigger React Query's default `refetchOnWindowFocus`, while a sibling page (same pattern, same generated hooks) visibly failed to show a newly created row. The generated hooks have no shared query-key knowledge to invalidate automatically.

**How to apply:** in every mutation's `onSuccess`, call `queryClient.invalidateQueries({ queryKey: getList<X>QueryKey(organizationId) })` (the matching key getter is exported alongside each generated hook). Do this for create, update, and delete on every entity — don't rely on default refetch-on-focus/mount behavior to mask a missing invalidation.

**Related race:** if a dialog/form closes (unmounting or disabling its own detail query) right after a save, don't fire-and-forget `invalidateQueries()` before closing — `await` it (or `Promise.all` of all the invalidations) before calling the close/onOpenChange handler. Otherwise a fast reopen of the same dialog can render one frame of pre-save data before the background refetch lands, which looks like a real persistence bug during e2e testing even though the database write was already correct.
