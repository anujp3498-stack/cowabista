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

// Task #27: a manager needs to export a campaign's FULL delivery log as CSV,
// not just the current page shown in the "Delivery log" dialog. This
// exercises the real streaming handler end-to-end: it must keyset-paginate
// past a single internal page (proving it doesn't silently truncate a large
// campaign), include the same delivery/failure metadata the dialog shows
// (job status, attempts, job-level AND provider-level error reasons), and
// stay scoped to the right organization -- mirroring the same scale-safe,
// org-isolated pattern already proven for the rejected-rows import download.

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
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
  };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.setHeader = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; };
  res.write = (chunk: string) => { res.chunks.push(chunk); return true; };
  res.end = () => { res.ended = true; };
  res.text = () => res.chunks.join("");
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

test("GET .../messages/export.csv includes job status, attempts, and both job-level and provider-level failure reasons", async () => {
  const slug = `msg-export-${process.pid}-${Date.now()}`;
  const { organization, campaign, route, template, phone } = await seedOrg(slug);

  const [contactSent] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
    rawPhone: "+15551110001", normalizedPhone: "+15551110001", status: "Valid",
    idempotencyKey: `${slug}-c1`,
  }).returning();
  const [contactFailedJob] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 2,
    rawPhone: "+15552220002", normalizedPhone: "+15552220002", status: "Valid",
    idempotencyKey: `${slug}-c2`,
  }).returning();
  const [contactFailedProvider] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 3,
    rawPhone: "+15553330003", normalizedPhone: "+15553330003", status: "Valid",
    idempotencyKey: `${slug}-c3`,
  }).returning();

  await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contactSent.id,
    templateId: template.id, type: "ResolveTemplateAndSend", status: "Sent", attempts: 1, idempotencyKey: `${slug}-j1`,
  });
  await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contactFailedJob.id,
    templateId: template.id, type: "ResolveTemplateAndSend", status: "Failed", attempts: 3,
    errorReason: "template_paused", idempotencyKey: `${slug}-j2`,
  });
  const [jobFailedProvider] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contactFailedProvider.id,
    templateId: template.id, type: "ResolveTemplateAndSend", status: "Failed", attempts: 1, idempotencyKey: `${slug}-j3`,
  }).returning();
  await db.insert(providerMessagesTable).values({
    organizationId: organization.id, campaignJobId: jobFailedProvider.id, provider: "mock",
    requestKey: `${slug}-req-3`, status: "failed", errorReason: "recipient_number_invalid",
  });

  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/messages/export.csv", "get");
    const res = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
    assert.match(res.headers["content-disposition"], /attachment; filename=".*delivery-log\.csv"/);
    assert.ok(res.ended);

    const lines = res.text().trim().split("\r\n");
    assert.equal(
      lines[0],
      "job_id,contact_phone,phone_number,template_name,job_status,attempts,max_attempts,job_error_reason,provider_status,provider_error_reason,provider_message_id,accepted_at,last_status_at",
    );
    assert.equal(lines.length, 4, "header + 3 jobs");
    assert.ok(lines.some((line) => line.includes("+15551110001") && line.includes("Sent") && line.includes(phone.phone)));
    assert.ok(lines.some((line) => line.includes("+15552220002") && line.includes("Failed") && line.includes("template_paused")));
    assert.ok(lines.some((line) => line.includes("+15553330003") && line.includes("recipient_number_invalid")));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET .../messages/export.csv streams past a single internal page for a large campaign without truncating", async () => {
  const slug = `msg-export-scale-${process.pid}-${Date.now()}`;
  const { organization, campaign, route, template } = await seedOrg(slug);

  // The handler pages internally at 2000 rows; seed past that boundary so
  // this proves the keyset cursor actually advances to a second page
  // instead of a naive implementation silently stopping at the first.
  const TOTAL = 2200;
  const contactRows = Array.from({ length: TOTAL }, (_, i) => ({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: i + 1,
    rawPhone: `+1555${String(4000000 + i).padStart(7, "0")}`, normalizedPhone: `+1555${String(4000000 + i).padStart(7, "0")}`,
    status: "Valid" as const, idempotencyKey: `${slug}-c${i}`,
  }));
  const contacts = await db.insert(campaignContactsTable).values(contactRows).returning({ id: campaignContactsTable.id });
  const jobRows = contacts.map((contact, i) => ({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contact.id,
    templateId: template.id, type: "ResolveTemplateAndSend" as const, status: "Sent" as const, attempts: 1,
    idempotencyKey: `${slug}-j${i}`,
  }));
  await db.insert(campaignJobsTable).values(jobRows);

  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/messages/export.csv", "get");
    const res = fakeResponse();
    await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) } }, res);

    assert.equal(res.statusCode, 200);
    const lines = res.text().trim().split("\r\n");
    assert.equal(lines.length, TOTAL + 1, "header + every job across both internal pages, none dropped or duplicated");
    const dataLines = lines.slice(1);
    const uniquePhones = new Set(dataLines.map((line) => line.split(",")[1]));
    assert.equal(uniquePhones.size, TOTAL, "no duplicate rows across the page boundary");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("GET .../messages/export.csv 404s for a campaign that does not belong to the requesting organization", async () => {
  const slugA = `msg-export-isoA-${process.pid}-${Date.now()}`;
  const slugB = `msg-export-isoB-${process.pid}-${Date.now()}`;
  const orgA = await seedOrg(slugA);
  const orgB = await seedOrg(slugB);

  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/messages/export.csv", "get");
    const res = fakeResponse();
    // Request orgA's campaign while authenticated/scoped as orgB.
    await handler({ params: { organizationId: String(orgB.organization.id), campaignId: String(orgA.campaign.id) } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.ended ?? false, false, "must not stream any data for a cross-org campaign");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.organization.id));
  }
});
