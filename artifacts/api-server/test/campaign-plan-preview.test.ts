import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { planCampaign } from "../src/services/campaign-planning";
import { getActivePlanSummary, PlanPreviewNotFoundError, previewPlanContact, searchPlanRecipients } from "../src/services/campaign-plan-preview";
import campaignEngineRouter from "../src/routes/campaign-engine";

// These tests prove the support/ops "what will this plan send" view reads
// the same frozen snapshot the real send path resolves against (see
// campaign-frozen-template-mutation.test.ts for the equivalent guarantee on
// the job-resolution side), and that it degrades to a clear 404 rather than
// a stack trace for every "nothing to show yet" case support will hit.

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

async function setUpPlannedCampaign(slug: string, { withMapping = true } = {}) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(4, "0")}${Math.floor(Math.random() * 900 + 100)}`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: slug, status: "Approved",
    body: "Hi {{1}}, your order {{2}} is ready", components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Draft" }).returning();
  await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 5,
  });
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization.id, campaignId: campaign.id, templateId: template.id });
  if (withMapping) {
    await db.insert(campaignTemplateMappingsTable).values([
      { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "1", source: "csv", sourceValue: "name" },
      { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "2", source: "static", sourceValue: "A1000" },
    ]);
  }
  if (withMapping) {
    await db.insert(contactImportSessionsTable).values({
      organizationId: organization.id, campaignId: campaign.id,
      idempotencyKey: `import-${campaign.id}`, fileName: "contacts.csv", status: "Completed", columns: ["name"],
    });
  }
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
    rawPhone: "+18880002222", normalizedPhone: "+18880002222", data: { name: "Priya" }, status: "Valid",
    idempotencyKey: `contact-${campaign.id}-1`,
  }).returning();
  await db.insert(campaignMetricsTable).values({ organizationId: organization.id, campaignId: campaign.id, total: 1, valid: 1 });

  return { organization, campaign, template, phone, contact: contact! };
}

test("getActivePlanSummary reflects the frozen routes/templates/mappings after planning, and is undefined before it", async () => {
  const slug = `plan-summary-${process.pid}-${Date.now()}`;
  const { organization, campaign, template, phone } = await setUpPlannedCampaign(slug);
  try {
    const before = await getActivePlanSummary(organization.id, campaign.id);
    assert.equal(before, undefined, "no active plan yet");

    await planCampaign(organization.id, campaign.id);
    const summary = await getActivePlanSummary(organization.id, campaign.id);
    assert.ok(summary);
    assert.equal(summary!.status, "Active");
    assert.equal(summary!.routes.length, 1);
    assert.equal(summary!.routes[0]!.phoneNumberId, phone.id);
    assert.equal(summary!.routes[0]!.phone, phone.phone);
    assert.equal(summary!.routes[0]!.templateId, template.id);
    assert.equal(summary!.templates.length, 1);
    assert.deepEqual(summary!.templates[0]!.requiredVariables.sort(), ["body:1", "body:2"]);
    assert.equal(summary!.mappings.length, 2);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("previewPlanContact resolves the exact rendered message a contact will receive, by contactId or phone", async () => {
  const slug = `plan-preview-${process.pid}-${Date.now()}`;
  const { organization, campaign, template, phone, contact } = await setUpPlannedCampaign(slug);
  try {
    await planCampaign(organization.id, campaign.id);

    const byId = await previewPlanContact(organization.id, campaign.id, { contactId: contact.id });
    assert.equal(byId.templateId, template.id);
    assert.equal(byId.phone, phone.phone);
    assert.deepEqual(byId.resolvedParameters.body, { "1": "Priya", "2": "A1000" });
    assert.equal(byId.renderedBody, "Hi Priya, your order A1000 is ready");
    assert.equal(byId.resolutionError, undefined);

    const byPhone = await previewPlanContact(organization.id, campaign.id, { phone: "+1 (888) 000-2222" });
    assert.equal(byPhone.contactId, contact.id);
    assert.equal(byPhone.renderedBody, "Hi Priya, your order A1000 is ready");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("previewPlanContact reports a resolution error instead of throwing when a since-edited CSV row breaks a mapping, but never falls back to the live template", async () => {
  const slug = `plan-preview-broken-${process.pid}-${Date.now()}`;
  const { organization, campaign, contact } = await setUpPlannedCampaign(slug);
  try {
    await planCampaign(organization.id, campaign.id);

    // Simulate the CSV-sourced value going missing after planning (e.g. a
    // manual data fix). Resolution must still be attempted against the
    // frozen template/mapping snapshot and report a clear error, not throw.
    await db.update(campaignContactsTable).set({ data: {} }).where(eq(campaignContactsTable.id, contact.id));

    const preview = await previewPlanContact(organization.id, campaign.id, { contactId: contact.id });
    assert.match(preview.resolutionError ?? "", /Missing mapping|resolved to an empty value/);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("previewPlanContact throws PlanPreviewNotFoundError for no plan, unknown contact, and un-allocated contact", async () => {
  const slug = `plan-preview-404-${process.pid}-${Date.now()}`;
  const { organization, campaign, contact } = await setUpPlannedCampaign(slug);
  try {
    await assert.rejects(
      previewPlanContact(organization.id, campaign.id, { contactId: contact.id }),
      PlanPreviewNotFoundError,
      "no active plan yet",
    );

    await planCampaign(organization.id, campaign.id);
    await assert.rejects(
      previewPlanContact(organization.id, campaign.id, { contactId: 999999999 }),
      PlanPreviewNotFoundError,
      "unknown contact",
    );

    const [otherOrg] = await db.insert(organizationsTable).values({ name: `${slug}-other`, slug: `${slug}-other` }).returning();
    try {
      await assert.rejects(
        previewPlanContact(otherOrg.id, campaign.id, { contactId: contact.id }),
        PlanPreviewNotFoundError,
        "cross-tenant lookup must not leak the contact",
      );
    } finally {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrg.id));
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET .../plan returns 404 before planning and 200 with the frozen snapshot after; POST .../plan/preview validates input and returns 404s as JSON errors", async () => {
  const slug = `plan-http-${process.pid}-${Date.now()}`;
  const { organization, campaign, contact } = await setUpPlannedCampaign(slug);
  try {
    const getPlan = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/plan", "get");
    const preview = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/plan/preview", "post");
    const params = { organizationId: String(organization.id), campaignId: String(campaign.id) };

    const notPlannedYet = fakeResponse();
    await getPlan({ params }, notPlannedYet, () => {});
    assert.equal(notPlannedYet.statusCode, 404);

    const missingBoth = fakeResponse();
    await preview({ params, body: {} }, missingBoth, () => {});
    assert.equal(missingBoth.statusCode, 400);

    await planCampaign(organization.id, campaign.id);

    const planned = fakeResponse();
    await getPlan({ params }, planned, () => {});
    assert.equal(planned.statusCode, 200, JSON.stringify(planned.body));
    assert.equal(planned.body.routes.length, 1);

    const resolvedPreview = fakeResponse();
    await preview({ params, body: { contactId: contact.id } }, resolvedPreview, () => {});
    assert.equal(resolvedPreview.statusCode, 200, JSON.stringify(resolvedPreview.body));
    assert.equal(resolvedPreview.body.renderedBody, "Hi Priya, your order A1000 is ready");

    const unknownContact = fakeResponse();
    await preview({ params, body: { contactId: 999999999 } }, unknownContact, () => {});
    assert.equal(unknownContact.statusCode, 404);
    assert.ok(unknownContact.body.error);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("searchPlanRecipients pages and searches every recipient's resolved message under the active plan", async () => {
  const slug = `plan-recipients-${process.pid}-${Date.now()}`;
  const { organization, campaign, contact: priya } = await setUpPlannedCampaign(slug);
  const [amit] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 2,
    rawPhone: "+18880003333", normalizedPhone: "+18880003333", data: { name: "Amit" }, status: "Valid",
    idempotencyKey: `contact-${campaign.id}-2`,
  }).returning();
  try {
    await assert.rejects(
      searchPlanRecipients(organization.id, campaign.id, {}),
      PlanPreviewNotFoundError,
      "no active plan yet",
    );

    await planCampaign(organization.id, campaign.id);

    const page1 = await searchPlanRecipients(organization.id, campaign.id, { limit: 1, offset: 0 });
    assert.equal(page1.total, 2);
    assert.equal(page1.recipients.length, 1);
    assert.equal(page1.recipients[0]!.contactId, priya.id);
    assert.equal(page1.recipients[0]!.renderedBody, "Hi Priya, your order A1000 is ready");

    const page2 = await searchPlanRecipients(organization.id, campaign.id, { limit: 1, offset: 1 });
    assert.equal(page2.recipients.length, 1);
    assert.equal(page2.recipients[0]!.contactId, amit.id);
    assert.equal(page2.recipients[0]!.renderedBody, "Hi Amit, your order A1000 is ready");

    const byPhone = await searchPlanRecipients(organization.id, campaign.id, { search: "0003333" });
    assert.equal(byPhone.total, 1);
    assert.equal(byPhone.recipients[0]!.contactId, amit.id);

    const byCsvField = await searchPlanRecipients(organization.id, campaign.id, { search: "Priya" });
    assert.equal(byCsvField.total, 1);
    assert.equal(byCsvField.recipients[0]!.contactId, priya.id);

    const noMatch = await searchPlanRecipients(organization.id, campaign.id, { search: "nobody-matches-this" });
    assert.equal(noMatch.total, 0);
    assert.deepEqual(noMatch.recipients, []);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("POST .../plan/recipients returns the same paginated/searched result over HTTP, 404s with no active plan", async () => {
  const slug = `plan-recipients-http-${process.pid}-${Date.now()}`;
  const { organization, campaign, contact } = await setUpPlannedCampaign(slug);
  try {
    const search = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/plan/recipients", "post");
    const params = { organizationId: String(organization.id), campaignId: String(campaign.id) };

    const notPlannedYet = fakeResponse();
    await search({ params, body: {} }, notPlannedYet, () => {});
    assert.equal(notPlannedYet.statusCode, 404);

    await planCampaign(organization.id, campaign.id);

    const defaultPage = fakeResponse();
    await search({ params, body: {} }, defaultPage, () => {});
    assert.equal(defaultPage.statusCode, 200, JSON.stringify(defaultPage.body));
    assert.equal(defaultPage.body.total, 1);
    assert.equal(defaultPage.body.limit, 25);
    assert.equal(defaultPage.body.recipients[0].contactId, contact.id);
    assert.equal(defaultPage.body.recipients[0].renderedBody, "Hi Priya, your order A1000 is ready");

    const invalidLimit = fakeResponse();
    await search({ params, body: { limit: 0 } }, invalidLimit, () => {});
    assert.equal(invalidLimit.statusCode, 400);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test.after(async () => {
  await pool.end();
});
