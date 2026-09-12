/*
 * P21 regression coverage: a replacement transport runtime fails a dead
 * consumer's pending broker deliveries closed one bounded page at a time,
 * with one failure-settlement transaction per campaign per page and one
 * broker acknowledgement per page, instead of one transaction and one
 * acknowledgement per delivery.
 *
 * State transition preserved for every reclaimed delivery (unchanged from the
 * per-delivery loop it replaces):
 *   own token     a delivery carrying the lane's own fencing token is this
 *                 lane's in-progress work: not settled, not acknowledged
 *   intent        settlePreparedTransport(job, { error }) first; a failed
 *                 intent write leaves the job untouched and unacknowledged
 *   fence         UPDATE only where status = 'Processing' AND lease_token =
 *                 the envelope's lease AND (org, campaign, route) match
 *   exhausted     the delivery-unknown error is never retryable, so the row
 *                 becomes 'Failed' whatever attempts/maxAttempts say
 *   lease         locked_at/locked_by/lease_token/lease_expires_at cleared
 *   clock         available_at = the recovery clock, no backoff
 *   attempts      unchanged
 *   counters      processing -1, failed +1 per updated row; route queue depth
 *                 -1 per updated row; one delta row per campaign per page
 *   no-op         a row already Sent (acknowledgement debt), already Failed
 *                 (an earlier reclaim), or re-leased is untouched inside a
 *                 committed transaction and its delivery is acknowledged
 *   complete      completeIfDrained(campaign) when a row was exhausted
 *   ack           XACK/XDEL only after the settlement committed; a failed
 *                 acknowledgement leaves the entry pending for the next pass
 *   provider      never called for a reclaimed delivery (at-most-once)
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
  RECLAIM_CURSOR_START,
  type BrokerDelivery,
  type BrokerEnvelope,
  type BrokerReclaim,
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
async function fixture(slug: string, jobCounts: number[], options: { attempts?: number; maxAttempts?: number } = {}) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization!.id, wabaId: waba!.id,
    phone: `+1556${organization!.id.toString().padStart(7, "0")}`,
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
    const jobIds: number[] = [];
    for (let job = 0; job < jobCount; job += 1) {
      const [contact] = await db.insert(campaignContactsTable).values({
        organizationId: organization!.id, campaignId: campaign!.id, rowNumber: job + 1,
        rawPhone: phone!.phone, normalizedPhone: phone!.phone, data: { phone: phone!.phone },
        status: "Valid", partitionKey: 1, routeId: route!.id, idempotencyKey: `${slug}-${index}-c${job}`,
      }).returning();
      const [row] = await db.insert(campaignJobsTable).values({
        organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id,
        contactId: contact!.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-${index}-j${job}`,
        attempts: options.attempts ?? 0, maxAttempts: options.maxAttempts ?? 5,
      }).returning();
      jobIds.push(row!.id);
    }
    campaigns.push({ campaign: campaign!, route: route!, jobIds });
  }
  return { organization: organization!, phone: phone!, campaigns };
}

class RecoverySender implements ProviderSender {
  sends = 0;
  intents = 0;
  failIntentFor = new Set<number>();
  async send() {
    this.sends += 1;
    throw new Error("the provider must never be called for a reclaimed delivery");
  }
  async settlePreparedTransport(job: { id: number }, _context: unknown, outcome: { error: unknown } | { providerMessageId: string }) {
    assert.ok("error" in outcome && outcome.error instanceof Error);
    assert.equal(outcome.error.message, "Provider delivery is unknown after broker consumer loss");
    this.intents += 1;
    if (this.failIntentFor.has(job.id)) throw new Error(`intent write failed for job ${job.id}`);
  }
}

/** Observes and, on request, breaks the broker exactly where the real one can fail. */
class SpyBroker implements PreparedDispatchBroker {
  readonly inner = new InMemoryPreparedDispatchBroker();
  readonly reclaims: Array<{ count: number; cursor: string; returned: number; next: string }> = [];
  readonly acks: string[][] = [];
  failNextAcks = 0;
  onReclaim?: () => void;
  publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]) {
    return this.inner.publish(phoneNumberId, fencingToken, envelopes);
  }
  consume(phoneNumberId: number, consumerId: string, count: number) {
    return this.inner.consume(phoneNumberId, consumerId, count);
  }
  async reclaimAbandoned(phoneNumberId: number, consumerId: string, minIdleMs: number, count: number, cursor = RECLAIM_CURSOR_START): Promise<BrokerReclaim> {
    const page = await this.inner.reclaimAbandoned(phoneNumberId, consumerId, minIdleMs, count, cursor);
    this.reclaims.push({ count, cursor, returned: page.deliveries.length, next: page.cursor });
    this.onReclaim?.();
    return page;
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
}

type Harness = {
  worker: CampaignWorker;
  sender: RecoverySender;
  broker: SpyBroker;
  reservoir: CampaignPhoneReservoir;
  lane: Record<string, unknown>;
  settlements: Array<{ campaignId: number; startedAt: number; endedAt: number }>;
  failSettlementFor: Set<number>;
  peakEnvelopes: number;
  peakRegistry: number;
  dispatches: number;
  recover(): Promise<void>;
};

function harness(f: Fixture, minIdleMs = 0): Harness {
  const sender = new RecoverySender();
  const broker = new SpyBroker();
  const worker = new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `reclaim-batch-${Date.now()}`, 30_000);
  const coordinator = {
    async ensurePhoneOwnership() {
      return { owned: true, fencingToken: LANE_TOKEN, validUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0 };
    },
    async releasePhoneOwnership() {},
  };
  const reservoir = new CampaignPhoneReservoir(worker, PAGE, coordinator as any, "replacement", 16_384, undefined, broker, minIdleMs);
  const lane = {
    organizationId: f.organization.id, phoneNumberId: f.phone.id, ownerId: "replacement", shardId: 0,
    fencingToken: LANE_TOKEN, ownershipValidUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0,
    capacity: PAGE, lowWater: PAGE / 2, highWater: PAGE, queued: 0, reserved: 0, providerInFlight: 0,
    refilling: false, refillDurationMs: 0, emptyDelayMs: 0, brokerDepth: 0, brokerConsumerLag: 0,
    queue: [], draining: false, sourceEmptyUntil: 0, sourceEmptyBackoffMs: 0, nextRecoveryAt: 0, nextMetricsAt: 0,
    pendingAckIds: [], ackInFlight: 0, ackRetryDelayMs: 0, nextAckRetryAt: 0, ackFlush: undefined,
    ackFlushTimer: undefined, published: new Map(), nextLeaseRenewalAt: 0,
  };
  const h: Harness = {
    worker, sender, broker, reservoir, lane, settlements: [], failSettlementFor: new Set(),
    peakEnvelopes: 0, peakRegistry: 0, dispatches: 0,
    recover: () => (reservoir as any).recoverAbandoned(lane),
  };
  const anyWorker = worker as any;
  const settle = anyWorker.withCampaignSettlement.bind(worker);
  anyWorker.withCampaignSettlement = async (campaignId: number, operation: () => Promise<unknown>) => {
    if (h.failSettlementFor.delete(campaignId)) throw new Error(`simulated settlement failure for campaign ${campaignId}`);
    const record = { campaignId, startedAt: 0, endedAt: 0 };
    h.settlements.push(record);
    try {
      return await settle(campaignId, async () => {
        record.startedAt = Date.now();
        return operation();
      });
    } finally {
      record.endedAt = Date.now();
    }
  };
  const abandon = worker.abandonBrokerEnvelopes.bind(worker);
  worker.abandonBrokerEnvelopes = async (envelopes: PreparedCampaignEnvelope[], now?: Date) => {
    h.peakEnvelopes = Math.max(h.peakEnvelopes, envelopes.length);
    h.peakRegistry = Math.max(h.peakRegistry, inFlightRegistry.size);
    return abandon(envelopes, now);
  };
  const dispatch = worker.dispatchReservoirEnvelope.bind(worker);
  worker.dispatchReservoirEnvelope = ((...args: Parameters<CampaignWorker["dispatchReservoirEnvelope"]>) => {
    h.dispatches += 1;
    return dispatch(...args);
  }) as CampaignWorker["dispatchReservoirEnvelope"];
  return h;
}

/**
 * Drives the exact production supply path for a consumer that then dies:
 * claim -> prepare -> handoff -> publish under the dead owner's token ->
 * consume by the dead consumer. Nothing is acknowledged, so every delivery
 * is pending under a consumer that will never return.
 */
async function stageDeadDeliveries(h: Harness, phoneId: number, count: number, token = DEAD_TOKEN): Promise<BrokerDelivery[]> {
  const envelopes: BrokerEnvelope[] = [];
  for (let round = 0; round < 400 && envelopes.length < count; round += 1) {
    // The pacing coordinator bounds one claim at 256 slots, as in production supply.
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
  const deliveries = await h.broker.consume(phoneId, `dead:${token}`, count);
  assert.equal(deliveries.length, count);
  assert.equal(inFlightRegistry.size, 0, "handoff releases the staging registrations");
  return deliveries;
}

const jobRows = (campaignId: number) =>
  db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(campaignJobsTable.id);
async function counters(campaignId: number) {
  await flushAllCampaignMetricDeltas(campaignId);
  const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaignId));
  const [campaign] = await db.select({ status: campaignsTable.status }).from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  const [route] = await db.select({ queueDepth: campaignRoutesTable.queueDepth }).from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaignId));
  return { queued: metrics!.queued, processing: metrics!.processing, sent: metrics!.sent, failed: metrics!.failed, status: campaign!.status, queueDepth: route!.queueDepth };
}
const slug = (name: string) => `p21-${name}-${process.pid}-${Date.now()}`;

async function assertFailedClosed(campaignId: number, expected: number, window: { before: Date; after: Date }) {
  const rows = await jobRows(campaignId);
  const failed = rows.filter((row) => row.status === "Failed");
  assert.equal(failed.length, expected);
  for (const row of failed) {
    assert.equal(row.errorReason, "Provider delivery is unknown after broker consumer loss");
    assert.equal(row.leaseToken, null);
    assert.equal(row.lockedAt, null);
    assert.equal(row.lockedBy, null);
    assert.equal(row.leaseExpiresAt, null);
    assert.equal(row.attempts, 1, "settlement never changes attempts; the claim did");
    assert.ok(
      row.availableAt.getTime() >= window.before.getTime() - 1_000 && row.availableAt.getTime() <= window.after.getTime() + 1_000,
      "a delivery-unknown failure is exhausted immediately, with no retry backoff",
    );
  }
  return rows;
}

test("A · one reclaimed delivery is failed closed, acknowledged after commit, and never sent", async () => {
  const f = await fixture(slug("one"), [1]);
  const h = harness(f);
  const [delivery] = await stageDeadDeliveries(h, f.phone.id, 1);
  const before = await counters(f.campaigns[0]!.campaign.id);
  const start = new Date();
  await h.recover();
  const end = new Date();

  await assertFailedClosed(f.campaigns[0]!.campaign.id, 1, { before: start, after: end });
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.processing, before.processing - 1);
  assert.equal(after.failed, before.failed + 1);
  assert.equal(after.queued, before.queued);
  assert.equal(after.queueDepth, before.queueDepth - 1);
  assert.equal(after.status, "Completed", "the last open job exhausting completes the campaign");
  assert.equal(h.settlements.length, 1);
  assert.deepEqual(h.broker.acks, [[delivery!.id]]);
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.equal(h.sender.intents, 1);
  assert.equal(h.sender.sends, 0);
  assert.equal(h.dispatches, 0);
  assert.equal(inFlightRegistry.size, 0);
});

test("B/F · 256 reclaimed deliveries of one campaign settle in one transaction and one acknowledgement", async () => {
  const f = await fixture(slug("page"), [PAGE]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, PAGE);
  const before = await counters(f.campaigns[0]!.campaign.id);
  const start = new Date();
  await h.recover();
  const end = new Date();

  await assertFailedClosed(f.campaigns[0]!.campaign.id, PAGE, { before: start, after: end });
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.processing, before.processing - PAGE);
  assert.equal(after.failed, before.failed + PAGE);
  assert.equal(after.queueDepth, before.queueDepth - PAGE);
  assert.equal(h.settlements.length, 1, "one settlement transaction for the whole page");
  assert.equal(h.broker.acks.length, 1, "one acknowledgement for the whole page");
  assert.deepEqual(new Set(h.broker.acks[0]), new Set(deliveries.map((d) => d.id)));
  assert.deepEqual(h.broker.reclaims.map((r) => [r.count, r.returned, r.next]), [[PAGE, PAGE, RECLAIM_CURSOR_START]]);
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.equal(h.sender.sends, 0);
  assert.equal(h.dispatches, 0);
});

test("C/P/Q · more than a page continues from the cursor, bounded to 256 in memory, and loses nothing", async () => {
  const total = 600;
  const f = await fixture(slug("pages"), [total]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, total);
  const before = await counters(f.campaigns[0]!.campaign.id);
  const start = new Date();
  await h.recover();
  const end = new Date();

  const rows = await assertFailedClosed(f.campaigns[0]!.campaign.id, total, { before: start, after: end });
  assert.equal(rows.filter((row) => row.status === "Processing").length, 0, "no job is left under a dead lease");
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.processing, before.processing - total);
  assert.equal(after.failed, before.failed + total);
  assert.equal(after.status, "Completed");
  assert.deepEqual(h.broker.reclaims.map((r) => r.count), [PAGE, PAGE, PAGE], "every page asks for at most 256");
  assert.deepEqual(h.broker.reclaims.map((r) => r.returned), [PAGE, PAGE, total - 2 * PAGE]);
  assert.equal(h.broker.reclaims[0]!.cursor, RECLAIM_CURSOR_START);
  assert.notEqual(h.broker.reclaims[1]!.cursor, RECLAIM_CURSOR_START, "the second page continues from the returned cursor");
  assert.equal(h.broker.reclaims[1]!.cursor, h.broker.reclaims[0]!.next);
  assert.equal(h.broker.reclaims[2]!.cursor, h.broker.reclaims[1]!.next);
  assert.equal(h.broker.reclaims[2]!.next, RECLAIM_CURSOR_START, "the pass ends when the scan reports the start cursor");
  assert.equal(h.settlements.length, 3, "one transaction per page, not per delivery");
  assert.equal(h.broker.acks.length, 3);
  assert.deepEqual(new Set(h.broker.acks.flat()), new Set(deliveries.map((d) => d.id)));
  assert.equal(h.peakEnvelopes, PAGE, "never more than a page of envelopes adopted at once");
  assert.ok(h.peakRegistry <= PAGE, `in-flight registrations peaked at ${h.peakRegistry}`);
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.equal(inFlightRegistry.size, 0);
  assert.equal(h.sender.sends, 0);
  assert.equal(h.dispatches, 0);
});

test("D · acknowledgement debt (already Sent) is left untouched and acknowledged with the unknown ones", async () => {
  const total = 40;
  const sentAlready = 15;
  const f = await fixture(slug("ackdebt"), [total]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, total);
  const sentIds = deliveries.slice(0, sentAlready).map((d) => d.envelope.job.id);
  // The dead consumer had settled these as Sent but died with their XACKs still queued.
  await db.update(campaignJobsTable).set({
    status: "Sent", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
  }).where(inArray(campaignJobsTable.id, sentIds));
  const sentBefore = (await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => sentIds.includes(row.id));
  const before = await counters(f.campaigns[0]!.campaign.id);
  const start = new Date();
  await h.recover();
  const end = new Date();

  const rows = await assertFailedClosed(f.campaigns[0]!.campaign.id, total - sentAlready, { before: start, after: end });
  const sentAfter = rows.filter((row) => sentIds.includes(row.id));
  assert.deepEqual(sentAfter.map((row) => [row.status, row.updatedAt.getTime()]), sentBefore.map((row) => ["Sent", row.updatedAt.getTime()]), "sent rows are not touched");
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.processing, before.processing - (total - sentAlready));
  assert.equal(after.failed, before.failed + (total - sentAlready));
  assert.equal(after.queueDepth, before.queueDepth - (total - sentAlready));
  assert.equal(h.settlements.length, 1);
  assert.equal(h.broker.acks.length, 1);
  assert.deepEqual(new Set(h.broker.acks[0]), new Set(deliveries.map((d) => d.id)), "one MULTI acknowledges unknown and sent alike");
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.equal(h.sender.sends, 0);
});

test("E · a page spanning campaigns settles once per campaign, under each campaign's serialization", async () => {
  const f = await fixture(slug("mixed"), [30, 20]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, 50);
  const before = await Promise.all(f.campaigns.map((c) => counters(c.campaign.id)));
  const start = new Date();
  await h.recover();
  const end = new Date();

  await assertFailedClosed(f.campaigns[0]!.campaign.id, 30, { before: start, after: end });
  await assertFailedClosed(f.campaigns[1]!.campaign.id, 20, { before: start, after: end });
  const after = await Promise.all(f.campaigns.map((c) => counters(c.campaign.id)));
  assert.equal(after[0]!.failed - before[0]!.failed, 30);
  assert.equal(after[1]!.failed - before[1]!.failed, 20);
  assert.equal(after[0]!.status, "Completed");
  assert.equal(after[1]!.status, "Completed");
  assert.deepEqual(new Set(h.settlements.map((s) => s.campaignId)), new Set(f.campaigns.map((c) => c.campaign.id)));
  assert.equal(h.settlements.length, 2, "one transaction per campaign in the page");
  assert.equal(h.broker.acks.length, 1, "still one acknowledgement for the page");
  assert.deepEqual(new Set(h.broker.acks[0]), new Set(deliveries.map((d) => d.id)));
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
});

test("G · recovery settlement waits behind live settlement of the same campaign", async () => {
  const f = await fixture(slug("concurrent"), [20]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, 20);
  let releaseLive!: () => void;
  const liveGate = new Promise<void>((resolve) => { releaseLive = resolve; });
  const live = (h.worker as any).withCampaignSettlement(f.campaigns[0]!.campaign.id, () => liveGate) as Promise<void>;
  const liveRecord = h.settlements[0]!;

  const recovery = h.recover();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(h.broker.acks.length, 0, "nothing is acknowledged while live settlement holds the campaign");
  assert.equal((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => row.status === "Failed").length, 0);
  releaseLive();
  await live;
  await recovery;

  const recoveryRecord = h.settlements[1]!;
  assert.ok(recoveryRecord.startedAt >= liveRecord.endedAt - 1, "recovery's transaction started only after the live one ended");
  assert.equal((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => row.status === "Failed").length, 20);
  assert.deepEqual(new Set(h.broker.acks[0]), new Set(deliveries.map((d) => d.id)));
});

test("H · a duplicate settlement of the same reclaimed envelopes is a committed no-op", async () => {
  const f = await fixture(slug("duplicate"), [12]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, 12);
  const before = await counters(f.campaigns[0]!.campaign.id);
  const adopt = () => deliveries.map((d) => h.worker.adoptPreparedEnvelope(d.envelope));

  const first = await h.worker.abandonBrokerEnvelopes(adopt());
  assert.equal(first.settled.length, 12);
  assert.equal(first.failure, undefined);
  const snapshot = await jobRows(f.campaigns[0]!.campaign.id);
  const second = await h.worker.abandonBrokerEnvelopes(adopt());
  assert.equal(second.settled.length, 12, "a no-op settlement still commits, so the deliveries may be acknowledged");
  assert.equal(second.failure, undefined);

  assert.deepEqual(
    (await jobRows(f.campaigns[0]!.campaign.id)).map((row) => [row.status, row.updatedAt.getTime()]),
    snapshot.map((row) => [row.status, row.updatedAt.getTime()]),
    "the second settlement touched no row",
  );
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.failed - before.failed, 12, "counters moved exactly once");
  assert.equal(after.processing - before.processing, -12);
  assert.equal(after.queueDepth - before.queueDepth, -12);
  assert.equal(inFlightRegistry.size, 0);
});

test("I · a failed settlement of one campaign leaves its deliveries pending while the others are acknowledged", async () => {
  const f = await fixture(slug("partial"), [16, 9]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, 25);
  const broken = f.campaigns[1]!.campaign.id;
  h.failSettlementFor.add(broken);

  await assert.rejects(h.recover(), /simulated settlement failure/);
  assert.equal((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => row.status === "Failed").length, 16);
  const brokenRows = await jobRows(broken);
  assert.ok(brokenRows.every((row) => row.status === "Processing" && row.leaseToken !== null), "the failed campaign's jobs keep their exact lease");
  assert.equal(h.broker.acks.length, 1, "what persisted is acknowledged before the failure is raised");
  assert.deepEqual(new Set(h.broker.acks[0]), new Set(deliveries.filter((d) => d.envelope.job.campaignId !== broken).map((d) => d.id)));
  assert.equal(await h.broker.pendingCount(f.phone.id), 9, "the unsettled deliveries stay pending for the next pass");
  assert.equal(inFlightRegistry.size, 0, "registrations are released even for the unsettled envelopes");

  await h.recover();
  assert.equal((await jobRows(broken)).filter((row) => row.status === "Failed").length, 9);
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.equal((await counters(broken)).failed, 9);
});

test("J · a Redis acknowledgement failure after a durable settlement is retried as a no-op on the next pass", async () => {
  const f = await fixture(slug("ackfail"), [24]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, 24);
  const before = await counters(f.campaigns[0]!.campaign.id);
  h.broker.failNextAcks = 1;

  await assert.rejects(h.recover(), /simulated Redis XACK failure/);
  assert.equal((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => row.status === "Failed").length, 24, "the settlement committed");
  assert.equal(await h.broker.pendingCount(f.phone.id), 24, "the deliveries are still pending");
  assert.equal(h.settlements.length, 1);

  await h.recover();
  assert.equal(h.settlements.length, 2, "the retry is a second (no-op) settlement, not a skipped one");
  assert.equal(h.broker.acks.length, 1);
  assert.deepEqual(new Set(h.broker.acks[0]), new Set(deliveries.map((d) => d.id)));
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.failed - before.failed, 24, "nothing is counted twice");
  assert.equal(after.processing - before.processing, -24);
});

test("K · a crash between the durable settlement and the acknowledgement is recovered by the next runtime", async () => {
  const f = await fixture(slug("crash"), [18]);
  const first = harness(f);
  const deliveries = await stageDeadDeliveries(first, f.phone.id, 18);
  const before = await counters(f.campaigns[0]!.campaign.id);
  // Runtime 1 settles the page and dies before XACK.
  const settled = await first.worker.abandonBrokerEnvelopes(deliveries.map((d) => first.worker.adoptPreparedEnvelope(d.envelope)));
  assert.equal(settled.settled.length, 18);
  assert.equal(await first.broker.pendingCount(f.phone.id), 18);

  // Runtime 2 (a new worker over the same broker state) finds them pending again.
  const second = harness(f);
  const reservoir = new CampaignPhoneReservoir(second.worker, PAGE, {
    async ensurePhoneOwnership() { return { owned: true, fencingToken: 3, validUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0 }; },
    async releasePhoneOwnership() {},
  } as any, "replacement-2", 16_384, undefined, first.broker, 0);
  await (reservoir as any).recoverAbandoned({ ...second.lane, ownerId: "replacement-2", fencingToken: 3 });

  assert.equal(await first.broker.pendingCount(f.phone.id), 0);
  assert.equal(first.broker.acks.length, 1);
  assert.deepEqual(new Set(first.broker.acks[0]), new Set(deliveries.map((d) => d.id)));
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.failed - before.failed, 18, "settled once, counted once");
  assert.equal((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => row.status === "Failed").length, 18);
  assert.equal(second.sender.sends, 0);
});

test("L · fencing: the lane's own deliveries are left alone and a re-leased job is not touched", async () => {
  const f = await fixture(slug("fence"), [10]);
  const h = harness(f);
  // Six deliveries pending under the dead consumer, four under this lane itself.
  const dead = await stageDeadDeliveries(h, f.phone.id, 6);
  const own = await stageDeadDeliveries(h, f.phone.id, 4, LANE_TOKEN);
  // One dead delivery's job was already requeued and re-leased by someone else.
  const releasedId = dead[0]!.envelope.job.id;
  await db.update(campaignJobsTable).set({ leaseToken: "another-lease", lockedBy: "someone-else" }).where(eq(campaignJobsTable.id, releasedId));
  const before = await counters(f.campaigns[0]!.campaign.id);

  await h.recover();

  const rows = await jobRows(f.campaigns[0]!.campaign.id);
  const released = rows.find((row) => row.id === releasedId)!;
  assert.equal(released.status, "Processing");
  assert.equal(released.leaseToken, "another-lease", "a different lease is never revoked by a stale envelope");
  assert.equal(rows.filter((row) => row.status === "Failed").length, 5);
  const ownIds = new Set(own.map((d) => d.envelope.job.id));
  assert.ok(rows.filter((row) => ownIds.has(row.id)).every((row) => row.status === "Processing"), "the lane's own work is untouched");
  assert.equal(h.broker.acks.length, 1);
  assert.deepEqual(new Set(h.broker.acks[0]), new Set(dead.map((d) => d.id)), "the stale envelope of the re-leased job is acknowledged; own deliveries are not");
  assert.equal(await h.broker.pendingCount(f.phone.id), 4, "the lane's own deliveries remain pending");
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.failed - before.failed, 5);
  assert.equal(h.sender.intents, 6, "the intent outcome is recorded for every stale delivery, as before");
});

test("M · retry semantics: delivery-unknown is exhausted regardless of remaining attempts", async () => {
  const f = await fixture(slug("retry"), [8], { attempts: 0, maxAttempts: 5 });
  const h = harness(f);
  await stageDeadDeliveries(h, f.phone.id, 8);
  const start = new Date();
  await h.recover();
  const end = new Date();
  const rows = await assertFailedClosed(f.campaigns[0]!.campaign.id, 8, { before: start, after: end });
  assert.ok(rows.every((row) => row.status === "Failed" && row.attempts === 1 && row.maxAttempts === 5), "never requeued for retry");
  const after = await counters(f.campaigns[0]!.campaign.id);
  assert.equal(after.queued, 0, "no retry was queued");
  assert.equal(after.failed, 8);
});

test("M2 · an intent write failure leaves that job untouched and unacknowledged for the next pass", async () => {
  const f = await fixture(slug("intent"), [10]);
  const h = harness(f);
  const deliveries = await stageDeadDeliveries(h, f.phone.id, 10);
  const stuck = deliveries[3]!.envelope.job.id;
  h.sender.failIntentFor.add(stuck);

  await assert.rejects(h.recover(), /intent write failed/);
  const rows = await jobRows(f.campaigns[0]!.campaign.id);
  assert.equal(rows.find((row) => row.id === stuck)!.status, "Processing");
  assert.equal(rows.filter((row) => row.status === "Failed").length, 9);
  assert.equal(await h.broker.pendingCount(f.phone.id), 1);
  assert.equal(inFlightRegistry.size, 0);

  h.sender.failIntentFor.clear();
  await h.recover();
  assert.equal((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => row.status === "Failed").length, 10);
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
});

test("N · STOP ends the pass after the current page; a later pass finishes the rest", async () => {
  const total = 600;
  const f = await fixture(slug("stop"), [total]);
  const h = harness(f);
  await stageDeadDeliveries(h, f.phone.id, total);
  h.broker.onReclaim = () => { (h.reservoir as any).stopping = true; };

  await h.recover();
  assert.equal(h.broker.reclaims.length, 1, "no further page is reclaimed once stopping");
  assert.equal(h.broker.acks.length, 1, "the page already reclaimed is still settled and acknowledged");
  assert.equal((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => row.status === "Failed").length, PAGE);
  assert.equal(await h.broker.pendingCount(f.phone.id), total - PAGE);

  (h.reservoir as any).stopping = false;
  h.broker.onReclaim = undefined;
  await h.recover();
  assert.equal((await jobRows(f.campaigns[0]!.campaign.id)).filter((row) => row.status === "Failed").length, total);
  assert.equal(await h.broker.pendingCount(f.phone.id), 0);
  assert.equal((await counters(f.campaigns[0]!.campaign.id)).status, "Completed");
});

test("O · an empty pending list costs one scan and nothing else", async () => {
  const f = await fixture(slug("empty"), [1]);
  const h = harness(f);
  await h.recover();
  assert.deepEqual(h.broker.reclaims.map((r) => [r.returned, r.next]), [[0, RECLAIM_CURSOR_START]]);
  assert.equal(h.settlements.length, 0);
  assert.equal(h.broker.acks.length, 0);
  assert.equal(h.sender.intents, 0);
});
