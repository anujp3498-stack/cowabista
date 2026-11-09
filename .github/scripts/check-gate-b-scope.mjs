#!/usr/bin/env node
// Dependency-free safety guard: protect the measured release identity against omitted transport files.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const benchmark = readFileSync(path.join(root, "artifacts/api-server/benchmark/campaign-benchmark.ts"), "utf8");
const match = /const measuredFiles = \[([\s\S]*?)\.\.\.schemaFiles,\s*\]\.sort\(\);/.exec(benchmark);
assert.ok(match, "Unable to parse Gate B measured-file list");
const named = [...match[1].matchAll(/"([^"]+)"/g)].map((value) => value[1]);
const required = [
  "artifacts/api-server/benchmark/campaign-benchmark.ts",
  "artifacts/api-server/src/services/campaign-queue.ts",
  "artifacts/api-server/src/services/campaign-runtime.ts",
  "artifacts/api-server/src/services/campaign-phone-reservoir.ts",
  "artifacts/api-server/src/services/campaign-transport-shard-worker.ts",
  "artifacts/api-server/src/services/campaign-transport-shards.ts",
  "artifacts/api-server/src/services/campaign-shard-pacing.ts",
  "artifacts/api-server/src/services/campaign-prepared-broker.ts",
  "artifacts/api-server/src/services/whatsapp-template-sender.ts",
  "artifacts/api-server/src/services/whatsapp-provider.ts",
  "artifacts/api-server/src/services/whatsapp-direct-sender.ts",
  "artifacts/api-server/src/services/whatsapp-transport-credentials.ts",
];
for (const file of required) {
  assert.ok(named.includes(file), `Gate B does not attest to critical file: ${file}`);
  assert.ok(existsSync(path.join(root,file)), `Gate B points to a missing file: ${file}`);
}
assert.equal(new Set(named).size, named.length, "Gate B measured-file list contains duplicates");
console.log(`Gate B scope PASS: ${required.length} critical paths included; ${named.length} named files`);
