/*
 * Step 369 regression coverage: renewPublishedLeases() keeps the exact leases
 * of BOTH kinds of outstanding prepared work this runtime owns:
 *
 *   published  envelopes published to the broker and not consumed yet
 *   queued     envelopes consumed into the lane's local queue that have not
 *              entered transport, e.g. because drain() stops at a saturated
 *              settlement plane (it never aborts claimed, prepared, leased
 *              work: the envelope stays queued with its exact lease)
 *
 * Before the fix only published envelopes were renewed. Under settlement
 * backpressure longer than a lease, every queued envelope's lease expired;
 * the runtime's reaper then aborted its registration and requeued the job,
 * so the work was thrown away and re-claimed (attempts + 1 each time, until
 * "Exceeded retry attempts after repeated lost/expired leases").
 *
 * Contract pinned here:
 *   - queued deliveries renew while settlement is backpressured, keep their
 *     exact lease token, are never reaped, and are each sent exactly once
 *     when the pressure lifts (no duplicate provider dispatch);
 *   - published deliveries still renew;
 *   - an expired or replaced lease is never resurrected (the exact-lease
 *     UPDATE: status Processing, same token, lease not yet expired);
 *   - fencing: only lanes this runtime still owns are renewed, and a queued
 *     entry adopted under another fencing token is not;
 *   - paused, stopped or revoked work (an aborted registration, a dropped
 *     lane, a stopping reservoir) is not renewed and is never sent;
 *   - queued work is re-checked in PostgreSQL before it is renewed, because
 *     the local abort is process-local: a pause or kill switch committed by
 *     another cell, or a suppression committed while the envelope waited, is
 *     only in the database. Such work is aborted, not renewed, never sent;
 *   - an inbound STOP (abortRecipient) reaches work adopted from the broker;
 *   - drain() never hands the provider an envelope whose lease is no longer
 *     known to be live (another cell may have reaped and re-claimed it);
 *   - if the re-check fails, published envelopes still renew and queued ones
 *     do not; the failure is a structured lane error and the pass is retried;
 *   - the re-check is split into bounded statements (1,000 envelopes each);
 *   - logging: broker, refill and acknowledgement failures are structured,
 *     rate-limited error lines; the dispatch path writes no per-message INFO
 *     trace.
 *
 * Everything runs against the disposable local database with the in-memory
 * broker and a counting sender; nothing reaches a provider.
 */
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
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
  suppressionsTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import {
  CampaignWorker,
  DatabaseJobQueue,
  RouteTpsLimiter,
  type CampaignJob,
  type ProviderSender,
} from "../src/services/campaign-queue";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { InMemoryPreparedDispatchBroker, type BrokerEnvelope } from "../src/services/campaign-prepared-broker";
import { inFlightRegistry } from "../src/services/campaign-inflight";
import { logger } from "../src/lib/logger";

const LANE_TOKEN = 7;
const OTHER_TOKEN = 6;
const LEASE_MS = 1_500; // renewal interval = max(250, LEASE_MS / 3) = 500 ms
const createdOrganizationIds: number[] = [];
const createdCampaignIds: number[] = [];
const reservoirs: CampaignPhoneReservoir[] = [];

afterEach(async () => {
  for (const reservoir of reservoirs.splice(0)) await reservoir.stop().catch(() => {});
  inFlightRegistry.clear();
  // A Running campaign with claimable jobs would starve later claims (the
  // candidate scan is global): stop every fixture campaign after each test.
  if (createdCampaignIds.length) await db.update(campaignsTable).set({ status: "Cancelled" }).where(inArray(campaignsTable.id, createdCampaignIds));
});
after(async () => {
  if (createdOrganizationIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrganizationIds));
  await pool.end();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (name: string) => `s369-${name}-${process.pid}-${Date.now()}`;

/** One Running campaign with `count` jobs on one phone. */
async function fixture(name: string, count: number, options: { bulk?: boolean; tps?: number } = {}) {
  const tps = options.tps ?? 1_000;
  const s = slug(name);
  const [organization] = await db.insert(organizationsTable).values({ name: s, slug: s }).returning();
  createdOrganizationIds.push(organization!.id);
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
  createdCampaignIds.push(campaign!.id);
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone!.id,
    templateId: template!.id, configuredTps: tps, queueDepth: count,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id,
    component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total: count, valid: count, queued: count });
  if (options.bulk) {
    const contacts = await db.insert(campaignContactsTable).values(Array.from({ length: count }, (_, index) => ({
      organizationId: organization!.id, campaignId: campaign!.id, rowNumber: index + 1,
      rawPhone: phone!.phone, normalizedPhone: phone!.phone, data: { phone: phone!.phone },
      status: "Valid" as const, partitionKey: 1, routeId: route!.id, idempotencyKey: `${s}-c${index}`,
    }))).returning({ id: campaignContactsTable.id });
    await db.insert(campaignJobsTable).values(contacts.map((contact, index) => ({
      organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id, contactId: contact.id,
      type: "ResolveTemplateAndSend" as const, idempotencyKey: `${s}-j${index}`, attempts: 0, maxAttempts: 5,
    })));
    return { organization: organization!, phone: phone!, campaign: campaign! };
  }
  for (let index = 0; index < count; index += 1) {
    const [contact] = await db.insert(campaignContactsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, rowNumber: index + 1,
      rawPhone: phone!.phone, normalizedPhone: phone!.phone, data: { phone: phone!.phone },
      status: "Valid", partitionKey: 1, routeId: route!.id, idempotencyKey: `${s}-c${index}`,
    }).returning();
    await db.insert(campaignJobsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id, contactId: contact!.id,
      type: "ResolveTemplateAndSend", idempotencyKey: `${s}-j${index}`, attempts: 0, maxAttempts: 5,
    });
  }
  return { organization: organization!, phone: phone!, campaign: campaign! };
}

class CountingSender implements ProviderSender {
  readonly sent: string[] = [];
  async send(_job: unknown, options: { idempotencyKey: string }) {
    this.sent.push(options.idempotencyKey);
    return { providerMessageId: `mock-${options.idempotencyKey}` };
  }
}

/**
 * A counting sender that prepares a per-recipient context and uses the
 * production recipient binding and batch suppression lookup
 * (WhatsAppTemplateSender; both are stateless, database-only methods).
 */
class RecipientCountingSender extends CountingSender {
  static recipientOf(job: Pick<CampaignJob, "contactId">): string {
    return `+1999${String(job.contactId).padStart(8, "0")}`;
  }
  async prepareBatch(jobs: CampaignJob[]): Promise<Map<number, unknown>> {
    return new Map(jobs.map((job) => [job.id, {
      jobId: job.id, organizationId: job.organizationId, recipient: RecipientCountingSender.recipientOf(job),
    }]));
  }
  preparedRecipient(context: unknown) {
    return WhatsAppTemplateSender.prototype.preparedRecipient.call(this, context);
  }
  validatePreparedBatch(items: ReadonlyArray<{ jobId: number; preparedContext: unknown }>) {
    return WhatsAppTemplateSender.prototype.validatePreparedBatch.call(this, items);
  }
}

function harness(
  f: Awaited<ReturnType<typeof fixture>>,
  count: number,
  sender: CountingSender = new CountingSender(),
  leaseMs = LEASE_MS,
) {
  const broker = new InMemoryPreparedDispatchBroker();
  const queue = new DatabaseJobQueue();
  const worker = new CampaignWorker(queue, sender, new RouteTpsLimiter(), `s369-${Date.now()}`, leaseMs);
  const coordinator = {
    async ensurePhoneOwnership() {
      return { owned: true, fencingToken: LANE_TOKEN, validUntilMs: Date.now() + 60_000, coordinationLatencyMs: 0 };
    },
    async releasePhoneOwnership() {},
  };
  const reservoir = new CampaignPhoneReservoir(worker, 64, coordinator as any, "s369-owner", 16_384, undefined, broker, 60_000);
  reservoirs.push(reservoir);
  const lane: Record<string, any> = {
    organizationId: f.organization.id, phoneNumberId: f.phone.id, sendingCredentialId: null, ownerId: "s369-owner", shardId: 0,
    fencingToken: LANE_TOKEN, ownershipValidUntilMs: Date.now() + 60_000, coordinationLatencyMs: 0,
    capacity: 64, lowWater: 32, highWater: 64, queued: 0, reserved: 0, providerInFlight: 0,
    refilling: false, refillDurationMs: 0, emptyDelayMs: 0, brokerDepth: 0, brokerConsumerLag: 0,
    queue: [], draining: false, sourceEmptyUntil: 0, sourceEmptyBackoffMs: 0, nextRecoveryAt: Number.MAX_SAFE_INTEGER,
    nextMetricsAt: Number.MAX_SAFE_INTEGER, pendingAckIds: [], ackInFlight: 0, ackRetryDelayMs: 0, nextAckRetryAt: 0,
    ackFlush: undefined, ackFlushTimer: undefined, published: new Map(), nextLeaseRenewalAt: 0,
  };
  (reservoir as any).lanes.set(f.phone.id, lane);
  // Settlement backpressure switch: drain() takes a settlement slot before an
  // envelope leaves its lane, so a refused slot keeps the envelope queued.
  let backpressure = false;
  const reserve = worker.tryReserveSettlementSlot.bind(worker);
  worker.tryReserveSettlementSlot = () => (backpressure ? false : reserve());
  // Every exact-lease renewal UPDATE, published or queued, goes through here:
  // one entry per statement, holding the number of leases it was offered.
  let renewCalls: number[] = [];
  const renew = queue.renewBrokerLeasesReturning.bind(queue);
  queue.renewBrokerLeasesReturning = async (leases, leaseMs) => {
    renewCalls.push(leases.length);
    return renew(leases, leaseMs);
  };
  return {
    sender, broker, worker, reservoir, lane,
    setBackpressure(on: boolean) { backpressure = on; },
    renewCalls: () => renewCalls,
    resetRenewCalls() { renewCalls = []; },
    /** The production supply path through publication, as runRefill does it (publish + lane.published). */
    async publish(): Promise<BrokerEnvelope[]> {
      const staged: BrokerEnvelope[] = [];
      for (let round = 0; round < 200 && staged.length < count; round += 1) {
        const claimed = await worker.claimPhoneBatch(f.phone.id, Math.min(256, count - staged.length));
        if (!claimed.length) { await sleep(10); continue; }
        const prepared = await worker.prepareReservoirBatch(claimed);
        await broker.publish(f.phone.id, LANE_TOKEN, prepared.map(({ job, preparedContext }) => ({ job, preparedContext })));
        for (const envelope of prepared) {
          const brokerEnvelope = worker.handoffPreparedEnvelope(envelope);
          lane.published.set(`${brokerEnvelope.job.id}:${brokerEnvelope.job.leaseToken ?? ""}`, brokerEnvelope);
          staged.push(brokerEnvelope);
        }
        lane.brokerDepth += prepared.length;
      }
      assert.equal(staged.length, count, "every job must be claimed, prepared and published");
      return staged;
    },
    consume: () => (reservoir as any).consume(lane) as Promise<void>,
    drain: () => (reservoir as any).drain(lane) as void,
  };
}

const jobRows = (campaignId: number) =>
  db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(campaignJobsTable.id);
/** The runtime's own expired-lease reaper (it uses no runtime state). */
const reap = () => (CampaignRuntime.prototype as any).reapExpiredLeases.call({}, new Date()) as Promise<void>;
/** What the runtime's maintenance tick does every pass: reap expired leases, then renew. */
async function maintain(reservoir: CampaignPhoneReservoir, forMs: number) {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await reap();
    await reservoir.renewPublishedLeases();
    await sleep(100);
  }
}

test("queued deliveries renew while settlement is backpressured; each is sent exactly once when it lifts", async () => {
  const COUNT = 6;
  const f = await fixture("queued", COUNT);
  const h = harness(f, COUNT);
  const staged = await h.publish();
  const tokens = new Map(staged.map((e) => [e.job.id, e.job.leaseToken]));
  h.setBackpressure(true);
  await h.consume();
  h.drain();
  assert.equal(h.lane.queue.length, COUNT, "backpressure keeps every consumed envelope queued");
  assert.equal(h.lane.published.size, 0, "consumed envelopes are no longer published");
  assert.equal(h.sender.sent.length, 0);

  // Three lease lifetimes under backpressure, with the reaper running as the
  // runtime does. Without queued renewal every lease expires and is reaped.
  await maintain(h.reservoir, LEASE_MS * 3);
  const held = await jobRows(f.campaign.id);
  for (const row of held) {
    assert.equal(row.status, "Processing", `job ${row.id} must still be held, never reaped`);
    assert.equal(row.leaseToken, tokens.get(row.id), "the exact lease token is kept");
    assert.equal(row.attempts, 1, "never re-claimed");
    assert.ok(row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now(), `job ${row.id} lease must be live`);
  }
  assert.ok(h.lane.queue.every((entry: any) => !entry.envelope.registration.signal.aborted), "no queued registration was aborted");
  for (const entry of h.lane.queue as any[]) {
    assert.equal(entry.leaseValidUntilMs, held.find((row) => row.id === entry.envelope.job.id)!.leaseExpiresAt!.getTime(),
      "the lane's transport-time bound is the expiry the renewal returned, not a stale read");
  }

  const info = logger.info.bind(logger);
  const infoLines: unknown[] = [];
  (logger as any).info = (...args: unknown[]) => { infoLines.push(args); };
  try {
    h.setBackpressure(false);
    h.drain();
    await h.worker.waitForIdle(10_000);
    for (let i = 0; i < 100 && (await jobRows(f.campaign.id)).some((row) => row.status !== "Sent"); i += 1) await sleep(50);
  } finally {
    (logger as any).info = info;
  }
  assert.equal(infoLines.length, 0, `dispatch must write no per-message INFO trace, got ${JSON.stringify(infoLines).slice(0, 300)}`);
  const done = await jobRows(f.campaign.id);
  assert.deepEqual(done.map((row) => row.status), Array(COUNT).fill("Sent"));
  assert.equal(h.sender.sent.length, COUNT, "each job reaches the provider once");
  assert.equal(new Set(h.sender.sent).size, COUNT, "no duplicate provider dispatch");
});

test("published deliveries still renew", async () => {
  const f = await fixture("published", 3);
  const h = harness(f, 3);
  const staged = await h.publish();
  const before = new Map((await jobRows(f.campaign.id)).map((row) => [row.id, row.leaseExpiresAt!.getTime()]));
  await sleep(600);
  await h.reservoir.renewPublishedLeases();
  for (const row of await jobRows(f.campaign.id)) {
    assert.equal(row.status, "Processing");
    assert.equal(row.leaseToken, staged.find((e) => e.job.id === row.id)!.job.leaseToken);
    assert.ok(row.leaseExpiresAt!.getTime() > before.get(row.id)!, `published job ${row.id} lease must be extended`);
  }
  assert.deepEqual(h.renewCalls(), [3]);
});

test("expired and replaced leases are never resurrected", async () => {
  const f = await fixture("expired", 3);
  const h = harness(f, 3);
  await h.publish();
  h.setBackpressure(true);
  await h.consume();
  assert.equal(h.lane.queue.length, 3);
  const [expired, replaced, live] = await jobRows(f.campaign.id);
  const past = new Date(Date.now() - 60_000);
  await db.update(campaignJobsTable).set({ leaseExpiresAt: past }).where(eq(campaignJobsTable.id, expired!.id));
  await db.update(campaignJobsTable).set({ leaseToken: "replaced-by-another-claim" }).where(eq(campaignJobsTable.id, replaced!.id));
  await sleep(600);
  const beforeRenewal = new Map((await jobRows(f.campaign.id)).map((row) => [row.id, row.leaseExpiresAt!.getTime()]));
  h.resetRenewCalls();
  await h.reservoir.renewPublishedLeases();
  const rows = new Map((await jobRows(f.campaign.id)).map((row) => [row.id, row]));
  assert.equal(rows.get(expired!.id)!.leaseExpiresAt!.getTime(), past.getTime(), "an expired lease stays expired");
  assert.equal(rows.get(replaced!.id)!.leaseToken, "replaced-by-another-claim", "the replacement keeps its token");
  assert.equal(rows.get(replaced!.id)!.leaseExpiresAt!.getTime(), beforeRenewal.get(replaced!.id), "the old token cannot extend the replacement's lease");
  assert.ok(rows.get(live!.id)!.leaseExpiresAt!.getTime() > beforeRenewal.get(live!.id)!, "the live queued lease is extended by this pass");
  assert.deepEqual(h.renewCalls(), [1], "only the live entry is offered for renewal");
  const byJob = new Map(h.lane.queue.map((entry: any) => [entry.envelope.job.id, entry.envelope.registration.signal.aborted]));
  assert.deepEqual([byJob.get(expired!.id), byJob.get(replaced!.id), byJob.get(live!.id)], [true, true, false],
    "the expired and replaced entries are revoked locally; the live one is not");

  h.setBackpressure(false);
  h.drain();
  await h.worker.waitForIdle(10_000);
  for (let i = 0; i < 100 && (await jobRows(f.campaign.id)).find((row) => row.id === live!.id)!.status !== "Sent"; i += 1) await sleep(50);
  assert.deepEqual(h.sender.sent, [live!.idempotencyKey], "only the live lease reaches the provider, once");
  const settled = new Map((await jobRows(f.campaign.id)).map((row) => [row.id, row]));
  assert.equal(settled.get(replaced!.id)!.leaseToken, "replaced-by-another-claim", "the revoked copy cannot settle the replacement");
  assert.equal(settled.get(replaced!.id)!.status, "Processing");
});

test("fencing: a lane whose ownership lapsed, or a queued entry adopted under another token, is not renewed", async () => {
  const f = await fixture("fencing", 2);
  const h = harness(f, 2);
  await h.publish();
  h.setBackpressure(true);
  await h.consume();
  assert.equal(h.lane.queue.length, 2);
  // An entry carrying another fencing token (never queued by consume, which
  // marks it stale; injected here to pin the guard).
  h.lane.queue[1].delivery = { ...h.lane.queue[1].delivery, fencingToken: OTHER_TOKEN };
  h.resetRenewCalls();
  await sleep(600);
  await h.reservoir.renewPublishedLeases();
  assert.deepEqual(h.renewCalls(), [1], "only the entry adopted under the lane's own token is renewed");

  h.lane.ownershipValidUntilMs = Date.now() - 1;
  h.lane.nextLeaseRenewalAt = 0;
  h.resetRenewCalls();
  await h.reservoir.renewPublishedLeases();
  assert.deepEqual(h.renewCalls(), [], "a lane whose ownership lapsed renews nothing");
});

test("paused or revoked work is not renewed and never sent", async () => {
  const f = await fixture("paused", 3);
  const h = harness(f, 3);
  await h.publish();
  h.setBackpressure(true);
  await h.consume();
  assert.equal(h.lane.queue.length, 3);
  // What the pause action does (campaign-engine.ts): status Paused, then
  // abort the campaign's in-flight registrations (revoked work).
  await db.update(campaignsTable).set({ status: "Paused" }).where(eq(campaignsTable.id, f.campaign.id));
  inFlightRegistry.abortCampaign(f.campaign.id, "Campaign pause");
  const before = new Map((await jobRows(f.campaign.id)).map((row) => [row.id, row.leaseExpiresAt!.getTime()]));
  h.resetRenewCalls();
  await sleep(600);
  await h.reservoir.renewPublishedLeases();
  assert.deepEqual(h.renewCalls(), [], "aborted registrations are not renewed");
  for (const row of await jobRows(f.campaign.id)) assert.equal(row.leaseExpiresAt!.getTime(), before.get(row.id), "lease untouched");

  h.setBackpressure(false);
  h.drain();
  await h.worker.waitForIdle(10_000);
  for (let i = 0; i < 100 && h.lane.providerInFlight > 0; i += 1) await sleep(20);
  assert.equal(h.sender.sent.length, 0, "paused work never reaches the provider");
  for (const row of await jobRows(f.campaign.id)) {
    assert.equal(row.status, "Queued", `job ${row.id} is requeued for after resume, not sent or failed`);
    assert.equal(row.leaseToken, null);
  }
});

test("stopped work (dropped lane, stopping reservoir) is not renewed and never sent", async () => {
  const f = await fixture("stopped", 4);
  const h = harness(f, 4);
  await h.publish();
  h.setBackpressure(true);
  await h.consume();
  assert.equal(h.lane.queue.length, 4);

  // Lane dropped (ownership lost, campaign stopped, credential revoked):
  // its queued work is discarded and no longer renewed.
  await (h.reservoir as any).dropLane(h.lane, false);
  h.resetRenewCalls();
  await h.reservoir.renewPublishedLeases();
  assert.deepEqual(h.renewCalls(), [], "a dropped lane renews nothing");
  assert.equal(h.lane.queue.length, 0);
  for (const row of await jobRows(f.campaign.id)) assert.equal(row.status, "Queued", "discarded work is requeued, never sent");

  // A stopping reservoir renews nothing.
  const g = await fixture("stopping", 2);
  const k = harness(g, 2);
  await k.publish();
  k.setBackpressure(true);
  await k.consume();
  await k.reservoir.stop();
  k.resetRenewCalls();
  await k.reservoir.renewPublishedLeases();
  assert.deepEqual(k.renewCalls(), [], "a stopping reservoir renews nothing");
  assert.equal(h.sender.sent.length + k.sender.sent.length, 0, "stopped work never reaches the provider");
});

// Phase 0 (docs/CROSS_CELL_DISPATCH_AUTHORIZATION.md): an envelope published but never consumed was never
// handed to the provider. Before Phase 0 a lane drop or a stop left its lease to expire, the reaper requeued
// it with its intent still pending, and re-preparation then failed it for manual reconciliation.
test("envelopes published but never consumed when a lane drops or the runtime stops are requeued as not started", async () => {
  const f = await fixture("unconsumed-drop", 3);
  const h = harness(f, 3);
  const staged = await h.publish();
  for (const row of await jobRows(f.campaign.id)) assert.deepEqual([row.status, row.attempts], ["Processing", 1]);
  await (h.reservoir as any).dropLane(h.lane, false);
  assert.equal(h.lane.published.size, 0);
  for (const row of await jobRows(f.campaign.id)) {
    assert.deepEqual([row.status, row.leaseToken, row.attempts], ["Queued", null, 0], `job ${row.id}: requeued, its attempt returned`);
  }

  // The stale deliveries are still in the broker. The phone's next lane re-claims the jobs under new leases;
  // consuming the stale deliveries discards them under their own old lease and never touches the new one.
  (h.reservoir as any).lanes.set(f.phone.id, h.lane);
  const fresh = await h.publish();
  const freshTokens = new Map(fresh.map((envelope) => [envelope.job.id, envelope.job.leaseToken]));
  assert.ok(staged.every((envelope) => freshTokens.get(envelope.job.id) !== envelope.job.leaseToken));
  await h.consume();
  await h.consume();
  assert.equal(h.lane.queue.length, 3, "only the fresh deliveries are adopted");
  assert.ok(h.lane.queue.every((entry: any) => freshTokens.get(entry.envelope.job.id) === entry.envelope.job.leaseToken));
  h.drain();
  await h.worker.waitForIdle(5_000);
  for (const row of await jobRows(f.campaign.id)) assert.deepEqual([row.status, row.attempts], ["Sent", 1], `job ${row.id}`);
  assert.equal(new Set(h.sender.sent).size, 3);
  assert.equal(h.sender.sent.length, 3, "each job is sent exactly once");

  const g = await fixture("unconsumed-stop", 2);
  const k = harness(g, 2);
  await k.publish();
  await k.reservoir.stop();
  for (const row of await jobRows(g.campaign.id)) {
    assert.deepEqual([row.status, row.leaseToken, row.attempts], ["Queued", null, 0], `job ${row.id}: requeued at stop, its attempt returned`);
  }
  assert.equal(k.sender.sent.length, 0);
});

test("broker, refill and acknowledgement failures are structured, rate-limited error logs", async () => {
  const errors: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const original = logger.error.bind(logger);
  (logger as any).error = (fields: Record<string, unknown>, message: string) => { errors.push({ fields, message }); };
  try {
    const failing = new Error("simulated broker outage");
    const broker = {
      async publish() {}, async consume() { throw failing; }, async reclaimAbandoned() { return { deliveries: [], cursor: "0-0" }; },
      async acknowledge() { throw new Error("simulated XACK failure"); },
      async metrics() { return { depth: 0, pending: 0, consumerLag: 0 }; }, async close() {},
    };
    const worker = {
      brokerLeaseRenewalIntervalMs: 500,
      async claimPhoneBatch() { throw new Error("simulated claim failure"); },
      async prepareReservoirBatch() { return []; }, async nextPhoneSupplyDueInMs() { return undefined; },
      tryReserveSettlementSlot() { return false; }, settlementSlotCapacity() { return 64; },
      async renewBrokerLeases() { return 0; }, revokeTransportOwnership() {}, updateTransportOwnership() {},
      transportShardForPhone() { return 0; }, async discardReservoirEnvelope() {},
    };
    const coordinator = { async releasePhoneOwnership() {} };
    const reservoir = new CampaignPhoneReservoir(worker as any, 8, coordinator as any, "s369-logs", 16_384, undefined, broker as any, 60_000) as any;
    const lane = {
      organizationId: 1, phoneNumberId: 424242, sendingCredentialId: null, ownerId: "s369-logs", shardId: 0, fencingToken: 3,
      ownershipValidUntilMs: Date.now() + 60_000, coordinationLatencyMs: 0, capacity: 8, lowWater: 4, highWater: 8,
      queued: 0, reserved: 0, providerInFlight: 0, refilling: false, refillDurationMs: 0, emptyDelayMs: 0,
      brokerDepth: 0, brokerConsumerLag: 0, queue: [], draining: false, sourceEmptyUntil: 0, sourceEmptyBackoffMs: 0,
      nextRecoveryAt: Number.MAX_SAFE_INTEGER, nextMetricsAt: Number.MAX_SAFE_INTEGER, pendingAckIds: ["1-0"], ackInFlight: 0,
      ackRetryDelayMs: 0, nextAckRetryAt: 0, ackFlush: undefined, ackFlushTimer: undefined, published: new Map(), nextLeaseRenewalAt: 0,
    };
    reservoir.lanes.set(lane.phoneNumberId, lane);
    // A broker outage fails every service pass; 50 passes write ONE line.
    for (let pass = 0; pass < 50; pass += 1) {
      reservoir.service(lane);
      await lane.service;
    }
    // The consume failure above ends the pass before a refill is requested;
    // request one directly (the next healthy pass would): its claim fails.
    reservoir.refillIfNeeded(lane);
    await lane.refill;
    await reservoir.flushAcks(lane);
    clearTimeout(lane.ackFlushTimer);
    lane.ackFlushTimer = undefined;
    const byKind = (kind: string) => errors.filter((entry) => entry.fields.kind === kind);
    assert.equal(byKind("service").length, 1, "one service failure line per window, not one per pass");
    assert.equal(reservoir.failureLog.get(`${lane.phoneNumberId}:${lane.fencingToken}:service`).repeats, 49, "the repeats are counted for the next line");
    assert.equal(byKind("refill").length, 1);
    assert.equal(byKind("ack").length, 1);
    for (const entry of errors) {
      assert.equal(entry.fields.phoneNumberId, lane.phoneNumberId);
      assert.equal(entry.fields.organizationId, 1);
      assert.equal(entry.fields.fencingToken, 3);
      assert.ok(entry.fields.error instanceof Error, "the error goes through the logger's scrubbing serializer");
      assert.equal(typeof entry.message, "string");
    }
    lane.pendingAckIds = [];
    await reservoir.dropLane(lane, false);
    assert.equal([...reservoir.failureLog.keys()].filter((key: string) => key.startsWith(`${lane.phoneNumberId}:`)).length, 0,
      "a dropped lane forgets its rate-limit state");
    // A pass already running on the dropped lane fails afterwards and
    // re-inserts an entry; it is pruned once its window is over.
    reservoir.logLaneFailure(lane, "ack", new Error("late failure after the drop"));
    const deadKey = `${lane.phoneNumberId}:${lane.fencingToken}:ack`;
    assert.ok(reservoir.failureLog.has(deadKey));
    reservoir.failureLog.get(deadKey).lastAt -= 31_000;
    const live = { ...lane, phoneNumberId: 434343, fencingToken: 4 };
    reservoir.lanes.set(live.phoneNumberId, live);
    reservoir.logLaneFailure(live, "service", new Error("another lane fails"));
    assert.ok(!reservoir.failureLog.has(deadKey), "a gone lane's entry is pruned");
    assert.ok(reservoir.failureLog.has("434343:4:service"), "a live lane's entry is kept");
    reservoir.lanes.delete(live.phoneNumberId);
    await reservoir.stop();
  } finally {
    (logger as any).error = original;
  }
});

test("a pause or kill switch committed by another cell stops renewal of queued work, which is never sent", async () => {
  // Database only: no inFlightRegistry.abortCampaign, because the action was
  // served by the other cell. The lane stays alive (it is not rediscovered).
  for (const change of [{ status: "Paused" as const }, { killSwitch: true }]) {
    const f = await fixture(`remote-${Object.keys(change)[0]}`, 3);
    const h = harness(f, 3);
    await h.publish();
    h.setBackpressure(true);
    await h.consume();
    assert.equal(h.lane.queue.length, 3);
    await db.update(campaignsTable).set(change).where(eq(campaignsTable.id, f.campaign.id));
    await sleep(600);
    const before = new Map((await jobRows(f.campaign.id)).map((row) => [row.id, row.leaseExpiresAt!.getTime()]));
    h.resetRenewCalls();
    await h.reservoir.renewPublishedLeases();
    assert.deepEqual(h.renewCalls(), [], `${JSON.stringify(change)}: no queued lease is offered for renewal`);
    for (const row of await jobRows(f.campaign.id)) assert.equal(row.leaseExpiresAt!.getTime(), before.get(row.id), "lease untouched");
    assert.ok(h.lane.queue.every((entry: any) => entry.envelope.registration.signal.aborted), "every queued registration is revoked");

    h.setBackpressure(false);
    h.drain();
    await h.worker.waitForIdle(10_000);
    for (let i = 0; i < 100 && h.lane.providerInFlight > 0; i += 1) await sleep(20);
    assert.equal(h.sender.sent.length, 0, `${JSON.stringify(change)}: nothing reaches the provider`);
    const expected = "killSwitch" in change ? "Cancelled" : "Queued";
    for (const row of await jobRows(f.campaign.id)) {
      assert.equal(row.status, expected, `job ${row.id}: settled as aborted (${expected}), not sent`);
      assert.equal(row.leaseToken, null);
    }
  }
});

test("a suppression committed while work is queued stops its renewal and its send; other recipients continue", async () => {
  const f = await fixture("suppressed", 3);
  const h = harness(f, 3, new RecipientCountingSender());
  await h.publish();
  h.setBackpressure(true);
  await h.consume();
  assert.equal(h.lane.queue.length, 3);
  const [target] = await jobRows(f.campaign.id);
  // Only the database row: no inFlightRegistry.abortRecipient (another cell
  // took the STOP, or it was an import of opt-outs).
  await db.insert(suppressionsTable).values({
    organizationId: f.organization.id, normalizedPhone: RecipientCountingSender.recipientOf(target!), reason: "Unsubscribed",
  });
  await sleep(600);
  h.resetRenewCalls();
  await h.reservoir.renewPublishedLeases();
  assert.deepEqual(h.renewCalls(), [2], "the suppressed recipient's lease is not renewed; the other two are");
  const aborted = h.lane.queue.filter((entry: any) => entry.envelope.registration.signal.aborted).map((entry: any) => entry.envelope.job.id);
  assert.deepEqual(aborted, [target!.id]);

  h.setBackpressure(false);
  h.drain();
  await h.worker.waitForIdle(10_000);
  for (let i = 0; i < 100 && (await jobRows(f.campaign.id)).filter((row) => row.status === "Sent").length < 2; i += 1) await sleep(50);
  const rows = await jobRows(f.campaign.id);
  assert.equal(h.sender.sent.length, 2);
  assert.ok(!h.sender.sent.includes(target!.idempotencyKey), "the suppressed recipient is never sent to");
  assert.equal(new Set(h.sender.sent).size, 2, "no duplicate provider dispatch");
  assert.equal(rows.find((row) => row.id === target!.id)!.status, "Queued", "requeued; preparation screens it again");
});

test("an inbound STOP reaches work adopted from the broker while it waits in the lane queue", async () => {
  const f = await fixture("stop", 2);
  const h = harness(f, 2, new RecipientCountingSender());
  await h.publish();
  h.setBackpressure(true);
  await h.consume();
  assert.equal(h.lane.queue.length, 2);
  const [target] = await jobRows(f.campaign.id);
  // What the webhook does on STOP (whatsapp-webhook.ts) besides inserting the
  // suppression row: abort in-flight work for that recipient.
  const reached = inFlightRegistry.abortRecipient(f.organization.id, RecipientCountingSender.recipientOf(target!), "Recipient opted out");
  assert.equal(reached, 1, "the adopted registration carries its recipient");
  h.resetRenewCalls();
  await sleep(600);
  await h.reservoir.renewPublishedLeases();
  assert.deepEqual(h.renewCalls(), [1], "the stopped recipient is not renewed");
  h.setBackpressure(false);
  h.drain();
  await h.worker.waitForIdle(10_000);
  for (let i = 0; i < 100 && h.sender.sent.length < 1; i += 1) await sleep(50);
  for (let i = 0; i < 40 && h.lane.providerInFlight > 0; i += 1) await sleep(20);
  assert.equal(h.sender.sent.length, 1);
  assert.ok(!h.sender.sent.includes(target!.idempotencyKey), "the stopped recipient is never sent to");
});

test("drain never hands the provider an envelope whose lease lapsed, even before a renewal pass notices", async () => {
  const f = await fixture("lapsed", 2);
  const h = harness(f, 2);
  await h.publish();
  h.setBackpressure(true);
  await h.consume();
  assert.equal(h.lane.queue.length, 2);
  // No renewal runs (the database was unreachable, say) and the leases lapse.
  await sleep(LEASE_MS + 300);
  // Another cell's reaper requeues the jobs; it cannot reach this process's
  // in-flight registry, so the local registrations stay unaborted. (A later
  // availableAt keeps this lane's own refill from re-claiming them during
  // the test, so only the queued copies are in play.)
  await db.update(campaignJobsTable).set({
    status: "Queued", leaseToken: null, leaseExpiresAt: null, lockedAt: null, lockedBy: null,
    availableAt: new Date(Date.now() + 3_600_000),
  }).where(and(eq(campaignJobsTable.campaignId, f.campaign.id), eq(campaignJobsTable.status, "Processing")));
  const entries = [...h.lane.queue] as any[];
  assert.ok(entries.every((entry) => !entry.envelope.registration.signal.aborted));
  h.setBackpressure(false);
  h.drain();
  await h.worker.waitForIdle(10_000);
  for (let i = 0; i < 100 && h.lane.providerInFlight > 0; i += 1) await sleep(20);
  assert.equal(h.sender.sent.length, 0, "a lapsed lease never reaches the provider (it may already be re-claimed)");
  for (const entry of entries) {
    assert.equal(entry.envelope.registration.signal.reason?.message, "Campaign lease expired before transport");
  }
  for (const row of await jobRows(f.campaign.id)) {
    assert.equal(row.status, "Queued", "the fenced abort settlement leaves the other cell's requeue untouched");
  }
});

test("drain fails closed on an unusable lease bound", async () => {
  const f = await fixture("nan-bound", 1);
  const h = harness(f, 1);
  await h.publish();
  h.setBackpressure(true);
  await h.consume();
  assert.equal(h.lane.queue.length, 1);
  const entry = h.lane.queue[0] as any;
  entry.leaseValidUntilMs = Number.NaN;
  h.setBackpressure(false);
  h.drain();
  await h.worker.waitForIdle(10_000);
  for (let i = 0; i < 100 && h.lane.providerInFlight > 0; i += 1) await sleep(20);
  assert.equal(h.sender.sent.length, 0, "an envelope whose lease is not known to be live is never sent");
  assert.equal(entry.envelope.registration.signal.reason?.message, "Campaign lease expired before transport");
});

test("if the queued re-check fails, published envelopes still renew, queued ones do not, and the failure is a lane error", async () => {
  const f = await fixture("check-fails", 3);
  const h = harness(f, 3);
  await h.publish();
  h.setBackpressure(true);
  h.lane.capacity = 2; // consume two; one stays published
  await h.consume();
  assert.equal(h.lane.queue.length, 2);
  assert.equal(h.lane.published.size, 1);
  (h.worker as any).renewQueuedReservoirLeases = async () => { throw new Error("simulated database outage"); };
  await sleep(600);
  const before = new Map((await jobRows(f.campaign.id)).map((row) => [row.id, row.leaseExpiresAt!.getTime()]));
  h.resetRenewCalls();
  const errors: Array<Record<string, unknown>> = [];
  const original = logger.error.bind(logger);
  (logger as any).error = (fields: Record<string, unknown>) => { errors.push(fields); };
  try {
    await h.reservoir.renewPublishedLeases(); // contained: housekeeping's remaining work still runs
  } finally {
    (logger as any).error = original;
  }
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.kind, "renewal");
  assert.equal(errors[0]!.phoneNumberId, f.phone.id);
  assert.match(String((errors[0]!.error as Error).message), /simulated database outage/);
  assert.deepEqual(h.renewCalls(), [1], "only the published envelope is renewed");
  const publishedId = [...h.lane.published.values()][0].job.id;
  for (const row of await jobRows(f.campaign.id)) {
    if (row.id === publishedId) assert.ok(row.leaseExpiresAt!.getTime() > before.get(row.id)!, "published lease extended");
    else assert.equal(row.leaseExpiresAt!.getTime(), before.get(row.id), "unverified queued lease untouched");
  }
  assert.equal(h.lane.nextLeaseRenewalAt, 0, "the pass is retried on the next tick");
});

test("the queued re-check and renewal run in bounded statements", async () => {
  const COUNT = 1_001; // one more than a chunk
  // The production 30 s lease: staging 1,001 envelopes takes longer than the
  // short lease the other tests use.
  const f = await fixture("chunked", COUNT, { bulk: true, tps: 5_000 });
  const h = harness(f, COUNT, new CountingSender(), 30_000);
  h.lane.capacity = 2_048;
  await h.publish();
  h.setBackpressure(true);
  while (h.lane.published.size) await h.consume();
  assert.equal(h.lane.queue.length, COUNT);
  await sleep(100);
  const before = new Map((await jobRows(f.campaign.id)).map((row) => [row.id, row.leaseExpiresAt!.getTime()]));
  h.lane.nextLeaseRenewalAt = 0;
  h.resetRenewCalls();
  await h.reservoir.renewPublishedLeases();
  assert.deepEqual(h.renewCalls(), [1_000, 1], "1,000 envelopes per statement group");
  const rows = await jobRows(f.campaign.id);
  assert.ok(rows.every((row) => row.status === "Processing" && row.leaseExpiresAt!.getTime() > before.get(row.id)!),
    "every queued lease is renewed");
  assert.ok(h.lane.queue.every((entry: any) => !entry.envelope.registration.signal.aborted));
});
