// Task #18: managers need to *see* readiness proactively on the Rocket
// Engine screen, not just discover it reactively after Plan fails with a
// 409. This proves GET .../campaigns/:id/readiness (a) reuses the exact
// same validateCampaignReady() rule set Plan enforces so it can never
// drift, (b) reports specific, actionable blocking issues for an
// unconfigured campaign, (c) reports ready:true with an empty error list
// once every rule passes, and (d) is scoped to the calling org like every
// other campaign-engine read.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
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
import { validateCampaignReady } from "../src/services/campaign-preflight";
import campaignEngineRouter from "../src/routes/campaign-engine";

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
  return res;
}

after(async () => {
  await pool.end();
});

test("GET .../readiness reports the exact blocking issues for an unconfigured campaign, matching validateCampaignReady", async () => {
  const slug = `readiness-blocked-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Draft" }).returning();
  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/readiness", "get");
    const res = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.campaignId, campaign.id);
    assert.equal(res.body.ready, false);
    const expected = await validateCampaignReady(organization.id, campaign.id);
    assert.deepEqual([...res.body.errors].sort(), [...expected].sort());
    assert.ok(res.body.errors.some((error: string) => /at least one sending route/i.test(error)), "a campaign with no routes must be flagged");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET .../readiness reports ready:true with no errors once every rule passes", async () => {
  const slug = `readiness-ready-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: slug, status: "Approved", language: "en_US",
    body: "Hi {{1}}", components: [{ type: "BODY", text: "Hi {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Draft" }).returning();
  await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 5,
  });
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization.id, campaignId: campaign.id, templateId: template.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "1", source: "static", sourceValue: "there",
  });
  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/readiness", "get");
    const res = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { campaignId: campaign.id, ready: true, errors: [] });
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET .../readiness is org-scoped: a route/template belonging to another tenant is invisible and still reports not ready", async () => {
  const slugA = `readiness-tenant-a-${process.pid}-${Date.now()}`;
  const slugB = `readiness-tenant-b-${process.pid}-${Date.now()}`;
  const [orgA] = await db.insert(organizationsTable).values({ name: slugA, slug: slugA }).returning();
  const [orgB] = await db.insert(organizationsTable).values({ name: slugB, slug: slugB }).returning();
  const [wabaB] = await db.insert(wabasTable).values({ organizationId: orgB.id, externalId: `${slugB}-waba`, displayName: slugB }).returning();
  const [phoneB] = await db.insert(phoneNumbersTable).values({
    organizationId: orgB.id, wabaId: wabaB.id, phone: `+1555${orgB.id.toString().padStart(7, "0")}`,
    displayName: `${slugB}-phone`, status: "Connected", tpsLimit: 10,
  }).returning();
  const [templateB] = await db.insert(templatesTable).values({
    organizationId: orgB.id, wabaId: wabaB.id, name: slugB, status: "Approved", language: "en_US",
    body: "Hi", components: [{ type: "BODY", text: "Hi" }],
  }).returning();
  // Campaign belongs to org A, but its route points at org B's phone/template
  // ids -- this must never resolve cross-tenant.
  const [campaignA] = await db.insert(campaignsTable).values({ organizationId: orgA.id, name: slugA, status: "Draft" }).returning();
  await db.insert(campaignRoutesTable).values({
    organizationId: orgA.id, campaignId: campaignA.id, phoneNumberId: phoneB.id, templateId: templateB.id, configuredTps: 5,
  });
  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/readiness", "get");
    const res = fakeResponse();
    await handler({ params: { organizationId: String(orgA.id), campaignId: String(campaignA.id) } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ready, false);
    assert.ok(res.body.errors.some((error: string) => /tenant-owned phone number/i.test(error)), "a cross-tenant phone id must not resolve as valid");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.id));
  }
});
