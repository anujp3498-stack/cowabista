import assert from "node:assert/strict";
import { test } from "node:test";
import { observedProviderThroughput, refreshedTpsLimit, UNVERIFIED_PHONE_TPS_LIMIT } from "../src/services/whatsapp-throughput";

test("Meta reported throughput is authoritative", () => {
  assert.deepEqual(observedProviderThroughput({ throughput: { level: "STANDARD" } }), { throughputLevel: "STANDARD", approvedTpsLimit: 80 });
  assert.deepEqual(observedProviderThroughput({ throughput: { level: "HIGH" } }), { throughputLevel: "HIGH", approvedTpsLimit: 1000 });
  assert.deepEqual(observedProviderThroughput({}), { throughputLevel: "UNKNOWN", approvedTpsLimit: null });
  assert.equal(observedProviderThroughput({ throughput: { level: "NOT_APPLICABLE" } }).approvedTpsLimit, null);
  assert.equal(UNVERIFIED_PHONE_TPS_LIMIT, 50);
});

test("tier refresh upgrades defaults, preserves manual lower caps and clamps downgrades", () => {
  assert.equal(refreshedTpsLimit(50, undefined, 80), 80);
  assert.equal(refreshedTpsLimit(30, undefined, 1000), 30, "manual lower cap without prior Meta evidence is preserved");
  assert.equal(refreshedTpsLimit(80, undefined, 1000), 80, "pre-existing custom cap without evidence is preserved");
  assert.equal(refreshedTpsLimit(80, 80, 1000), 1000);
  assert.equal(refreshedTpsLimit(1000, 1000, 80), 80);
  assert.equal(refreshedTpsLimit(40, 80, 1000), 40);
  assert.equal(refreshedTpsLimit(700, 1000, 80), 80);
  assert.equal(refreshedTpsLimit(50, undefined, null), 50);
});
