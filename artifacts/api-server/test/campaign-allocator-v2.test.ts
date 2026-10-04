import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  AllocatorInputError,
  createAllocatorV2,
  type AllocatorV2Input,
  type DistributionMode,
} from "../src/services/campaign-allocator-v2";

// Pure allocator-v2 tests (V2-06A): in memory, no database. 300,000
// synthetic recipients per mode on the canonical X/Y/Z fixture.
//
// Statistical tolerance: assignments come from SHA-256, so counts behave
// like independent draws. For N = 300,000 and p = 1/3 one standard
// deviation is ~258 recipients (0.086% of N); a 1% tolerance on a share of
// N is > 11 standard deviations, and the per-bucket proportion tolerances
// below (1.5 percentage points on buckets of ~50-100k) are > 7 standard
// deviations. They catch any real bias (a wrong formula shifts shares by
// whole percent) while never failing on hash noise.

const RECIPIENTS = 300_000;
const recipients = Array.from({ length: RECIPIENTS }, (_, index) => `+44${String(7_000_000_000 + index * 7919 % 999_999_999).padStart(10, "0")}`);

// Canonical X/Y/Z fixture. Route ids deliberately not in phone order.
const X = { routeId: 31, phoneNumberId: 1, rate: 100 };
const Y = { routeId: 12, phoneNumberId: 2, rate: 200 };
const Z = { routeId: 25, phoneNumberId: 3, rate: 300 };
const A = 101, B = 102, C = 103;
const fixture = (mode: DistributionMode): AllocatorV2Input => ({
  mode,
  templateIds: [A, B, C],
  lanes: [
    { ...X, templateIds: [A, B] },
    { ...Y, templateIds: [A, B, C] },
    { ...Z, templateIds: [B, C] },
  ],
});
const eligible = new Map([[1, new Set([A, B])], [2, new Set([A, B, C])], [3, new Set([B, C])]]);

function run(input: AllocatorV2Input, keys = recipients) {
  const allocator = createAllocatorV2(input);
  const decisions = keys.map((key) => allocator.allocate(key));
  const digest = createHash("sha256").update(decisions.map((d, i) => `${keys[i]}>${d.phoneNumberId}/${d.routeId}/${d.templateId}`).join("\n")).digest("hex");
  return { decisions, digest };
}

function tally(decisions: ReturnType<typeof run>["decisions"]) {
  const bySender = new Map<number, number>();
  const byTemplate = new Map<number, number>();
  const byPair = new Map<string, number>();
  for (const d of decisions) {
    bySender.set(d.phoneNumberId, (bySender.get(d.phoneNumberId) ?? 0) + 1);
    byTemplate.set(d.templateId, (byTemplate.get(d.templateId) ?? 0) + 1);
    byPair.set(`${d.phoneNumberId}:${d.templateId}`, (byPair.get(`${d.phoneNumberId}:${d.templateId}`) ?? 0) + 1);
  }
  return { bySender, byTemplate, byPair };
}

const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);

test("equal by numbers on X/Y/Z: each number gets ~1/3, rotates through ITS eligible templates, never an ineligible pair", () => {
  const started = Date.now();
  const { decisions, digest } = run(fixture("equal_numbers"));
  const elapsed = Date.now() - started;
  const { bySender, byPair } = tally(decisions);
  for (const phone of [1, 2, 3]) near(bySender.get(phone)!, RECIPIENTS / 3, RECIPIENTS * 0.01, `sender ${phone}`);
  for (const d of decisions) assert.ok(eligible.get(d.phoneNumberId)!.has(d.templateId), `ineligible pair ${d.phoneNumberId}/${d.templateId}`);
  // Rotation inside each number: uniform over its eligible templates.
  for (const [phone, templates] of eligible) {
    const total = bySender.get(phone)!;
    for (const templateId of templates) {
      near(byPair.get(`${phone}:${templateId}`)! / total, 1 / templates.size, 0.015, `sender ${phone} template ${templateId}`);
    }
  }
  assert.equal(byPair.get(`1:${C}`), undefined);
  assert.equal(byPair.get(`3:${A}`), undefined);
  assert.equal(new Set(decisions.map((d) => d.routeId)).size, 3, "one route per sender lane");
  console.log(JSON.stringify({ mode: "equal_numbers", recipients: RECIPIENTS, ms: elapsed, digest, bySender: Object.fromEntries(bySender), byPair: Object.fromEntries(byPair) }));
});

test("equal by templates on X/Y/Z: each template gets ~1/3, split among ITS eligible numbers by configured rate", () => {
  const started = Date.now();
  const { decisions, digest } = run(fixture("equal_templates"));
  const elapsed = Date.now() - started;
  const { byTemplate, byPair } = tally(decisions);
  for (const templateId of [A, B, C]) near(byTemplate.get(templateId)!, RECIPIENTS / 3, RECIPIENTS * 0.01, `template ${templateId}`);
  for (const d of decisions) assert.ok(eligible.get(d.phoneNumberId)!.has(d.templateId), `ineligible pair ${d.phoneNumberId}/${d.templateId}`);
  // Expected rate proportions inside each bucket.
  const expected: Record<number, Record<number, number>> = {
    [A]: { 1: 100 / 300, 2: 200 / 300 },            // X, Y
    [B]: { 1: 100 / 600, 2: 200 / 600, 3: 300 / 600 }, // X, Y, Z
    [C]: { 2: 200 / 500, 3: 300 / 500 },            // Y, Z
  };
  for (const [templateId, shares] of Object.entries(expected)) {
    const total = byTemplate.get(Number(templateId))!;
    for (const [phone, share] of Object.entries(shares)) {
      near((byPair.get(`${phone}:${templateId}`) ?? 0) / total, share, 0.015, `template ${templateId} sender ${phone}`);
    }
  }
  console.log(JSON.stringify({ mode: "equal_templates", recipients: RECIPIENTS, ms: elapsed, digest, byTemplate: Object.fromEntries(byTemplate), byPair: Object.fromEntries(byPair) }));
});

test("assignments are deterministic: same input, serialized input, shuffled candidates and any page size give identical results", () => {
  for (const mode of ["equal_numbers", "equal_templates"] as const) {
    const sample = recipients.slice(0, 20_000);
    const base = run(fixture(mode), sample);
    assert.equal(run(fixture(mode), sample).digest, base.digest, "same input twice");
    // "Process restart": rebuild from serialized data.
    const revived = JSON.parse(JSON.stringify(fixture(mode))) as AllocatorV2Input;
    assert.equal(run(revived, sample).digest, base.digest, "rebuilt from JSON");
    // Shuffled lanes, templates and per-lane template lists.
    const shuffled: AllocatorV2Input = {
      mode,
      templateIds: [C, A, B],
      lanes: [
        { ...Z, templateIds: [C, B] },
        { ...X, templateIds: [B, A] },
        { ...Y, templateIds: [C, A, B] },
      ],
    };
    assert.equal(run(shuffled, sample).digest, base.digest, "candidate order does not matter");
    // Page size: the same recipients processed in pages of 1, 7, 500 and all at once.
    for (const pageSize of [1, 7, 500, sample.length]) {
      const allocator = createAllocatorV2(fixture(mode));
      const paged: ReturnType<typeof run>["decisions"] = [];
      for (let start = 0; start < sample.length; start += pageSize) {
        for (const key of sample.slice(start, start + pageSize)) paged.push(allocator.allocate(key));
      }
      assert.deepEqual(paged, base.decisions, `page size ${pageSize}`);
    }
    // Processing order: reversed input order yields the same per-recipient decision.
    const reversed = [...sample].reverse();
    const allocator = createAllocatorV2(fixture(mode));
    reversed.forEach((key, index) => assert.deepEqual(allocator.allocate(key), base.decisions[sample.length - 1 - index]));
  }
});

test("1 number x 3 templates and 3 numbers x 1 template", () => {
  const oneByThree = run({ mode: "equal_numbers", templateIds: [A, B, C], lanes: [{ ...X, templateIds: [A, B, C] }] }, recipients.slice(0, 30_000));
  const t = tally(oneByThree.decisions);
  assert.deepEqual([...t.bySender.keys()], [1]);
  for (const templateId of [A, B, C]) near(t.byTemplate.get(templateId)!, 10_000, 300, `1x3 template ${templateId}`);
  const threeByOne = run({ mode: "equal_numbers", templateIds: [A], lanes: [{ ...X, templateIds: [A] }, { ...Y, templateIds: [A] }, { ...Z, templateIds: [A] }] }, recipients.slice(0, 30_000));
  const u = tally(threeByOne.decisions);
  assert.deepEqual([...u.byTemplate.keys()], [A]);
  for (const phone of [1, 2, 3]) near(u.bySender.get(phone)!, 10_000, 300, `3x1 sender ${phone}`);
});

test("incomplete or inconsistent input is refused, never dropped or substituted", () => {
  const refuse = (input: AllocatorV2Input, pattern: RegExp) => assert.throws(() => createAllocatorV2(input), (error: unknown) => error instanceof AllocatorInputError && pattern.test(error.message));
  refuse({ mode: "equal_numbers", templateIds: [A, B], lanes: [{ ...X, templateIds: [A] }, { ...Y, templateIds: [] }] }, /Number 2 cannot send any selected template/);
  refuse({ mode: "equal_numbers", templateIds: [A, B, C], lanes: [{ ...X, templateIds: [A, B] }] }, /Template 103 has no eligible selected number/);
  refuse({ mode: "equal_templates", templateIds: [A], lanes: [{ ...X, templateIds: [A] }, { ...X, routeId: 99, templateIds: [A] }] }, /more than one sender lane/);
  refuse({ mode: "equal_numbers", templateIds: [A], lanes: [{ ...X, templateIds: [A, B] }] }, /not selected/);
  refuse({ mode: "equal_numbers", templateIds: [A], lanes: [{ ...X, rate: 0, templateIds: [A] }] }, /positive integer rate/);
  refuse({ mode: "smart_capacity" as DistributionMode, templateIds: [A], lanes: [{ ...X, templateIds: [A] }] }, /Unsupported distribution mode/);
  refuse({ mode: "equal_numbers", templateIds: [], lanes: [] }, /Select at least one template/);
});
