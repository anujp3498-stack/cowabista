import assert from "node:assert/strict";
import test from "node:test";
import { reviveEnvelope } from "../src/services/campaign-prepared-broker";

// The broker used to parse envelopes with a JSON.parse reviver. The replacement
// must produce exactly the same value for every payload: any string held under
// a date-named key becomes a Date at any depth, and nothing else changes.

const DATE_FIELDS = ["availableAt", "lockedAt", "leaseExpiresAt", "scheduledSendAt", "createdAt", "updatedAt"];
const reference = (payload: string) => JSON.parse(payload, (key, value) =>
  DATE_FIELDS.includes(key) && typeof value === "string" ? new Date(value) : value);

function canonical(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.getTime() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}
function assertSameAsReviver(payload: string) {
  assert.deepEqual(canonical(reviveEnvelope(payload)), canonical(reference(payload)));
}

const job = {
  id: 42, organizationId: 7, campaignId: 9, routeId: 3, contactId: 11, configuredTps: 1000, templateId: 5, status: "Processing",
  attempts: 1, maxAttempts: 5, priority: "Normal", idempotencyKey: "org:7:campaign:9:contact:11", leaseToken: "abc", lockedBy: "w-1",
  availableAt: "2026-09-11T14:00:00.000Z", lockedAt: "2026-09-11T14:00:01.250Z", leaseExpiresAt: "2026-09-11T14:00:31.250Z",
  scheduledSendAt: "2026-09-11T14:00:02.123Z", createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-11T14:00:01.250Z",
  lastError: null, providerMessageId: null, dispatchPhoneNumberId: 1, metadata: { createdAt: "not-a-date-but-still-converted", note: "keep" },
};

test("a job envelope gets Date instances for its six date columns and nothing else changes", () => {
  const payload = JSON.stringify({ job, preparedContext: null });
  const envelope = reviveEnvelope(payload) as { job: Record<string, unknown>; preparedContext: unknown };
  for (const field of DATE_FIELDS) {
    assert.ok(envelope.job[field] instanceof Date, `${field} must be a Date`);
    assert.equal((envelope.job[field] as Date).toISOString(), (job as Record<string, unknown>)[field]);
  }
  assert.equal(envelope.job.idempotencyKey, job.idempotencyKey);
  assert.equal(envelope.job.lastError, null);
  assert.equal(envelope.preparedContext, null);
  assertSameAsReviver(payload);
});

test("null or non-string values under date keys are left alone, and nested date keys are revived at any depth", () => {
  const payload = JSON.stringify({
    job: { ...job, lockedAt: null, scheduledSendAt: 1700000000000 },
    preparedContext: {
      connection: { id: 1, createdAt: "2026-01-01T00:00:00.000Z", nested: [{ updatedAt: "2026-02-02T00:00:00.000Z" }, "updatedAt", 3] },
      payload: { components: [{ type: "body", parameters: [{ type: "text", text: "createdAt" }] }] },
      scheduledSendAt: ["2026-03-03T00:00:00.000Z"],
    },
  });
  const envelope = reviveEnvelope(payload) as any;
  assert.equal(envelope.job.lockedAt, null);
  assert.equal(envelope.job.scheduledSendAt, 1700000000000);
  assert.ok(envelope.preparedContext.connection.createdAt instanceof Date);
  assert.ok(envelope.preparedContext.connection.nested[0].updatedAt instanceof Date);
  assert.equal(envelope.preparedContext.connection.nested[1], "updatedAt", "array elements are values, not keys");
  assert.equal(envelope.preparedContext.payload.components[0].parameters[0].text, "createdAt", "a string that merely equals a key name is untouched");
  assert.ok(Array.isArray(envelope.preparedContext.scheduledSendAt), "an array under a date key stays an array");
  assert.equal(envelope.preparedContext.scheduledSendAt[0], "2026-03-03T00:00:00.000Z");
  assertSameAsReviver(payload);
});

test("equivalence with the reviver on 500 random nested payloads", () => {
  let seed = 20260911;
  const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const keys = [...DATE_FIELDS, "id", "name", "items", "x", "createdAtNot", "data"];
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)]!;
  function generate(depth: number): unknown {
    const roll = rand();
    if (depth > 4 || roll < 0.25) return pick([null, 1, 2.5, true, "plain", "2026-09-11T00:00:00.000Z", "", "createdAt"]);
    if (roll < 0.5) return Array.from({ length: Math.floor(rand() * 4) }, () => generate(depth + 1));
    const object: Record<string, unknown> = {};
    for (let index = 0, count = Math.floor(rand() * 6); index < count; index += 1) object[pick(keys)] = generate(depth + 1);
    return object;
  }
  for (let round = 0; round < 500; round += 1) {
    const payload = JSON.stringify({ job: { ...job, extra: generate(0) }, preparedContext: generate(0) });
    assertSameAsReviver(payload);
  }
});

test("invalid JSON still throws, as before", () => {
  assert.throws(() => reviveEnvelope("{not json"), SyntaxError);
});
