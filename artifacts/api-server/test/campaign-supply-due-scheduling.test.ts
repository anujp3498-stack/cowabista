import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";

/*
 * P3 regression coverage: the supply scheduler's response to an empty claim.
 *
 * claimPhoneBatch only returns jobs whose availableAt has arrived, and pacing
 * deliberately stamps availableAt forward. The scheduler used to read "nothing
 * came back" as "this source is empty" and arm an exponential 1s -> 30s park.
 * Worse, it also armed that park for a merely *short* batch, and the ladder's
 * reset sat behind that break, so only a full-size batch could lower it again:
 * a lane that kept finding work still ratcheted to 8-16s of sleep while its
 * own paced backlog came due a few hundred milliseconds later.
 *
 * These tests pin the three properties that fix depends on.
 */

const CAPACITY = 1_024;
const BATCH = 128;

function testLane(phoneNumberId: number, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 1,
    phoneNumberId,
    ownerId: "supply-due-test",
    shardId: 0,
    fencingToken: 7,
    ownershipValidUntilMs: Date.now() + 3_600_000,
    coordinationLatencyMs: 0,
    capacity: CAPACITY,
    lowWater: Math.floor(CAPACITY / 2),
    highWater: CAPACITY,
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
    nextRecoveryAt: Number.MAX_SAFE_INTEGER,
    nextMetricsAt: Number.MAX_SAFE_INTEGER,
    pendingAckIds: [],
    ackInFlight: 0,
    ackRetryDelayMs: 0,
    nextAckRetryAt: 0,
    published: new Map(),
    nextLeaseRenewalAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  } as any;
}

function createBroker() {
  const streams = new Map<number, Array<{ id: string; fencingToken: number; envelope: any; taken: boolean }>>();
  let sequence = 0;
  const partition = (phoneNumberId: number) => {
    let entries = streams.get(phoneNumberId);
    if (!entries) { entries = []; streams.set(phoneNumberId, entries); }
    return entries;
  };
  return {
    async publish(phoneNumberId: number, fencingToken: number, envelopes: any[]) {
      for (const envelope of envelopes) {
        partition(phoneNumberId).push({ id: `e${sequence++}`, fencingToken, envelope, taken: false });
      }
    },
    async consume(phoneNumberId: number, _consumerId: string, count: number) {
      const deliveries = [];
      for (const entry of partition(phoneNumberId)) {
        if (entry.taken) continue;
        entry.taken = true;
        deliveries.push({
          id: entry.id, phoneNumberId, fencingToken: entry.fencingToken, envelope: entry.envelope,
        });
        if (deliveries.length >= count) break;
      }
      return deliveries;
    },
    async acknowledge(phoneNumberId: number, ids: string[]) {
      const removed = new Set(ids);
      streams.set(phoneNumberId, partition(phoneNumberId).filter((entry) => !removed.has(entry.id)));
    },
    async reclaimAbandoned() { return []; },
    async metrics(phoneNumberId: number) {
      const entries = partition(phoneNumberId);
      const pending = entries.filter((entry) => entry.taken).length;
      return { depth: entries.length, pending, consumerLag: entries.length - pending };
    },
    async close() {},
  };
}

type SourceOptions = {
  /** Jobs whose availableAt has already arrived, per claim, in order. */
  yields: number[];
  /** What nextPhoneSupplyDueInMs() reports. undefined = no future work. */
  dueInMs: number | undefined;
};

function createWorker(source: SourceOptions, log: {
  claims: number;
  dueProbes: number;
  claimedSizes: number[];
}) {
  let nextJobId = 1;
  return {
    brokerLeaseRenewalIntervalMs: 10_000,
    tryReserveSettlementSlot() { return true; },
    releaseSettlementSlot() {},
    settlementSlotCapacity() { return 4096; },
    async claimPhoneBatch(phoneNumberId: number, slots: number) {
      const index = log.claims;
      log.claims += 1;
      const available = source.yields[index] ?? 0;
      const size = Math.min(slots, available);
      log.claimedSizes.push(size);
      return Array.from({ length: size }, () => {
        const id = nextJobId++;
        return {
          id,
          organizationId: 1,
          campaignId: 1,
          routeId: phoneNumberId,
          leaseToken: `lease-${id}`,
          leaseExpiresAt: new Date(Date.now() + 30_000),
          idempotencyKey: `job-${id}`,
          attempts: 1,
          configuredTps: 100,
          dispatchPhoneNumberId: phoneNumberId,
          scheduledSendAt: new Date(),
        };
      });
    },
    async nextPhoneSupplyDueInMs() {
      log.dueProbes += 1;
      return source.dueInMs;
    },
    async prepareReservoirBatch(jobs: any[]) {
      return jobs.map((job) => ({ job, preparedContext: {}, registration: { key: `r${job.id}` } }));
    },
    handoffPreparedEnvelope(envelope: any) {
      return { job: envelope.job, preparedContext: envelope.preparedContext };
    },
    adoptPreparedEnvelope(envelope: any) {
      return { ...envelope, registration: { key: `a${envelope.job.id}` } };
    },
    async validatePreparedBrokerEnvelopes(envelopes: any[]) {
      return { valid: envelopes, stale: [] };
    },
    async dispatchReservoirEnvelope() {},
    async discardReservoirEnvelope() {},
    async abandonBrokerEnvelope() {},
    async renewBrokerLeases() { return 0; },
    updateTransportOwnership() {},
    revokeTransportOwnership() {},
    transportShardForPhone() { return 0; },
  };
}

function createReservoir(worker: unknown, broker: unknown) {
  return new CampaignPhoneReservoir(
    worker as any, BATCH, {} as any, "supply-due-test", 16_384, undefined, broker as any, 5_000,
  ) as any;
}

/**
 * Test 1 -- future-available queued work must not cause a multi-second park.
 *
 * The lane finds nothing claimable, but the source reports its next job comes
 * due in 250ms. Before the fix this armed a 1s park that then doubled on every
 * repeat; the lane must now be parked for approximately the real wait.
 */
test("a lane waiting only on future-due work parks until that work is due", async () => {
  const log = { claims: 0, dueProbes: 0, claimedSizes: [] as number[] };
  const worker = createWorker({ yields: [0], dueInMs: 250 }, log);
  const reservoir = createReservoir(worker, createBroker());
  const lane = testLane(1);
  reservoir.lanes.set(lane.phoneNumberId, lane);

  const before = Date.now();
  await reservoir.runRefill(lane);

  assert.equal(log.dueProbes, 1, "an empty claim must ask when work next becomes due");
  const parkedForMs = lane.sourceEmptyUntil - before;
  assert.ok(
    parkedForMs >= 250 && parkedForMs <= 400,
    `expected a park close to the 250ms real wait, got ${parkedForMs}ms`,
  );
  assert.equal(
    lane.sourceEmptyBackoffMs, 0,
    "waiting on paced supply must not charge the empty-source ladder",
  );
});

/**
 * Test 2 -- a genuinely empty source must still back off, and still escalate.
 *
 * This is what keeps an idle fleet off PostgreSQL. Removing it would turn the
 * fix into continuous polling, so it is pinned explicitly.
 */
test("a source with no future work still backs off exponentially", async () => {
  const log = { claims: 0, dueProbes: 0, claimedSizes: [] as number[] };
  const worker = createWorker({ yields: [0, 0, 0], dueInMs: undefined }, log);
  const reservoir = createReservoir(worker, createBroker());
  const lane = testLane(1);
  reservoir.lanes.set(lane.phoneNumberId, lane);

  const observed: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lane.sourceEmptyUntil = 0;
    await reservoir.runRefill(lane);
    observed.push(lane.sourceEmptyBackoffMs);
  }

  assert.deepEqual(
    observed, [1_000, 2_000, 4_000],
    "an empty source must keep the exponential ladder that stops idle polling",
  );
  assert.equal(log.dueProbes, 3);
});

/**
 * Test 3 -- a short batch is work, not an empty source.
 *
 * The lane claims 40 of a possible 128. Before the fix this armed the ladder
 * and broke before the reset, so the park grew even though supply was flowing.
 * It must now neither park the lane nor probe for a due time at all.
 */
test("a partial claim neither parks the lane nor charges the ladder", async () => {
  const log = { claims: 0, dueProbes: 0, claimedSizes: [] as number[] };
  const worker = createWorker({ yields: [40], dueInMs: 250 }, log);
  const reservoir = createReservoir(worker, createBroker());
  const lane = testLane(1, { sourceEmptyBackoffMs: 8_000 });
  reservoir.lanes.set(lane.phoneNumberId, lane);

  await reservoir.runRefill(lane);

  assert.deepEqual(log.claimedSizes, [40], "the claim must have returned a short batch");
  assert.equal(log.dueProbes, 0, "a claim that produced work is not an empty source");
  assert.ok(
    lane.sourceEmptyUntil <= Date.now(),
    "a lane that just received work must stay immediately eligible to refill",
  );
  assert.equal(
    lane.sourceEmptyBackoffMs, 0,
    "supplying work must reset the ladder instead of leaving it ratcheted",
  );
});

/**
 * Test 4 -- pacing stays the authority on what may be claimed.
 *
 * The scheduler only ever reads the due time to pick a wake-up. It must not
 * claim more than the source makes available, and it must never publish an
 * envelope the source did not hand it, however short the park is.
 */
test("next-due scheduling never claims more than the source releases", async () => {
  const log = { claims: 0, dueProbes: 0, claimedSizes: [] as number[] };
  const worker = createWorker({ yields: [10], dueInMs: 0 }, log);
  const broker = createBroker();
  const reservoir = createReservoir(worker, broker);
  const lane = testLane(1);
  reservoir.lanes.set(lane.phoneNumberId, lane);

  await reservoir.runRefill(lane);

  assert.deepEqual(log.claimedSizes, [10]);
  // The fake broker's depth counts every published entry that has not been
  // acknowledged, consumed ones included, so it is the full published total.
  assert.equal(
    (await broker.metrics(1)).depth, 10,
    "exactly the released jobs may reach the broker",
  );

  // A zero/negative due time must still resolve to a real park, not a spin.
  lane.brokerDepth = 0;
  lane.queued = 0;
  lane.sourceEmptyUntil = 0;
  const before = Date.now();
  await reservoir.runRefill(lane);
  assert.ok(
    lane.sourceEmptyUntil > before,
    "a zero due interval must still park the lane rather than busy-loop",
  );
});
