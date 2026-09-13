/*
 * P25 regression coverage: reconcileCampaignJobs must not leave pending
 * campaign_metric_deltas behind after recounting from job rows.
 *
 * Every delta row is written in the same transaction as the job transition it
 * describes. Reconciliation recounts those transitions from the rows, so any
 * delta still pending at that moment describes a transition the recount
 * already includes; if it is folded later, the counters drift by exactly that
 * delta (observed: processing = 1 with every row Sent after the recovery
 * probe's reap; sent +692 / processing +18 after a hard kill). The recount,
 * the removal of the pending deltas and the counter rewrite are now one
 * statement inside the reconcile transaction, so they share one snapshot: a
 * transition that commits later leaves its delta in place to be folded on
 * top, one that committed earlier is counted once and its delta removed.
 *
 * Reconcile is reached from the lease reaper (after any expired lease) and
 * from the pause / cancel / emergency-kill route; both call the same function
 * that these tests call directly.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
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
  templatesTable,
  wabasTable,
} from "@workspace/db";
import {
  CampaignWorker,
  DatabaseJobQueue,
  RouteTpsLimiter,
  flushAllCampaignMetricDeltas,
  type ProviderSender,
} from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { reconcileCampaignJobs } from "../src/services/campaign-reconciliation";
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

async function fixture(slug: string, jobCount: number) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization!.id, wabaId: waba!.id,
    phone: `+1558${organization!.id.toString().padStart(7, "0")}`,
    displayName: slug, status: "Connected", tpsLimit: 1_000,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${slug}-template`,
    status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: organization!.id, name: slug, status: "Running",
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
  for (let index = 0; index < jobCount; index += 1) {
    const [contact] = await db.insert(campaignContactsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, rowNumber: index + 1,
      rawPhone: phone!.phone, normalizedPhone: phone!.phone, data: { phone: phone!.phone },
      status: "Valid", partitionKey: 1, routeId: route!.id, idempotencyKey: `${slug}-c${index}`,
    }).returning();
    const [job] = await db.insert(campaignJobsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id,
      contactId: contact!.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-j${index}`,
      attempts: 0, maxAttempts: 5,
    }).returning();
    jobIds.push(job!.id);
  }
  return { organization: organization!, phone: phone!, campaign: campaign!, route: route!, jobIds };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

class SucceedingSender implements ProviderSender {
  sends = 0;
  async send(_job: unknown, options: { idempotencyKey: string }) {
    this.sends += 1;
    return { providerMessageId: `provider-${options.idempotencyKey}` };
  }
}
const worker = (sender: ProviderSender = new SucceedingSender(), leaseMs = 30_000) =>
  new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `reconcile-${Date.now()}`, leaseMs);

/** The production send path: claim -> prepare -> slot -> dispatch, until `count` jobs were dispatched. */
async function dispatchAll(w: CampaignWorker, phoneId: number, count: number) {
  let dispatched = 0;
  for (let round = 0; round < 400 && dispatched < count; round += 1) {
    const claimed = await w.claimPhoneBatch(phoneId, Math.min(256, count - dispatched));
    if (!claimed.length) { await new Promise((r) => setTimeout(r, 10)); continue; }
    const prepared = await w.prepareReservoirBatch(claimed);
    for (const envelope of prepared) {
      assert.ok(w.tryReserveSettlementSlot());
      void w.dispatchReservoirEnvelope(envelope, new Date(), true);
      dispatched += 1;
    }
  }
  assert.equal(dispatched, count);
  assert.ok(await w.waitForIdle(20_000), "every dispatched job must settle");
}

/** Authoritative counts from the job rows, in the shape of the campaign_metrics counters. */
async function rowCounts(campaignId: number) {
  const rows = await db.select({ status: campaignJobsTable.status, attempts: campaignJobsTable.attempts })
    .from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId));
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  // retry_count is deliberately left out: the recount defines it as attempts - 1 over rows while the delta path
  // only counts provider-retry requeues (a pre-existing definitional difference outside this defect).
  return { queued: count("Queued"), processing: count("Processing"), sent: count("Sent"), failed: count("Failed") };
}
async function metrics(campaignId: number) {
  const [m] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaignId));
  return { queued: m!.queued, processing: m!.processing, sent: m!.sent, failed: m!.failed };
}
const pendingDeltas = async (campaignId: number) =>
  (await db.select().from(campaignMetricDeltasTable).where(eq(campaignMetricDeltasTable.campaignId, campaignId))).length;
const campaignStatus = async (campaignId: number) =>
  (await db.select({ status: campaignsTable.status }).from(campaignsTable).where(eq(campaignsTable.id, campaignId)))[0]!.status;
/** Exact means: after every pending delta is folded, the counters equal the rows. */
async function assertExact(campaignId: number, why: string) {
  await flushAllCampaignMetricDeltas(campaignId);
  assert.deepEqual(await metrics(campaignId), await rowCounts(campaignId), why);
}
const slug = (name: string) => `p25-${name}-${process.pid}-${Date.now()}`;

test("1 · pending deltas followed by a reconcile give exact counters, and the deltas are gone", async () => {
  const f = await fixture(slug("pending"), 40);
  const w = worker();
  // Real claims: 10 jobs move to Processing, and their +processing/-queued delta rows stay pending.
  let claimed = 0;
  while (claimed < 10) claimed += (await w.claimPhoneBatch(f.phone.id, 10 - claimed)).length;
  assert.ok((await pendingDeltas(f.campaign.id)) >= 1, "the claim left its delta pending");
  assert.deepEqual(await metrics(f.campaign.id), { queued: 40, processing: 0, sent: 0, failed: 0 }, "nothing folded yet");

  await reconcileCampaignJobs(f.campaign.id);

  assert.equal(await pendingDeltas(f.campaign.id), 0, "the recount consumed every pending delta");
  assert.deepEqual(await metrics(f.campaign.id), { queued: 30, processing: 10, sent: 0, failed: 0 });
  await assertExact(f.campaign.id, "a later flush has nothing left to double-apply");
});

test("2/3 · the recovery-probe scenario: reap then reconcile, then every job sends, processing returns to 0 and the campaign completes", async () => {
  const f = await fixture(slug("probe"), 30);
  // A job claimed under a short lease by a worker that never comes back (the harness's own probe, or a crash).
  const [interrupted] = await worker(new SucceedingSender(), 250).claimPhoneBatch(f.phone.id, 1);
  assert.ok(interrupted);
  await new Promise((r) => setTimeout(r, 300));
  const runtime = new CampaignRuntime();
  await (runtime as unknown as { reapExpiredLeases(now: Date): Promise<void> }).reapExpiredLeases(new Date());
  assert.equal((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, interrupted!.id)))[0]!.status, "Queued");
  // Before the fix: the reaper's reconcile recounted processing = 0, queued = 30, and the claim's still-pending
  // delta was folded afterwards, leaving processing = 1 for the rest of the campaign's life.
  assert.equal(await pendingDeltas(f.campaign.id), 0);
  assert.deepEqual(await metrics(f.campaign.id), { queued: 30, processing: 0, sent: 0, failed: 0 });

  const w = worker();
  await dispatchAll(w, f.phone.id, 30);
  await assertExact(f.campaign.id, "exact after every job settled");
  assert.deepEqual(await metrics(f.campaign.id), { queued: 0, processing: 0, sent: 30, failed: 0 });
  assert.equal(await campaignStatus(f.campaign.id), "Completed", "completion fires because processing is 0");
});

test("4/5 · many pending delta rows of every kind (the +692 sent / +18 processing shape) are folded exactly once", async () => {
  const f = await fixture(slug("shape"), 60);
  const w = worker();
  // 20 claimed (pending claim deltas), of which 8 already settled Sent by a process that died before flushing:
  // their rows are Sent and their sent deltas are still pending, exactly the post-kill state.
  let claimed: number[] = [];
  while (claimed.length < 20) claimed = claimed.concat((await w.claimPhoneBatch(f.phone.id, 20 - claimed.length)).map((j) => j.id));
  const sentIds = claimed.slice(0, 8);
  await db.update(campaignJobsTable).set({ status: "Sent", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null })
    .where(inArray(campaignJobsTable.id, sentIds));
  for (let i = 0; i < 4; i += 1) {
    await db.insert(campaignMetricDeltasTable).values({ organizationId: f.organization.id, campaignId: f.campaign.id, processingDelta: -2, sentDelta: 2 });
  }
  // Two of them also failed closed with their deltas pending.
  const failedIds = claimed.slice(8, 10);
  await db.update(campaignJobsTable).set({ status: "Failed", errorReason: "x", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null })
    .where(inArray(campaignJobsTable.id, failedIds));
  await db.insert(campaignMetricDeltasTable).values({ organizationId: f.organization.id, campaignId: f.campaign.id, processingDelta: -2, failedDelta: 2 });
  assert.ok((await pendingDeltas(f.campaign.id)) >= 6, "multiple pending delta rows");

  await reconcileCampaignJobs(f.campaign.id);
  assert.equal(await pendingDeltas(f.campaign.id), 0);
  assert.deepEqual(await metrics(f.campaign.id), { queued: 40, processing: 10, sent: 8, failed: 2 });
  await assertExact(f.campaign.id, "no delta is applied a second time");
  // Before the fix the pending rows would have been folded on top of the recount: sent 16, failed 4, processing 0.
});

test("6 · the pause / cancel / emergency-kill route path (abort + reconcile) cannot double-apply a settlement in flight", async () => {
  const f = await fixture(slug("pause"), 24);
  const w = worker();
  await dispatchAll(w, f.phone.id, 12);
  assert.deepEqual(await rowCounts(f.campaign.id), { queued: 12, processing: 0, sent: 12, failed: 0 });
  // 6 more claimed and left pending, as jobs are when an operator pauses mid-send.
  let n = 0;
  while (n < 6) n += (await w.claimPhoneBatch(f.phone.id, 6 - n)).length;
  const before = await metrics(f.campaign.id);
  assert.ok(before.sent <= 12);

  // What the route does after the transition: abort in-flight work, then reconcile.
  inFlightRegistry.abortCampaign(f.campaign.id, "Campaign pause");
  await inFlightRegistry.waitForIdle(250);
  await reconcileCampaignJobs(f.campaign.id);
  await reconcileCampaignJobs(f.campaign.id);

  assert.equal(await pendingDeltas(f.campaign.id), 0);
  assert.deepEqual(await metrics(f.campaign.id), { queued: 6, processing: 6, sent: 12, failed: 0 });
  await assertExact(f.campaign.id, "two reconciles and a flush change nothing");
});

test("7a · a claim committing concurrently with reconcile is neither lost nor counted twice", async () => {
  const f = await fixture(slug("race"), 400);
  const w = worker();
  // The claim path does not take the campaign lock, so it can commit while reconcile runs. Interleave them
  // many times; whichever side of the recount snapshot each claim lands on, the counters must end exact.
  let claimed = 0;
  for (let round = 0; round < 12; round += 1) {
    const [, jobs] = await Promise.all([
      reconcileCampaignJobs(f.campaign.id),
      w.claimPhoneBatch(f.phone.id, 25),
      reconcileCampaignJobs(f.campaign.id),
    ]);
    claimed += jobs.length;
    await assertExact(f.campaign.id, `round ${round}: exact after the concurrent claim`);
  }
  assert.ok(claimed >= 100, `the interleaving actually claimed work (${claimed})`);
  assert.equal((await rowCounts(f.campaign.id)).processing, claimed);
});

test("7b · a settlement writer holding the campaign lock serializes with reconcile and its delta is folded exactly once", async () => {
  const f = await fixture(slug("lock"), 16);
  const w = worker();
  let claimed: number[] = [];
  while (claimed.length < 4) claimed = claimed.concat((await w.claimPhoneBatch(f.phone.id, 4 - claimed.length)).map((j) => j.id));
  await flushAllCampaignMetricDeltas(f.campaign.id);
  assert.deepEqual(await metrics(f.campaign.id), { queued: 12, processing: 4, sent: 0, failed: 0 });

  // A settlement-shaped writer: campaign row locked, one job settled and its delta written, then a pause before
  // commit while reconcile is already waiting on the lock.
  let releaseWriter!: () => void;
  const hold = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const writer = db.transaction(async (tx) => {
    await tx.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.id, f.campaign.id)).for("update");
    await tx.update(campaignJobsTable).set({ status: "Sent", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null })
      .where(and(eq(campaignJobsTable.id, claimed[0]!), eq(campaignJobsTable.status, "Processing")));
    await tx.insert(campaignMetricDeltasTable).values({ organizationId: f.organization.id, campaignId: f.campaign.id, processingDelta: -1, sentDelta: 1 });
    await hold;
  });
  await new Promise((r) => setTimeout(r, 50));
  const reconcile = reconcileCampaignJobs(f.campaign.id);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await metrics(f.campaign.id), { queued: 12, processing: 4, sent: 0, failed: 0 }, "reconcile is blocked behind the lock");
  releaseWriter();
  await writer;
  await reconcile;

  assert.equal(await pendingDeltas(f.campaign.id), 0, "the writer's delta, committed before the recount ran, was consumed by it");
  assert.deepEqual(await metrics(f.campaign.id), { queued: 12, processing: 3, sent: 1, failed: 0 });
  await assertExact(f.campaign.id, "exact after the serialized writer");
});

test("8 · normal settlement without any reconcile is unchanged: deltas are written, flushed, and exact", async () => {
  const f = await fixture(slug("normal"), 50);
  const w = worker();
  await dispatchAll(w, f.phone.id, 50);
  await assertExact(f.campaign.id, "the ordinary delta path still folds to exact counters");
  assert.deepEqual(await metrics(f.campaign.id), { queued: 0, processing: 0, sent: 50, failed: 0 });
  assert.equal(await pendingDeltas(f.campaign.id), 0);
  assert.equal(await campaignStatus(f.campaign.id), "Completed");
});
