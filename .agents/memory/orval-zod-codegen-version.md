---
name: Orval zod codegen version bug
description: Orval config option needed to avoid a broken generated zod client version string.
---

Orval's zod-schema generator can emit a `catalog:`-style workspace version string into the generated client instead of a real semver, which breaks the build.

**Why:** the generator infers the zod version to target from the workspace's own `zod` dependency spec, and pnpm catalog references (`catalog:`) aren't a valid version for the generator to reason about.

**How to apply:** in the orval config, explicitly pin `override.zod.version: 3` so generation targets a concrete zod major version instead of inferring from the workspace catalog reference.
