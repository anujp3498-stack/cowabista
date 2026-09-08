---
name: Clean-source benchmark bundles
description: Preserving Node module resolution without invalidating clean-source benchmark evidence.
---

Generated Node benchmark bundles that externalize package dependencies must stay
under the package directory so Node can resolve those dependencies. The bundle
directory must also be ignored by Git, and capacity-study runners must verify the
source profile both before and after measurement.

**Why:** Moving a bundle to the system temporary directory broke resolution of
externalized logging dependencies; leaving it unignored under the package made
an otherwise clean benchmark report a dirty working tree.

**How to apply:** For evidence-producing Node benchmarks, use a package-local,
Git-ignored temporary build directory and fail the study if commit, measured-file
digest, or clean-tree status changes during a run.