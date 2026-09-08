// Task #30: prove that in-flight campaign jobs survive an actual worker
// *process crash* -- not just a graceful pause/cancel where the same
// process gets a chance to run its own cleanup (inFlightRegistry.abort*).
//
// A crash means: the process holding the lease disappears mid-send with no
// signal fired, no `finally` block running, and no status change to the
// campaign at all (it is still "Running"). The only thing a fresh process
// can rely on to notice this is the lease's own expiry timestamp, written
// by the database clock at claim time. These tests never call abort/stop;
// they simulate death by simply abandoning a claimed job and letting a
// brand-new `CampaignRuntime`/`CampaignWorker` (standing in for the
// restarted process) reap and safely re-deliver it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
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
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { inFlightRegistry } from "../src/services/campaign-inflight";

after(async () => {
  inFlightRegistry.clear();
  await pool.end();
});

class SuccessfulSender implements ProviderSender {
  readonly idempotencyKeys: string[] = [];
  async send(_job: typeof campaignJobsTable.$inferSelect, options: { idempotencyKey: string }) {
    this.idempotencyKeys.push(options.idempotencyKey);
    return { providerMessageId: `provider-${options.idempotencyKey}` };
  }
}

async function createRunningFixture(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: organization.id,
    externalId: `${slug}-waba`,
    displayName: slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id,
    wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: slug,
    status: "Connected",
    tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id,
    wabaId: waba.id,
    name: `${slug}-template`,
    status: "Approved",
    body: "Hello {{1}}",
    components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  // The campaign is created -- and stays -- "Running" for the whole test.
  // It is never Paused or Cancelled: the only thing that changes is that
  // the worker holding the lease vanishes.
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: organization.id,
    name: slug,
    status: "Running",
  }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    phoneNumberId: phone.id,
    templateId: template.id,
    configuredTps: 10,
    queueDepth: 1,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    templateId: template.id,
  });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    templateId: template.id,
    component: "body",
    variable: "1",
    source: "static",
    sourceValue: "World",
  });
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    rowNumber: 2,
    rawPhone: phone.phone,
    normalizedPhone: phone.phone,
    data: { phone: phone.phone },
    status: "Valid",
    partitionKey: 1,
    routeId: route.id,
    idempotencyKey: `${slug}-contact`,
  }).returning();
  await db.insert(campaignMetricsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    total: 1,
    valid: 1,
    queued: 1,
  });
  const [job] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    routeId: route.id,
    contactId: contact.id,
    type: "ResolveTemplateAndSend",
    idempotencyKey: `${slug}-send`,
  }).returning();
  return { organization, waba, phone, template, campaign, route, job };
}

test("a job survives its worker process crashing mid-send: a fresh process recovers and delivers it exactly once", async () => {
  const fixture = await createRunningFixture(`crash-${process.pid}-${Date.now()}`);
  try {
    // Simulate the doomed process: it claims the job (a real DB-clock
    // lease, 150ms TTL) and then, standing in for a crash, does absolutely
    // nothing else -- no abort call, no settle, no status change on the
    // campaign. This is deliberately NOT `worker.processOne()`, because
    // that helper's own `finally` block would release/clean up state a
    // dead process could never actually run.
    const limiter = new RouteTpsLimiter();
    const crashedClaim = await new DatabaseJobQueue().claim(limiter, "doomed-worker", 150, new Date());
    assert.ok(crashedClaim, "the doomed worker must have claimed the job before crashing");
    const staleLeaseToken = crashedClaim!.leaseToken;
    assert.ok(staleLeaseToken);

    let [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
    let [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    assert.equal(job?.status, "Processing");
    assert.equal(metrics?.processing, 1);
    assert.equal(metrics?.queued, 0);

    // The campaign itself never left "Running" -- unlike a pause/cancel,
    // nothing in the system was told anything went wrong yet.
    const [campaignDuringCrash] = await db.select({ status: campaignsTable.status }).from(campaignsTable)
      .where(eq(campaignsTable.id, fixture.campaign.id));
    assert.equal(campaignDuringCrash?.status, "Running");

    // Let the lease clock actually expire (database time, not wall time).
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A brand-new process starts up (new CampaignRuntime instance, nothing
    // shared with the dead one) and runs its lease-reaping sweep, exactly
    // as `tick()` does on every interval.
    const restartedRuntime = new CampaignRuntime();
    await (restartedRuntime as unknown as { reapExpiredLeases(now: Date): Promise<void> })
      .reapExpiredLeases(new Date(Date.now() + 60 * 60 * 1000));

    [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
    [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    assert.equal(job?.status, "Queued", "a crashed lease on a still-Running campaign must be requeued, not cancelled");
    assert.equal(job?.lockedBy, null);
    assert.equal(job?.leaseToken, null);
    assert.equal(metrics?.processing, 0);
    assert.equal(metrics?.queued, 1);

    // The restarted process's own worker now picks the recovered job back
    // up and actually delivers it.
    const successful = new SuccessfulSender();
    const recoveredWorker = new CampaignWorker(new DatabaseJobQueue(), successful, new RouteTpsLimiter(), "recovered-worker");
    const outcome = await recoveredWorker.processOne(new Date(Date.now() + 1_000));
    assert.equal(outcome, "sent");
    assert.deepEqual(successful.idempotencyKeys, [fixture.job.idempotencyKey], "the recovered job must be delivered exactly once");

    [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
    [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    const [campaignAfter] = await db.select({ sent: campaignsTable.sent }).from(campaignsTable)
      .where(eq(campaignsTable.id, fixture.campaign.id));
    assert.equal(job?.status, "Sent");
    assert.equal(metrics?.sent, 1);
    assert.equal(metrics?.processing, 0);
    assert.equal(metrics?.queued, 0);
    assert.equal(campaignAfter?.sent, 1);

    // Guard against a theoretical zombie: if anything ever tried to settle
    // the *original* (dead) lease token after recovery already moved on,
    // it must be a safe no-op, not a duplicate "Sent" or double-counted
    // metric. This directly exercises the same lease-fenced WHERE clause
    // `CampaignWorker` itself relies on.
    const [zombieSettle] = await db.update(campaignJobsTable).set({
      status: "Sent",
      payload: { providerMessageId: "zombie-response" },
    }).where(and(
      eq(campaignJobsTable.id, fixture.job.id),
      eq(campaignJobsTable.status, "Processing"),
      eq(campaignJobsTable.leaseToken, staleLeaseToken!),
    )).returning();
    assert.equal(zombieSettle, undefined, "a late response against the crashed process's stale lease token must affect zero rows");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("multiple crashed leases across independent campaigns are each recovered without cross-campaign leakage", async () => {
  const prefix = `multi-crash-${process.pid}-${Date.now()}`;
  const first = await createRunningFixture(`${prefix}-a`);
  const second = await createRunningFixture(`${prefix}-b`);
  try {
    const limiter = new RouteTpsLimiter();
    const claimA = await new DatabaseJobQueue().claim(limiter, "doomed-a", 150, new Date());
    const claimB = await new DatabaseJobQueue().claim(limiter, "doomed-b", 150, new Date());
    assert.ok(claimA);
    assert.ok(claimB);
    // Both worker instances "crash" here -- nothing further is ever called
    // on either claim.

    await new Promise((resolve) => setTimeout(resolve, 300));

    const restartedRuntime = new CampaignRuntime();
    await (restartedRuntime as unknown as { reapExpiredLeases(now: Date): Promise<void> })
      .reapExpiredLeases(new Date(Date.now() + 60 * 60 * 1000));

    for (const fixture of [first, second]) {
      const [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
      const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
      assert.equal(job?.status, "Queued", `job for ${fixture.organization.slug} must be requeued after the crash`);
      assert.equal(metrics?.processing, 0);
      assert.equal(metrics?.queued, 1);
    }

    const senderA = new SuccessfulSender();
    const senderB = new SuccessfulSender();
    const workerA = new CampaignWorker(new DatabaseJobQueue(), senderA, new RouteTpsLimiter(), "recovered-a");
    const workerB = new CampaignWorker(new DatabaseJobQueue(), senderB, new RouteTpsLimiter(), "recovered-b");
    const [outcomeA, outcomeB] = await Promise.all([
      workerA.processOne(new Date(Date.now() + 1_000)),
      workerB.processOne(new Date(Date.now() + 1_000)),
    ]);
    assert.equal(outcomeA, "sent");
    assert.equal(outcomeB, "sent");
    assert.deepEqual(senderA.idempotencyKeys, [first.job.idempotencyKey]);
    assert.deepEqual(senderB.idempotencyKeys, [second.job.idempotencyKey]);

    for (const fixture of [first, second]) {
      const [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
      const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
      assert.equal(job?.status, "Sent");
      assert.equal(metrics?.sent, 1);
      assert.equal(metrics?.processing, 0);
      assert.equal(metrics?.queued, 0);
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, first.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, second.organization.id));
  }
});

// A "poison pill" job -- one whose payload reliably crashes the worker
// process every time, before CampaignWorker.processOne's own catch block
// (the ONLY normal place maxAttempts is enforced) ever runs -- must not
// crash-loop forever. Once it has already been claimed maxAttempts times,
// the next lease-expiry sweep must fail it, not requeue it again.
test("a job that keeps crashing its worker on every claim is failed, not requeued forever, once maxAttempts is reached", async () => {
  const fixture = await createRunningFixture(`poison-${process.pid}-${Date.now()}`);
  try {
    // Fast-forward straight to "one claim away from exhausted" instead of
    // looping the full crash/reap cycle maxAttempts times -- attempts
    // increments identically on every real claim either way (see
    // runClaimTransaction), so this is equivalent to maxAttempts-1 prior
    // crashes having already happened.
    await db.update(campaignJobsTable).set({ attempts: fixture.job.maxAttempts - 1 })
      .where(eq(campaignJobsTable.id, fixture.job.id));

    const limiter = new RouteTpsLimiter();
    const crashedClaim = await new DatabaseJobQueue().claim(limiter, "doomed-worker", 150, new Date());
    assert.ok(crashedClaim, "the doomed worker must have claimed the job before crashing");
    // Nothing else runs on this claim -- standing in for the crash.

    let [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
    assert.equal(job?.status, "Processing");
    assert.equal(job?.attempts, fixture.job.maxAttempts, "the claim that crashed must still count as an attempt");

    await new Promise((resolve) => setTimeout(resolve, 300));

    const restartedRuntime = new CampaignRuntime();
    await (restartedRuntime as unknown as { reapExpiredLeases(now: Date): Promise<void> })
      .reapExpiredLeases(new Date(Date.now() + 60 * 60 * 1000));

    [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
    const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    const [route] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.id, fixture.route.id));
    const [campaignAfter] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, fixture.campaign.id));
    assert.equal(job?.status, "Failed", "a job already at maxAttempts must be failed on lease expiry, not requeued into another crash loop");
    assert.equal(job?.lockedBy, null);
    assert.equal(job?.leaseToken, null);
    assert.match(job?.errorReason ?? "", /attempts/i);
    assert.equal(metrics?.processing, 0);
    assert.equal(metrics?.queued, 0);
    assert.equal(metrics?.failed, 1);
    assert.equal(route?.queueDepth, 0);
    assert.equal(campaignAfter?.failed, 1);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});
