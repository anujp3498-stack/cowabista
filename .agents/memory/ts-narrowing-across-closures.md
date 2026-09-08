---
name: TypeScript narrowing of an object property doesn't survive a closure boundary
description: A `const foo = maybeUndefined(); if (!foo.value) return;` guard followed by using `foo.value` inside a nested async callback (e.g. db.transaction(async (tx) => ...)) silently re-widens to `T | undefined`, breaking `tsc --noEmit` even though the logic is correct.
---

TypeScript narrows a variable itself across closures (an effectively-const local stays narrowed), but does **not** narrow a *property read off an object* (`foo.value`) once that read happens inside a nested function body declared after the guard — because the compiler can't prove the object's property wasn't mutated between the guard and the callback running. This is easy to trigger with `db.transaction(async (tx) => { ... use foo.value ... })` right after an early-return null check on `foo.value`.

**Why:** it compiled and ran correctly in every test (the property genuinely never changes at runtime), so the bug is invisible unless someone actually runs `pnpm run typecheck` — a build-tool-only test suite (esbuild-transpiled tests) will never catch it, letting a real typecheck regression sit unnoticed for a while.

**How to apply:** immediately after the guard, assign the narrowed property to its own local variable (`const value = foo.value; if (!value) return;`) and use that local everywhere inside the nested callback instead of re-reading `foo.value`. When auditing "did my last change break the build," run `pnpm run typecheck` explicitly — passing tests alone do not prove this.
