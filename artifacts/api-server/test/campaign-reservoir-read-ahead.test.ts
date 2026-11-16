/*
 * P1 (docs/DELIVERY_UNKNOWN_REDUCTION_PLAN.md): the reservoir reads from a phone's stream only about
 * TPS x consumeAheadMs beyond what drain() admitted, instead of up to the lane's 3 s capacity. Work left unread is
 * not pending under the process, so after a crash the successor discards it as never sent instead of failing it
 * delivery-unknown.
 *
 *   bound          a read never exceeds the read-ahead target (queued + read-not-adopted + reads in progress
 *                  count against it) and skips reads below a minimum chunk
 *   concurrency    two consume passes started together read the deficit once, not twice
 *   takeover       entries this lane did not publish (a dead owner's backlog) are read at the full bound, so the
 *                  successor discards them quickly and its refill is not held off
 *   off            without consumeAheadMs the read size is the earlier one (hand-built reservoirs)
 *   STOP safety    adoption refuses an envelope whose armed provider intent is no longer pending (a STOP reply
 *                  rejected it while it waited unread): requeued as never sent, never queued for transport
 *   P0             the stale discard is counted (brokerStaleDiscarded) and every read too (brokerReads)
 *   replay         an envelope replaying an accepted provider message id is adopted although its intent is no
 *                  longer pending (refusing it looped forever: discarded, re-prepared as the same replay, ...);
 *                  a replay whose id does not match the intent's is still refused
 *   margin         the target widens by the smoothed consume pass time, so a slow database does not starve sends
 *   starvation     a consume-behind event (opened by drain(), see campaign-b13-remediation R5b) is closed by the
 *                  next read that queues work
 *
 * The bound/concurrency tests pin the smoothed consume time to 0 after every pass (the margin test sets it).
 *
 * Real PostgreSQL (claims, preparation, validation, settlement), in-memory broker.
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
  providerMessagesTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter, type ProviderSender } from "../src/services/campaign-queue";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import { InMemoryPreparedDispatchBroker, type BrokerEnvelope, type PreparedDispatchBroker } from "../src/services/campaign-prepared-broker";
import { inFlightRegistry } from "../src/services/campaign-inflight";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";

const organizationIds: number[] = [];
after(async () => {
  inFlightRegistry.clear();
  if (organizationIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  await pool.end();
});

const DEAD_TOKEN = 1;
const LANE_TOKEN = 2;
const PAGE = 256;
const slug = (name: string) => `p1ra-${name}-${process.pid}-${Date.now()}`;

/** One phone (tpsLimit `tps`), one Running campaign with one route and `jobs` jobs, unique recipients. */
async function fixture(name: string, jobs: number, tps: number) {
  const s = slug(name);
  const [organization] = await db.insert(organizationsTable).values({ name: s, slug: s }).returning();
  organizationIds.push(organization!.id);
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${s}-waba`, displayName: s }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization!.id, wabaId: waba!.id, phone: `+1557${organization!.id.toString().padStart(7, "0")}`,
    displayName: s, status: "Connected", tpsLimit: tps,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${s}-template`, status: "Approved",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: s, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone!.id, templateId: template!.id,
    configuredTps: tps, queueDepth: jobs,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id,
    component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total: jobs, valid: jobs, queued: jobs });
  const recipients = Array.from({ length: jobs }, (_, i) => `+1996${organization!.id.toString().padStart(5, "0")}${i.toString().padStart(4, "0")}`);
  const contacts = await db.insert(campaignContactsTable).values(recipients.map((recipient, i) => ({
    organizationId: organization!.id, campaignId: campaign!.id, rowNumber: i + 1, rawPhone: recipient, normalizedPhone: recipient,
    status: "Valid" as const, partitionKey: 1, routeId: route!.id, idempotencyKey: `${s}-c${i}`, data: {},
  }))).returning({ id: campaignContactsTable.id });
  await db.insert(campaignJobsTable).values(contacts.map((contact, i) => ({
    organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id, contactId: contact.id,
    type: "ResolveTemplateAndSend" as const, idempotencyKey: `${s}-j${i}`, availableAt: new Date(),
  })));
  return { organization: organization!, phone: phone!, campaign: campaign!, route: route! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

class NeverSendSender implements ProviderSender {
  async send(): Promise<string> { throw new Error("nothing in these tests reaches the provider"); }
  async revokePrepared() {}
  async prepareBatch(jobs: Array<{ id: number }>) { return new Map(jobs.map((job) => [job.id, { jobId: job.id }])); }
}

class CountingBroker implements PreparedDispatchBroker {
  readonly inner = new InMemoryPreparedDispatchBroker();
  readonly reads: number[] = [];
  readonly requested: number[] = [];
  /** Holds every read until released, so two passes can be in flight together. */
  gate: Promise<void> | undefined;
  publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]) { return this.inner.publish(phoneNumberId, fencingToken, envelopes); }
  async consume(phoneNumberId: number, consumerId: string, count: number) {
    this.requested.push(count);
    if (this.gate) await this.gate;
    const deliveries = await this.inner.consume(phoneNumberId, consumerId, count);
    this.reads.push(deliveries.length);
    return deliveries;
  }
  reclaimAbandoned(phoneNumberId: number, consumerId: string, minIdleMs: number, count: number, cursor?: string) {
    return this.inner.reclaimAbandoned(phoneNumberId, consumerId, minIdleMs, count, cursor);
  }
  acknowledge(phoneNumberId: number, ids: string[]) { return this.inner.acknowledge(phoneNumberId, ids); }
  metrics(phoneNumberId: number) { return this.inner.metrics(phoneNumberId); }
  async close() {}
}

function harness(f: Fixture, options: { consumeAheadMs?: number; tps: number; capacity?: number }) {
  const broker = new CountingBroker();
  const worker = new CampaignWorker(new DatabaseJobQueue(), new NeverSendSender(), new RouteTpsLimiter(), `p1ra-${Date.now()}-${Math.random()}`, 30_000);
  worker.updateTransportOwnership(f.phone.id, LANE_TOKEN, Date.now() + 60_000);
  const coordinator = {
    async ensurePhoneOwnership() { return { owned: true, fencingToken: LANE_TOKEN, validUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0 }; },
    async releasePhoneOwnership() {},
  };
  const reservoir = new CampaignPhoneReservoir(worker, PAGE, coordinator as never, "p1ra-owner", 16_384, undefined, broker, 0,
    undefined, undefined, options.consumeAheadMs);
  const capacity = options.capacity ?? Math.min(4_096, Math.ceil(options.tps * 3));
  const lane: Record<string, any> = {
    organizationId: f.organization.id, phoneNumberId: f.phone.id, ownerId: "p1ra-owner", shardId: 0,
    fencingToken: LANE_TOKEN, ownershipValidUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0,
    capacity, lowWater: Math.floor(capacity / 2), highWater: capacity, queued: 0, reserved: 0, providerInFlight: 0,
    refilling: false, refillDurationMs: 0, emptyDelayMs: 0, brokerDepth: 0, brokerConsumerLag: 0,
    queue: [], draining: false, sourceEmptyUntil: 0, sourceEmptyBackoffMs: 0, nextRecoveryAt: 0, nextMetricsAt: 0,
    pendingAckIds: [], ackInFlight: 0, ackRetryDelayMs: 0, nextAckRetryAt: 0, published: new Map(), nextLeaseRenewalAt: 0,
    acquiredAt: Date.now(), unadopted: [], adopting: new Set(), tps: options.tps, consumeReserved: 0,
  };
  (reservoir as any).lanes.set(f.phone.id, lane);
  // The margin (consumeLatencyMs) is measured per pass; pinned to `latencyMs` after each one so read sizes are exact.
  const consume = async (latencyMs = 0) => {
    await (reservoir as any).consume(lane);
    lane.consumeLatencyMs = latencyMs;
  };
  return { broker, worker, reservoir, lane, consume };
}
type Harness = ReturnType<typeof harness>;

/**
 * Claims, prepares and publishes `count` jobs under `token`, as the lane's refill does (own token: registered in
 * lane.published, so they count as this lane's unread entries) or as a dead owner left them (another token).
 */
async function publish(h: Harness, f: Fixture, count: number, token: number) {
  const envelopes: BrokerEnvelope[] = [];
  for (let round = 0; round < 400 && envelopes.length < count; round += 1) {
    const claimed = await h.worker.claimPhoneBatch(f.phone.id, Math.min(PAGE, count - envelopes.length));
    if (!claimed.length) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
    for (const envelope of await h.worker.prepareReservoirBatch(claimed)) envelopes.push(h.worker.handoffPreparedEnvelope(envelope));
  }
  assert.equal(envelopes.length, count, "every job claimed and prepared");
  await h.broker.publish(f.phone.id, token, envelopes);
  if (token === LANE_TOKEN) for (const envelope of envelopes) h.lane.published.set((h.reservoir as any).publishedKey(envelope), envelope);
  h.lane.brokerDepth += count;
  h.lane.brokerConsumerLag += count;
  return envelopes;
}

/** Simulates drain() admitting `count` queued envelopes to transport (removes them from the lane queue). */
function admit(h: Harness, count: number) {
  for (let i = 0; i < count; i += 1) {
    const queued = h.lane.queue.shift();
    if (!queued) break;
    h.lane.queued -= 1;
    h.lane.providerInFlight += 1;
  }
}

test("bound: a read never exceeds TPS x consumeAheadMs beyond what drain() admitted, and skips reads below the minimum chunk", async () => {
  const f = await fixture("bound", 900, 1_000);
  const h = harness(f, { consumeAheadMs: 250, tps: 1_000 });
  await publish(h, f, 900, LANE_TOKEN);
  const metricsBefore = campaignDispatchMetrics.snapshot();

  await h.consume();
  assert.deepEqual(h.broker.reads, [250], "the first pass reads the read-ahead target (1,000 TPS x 250 ms), not the 256 page or the 3,000 capacity");
  assert.equal(h.lane.queued, 250);
  await h.consume();
  assert.deepEqual(h.broker.reads, [250], "a full read-ahead issues no read");
  admit(h, 40);
  await h.consume();
  assert.deepEqual(h.broker.reads, [250], "a deficit below the minimum chunk (ceil(250 / 4) = 63) issues no read");
  admit(h, 160);
  await h.consume();
  assert.deepEqual(h.broker.reads, [250, 200], "a deficit of 200 is read in one pass, exactly");
  assert.equal(h.lane.queued, 250);
  const metricsAfter = campaignDispatchMetrics.snapshot();
  assert.equal(metricsAfter.brokerReads - metricsBefore.brokerReads, 2, "P0: every stream read is counted");
  assert.equal(metricsAfter.brokerEmptyReads - metricsBefore.brokerEmptyReads, 0);
  inFlightRegistry.clear();
});

test("concurrency: two consume passes started together read the deficit once", async () => {
  const f = await fixture("concurrent", 400, 1_000);
  const h = harness(f, { consumeAheadMs: 250, tps: 1_000 });
  await publish(h, f, 400, LANE_TOKEN);
  let release!: () => void;
  h.broker.gate = new Promise<void>((resolve) => { release = resolve; });
  const first = h.consume();
  const second = h.consume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(h.broker.requested, [250], "the second pass saw the first pass's reservation and did not read");
  assert.equal(h.lane.queued, 250);
  assert.equal(h.lane.consumeReserved, 0, "the reservation is returned after the read");
  inFlightRegistry.clear();
});

test("takeover: a dead owner's unread backlog is read at the full bound and discarded, not in read-ahead steps", async () => {
  const f = await fixture("takeover", 300, 100);
  const h = harness(f, { consumeAheadMs: 250, tps: 100 });
  const dead = await publish(h, f, 300, DEAD_TOKEN);
  const metricsBefore = campaignDispatchMetrics.snapshot();
  await h.consume();
  // capacity = 300 (100 TPS x 3 s); the read-ahead target alone would be 25.
  assert.deepEqual(h.broker.reads, [256], "the foreign backlog is read a full page at a time");
  await h.consume();
  assert.deepEqual(h.broker.reads, [256, 44]);
  const rows = await db.select().from(campaignJobsTable).where(inArray(campaignJobsTable.id, dead.map((e) => e.job.id)));
  assert.ok(rows.every((row) => row.status === "Queued" && row.attempts === 0), "every dead-owner entry was discarded as never sent: requeued, attempt returned");
  assert.equal(h.lane.queued, 0, "nothing of the dead owner's was queued for transport");
  const metricsAfter = campaignDispatchMetrics.snapshot();
  assert.equal(metricsAfter.brokerStaleDiscarded - metricsBefore.brokerStaleDiscarded, 300, "P0: the stale discard is counted");
  inFlightRegistry.clear();
});

test("off: without consumeAheadMs the read size is the earlier one", async () => {
  const f = await fixture("off", 600, 1_000);
  const h = harness(f, { tps: 1_000 });
  await publish(h, f, 600, LANE_TOKEN);
  await h.consume();
  await h.consume();
  await h.consume();
  assert.deepEqual(h.broker.reads, [256, 256, 88], "page-sized reads up to the capacity, as before P1");
  inFlightRegistry.clear();
});

test("STOP safety: an envelope whose provider intent was rejected while it waited unread is never queued for transport", async () => {
  const f = await fixture("stop", 4, 1_000);
  const h = harness(f, { consumeAheadMs: 250, tps: 1_000 });
  const envelopes = await publish(h, f, 4, LANE_TOKEN);
  const ids = envelopes.map((e) => e.job.id);
  // Armed intents for every job, as WhatsAppTemplateSender.prepareBatch writes them; then a STOP reply for the
  // second recipient rejects its pending intent (whatsapp-webhook.ts) while the envelope is still unread.
  await db.insert(providerMessagesTable).values(ids.map((jobId, i) => ({
    organizationId: f.organization.id, campaignJobId: jobId, requestKey: `p1ra-stop-${jobId}-${i}`, status: "pending",
  })));
  await db.update(providerMessagesTable).set({ status: "rejected", errorReason: "Recipient opted out (STOP reply)" })
    .where(eq(providerMessagesTable.campaignJobId, ids[1]!));
  await h.consume();
  const queuedIds = h.lane.queue.map((queued: { envelope: { job: { id: number } } }) => queued.envelope.job.id).sort();
  assert.deepEqual(queuedIds, [ids[0], ids[2], ids[3]].sort(), "only the jobs whose intent is still pending are queued");
  const [stopped] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, ids[1]!));
  assert.equal(stopped!.status, "Queued", "the rejected one is requeued as never sent (re-preparation then applies the suppression)");
  assert.equal(stopped!.attempts, 0, "its attempt is returned");
  inFlightRegistry.clear();
});

test("replay: an envelope replaying an accepted provider message id is adopted although its intent is sent or delivered", async () => {
  const f = await fixture("replay", 4, 1_000);
  const h = harness(f, { consumeAheadMs: 250, tps: 1_000 });
  // Claim and prepare as the lane's refill does, then make three of them replays (re-prepared after a crash between
  // the provider's acceptance and the job's settlement: WhatsAppTemplateSender sets priorProviderMessageId).
  const claimed = await h.worker.claimPhoneBatch(f.phone.id, 4);
  assert.equal(claimed.length, 4);
  const envelopes = (await h.worker.prepareReservoirBatch(claimed)).map((envelope) => h.worker.handoffPreparedEnvelope(envelope));
  const ids = envelopes.map((envelope) => envelope.job.id);
  const intentRows = [
    { status: "sent", providerMessageId: `wamid.p1ra-${ids[0]}`, replays: `wamid.p1ra-${ids[0]}` },
    { status: "delivered", providerMessageId: `wamid.p1ra-${ids[1]}`, replays: `wamid.p1ra-${ids[1]}` },
    { status: "sent", providerMessageId: `wamid.p1ra-${ids[2]}`, replays: `wamid.p1ra-other-${ids[2]}` },
    { status: "pending", providerMessageId: null, replays: undefined },
  ];
  await db.insert(providerMessagesTable).values(intentRows.map((row, i) => ({
    organizationId: f.organization.id, campaignJobId: ids[i]!, requestKey: `p1ra-replay-${ids[i]}`,
    status: row.status, providerMessageId: row.providerMessageId,
  })));
  for (const [i, envelope] of envelopes.entries()) {
    const replays = intentRows[i]!.replays;
    if (replays) (envelope as { preparedContext: unknown }).preparedContext = { ...(envelope.preparedContext as object), priorProviderMessageId: replays };
  }
  await h.broker.publish(f.phone.id, LANE_TOKEN, envelopes);
  for (const envelope of envelopes) h.lane.published.set((h.reservoir as any).publishedKey(envelope), envelope);
  h.lane.brokerDepth += 4;
  h.lane.brokerConsumerLag += 4;
  await h.consume();
  const queuedIds = h.lane.queue.map((queued: { envelope: { job: { id: number } } }) => queued.envelope.job.id).sort();
  assert.deepEqual(queuedIds, [ids[0], ids[1], ids[3]].sort(),
    "the matching replays (sent, delivered) and the pending one are adopted; the mismatched replay is not");
  const [mismatched] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, ids[2]!));
  assert.equal(mismatched!.status, "Queued", "a replay that does not match the recorded id is discarded as never sent");
  inFlightRegistry.clear();
});

test("margin: the read-ahead target widens by the smoothed consume pass time", async () => {
  const f = await fixture("margin", 600, 1_000);
  const h = harness(f, { consumeAheadMs: 250, tps: 1_000 });
  await publish(h, f, 600, LANE_TOKEN);
  h.lane.consumeLatencyMs = 100;
  await h.consume(100);
  assert.deepEqual(h.broker.reads, [256], "1,000 TPS x (250 + 100) ms = 350, read a page at a time");
  await h.consume(100);
  assert.deepEqual(h.broker.reads, [256, 94], "up to the widened target of 350");
  h.lane.consumeLatencyMs = 5_000;
  admit(h, 350);
  await h.consume(5_000);
  assert.deepEqual(h.broker.reads, [256, 94, 250], "the margin is capped at 1 s (target 1,000 TPS x 1,250 ms); the 250 entries left are read in one pass");
  inFlightRegistry.clear();
});

test("starvation: a consume-behind event is closed by the next read that queues work", async () => {
  // drain() opens it (campaign-b13-remediation.test.ts R5b); a refill's publish closes the other causes.
  const f = await fixture("starve", 300, 1_000);
  const h = harness(f, { consumeAheadMs: 250, tps: 1_000 });
  await publish(h, f, 300, LANE_TOKEN);
  const before = campaignDispatchMetrics.snapshot();
  h.lane.emptySince = Date.now() - 40;
  h.lane.emptyCause = "consume-behind";
  await h.consume();
  assert.equal(h.lane.queued, 250, "the read refilled the queue");
  const after = campaignDispatchMetrics.snapshot();
  assert.equal(after.reservoirStarvationEvents - before.reservoirStarvationEvents, 1, "the read that queued work closed the event");
  assert.equal(after.reservoirStarvationLog.at(-1)?.cause, "consume-behind");
  assert.ok((after.reservoirStarvationLog.at(-1)?.durationMs ?? 0) >= 40);
  assert.equal(h.lane.emptySince, undefined);
  assert.equal(h.lane.emptyCause, undefined);
  inFlightRegistry.clear();
});
