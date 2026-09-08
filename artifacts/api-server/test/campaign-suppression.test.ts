import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  suppressionsTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { ProviderRequestError } from "../src/services/whatsapp-provider";
import { parseWhatsAppOptOuts, processWhatsAppOptOut } from "../src/services/whatsapp-webhook";
import suppressionsRouter from "../src/routes/suppressions";

// Task #21: a suppressed/opted-out recipient must never actually be sent a
// campaign message, even if they opted out (or were manually suppressed)
// AFTER their contact row was imported. The enforcement point is
// WhatsAppTemplateSender.send() -- right before any provider handoff -- and
// the ingestion point is an inbound WhatsApp "STOP"-style reply parsed off
// the same webhook that already carries delivery-status callbacks.

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

async function seedSendableJob(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(4, "0")}${Math.floor(Math.random() * 900 + 100)}`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10,
    providerPhoneId: `${slug}-provider-phone`,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: slug, status: "Approved", language: "en_US",
    body: "Hi", components: [{ type: "BODY", text: "Hi" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 5,
  }).returning();
  const recipientPhone = "+15559990001";
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
    rawPhone: recipientPhone, normalizedPhone: recipientPhone, status: "Valid",
    idempotencyKey: `${slug}-contact`,
  }).returning();
  const [job] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contact.id,
    templateId: template.id, type: "ResolveTemplateAndSend", status: "Processing", idempotencyKey: `${slug}-job`,
  }).returning();
  return { organization, recipientPhone, job };
}

after(async () => {
  await pool.end();
});

test("send() blocks a contact suppressed mid-campaign, with a non-retryable Failed-style error", async () => {
  const slug = `suppress-send-${process.pid}-${Date.now()}`;
  const { organization, recipientPhone, job } = await seedSendableJob(slug);
  try {
    await db.insert(suppressionsTable).values({
      organizationId: organization.id, normalizedPhone: recipientPhone, reason: "Unsubscribed",
    });
    const sender = new WhatsAppTemplateSender();
    await assert.rejects(
      () => sender.send(job, { signal: new AbortController().signal }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError, `expected ProviderRequestError, got ${error}`);
        assert.equal((error as ProviderRequestError).retryable, false);
        assert.match((error as ProviderRequestError).message, /suppression list/i);
        return true;
      },
    );
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("send() still succeeds normally for a non-suppressed contact (regression)", async () => {
  const slug = `suppress-regression-${process.pid}-${Date.now()}`;
  const { organization, job } = await seedSendableJob(slug);
  try {
    const sender = new WhatsAppTemplateSender();
    const result = await sender.send(job, { signal: new AbortController().signal });
    assert.ok(result.providerMessageId, "expected a provider message id for an unsuppressed send");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("a STOP that commits while send() is waiting on the shared phone lock is never missed (race regression)", async () => {
  // Regression for the check-then-act suppression window: the authoritative
  // recheck now lives inside the same advisory-locked transaction that
  // reserves the provider send, keyed on the exact same org+phone lock a
  // STOP webhook takes. This proves a STOP that commits WHILE send() is
  // blocked waiting for that lock is still seen by send()'s recheck once it
  // acquires the lock -- the scenario the old early-only check could miss.
  const slug = `suppress-race-${process.pid}-${Date.now()}`;
  const { organization, recipientPhone, job } = await seedSendableJob(slug);
  try {
    const lockKey = `suppression-phone:${organization.id}:${recipientPhone}`;
    let signalHolding!: () => void;
    let releaseHold!: () => void;
    const holding = new Promise<void>((resolve) => { signalHolding = resolve; });
    const mayRelease = new Promise<void>((resolve) => { releaseHold = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      signalHolding();
      await mayRelease;
    });
    await holding;

    const sender = new WhatsAppTemplateSender();
    const sendPromise = sender.send(job, { signal: new AbortController().signal });
    // Give send() time to pass its early (non-authoritative) suppression
    // check -- which finds nothing yet -- and reach the reservation
    // transaction, where it now blocks waiting for the same lock `holder`
    // is holding.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The STOP arrives and commits here, while send() is still queued on
    // the lock -- after send()'s early check already passed.
    await db.insert(suppressionsTable).values({
      organizationId: organization.id, normalizedPhone: recipientPhone, reason: "STOP reply (race regression test)",
    });
    releaseHold();
    await holder;

    await assert.rejects(
      () => sendPromise,
      (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError, `expected ProviderRequestError, got ${error}`);
        assert.equal((error as ProviderRequestError).retryable, false);
        assert.match((error as ProviderRequestError).message, /suppression list/i);
        return true;
      },
      "send() must still catch a STOP that committed only after its early check passed",
    );
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("an inbound STOP reply is parsed and suppresses the sender for the receiving tenant", async () => {
  const slug = `optout-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const providerPhoneId = `${slug}-phone-id`;
  await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(4, "0")}001`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10, providerPhoneId,
  });
  try {
    const payload = {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: providerPhoneId },
        messages: [{ id: "wamid.stop1", from: "15559998888", type: "text", timestamp: `${Math.floor(Date.now() / 1000)}`, text: { body: "STOP" } }],
      } }] }],
    };
    const optOuts = parseWhatsAppOptOuts(payload);
    assert.equal(optOuts.length, 1);
    const outcome = await processWhatsAppOptOut(optOuts[0]);
    assert.equal(outcome, "suppressed");

    const [row] = await db.select().from(suppressionsTable).where(eq(suppressionsTable.organizationId, organization.id));
    assert.ok(row, "expected a suppression row to be created");
    assert.equal(row.normalizedPhone, "+15559998888");
    assert.match(row.reason, /STOP/);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("an ordinary inbound message is never treated as an opt-out", async () => {
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "irrelevant" },
      messages: [{ id: "wamid.hello1", from: "15559998888", type: "text", timestamp: `${Math.floor(Date.now() / 1000)}`, text: { body: "please stop by tomorrow" } }],
    } }] }],
  };
  assert.deepEqual(parseWhatsAppOptOuts(payload), []);
});

test("processWhatsAppOptOut reports unmatched for an unknown phone_number_id", async () => {
  const outcome = await processWhatsAppOptOut({
    eventId: "e1", phoneNumberId: "does-not-exist", from: "15559998888", text: "STOP", occurredAt: new Date(),
  });
  assert.equal(outcome, "unmatched");
});

test("suppressions CRUD: list, create, and delete are org-scoped", async () => {
  const slug = `suppress-crud-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  try {
    const createHandler = findRouteHandler(suppressionsRouter, "/suppressions", "post");
    const listHandler = findRouteHandler(suppressionsRouter, "/suppressions", "get");
    const deleteHandler = findRouteHandler(suppressionsRouter, "/suppressions/:suppressionId", "delete");

    const createRes = fakeResponse();
    await createHandler({ organizationId: organization.id, body: { phone: "+15558887777", reason: "Manual test" } }, createRes);
    assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
    const created = createRes.body;
    assert.equal(created.normalizedPhone, "+15558887777");

    const listRes = fakeResponse();
    await listHandler({ organizationId: organization.id, query: {} }, listRes);
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.total, 1);
    assert.equal(listRes.body.suppressions[0].id, created.id);

    const deleteRes = fakeResponse();
    await deleteHandler({ organizationId: organization.id, params: { suppressionId: String(created.id) } }, deleteRes);
    assert.equal(deleteRes.statusCode, 204);

    const listAfterRes = fakeResponse();
    await listHandler({ organizationId: organization.id, query: {} }, listAfterRes);
    assert.equal(listAfterRes.body.total, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});
