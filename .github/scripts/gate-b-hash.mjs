#!/usr/bin/env node
// Prints the Gate B measuredFilesSha256 of a checkout exactly as artifacts/api-server/benchmark/campaign-benchmark.ts
// computes it (sourceProfile). The measured-file list is read from that file itself, so the two cannot drift.
// Usage: node .github/scripts/gate-b-hash.mjs [checkout-dir]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const benchmark = readFileSync(path.join(root, "artifacts/api-server/benchmark/campaign-benchmark.ts"), "utf8");
const list = /const measuredFiles = \[([\s\S]*?)\.\.\.schemaFiles,\s*\]\.sort\(\);/.exec(benchmark);
if (!list) throw new Error("measuredFiles list not found in campaign-benchmark.ts; update gate-b-hash.mjs");
const named = [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const schemaFiles = execFileSync("git", ["ls-files", "lib/db/src"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const files = [...named, ...schemaFiles].sort();
const hash = createHash("sha256");
for (const file of files) {
  hash.update(file);
  hash.update("\0");
  hash.update(readFileSync(path.join(root, file)));
  hash.update("\0");
}
console.log(`measuredFilesSha256 ${hash.digest("hex")} (${files.length} files)`);
