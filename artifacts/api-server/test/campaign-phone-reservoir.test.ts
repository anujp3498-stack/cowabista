import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function testLane(phoneNumberId: number, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 1,
    phoneNumberId,
    ownerId: "reservoir-test",
    shardId: 0,
    fencingToken: 7,
    ownershipValidUntilMs: Date.now() + 5_000,
    coordinationLatencyMs: 0,
    capacity: 8,
    lowWater: 4,
    highWater: 8,
    queued: 0,
    reserved: 0,
    providerInFlight: 0,
    refilling: false,
    refillDurationMs: 0,
    emptyDelayMs: 0,
    brokerDepth: 0,
    brokerConsumerLag: 0,
    queue: [],
    draining: false,
    sourceEmptyUntil: 0,
    sourceEmptyBackoffMs: 0,
    nextRecoveryAt: 0,
    nextMetricsAt: 0,
    pendingAckIds: [],
    ackInFlight: 0,
    ackRetryDelayMs: 0,
    nextAckRetryAt: 0,
    published: new Map(),
    nextLeaseRenewalAt: 0,
    ...overrides,
  } as any;
}

test("published work is consumed below low-water and reaches provider transport", async () => {
  const secondClaim = deferred<unknown[]>();
  let claimCalls = 0;
  let published = 0;
  let consumeCalls = 0;
  let providerStarts = 0;

  const job = {
    id: 101,
    organizationId: 1,
    campaignId: 2,
    routeId: 3,
    contactId: 4,
    type: "ResolveTemplateAndSend",
    payload: {},
    status: "Processing",
    attempts: 1,
    maxAttempts: 3,
    availableAt: new Date(),
    lockedAt: new Date(),
    lockedBy: "test",
    leaseToken: "lease-101",
    leaseExpiresAt: new Date(Date.now() + 30_000),
    scheduledSendAt: new Date(),
    idempotencyKey: "job-101",
    errorReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    dispatchPhoneNumberId: 11,
  } as any;
  const envelope = {
    job,
    preparedContext: { providerMessageRowId: 101, payload: { to: "15550000000" } },
    registration: { key: "test-registration" },
  } as any;

  const broker = {
    async publish(_phoneNumberId: number, _fencingToken: number, envelopes: unknown[]) {
      published += envelopes.length;
    },
    async consume() {
      consumeCalls += 1;
      return [{
        id: "stream-101",
        fencingToken: 7,
        envelope: { job, preparedContext: envelope.preparedContext },
      }];
    },
    async acknowledge() {},
    async metrics() {
      return { depth: 0, pending: 0, consumerLag: 0 };
    },
    async reclaimAbandoned() { return []; },
    async close() {},
  };
  const worker = {
    tryReserveSettlementSlot() { return true; },
    releaseSettlementSlot() {},
    async claimPhoneBatch() {
      claimCalls += 1;
      return claimCalls === 1 ? [job] : secondClaim.promise;
    },
    async prepareReservoirBatch() {
      return claimCalls === 1 ? [envelope] : [];
    },
    handoffPreparedEnvelope() {
      return { job, preparedContext: envelope.preparedContext };
    },
    adoptPreparedEnvelope(value: unknown) {
      return { ...(value as object), registration: { key: "adopted-registration" } };
    },
    async validatePreparedBrokerEnvelopes(values: unknown[]) {
      return { valid: values, stale: [] };
    },
    async discardReservoirEnvelope() {},
    async dispatchReservoirEnvelope() {
      providerStarts += 1;
    },
    updateTransportOwnership() {},
    revokeTransportOwnership() {},
    transportShardForPhone() { return 0; },
  };
  const coordinator = {
    async ensurePhoneOwnership() {
      return { owned: true, fencingToken: 7, validUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0 };
    },
    async releasePhoneOwnership() {},
  };
  const reservoir = new CampaignPhoneReservoir(
    worker as any,
    1,
    coordinator as any,
    "reservoir-test",
    16_384,
    undefined,
    broker as any,
  );
  const lane = {
    organizationId: 1,
    phoneNumberId: 11,
    ownerId: "reservoir-test",
    shardId: 0,
    fencingToken: 7,
    ownershipValidUntilMs: Date.now() + 5_000,
    coordinationLatencyMs: 0,
    capacity: 8,
    lowWater: 4,
    highWater: 8,
    queued: 0,
    reserved: 0,
    providerInFlight: 0,
    refilling: false,
    refillDurationMs: 0,
    emptyDelayMs: 0,
    brokerDepth: 0,
    brokerConsumerLag: 0,
    queue: [],
    draining: false,
    sourceEmptyUntil: 0,
    nextRecoveryAt: 0,
    nextMetricsAt: 0,
    pendingAckIds: [],
    ackInFlight: 0,
    ackRetryDelayMs: 0,
    nextAckRetryAt: 0,
    published: new Map(),
    nextLeaseRenewalAt: 0,
  } as any;

  try {
    (reservoir as any).lanes.set(lane.phoneNumberId, lane);
    (reservoir as any).refillIfNeeded(lane);
    const publishDeadline = Date.now() + 1_000;
    while (published === 0 && Date.now() < publishDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(published, 1, "the first prepared batch must reach the broker");
    assert.ok(lane.brokerDepth < lane.lowWater, "the regression must exercise a sub-low-water lane");

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      !(published > 0 && lane.brokerDepth > 0 && lane.brokerConsumerLag > 0 && consumeCalls === 0),
      "published broker work must not remain unconsumed past the dispatch interval",
    );
    assert.ok(consumeCalls > 0, "consume() must run immediately after publication");
    const providerDeadline = Date.now() + 1_000;
    while (providerStarts === 0 && Date.now() < providerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      providerStarts > 0,
      `consumed work must reach provider transport: ${JSON.stringify({
        consumeCalls,
        providerStarts,
        queued: lane.queued,
        queueLength: lane.queue.length,
        providerInFlight: lane.providerInFlight,
      })}`,
    );
  } finally {
    secondClaim.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reservoir.stop();
  }
});

// Every owned lane must be able to reach PostgreSQL, so the scheduler's bound
// scales with the lane count rather than sitting at a fixed 2. Use more lanes
// than the hard maximum so a queue genuinely forms, and assert the bound
// itself instead of a literal that would re-freeze the starvation regression.
const LANE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test("refill requests are watermark-driven and globally bounded", async () => {
  const claims = new Map<number, ReturnType<typeof deferred<unknown[]>>>(
    LANE_IDS.map((phoneNumberId) => [phoneNumberId, deferred<unknown[]>()]),
  );
  let claimCalls = 0;
  let activeClaims = 0;
  let maxActiveClaims = 0;
  const worker = {
    tryReserveSettlementSlot() { return true; },
    releaseSettlementSlot() {},
    async claimPhoneBatch(phoneNumberId: number) {
      claimCalls += 1;
      activeClaims += 1;
      maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
      try {
        return await claims.get(phoneNumberId)!.promise;
      } finally {
        activeClaims -= 1;
      }
    },
    async prepareReservoirBatch() { return []; },
    async discardReservoirEnvelope() {},
    revokeTransportOwnership() {},
  };
  const broker = {
    async consume() { return []; },
    async publish() {},
    async acknowledge() {},
    async metrics() { return { depth: 0, pending: 0, consumerLag: 0 }; },
    async reclaimAbandoned() { return []; },
    async close() {},
  };
  const coordinator = {
    async releasePhoneOwnership() {},
  };
  const reservoir = new CampaignPhoneReservoir(
    worker as any,
    8,
    coordinator as any,
    "bounded-refill-test",
    65_536,
    undefined,
    broker as any,
  );
  const lanes = LANE_IDS.map((phoneNumberId) => testLane(phoneNumberId));
  for (const lane of lanes) (reservoir as any).lanes.set(lane.phoneNumberId, lane);
  const bound = (reservoir as any).refillConcurrency();

  try {
    for (const lane of lanes) (reservoir as any).refillIfNeeded(lane);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(bound < lanes.length, "this test needs more lanes than the scheduler bound");
    assert.equal(claimCalls, bound, "only the global refill concurrency bound may claim initially");
    assert.equal(maxActiveClaims, bound);
    assert.equal(
      (reservoir as any).refillQueue.length,
      lanes.length - bound,
      "lanes past the bound must wait in the scheduler",
    );

    for (let index = 0; index < bound; index += 1) claims.get(LANE_IDS[index]!)!.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(claimCalls, lanes.length, "queued lanes should start when refill slots are released");
    assert.equal(maxActiveClaims, bound, "the scheduler bound must hold as slots recycle");
    for (const lane of lanes) claims.get(lane.phoneNumberId)!.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const queuedLane = testLane(LANE_IDS.length + 1, { brokerDepth: 5, queued: 5 });
    (reservoir as any).lanes.set(queuedLane.phoneNumberId, queuedLane);
    (reservoir as any).refillIfNeeded(queuedLane);
    assert.equal(claimCalls, lanes.length, "a lane above low-water must not poll PostgreSQL again");
  } finally {
    await reservoir.stop();
  }
});

test("empty source claims back off instead of polling every service tick", async () => {
  let claimCalls = 0;
  const worker = {
    tryReserveSettlementSlot() { return true; },
    releaseSettlementSlot() {},
    async claimPhoneBatch() {
      claimCalls += 1;
      return [];
    },
    async prepareReservoirBatch() { return []; },
    revokeTransportOwnership() {},
  };
  const broker = {
    async consume() { return []; },
    async publish() {},
    async acknowledge() {},
    async metrics() { return { depth: 0, pending: 0, consumerLag: 0 }; },
    async reclaimAbandoned() { return []; },
    async close() {},
  };
  const coordinator = {
    async releasePhoneOwnership() {},
  };
  const reservoir = new CampaignPhoneReservoir(
    worker as any,
    8,
    coordinator as any,
    "empty-backoff-test",
    65_536,
    undefined,
    broker as any,
  );
  const lane = testLane(11);
  (reservoir as any).lanes.set(lane.phoneNumberId, lane);

  try {
    (reservoir as any).refillIfNeeded(lane);
    const refill = lane.refill;
    assert.ok(refill);
    await refill;
    assert.equal(claimCalls, 1);
    assert.equal(lane.sourceEmptyBackoffMs, 1_000);
    (reservoir as any).refillIfNeeded(lane);
    assert.equal(claimCalls, 1, "source-empty backoff must suppress repeated claim polling");
  } finally {
    await reservoir.stop();
  }
});