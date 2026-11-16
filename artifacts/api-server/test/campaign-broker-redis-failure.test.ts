/*
 * Decision 3 (Redis failures). A phone lane's published work whose stream entry it can no longer read must not stay
 * published (its lease renewed forever, never sent, never settled, the campaign never completing), and nothing it
 * may already have handed to the provider may ever be sent again.
 *
 *   lost reply       XREADGROUP delivered entries to this consumer but the reply never arrived (connection reset,
 *                    timeout): the next recovery pass, brought forward, finds them in this consumer's own pending
 *                    list (published, never read) and settles them never started (revoked under their exact lease,
 *                    requeued, attempt returned), then acknowledges them
 *   read vs lost     entries the lane did read (waiting in `unadopted`, or queued) are never judged lost
 *   read in flight   while recovery decides, no new read starts and one in flight is waited for, so an entry being
 *                    handed over is adopted, not settled; a read that does not finish in time defers the check
 *   retry            a settlement that fails leaves the work published and the scan pending; the next pass settles it
 *   stream loss      the stream (or its consumer group) is gone: unread published work is settled never started;
 *                    queued work (possibly in transport) is untouched
 *   Redis reset      real Redis: a command that finds the group gone (NOGROUP: restart without persistence, a deleted
 *                    key, a group destroyed) recreates it at the stream's end, trims the old entries (never
 *                    re-delivered) and throws BrokerStreamResetError once; the lane brings its recovery forward
 *   fresh process    a new broker that finds a stream without its group creates it the same way (at the end, old
 *                    entries trimmed): before, it was created at "0" and a dead owner's read entries were re-delivered
 *                    as unread, so the successor's stale discard requeued work that may already have been sent
 *   concurrent reset a second broker that finds the group already recreated (BUSYGROUP) trims nothing
 *
 * Real PostgreSQL for the lane tests (claims, preparation, validation, settlement); in-memory broker, except the
 * Redis tests, which start their own redis-server (never a shared one: they FLUSHALL and destroy groups).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { inArray } from "drizzle-orm";
import { createClient } from "redis";
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
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter, type ProviderSender } from "../src/services/campaign-queue";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import {
  BrokerStreamResetError,
  InMemoryPreparedDispatchBroker,
  RedisPreparedDispatchBroker,
  type BrokerDelivery,
  type BrokerEnvelope,
  type PreparedDispatchBroker,
} from "../src/services/campaign-prepared-broker";
import { inFlightRegistry } from "../src/services/campaign-inflight";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";

const REDIS_PORT = 6396;
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;
let redis: ChildProcess;
const organizationIds: number[] = [];

before(async () => {
  redis = spawn("redis-server", ["--port", String(REDIS_PORT), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    redis.once("spawn", resolve);
    redis.once("error", (error) => reject(new Error(`redis-server could not be started (is Redis 7 installed?): ${error.message}`)));
  });
  const deadline = Date.now() + 3_000;
  for (;;) {
    const client = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false } });
    client.on("error", () => {});
    try {
      await client.connect();
      await client.ping();
      await client.quit();
      break;
    } catch {
      try { await client.disconnect(); } catch { /* not connected */ }
      if (Date.now() >= deadline) throw new Error("the test redis-server did not start");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

after(async () => {
  inFlightRegistry.clear();
  if (organizationIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  await pool.end();
  redis.kill("SIGTERM");
});

const LANE_TOKEN = 2;
const PAGE = 256;
const slug = (name: string) => `d3rf-${name}-${process.pid}-${Date.now()}`;

/** One phone, one Running campaign with one route and `jobs` jobs, unique recipients. */
async function fixture(name: string, jobs: number, tps = 100) {
  const s = slug(name);
  const [organization] = await db.insert(organizationsTable).values({ name: s, slug: s }).returning();
  organizationIds.push(organization!.id);
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${s}-waba`, displayName: s }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization!.id, wabaId: waba!.id, phone: `+1558${organization!.id.toString().padStart(7, "0")}`,
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
  const recipients = Array.from({ length: jobs }, (_, i) => `+1995${organization!.id.toString().padStart(5, "0")}${i.toString().padStart(4, "0")}`);
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

/** Never reaches the provider; records every revocation (job id and the exact lease it was revoked under). */
class RecordingSender implements ProviderSender {
  readonly revoked: Array<{ jobId: number; leaseToken: string | null | undefined }> = [];
  failRevokes = 0;
  async send(): Promise<string> { throw new Error("nothing in these tests reaches the provider"); }
  async revokePrepared(context: unknown, _error: Error, leaseToken?: string | null) {
    if (this.failRevokes > 0) {
      this.failRevokes -= 1;
      throw new Error("simulated revoke failure");
    }
    this.revoked.push({ jobId: (context as { jobId: number }).jobId, leaseToken });
  }
  async prepareBatch(jobs: Array<{ id: number }>) { return new Map(jobs.map((job) => [job.id, { jobId: job.id }])); }
}

/**
 * The in-memory broker with Redis's failure modes: a read whose reply is lost after the entries were delivered, and
 * a read held after delivery (its reply in flight) until released.
 */
class FaultyBroker implements PreparedDispatchBroker {
  readonly inner = new InMemoryPreparedDispatchBroker();
  readonly requested: number[] = [];
  loseNextReply = false;
  /** Holds a read after its entries were delivered (the reply is in flight) until released. */
  replyGate: Promise<void> | undefined;
  publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]) { return this.inner.publish(phoneNumberId, fencingToken, envelopes); }
  async consume(phoneNumberId: number, consumerId: string, count: number) {
    this.requested.push(count);
    const deliveries = await this.inner.consume(phoneNumberId, consumerId, count);
    // One-shot: only the read in flight is held (a later read must never wait on it).
    const gate = this.replyGate;
    this.replyGate = undefined;
    if (gate) await gate;
    if (this.loseNextReply) {
      this.loseNextReply = false;
      throw new Error("Socket closed unexpectedly (simulated lost XREADGROUP reply)");
    }
    return deliveries;
  }
  /** Holds the next reclaim (the recovery pass's step after the lost-entry check) until released. */
  reclaimGate: Promise<void> | undefined;
  failAcks = 0;
  async reclaimAbandoned(phoneNumberId: number, consumerId: string, minIdleMs: number, count: number, cursor?: string) {
    const gate = this.reclaimGate;
    this.reclaimGate = undefined;
    if (gate) await gate;
    return this.inner.reclaimAbandoned(phoneNumberId, consumerId, minIdleMs, count, cursor);
  }
  async acknowledge(phoneNumberId: number, ids: string[]) {
    if (this.failAcks > 0) {
      this.failAcks -= 1;
      throw new Error("simulated acknowledgement failure");
    }
    return this.inner.acknowledge(phoneNumberId, ids);
  }
  metrics(phoneNumberId: number) { return this.inner.metrics(phoneNumberId); }
  pendingOwn(phoneNumberId: number, consumerId: string, count: number, afterId?: string) { return this.inner.pendingOwn(phoneNumberId, consumerId, count, afterId); }
  missingPublished(phoneNumberId: number, envelopes: BrokerEnvelope[]) { return this.inner.missingPublished(phoneNumberId, envelopes); }
  async close() {}
}

function harness(f: Fixture, broker: PreparedDispatchBroker, options: { tps?: number; consumeAheadMs?: number } = {}) {
  const sender = new RecordingSender();
  const worker = new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `d3rf-${Date.now()}-${Math.random()}`, 30_000);
  worker.updateTransportOwnership(f.phone.id, LANE_TOKEN, Date.now() + 60_000);
  const coordinator = {
    async ensurePhoneOwnership() { return { owned: true, fencingToken: LANE_TOKEN, validUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0 }; },
    async releasePhoneOwnership() {},
  };
  const tps = options.tps ?? 100;
  const reservoir = new CampaignPhoneReservoir(worker, PAGE, coordinator as never, "d3rf-owner", 16_384, undefined, broker, 0,
    undefined, undefined, options.consumeAheadMs);
  const capacity = Math.min(4_096, Math.ceil(tps * 3));
  const lane: Record<string, any> = {
    organizationId: f.organization.id, phoneNumberId: f.phone.id, ownerId: "d3rf-owner", shardId: 0,
    fencingToken: LANE_TOKEN, ownershipValidUntilMs: Date.now() + 5_000, coordinationLatencyMs: 0,
    capacity, lowWater: Math.floor(capacity / 2), highWater: capacity, queued: 0, reserved: 0, providerInFlight: 0,
    refilling: false, refillDurationMs: 0, emptyDelayMs: 0, brokerDepth: 0, brokerConsumerLag: 0,
    queue: [], draining: false, sourceEmptyUntil: 0, sourceEmptyBackoffMs: 0, nextRecoveryAt: 0, nextMetricsAt: 0,
    pendingAckIds: [], ackInFlight: 0, ackRetryDelayMs: 0, nextAckRetryAt: 0, published: new Map(), nextLeaseRenewalAt: 0,
    acquiredAt: Date.now(), unadopted: [], adopting: new Set(), tps, consumeReserved: 0,
  };
  (reservoir as any).lanes.set(f.phone.id, lane);
  const consume = () => (reservoir as any).consume(lane) as Promise<void>;
  const recover = () => (reservoir as any).recoverAbandoned(lane) as Promise<void>;
  const consumerId = `${lane.ownerId}:${lane.fencingToken}`;
  return { sender, worker, reservoir, lane, consume, recover, consumerId, broker };
}
type Harness = ReturnType<typeof harness>;

/** Claims, prepares and publishes `count` jobs under the lane's token, as its refill does. */
async function publish(h: Harness, f: Fixture, count: number) {
  const envelopes: BrokerEnvelope[] = [];
  for (let round = 0; round < 400 && envelopes.length < count; round += 1) {
    const claimed = await h.worker.claimPhoneBatch(f.phone.id, Math.min(PAGE, count - envelopes.length));
    if (!claimed.length) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
    for (const envelope of await h.worker.prepareReservoirBatch(claimed)) envelopes.push(h.worker.handoffPreparedEnvelope(envelope));
  }
  assert.equal(envelopes.length, count, "every job claimed and prepared");
  await h.broker.publish(f.phone.id, LANE_TOKEN, envelopes);
  for (const envelope of envelopes) h.lane.published.set((h.reservoir as any).publishedKey(envelope), envelope);
  h.lane.brokerDepth += count;
  h.lane.brokerConsumerLag += count;
  return envelopes;
}

async function jobRows(envelopes: BrokerEnvelope[]) {
  return db.select().from(campaignJobsTable).where(inArray(campaignJobsTable.id, envelopes.map((envelope) => envelope.job.id)));
}

/** Every job settled never started: requeued with its attempt returned and no lease, and revoked under its exact lease. */
async function assertSettledNotStarted(h: Harness, envelopes: BrokerEnvelope[], label: string) {
  const rows = await jobRows(envelopes);
  assert.equal(rows.length, envelopes.length);
  for (const row of rows) {
    assert.equal(row.status, "Queued", `${label}: job ${row.id} requeued`);
    assert.equal(row.attempts, 0, `${label}: job ${row.id}'s attempt returned (it never started)`);
    assert.equal(row.leaseToken, null, `${label}: job ${row.id}'s lease released`);
  }
  const revokedUnder = new Map(h.sender.revoked.map((revocation) => [revocation.jobId, revocation.leaseToken]));
  for (const envelope of envelopes) {
    assert.equal(revokedUnder.get(envelope.job.id), envelope.job.leaseToken, `${label}: job ${envelope.job.id} revoked under its exact lease`);
  }
}

test("lost reply: entries delivered by a read whose reply was lost are settled never started and acknowledged", async () => {
  const f = await fixture("lost-reply", 40);
  const broker = new FaultyBroker();
  // Read-ahead bounds each read to 100 TPS x 80 ms = 8 entries.
  const h = harness(f, broker, { tps: 100, consumeAheadMs: 80 });
  const envelopes = await publish(h, f, 40);
  const before = campaignDispatchMetrics.snapshot();

  broker.loseNextReply = true;
  await assert.rejects(h.consume(), /lost XREADGROUP reply/);
  assert.equal(h.lane.consumeReplyUncertain, true, "the failed read is remembered");
  assert.equal(h.lane.nextRecoveryAt, 0, "and the recovery pass is brought forward");
  assert.equal(h.lane.unadopted.length, 0, "the lane never saw the delivered entries");
  assert.equal(h.lane.consumeReserved, 0, "the read's reservation is returned");
  assert.equal((await broker.metrics(f.phone.id)).pending, 8, "the eight entries are pending under this consumer");
  const lost = envelopes.slice(0, 8);
  // A regular read never re-delivers a pending entry: without recovery these stayed published (renewed) forever.
  await h.consume();
  const queued = (h.lane.queue as Array<{ envelope: BrokerEnvelope }>).map((entry) => entry.envelope.job.id);
  assert.deepEqual(queued, envelopes.slice(8, 16).map((e) => e.job.id), "the next read gets the next eight, not the lost ones");

  await h.recover();
  await assertSettledNotStarted(h, lost, "lost reply");
  assert.equal(h.sender.revoked.length, 8, "only the lost entries are revoked");
  assert.equal(h.lane.consumeReplyUncertain, false, "the scan completed");
  for (const envelope of lost) assert.equal(h.lane.published.has((h.reservoir as any).publishedKey(envelope)), false, "forgotten: no longer renewed");
  assert.equal(h.lane.published.size, 24, "the unread entries stay published");
  const pendingAfter = await broker.inner.pendingOwn(f.phone.id, h.consumerId, 1_000);
  assert.deepEqual(pendingAfter.deliveries.map((d) => d.envelope.job.id), queued, "the lost entries are acknowledged; the queued ones stay pending");
  assert.equal(h.lane.queue.length, 8, "the queued work is untouched");
  const after = campaignDispatchMetrics.snapshot();
  assert.equal(after.brokerLostEntries - before.brokerLostEntries, 8, "counted");

  // The requeued jobs are claimed again under new leases; nothing was ever sent (the sender throws if called).
  const again = await publish(h, f, 8);
  assert.deepEqual(again.map((e) => e.job.id).sort(), lost.map((e) => e.job.id).sort(), "the same jobs, claimed again");
  for (const envelope of again) {
    assert.notEqual(envelope.job.leaseToken, lost.find((l) => l.job.id === envelope.job.id)!.job.leaseToken, "under a new lease");
  }
  inFlightRegistry.clear();
});

test("read vs lost: deliveries the lane did read (unadopted or queued) are never judged lost", async () => {
  const f = await fixture("read-vs-lost", 30);
  const broker = new FaultyBroker();
  const h = harness(f, broker);
  const envelopes = await publish(h, f, 30);
  // Five read by an earlier pass and waiting in `unadopted` (as after a validation failure), not adopted.
  const read = await broker.inner.consume(f.phone.id, h.consumerId, 5);
  h.lane.unadopted.push(...read);
  // The next read loses its reply (it can only deliver the 25 left).
  broker.loseNextReply = true;
  await assert.rejects(h.consume());
  await h.recover();
  const readIds = new Set(read.map((d) => d.envelope.job.id));
  const lost = envelopes.filter((e) => !readIds.has(e.job.id));
  await assertSettledNotStarted(h, lost, "read vs lost");
  const readRows = await jobRows(envelopes.filter((e) => readIds.has(e.job.id)));
  assert.ok(readRows.every((row) => row.status === "Processing" && row.attempts === 1), "the five read entries keep their leases");
  assert.equal(h.sender.revoked.filter((r) => readIds.has(r.jobId)).length, 0, "and are not revoked");
  assert.equal(h.lane.published.size, 5);
  // The next pass adopts them normally.
  await h.consume();
  assert.equal(h.lane.queued, 5, "the read entries are queued for transport");
  assert.equal(h.lane.published.size, 0);
  inFlightRegistry.clear();
});

test("read in flight: recovery waits for a read whose reply is in flight and starts no new read; its deliveries are adopted, not settled", async () => {
  const f = await fixture("in-flight", 30);
  const broker = new FaultyBroker();
  const h = harness(f, broker);
  await publish(h, f, 30);
  // An earlier read failed, so the scan of this consumer's pending list is due.
  h.lane.consumeReplyUncertain = true;
  let release!: () => void;
  broker.replyGate = new Promise<void>((resolve) => { release = resolve; });
  const reading = h.consume(); // delivers, then holds its reply
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(h.lane.consumeReserved > 0, "a read is in flight");
  const recovering = h.recover();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.lane.lostScan, true, "recovery holds new reads off while it decides");
  const requestedBefore = broker.requested.length;
  await h.consume();
  assert.equal(broker.requested.length, requestedBefore, "no read starts while recovery decides");
  release();
  await reading;
  await recovering;
  assert.equal(h.sender.revoked.length, 0, "nothing the in-flight read delivered was judged lost");
  assert.equal(h.lane.queued, 30, "every delivery was adopted and queued");
  assert.equal(h.lane.consumeReplyUncertain, false);
  assert.equal(h.lane.lostScan, false);
  inFlightRegistry.clear();
});

test("read in flight: a read that does not finish in time leaves the decision to the next pass", async () => {
  const f = await fixture("in-flight-slow", 10);
  const broker = new FaultyBroker();
  const h = harness(f, broker);
  await publish(h, f, 10);
  h.lane.consumeReplyUncertain = true;
  let release!: () => void;
  broker.replyGate = new Promise<void>((resolve) => { release = resolve; });
  const reading = h.consume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = Date.now();
  await h.recover();
  assert.ok(Date.now() - started < 2_000, "the wait is bounded");
  assert.equal(h.sender.revoked.length, 0, "nothing settled");
  assert.equal(h.lane.consumeReplyUncertain, true, "the scan is still due");
  assert.equal(h.lane.lostScan, false, "reads are allowed again");
  release();
  await reading;
  await h.recover();
  assert.equal(h.sender.revoked.length, 0, "the read's deliveries were adopted, not settled");
  assert.equal(h.lane.queued, 10);
  assert.equal(h.lane.consumeReplyUncertain, false);
  inFlightRegistry.clear();
});

test("retry: a settlement that fails leaves the work published and the scan due; the next pass settles it", async () => {
  const f = await fixture("retry", 12);
  const broker = new FaultyBroker();
  const h = harness(f, broker);
  const envelopes = await publish(h, f, 12);
  broker.loseNextReply = true;
  await assert.rejects(h.consume());
  h.sender.failRevokes = 1;
  await assert.rejects(h.recover(), /simulated revoke failure/);
  assert.equal(h.lane.published.size, 12, "still published (renewed), not forgotten");
  assert.equal(h.lane.consumeReplyUncertain, true, "the scan is still due");
  assert.equal(h.lane.lostScan, false);
  assert.equal((await broker.metrics(f.phone.id)).pending, 12, "still pending: not acknowledged before settlement");
  await h.recover();
  await assertSettledNotStarted(h, envelopes, "retry");
  assert.equal(h.lane.published.size, 0);
  assert.equal((await broker.metrics(f.phone.id)).pending, 0, "acknowledged after the settlement");
  inFlightRegistry.clear();
});

test("retry: an acknowledgement that fails leaves the settled entries published and the scan due; the next pass acknowledges them", async () => {
  const f = await fixture("ack-retry", 6);
  const broker = new FaultyBroker();
  const h = harness(f, broker);
  const envelopes = await publish(h, f, 6);
  broker.loseNextReply = true;
  await assert.rejects(h.consume());
  broker.failAcks = 1;
  await assert.rejects(h.recover(), /simulated acknowledgement failure/);
  await assertSettledNotStarted(h, envelopes, "settled before the acknowledgement");
  assert.equal(h.lane.published.size, 6, "not forgotten: forgotten, the scan would skip them and they stayed pending for good");
  assert.equal(h.lane.consumeReplyUncertain, true, "the scan is still due");
  assert.equal((await broker.metrics(f.phone.id)).pending, 6);
  await h.recover();
  assert.equal((await broker.metrics(f.phone.id)).pending, 0, "acknowledged on the next pass");
  assert.equal(h.lane.published.size, 0);
  assert.equal(h.lane.consumeReplyUncertain, false);
  await assertSettledNotStarted(h, envelopes, "after the retry");
  inFlightRegistry.clear();
});

test("recovery request: a read that fails while a recovery pass runs brings the next pass forward when that one ends", async () => {
  const f = await fixture("request-during-pass", 10);
  const broker = new FaultyBroker();
  const h = harness(f, broker);
  await publish(h, f, 10);
  h.lane.nextMetricsAt = Date.now() + 60_000;
  h.lane.sourceEmptyUntil = Date.now() + 60_000; // no refill in this test
  let release!: () => void;
  broker.reclaimGate = new Promise<void>((resolve) => { release = resolve; });
  (h.reservoir as any).service(h.lane); // starts the recovery pass (held in its reclaim step)
  await h.lane.service;
  assert.ok(h.lane.recovery, "a recovery pass is running");
  broker.loseNextReply = true;
  await assert.rejects(h.consume());
  assert.equal(h.lane.consumeReplyUncertain, true);
  release();
  await h.lane.recovery;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.lane.nextRecoveryAt, 0, "the running pass's end did not defer the requested one by a whole interval");
  await h.recover();
  assert.equal(h.sender.revoked.length, 10, "the lost reply's entries are settled by the next pass");
  inFlightRegistry.clear();
});

test("stream loss: unread published work is settled never started; queued work is untouched", async () => {
  const f = await fixture("stream-loss", 30);
  const broker = new FaultyBroker();
  const h = harness(f, broker, { tps: 100, consumeAheadMs: 80 });
  const envelopes = await publish(h, f, 30);
  await h.consume(); // read-ahead: 100 TPS x 80 ms = 8
  const queued = h.lane.queue.map((entry: { envelope: BrokerEnvelope }) => entry.envelope.job.id) as number[];
  assert.equal(queued.length, 8);
  const before = campaignDispatchMetrics.snapshot();
  broker.inner.loseStream(f.phone.id);
  await h.recover();
  const unread = envelopes.filter((e) => !queued.includes(e.job.id));
  await assertSettledNotStarted(h, unread, "stream loss");
  assert.equal(h.lane.queue.length, 8, "queued work (possibly in transport) stays queued");
  const queuedRows = await jobRows(envelopes.filter((e) => queued.includes(e.job.id)));
  assert.ok(queuedRows.every((row) => row.status === "Processing"), "and keeps its lease");
  assert.equal(h.sender.revoked.filter((r) => queued.includes(r.jobId)).length, 0, "and is never revoked");
  assert.equal(h.lane.published.size, 0);
  assert.equal(campaignDispatchMetrics.snapshot().brokerLostEntries - before.brokerLostEntries, 22);
  // A second pass finds nothing more.
  await h.recover();
  assert.equal(campaignDispatchMetrics.snapshot().brokerLostEntries - before.brokerLostEntries, 22);
  inFlightRegistry.clear();
});

function envelope(id: number, phoneNumberId: number): BrokerEnvelope {
  return {
    job: {
      id, organizationId: 1, campaignId: 2, routeId: 3, contactId: 4, type: "ResolveTemplateAndSend", payload: {},
      status: "Processing", attempts: 1, maxAttempts: 3, availableAt: new Date(), lockedAt: new Date(), lockedBy: "publisher",
      leaseToken: `lease-${id}`, leaseExpiresAt: new Date(Date.now() + 30_000), scheduledSendAt: new Date(),
      idempotencyKey: `job-${id}`, errorReason: null, createdAt: new Date(), updatedAt: new Date(), dispatchPhoneNumberId: phoneNumberId,
    },
    preparedContext: { providerMessageRowId: id, payload: { to: String(id) } },
  } as BrokerEnvelope;
}

async function rawClient() {
  const client = createClient({ url: REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  return client;
}
const key = (phone: number) => `campaign:prepared:{phone:${phone}}`;

test("Redis reset: a restart without persistence (keys gone) recreates the group, reports the reset once, and new work flows", async () => {
  const broker = new RedisPreparedDispatchBroker(REDIS_URL);
  const raw = await rawClient();
  try {
    const phone = 501;
    const old = [envelope(1, phone), envelope(2, phone), envelope(3, phone)];
    await broker.publish(phone, 7, old);
    assert.deepEqual(await broker.missingPublished(phone, old), [false, false, false]);
    await raw.flushAll();
    await assert.rejects(broker.consume(phone, "c:7", 10), (error: unknown) => error instanceof BrokerStreamResetError && error.phoneNumberId === phone);
    assert.deepEqual(await broker.missingPublished(phone, old), [true, true, true], "the old entries are reported missing");
    assert.equal(Number(await raw.sendCommand(["XLEN", key(phone)])), 0);
    const groups = await raw.sendCommand(["XINFO", "GROUPS", key(phone)]) as unknown[];
    assert.equal(groups.length, 1, "the group exists again");
    assert.deepEqual(await broker.consume(phone, "c:7", 10), [], "the next read works and finds nothing");
    const fresh = [envelope(4, phone), envelope(5, phone)];
    await broker.publish(phone, 7, fresh);
    assert.deepEqual((await broker.consume(phone, "c:7", 10)).map((d) => d.envelope.job.id), [4, 5], "new work flows");
    assert.deepEqual(await broker.missingPublished(phone, fresh), [false, false]);
  } finally {
    await raw.quit();
    await broker.close();
  }
});

test("Redis reset: a destroyed group is recreated at the stream's end and its old entries are trimmed, never re-delivered", async () => {
  const broker = new RedisPreparedDispatchBroker(REDIS_URL);
  const raw = await rawClient();
  try {
    const phone = 502;
    await broker.publish(phone, 7, [envelope(11, phone), envelope(12, phone), envelope(13, phone)]);
    const delivered = await broker.consume(phone, "c:7", 2); // possibly in transport when the group is lost
    assert.equal(delivered.length, 2);
    await raw.sendCommand(["XGROUP", "DESTROY", key(phone), "campaign-prepared-v1"]);
    // XACK reports nothing for a missing group: an acknowledgement after the loss is harmless (it deletes the entry).
    await broker.acknowledge(phone, [delivered[0]!.id]);
    await assert.rejects(broker.consume(phone, "c:7", 10), BrokerStreamResetError);
    assert.equal(Number(await raw.sendCommand(["XLEN", key(phone)])), 0, "old entries trimmed");
    assert.equal(await raw.exists(`${key(phone)}:published`), 0, "the dedupe hash is cleared");
    assert.deepEqual(await broker.consume(phone, "c:7", 10), [], "nothing old is ever delivered again, read or unread");
    assert.deepEqual(await broker.missingPublished(phone, [envelope(11, phone), envelope(13, phone)]), [true, true]);
    // Every command path recovers the same way: metrics and reclaim after another loss.
    await raw.sendCommand(["XGROUP", "DESTROY", key(phone), "campaign-prepared-v1"]);
    await assert.rejects(broker.metrics(phone), BrokerStreamResetError);
    assert.deepEqual(await broker.metrics(phone), { depth: 0, pending: 0, consumerLag: 0 });
    await raw.sendCommand(["XGROUP", "DESTROY", key(phone), "campaign-prepared-v1"]);
    await assert.rejects(broker.reclaimAbandoned(phone, "c:8", 0, 10), BrokerStreamResetError);
    assert.deepEqual((await broker.reclaimAbandoned(phone, "c:8", 0, 10)).deliveries, []);
  } finally {
    await raw.quit();
    await broker.close();
  }
});

test("Redis fresh process: a stream found without its group is never read from its start (a dead owner's read entries are not re-delivered)", async () => {
  const before = new RedisPreparedDispatchBroker(REDIS_URL);
  const raw = await rawClient();
  try {
    const phone = 505;
    await before.publish(phone, 7, [envelope(51, phone), envelope(52, phone), envelope(53, phone)]);
    const read = await before.consume(phone, "dead:7", 2); // read (possibly sent) by an owner that then died
    assert.equal(read.length, 2);
    await raw.sendCommand(["XGROUP", "DESTROY", key(phone), "campaign-prepared-v1"]); // and the group was lost
  } finally {
    await before.close();
  }
  const fresh = new RedisPreparedDispatchBroker(REDIS_URL); // a new process: no group cached
  try {
    const phone = 505;
    assert.deepEqual(await fresh.consume(phone, "successor:8", 10), [], "nothing is re-delivered as if unread");
    assert.equal(Number(await raw.sendCommand(["XLEN", key(phone)])), 0, "the old entries are trimmed (their leases expire and are reaped)");
    await fresh.publish(phone, 8, [envelope(54, phone)]);
    assert.deepEqual((await fresh.consume(phone, "successor:8", 10)).map((d) => d.envelope.job.id), [54], "new work flows");
  } finally {
    await raw.quit();
    await fresh.close();
  }
});

test("Redis concurrent reset: a broker that finds the group already recreated trims nothing", async () => {
  const first = new RedisPreparedDispatchBroker(REDIS_URL);
  const second = new RedisPreparedDispatchBroker(REDIS_URL);
  const raw = await rawClient();
  try {
    const phone = 503;
    await first.publish(phone, 7, [envelope(21, phone)]);
    await second.metrics(phone); // the second broker has seen the group
    await raw.flushAll();
    await assert.rejects(first.consume(phone, "c:7", 10), BrokerStreamResetError);
    await first.publish(phone, 7, [envelope(22, phone)]);
    // The second broker's command failed with NOGROUP before the first recreated the group; its reset must not trim
    // the entry published since.
    await assert.rejects(
      (second as any).withGroup(phone, async () => { throw new Error("NOGROUP No such key or consumer group (simulated race)"); }),
      BrokerStreamResetError,
    );
    assert.equal(Number(await raw.sendCommand(["XLEN", key(phone)])), 1, "the entry published after the first reset survives");
    assert.deepEqual((await second.consume(phone, "c:8", 10)).map((d) => d.envelope.job.id), [22]);
  } finally {
    await raw.quit();
    await first.close();
    await second.close();
  }
});

test("Redis pendingOwn: pages this consumer's own pending entries in stream order and nothing else", async () => {
  const broker = new RedisPreparedDispatchBroker(REDIS_URL);
  try {
    const phone = 504;
    await broker.publish(phone, 7, [1, 2, 3, 4, 5].map((id) => envelope(30 + id, phone)));
    const mine = await broker.consume(phone, "c:mine", 5); // the reply "lost": the caller never used it
    await broker.publish(phone, 7, [envelope(40, phone)]);
    await broker.consume(phone, "c:other", 5);
    const pages: number[][] = [];
    let after: string | null = "0";
    while (after !== null) {
      const page: { deliveries: BrokerDelivery[]; nextId: string | null } = await broker.pendingOwn(phone, "c:mine", 2, after);
      pages.push(page.deliveries.map((d) => d.envelope.job.id));
      after = page.nextId;
    }
    assert.deepEqual(pages, [[31, 32], [33, 34], [35]], "only this consumer's, in stream order, paged");
    await broker.acknowledge(phone, [mine[0]!.id, mine[1]!.id]);
    assert.deepEqual((await broker.pendingOwn(phone, "c:mine", 10)).deliveries.map((d) => d.envelope.job.id), [33, 34, 35]);
    assert.deepEqual((await broker.consume(phone, "c:mine", 10)), [], "a regular read never re-delivers them");
  } finally {
    await broker.close();
  }
});

test("Redis end to end: after a restart without persistence the lane settles its unread published work and brings recovery forward", async () => {
  const f = await fixture("redis-e2e", 20);
  const broker = new RedisPreparedDispatchBroker(REDIS_URL);
  const raw = await rawClient();
  try {
    const h = harness(f, broker);
    const envelopes = await publish(h, f, 20);
    h.lane.nextRecoveryAt = Date.now() + 60_000;
    await raw.flushAll();
    await assert.rejects(h.consume(), BrokerStreamResetError);
    assert.equal(h.lane.nextRecoveryAt, 0, "the reset brings the recovery pass forward");
    // A metrics call that finds the reset brings it forward too (the service pass's catch).
    h.lane.nextRecoveryAt = Date.now() + 60_000;
    h.lane.nextMetricsAt = 0;
    await raw.flushAll();
    (h.reservoir as any).service(h.lane);
    await h.lane.service;
    assert.equal(h.lane.nextRecoveryAt, 0, "a reset found by any service command brings recovery forward");
    await h.recover();
    await assertSettledNotStarted(h, envelopes, "Redis restart");
    assert.equal(h.lane.published.size, 0, "nothing left published and renewed");
    assert.equal(h.lane.consumeReplyUncertain, false);
  } finally {
    await raw.quit();
    await broker.close();
    inFlightRegistry.clear();
  }
});
