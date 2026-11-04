#!/usr/bin/env bash
# Prints the release-artifact SHA-256 rows of deploy/cutover/FINAL-SEQUENCE.md §6 for a built checkout.
# Usage: release-hashes.sh <checkout-dir>   (after pnpm install --frozen-lockfile and both builds)
set -euo pipefail
cd "$1"
for f in \
  artifacts/api-server/dist/index.mjs \
  artifacts/api-server/dist/auth-admin.mjs \
  artifacts/api-server/dist/campaign-transport-shard-worker.mjs \
  artifacts/api-server/dist/pino-worker.mjs \
  artifacts/api-server/dist/pino-file.mjs \
  artifacts/api-server/dist/pino-pretty.mjs \
  artifacts/api-server/dist/thread-stream-worker.mjs \
  artifacts/wabista-nexus/dist/public/index.html \
  pnpm-lock.yaml; do
  # A missing artifact must fail the job, not print a blank hash: the printf below does not propagate a failed
  # command substitution, so every build lacking the same file used to diff as identical.
  if [ ! -s "$f" ]; then echo "release artifact missing or empty: $f" >&2; exit 1; fi
  printf '%s %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
done
spa_files=$(cd artifacts/wabista-nexus/dist/public && find . -type f | wc -l | tr -d ' ')
if [ "$spa_files" -lt 1 ]; then echo "release artifact missing: the SPA build is empty" >&2; exit 1; fi
spa_tree=$(cd artifacts/wabista-nexus/dist/public && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)
printf '%s %s\n' "$spa_tree" "spa-tree(${spa_files} files)"
