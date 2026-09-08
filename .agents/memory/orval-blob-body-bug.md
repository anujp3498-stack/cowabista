---
name: Orval binary/Blob request bodies get JSON.stringify'd
description: Generated mutation hooks for a raw file/binary upload endpoint silently corrupt the body; write the fetch call by hand instead.
---

For an OpenAPI operation whose request body is a raw binary type (e.g. `content: { application/octet-stream | text/csv: { schema: { type: string, format: binary } } } }`, orval's generated `api-client-react` mutation function still does `body: JSON.stringify(<blobArg>)` instead of passing the `Blob`/`File` through untouched. Using the generated `useX` hook for such an endpoint sends `"{}"` (or similar) as the body instead of the real bytes -- the request "succeeds" at the HTTP layer but the payload is garbage.

**Why:** discovered building a large-CSV streaming upload endpoint; the generated `useStreamContactImport` hook's `mutationFn` called `streamContactImport(...)` whose body was hardcoded to `JSON.stringify(streamContactImportBody)` even though the parameter type was `BodyType<Blob>`. This is an orval codegen gap for binary bodies, not a one-off typo -- expect it on any binary-upload operation.

**How to apply:** for any endpoint with a binary/blob request body, do not use the generated hook for the actual upload. Instead, hand-write a `fetch()` call using the generated `get<OperationId>Url()` helper for the URL (that part is fine) and pass the raw `File`/`Blob` as `body` directly, setting headers yourself. Still fine to use generated hooks/types for everything else (query keys, response types, GET/JSON endpoints).
