/*
 * P1 regression: completeIfDrained() must not run its expensive path on every
 * settlement batch.
 *
 * Settlement calls completeIfDrained() for every campaign it *touched*, not
 * for campaigns it proved drained. On a busy campaign that meant an unbounded
 * flushAllCampaignMetricDeltas() loop plus a second campaigns/campaign_metrics
 * locking transaction after every batch -- measured at 53.8 ms per batch where
 * the settlement write alone takes 3.9 ms.
 *
 * The gate is a necessary condition, not an approximation: completion requires
 * queued == 0 AND processing == 0, so one non-terminal job proves the campaign
 * cannot complete. These tests pin both halves of that contract -- the skip,
 * and the completion that must still happen.
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
import { inFlightRegistry } from "../src/services/campaign-inflight";

after(async () => {
  inFlightRegistry.clear();
  // Fixtures deliberately leave requeued or undrained jobs behind; a Running
  // campaign with claimable jobs starves every later test's claims (the
  // candidate scan is global and oldest-first), so cancel them before leaving.
  if (createdCampaignIds.length) await db.update(campaignsTable).set({ status: "Cancelled" }).where(inArray(campaignsTable.id, createdCampaignIds));
  await pool.end();
});
const createdCampaignIds: number[] = [];

class SuccessfulSender implements ProviderSender {
  readonly sent: string[] = [];
  async send(_job: typeof campaignJobsTable.$inferSelect, options: { idempotencyKey: string }) {
    this.sent.push(options.idempotencyKey);
    return { providerMessageId: `provider-${options.idempotencyKey}` };
  }
}

async function fixture(slug: string, jobCount: number) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: slug, status: "Connected", tpsLimit: 50,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: `${slug}-template`,
    status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: organization.id, name: slug, status: "Running",
  }).returning();
  createdCampaignIds.push(campaign.id);
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id,
    templateId: template.id, configuredTps: 50, queueDepth: jobCount,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
  });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
    component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({
    organizationId: organization.id, campaignId: campaign.id,
    total: jobCount, valid: jobCount, queued: jobCount,
  });
  const jobs = [];
  for (let index = 0; index < jobCount; index += 1) {
    const [contact] = await db.insert(campaignContactsTable).values({
      organizationId: organization.id, campaignId: campaign.id, rowNumber: index + 1,
      rawPhone: phone.phone, normalizedPhone: phone.phone, data: { phone: phone.phone },
      status: "Valid", partitionKey: 1, routeId: route.id, idempotencyKey: `${slug}-c${index}`,
    }).returning();
    const [job] = await db.insert(campaignJobsTable).values({
      organizationId: organization.id, campaignId: campaign.id, routeId: route.id,
      contactId: contact.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-j${index}`,
    }).returning();
    jobs.push(job);
  }
  return { organization, campaign, route, jobs };
}

const worker = () => new CampaignWorker(
  new DatabaseJobQueue(), new SuccessfulSender(), new RouteTpsLimiter(), "settlement-completion-test",
);

async function campaignStatus(campaignId: number) {
  const [row] = await db.select({ status: campaignsTable.status, completedAt: campaignsTable.completedAt })
    .from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  return row;
}

test("A · a settlement batch on a campaign that is not drainable skips the expensive completion path", async () => {
  const f = await fixture(`p1-skip-${process.pid}-${Date.now()}`, 6);
  try {
    // processBatch() is the path the reservoir drives: settleSentBatch()
    // appends metric deltas and then calls completeIfDrained() for every
    // campaign it touched. processOne() is deliberately not used here -- it
    // settles through settleSent(), which updates campaign_metrics directly
    // and already carries its own maybeDrained gate.
    const outcome = await worker().processBatch(2, new Date());
    assert.equal(outcome, "sent");

    const sent = await db.select({ id: campaignJobsTable.id }).from(campaignJobsTable).where(and(
      eq(campaignJobsTable.campaignId, f.campaign.id), eq(campaignJobsTable.status, "Sent"),
    ));
    assert.ok(sent.length > 0 && sent.length < 6, `partial settlement expected, got ${sent.length}/6`);

    // The gate skipped flushAllCampaignMetricDeltas(), so the batch's delta
    // rows are still pending. Before the gate they were folded every batch.
    const deltas = await db.select({ id: campaignMetricDeltasTable.id })
      .from(campaignMetricDeltasTable).where(eq(campaignMetricDeltasTable.campaignId, f.campaign.id));
    assert.ok(
      deltas.length > 0,
      "settlement deltas must still be unflushed: that flush loop is the expensive path being skipped",
    );
    assert.equal((await campaignStatus(f.campaign.id))?.status, "Running");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, f.organization.id));
  }
});

test("B · the campaign still completes when its last job settles", async () => {
  const f = await fixture(`p1-drain-${process.pid}-${Date.now()}`, 2);
  try {
    const w = worker();
    assert.equal(await w.processOne(new Date()), "sent");
    assert.equal((await campaignStatus(f.campaign.id))?.status, "Running", "not drained after the first of two");

    assert.equal(await w.processOne(new Date()), "sent");
    const after = await campaignStatus(f.campaign.id);
    assert.equal(after?.status, "Completed", "the last settlement must still run the completion path");
    assert.ok(after?.completedAt, "completedAt must be stamped");

    const [metrics] = await db.select({
      queued: campaignMetricsTable.queued, processing: campaignMetricsTable.processing,
      sent: campaignMetricsTable.sent,
    }).from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, f.campaign.id));
    assert.equal(metrics?.queued, 0);
    assert.equal(metrics?.processing, 0);
    assert.equal(metrics?.sent, 2, "deltas must have been folded before the completion check");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, f.organization.id));
  }
});

test("C · concurrent settlement cannot complete a campaign that still has work", async () => {
  const f = await fixture(`p1-race-${process.pid}-${Date.now()}`, 6);
  try {
    // Three workers settle in parallel while three jobs remain untouched.
    // No interleaving may mark the campaign Completed.
    await Promise.all([worker().processOne(new Date()), worker().processOne(new Date()), worker().processOne(new Date())]);
    const remaining = await db.select({ id: campaignJobsTable.id }).from(campaignJobsTable).where(and(
      eq(campaignJobsTable.campaignId, f.campaign.id),
      inArray(campaignJobsTable.status, ["Queued", "Processing"]),
    ));
    // Claim races and per-route in-flight caps make the exact number settled
    // nondeterministic; what must hold is that work remains and the campaign
    // was not completed underneath it.
    assert.ok(remaining.length > 0, "the race must leave outstanding work for this assertion to mean anything");
    assert.equal(
      (await campaignStatus(f.campaign.id))?.status,
      "Running",
      "premature completion while jobs remain is a correctness failure, not a performance one",
    );
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, f.organization.id));
  }
});

test("D · skipped metric deltas are not lost and still fold correctly", async () => {
  const f = await fixture(`p1-delta-${process.pid}-${Date.now()}`, 3);
  try {
    const w = worker();
    assert.equal(await w.processOne(new Date()), "sent");
    assert.equal(await w.processOne(new Date()), "sent");

    // The gate skipped the per-batch flush; the periodic flusher is what folds
    // them. It must produce exactly the same totals.
    await flushAllCampaignMetricDeltas(f.campaign.id);

    const [metrics] = await db.select({
      queued: campaignMetricsTable.queued, processing: campaignMetricsTable.processing,
      sent: campaignMetricsTable.sent,
    }).from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, f.campaign.id));
    assert.equal(metrics?.sent, 2, "every skipped delta must still be applied exactly once");
    assert.equal(metrics?.queued, 1, "one job remains queued");
    assert.equal(metrics?.processing, 0);

    const leftover = await db.select({ id: campaignMetricDeltasTable.id })
      .from(campaignMetricDeltasTable).where(eq(campaignMetricDeltasTable.campaignId, f.campaign.id));
    assert.equal(leftover.length, 0, "the flush must consume every pending delta");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, f.organization.id));
  }
});

test("E · a job is delivered exactly once across the gated settlement path", async () => {
  const f = await fixture(`p1-idem-${process.pid}-${Date.now()}`, 2);
  try {
    const sender = new SuccessfulSender();
    const w = new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), "idem-test");
    assert.equal(await w.processOne(new Date()), "sent");
    assert.equal(await w.processOne(new Date()), "sent");
    assert.equal(await w.processOne(new Date()), "idle", "no job may be claimable twice");

    assert.equal(sender.sent.length, 2, "exactly one provider call per job");
    assert.equal(new Set(sender.sent).size, 2, "idempotency keys must be distinct");

    const jobs = await db.select({ status: campaignJobsTable.status, leaseToken: campaignJobsTable.leaseToken })
      .from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, f.campaign.id));
    assert.deepEqual(jobs.map((j) => j.status).sort(), ["Sent", "Sent"]);
    assert.ok(jobs.every((j) => j.leaseToken === null), "settled jobs must release their lease");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, f.organization.id));
  }
});
