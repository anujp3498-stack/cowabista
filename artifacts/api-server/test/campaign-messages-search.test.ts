import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  providerMessagesTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import campaignEngineRouter from "../src/routes/campaign-engine";

// POST .../campaigns/:id/messages/search backs the "Delivery log" dialog --
// the only place a manager can see exactly which recipients failed and why.
// This exercises the real handler end-to-end: org isolation, the status
// filter, and that `search` matches phone number AND job/provider error
// reasons (so support can find "who hit template_paused" without knowing a
// phone number up front).

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.send = (body?: unknown) => { res.body = body; return res; };
  return res;
}

async function seedOrg(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(4, "0")}${Math.floor(Math.random() * 900 + 100)}`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: slug, status: "Approved",
    body: "Hi", components: [{ type: "BODY", text: "Hi" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 5,
  }).returning();
  return { organization, phone, template, campaign, route };
}

after(async () => {
  await pool.end();
});

test("POST .../messages/search filters by status, matches phone or error reason, and paginates within one org", async () => {
  const slug = `msg-search-${process.pid}-${Date.now()}`;
  const { organization, campaign, route, template } = await seedOrg(slug);

  const [contactA] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
    rawPhone: "+15551110001", normalizedPhone: "+15551110001", status: "Valid",
    idempotencyKey: `${slug}-c1`,
  }).returning();
  const [contactB] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 2,
    rawPhone: "+15552220002", normalizedPhone: "+15552220002", status: "Valid",
    idempotencyKey: `${slug}-c2`,
  }).returning();
  const [contactC] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 3,
    rawPhone: "+15553330003", normalizedPhone: "+15553330003", status: "Valid",
    idempotencyKey: `${slug}-c3`,
  }).returning();

  const [jobSent] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contactA.id,
    templateId: template.id, type: "ResolveTemplateAndSend", status: "Sent", idempotencyKey: `${slug}-j1`,
  }).returning();
  const [jobFailedJobLevel] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contactB.id,
    templateId: template.id, type: "ResolveTemplateAndSend", status: "Failed", errorReason: "template_paused",
    idempotencyKey: `${slug}-j2`,
  }).returning();
  const [jobFailedProviderLevel] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contactC.id,
    templateId: template.id, type: "ResolveTemplateAndSend", status: "Failed", idempotencyKey: `${slug}-j3`,
  }).returning();
  await db.insert(providerMessagesTable).values({
    organizationId: organization.id, campaignJobId: jobFailedProviderLevel.id, provider: "mock",
    requestKey: `${slug}-req-3`, status: "failed", errorReason: "recipient_number_invalid",
  });

  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/messages/search", "post");

    // Default (no filters): all 3 jobs for this campaign.
    const resAll = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: {} }, resAll);
    assert.equal(resAll.statusCode, 200, JSON.stringify(resAll.body));
    assert.equal(resAll.body.total, 3);

    // Status filter: only Failed jobs.
    const resFailed = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { status: "Failed" } }, resFailed);
    assert.equal(resFailed.statusCode, 200);
    assert.equal(resFailed.body.total, 2);
    const failedJobIds = resFailed.body.messages.map((m: { jobId: number }) => m.jobId).sort();
    assert.deepEqual(failedJobIds, [jobFailedJobLevel.id, jobFailedProviderLevel.id].sort());

    // Search by phone number.
    const resByPhone = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { search: "5551110001" } }, resByPhone);
    assert.equal(resByPhone.body.total, 1);
    assert.equal(resByPhone.body.messages[0].jobId, jobSent.id);

    // Search by job-level error reason (support looking up "who hit this error").
    const resByJobReason = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { search: "template_paused" } }, resByJobReason);
    assert.equal(resByJobReason.body.total, 1);
    assert.equal(resByJobReason.body.messages[0].jobId, jobFailedJobLevel.id);

    // Search by provider-level error reason.
    const resByProviderReason = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { search: "recipient_number_invalid" } }, resByProviderReason);
    assert.equal(resByProviderReason.body.total, 1);
    assert.equal(resByProviderReason.body.messages[0].jobId, jobFailedProviderLevel.id);
    assert.equal(resByProviderReason.body.messages[0].providerErrorReason, "recipient_number_invalid");

    // Pagination: limit 1 returns one row and reports the true total.
    const resPage = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { limit: 1, offset: 0 } }, resPage);
    assert.equal(resPage.body.messages.length, 1);
    assert.equal(resPage.body.total, 3);
    assert.equal(resPage.body.limit, 1);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("POST .../messages/search never returns another organization's jobs", async () => {
  const slugA = `msg-search-isoA-${process.pid}-${Date.now()}`;
  const slugB = `msg-search-isoB-${process.pid}-${Date.now()}`;
  const orgA = await seedOrg(slugA);
  const orgB = await seedOrg(slugB);

  const [contactA] = await db.insert(campaignContactsTable).values({
    organizationId: orgA.organization.id, campaignId: orgA.campaign.id, rowNumber: 1,
    rawPhone: "+15559990001", normalizedPhone: "+15559990001", status: "Valid",
    idempotencyKey: `${slugA}-c1`,
  }).returning();
  const [contactB] = await db.insert(campaignContactsTable).values({
    organizationId: orgB.organization.id, campaignId: orgB.campaign.id, rowNumber: 1,
    rawPhone: "+15559990002", normalizedPhone: "+15559990002", status: "Valid",
    idempotencyKey: `${slugB}-c1`,
  }).returning();
  await db.insert(campaignJobsTable).values({
    organizationId: orgA.organization.id, campaignId: orgA.campaign.id, routeId: orgA.route.id, contactId: contactA.id,
    templateId: orgA.template.id, type: "ResolveTemplateAndSend", status: "Sent", idempotencyKey: `${slugA}-j1`,
  });
  await db.insert(campaignJobsTable).values({
    organizationId: orgB.organization.id, campaignId: orgB.campaign.id, routeId: orgB.route.id, contactId: contactB.id,
    templateId: orgB.template.id, type: "ResolveTemplateAndSend", status: "Sent", idempotencyKey: `${slugB}-j1`,
  });

  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/messages/search", "post");
    const res = fakeResponse();
    await handler({ params: { organizationId: String(orgA.organization.id), campaignId: String(orgA.campaign.id) }, body: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.messages[0].phone, "+15559990001");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.organization.id));
  }
});
