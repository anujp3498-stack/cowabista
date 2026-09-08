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
  providerEventsTable,
  providerMessagesTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import analyticsRouter from "../src/routes/analytics";

// The Analytics page (artifacts/wabista-nexus/src/pages/analytics.tsx) used to
// render hard-coded placeholder numbers and "Chart visualization placeholder"
// cards. These endpoints back real KPIs, a daily delivery-trend series, and a
// per-phone-number route health breakdown, all computed from provider_messages
// / provider_events rows that the WhatsApp webhook handler already writes.

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

async function seedOrgWithMessages(slug: string) {
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
  const contacts = await db.insert(campaignContactsTable).values([1, 2, 3, 4].map((n) => ({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: n,
    normalizedPhone: `+1555${n}`, status: "Valid", idempotencyKey: `${slug}-contact-${n}`,
  }))).returning();
  const jobs = await db.insert(campaignJobsTable).values([
    { organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contacts[0].id, templateId: template.id, type: "ResolveTemplateAndSend", status: "Sent", idempotencyKey: `${slug}-1` },
    { organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contacts[1].id, templateId: template.id, type: "ResolveTemplateAndSend", status: "Sent", idempotencyKey: `${slug}-2` },
    { organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contacts[2].id, templateId: template.id, type: "ResolveTemplateAndSend", status: "Failed", idempotencyKey: `${slug}-3` },
    { organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contacts[3].id, templateId: template.id, type: "ResolveTemplateAndSend", status: "Sent", idempotencyKey: `${slug}-4` },
  ]).returning();
  return { organization, phone, campaign, route, jobs };
}

test("GET /analytics/summary computes delivery/read/failure rates from real provider_messages rows, scoped to the org", async () => {
  const slug = `analytics-summary-${process.pid}-${Date.now()}`;
  const { organization, jobs } = await seedOrgWithMessages(slug);
  try {
    const now = new Date();
    await db.insert(providerMessagesTable).values([
      { organizationId: organization.id, campaignJobId: jobs[0].id, requestKey: `${slug}-1`, status: "delivered", acceptedAt: now },
      { organizationId: organization.id, campaignJobId: jobs[1].id, requestKey: `${slug}-2`, status: "read", acceptedAt: now },
      { organizationId: organization.id, campaignJobId: jobs[2].id, requestKey: `${slug}-3`, status: "failed", errorReason: "template_paused", acceptedAt: now },
      { organizationId: organization.id, campaignJobId: jobs[3].id, requestKey: `${slug}-4`, status: "sent", acceptedAt: now },
    ]);

    const handler = findRouteHandler(analyticsRouter, "/analytics/summary", "get");
    const res = fakeResponse();
    await handler({ organizationId: organization.id }, res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.totalSent, 4);
    // delivered+read = 2 of 4 => 50%
    assert.equal(res.body.deliveryRate, 50);
    // read = 1 of 4 => 25%
    assert.equal(res.body.readRate, 25);
    // failed = 1 of 4 => 25%
    assert.equal(res.body.failureRate, 25);
    assert.equal(res.body.activeRoutes, 1);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET /analytics/summary returns all-zero rates (never divides by zero) for an org with no messages yet", async () => {
  const slug = `analytics-summary-empty-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  try {
    const handler = findRouteHandler(analyticsRouter, "/analytics/summary", "get");
    const res = fakeResponse();
    await handler({ organizationId: organization.id }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalSent, 0);
    assert.equal(res.body.deliveryRate, 0);
    assert.equal(res.body.readRate, 0);
    assert.equal(res.body.failureRate, 0);
    assert.equal(res.body.activeRoutes, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET /analytics/delivery-trends buckets sent counts by acceptedAt day and delivered/read/failed counts by provider event day, dense over the requested window", async () => {
  const slug = `analytics-trends-${process.pid}-${Date.now()}`;
  const { organization, jobs } = await seedOrgWithMessages(slug);
  try {
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    const [msg1] = await db.insert(providerMessagesTable).values({
      organizationId: organization.id, campaignJobId: jobs[0].id, requestKey: `${slug}-1`,
      providerMessageId: `${slug}-wamid-1`, status: "delivered", acceptedAt: today,
    }).returning();
    await db.insert(providerMessagesTable).values({
      organizationId: organization.id, campaignJobId: jobs[1].id, requestKey: `${slug}-2`,
      status: "sent", acceptedAt: yesterday,
    });
    await db.insert(providerEventsTable).values({
      organizationId: organization.id, providerMessageDbId: msg1.id, campaignJobId: jobs[0].id,
      providerEventId: `${slug}-event-1`, providerMessageId: `${slug}-wamid-1`,
      eventType: "delivered", occurredAt: today,
    });

    const handler = findRouteHandler(analyticsRouter, "/analytics/delivery-trends", "get");
    const res = fakeResponse();
    await handler({ organizationId: organization.id, query: { days: "3" } }, res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.days.length, 3);
    const todayKey = today.toISOString().slice(0, 10);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    const todayBucket = res.body.days.find((d: { date: string }) => d.date === todayKey);
    const yesterdayBucket = res.body.days.find((d: { date: string }) => d.date === yesterdayKey);
    assert.ok(todayBucket, "today's bucket should be present in a dense 3-day window");
    assert.equal(todayBucket.sent, 1);
    assert.equal(todayBucket.delivered, 1);
    assert.equal(yesterdayBucket.sent, 1);
    assert.equal(yesterdayBucket.delivered, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET /analytics/route-health aggregates per phone number across all campaigns and ranks top error reasons, isolated per org", async () => {
  const slugA = `analytics-route-a-${process.pid}-${Date.now()}`;
  const slugB = `analytics-route-b-${process.pid}-${Date.now()}`;
  const orgA = await seedOrgWithMessages(slugA);
  const orgB = await seedOrgWithMessages(slugB);
  try {
    await db.insert(providerMessagesTable).values([
      { organizationId: orgA.organization.id, campaignJobId: orgA.jobs[0].id, requestKey: `${slugA}-1`, status: "delivered" },
      { organizationId: orgA.organization.id, campaignJobId: orgA.jobs[1].id, requestKey: `${slugA}-2`, status: "failed", errorReason: "template_paused" },
      { organizationId: orgA.organization.id, campaignJobId: orgA.jobs[2].id, requestKey: `${slugA}-3`, status: "failed", errorReason: "template_paused" },
      { organizationId: orgA.organization.id, campaignJobId: orgA.jobs[3].id, requestKey: `${slugA}-4`, status: "failed", errorReason: "recipient_unreachable" },
    ]);
    await db.insert(providerMessagesTable).values([
      { organizationId: orgB.organization.id, campaignJobId: orgB.jobs[0].id, requestKey: `${slugB}-1`, status: "delivered" },
    ]);

    const handler = findRouteHandler(analyticsRouter, "/analytics/route-health", "get");
    const res = fakeResponse();
    await handler({ organizationId: orgA.organization.id }, res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.routes.length, 1);
    const entry = res.body.routes[0];
    assert.equal(entry.phoneNumberId, orgA.phone.id);
    assert.equal(entry.sent, 4);
    assert.equal(entry.delivered, 1);
    assert.equal(entry.failed, 3);
    assert.equal(entry.failureRate, 75);
    assert.equal(entry.topErrorReasons[0].reason, "template_paused");
    assert.equal(entry.topErrorReasons[0].count, 2);
    assert.equal(entry.topErrorReasons[1].reason, "recipient_unreachable");
    assert.equal(entry.topErrorReasons[1].count, 1);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.organization.id));
  }
});
