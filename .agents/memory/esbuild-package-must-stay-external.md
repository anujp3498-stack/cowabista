---
name: esbuild package must stay external when bundling a file that imports it
description: A test/build script that itself imports the `esbuild` npm package (to build a nested harness) breaks with "__filename is not defined" if the outer bundler inlines esbuild into an ESM bundle instead of externalizing it.
---

## The issue

Some test files build their own nested artifact at runtime (e.g. an OS-process
crash-recovery harness) by calling `esbuild`'s `build()` API directly. When the
*outer* build step (the harness that compiles `*.test.ts` files before running
them) bundles that test file with `bundle: true` and does not list `"esbuild"` in
its own `external` array, esbuild's package internals get inlined into the ESM
output. esbuild's own code relies on a CJS-style `__filename` global to locate its
native binary, which does not exist in an ES module — even a `require` shim banner
(`createRequire(import.meta.url)`) does not fix this, because the failure is a bare
`__filename` reference, not a `require()` call.

Symptom: `ReferenceError: __filename is not defined` thrown from deep inside the
bundled output (e.g. `esbuildCommandAndArgs`/`ensureServiceIsRunning`), not from
any line the test itself wrote — easy to mistake for an unrelated environment
regression.

**Why:** esbuild's package is written assuming it runs as unbundled CJS/Node code
with real `__filename`; bundling it defeats that assumption regardless of output
format banners.

## How to apply

Any bundler config used to compile a file that itself does
`import { build } from "esbuild"` must add `"esbuild"` to its own `external` list,
the same way `pg-native`/`pino`/`thread-stream` are already externalized for other
native/worker-thread reasons. Check for this whenever a new test or script both (a)
gets bundled by another build step and (b) imports `esbuild` itself.
