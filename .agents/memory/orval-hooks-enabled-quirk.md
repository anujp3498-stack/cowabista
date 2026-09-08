---
name: Orval-generated list hooks enabled option quirk
description: Passing a partial query options object to a generated useList hook fails type-checking; how to work around it.
---

Orval-generated `useList<Entity>(organizationId, options?)` React Query hooks type their `options.query` as the full `UseQueryOptions`, which requires `queryKey`. Passing just `{ query: { enabled: someCondition } }` to conditionally gate the query fails TypeScript because the partial object is missing `queryKey`.

**Why:** the generated hook's options type isn't a `Partial<UseQueryOptions>` — it expects a subset that still satisfies required fields once merged, and TS won't infer that the generated default at the call site backfills `queryKey`.

**How to apply:** omit the options argument entirely and rely on the hook's built-in default `enabled` check (typically `organizationId !== null && organizationId !== undefined`), passing the org id cast `as number` for TS purposes. This is correct at runtime even though the id may transiently be `null`/`undefined` before the org context resolves.

For a hook with no such built-in default (e.g. a plain `useList<Entity>(options?)` with no id argument at all, so there's nothing to gate on), passing `{ query: { enabled: someCondition, queryKey: getList<Entity>QueryKey() } }` (explicitly re-supplying the generated query key) satisfies the type without needing the rest of `UseQueryOptions`.

Same quirk hits single-item `useGet<Entity>(id, options?)` hooks, e.g. wanting `retry: false` for a lookup where a 404 is a normal, final outcome (not worth React Query's default 3 retries, which otherwise leaves the UI showing a loading spinner for several seconds after a definitive not-found). Cleanest fix there: skip the generated hook and call `useQuery` directly with the generated `get<Entity>QueryKey(...)` and the generated plain async `get<Entity>(...)` fetch function as `queryFn`, passing whatever real `UseQueryOptions` you need (`retry: false`, `enabled`, etc.) with no typing fight.
