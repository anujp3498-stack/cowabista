---
name: Orval zod response schema and format:date
description: Why an OpenAPI `format: date` field on a response schema breaks a plain "YYYY-MM-DD" contract when the generated zod schema is used to validate/serialize the response.
---

Orval's zod codegen maps an OpenAPI `{ type: string, format: date }` schema to `zod.coerce.date()`, not `zod.string()`. If a response schema uses that field and the handler calls `GeneratedResponseSchema.parse(...)` on a plain `"YYYY-MM-DD"` string before `res.json(...)`, zod coerces it into a real `Date` object. `JSON.stringify` then serializes it as a full ISO datetime (`"2026-08-26T00:00:00.000Z"`), silently breaking any frontend code (or test) that expected a bare date string.

**Why:** discovered while building an analytics delivery-trends endpoint whose response schema `.parse()` step is also used for response validation/serialization (a common pattern in this codebase), not just request input validation.

**How to apply:** for a date-only field in a *response* schema, use `{ type: string, description: "YYYY-MM-DD" }` (no `format: date`) in `lib/api-spec/openapi.yaml`, or manually format when serializing if `format: date` is otherwise wanted for docs/OpenAPI tooling. Re-run orval and grep the generated schema for `zod.coerce.date()` if a date field's shape ever looks suspicious.
