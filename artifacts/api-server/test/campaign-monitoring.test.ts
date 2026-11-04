import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignJobsTable,
  campaignMetricsTable,
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

// GET .../campaigns/:id/monitoring backs the Rocket Engine screen's live
// send-progress panel. Its per-route query joins phone_numbers to read
// tps_limit but only grouped by campaign_routes.id -- Postgres only infers
// a selected column is functionally dependent on a GROUP BY column when
// that column is the SAME table's own primary key, so a joined table's
// column (phoneNumbersTable.tpsLimit) made every call to this endpoint
// fail with a 500 the moment more than zero routes existed. This test
// exercises the real handler end-to-end against a live route so any future
// change to that query is caught immediately rather than only surfacing in
// production once a route exists.

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

after(async () => {
  await pool.end();
});

test("GET .../monitoring succeeds (not a 500) once a campaign has a route, and reports sent/failed/pending counts", async () => {
  const slug = `monitoring-${process.pid}-${Date.now()}`;
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
  await db.insert(campaignMetricsTable).values({ organizationId: organization.id, campaignId: campaign.id, total: 3, valid: 3, sent: 1, failed: 1 });
  await db.insert(campaignJobsTable).values([
    { organizationId: organization.id, campaignId: campaign.id, routeId: route.id, templateId: template.id, type: "ResolveTemplateAndSend", status: "Sent", idempotencyKey: `${slug}-1` },
    { organizationId: organization.id, campaignId: campaign.id, routeId: route.id, templateId: template.id, type: "ResolveTemplateAndSend", status: "Failed", errorReason: "template_paused", idempotencyKey: `${slug}-2` },
  ]);

  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/monitoring", "get");
    const res = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) } }, res);

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.sent, 1);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.pending, 1);
    assert.equal(res.body.routes.length, 1);
    assert.equal(res.body.routes[0].routeId, route.id);
    assert.equal(res.body.routes[0].sent, 1);
    assert.equal(res.body.routes[0].failed, 1);
    assert.deepEqual(res.body.routes[0].errorReasons, { template_paused: 1 });
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET .../monitoring 404s for a campaign that doesn't exist under the org, and returns all-zero stats for one that exists but was never planned", async () => {
  const slug = `monitoring-empty-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Draft" }).returning();
  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/monitoring", "get");

    const resMissing = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: "999999999" } }, resMissing);
    assert.equal(resMissing.statusCode, 404);

    const resEmpty = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) } }, resEmpty);
    assert.equal(resEmpty.statusCode, 200);
    assert.equal(resEmpty.body.valid, 0);
    assert.equal(resEmpty.body.pending, 0);
    assert.deepEqual(resEmpty.body.routes, []);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET .../monitoring counts every job whose outcome needs manual review: delivery_unknown, and Failed with a pending intent", async () => {
  const slug = `monitoring-unknown-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1556${organization.id.toString().padStart(4, "0")}${Math.floor(Math.random() * 900 + 100)}`,
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
  await db.insert(campaignMetricsTable).values({ organizationId: organization.id, campaignId: campaign.id, total: 5, valid: 5 });
  // [job status, intent status]: only the first two need manual review.
  const cases = [
    ["Failed", "pending"], // Decision 2: failed for manual reconciliation, the earlier lease's intent still pending
    ["Failed", "delivery_unknown"],
    ["Failed", "rejected"], // the provider refused it: known not delivered
    ["Sent", "sent"],
    ["Processing", "pending"], // in flight: not (yet) unknown
  ] as const;
  for (const [index, [jobStatus, intentStatus]] of cases.entries()) {
    const [job] = await db.insert(campaignJobsTable).values({
      organizationId: organization.id, campaignId: campaign.id, routeId: route.id, templateId: template.id,
      type: "ResolveTemplateAndSend", status: jobStatus, idempotencyKey: `${slug}-${index}`,
    }).returning();
    await db.insert(providerMessagesTable).values({
      organizationId: organization.id, campaignJobId: job!.id, requestKey: `${slug}-rk-${index}`, status: intentStatus,
    });
  }
  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/monitoring", "get");
    const res = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.deliveryUnknown, 2, "delivery_unknown, and Failed with a pending intent");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});
