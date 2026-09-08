---
name: Orval zod codegen collides when adding a query param to a path-param operation
description: Adding a new query parameter to an operation that already has path params can make orval emit a duplicate type/schema name and break tsc --build.
---

Adding a new optional query parameter to an existing OpenAPI operation that already has path parameters (e.g. `GET /orgs/{organizationId}/campaigns/{campaignId}/template-mappings`) can make orval's zod generator emit two exports with the *same* name: the existing path-params zod object (in `generated/api.ts`) and a new query-params TS type (in `generated/types/<OperationId>Params.ts`) both named `<OperationId>Params`. This breaks `tsc --build` for the zod package with a duplicate-export error.

**Why:** orval names path-param and query-param types after the operationId with the same `<OperationId>Params` convention; when both exist for one operation, the zod codegen target doesn't disambiguate them. Query-only operations (no path params) never hit this because there's no colliding path-params object to begin with.

**How to apply:** before adding a query param to an operation that already has path params, check whether a client-side alternative avoids the backend change entirely (e.g. duplicate a small pure derivation function in the frontend instead of asking the backend for a live preview). If the query param is unavoidable, expect to rename one side or restructure the operation (e.g. split into a separate endpoint) rather than assuming it will codegen cleanly.

**Confirmed working alternative:** for a lookup-style operation on a path-param resource (e.g. "resolve one contact under campaign :campaignId"), define it as `POST .../plan/preview` with the lookup key(s) in the request body instead of `GET .../plan/preview?contactId=...`. This sidesteps the collision entirely (no query-params type is ever generated) and Orval codegen (including the zod client) succeeds cleanly. Trade-off: the operation is no longer cacheable as a GET and becomes a mutation hook (`useMutation`) instead of a query hook on the frontend, which is fine for on-demand lookups.

**The POST+body workaround only works with named `$ref` schemas.** Switching a colliding GET+query op to POST+body still collides (this time as `<OperationId>Body`) if the request body or response is defined as an inline `type: object` schema in the OpenAPI spec — orval generates the same duplicate-export problem for inline bodies/responses on a path-param operation. Fix: define the request body and response as separate named schemas under `components/schemas` (e.g. `FooInput`, `FooPage`) and reference them with `$ref` instead of inlining. This is required, not optional, whenever the operation already has path params.
