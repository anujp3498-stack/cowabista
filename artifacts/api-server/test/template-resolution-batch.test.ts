/*
 * Batch template resolution (resolveJobTemplates) must resolve every job exactly as the single-job resolver
 * (resolveJobTemplate) does: same outcome, same error text, same fenced payload write. The batch now covers
 * legacy (plan-less) jobs and claim batches that span campaigns with set-based reads; before, any such batch fell
 * back to the single-job resolver per job (four or five round trips each, ~6.9 ms per job on the HTTP benchmark
 * path, which capped a cell near 500 sends/s).
 *
 * Two identical fixtures are built. One is resolved as one batch, the other job by job; the outcomes must match.
 * Cases: a valid legacy job; a contact owned by another organization; an empty mapped value; a job whose template
 * is not selected; a lease revoked after the claim; a job with no lease; a legacy job of a campaign that has an
 * Active plan (resolved from that plan's snapshot); and plan-backed jobs of two campaigns in the same batch.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignPlansTable,
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
  type CampaignJob,
} from "@workspace/db";
import { resolveJobTemplate, resolveJobTemplates } from "../src/services/template-resolution";

const organizationIds: number[] = [];
after(async () => {
  if (organizationIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  await pool.end();
});

async function fixture(tag: string) {
  const slug = `trb-${tag}-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [other] = await db.insert(organizationsTable).values({ name: `${slug}-other`, slug: `${slug}-other` }).returning();
  organizationIds.push(organization!.id, other!.id);
  const orgId = organization!.id;
  const [waba] = await db.insert(wabasTable).values({ organizationId: orgId, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: orgId, wabaId: waba!.id, phone: `+1556${String(orgId).padStart(7, "0")}`, displayName: slug, status: "Connected", tpsLimit: 100,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: orgId, wabaId: waba!.id, name: `${slug}-t`, status: "Approved", language: "en_US",
    body: "Hi {{1}}", components: [{ type: "BODY", text: "Hi {{1}}" }],
  }).returning();
  const [unselected] = await db.insert(templatesTable).values({
    organizationId: orgId, wabaId: waba!.id, name: `${slug}-u`, status: "Approved", language: "en_US",
    body: "Other {{1}}", components: [{ type: "BODY", text: "Other {{1}}" }],
  }).returning();
  const lease = (n: number) => `${slug}-lease-${n}`;

  async function campaign(name: string, options: { plan?: "active-only" | "frozen" } = {}) {
    const [row] = await db.insert(campaignsTable).values({ organizationId: orgId, name: `${slug}-${name}`, status: "Running" }).returning();
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: orgId, campaignId: row!.id, phoneNumberId: phone!.id, templateId: template!.id, configuredTps: 100,
    }).returning();
    await db.insert(campaignTemplateSelectionsTable).values({ organizationId: orgId, campaignId: row!.id, templateId: template!.id });
    await db.insert(campaignTemplateMappingsTable).values({
      organizationId: orgId, campaignId: row!.id, templateId: template!.id, component: "body", variable: "1", source: "csv", sourceValue: "name",
    });
    let planId: number | null = null;
    if (options.plan) {
      const [plan] = await db.insert(campaignPlansTable).values({
        organizationId: orgId, campaignId: row!.id, version: 1, allocatorVersion: "trb-v1", partitionCount: 64,
        routes: [{ routeId: route!.id, phoneNumberId: phone!.id, templateId: template!.id, configuredTps: 100, providerTpsLimit: 100, phone: phone!.phone, displayName: slug }],
        templateIds: [template!.id],
        // The snapshot body differs from the live template: proves which source resolved the job.
        templatesSnapshot: [{ id: template!.id, name: template!.name, language: "en_US", wabaId: waba!.id, body: "Frozen {{1}}", components: [{ type: "BODY", text: "Frozen {{1}}" }] }],
        mappingsSnapshot: [{ templateId: template!.id, component: "body", variable: "1", source: "static", sourceValue: "from-plan" }],
        status: "Active",
      } as typeof campaignPlansTable.$inferInsert).returning();
      planId = plan!.id;
    }
    return { campaign: row!, route: route!, planId: options.plan === "frozen" ? planId : null };
  }
  async function job(
    c: Awaited<ReturnType<typeof campaign>>, n: number,
    options: { data?: Record<string, string>; contactOrg?: number; templateId?: number; leased?: boolean; planned?: boolean } = {},
  ): Promise<CampaignJob> {
    const [contact] = await db.insert(campaignContactsTable).values({
      organizationId: options.contactOrg ?? orgId, campaignId: options.contactOrg ? (await otherCampaign()).id : c.campaign.id,
      rowNumber: n, rawPhone: `+1777${String(orgId).padStart(5, "0")}${String(n).padStart(3, "0")}`,
      normalizedPhone: `+1777${String(orgId).padStart(5, "0")}${String(n).padStart(3, "0")}`, data: options.data ?? { name: `Name ${n}` },
      status: "Valid", idempotencyKey: `${slug}-contact-${n}`,
    }).returning();
    const [row] = await db.insert(campaignJobsTable).values({
      organizationId: orgId, campaignId: c.campaign.id, routeId: c.route.id, contactId: contact!.id,
      templateId: options.templateId ?? null, planId: options.planned ? c.planId : null,
      type: "ResolveTemplateAndSend", status: "Processing", idempotencyKey: `${slug}-job-${n}`,
      leaseToken: options.leased === false ? null : lease(n), lockedBy: "trb", payload: { contactId: contact!.id },
    }).returning();
    return row!;
  }
  let otherCampaignRow: typeof campaignsTable.$inferSelect | undefined;
  async function otherCampaign() {
    otherCampaignRow ??= (await db.insert(campaignsTable).values({ organizationId: other!.id, name: `${slug}-x`, status: "Running" }).returning())[0];
    return otherCampaignRow!;
  }

  const legacy = await campaign("legacy");
  const withActivePlan = await campaign("active-plan", { plan: "active-only" });
  const plannedA = await campaign("planned-a", { plan: "frozen" });
  const plannedB = await campaign("planned-b", { plan: "frozen" });
  const jobs = [
    await job(legacy, 1),
    await job(legacy, 2, { contactOrg: other!.id }),
    await job(legacy, 3, { data: { other: "x" } }),
    await job(legacy, 4, { templateId: unselected!.id }),
    await job(legacy, 5),
    await job(legacy, 6, { leased: false }),
    await job(withActivePlan, 7),
    await job(plannedA, 8, { planned: true }),
    await job(plannedB, 9, { planned: true }),
    await job(legacy, 10),
  ];
  // Job 5's lease is replaced after the claim (another owner took it over): its fenced write must not apply.
  await db.update(campaignJobsTable).set({ leaseToken: `${slug}-lease-5-newer` }).where(eq(campaignJobsTable.id, jobs[4]!.id));
  return jobs;
}

/** What callers depend on: the error text, or the resolved payload's template and parameters, and the stored payload. */
async function normalize(jobs: CampaignJob[], outcomes: Array<{ resolvedJob?: CampaignJob; error?: unknown }>) {
  const stored = new Map((await db.select({ id: campaignJobsTable.id, payload: campaignJobsTable.payload }).from(campaignJobsTable)
    .where(inArray(campaignJobsTable.id, jobs.map((job) => job.id)))).map((row) => [row.id, row.payload as Record<string, unknown>]));
  return outcomes.map((outcome, index) => {
    const storedPayload = stored.get(jobs[index]!.id)!;
    if (outcome.error !== undefined) {
      return { error: outcome.error instanceof Error ? outcome.error.message.replace(/\d+/g, "#") : String(outcome.error), storedResolved: "resolvedParameters" in storedPayload };
    }
    const payload = outcome.resolvedJob!.payload as { templateId?: number; resolvedParameters?: unknown };
    return {
      resolvedParameters: payload.resolvedParameters,
      templateIdSet: typeof payload.templateId === "number",
      storedResolvedParameters: storedPayload.resolvedParameters,
      leaseToken: outcome.resolvedJob!.leaseToken === jobs[index]!.leaseToken,
      configuredTps: outcome.resolvedJob!.configuredTps === jobs[index]!.configuredTps,
    };
  });
}

test("a batch of legacy, mixed-campaign and planned jobs resolves exactly as the single-job resolver resolves each", async () => {
  const batchJobs = await fixture("batch");
  const singleJobs = await fixture("single");
  const batch = await resolveJobTemplates(batchJobs);
  const single = await Promise.all(singleJobs.map(async (job) => {
    try { return { resolvedJob: await resolveJobTemplate(job) }; } catch (error) { return { error }; }
  }));
  const batchView = await normalize(batchJobs, batch);
  const singleView = await normalize(singleJobs, single);
  assert.deepEqual(batchView, singleView);
  assert.equal(batch.length, batchJobs.length);
  batch.forEach((outcome, index) => assert.equal(outcome.job.id, batchJobs[index]!.id, "results come back in input order"));

  // The cases really cover each branch.
  const errors = batchView.map((view) => ("error" in view ? view.error : null));
  assert.equal(errors[1], "Campaign contact is missing or not tenant-owned");
  assert.equal(errors[2], "Mapping body:# resolved to an empty value");
  assert.equal(errors[3], "Route template # is not selected");
  assert.equal(errors[4], "Job lease was revoked before template resolution");
  assert.equal(errors[5], "Template resolution requires an active job lease");
  assert.deepEqual((batchView[0] as { resolvedParameters: unknown }).resolvedParameters, { header: {}, body: { "1": "Name 1" }, button: {} });
  assert.deepEqual((batchView[6] as { resolvedParameters: unknown }).resolvedParameters, { header: {}, body: { "1": "from-plan" }, button: {} },
    "a legacy job of a campaign with an Active plan resolves from that plan's snapshot");
  for (const index of [7, 8]) {
    assert.deepEqual((batchView[index] as { resolvedParameters: unknown }).resolvedParameters, { header: {}, body: { "1": "from-plan" }, button: {} },
      "plan-backed jobs of two campaigns in one batch resolve from their frozen plans");
  }
  assert.ok(batchView.every((view) => !("error" in view) || view.storedResolved === false), "a failed job's stored payload is untouched");
});
