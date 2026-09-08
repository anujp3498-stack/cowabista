// Rocket Campaign roadmap requirement: "parallel per-number processing".
// Before this fix, CampaignRuntime.tick() awaited each claim+send in a
// strictly sequential loop, so two phone numbers could never send at the
// same time -- aggregate throughput was bottlenecked by one provider
// round-trip at a time no matter how many numbers/routes a campaign had.
// This proves the production CampaignRuntime (not a hand-rolled
// Promise.all of separate workers) actually overlaps sends across two
// different phone numbers within a single tick.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
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
import type { ProviderSender } from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { inFlightRegistry } from "../src/services/campaign-inflight";

after(async () => {
  inFlightRegistry.clear();
  await pool.end();
});

/** Records how many sends are simultaneously in-flight, holding each one open until released so overlap can be observed deterministically. */
class TrackingSender implements ProviderSender {
  inFlight = 0;
  maxObservedInFlight = 0;
  readonly delivered: string[] = [];
  private releasers: Array<() => void> = [];

  async send(_job: typeof campaignJobsTable.$inferSelect, options: { idempotencyKey: string }) {
    this.inFlight += 1;
    this.maxObservedInFlight = Math.max(this.maxObservedInFlight, this.inFlight);
    await new Promise<void>((resolve) => this.releasers.push(resolve));
    this.inFlight -= 1;
    this.delivered.push(options.idempotencyKey);
    return { providerMessageId: `provider-${options.idempotencyKey}` };
  }

  /** Releases every send currently blocked in send(), letting the test control exactly when work "completes". */
  releaseAll(): void {
    const pending = this.releasers;
    this.releasers = [];
    for (const release of pending) release();
  }
}

async function createRouteWithJob(slug: string, organizationId: number, campaignId: number, phoneSuffix: number) {
  const [waba] = await db.insert(wabasTable).values({
    organizationId, externalId: `${slug}-waba-${phoneSuffix}`, displayName: slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId, wabaId: waba.id,
    phone: `+1555${organizationId.toString().padStart(4, "0")}${phoneSuffix.toString().padStart(3, "0")}`,
    displayName: `${slug}-${phoneSuffix}`, status: "Connected", tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId, wabaId: waba.id, name: `${slug}-template-${phoneSuffix}`, status: "Approved",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId, campaignId, phoneNumberId: phone.id, templateId: template.id, configuredTps: 10, queueDepth: 1,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId, campaignId, templateId: template.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId, campaignId, templateId: template.id, component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId, campaignId, rowNumber: phoneSuffix, rawPhone: phone.phone, normalizedPhone: phone.phone,
    data: { phone: phone.phone }, status: "Valid", partitionKey: phoneSuffix, routeId: route.id,
    idempotencyKey: `${slug}-contact-${phoneSuffix}`,
  }).returning();
  const [job] = await db.insert(campaignJobsTable).values({
    organizationId, campaignId, routeId: route.id, contactId: contact.id,
    type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-send-${phoneSuffix}`,
  }).returning();
  return { phone, route, job };
}

test("CampaignRuntime overlaps sends to two different phone numbers within a single tick instead of serializing them", async () => {
  const slug = `parallel-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
  const routeA = await createRouteWithJob(slug, organization.id, campaign.id, 1);
  const routeB = await createRouteWithJob(slug, organization.id, campaign.id, 2);
  await db.insert(campaignMetricsTable).values({ organizationId: organization.id, campaignId: campaign.id, total: 2, valid: 2, queued: 2 });

  const sender = new TrackingSender();
  const runtime = new CampaignRuntime(sender);
  try {
    const tickPromise = runtime.runTickForTest();
    // Poll (instead of a single fixed sleep) for both claim+send lanes to
    // reach the (blocked) send() call. A fixed sleep raced the variable time
    // each lane spends on its own claim/lock/select work before calling
    // send(), which made this assertion flaky under load without actually
    // testing serialization -- if sends were still serialized, polling would
    // time out with maxObservedInFlight stuck at 1, never reaching 2.
    const deadline = Date.now() + 5_000;
    while (sender.maxObservedInFlight < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(sender.maxObservedInFlight, 2, "both phone numbers' sends should be in-flight at the same time, proving parallel per-number processing");
    sender.releaseAll();
    await tickPromise;

    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(jobs.length, 2);
    for (const job of jobs) assert.equal(job.status, "Sent");
    assert.deepEqual(new Set(sender.delivered), new Set([routeA.job.idempotencyKey, routeB.job.idempotencyKey]));
  } finally {
    await runtime.stop();
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});
