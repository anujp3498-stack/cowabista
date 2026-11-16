/*
 * Batch template resolution (resolveJobTemplates) must resolve every job exactly as the single-job resolver
 * (resolveJobTemplate) does: same outcome, same error text, same template, same fenced payload write. The batch now
 * covers legacy (plan-less) jobs and claim batches that span campaigns and organizations with set-based reads; before,
 * any such batch fell back to the single-job resolver per job (four or five round trips each, ~6.9 ms per job on the
 * HTTP benchmark path, which capped a cell near 500 sends/s).
 *
 * Identical fixtures are built for two organizations, twice. One copy (both organizations' jobs together) is resolved
 * as ONE batch, the other job by job; the outcomes must match. Cases per organization:
 *   legacy campaign: a valid job; a contact owned by another organization; an empty mapped value; a job whose
 *     template is not selected; a lease revoked after the claim; a job with no lease; another valid job;
 *   a legacy job of a campaign that has an Active plan (resolved from that plan's snapshot);
 *   plan-backed jobs of two campaigns, with a revoked lease and a foreign contact inside a plan-backed group;
 *   a template variable with no mapping ("Missing mapping ...");
 *   a route with no template ("Route template is missing or not tenant-owned");
 *   media headers: one asset bound to the sending number (resolved to its provider media id), one not bound (fails
 *     alone, in the same per-organization media call).
 * A second test pins the one deliberate difference: a plan-backed job whose plan is not its campaign's fails closed
 * in the batch, while the single-job resolver falls back to the live tables.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { eq, inArray } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMediaAssetsTable,
  campaignMediaProviderBindingsTable,
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

/** Template id -> a label that is the same in every copy of the fixture, so outcomes can be compared across copies. */
const templateLabels = new Map<number, string>();

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
  const newTemplate = async (label: string, body: string, components: unknown[]) => {
    const [row] = await db.insert(templatesTable).values({
      organizationId: orgId, wabaId: waba!.id, name: `${slug}-${label}`, status: "Approved", language: "en_US", body, components,
    }).returning();
    templateLabels.set(row!.id, label);
    return row!;
  };
  const template = await newTemplate("t", "Hi {{1}}", [{ type: "BODY", text: "Hi {{1}}" }]);
  const unselected = await newTemplate("u", "Other {{1}}", [{ type: "BODY", text: "Other {{1}}" }]);
  const twoVariables = await newTemplate("two", "Hi {{1}} {{2}}", [{ type: "BODY", text: "Hi {{1}} {{2}}" }]);
  const withImage = await newTemplate("image", "Look {{1}}", [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Look {{1}}" }]);
  const lease = (n: number) => `${slug}-lease-${n}`;

  async function campaign(name: string, options: { plan?: "active-only" | "frozen"; template?: typeof template | null; mappings?: Array<{ component: string; variable: string; source: string; sourceValue: string }> } = {}) {
    const routeTemplate = options.template === undefined ? template : options.template;
    const [row] = await db.insert(campaignsTable).values({ organizationId: orgId, name: `${slug}-${name}`, status: "Running" }).returning();
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: orgId, campaignId: row!.id, phoneNumberId: phone!.id, templateId: routeTemplate?.id ?? null, configuredTps: 100,
    }).returning();
    if (routeTemplate) {
      await db.insert(campaignTemplateSelectionsTable).values({ organizationId: orgId, campaignId: row!.id, templateId: routeTemplate.id });
      for (const mapping of options.mappings ?? [{ component: "body", variable: "1", source: "csv", sourceValue: "name" }]) {
        await db.insert(campaignTemplateMappingsTable).values({ organizationId: orgId, campaignId: row!.id, templateId: routeTemplate.id, ...mapping });
      }
    }
    let planId: number | null = null;
    if (options.plan) {
      const [plan] = await db.insert(campaignPlansTable).values({
        organizationId: orgId, campaignId: row!.id, version: 1, allocatorVersion: "trb-v1", partitionCount: 64,
        routes: [{ routeId: route!.id, phoneNumberId: phone!.id, templateId: template.id, configuredTps: 100, providerTpsLimit: 100, phone: phone!.phone, displayName: slug }],
        templateIds: [template.id],
        // The snapshot body differs from the live template: proves which source resolved the job.
        templatesSnapshot: [{ id: template.id, name: template.name, language: "en_US", wabaId: waba!.id, body: "Frozen {{1}}", components: [{ type: "BODY", text: "Frozen {{1}}" }] }],
        mappingsSnapshot: [{ templateId: template.id, component: "body", variable: "1", source: "static", sourceValue: "from-plan" }],
        status: "Active",
      } as typeof campaignPlansTable.$inferInsert).returning();
      planId = plan!.id;
    }
    return { campaign: row!, route: route!, planId: options.plan === "frozen" ? planId : null };
  }
  let otherCampaignRow: typeof campaignsTable.$inferSelect | undefined;
  async function otherCampaign() {
    otherCampaignRow ??= (await db.insert(campaignsTable).values({ organizationId: other!.id, name: `${slug}-x`, status: "Running" }).returning())[0];
    return otherCampaignRow!;
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
  async function mediaAsset(c: Awaited<ReturnType<typeof campaign>>, name: string, bound: boolean) {
    const sha256 = `${slug}-${name}-sha`;
    const [asset] = await db.insert(campaignMediaAssetsTable).values({
      organizationId: orgId, campaignId: c.campaign.id, fileName: `${name}.png`, contentType: "image/png", byteLength: 10,
      kind: "image", storageKey: `${slug}/${name}`, sha256, status: "ready",
    }).returning();
    if (bound) {
      await db.insert(campaignMediaProviderBindingsTable).values({
        organizationId: orgId, mediaAssetId: asset!.id, phoneNumberId: phone!.id, transport: "mock", providerMediaId: `mock-media-${name}`,
        sha256, uploadedAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    }
    return asset!;
  }

  const legacy = await campaign("legacy");
  const withActivePlan = await campaign("active-plan", { plan: "active-only" });
  const plannedA = await campaign("planned-a", { plan: "frozen" });
  const plannedB = await campaign("planned-b", { plan: "frozen" });
  const unmapped = await campaign("unmapped", { template: twoVariables });
  const noTemplate = await campaign("no-template", { template: null });
  const mediaBound = await campaign("media-bound", { template: withImage, mappings: [{ component: "body", variable: "1", source: "csv", sourceValue: "name" }] });
  const mediaUnbound = await campaign("media-unbound", { template: withImage, mappings: [{ component: "body", variable: "1", source: "csv", sourceValue: "name" }] });
  const boundAsset = await mediaAsset(mediaBound, "bound", true);
  const unboundAsset = await mediaAsset(mediaUnbound, "unbound", false);
  await db.insert(campaignTemplateMappingsTable).values([
    { organizationId: orgId, campaignId: mediaBound.campaign.id, templateId: withImage.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(boundAsset.id) },
    { organizationId: orgId, campaignId: mediaUnbound.campaign.id, templateId: withImage.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(unboundAsset.id) },
  ]);
  const jobs = [
    await job(legacy, 1),
    await job(legacy, 2, { contactOrg: other!.id }),
    await job(legacy, 3, { data: { other: "x" } }),
    await job(legacy, 4, { templateId: unselected.id }),
    await job(legacy, 5),
    await job(legacy, 6, { leased: false }),
    await job(withActivePlan, 7),
    await job(plannedA, 8, { planned: true }),
    await job(plannedB, 9, { planned: true }),
    await job(legacy, 10),
    await job(plannedA, 11, { planned: true }),
    await job(plannedA, 12, { planned: true, contactOrg: other!.id }),
    await job(unmapped, 13),
    await job(noTemplate, 14),
    await job(mediaBound, 15),
    await job(mediaUnbound, 16),
  ];
  // Jobs 5 and 11 have their lease replaced after the claim (another owner took them over): their fenced write must
  // not apply. Job 11 is inside a plan-backed group, next to a valid job (8) and a foreign contact (12).
  for (const index of [4, 10]) {
    await db.update(campaignJobsTable).set({ leaseToken: `${slug}-lease-${index + 1}-newer` }).where(eq(campaignJobsTable.id, jobs[index]!.id));
  }
  return { jobs, legacy, plannedA, plannedB, phone: phone!, orgId, slug };
}

/** What callers depend on: the error text, or the resolved payload's template, parameters and media, and the stored payload. */
async function normalize(jobs: CampaignJob[], outcomes: Array<{ resolvedJob?: CampaignJob; error?: unknown }>) {
  const stored = new Map((await db.select({ id: campaignJobsTable.id, payload: campaignJobsTable.payload }).from(campaignJobsTable)
    .where(inArray(campaignJobsTable.id, jobs.map((job) => job.id)))).map((row) => [row.id, row.payload as Record<string, unknown>]));
  return outcomes.map((outcome, index) => {
    const storedPayload = stored.get(jobs[index]!.id)!;
    if (outcome.error !== undefined) {
      return { error: outcome.error instanceof Error ? outcome.error.message.replace(/\d+/g, "#") : String(outcome.error), storedResolved: "resolvedParameters" in storedPayload };
    }
    const payload = outcome.resolvedJob!.payload as { templateId?: number; resolvedParameters?: { headerMedia?: { assetId?: string; id?: string } } };
    const media = payload.resolvedParameters?.headerMedia;
    return {
      template: typeof payload.templateId === "number" ? templateLabels.get(payload.templateId) ?? "unknown" : "none",
      resolvedParameters: { ...payload.resolvedParameters, headerMedia: media ? { bound: typeof media.id === "string" && media.id.startsWith("mock-media-") } : undefined },
      storedTemplate: typeof storedPayload.templateId === "number" ? templateLabels.get(storedPayload.templateId) ?? "unknown" : "none",
      storedMatchesReturned: isDeepStrictEqual(storedPayload.resolvedParameters, payload.resolvedParameters),
      leaseToken: outcome.resolvedJob!.leaseToken === jobs[index]!.leaseToken,
      configuredTps: outcome.resolvedJob!.configuredTps === jobs[index]!.configuredTps,
    };
  });
}

const single = (jobs: CampaignJob[]) => Promise.all(jobs.map(async (job) => {
  try { return { resolvedJob: await resolveJobTemplate(job) }; } catch (error) { return { error }; }
}));

test("one batch spanning two organizations and many campaigns resolves exactly as the single-job resolver resolves each job", async () => {
  const batchA = await fixture("batch-a");
  const batchB = await fixture("batch-b");
  const singleA = await fixture("single-a");
  const singleB = await fixture("single-b");
  const batchJobs = [...batchA.jobs, ...batchB.jobs];
  const singleJobs = [...singleA.jobs, ...singleB.jobs];
  const batch = await resolveJobTemplates(batchJobs);
  const one = await single(singleJobs);
  const batchView = await normalize(batchJobs, batch);
  const singleView = await normalize(singleJobs, one);
  assert.deepEqual(batchView, singleView);
  assert.equal(batch.length, batchJobs.length);
  batch.forEach((outcome, index) => assert.equal(outcome.job.id, batchJobs[index]!.id, "results come back in input order"));

  // The cases really cover each branch, in both organizations.
  for (const offset of [0, 16]) {
    const view = (index: number) => batchView[offset + index]!;
    const error = (index: number) => ("error" in view(index) ? (view(index) as { error: string }).error : null);
    const parameters = (index: number) => (view(index) as { resolvedParameters: unknown }).resolvedParameters;
    const templateOf = (index: number) => (view(index) as { template: string }).template;
    assert.deepEqual(parameters(0), { header: {}, body: { "1": "Name 1" }, button: {}, headerMedia: undefined });
    assert.equal(templateOf(0), "t");
    assert.equal(error(1), "Campaign contact is missing or not tenant-owned");
    assert.equal(error(2), "Mapping body:# resolved to an empty value");
    assert.equal(error(3), "Route template # is not selected");
    assert.equal(error(4), "Job lease was revoked before template resolution");
    assert.equal(error(5), "Template resolution requires an active job lease");
    assert.deepEqual(parameters(6), { header: {}, body: { "1": "from-plan" }, button: {}, headerMedia: undefined },
      "a legacy job of a campaign with an Active plan resolves from that plan's snapshot");
    for (const index of [7, 8]) {
      assert.deepEqual(parameters(index), { header: {}, body: { "1": "from-plan" }, button: {}, headerMedia: undefined },
        "plan-backed jobs of two campaigns in one batch resolve from their frozen plans");
      assert.equal(templateOf(index), "t");
    }
    assert.equal(error(10), "Job lease was revoked before template resolution", "a revoked lease inside a plan-backed group fails alone");
    assert.equal(error(11), "Campaign contact is missing or not tenant-owned", "a foreign contact inside a plan-backed group fails alone");
    assert.equal(error(12), "Missing mapping body:# for template #");
    assert.equal(error(13), "Route template is missing or not tenant-owned");
    assert.deepEqual(parameters(14), { header: {}, body: { "1": "Name 15" }, button: {}, headerMedia: { bound: true } },
      "a media header resolves to the provider media id bound to the sending number");
    assert.equal(templateOf(14), "image");
    assert.equal(error(15), "Campaign media # is not prepared for this sending number; plan the campaign again",
      "an unbound media asset fails alone in the same per-organization media call");
  }
  assert.ok(batchView.every((view) => !("error" in view) || view.storedResolved === false), "a failed job's stored payload is untouched");
  assert.ok(batchView.every((view) => "error" in view || (view.storedMatchesReturned && view.storedTemplate === view.template)),
    "every resolved job's stored payload is the one returned");
});

test("a plan-backed job whose plan is not its campaign's fails closed in the batch (the single-job resolver falls back to the live tables)", async () => {
  const f = await fixture("foreign-plan");
  // Job 8 (planned-a) is pointed at planned-b's plan: a plan exists, but not for the job's campaign.
  const job = { ...f.jobs[7]!, planId: f.plannedB.planId };
  await db.update(campaignJobsTable).set({ planId: f.plannedB.planId }).where(eq(campaignJobsTable.id, job.id));
  const [batched] = await resolveJobTemplates([job]);
  assert.ok(batched!.error instanceof Error);
  assert.equal(batched!.error.message, "Frozen campaign plan is missing or not tenant-owned");
  assert.equal(batched!.resolvedJob, undefined);
  const [row] = await db.select({ payload: campaignJobsTable.payload }).from(campaignJobsTable).where(eq(campaignJobsTable.id, job.id));
  assert.ok(!("resolvedParameters" in (row!.payload as Record<string, unknown>)), "nothing is written for a job that fails closed");
  // The documented difference (template-resolution.ts, resolveJobTemplates): the one-job path uses the live tables.
  const resolved = await resolveJobTemplate(job);
  assert.deepEqual((resolved.payload as { resolvedParameters: unknown }).resolvedParameters, { header: {}, body: { "1": "Name 8" }, button: {} });
});
