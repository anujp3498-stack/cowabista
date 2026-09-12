import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";

/*
 * Supply-scheduler regression coverage.
 *
 * The shared refill scheduler previously let one run hold a global slot for
 * the life of the process: runRefill looped until its own lane reached high
 * water, but transport drains published work as fast as it arrives, so that
 * exit was never reached under continuous supply. Every lane past the
 * concurrency limit was then starved permanently -- it never issued a single
 * PostgreSQL claim. These tests pin the scheduler contract that prevents it.
 *
 * Lanes are injected directly, exactly as campaign-phone-reservoir.test.ts
 * does, so the scheduler is exercised without discover()'s database access.
 */

// The lock-out only appears when transport drains published work at least as
// fast as supply produces it: brokerDepth then never climbs to high water, so
// runRefill's only non-error exit is never taken. A claim that is far slower
// than a dispatch, over a capacity many batches deep, is that regime.
const CAPACITY = 1_024;
const BATCH = 128;
const CLAIM_MS = 15;
const DISPATCH_MS = 1;

function testLane(phoneNumberId: number, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 1,
    phoneNumberId,
    ownerId: "scheduler-test",
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

/**
 * Minimal stand-in for the Redis stream: read-once delivery plus ack/delete,
 * which is what the reservoir's watermark accounting depends on.
 */
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
          id: entry.id,
          phoneNumberId,
          fencingToken: entry.fencingToken,
          envelope: entry.envelope,
        });
        if (deliveries.length >= count) break;
      }
      return deliveries;
    },
    async acknowledge(phoneNumberId: number, ids: string[]) {
      const removed = new Set(ids);
      streams.set(phoneNumberId, partition(phoneNumberId).filter((entry) => !removed.has(entry.id)));
    },
    async reclaimAbandoned() { return { deliveries: [], cursor: "0-0" }; },
    async metrics(phoneNumberId: number) {
      const entries = partition(phoneNumberId);
      const pending = entries.filter((entry) => entry.taken).length;
      return { depth: entries.length, pending, consumerLag: entries.length - pending };
    },
    async close() {},
  };
}

type WorkerOptions = {
  onClaim?: (phoneNumberId: number) => void;
  prepare?: (jobs: any[]) => Promise<any[]>;
  /** Bounded durable-outcome capacity, as CampaignWorker enforces it. */
  settlementSlots?: number;
};

/**
 * Supply is unlimited: every claim returns a full batch. That is the regime
 * the lock-out needs -- a lane's broker never reaches high water, so the
 * high-water loop exit is never taken.
 */
function createWorker(claims: Map<number, number>, starts: Map<number, number>, options: WorkerOptions = {}) {
  let nextJobId = 1;
  return {
    brokerLeaseRenewalIntervalMs: 10_000,
    settlementSlots: options.settlementSlots ?? Number.MAX_SAFE_INTEGER,
    settlementReserved: 0,
    settlementReleased: 0,
    tryReserveSettlementSlot() {
      if (this.settlementReserved - this.settlementReleased >= this.settlementSlots) return false;
      this.settlementReserved += 1;
      return true;
    },
    releaseSettlementSlot() { this.settlementReleased += 1; },
    settlementSlotCapacity() { return this.settlementSlots; },
    async nextPhoneSupplyDueInMs() { return undefined; },
    async claimPhoneBatch(phoneNumberId: number, slots: number) {
      claims.set(phoneNumberId, (claims.get(phoneNumberId) ?? 0) + 1);
      options.onClaim?.(phoneNumberId);
      await new Promise<void>((resolve) => setTimeout(resolve, CLAIM_MS));
      return Array.from({ length: slots }, () => {
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
    async prepareReservoirBatch(jobs: any[]) {
      if (options.prepare) return options.prepare(jobs);
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
    async dispatchReservoirEnvelope(envelope: any) {
      const phoneNumberId = envelope.job.dispatchPhoneNumberId;
      starts.set(phoneNumberId, (starts.get(phoneNumberId) ?? 0) + 1);
      await new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_MS));
    },
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
    worker as any,
    BATCH,
    {} as any,
    "scheduler-test",
    16_384,
    undefined,
    broker as any,
    5_000,
  ) as any;
}

/** Mirrors CampaignRuntime.start(): every tick fans service() over all lanes. */
async function runLanes(reservoir: any, lanes: any[], durationMs: number) {
  for (const lane of lanes) reservoir.lanes.set(lane.phoneNumberId, lane);
  const ticker = setInterval(() => {
    for (const lane of lanes) reservoir.service(lane);
  }, 10);
  for (const lane of lanes) reservoir.service(lane);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  } finally {
    clearInterval(ticker);
    reservoir.stopping = true;
  }
}

test("every lane in a four-phone fleet claims and dispatches", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const reservoir = createReservoir(createWorker(claims, starts), createBroker());
  const lanes = [1, 2, 3, 4].map((id) => testLane(id));

  await runLanes(reservoir, lanes, 500);

  for (const lane of lanes) {
    assert.ok(
      (claims.get(lane.phoneNumberId) ?? 0) > 0,
      `lane ${lane.phoneNumberId} never reached PostgreSQL: ${JSON.stringify([...claims])}`,
    );
    assert.ok(
      (starts.get(lane.phoneNumberId) ?? 0) > 0,
      `lane ${lane.phoneNumberId} never started a provider call: ${JSON.stringify([...starts])}`,
    );
  }
});

test("a refill releases its scheduler slot while supply is still continuous", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const reservoir = createReservoir(createWorker(claims, starts), createBroker());
  const lanes = [1, 2, 3, 4].map((id) => testLane(id));

  await runLanes(reservoir, lanes, 500);

  // The lock-out signature was activeRefills pinned at the limit with lanes
  // still queued behind it. Supply never ran dry here, so a slot can only be
  // free because runRefill is bounded rather than looping to high water.
  assert.ok(
    reservoir.activeRefills <= reservoir.refillConcurrency(),
    `activeRefills ${reservoir.activeRefills} exceeded the scheduler limit`,
  );
  for (const lane of lanes) {
    assert.ok(
      (claims.get(lane.phoneNumberId) ?? 0) > 1,
      `lane ${lane.phoneNumberId} claimed only once, so its slot was never recycled`,
    );
  }
});

test("lane count above the old concurrency limit still receives refill service", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const reservoir = createReservoir(createWorker(claims, starts), createBroker());
  const lanes = [1, 2, 3, 4, 5, 6].map((id) => testLane(id));

  await runLanes(reservoir, lanes, 700);

  const starved = lanes.filter((lane) => (claims.get(lane.phoneNumberId) ?? 0) === 0);
  assert.deepEqual(
    starved.map((lane) => lane.phoneNumberId),
    [],
    `lanes starved of supply: ${JSON.stringify([...claims])}`,
  );
  for (const lane of lanes) {
    assert.ok(
      (starts.get(lane.phoneNumberId) ?? 0) > 0,
      `lane ${lane.phoneNumberId} never started a provider call`,
    );
  }
});

test("a lane waiting for a scheduler slot does not report itself as refilling", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const release: Array<() => void> = [];
  // Hold every claim open so the scheduler saturates and later lanes are
  // provably queued rather than running.
  const worker = createWorker(claims, starts, {});
  const originalClaim = worker.claimPhoneBatch.bind(worker);
  worker.claimPhoneBatch = async (phoneNumberId: number, slots: number) => {
    await new Promise<void>((resolve) => release.push(resolve));
    return originalClaim(phoneNumberId, slots);
  };
  const reservoir = createReservoir(worker, createBroker());
  const lanes = Array.from({ length: 12 }, (_, index) => testLane(index + 1));
  for (const lane of lanes) reservoir.lanes.set(lane.phoneNumberId, lane);

  try {
    for (const lane of lanes) reservoir.refillIfNeeded(lane);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.ok(reservoir.refillQueue.length > 0, "the scheduler must have queued lanes to observe");
    const metrics = reservoir.metrics();
    const reportedRefilling = metrics.filter((lane: any) => lane.refilling).length;
    assert.equal(
      reportedRefilling,
      reservoir.activeRefills,
      `${reportedRefilling} lanes reported refilling but only ${reservoir.activeRefills} hold a slot`,
    );
    for (const queued of reservoir.refillQueue) {
      const reported = metrics.find((lane: any) => lane.phoneNumberId === queued.phoneNumberId);
      assert.equal(
        reported.refilling,
        false,
        `queued lane ${queued.phoneNumberId} falsely reported itself as refilling`,
      );
    }
  } finally {
    reservoir.stopping = true;
    for (const resolve of release) resolve();
  }
});

test("a preparation error is not classified as an empty source", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const worker = createWorker(claims, starts, {
    prepare: async () => { throw new Error("provider preparation failed"); },
  });
  const reservoir = createReservoir(worker, createBroker());
  const lane = testLane(1);
  reservoir.lanes.set(lane.phoneNumberId, lane);

  try {
    reservoir.refillIfNeeded(lane);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // A failed preparation says nothing about whether PostgreSQL still holds
    // ready rows. Backing the lane off as if the source were empty would idle
    // a healthy phone for up to SOURCE_EMPTY_MAX_BACKOFF_MS.
    assert.equal(lane.sourceEmptyBackoffMs, 0, "a preparation error must not arm the source-empty backoff");
    assert.equal(lane.sourceEmptyUntil, 0, "a preparation error must not park the lane as source-empty");
    // The slot must also come back, otherwise one failing lane wedges the
    // scheduler for every other phone.
    assert.equal(reservoir.activeRefills, 0, "a failed refill must release its scheduler slot");
    assert.equal(lane.refilling, false, "a failed refill must clear its enqueue guard");
  } finally {
    reservoir.stopping = true;
  }
});

test("a genuinely empty source does arm the backoff", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const worker = createWorker(claims, starts);
  worker.claimPhoneBatch = async () => [];
  const reservoir = createReservoir(worker, createBroker());
  const lane = testLane(1);
  reservoir.lanes.set(lane.phoneNumberId, lane);

  try {
    reservoir.refillIfNeeded(lane);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    assert.ok(lane.sourceEmptyBackoffMs > 0, "an empty claim must still back the lane off");
    assert.ok(lane.sourceEmptyUntil > Date.now(), "an empty claim must park the lane");
  } finally {
    reservoir.stopping = true;
  }
});

/*
 * P0 regression: settlement-induced dispatch collapse.
 *
 * Measured: 10,198 of 14,336 dispatches were valid, correctly-fenced,
 * live-leased envelopes rejected only because the 4,096 durable-outcome slots
 * were full. The rejection called settleAborted(), which takes
 * `campaigns FOR UPDATE` -- the same row settlement must hold to commit and
 * release those slots. Backpressure therefore blocked its own recovery and
 * saturation became congestion collapse.
 *
 * The contract these tests pin: a saturated settlement plane stops work
 * ENTERING transport. It never aborts, requeues or discards work that is
 * already claimed, prepared and leased.
 */

test("a saturated settlement plane stops dispatch instead of aborting leased work", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const SLOTS = 3;
  const worker = createWorker(claims, starts, { settlementSlots: SLOTS });
  // Provider never completes, so every reserved slot stays held and the lane
  // is forced against the cap -- the exact regime that collapsed.
  // A barrier, not a dangling promise: without P0 dispatch is unbounded and
  // the surplus promises would keep the event loop alive forever, so release
  // them before asserting and the pre-P0 failure is a clean assertion.
  const release: Array<() => void> = [];
  worker.dispatchReservoirEnvelope = async (envelope: any) => {
    const phoneNumberId = envelope.job.dispatchPhoneNumberId;
    starts.set(phoneNumberId, (starts.get(phoneNumberId) ?? 0) + 1);
    await new Promise<void>((resolve) => release.push(resolve));
  };
  const reservoir = createReservoir(worker, createBroker());
  const lane = testLane(1);

  await runLanes(reservoir, [lane], 300);

  const started = starts.get(1) ?? 0;
  const queuedAtBound = lane.queue.length;
  const inFlight = lane.providerInFlight;
  const reserved = worker.settlementReserved;
  for (const resolve of release) resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(started, SLOTS, `dispatch must stop at the settlement bound, started ${started}`);
  assert.equal(reserved, SLOTS, "no slot may be reserved beyond the bound");
  assert.equal(inFlight, SLOTS, "only bounded work may be in transport");
  // The decisive assertion: the surplus is still queued and still leased.
  assert.ok(queuedAtBound > 0, "surplus envelopes must remain queued, not be aborted away");
});

test("dispatch resumes without loss once settlement capacity is released", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const SLOTS = 2;
  const worker = createWorker(claims, starts, { settlementSlots: SLOTS });
  let hold = true;
  const holdDeadline = Date.now() + 5_000;
  worker.dispatchReservoirEnvelope = async (envelope: any) => {
    const phoneNumberId = envelope.job.dispatchPhoneNumberId;
    starts.set(phoneNumberId, (starts.get(phoneNumberId) ?? 0) + 1);
    while (hold && Date.now() < holdDeadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    worker.releaseSettlementSlot();
  };
  const reservoir = createReservoir(worker, createBroker());
  const lane = testLane(1);

  await runLanes(reservoir, [lane], 200);
  const blocked = starts.get(1) ?? 0;
  assert.equal(blocked, SLOTS, "dispatch must be held at the bound while settlement is saturated");

  // Settlement drains: capacity returns and transport must pick straight up.
  hold = false;
  (reservoir as any).stopping = false;
  await runLanes(reservoir, [lane], 300);

  assert.ok(
    (starts.get(1) ?? 0) > blocked,
    `dispatch must resume once capacity is released: ${blocked} -> ${starts.get(1)}`,
  );
});

/*
 * P13: the durable-outcome pool is shared by every lane, and a slot is held
 * from dispatch until the batch settles. Lanes whose completions keep firing
 * re-take released slots inside their own completion callbacks; a lane with
 * nothing in flight only retries on the service tick. Measured on the
 * corrected harness as one phone starving for 8-13s while the other three
 * held 1,400-1,570 slots each. The pool is now partitioned per lane.
 */

test("settlement capacity is partitioned across lanes: no lane can hold more than its share", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const SLOTS = 8;
  const worker = createWorker(claims, starts, { settlementSlots: SLOTS });
  const release: Array<() => void> = [];
  worker.dispatchReservoirEnvelope = async (envelope: any) => {
    const phoneNumberId = envelope.job.dispatchPhoneNumberId;
    starts.set(phoneNumberId, (starts.get(phoneNumberId) ?? 0) + 1);
    await new Promise<void>((resolve) => release.push(resolve));
  };
  const reservoir = createReservoir(worker, createBroker());
  const lanes = [1, 2, 3, 4].map((phone) => testLane(phone));
  await runLanes(reservoir, lanes, 400);
  const perLane = lanes.map((lane) => starts.get(lane.phoneNumberId) ?? 0);
  for (const resolve of release) resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(perLane, [2, 2, 2, 2], `each of four lanes gets 8/4 = 2 slots, got ${perLane}`);
  assert.equal(worker.settlementReserved, SLOTS, "the whole pool is still usable");
});

test("a lane with nothing in flight is not starved by lanes whose completions keep re-taking released slots", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const SLOTS = 4;
  const worker = createWorker(claims, starts, { settlementSlots: SLOTS });
  // Lane 1 behaves like a hot phone: every completion releases its slot and
  // its drain() immediately re-dispatches, taking the slot back. Lane 2's
  // provider never completes, so once it has work it depends entirely on
  // winning a released slot from the service tick.
  const held: Array<() => void> = [];
  worker.dispatchReservoirEnvelope = async (envelope: any) => {
    const phoneNumberId = envelope.job.dispatchPhoneNumberId;
    starts.set(phoneNumberId, (starts.get(phoneNumberId) ?? 0) + 1);
    if (phoneNumberId === 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      worker.releaseSettlementSlot();
      return;
    }
    await new Promise<void>((resolve) => held.push(resolve));
  };
  const reservoir = createReservoir(worker, createBroker());
  const hot = testLane(1);
  const cold = testLane(2);
  // Let the hot lane fill the pool first, then bring the cold lane in.
  await runLanes(reservoir, [hot], 150);
  assert.ok((starts.get(1) ?? 0) > 0);
  (reservoir as any).stopping = false;
  await runLanes(reservoir, [hot, cold], 400);
  const coldStarts = starts.get(2) ?? 0;
  const hotInFlight = hot.providerInFlight;
  for (const resolve of held) resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.ok(coldStarts >= 1, `the cold lane must obtain released capacity, got ${coldStarts} starts`);
  assert.ok(coldStarts <= SLOTS / 2, `the cold lane is bounded by its share too, got ${coldStarts}`);
  assert.ok(hotInFlight <= SLOTS / 2, `the hot lane must not hold more than its share, holds ${hotInFlight}`);
});

test("a single lane still receives the whole settlement pool", async () => {
  const claims = new Map<number, number>();
  const starts = new Map<number, number>();
  const SLOTS = 5;
  const worker = createWorker(claims, starts, { settlementSlots: SLOTS });
  const release: Array<() => void> = [];
  worker.dispatchReservoirEnvelope = async (envelope: any) => {
    const phoneNumberId = envelope.job.dispatchPhoneNumberId;
    starts.set(phoneNumberId, (starts.get(phoneNumberId) ?? 0) + 1);
    await new Promise<void>((resolve) => release.push(resolve));
  };
  const reservoir = createReservoir(worker, createBroker());
  await runLanes(reservoir, [testLane(1)], 300);
  const started = starts.get(1) ?? 0;
  for (const resolve of release) resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(started, SLOTS);
});
