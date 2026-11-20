/*
 * B13 remediation regressions (evidence/B13-DIAGNOSTICS-T1-T2.md, R1-R3). Each test reproduces a failure
 * measured on release 2884382f and must pass after the fix. Production path: the real CampaignWorker and the
 * WhatsApp template sender in a mock workspace with real durable intents; mock sends only, observed through
 * CAMPAIGN_TEST_PROVIDER_LOG.
 *
 *   R1a  outcome backpressure at preparation arms no intent and returns the claim's attempt, so the work is
 *        later prepared and sent exactly once. On 2884382f the intents were committed before the capacity check,
 *        the batch was requeued with them still pending, and re-preparation failed every job for manual
 *        reconciliation although nothing had been sent (0.3-2.6% of a no-fault run, in batches of 256).
 *   R1b  a lane with no preparation headroom does not claim at all, and does not park itself as source-empty.
 *   R2   a dead owner's deferred (still-leased) deliveries do not count as the new lane's ready supply: the lane
 *        refills fresh work at once instead of waiting ~30 s for the dead leases to expire; the deferred
 *        deliveries themselves stay pending and are never sent.
 *   R3   a reclaimed delivery whose intent the dead owner had already recorded as sent is settled Sent with that
 *        provider message id, not Failed as delivery-unknown, and is never sent again.
 *   R4   work whose paced slot is not yet due waits in its lane without holding a settlement slot; on 2884382f it
 *        entered transport up to 3 s early and the slot pool sat full at the ceiling (every drain probe refused).
 *   R5   every starvation event is recorded with its phone, start, end and the lane's state when it went empty.
 *   R6   a healthy campaign's campaign_metrics keep advancing while another cell's expired leases are reaped; on
 *        2884382f they froze for the whole reap (6-11 s measured), because deltas were folded only between reaps.
 * Receipt-based duplicate measurement across a real SIGKILL (R7) is campaign-receipt-ledger.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricDeltasTable,
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
import {
  CampaignWorker,
  DatabaseJobQueue,
  RouteTpsLimiter,
  flushAllCampaignMetricDeltas,
  type PreparedCampaignEnvelope,
} from "../src/services/campaign-queue";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import { InMemoryPreparedDispatchBroker, type BrokerEnvelope } from "../src/services/campaign-prepared-broker";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { inFlightRegistry } from "../src/services/campaign-inflight";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";
import { CampaignRuntime } from "../src/services/campaign-runtime";

const workDir = mkdtempSync(path.join(tmpdir(), "b13-remediation-"));
const providerLog = path.join(workDir, "provider.log");
process.env.CAMPAIGN_TEST_PROVIDER_LOG = providerLog;

const organizationIds: number[] = [];
const workers: CampaignWorker[] = [];
after(async () => {
  for (const worker of workers) {
    await worker.waitForIdle(5_000).catch(() => false);
    await worker.closeDispatchScheduler().catch(() => {});
  }
  inFlightRegistry.clear();
  if (organizationIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  rmSync(workDir, { recursive: true, force: true });
  await pool.end();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TPS = 1_000;
const OUTCOME_CAPACITY = 4_096;
const DEAD_TOKEN = 1;
const LANE_TOKEN = 2;
const slug = (name: string) => `b13r-${name}-${process.pid}-${Date.now()}`;

async function fixture(name: string, count: number) {
  const s = slug(name);
  const [organization] = await db.insert(organizationsTable).values({ name: s, slug: s }).returning();
  organizationIds.push(organization!.id);
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${s}-waba`, displayName: s }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization!.id, wabaId: waba!.id, phone: `+1558${organization!.id.toString().padStart(7, "0")}`,
    displayName: s, status: "Connected", tpsLimit: TPS, providerPhoneId: `test-${s}`,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: s, status: "Approved", language: "en_US",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: s, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone!.id, templateId: template!.id, configuredTps: TPS, queueDepth: count,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id, component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total: count, valid: count, queued: count });
  const recipients = Array.from({ length: count }, (_, i) => `+1997${organization!.id.toString().padStart(5, "0")}${i.toString().padStart(4, "0")}`);
  const contacts = await db.insert(campaignContactsTable).values(recipients.map((recipient, i) => ({
    organizationId: organization!.id, campaignId: campaign!.id, rowNumber: i + 1, rawPhone: recipient, normalizedPhone: recipient,
    status: "Valid" as const, partitionKey: 1, routeId: route!.id, idempotencyKey: `${s}-c${i}`, data: {},
  }))).returning({ id: campaignContactsTable.id });
  await db.insert(campaignJobsTable).values(contacts.map((contact, i) => ({
    organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id, contactId: contact.id, templateId: template!.id,
    type: "ResolveTemplateAndSend" as const, idempotencyKey: `${s}-j${i}`, availableAt: new Date(),
  })));
  return { organization: organization!, phone: phone!, campaign: campaign!, recipients };
}

function newWorker(sender = new WhatsAppTemplateSender()) {
  const worker = new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `b13r-${Date.now()}-${Math.random()}`, 30_000);
  workers.push(worker);
  return { worker, sender };
}

/** The sender's own bookkeeping, exactly as OUTCOME_CAPACITY prepared-but-unsettled envelopes leave it. */
function saturateOutcomes(sender: WhatsAppTemplateSender) {
  const reserved = (sender as unknown as { reservedOutcomeJobIds: Set<number> }).reservedOutcomeJobIds;
  for (let i = 1; i <= OUTCOME_CAPACITY; i += 1) reserved.add(-i);
  return () => { for (let i = 1; i <= OUTCOME_CAPACITY; i += 1) reserved.delete(-i); };
}

const sentTo = () => existsSync(providerLog)
  ? readFileSync(providerLog, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { payload: { to: string } }).payload.to)
  : [];
const jobs = (campaignId: number) => db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(campaignJobsTable.id);
const intents = (jobIds: number[]) => db.select().from(providerMessagesTable).where(inArray(providerMessagesTable.campaignJobId, jobIds));

async function claimUntil(worker: CampaignWorker, phoneId: number, count: number) {
  const claimed = [];
  for (let round = 0; round < 100 && claimed.length < count; round += 1) {
    const batch = await worker.claimPhoneBatch(phoneId, count - claimed.length);
    if (!batch.length) { await sleep(20); continue; }
    claimed.push(...batch);
  }
  assert.equal(claimed.length, count, "every job claimed");
  return claimed;
}

async function claimAndPrepare(worker: CampaignWorker, phoneId: number, count: number): Promise<PreparedCampaignEnvelope[]> {
  const envelopes: PreparedCampaignEnvelope[] = [];
  for (let round = 0; round < 200 && envelopes.length < count; round += 1) {
    const claimed = await worker.claimPhoneBatch(phoneId, Math.min(256, count - envelopes.length));
    if (!claimed.length) { await sleep(20); continue; }
    envelopes.push(...await worker.prepareReservoirBatch(claimed));
  }
  assert.equal(envelopes.length, count, "every job claimed and prepared");
  return envelopes;
}

async function settled(campaignId: number, done: (rows: Awaited<ReturnType<typeof jobs>>) => boolean) {
  for (let i = 0; i < 300; i += 1) {
    const rows = await jobs(campaignId);
    if (done(rows)) return rows;
    await sleep(50);
  }
  throw new Error("jobs did not settle");
}

function laneState(organizationId: number, phoneNumberId: number, fencingToken = LANE_TOKEN) {
  return {
    organizationId, phoneNumberId, ownerId: "replacement", shardId: 0,
    fencingToken, ownershipValidUntilMs: Date.now() + 60_000, coordinationLatencyMs: 0,
    capacity: 256, lowWater: 128, highWater: 256, queued: 0, reserved: 0, providerInFlight: 0,
    refilling: false, refillDurationMs: 0, emptyDelayMs: 0, brokerDepth: 0, brokerConsumerLag: 0,
    queue: [], draining: false, sourceEmptyUntil: 0, sourceEmptyBackoffMs: 0, nextRecoveryAt: 0, nextMetricsAt: 0,
    pendingAckIds: [], ackInFlight: 0, ackRetryDelayMs: 0, nextAckRetryAt: 0, ackFlush: undefined,
    ackFlushTimer: undefined, published: new Map(), nextLeaseRenewalAt: 0,
  };
}

/** A lane the reservoir owns (refill and drain act only on lanes in its own map). */
function registeredLane(reservoir: CampaignPhoneReservoir, organizationId: number, phoneNumberId: number) {
  const lane = laneState(organizationId, phoneNumberId);
  (reservoir as unknown as { lanes: Map<number, unknown> }).lanes.set(phoneNumberId, lane);
  return lane;
}

function reservoirFor(worker: CampaignWorker, broker: InMemoryPreparedDispatchBroker) {
  const coordinator = {
    async ensurePhoneOwnership() { return { owned: true, fencingToken: LANE_TOKEN, validUntilMs: Date.now() + 60_000, coordinationLatencyMs: 0 }; },
    async releasePhoneOwnership() {},
  };
  // abandonedDeliveryMs 0: every pending delivery of another consumer is reclaimable at once.
  return new CampaignPhoneReservoir(worker, 256, coordinator as never, "replacement", 16_384, undefined, broker, 0);
}

/** A dead owner's supply: claim -> prepare -> handoff -> publish under its token -> consumed, never acknowledged. */
async function stageDead(worker: CampaignWorker, broker: InMemoryPreparedDispatchBroker, phoneId: number, count: number) {
  const envelopes: BrokerEnvelope[] = [];
  for (const envelope of await claimAndPrepare(worker, phoneId, count)) envelopes.push(worker.handoffPreparedEnvelope(envelope));
  await broker.publish(phoneId, DEAD_TOKEN, envelopes);
  const deliveries = await broker.consume(phoneId, `dead:${DEAD_TOKEN}`, count);
  assert.equal(deliveries.length, count);
  return deliveries;
}

async function bareCampaign(name: string, status: "Running" | "Paused") {
  const s = slug(name);
  const [organization] = await db.insert(organizationsTable).values({ name: s, slug: s }).returning();
  organizationIds.push(organization!.id);
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: s, status }).returning();
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total: 0, valid: 0, queued: 0 });
  return { organization: organization!, campaign: campaign! };
}

/** A worker stand-in for drain(): counts settlement reservations and dispatches, never resolves a dispatch. */
function drainProbe() {
  const probe = { reserved: 0, dispatched: [] as number[] };
  const worker = {
    settlementSlotCapacity: () => OUTCOME_CAPACITY,
    preparationHeadroom: () => Number.POSITIVE_INFINITY,
    tryReserveSettlementSlot: () => { probe.reserved += 1; return true; },
    dispatchReservoirEnvelope: (envelope: { job: { id: number } }) => { probe.dispatched.push(envelope.job.id); return new Promise(() => {}); },
  };
  return { probe, worker: worker as unknown as CampaignWorker };
}

function queued(id: number, scheduledSendAt: Date) {
  return {
    delivery: { id: `d-${id}`, phoneNumberId: 1, fencingToken: LANE_TOKEN, envelope: {} },
    envelope: { job: { id, scheduledSendAt }, registration: { signal: new AbortController().signal, abort() {} } },
    leaseValidUntilMs: Date.now() + 60_000,
  };
}

test("R4 · work not yet due waits in its lane without a settlement slot; only due work enters transport", async () => {
  const { probe, worker } = drainProbe();
  const reservoir = reservoirFor(worker, new InMemoryPreparedDispatchBroker());
  const lane = laneState(1, 1);
  const now = Date.now();
  // Pacing reserves slots up to 3 s ahead: five due now, five due in ~2.5 s.
  const entries = [1, 2, 3, 4, 5].map((id) => queued(id, new Date(now - 5)))
    .concat([6, 7, 8, 9, 10].map((id) => queued(id, new Date(now + 2_500))));
  (lane as unknown as { queue: unknown[] }).queue = entries;
  lane.queued = entries.length;
  (reservoir as unknown as { drain(lane: unknown): void }).drain(lane);
  assert.deepEqual(probe.dispatched, [1, 2, 3, 4, 5], "only work inside the admission horizon is handed to transport");
  assert.equal(probe.reserved, 5, "no settlement slot is held for work that is not due");
  assert.equal(lane.queued, 5, "the rest stays queued in the lane, where its lease is renewed");
  const timer = (lane as { drainTimer?: NodeJS.Timeout }).drainTimer;
  assert.ok(timer, "drain wakes itself when the next envelope comes due");
  clearTimeout(timer);
});

test("R5 · starvation events carry their phone, start, end and the lane's state when it went empty", async () => {
  const { worker } = drainProbe();
  const reservoir = reservoirFor(worker, new InMemoryPreparedDispatchBroker());
  const lane = laneState(1, 42);
  lane.sourceEmptyUntil = Date.now() + 5_000; // parked on the source-empty ladder
  (lane as unknown as { queue: unknown[] }).queue = [queued(1, new Date(Date.now() - 5))];
  lane.queued = 1;
  (reservoir as unknown as { drain(lane: unknown): void }).drain(lane);
  const emptied = lane as unknown as { emptySince?: number; emptyCause?: string };
  assert.ok(emptied.emptySince, "the lane went empty");
  assert.equal(emptied.emptyCause, "source-empty-backoff", "classified at the moment it went empty");

  const before = campaignDispatchMetrics.snapshot();
  campaignDispatchMetrics.reservoirStarvation(120, { phoneNumberId: 42, startedAtMs: 1_000, cause: "source-empty-backoff" });
  const after = campaignDispatchMetrics.snapshot();
  assert.equal(after.reservoirStarvationEvents, before.reservoirStarvationEvents + 1, "the total counts every event, as before");
  assert.equal(after.reservoirStarvationMs, before.reservoirStarvationMs + 120);
  assert.deepEqual(after.reservoirStarvationLog.at(-1), { phoneNumberId: 42, startedAtMs: 1_000, endedAtMs: 1_120, durationMs: 120, cause: "source-empty-backoff" });
  assert.equal(after.reservoirStarvationByCause["source-empty-backoff"]!.events, (before.reservoirStarvationByCause["source-empty-backoff"]?.events ?? 0) + 1);
});

test("R6 · a healthy campaign's metrics keep advancing while another cell's expired leases are reaped", async () => {
  // Enough expired leases that reaping them takes seconds even against a loopback database (a dead cell left
  // ~6,000 against a networked one in B13, and froze the healthy campaign's metrics for 6-11 s).
  const DEAD = 30_000;
  const dead = await bareCampaign("r6-dead", "Paused"); // requeued work stays unclaimable
  const healthy = await bareCampaign("r6-healthy", "Running");
  const expiredAt = new Date(Date.now() - 60_000);
  for (let start = 0; start < DEAD; start += 2_000) {
    await db.insert(campaignJobsTable).values(Array.from({ length: Math.min(2_000, DEAD - start) }, (_, i) => ({
      organizationId: dead.organization.id, campaignId: dead.campaign.id, type: "ResolveTemplateAndSend" as const,
      idempotencyKey: `r6-${start + i}`, status: "Processing", attempts: 1, leaseToken: `dead-lease-${start + i}`,
      lockedBy: "dead-cell", lockedAt: expiredAt, leaseExpiresAt: expiredAt,
    })));
  }
  const runtime = new CampaignRuntime(new WhatsAppTemplateSender(), undefined, { phoneScope: new Set([-1]) });
  runtime.start(100);
  const advances: number[] = [];
  let lastSent = -1;
  let reapedAt: number | undefined;
  const started = Date.now();
  try {
    for (;;) {
      // The healthy cell's settlement keeps producing deltas, as a sending campaign does.
      await db.insert(campaignMetricDeltasTable).values({ organizationId: healthy.organization.id, campaignId: healthy.campaign.id, sentDelta: 10 });
      const [metrics] = await db.select({ sent: campaignMetricsTable.sent }).from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, healthy.campaign.id));
      if (metrics!.sent !== lastSent) { lastSent = metrics!.sent; advances.push(Date.now()); }
      const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(campaignJobsTable)
        .where(and(eq(campaignJobsTable.campaignId, dead.campaign.id), eq(campaignJobsTable.status, "Processing")));
      if (left!.n === 0) reapedAt ??= Date.now();
      if ((left!.n === 0 && Date.now() - started > 3_000) || Date.now() - started > 120_000) break;
      await sleep(50);
    }
  } finally {
    await runtime.stop();
  }
  const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(campaignJobsTable)
    .where(and(eq(campaignJobsTable.campaignId, dead.campaign.id), eq(campaignJobsTable.status, "Processing")));
  assert.equal(left!.n, 0, "every expired lease was reaped");
  // Over the whole reap window: from the start to the first advance, between advances, and from the last advance
  // before the reap finished to its end. A freeze is time with no advance at all, wherever it falls.
  const windowEnd = reapedAt ?? Date.now();
  const points = [started, ...advances.filter((at) => at <= windowEnd), windowEnd];
  const gaps = points.slice(1).map((at, i) => at - points[i]!);
  const maxGap = Math.max(0, ...gaps);
  console.log(`[R6] reaped ${DEAD} expired leases in ${(reapedAt ?? Date.now()) - started} ms; metrics advanced ${advances.length} times, longest gap ${maxGap} ms`);
  assert.ok(maxGap < 1_500, `the healthy campaign's metrics never froze for long (longest gap ${maxGap} ms over ${advances.length} advances)`);
});

test("R1a · outcome backpressure at preparation arms no intent, returns the attempt, and the work is later sent exactly once", async () => {
  const COUNT = 4;
  const f = await fixture("r1a", COUNT);
  const { worker, sender } = newWorker();
  worker.updateTransportOwnership(f.phone.id, 11, Date.now() + 60_000);
  const release = saturateOutcomes(sender);
  const claimed = await claimUntil(worker, f.phone.id, COUNT);
  const refused = await worker.prepareReservoirBatch(claimed);
  assert.equal(refused.length, 0, "a saturated outcome plane prepares nothing");
  const ids = claimed.map((job) => job.id);
  let rows = await jobs(f.campaign.id);
  assert.ok(rows.every((row) => row.status === "Queued"), "the refused work is requeued");
  assert.deepEqual((await intents(ids)).filter((intent) => intent.status === "pending").map((intent) => intent.campaignJobId), [],
    "no intent is left pending for work that never reached the provider");
  assert.ok(rows.every((row) => row.attempts === 0), "backpressure is not an attempt: the claim's attempt is returned");
  assert.equal(sentTo().filter((to) => f.recipients.includes(to)).length, 0, "nothing was sent");

  release();
  const envelopes = await claimAndPrepare(worker, f.phone.id, COUNT);
  await Promise.all(envelopes.map((envelope) => {
    assert.ok(worker.tryReserveSettlementSlot());
    return worker.dispatchReservoirEnvelope(envelope, new Date(), true);
  }));
  rows = await settled(f.campaign.id, (r) => r.every((row) => row.status === "Sent" || row.status === "Failed"));
  assert.deepEqual(rows.map((row) => [row.status, row.attempts]), rows.map(() => ["Sent", 1]), "every job sent, on its first attempt");
  const sent = sentTo().filter((to) => f.recipients.includes(to));
  assert.deepEqual([...sent].sort(), [...f.recipients].sort(), "each recipient reached the provider exactly once");
  assert.ok((await intents(ids)).every((intent) => intent.status === "sent"));
});

test("R1b · a lane with no preparation headroom claims nothing and is not parked as source-empty", async () => {
  const f = await fixture("r1b", 300);
  const { worker, sender } = newWorker();
  const release = saturateOutcomes(sender);
  let claims = 0;
  const claim = worker.claimPhoneBatch.bind(worker);
  worker.claimPhoneBatch = (async (...args: Parameters<CampaignWorker["claimPhoneBatch"]>) => { claims += 1; return claim(...args); }) as CampaignWorker["claimPhoneBatch"];
  const broker = new InMemoryPreparedDispatchBroker();
  const reservoir = reservoirFor(worker, broker);
  const lane = registeredLane(reservoir, f.organization.id, f.phone.id);
  await (reservoir as unknown as { runRefill(lane: unknown): Promise<void> }).runRefill(lane);
  assert.equal(claims, 0, "no claim is made when no prepared envelope could be settled");
  assert.equal(lane.sourceEmptyUntil, 0, "the lane is not put to sleep as if its source were empty");
  assert.equal(lane.sourceEmptyBackoffMs, 0);
  const rows = await jobs(f.campaign.id);
  assert.ok(rows.every((row) => row.status === "Queued" && row.attempts === 0), "no job was touched");
  release();
});

test("R1c · with no preparation headroom, refills never re-arm themselves without yielding (no event-loop livelock)", async () => {
  // Independent review finding on ab2c8c8: runRefill stopped before its first await when headroom was 0, and the
  // re-arm in pumpRefills started the next run in the same microtask chain, forever.
  const f = await fixture("r1c", 50);
  const { worker, sender } = newWorker();
  const release = saturateOutcomes(sender);
  const reservoir = reservoirFor(worker, new InMemoryPreparedDispatchBroker());
  const lane = registeredLane(reservoir, f.organization.id, f.phone.id);
  const r = reservoir as unknown as { runRefill(lane: unknown): Promise<void>; refillIfNeeded(lane: unknown): void };
  const original = r.runRefill.bind(reservoir);
  let runs = 0;
  r.runRefill = async (l: unknown) => {
    runs += 1;
    if (runs > 50) throw new Error("refill re-armed itself without the event loop turning");
    return original(l);
  };
  r.refillIfNeeded(lane);
  await new Promise((resolve) => setImmediate(resolve)); // reached only once the microtask chain ends
  await sleep(50);
  assert.ok(runs <= 1, `${runs} refill runs started back to back`);
  const rows = await jobs(f.campaign.id);
  assert.ok(rows.every((row) => row.status === "Queued" && row.attempts === 0), "no job was claimed");
  release();
});

test("R2 · a dead owner's deferred deliveries do not hold back the new lane's refill, and are never sent", async () => {
  const DEAD = 300;
  const f = await fixture("r2", DEAD + 50);
  const { worker } = newWorker();
  const broker = new InMemoryPreparedDispatchBroker();
  await stageDead(worker, broker, f.phone.id, DEAD); // leases stay live: Decision 8 defers their reclaim
  const reservoir = reservoirFor(worker, broker);
  const lane = registeredLane(reservoir, f.organization.id, f.phone.id);
  let claims = 0;
  worker.claimPhoneBatch = (async () => { claims += 1; return []; }) as CampaignWorker["claimPhoneBatch"];
  await (reservoir as unknown as { serviceLane(lane: unknown): Promise<void> }).serviceLane(lane);
  for (let i = 0; i < 50 && claims === 0; i += 1) await sleep(20);
  assert.ok(claims > 0, `the lane refills fresh work at once (brokerDepth ${lane.brokerDepth}, lowWater ${lane.lowWater})`);
  const rows = await jobs(f.campaign.id);
  assert.equal(rows.filter((row) => row.status === "Processing").length, DEAD, "every deferred job is still held by its live lease");
  assert.equal((await broker.metrics(f.phone.id)).pending, DEAD, "and every deferred delivery is still pending, not acknowledged");
  assert.equal(sentTo().filter((to) => f.recipients.includes(to)).length, 0, "nothing was sent");
});

test("R3 · a reclaimed delivery whose intent is already sent is settled Sent with that id, never Failed and never re-sent", async () => {
  const COUNT = 3;
  const f = await fixture("r3", COUNT);
  const { worker } = newWorker();
  const broker = new InMemoryPreparedDispatchBroker();
  const deliveries = await stageDead(worker, broker, f.phone.id, COUNT);
  const ids = deliveries.map((delivery) => delivery.envelope.job.id);
  // The dead owner's outcome flush committed for two jobs (provider accepted them); it died before settling the jobs.
  const sentIds = ids.slice(0, 2);
  for (const id of sentIds) {
    await db.update(providerMessagesTable).set({ status: "sent", providerMessageId: `wamid.b13r-dead-${id}` })
      .where(eq(providerMessagesTable.campaignJobId, id));
  }
  await db.update(campaignJobsTable).set({ leaseExpiresAt: new Date(Date.now() - 60_000) }).where(inArray(campaignJobsTable.id, ids));
  const before = sentTo().length;
  const reservoir = reservoirFor(worker, broker);
  const lane = laneState(f.organization.id, f.phone.id);
  await (reservoir as unknown as { recoverAbandoned(lane: unknown): Promise<void> }).recoverAbandoned(lane);
  const rows = await jobs(f.campaign.id);
  for (const row of rows) {
    if (sentIds.includes(row.id)) {
      assert.equal(row.status, "Sent", "the provider accepted it: the job is Sent, not delivery-unknown");
      assert.equal((row.payload as { providerMessageId?: string }).providerMessageId, `wamid.b13r-dead-${row.id}`);
    } else {
      assert.deepEqual([row.status, row.errorReason], ["Failed", "Provider delivery is unknown after broker consumer loss"],
        "a pending intent under an expired lease is still failed closed for manual reconciliation");
    }
  }
  const byJob = new Map((await intents(ids)).map((intent) => [intent.campaignJobId, intent.status]));
  assert.deepEqual(ids.map((id) => byJob.get(id)), ["sent", "sent", "delivery_unknown"]);
  assert.equal(sentTo().length, before, "nothing is sent again");
  assert.equal((await broker.metrics(f.phone.id)).pending, 0, "all reclaimed deliveries acknowledged");
  await flushAllCampaignMetricDeltas(f.campaign.id);
  const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, f.campaign.id));
  assert.deepEqual([metrics!.sent, metrics!.failed, metrics!.processing], [2, 1, 0], "campaign counters match the job rows");
});
