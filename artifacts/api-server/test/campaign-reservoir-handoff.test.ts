// V2-372 review fixes, on the reservoir with in-memory fakes (no database, no Redis):
//  1. a handoff that does not drain in time never revokes transport while sends are in flight (that aborts their
//     HTTP calls into delivery-unknown): it requeues what never reached transport, waits for the sends, then releases;
//  2. its settling and releasing happen after the discovery loop has renewed every lease (reviewHandoff only decides);
//  3. stop() settles never-sent work even when leaving the membership hangs on Redis;
//  4. a broker delivery that cannot be adopted is dropped instead of blocking every delivery behind it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import { InMemoryPacingCoordinator } from "../src/services/campaign-pacing-coordinator";
import { PhoneAssignmentController } from "../src/services/campaign-phone-assignment";

const PHONE = 9;
const TOKEN = 4;
const HANDOFF_MAX_MS = 15_000;

type Calls = { revoked: number; released: number; discardedQueued: number; discardedPublished: number; acked: string[] };

function setup(options: { leaveHangs?: boolean } = {}) {
  const calls: Calls = { revoked: 0, released: 0, discardedQueued: 0, discardedPublished: 0, acked: [] };
  const worker = {
    revokeTransportOwnership: () => { calls.revoked += 1; },
    discardReservoirEnvelopes: async (envelopes: unknown[]) => { calls.discardedQueued += envelopes.length; return { settled: envelopes }; },
    discardPublishedEnvelopes: async (envelopes: unknown[]) => { calls.discardedPublished += envelopes.length; },
    adoptPreparedEnvelope: (envelope: { job: { leaseToken?: string | null } }) => {
      if (!envelope.job.leaseToken) throw new Error("Broker envelope has no durable lease token");
      return { ...envelope, registration: { key: "k", signal: new AbortController().signal } };
    },
    validatePreparedBrokerEnvelopes: async (envelopes: Array<{ job: { leaseToken?: string | null } }>) => ({
      valid: envelopes.filter((envelope) => envelope.job.leaseToken).map((envelope) => ({
        ...envelope, job: { ...envelope.job, leaseExpiresAt: new Date(Date.now() + 60_000) },
      })),
    }),
    transportShardForPhone: () => 0,
  };
  const coordinator = {
    async ensurePhoneOwnership() { return { owned: true, fencingToken: TOKEN, validUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0 }; },
    async releasePhoneOwnership() { calls.released += 1; },
    async reserveBatch() { throw new Error("unused"); },
    async close() {},
  };
  let consumeQueue: unknown[] = [];
  const broker = {
    async consume() { const out = consumeQueue; consumeQueue = []; return out; },
    async acknowledge(_phone: number, ids: string[]) { calls.acked.push(...ids); },
    async close() {},
    async metrics() { return { depth: 0, pending: 0, consumerLag: 0 }; },
  };
  const store = new InMemoryPacingCoordinator();
  if (options.leaveHangs) store.leaveCell = () => new Promise<void>(() => {});
  const assignment = new PhoneAssignmentController(store, "cell-a", "owner-a", 16_384, { handoffMaxMs: HANDOFF_MAX_MS });
  // The assigned cell for the phone is another cell, so a handoff is never cancelled here.
  assignment.assignedCell = () => "cell-b";
  const reservoir = new CampaignPhoneReservoir(worker as never, 64, coordinator as never, "owner-a", 16_384, undefined, broker as never, 5_000, assignment);
  const lane: Record<string, any> = {
    organizationId: 1, phoneNumberId: PHONE, sendingCredentialId: null, ownerId: "owner-a", shardId: 0,
    fencingToken: TOKEN, ownershipValidUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0,
    capacity: 30, highWater: 30, lowWater: 15, queued: 0, reserved: 0, providerInFlight: 0, refilling: false,
    refillDurationMs: 0, emptyDelayMs: 0, brokerDepth: 0, brokerConsumerLag: 0, queue: [], draining: false,
    sourceEmptyUntil: 0, sourceEmptyBackoffMs: 0, nextRecoveryAt: 0, nextMetricsAt: 0, pendingAckIds: [], ackInFlight: 0,
    ackRetryDelayMs: 0, nextAckRetryAt: 0, published: new Map(), nextLeaseRenewalAt: 0, acquiredAt: 0,
    unadopted: [], adopting: new Set(),
  };
  (reservoir as any).lanes.set(PHONE, lane);
  return { reservoir: reservoir as any, lane, calls, feed: (deliveries: unknown[]) => { consumeQueue = deliveries; } };
}

const delivery = (id: string, jobId: number, leaseToken: string | null) => ({
  id, phoneNumberId: PHONE, fencingToken: TOKEN, envelope: { job: { id: jobId, leaseToken, campaignId: 1, routeId: 1 }, preparedContext: {} },
});

test("an expired handoff keeps transport and the lease while sends are in flight, requeues unsent work, then releases", async () => {
  const { reservoir, lane, calls } = setup();
  lane.handoff = { since: Date.now() - HANDOFF_MAX_MS - 1, to: "cell-b" };
  lane.providerInFlight = 2;
  lane.queue.push({ delivery: delivery("1-0", 1, "l1"), envelope: {}, leaseValidUntilMs: Date.now() + 60_000 }, { delivery: delivery("2-0", 2, "l2"), envelope: {}, leaseValidUntilMs: Date.now() + 60_000 });
  lane.queued = 2;
  lane.published.set("3:l3", { job: { id: 3, leaseToken: "l3" } });

  assert.equal(reservoir.reviewHandoff(lane), "settle", "reviewHandoff only decides; settling runs after the renewal loop");
  assert.equal(lane.handoff.expired, true);
  assert.equal(calls.discardedQueued, 0, "nothing was settled inside the decision");
  assert.equal(reservoir.isInert(lane), true, "an expired handoff adopts and admits nothing more");

  await reservoir.settleExpiredHandoff(lane);
  assert.equal(calls.discardedQueued, 2, "queued work never handed to transport is requeued");
  assert.equal(calls.discardedPublished, 1, "published work never consumed is requeued");
  assert.equal(lane.queue.length, 0);
  assert.equal(lane.published.size, 0);
  assert.equal(calls.revoked, 0, "transport is not revoked while sends are in flight");
  assert.equal(calls.released, 0, "the lease is kept while sends are in flight");

  assert.equal(reservoir.reviewHandoff(lane), "none", "waits for the sends in transport");
  lane.providerInFlight = 0;
  lane.pendingAckIds.push("x");
  assert.equal(reservoir.reviewHandoff(lane), "none", "and for their acknowledgements");
  lane.pendingAckIds.length = 0;
  assert.equal(reservoir.reviewHandoff(lane), "release");
  await reservoir.completeHandoff(lane, false);
  assert.equal(calls.revoked, 1);
  assert.equal(calls.released, 1);
  assert.equal(reservoir.lanes.has(PHONE), false);
});

test("a drained handoff is released at once; one stuck past the transport grace is forced", async () => {
  const drained = setup();
  drained.lane.handoff = { since: Date.now(), to: "cell-b" };
  assert.equal(drained.reservoir.reviewHandoff(drained.lane), "release");

  const stuck = setup();
  stuck.lane.handoff = { since: Date.now() - HANDOFF_MAX_MS - 120_001, to: "cell-b", expired: true };
  stuck.lane.providerInFlight = 1;
  assert.equal(stuck.reservoir.reviewHandoff(stuck.lane), "force-release");

  const waiting = setup();
  waiting.lane.handoff = { since: Date.now() - 1_000, to: "cell-b" };
  waiting.lane.providerInFlight = 1;
  assert.equal(waiting.reservoir.reviewHandoff(waiting.lane), "none", "within handoffMaxMs a busy lane keeps draining");
  assert.equal(waiting.lane.handoff.expired, undefined);
});

test("stop() settles never-sent work even when leaving the membership hangs on Redis", async () => {
  const { reservoir, lane, calls } = setup({ leaveHangs: true });
  lane.queue.push({ delivery: delivery("5-0", 5, "l5"), envelope: {}, leaseValidUntilMs: Date.now() + 60_000 });
  lane.queued = 1;
  lane.published.set("6:l6", { job: { id: 6, leaseToken: "l6" } });
  const started = Date.now();
  await reservoir.stop();
  assert.equal(calls.discardedQueued, 1, "queued work requeued");
  assert.equal(calls.discardedPublished, 1, "published work requeued");
  assert.equal(calls.released, 1, "the lease released");
  assert.ok(Date.now() - started < 3_000, `stop finished in ${Date.now() - started} ms despite the hung leave`);
});

test("a delivery without a durable lease is acknowledged and dropped; the deliveries around it are queued", async () => {
  const { reservoir, lane, calls, feed } = setup();
  feed([delivery("7-0", 7, "l7"), delivery("8-0", 8, null), delivery("9-0", 9, "l9")]);
  await reservoir.consume(lane);
  assert.deepEqual(lane.queue.map((entry: { delivery: { id: string } }) => entry.delivery.id), ["7-0", "9-0"]);
  assert.deepEqual(calls.acked, ["8-0"], "the unusable delivery is acknowledged");
  assert.deepEqual(lane.unadopted, [], "nothing is left to block later passes");
  await reservoir.consume(lane);
  assert.equal(lane.queue.length, 2);
});
