---
name: Composite TS project references redirect to stale dist declarations
description: Why an artifact's own `tsc --noEmit` can report "no exported member" for symbols that clearly exist in a referenced lib package's source.
---

In this monorepo, `lib/*` packages are TS composite projects (`"composite": true`, `emitDeclarationOnly`) referenced via `"references"` in each artifact's tsconfig, while their `package.json` "exports" points straight at `./src/index.ts` (source, not dist) — a pattern meant to let dev/runtime resolution use source directly.

TypeScript's project-reference "declaration redirect" overrides that: when compiling a project that references a composite project, `tsc` resolves imports of the referenced package to its **already-built `dist/*.d.ts` files**, not the live source, unless `disableSourceOfProjectReferenceRedirect` is set. If a merge (e.g. from an isolated task-agent repl) adds new exported tables/types to a `lib/db` (or other `lib/*`) schema file but nothing rebuilds that package's `dist`, every artifact's standalone `tsc -p ... --noEmit` will report the new symbols as missing/not-exported — even though `grep`ing the source proves they exist, and the lib package typechecks fine in isolation.

**Why:** this makes a real, merged, correct schema change look like a broken merge if you only run an artifact's own `pnpm run typecheck` script. The failure is entirely a stale-build artifact, not a code defect.

**How to apply:** after any merge that touches a `lib/*` package (schema, shared types, etc.), rebuild it first — `cd lib/<pkg> && npx tsc -p tsconfig.json` (composite build) for each affected lib, or just run the root `pnpm run typecheck` (which runs `tsc --build` across libs before delegating to each artifact). Never conclude a typecheck failure is a real regression until you've ruled out a stale composite build this way.
