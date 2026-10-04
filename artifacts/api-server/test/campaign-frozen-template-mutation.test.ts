import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { planCampaign, type FrozenRoute } from "../src/services/campaign-planning";
import { resolveJobTemplate } from "../src/services/template-resolution";
import campaignEngineRouter from "../src/routes/campaign-engine";
import templatesRouter from "../src/routes/templates";

// These tests prove the frozen-plan guarantee holds against the actual HTTP
// route handlers that manage templates/selections/mappings -- not just
// direct database edits -- because those endpoints allow changes at any
// campaign status. A planned/executing job must keep resolving against the
// plan's own frozen template/mapping snapshot no matter what those
// endpoints do afterward. See campaignPlansTable's templatesSnapshot and
// template-resolution.ts's frozenTemplateForJob.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRouteHandler(router: any, path: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler registered for ${method.toUpperCase()} ${path}`);
}

function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.send = (body?: unknown) => { res.body = body; return res; };
  return res;
}

async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  return organization;
}

async function createWaba(organizationId: number, slug: string) {
  const [waba] = await db.insert(wabasTable).values({
    organizationId, externalId: `${slug}-waba`, displayName: slug,
  }).returning();
  return waba;
}

async function createPhone(organizationId: number, wabaId: number, slug: string, tpsLimit: number) {
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId, wabaId,
    phone: `+1555${organizationId.toString().padStart(4, "0")}${Math.floor(Math.random() * 900 + 100)}`,
    displayName: slug, status: "Connected", tpsLimit,
  }).returning();
  return phone;
}

async function createTemplate(organizationId: number, wabaId: number, slug: string, body: string) {
  const [template] = await db.insert(templatesTable).values({
    organizationId, wabaId, name: slug, status: "Approved", body,
    components: [{ type: "BODY", text: body }],
  }).returning();
  return template;
}

// Builds an already-leased ("Processing") job that mirrors exactly what
// executeCampaignPlan() would create for this campaign's one allocation
// (same organizationId/campaignId/routeId/contactId/configuredTps/templateId/
// planId shape -- see executeCampaignPlanLocked), but skips ever creating a
// real "Queued" job on a "Running" campaign. That matters here because the
// api-server process runs a real CampaignRuntime background worker against
// this same database (see campaign-runtime.ts), polling every 100ms and
// claiming any Queued job on any Running campaign cluster-wide; a genuinely
// executed job in these tests would be racing that live worker for the
// lease, which is exactly the kind of nondeterministic, environment-shared
// flakiness these tests must not have. Skipping straight to "Processing"
// keeps the test hermetic while still exercising the real frozen-plan
// snapshot (planCampaign() runs for real) and the real resolution code path
// (resolveJobTemplate() runs unmodified against this job).
async function setUpPlannedCampaign(slug: string) {
  const organization = await createOrganization(slug);
  const waba = await createWaba(organization.id, slug);
  const phone = await createPhone(organization.id, waba.id, slug, 10);
  const template = await createTemplate(organization.id, waba.id, slug, "Hello {{1}}");
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Draft" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 5,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization.id, campaignId: campaign.id, templateId: template.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
    component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
    rawPhone: "+18880001111", normalizedPhone: "+18880001111", data: {}, status: "Valid",
    idempotencyKey: `contact-${campaign.id}-1`,
  }).returning();
  await db.insert(campaignMetricsTable).values({ organizationId: organization.id, campaignId: campaign.id, total: 1, valid: 1 });

  const { plan } = await planCampaign(organization.id, campaign.id);
  const [allocation] = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.campaignId, campaign.id));
  assert.ok(allocation, "planCampaign must have allocated the one contact");
  const frozenRoute = (plan.routes as FrozenRoute[]).find((frozen) => frozen.routeId === allocation!.routeId);

  const [job] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    routeId: allocation!.routeId,
    contactId: contact!.id,
    configuredTps: frozenRoute?.configuredTps ?? null,
    templateId: frozenRoute?.templateId ?? null,
    planId: plan.id,
    type: "ResolveTemplateAndSend",
    idempotencyKey: `send:${contact!.idempotencyKey}`,
    payload: { contactId: contact!.id },
    status: "Processing",
    lockedAt: sql`statement_timestamp()`,
    lockedBy: "frozen-mutation-test-setup",
    leaseToken: randomUUID(),
    leaseExpiresAt: sql`statement_timestamp() + interval '30 seconds'`,
    attempts: 1,
  }).returning();
  assert.ok(job, "must have created an already-leased job");
  return { organization, campaign, template, route: route!, job: job! };
}

test("PUT template-mappings is refused once a job exists, and the already-planned job still resolves against its frozen plan", async () => {
  // V2-05B.1 contract change: this test used to assert that the legacy PUT
  // could replace the live selection/mappings at any status, even after a
  // job existed. That writer now obeys the campaign setup lifecycle
  // (assertSetupEditable), so with execution history the replacement is
  // refused (409 execution_history) and nothing changes. The frozen-plan
  // isolation this test protects is still asserted: the job resolves from
  // its own plan snapshot exactly as before.
  const slug = `frozen-mapping-put-${process.pid}-${Date.now()}`;
  const { organization, campaign, template, job } = await setUpPlannedCampaign(slug);
  try {
    const put = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/template-mappings", "put");
    const res = fakeResponse();
    await put(
      {
        params: { organizationId: String(organization.id), campaignId: String(campaign.id) },
        body: { templateIds: [], mappings: [] },
      },
      res,
      () => {},
    );
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal((res.body as { code?: string }).code, "execution_history");

    const selections = await db.select().from(campaignTemplateSelectionsTable).where(eq(campaignTemplateSelectionsTable.campaignId, campaign.id));
    assert.equal(selections.length, 1, "the live selection was not replaced");

    const resolved = await resolveJobTemplate(job);
    assert.equal((resolved.payload as { templateId: number }).templateId, template.id);
    assert.deepEqual((resolved.payload as { resolvedParameters: { body: Record<string, string> } }).resolvedParameters.body, { "1": "World" });
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("PATCH /templates/:id editing a template's body after planning does not change an already-planned job's resolution", async () => {
  const slug = `frozen-template-patch-${process.pid}-${Date.now()}`;
  const { organization, campaign, template, job } = await setUpPlannedCampaign(slug);
  try {
    // Edit the template's body to require a second variable that the
    // campaign never mapped -- if resolution depended on the live template
    // row, this would now fail to resolve.
    const patch = findRouteHandler(templatesRouter, "/templates/:templateId", "patch");
    const res = fakeResponse();
    await patch(
      {
        params: { templateId: String(template.id) },
        body: { body: "Hello {{1}}, your code is {{2}}" },
        organizationId: organization.id,
      },
      res,
      () => {},
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    const [liveTemplate] = await db.select().from(templatesTable).where(eq(templatesTable.id, template.id));
    assert.match(liveTemplate!.body, /\{\{2\}\}/, "the live template row must reflect the edit");

    // The already-planned job must still resolve using the frozen
    // single-variable body from the plan snapshot, not the live two-variable
    // body -- it must NOT throw "Missing mapping" for the new variable.
    const resolved = await resolveJobTemplate(job);
    assert.deepEqual((resolved.payload as { resolvedParameters: { body: Record<string, string> } }).resolvedParameters.body, { "1": "World" });
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("DELETE /templates/:id is fenced once the template has been allocated by a campaign plan", async () => {
  const slug = `frozen-template-delete-${process.pid}-${Date.now()}`;
  const { organization, campaign, template } = await setUpPlannedCampaign(slug);
  try {
    const del = findRouteHandler(templatesRouter, "/templates/:templateId", "delete");
    const res = fakeResponse();
    await del(
      { params: { templateId: String(template.id) }, organizationId: organization.id },
      res,
      () => {},
    );
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));

    const [stillThere] = await db.select().from(templatesTable).where(eq(templatesTable.id, template.id));
    assert.ok(stillThere, "the template must not have been deleted");

    const [jobAfter] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(jobAfter.templateId, template.id, "the job's frozen template reference must be untouched");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test.after(async () => {
  await pool.end();
});
