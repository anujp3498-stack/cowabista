import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignJobsTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  providerMessagesTable,
} from "@workspace/db";
import phoneNumbersRouter from "../src/routes/phone-numbers";

// V2-375A0 temporary fail-closed guard. This uses the REAL DELETE handler
// and a disposable test organization, without calling any Meta API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findHandler(router: any) {
  for (const layer of router.stack) {
    if (layer.route?.path === "/phone-numbers/:phoneNumberId" && layer.route.methods.delete) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error("DELETE phone-number handler not found");
}

function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.send = (body?: unknown) => { res.body = body; return res; };
  return res;
}

const deletePhone = findHandler(phoneNumbersRouter);

test("DELETE phone refuses with 409 and preserves route, job, provider message and number", async () => {
  const slug = `v2-375-guard-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable)
    .values({ name: slug, slug }).returning();
  assert.ok(organization);
  try {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id,
      phone: "+15550005001",
      displayName: "Protected historical sender",
      status: "Connected",
    }).returning();
    const [campaign] = await db.insert(campaignsTable).values({
      organizationId: organization.id,
      name: "Completed history fixture",
      status: "Completed",
    }).returning();
    assert.ok(phone && campaign);
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id,
      campaignId: campaign.id,
      phoneNumberId: phone.id,
    }).returning();
    assert.ok(route);
    const [job] = await db.insert(campaignJobsTable).values({
      organizationId: organization.id,
      campaignId: campaign.id,
      routeId: route.id,
      type: "template",
      status: "Sent",
      idempotencyKey: `${slug}-job`,
    }).returning();
    assert.ok(job);
    const [providerMessage] = await db.insert(providerMessagesTable).values({
      organizationId: organization.id,
      campaignJobId: job.id,
      requestKey: `${slug}-request`,
      providerMessageId: `wamid.${slug}`,
      status: "accepted",
    }).returning();
    assert.ok(providerMessage);

    const response = fakeResponse();
    await deletePhone({ organizationId: organization.id, params: { phoneNumberId: String(phone.id) } }, response, () => {});
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, "phone_history_protected");

    const [retainedPhone] = await db.select({ id: phoneNumbersTable.id }).from(phoneNumbersTable).where(eq(phoneNumbersTable.id, phone.id));
    const [retainedRoute] = await db.select({ id: campaignRoutesTable.id }).from(campaignRoutesTable).where(eq(campaignRoutesTable.id, route.id));
    const [retainedJob] = await db.select({ id: campaignJobsTable.id }).from(campaignJobsTable).where(eq(campaignJobsTable.id, job.id));
    const [retainedProviderMessage] = await db.select({ id: providerMessagesTable.id }).from(providerMessagesTable).where(eq(providerMessagesTable.id, providerMessage.id));
    assert.ok(retainedPhone && retainedRoute && retainedJob && retainedProviderMessage);

    const unknown = fakeResponse();
    await deletePhone({ organizationId: organization.id, params: { phoneNumberId: "2147483647" } }, unknown, () => {});
    assert.equal(unknown.statusCode, 404);
  } finally {
    // Delete ONLY this disposable test organization; never run against production.
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

after(async () => { await pool.end(); });
