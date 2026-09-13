/*
 * P21 (stale discard) regression coverage: when a consumed broker page holds
 * envelopes the lane must not send (a dead owner's fencing token, a replaced
 * or expired lease, a campaign that is no longer sendable), the reservoir
 * discards them as one page: one aborted settlement per campaign in the page
 * and one acknowledgement, instead of one settleAborted transaction and one
 * XACK per envelope.
 *
 * State transition preserved for every stale envelope (settleAborted's, now
 * taken once per campaign per page by settleAbortedBatch):
 *   never sent    a stale envelope was never handed to the provider, so it is
 *                 requeued, not failed: status Queued, lease cleared,
 *                 available_at = now + 250 ms, attempts unchanged, error
 *                 reason untouched (Cancelled instead when the campaign is
 *                 killed or no longer Running/Paused)
 *   fence         UPDATE only where status = 'Processing' AND lease_token =
 *                 the envelope's lease; a row already Sent, already Failed,
 *                 or re-leased is untouched inside a committed transaction
 *                 and its delivery is acknowledged
 *   own token     a delivery carrying the lane's own token with a live lease
 *                 is queued for dispatch, never discarded
 *   revoke        revokePrepared(context) first; an envelope whose revoke
 *                 fails is not settled and keeps its lease
 *   counters      processing -1, queued +1 per requeued row (route depth -1
 *                 per cancelled row), clamped exactly as the per-row form
 *   ack           XACK/XDEL only after the settlement committed; a failed
 *                 acknowledgement leaves the entry pending, and the reclaim
 *                 pass later settles it as a no-op and acknowledges it
 *   release       the in-flight registration and route slot of every stale
 *                 envelope released exactly once, settled or not
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  settlementDb,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import {
  CampaignWorker,
  DatabaseJobQueue,
  RouteTpsLimiter,
  flushAllCampaignMetricDeltas,
  type PreparedCampaignEnvelope,
  type ProviderSender,
} from "../src/services/campaign-queue";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import {
  InMemoryPreparedDispatchBroker,
  type BrokerEnvelope,
  type PreparedDispatchBroker,
} from "../src/services/campaign-prepared-broker";
import { inFlightRegistry } from "../src/services/campaign-inflight";

const createdCampaignIds: number[] = [];
after(async () => {
  inFlightRegistry.clear();
  if (createdCampaignIds.length) {
    await db.update(campaignsTable).set({ status: "Cancelled" })
      .where(inArray(campaignsTable.id, createdCampaignIds));
  }
  await pool.end();
});

const DEAD_TOKEN = 1;
const LANE_TOKEN = 2;
const PAGE = 256;

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One phone; one route per campaign on that phone; `jobCounts[i]` jobs in campaign i. */
async function fixture(slug: string, jobCounts: number[]) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization!.id, wabaId: waba!.id,
    phone: `+1557${organization!.id.toString().padStart(7, "0")}`,
    displayName: slug, status: "Connected", tpsLimit: 1_000,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${slug}-template`,
    status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const campaigns = [];
  for (const [index, jobCount] of jobCounts.entries()) {
    const [campaign] = await db.insert(campaignsTable).values({
      organizationId: organization!.id, name: `${slug}-${index}`, status: "Running",
    }).returning();
    createdCampaignIds.push(campaign!.id);
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone!.id,
      templateId: template!.id, configuredTps: 1_000, queueDepth: jobCount,
    }).returning();
    await db.insert(campaignTemplateSelectionsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id,
    });
    await db.insert(campaignTemplateMappingsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id,
      component: "body", variable: "1", source: "static", sourceValue: "World",
    });
    await db.insert(campaignMetricsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id,
      total: jobCount, valid: jobCount, queued: jobCount,
    });
    for (let job = 0; job < jobCount; job += 1) {
      const [contact] = await db.insert(campaignContactsTable).values({
        organizationId: organization!.id, campaignId: campaign!.id, rowNumber: job + 1,
        rawPhone: phone!.phone, normalizedPhone: phone!.phone, data: { phone: phone!.phone },
        status: "Valid", partitionKey: 1, routeId: route!.id, idempotencyKey: `${slug}-${index}-c${job}`,
      }).returning();
      await db.insert(campaignJobsTable).values({
        organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id,
        contactId: contact!.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-${index}-j${job}`,
        attempts: 0, maxAttempts: 5,
      });
    }
    campaigns.push({ campaign: campaign!, route: route! });
  }
  return { organization: organization!, phone: phone!, campaigns };
}

class DiscardSender implements ProviderSender {
  sends = 0;
  revokes = 0;
  failRevokeFor = new Set<number>();
  async send() {
    this.sends += 1;
    throw new Error("the provider must never be called for a stale envelope");
  }
  async revokePrepared(context: unknown, reason: unknown) {
    assert.ok(reason instanceof Error && reason.message === "Campaign runtime stopping");
    this.revokes += 1;
    const jobId = (context as { jobId?: number } | undefined)?.jobId;
    if (jobId !== undefined && this.failRevokeFor.has(jobId)) throw new Error(`revoke failed for job ${jobId}`);
  }
  /** Gives each prepared context a job id so revokes can be targeted. */
  async prepareBatch(jobs: Array<{ id: number }>) {
    return new Map(jobs.map((job) => [job.id, { jobId: job.id }]));
  }
}

class SpyBroker implements PreparedDispatchBroker {
  readonly inner = new InMemoryPreparedDispatchBroker();
  readonly acks: string[][] = [];
  readonly consumes: number[] = [];
  failNextAcks = 0;
  publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]) {
    return this.inner.publish(phoneNumberId, fencingToken, envelopes);
  }
  async consume(phoneNumberId: number, consumerId: string, count: number) {
    const deliveries = await this.inner.consume(phoneNumberId, consumerId, count);
    this.consumes.push(deliveries.length);
    return deliveries;
  }
  reclaimAbandoned(phoneNumberId: number, consumerId: string, minIdleMs: number, count: number, cursor?: string) {
    return this.inner.reclaimAbandoned(phoneNumberId, consumerId, minIdleMs, count, cursor);
  }
  async acknowledge(phoneNumberId: number, ids: string[]) {
    if (!ids.length) return;
    if (this.failNextAcks > 0) {
      this.failNextAcks -= 1;
      throw new Error("simulated Redis XACK failure");
    }
    this.acks.push([...ids]);
    return this.inner.acknowledge(phoneNumberId, ids);
  }
  metrics(phoneNumberId: number) { return this.inner.metrics(phoneNumberId); }
  async close() {}
  pendingCount(phoneNumberId: number) { return this.inner.metrics(phoneNumberId).then((m) => m.pending); }
  depth(phoneNumberId: number) { return this.inner.metrics(phoneNumberId).then((m) => m.depth); }
}

type Harness = {
  worker: CampaignWorker;
  sender: DiscardSender;
  broker: SpyBroker;
  reservoir: CampaignPhoneReservoir;
  lane: Record<string, any>;
  transactions: number;
  failTransaction: number | undefined;
  peakPage: number;
  dispatches: number;
  consume(): Promise<void>;
  recover(): Promise<void>;
};

const originalTransaction = settlementDb.transaction.bind(settlementDb);
let transactionCounter: ((error?: unknown) => void) | undefined;
(settlementDb as any).transaction = (...args: Parameters<typeof settlementDb.transaction>) => {
  transactionCounter?.();
  return originalTransaction(...args);
};

function harness(f: Fixture): Harness {
  const sender = new DiscardSender();
  const broker = new SpyBroker();
  const worker = new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `stale-discard-${Date.now()}`, 30_000);
  const coordinator = {
    async ensurePhoneOwnership() {
      return { owned: true, fencingToken: LANE_TOKEN, validUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0 };
    },
    async releasePhoneOwnership() {},
  };
  const reservoir = new CampaignPhoneReservoir(worker, PAGE, coordinator as any, "replacement", 16_384, undefined, broker, 0);
  const lane: Record<string, any> = {
    organizationId: f.organization.id, phoneNumberId: f.phone.id, ownerId: "replacement", shardId: 0,
    fencingToken: LANE_TOKEN, ownershipValidUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0,
    capacity: PAGE, lowWater: PAGE / 2, highWater: PAGE, queued: 0, reserved: 0, providerInFlight: 0,
    refilling: false, refillDurationMs: 0, emptyDelayMs: 0, brokerDepth: 0, brokerConsumerLag: 0,
    queue: [], draining: false, sourceEmptyUntil: 0, sourceEmptyBackoffMs: 0, nextRecoveryAt: 0, nextMetricsAt: 0,
    pendingAckIds: [], ackInFlight: 0, ackRetryDelayMs: 0, nextAckRetryAt: 0, ackFlush: undefined,
    ackFlushTimer: undefined, published: new Map(), nextLeaseRenewalAt: 0,
  };
  const h: Harness = {
    worker, sender, broker, reservoir, lane, transactions: 0, failTransaction: undefined, peakPage: 0, dispatches: 0,
    consume: async () => {
      transactionCounter = () => {
        h.transactions += 1;
        if (h.failTransaction === h.transactions) throw new Error(`simulated settlement failure in transaction ${h.transactions}`);
      };
      try {
        await (reservoir as any).consume(lane);
      } finally {
        transactionCounter = undefined;
      }
    },
    recover: () => (reservoir as any).recoverAbandoned(lane),
  };
  const discard = worker.discardReservoirEnvelopes.bind(worker);
  worker.discardReservoirEnvelopes = async (envelopes: PreparedCampaignEnvelope[], now?: Date) => {
    h.peakPage = Math.max(h.peakPage, envelopes.length);
    return discard(envelopes, now);
  };
  const dispatch = worker.dispatchReservoirEnvelope.bind(worker);
  worker.dispatchReservoirEnvelope = ((...args: Parameters<CampaignWorker["dispatchReservoirEnvelope"]>) => {
    h.dispatches += 1;
    return dispatch(...args);
  }) as CampaignWorker["dispatchReservoirEnvelope"];
  return h;
}

/**
 * The production supply path up to publication, under `token`, with nothing
 * consumed: exactly what a runtime that dies between publish and consume
 * leaves behind. Returns the published envelopes (job ids and leases).
 */
async function stageUnconsumed(h: Harness, phoneId: number, count: number, token = DEAD_TOKEN): Promise<BrokerEnvelope[]> {
  const envelopes: BrokerEnvelope[] = [];
  for (let round = 0; round < 400 && envelopes.length < count; round += 1) {
    const claimed = await h.worker.claimPhoneBatch(phoneId, Math.min(PAGE, count - envelopes.length));
    if (!claimed.length) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    const prepared = await h.worker.prepareReservoirBatch(claimed);
    for (const envelope of prepared) envelopes.push(h.worker.handoffPreparedEnvelope(envelope));
  }
  assert.equal(envelopes.length, count, "every job must have been claimed and prepared");
  await h.broker.publish(phoneId, token, envelopes);
  h.lane.brokerDepth += count;
  assert.equal(inFlightRegistry.size, 0, "handoff releases the staging registrations");
  return envelopes;
}

const jobRows = (campaignId: number) =>
  db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(campaignJobsTable.id);
async function counters(campaignId: number) {
  await flushAllCampaignMetricDeltas(campaignId);
  const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaignId));
  const [route] = await db.select({ queueDepth: campaignRoutesTable.queueDepth }).from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaignId));
  return { queued: metrics!.queued, processing: metrics!.processing, sent: metrics!.sent, failed: metrics!.failed, queueDepth: route!.queueDepth };
}
const slug = (name: string) => `p21d-${name}-${process.pid}-${Date.now()}`;
const routeInFlight = (h: Harness, routeId: number) => ((h.worker as any).routeInFlight as Map<number, number>).get(routeId);

async function assertRequeued(campaignId: number, ids: number[], window: { before: Date; after: Date }) {
  const rows = (await jobRows(campaignId)).filter((row) => ids.includes(row.id));
  assert.equal(rows.length, ids.length);
  for (const row of rows) {
    assert.equal(row.status, "Queued", `job ${row.id} must be requeued, never failed`);
    assert.equal(row.leaseToken, null);
    assert.equal(row.lockedAt, null);
    assert.equal(row.lockedBy, null);
    assert.equal(row.leaseExpiresAt, null);
    assert.equal(row.attempts, 1, "settlement never changes attempts; the claim did");
    assert.equal(row.errorReason, null, "a requeue records no error");
    assert.ok(
      row.availableAt.getTime() >= window.before.getTime() + 250 - 5 && row.availableAt.getTime() <= window.after.getTime() + 250 + 5,
      `available_at is the discard clock plus 250 ms, got ${row.availableAt.toISOString()}`,
    );
  }
  return rows;
}

test("A · a full page of 256 stale envelopes is requeued in one transaction and acknowledged once", async () => {
  const f = await fixture(slug("page"), [PAGE]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, PAGE);
  const before = await counters(f.campaigns[0]!.campaign.id);
  const start = new Date();
  await h.consume();
  const end = new Date();

  await assertRequeued(f.campaigns[0]!.campaign.id, staged.map((e) => e.job.id), { before: start, after: end });
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.processing, before.processing - PAGE);
  assert.equal(after.queued, before.queued + PAGE);
  assert.equal(after.failed, before.failed);
  assert.equal(after.queueDepth, before.queueDepth, "a requeue leaves the route's depth alone");
  assert.equal(h.transactions, 1, "one aborted settlement for the whole page");
  assert.equal(h.broker.acks.length, 1, "one acknowledgement for the whole page");
  assert.equal(h.broker.acks[0]!.length, PAGE);
  assert.equal(h.sender.revokes, PAGE, "every stale envelope's prepared intent is revoked, as before");
  assert.equal(h.sender.sends, 0);
  assert.equal(h.dispatches, 0);
  assert.equal(h.lane.queued, 0);
  assert.equal(h.lane.brokerDepth, 0, "the lane's outstanding count drops by the acknowledged page");
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.equal(await h.broker.depth(f.phone.id), 0);
  assert.equal(inFlightRegistry.size, 0);
  assert.equal(routeInFlight(h, f.campaigns[0]!.route.id), undefined, "route slots are released exactly once");
});

test("B · a page spanning campaigns settles once per campaign and is acknowledged once", async () => {
  const f = await fixture(slug("mixed"), [30, 20]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, 50);
  const before = await Promise.all(f.campaigns.map((c) => counters(c.campaign.id)));
  const start = new Date();
  await h.consume();
  const end = new Date();

  for (const [index, c] of f.campaigns.entries()) {
    const ids = staged.filter((e) => e.job.campaignId === c.campaign.id).map((e) => e.job.id);
    assert.equal(ids.length, [30, 20][index]);
    await assertRequeued(c.campaign.id, ids, { before: start, after: end });
    const after = await counters(c.campaign.id);
    assert.equal(after.queued - before[index]!.queued, ids.length);
    assert.equal(after.processing - before[index]!.processing, -ids.length);
  }
  assert.equal(h.transactions, 2, "one transaction per campaign in the page");
  assert.equal(h.broker.acks.length, 1);
  assert.equal(h.broker.acks[0]!.length, 50);
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
});

test("C · deliveries carrying the lane's own token with a live lease are queued, never discarded", async () => {
  const f = await fixture(slug("own"), [20]);
  const h = harness(f);
  await stageUnconsumed(h, f.phone.id, 20, LANE_TOKEN);
  await h.consume();
  assert.equal(h.lane.queued, 20);
  assert.equal(h.lane.queue.length, 20);
  assert.equal(h.transactions, 0);
  assert.equal(h.sender.revokes, 0);
  assert.equal(h.broker.acks.length, 0);
  assert.ok((await jobRows(f.campaigns[0]!.campaign.id)).every((row) => row.status === "Processing" && row.leaseToken !== null));
  assert.equal(await h.broker.pendingCount(f.phone.id), 20, "queued work stays pending until it is sent and acknowledged");
  assert.equal(h.sender.sends, 0);
  // The queued envelopes hold their registrations until dispatch; this test never dispatches them.
  inFlightRegistry.clear();
});

test("D/E · rows already Sent or already Failed are committed no-ops and their deliveries are acknowledged", async () => {
  const f = await fixture(slug("terminal"), [40]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, 40);
  const sentIds = staged.slice(0, 10).map((e) => e.job.id);
  const failedIds = staged.slice(10, 20).map((e) => e.job.id);
  await db.update(campaignJobsTable).set({ status: "Sent", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null })
    .where(inArray(campaignJobsTable.id, sentIds));
  await db.update(campaignJobsTable).set({ status: "Failed", errorReason: "earlier", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null })
    .where(inArray(campaignJobsTable.id, failedIds));
  const snapshot = (await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => sentIds.includes(row.id) || failedIds.includes(row.id));
  const before = await counters(f.campaigns[0]!.campaign.id);
  const start = new Date();
  await h.consume();
  const end = new Date();

  const rows = await jobRows(f.campaigns[0]!.campaign.id);
  assert.deepEqual(
    rows.filter((row) => sentIds.includes(row.id) || failedIds.includes(row.id)).map((row) => [row.status, row.errorReason, row.updatedAt.getTime()]),
    snapshot.map((row) => [row.status, row.errorReason, row.updatedAt.getTime()]),
    "terminal rows are not touched",
  );
  await assertRequeued(f.campaigns[0]!.campaign.id, staged.slice(20).map((e) => e.job.id), { before: start, after: end });
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.queued - before.queued, 20, "only the rows actually requeued are counted");
  assert.equal(after.processing - before.processing, -20);
  assert.equal(h.transactions, 1);
  assert.equal(h.broker.acks.length, 1);
  assert.equal(h.broker.acks[0]!.length, 40, "one MULTI acknowledges no-ops and requeues alike");
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
});

test("F · a re-leased row keeps its newer lease; only the stale delivery is acknowledged", async () => {
  const f = await fixture(slug("release"), [12]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, 12);
  const releasedId = staged[4]!.job.id;
  await db.update(campaignJobsTable).set({ leaseToken: "another-lease", lockedBy: "someone-else" }).where(eq(campaignJobsTable.id, releasedId));
  const start = new Date();
  await h.consume();
  const end = new Date();

  const rows = await jobRows(f.campaigns[0]!.campaign.id);
  const released = rows.find((row) => row.id === releasedId)!;
  assert.equal(released.status, "Processing");
  assert.equal(released.leaseToken, "another-lease", "a different lease is never revoked by a stale envelope");
  await assertRequeued(f.campaigns[0]!.campaign.id, staged.filter((e) => e.job.id !== releasedId).map((e) => e.job.id), { before: start, after: end });
  assert.equal(h.broker.acks[0]!.length, 12, "the stale envelope of the re-leased job is acknowledged too");
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
});

test("G · a failed settlement leaves that campaign's deliveries pending with their leases; the rest are acknowledged", async () => {
  const f = await fixture(slug("partial"), [16, 9]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, 25);
  h.failTransaction = 2;

  await assert.rejects(h.consume(), /simulated settlement failure/);
  // Groups settle in page order, so whichever campaign came second is the broken one.
  const states = await Promise.all(f.campaigns.map(async (c) => ({ c, rows: await jobRows(c.campaign.id) })));
  const okCampaign = states.find(({ rows }) => rows.every((row) => row.status === "Queued"))!.c;
  const brokenCampaign = f.campaigns.find((c) => c !== okCampaign)!;
  const okCount = staged.filter((e) => e.job.campaignId === okCampaign.campaign.id).length;
  const brokenCount = staged.length - okCount;
  assert.ok((await jobRows(brokenCampaign.campaign.id)).every((row) => row.status === "Processing" && row.leaseToken !== null), "the failed campaign's jobs keep their exact lease");
  assert.equal(h.broker.acks.length, 1, "what persisted is acknowledged before the failure is raised");
  assert.equal(h.broker.acks[0]!.length, okCount);
  assert.equal(await h.broker.pendingCount(f.phone.id), brokenCount, "the unsettled deliveries stay pending");
  assert.equal(inFlightRegistry.size, 0, "registrations are released even for the unsettled envelopes");
  assert.equal(routeInFlight(h, brokenCampaign.route.id), undefined);

  // Pending under this consumer with a foreign token, they are the reclaim
  // pass's to resolve, exactly as a thrown per-envelope discard left them.
  await h.recover();
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.ok((await jobRows(brokenCampaign.campaign.id)).every((row) => row.status !== "Processing"), "nothing stays under a dead lease");
});

test("G2 · a failed revoke leaves only that envelope pending with its lease", async () => {
  const f = await fixture(slug("revoke"), [10]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, 10);
  const stuck = staged[3]!.job.id;
  h.sender.failRevokeFor.add(stuck);

  await assert.rejects(h.consume(), /revoke failed/);
  const rows = await jobRows(f.campaigns[0]!.campaign.id);
  assert.equal(rows.find((row) => row.id === stuck)!.status, "Processing");
  assert.equal(rows.filter((row) => row.status === "Queued").length, 9);
  assert.equal(h.broker.acks[0]!.length, 9);
  assert.equal(await h.broker.pendingCount(f.phone.id), 1);
  assert.equal(inFlightRegistry.size, 0);
});

test("H · an acknowledgement failure after the commit is retried as a no-op by the reclaim pass", async () => {
  const f = await fixture(slug("ackfail"), [24]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, 24);
  const before = await counters(f.campaigns[0]!.campaign.id);
  h.broker.failNextAcks = 1;
  const start = new Date();
  await assert.rejects(h.consume(), /simulated Redis XACK failure/);
  const end = new Date();

  await assertRequeued(f.campaigns[0]!.campaign.id, staged.map((e) => e.job.id), { before: start, after: end });
  assert.equal(await h.broker.pendingCount(f.phone.id), 24, "the deliveries are still pending");
  const snapshot = await jobRows(f.campaigns[0]!.campaign.id);

  await h.recover();
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.deepEqual(
    (await jobRows(f.campaigns[0]!.campaign.id)).map((row) => [row.status, row.leaseToken, row.updatedAt.getTime()]),
    snapshot.map((row) => [row.status, row.leaseToken, row.updatedAt.getTime()]),
    "the retry touched no row: the requeued rows no longer match the stale lease",
  );
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.queued - before.queued, 24, "counted once");
  assert.equal(after.processing - before.processing, -24);
  assert.equal(after.failed, before.failed, "a requeued job is never failed closed by the retry");
});

test("I · a crash between the commit and the acknowledgement is recovered by the next runtime without a second transition", async () => {
  const f = await fixture(slug("crash"), [18]);
  const first = harness(f);
  const staged = await stageUnconsumed(first, f.phone.id, 18);
  const deliveries = await first.broker.consume(f.phone.id, "replacement:2", 18);
  const before = await counters(f.campaigns[0]!.campaign.id);
  // Runtime 1 settles the page and dies before XACK.
  const settled = await first.worker.discardReservoirEnvelopes(deliveries.map((d) => first.worker.adoptPreparedEnvelope(d.envelope)));
  assert.equal(settled.settled.length, 18);
  assert.equal(settled.failure, undefined);
  assert.equal(await first.broker.pendingCount(f.phone.id), 18);
  assert.equal(inFlightRegistry.size, 0);

  // Runtime 2 over the same broker state finds them pending under a foreign token.
  const second = harness(f);
  const reservoir = new CampaignPhoneReservoir(second.worker, PAGE, {
    async ensurePhoneOwnership() { return { owned: true, fencingToken: 3, validUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0 }; },
    async releasePhoneOwnership() {},
  } as any, "replacement-2", 16_384, undefined, first.broker, 0);
  await (reservoir as any).recoverAbandoned({ ...second.lane, ownerId: "replacement-2", fencingToken: 3 });

  assert.equal(await first.broker.pendingCount(f.phone.id), 0);
  assert.ok((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => staged.some((e) => e.job.id === row.id)).every((row) => row.status === "Queued"));
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.queued - before.queued, 18, "requeued once, counted once");
  assert.equal(after.failed, before.failed);
  assert.equal(second.sender.sends, 0);
});

test("K/L · a requeued stale envelope is claimable again exactly once and nothing is lost", async () => {
  const f = await fixture(slug("reclaim"), [PAGE]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, PAGE);
  await h.consume();
  assert.equal(h.sender.sends, 0);
  assert.equal(h.dispatches, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const again: number[] = [];
  for (let round = 0; round < 400 && again.length < PAGE; round += 1) {
    const claimed = await h.worker.claimPhoneBatch(f.phone.id, PAGE - again.length);
    if (!claimed.length) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
    for (const job of claimed) {
      assert.equal(job.attempts, 2, "the second claim is the second attempt");
      again.push(job.id);
    }
  }
  assert.deepEqual(new Set(again), new Set(staged.map((e) => e.job.id)), "every requeued job comes back, each exactly once");
  const rows = await jobRows(f.campaigns[0]!.campaign.id);
  assert.equal(rows.filter((row) => row.status === "Processing").length, PAGE);
  assert.equal(rows.filter((row) => row.status === "Queued").length, 0, "no job is left behind or duplicated");
});

test("M · more than a page of stale envelopes is discarded page by page, never more than 256 at once", async () => {
  const total = 600;
  const f = await fixture(slug("pages"), [total]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, total);
  const before = await counters(f.campaigns[0]!.campaign.id);
  const start = new Date();
  await h.consume();
  await h.consume();
  await h.consume();
  const end = new Date();

  assert.deepEqual(h.broker.consumes, [PAGE, PAGE, total - 2 * PAGE], "each service pass consumes at most a page");
  assert.equal(h.peakPage, PAGE, "never more than a page of envelopes discarded at once");
  assert.equal(h.transactions, 3, "one transaction per page");
  assert.equal(h.broker.acks.length, 3);
  await assertRequeued(f.campaigns[0]!.campaign.id, staged.map((e) => e.job.id), { before: start, after: end });
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.queued - before.queued, total);
  assert.equal(after.processing - before.processing, -total);
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.equal(await h.broker.depth(f.phone.id), 0);
  assert.equal(h.lane.brokerDepth, 0);
  assert.equal(inFlightRegistry.size, 0);
});

test("N · a stale old-token envelope cannot touch a job the live lane holds under a newer lease", async () => {
  const f = await fixture(slug("newer"), [8]);
  const h = harness(f);
  const staged = await stageUnconsumed(h, f.phone.id, 8);
  const target = staged[2]!;
  // The live lane has since re-claimed this job: a newer lease in the database
  // and a fresh envelope under the lane's own token behind the stale one.
  await db.update(campaignJobsTable).set({ leaseToken: "newer-lease", lockedBy: "live-lane", leaseExpiresAt: new Date(Date.now() + 30_000) })
    .where(eq(campaignJobsTable.id, target.job.id));
  await h.broker.publish(f.phone.id, LANE_TOKEN, [{ ...target, job: { ...target.job, leaseToken: "newer-lease" } } as BrokerEnvelope]);
  h.lane.brokerDepth += 1;

  await h.consume();

  const rows = await jobRows(f.campaigns[0]!.campaign.id);
  const row = rows.find((r) => r.id === target.job.id)!;
  assert.equal(row.status, "Processing");
  assert.equal(row.leaseToken, "newer-lease", "the stale envelope's settlement did not match the newer lease");
  assert.equal(h.lane.queued, 1, "the live envelope is queued");
  assert.equal(h.lane.queue[0]!.envelope.job.id, target.job.id);
  assert.equal(h.lane.queue[0]!.envelope.job.leaseToken, "newer-lease");
  assert.equal(h.broker.acks.length, 1);
  assert.equal(h.broker.acks[0]!.length, 8, "all eight stale envelopes are acknowledged; the live one is not");
  assert.equal(rows.filter((r) => r.status === "Queued").length, 7);
  assert.equal(await h.broker.pendingCount(f.phone.id), 1);
  assert.equal(h.sender.sends, 0);
  inFlightRegistry.clear();
});
