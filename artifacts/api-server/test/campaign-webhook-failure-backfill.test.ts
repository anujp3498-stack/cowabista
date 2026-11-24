import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
  suppressionsTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { processWhatsAppStatus } from "../src/services/whatsapp-webhook";
import analyticsRouter from "../src/routes/analytics";
import whatsappWebhookRouter from "../src/routes/whatsapp-webhook";

// Regression coverage for: WhatsApp very often reports a delivery failure
// via webhook *after* a message was already accepted ("sent"). The webhook
// handler recorded that reason on provider_events, but never backfilled
// provider_messages.errorReason -- so route-health analytics (which reads
// provider_messages.errorReason directly, coalesced to "Unknown error")
// permanently showed "Unknown error" for exactly these post-send failures,
// even though the real reason was sitting in the database the whole time.

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

async function seedSentMessage(slug: string, options: { wabaExternalId?: string; providerPhoneId?: string } = {}) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: options.wabaExternalId ?? `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(4, "0")}001`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10,
    ...(options.providerPhoneId ? { providerPhoneId: options.providerPhoneId } : {}),
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: slug, status: "Approved",
    body: "Hi", components: [{ type: "BODY", text: "Hi" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 5,
  }).returning();
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
    normalizedPhone: "+15551234567", status: "Valid", idempotencyKey: `${slug}-contact-1`,
  }).returning();
  const [job] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contact.id, templateId: template.id,
    type: "ResolveTemplateAndSend", status: "Sent", idempotencyKey: `${slug}-job-1`,
  }).returning();
  const [message] = await db.insert(providerMessagesTable).values({
    organizationId: organization.id, campaignJobId: job.id, requestKey: `${slug}-request-1`,
    providerMessageId: `wamid.${slug}`, status: "sent",
  }).returning();
  return { organization, phone, campaign, route, job, message };
}

test("a webhook failure reported after send backfills provider_messages.errorReason, and route-health stops showing Unknown error", async () => {
  const slug = `webhook-failure-${process.pid}-${Date.now()}`;
  const { organization, phone, message } = await seedSentMessage(slug);
  try {
    const outcome = await processWhatsAppStatus({
      eventId: `${message.providerMessageId}:failed:1`,
      messageId: message.providerMessageId!,
      status: "failed",
      occurredAt: new Date(),
      errorCode: "131026",
      errorReason: "recipient_unreachable",
    });
    assert.equal(outcome, "applied");

    const [updated] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, message.id));
    assert.equal(updated.status, "failed");
    assert.equal(
      updated.errorReason,
      "recipient_unreachable",
      "provider_messages.errorReason must be backfilled from the webhook event, not left null",
    );

    const [event] = await db.select().from(providerEventsTable).where(eq(providerEventsTable.providerMessageDbId, message.id));
    assert.equal(event.errorReason, "recipient_unreachable");

    // The actual bug this guards against: route-health's top-error-reasons
    // query reads provider_messages.errorReason directly (coalesced to
    // "Unknown error"). Confirm it now surfaces the real reason.
    const handler = findRouteHandler(analyticsRouter, "/analytics/route-health", "get");
    const res = fakeResponse();
    await handler({ organizationId: organization.id }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const entry = res.body.routes.find((r: { phoneNumberId: number }) => r.phoneNumberId === phone.id);
    assert.ok(entry, "expected a route-health entry for the seeded phone number");
    assert.equal(entry.failed, 1);
    assert.equal(entry.topErrorReasons[0]?.reason, "recipient_unreachable");
    assert.notEqual(entry.topErrorReasons[0]?.reason, "Unknown error");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("replaying the same webhook failure event is idempotent: no duplicate provider_events row and errorReason is unchanged", async () => {
  const slug = `webhook-failure-replay-${process.pid}-${Date.now()}`;
  const { organization, message } = await seedSentMessage(slug);
  try {
    const event = {
      eventId: `${message.providerMessageId}:failed:1`,
      messageId: message.providerMessageId!,
      status: "failed" as const,
      occurredAt: new Date(),
      errorCode: "131026",
      errorReason: "recipient_unreachable",
    };
    const first = await processWhatsAppStatus(event);
    const second = await processWhatsAppStatus(event);
    assert.equal(first, "applied");
    assert.equal(second, "duplicate");

    const events = await db.select().from(providerEventsTable).where(eq(providerEventsTable.providerMessageDbId, message.id));
    assert.equal(events.length, 1, "replaying the same webhook event must not create a second provider_events row");

    const [updated] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, message.id));
    assert.equal(updated.errorReason, "recipient_unreachable");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("a webhook failure for one org never touches another org's provider_messages row", async () => {
  const slugA = `webhook-failure-orgA-${process.pid}-${Date.now()}`;
  const slugB = `webhook-failure-orgB-${process.pid}-${Date.now()}`;
  const orgA = await seedSentMessage(slugA);
  const orgB = await seedSentMessage(slugB);
  try {
    await processWhatsAppStatus({
      eventId: `${orgA.message.providerMessageId}:failed:1`,
      messageId: orgA.message.providerMessageId!,
      status: "failed",
      occurredAt: new Date(),
      errorReason: "recipient_unreachable",
    });

    const [updatedA] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, orgA.message.id));
    const [updatedB] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, orgB.message.id));
    assert.equal(updatedA.errorReason, "recipient_unreachable");
    assert.equal(updatedB.status, "sent");
    assert.equal(updatedB.errorReason, null);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.organization.id));
  }
});


test("V2-380: signed webhook status and STOP callbacks stay in their own workspaces when the Meta WABA is shared", async () => {
  const stamp = `shared-webhook-${process.pid}-${Date.now()}`;
  const wabaExternalId = `meta-waba-${stamp}`;
  const orgA = await seedSentMessage(`${stamp}-a`, {
    wabaExternalId, providerPhoneId: `meta-phone-${stamp}-a`,
  });
  const orgB = await seedSentMessage(`${stamp}-b`, {
    wabaExternalId, providerPhoneId: `meta-phone-${stamp}-b`,
  });
  const previousSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = `v2-380-test-secret-${stamp}`;
  try {
    const accounts = await db.select().from(wabasTable).where(eq(wabasTable.externalId, wabaExternalId));
    assert.equal(accounts.length, 2, "one external WABA is represented separately in each tenant");
    assert.notEqual(accounts[0]!.id, accounts[1]!.id);
    assert.deepEqual(
      new Set(accounts.map((account) => account.organizationId)),
      new Set([orgA.organization.id, orgB.organization.id]),
    );
    assert.notEqual(orgA.phone.providerPhoneId, orgB.phone.providerPhoneId);

    // Exercise the real signed HTTP webhook handler with two tenants using one Meta WABA.
    const handler = findRouteHandler(whatsappWebhookRouter, "/webhooks/whatsapp", "post");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const inbound = (messageId: string, phoneNumberId: string, from: string, status: string) => ({
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: phoneNumberId },
        statuses: [{ id: messageId, status, timestamp }],
        messages: [{ id: `stop-${messageId}`, from, type: "text", timestamp, text: { body: "STOP" } }],
      } }] }],
    });
    const deliver = async (payload: unknown, validSignature = true) => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const digest = createHmac("sha256", process.env.META_APP_SECRET!).update(body).digest("hex");
      const signature = `sha256=${validSignature ? digest : "0".repeat(64)}`;
      const response = fakeResponse();
      await handler({ body, headers: { "x-hub-signature-256": signature } }, response);
      return response;
    };

    const eventA = inbound(orgA.message.providerMessageId!, orgA.phone.providerPhoneId!, "15558881111", "delivered");
    const rejected = await deliver(eventA, false);
    assert.equal(rejected.statusCode, 401, "an invalid signature cannot modify either workspace");
    const [beforeA] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, orgA.message.id));
    assert.equal(beforeA!.status, "sent");

    const receivedA = await deliver(eventA);
    assert.equal(receivedA.statusCode, 200);
    assert.deepEqual(receivedA.body, { received: true });
    let [updatedA] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, orgA.message.id));
    let [updatedB] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, orgB.message.id));
    assert.equal(updatedA!.status, "delivered");
    assert.equal(updatedB!.status, "sent", "tenant B status must stay unchanged after tenant A webhook");
    let suppressedA = await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, orgA.organization.id));
    let suppressedB = await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, orgB.organization.id));
    assert.equal(suppressedA.length, 1);
    assert.equal(suppressedA[0]!.normalizedPhone, "+15558881111");
    assert.equal(suppressedB.length, 0, "tenant B must not receive tenant A's STOP");

    const eventB = inbound(orgB.message.providerMessageId!, orgB.phone.providerPhoneId!, "15558882222", "read");
    const receivedB = await deliver(eventB);
    assert.equal(receivedB.statusCode, 200);
    [updatedA] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, orgA.message.id));
    [updatedB] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, orgB.message.id));
    assert.equal(updatedA!.status, "delivered", "tenant B webhook must not alter tenant A status");
    assert.equal(updatedB!.status, "read");
    suppressedA = await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, orgA.organization.id));
    suppressedB = await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, orgB.organization.id));
    assert.equal(suppressedA.length, 1);
    assert.equal(suppressedB.length, 1);
    assert.equal(suppressedB[0]!.normalizedPhone, "+15558882222");

    // Duplicate delivery callbacks remain idempotent and never create new suppression rows.
    assert.equal((await deliver(eventA)).statusCode, 200);
    assert.equal((await db.select().from(providerEventsTable).where(eq(providerEventsTable.providerMessageDbId, orgA.message.id))).length, 1);
    assert.equal((await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, orgA.organization.id))).length, 1);
    assert.equal((await db.select().from(providerEventsTable).where(eq(providerEventsTable.providerMessageDbId, orgB.message.id))).length, 1);
    const [campaignA] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, orgA.campaign.id));
    const [campaignB] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, orgB.campaign.id));
    assert.equal(campaignA!.delivered, 1);
    assert.equal(campaignB!.delivered, 1);
    assert.equal(campaignA!.read, 0);
    assert.equal(campaignB!.read, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previousSecret;
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.organization.id));
  }
});
