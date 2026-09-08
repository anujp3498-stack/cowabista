// Task #31: confirm a *real send* -- resolveJobTemplate() persisting
// per-contact variable values, then WhatsAppTemplateSender.send() building
// and handing off the actual Meta template payload -- applies the right
// header, body, and button values for a multi-component template, and that
// two different contacts on the same template each get their own values
// (never a shared/stale one).
//
// The mock provider client is deterministic
// (`wamid.mock_<sha256(phoneId:JSON.stringify(payload))>`), so recomputing
// that same hash over the *expected* payload and comparing it to the real
// `providerMessageId` returned by `send()` proves, byte-for-byte, exactly
// what request body the sender actually handed to the provider -- without
// needing to intercept or mock any internals.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
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
import { resolveJobTemplate } from "../src/services/template-resolution";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";

after(async () => {
  await pool.end();
});

function deterministicMockId(phoneId: string, payload: Record<string, unknown>): string {
  const value = `${phoneId}:${JSON.stringify(payload)}`;
  return `wamid.mock_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function expectedPayload(recipient: string, header: string, orderId: string, promoCode: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: {
      name: "fidelity-template",
      language: { code: "en_US" },
      components: [
        { type: "header", parameters: [{ type: "text", text: header }] },
        { type: "body", parameters: [{ type: "text", text: orderId }, { type: "text", text: "Acme Co" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: promoCode }] },
      ],
    },
  };
}

async function seedFidelityFixture(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10,
  }).returning();
  // A real multi-component template: HEADER (text, 1 dynamic var), BODY (2
  // dynamic vars), BUTTONS with one dynamic URL var at button index 0.
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: "fidelity-template", status: "Approved", language: "en_US",
    body: "Order {{1}} for {{2}}",
    components: [
      { type: "HEADER", format: "TEXT", text: "Hello {{1}}" },
      { type: "BODY", text: "Order {{1}} for {{2}}" },
      { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/promo/{{1}}" }] },
    ],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 10,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
  });
  await db.insert(campaignTemplateMappingsTable).values([
    { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "header", variable: "1", source: "csv", sourceValue: "headerName" },
    { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "1", source: "csv", sourceValue: "orderId" },
    { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "2", source: "static", sourceValue: "Acme Co" },
    { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "button", variable: "0:1", source: "csv", sourceValue: "promoCode" },
  ]);
  return { organization, phone, template, campaign, route };
}

async function makeClaimedJob(fixture: Awaited<ReturnType<typeof seedFidelityFixture>>, contactId: number, slug: string) {
  const [job] = await db.insert(campaignJobsTable).values({
    organizationId: fixture.organization.id, campaignId: fixture.campaign.id, routeId: fixture.route.id, contactId,
    templateId: fixture.template.id, type: "ResolveTemplateAndSend", status: "Processing", lockedBy: "test-worker",
    leaseToken: `${slug}-lease`, idempotencyKey: `${slug}-send`,
  }).returning();
  return job;
}

test("a real send resolves and applies the correct header/body/button values, and two contacts on the same template never share values", async () => {
  const slug = `fidelity-${process.pid}-${Date.now()}`;
  const fixture = await seedFidelityFixture(slug);
  try {
    const [contactA] = await db.insert(campaignContactsTable).values({
      organizationId: fixture.organization.id, campaignId: fixture.campaign.id, rowNumber: 1,
      rawPhone: "+15559990001", normalizedPhone: "+15559990001", status: "Valid",
      data: { headerName: "Alice", orderId: "ORD-1001", promoCode: "ALPHA10" },
      idempotencyKey: `${slug}-contact-a`,
    }).returning();
    const [contactB] = await db.insert(campaignContactsTable).values({
      organizationId: fixture.organization.id, campaignId: fixture.campaign.id, rowNumber: 2,
      rawPhone: "+15559990002", normalizedPhone: "+15559990002", status: "Valid",
      data: { headerName: "Bob Household", orderId: "ORD-2002", promoCode: "BETA99" },
      idempotencyKey: `${slug}-contact-b`,
    }).returning();

    const jobA = await makeClaimedJob(fixture, contactA.id, `${slug}-a`);
    const jobB = await makeClaimedJob(fixture, contactB.id, `${slug}-b`);

    const sender = new WhatsAppTemplateSender();

    const resolvedA = await resolveJobTemplate(jobA);
    // resolvedParameters must actually hold each component's variable,
    // keyed by variable number, straight off this contact's CSV row.
    assert.deepEqual(resolvedA.payload.resolvedParameters, {
      header: { "1": "Alice" }, body: { "1": "ORD-1001", "2": "Acme Co" }, button: { "0:1": "ALPHA10" },
    });
    const resultA = await sender.send(resolvedA, { signal: new AbortController().signal, idempotencyKey: resolvedA.idempotencyKey });
    const providerPhoneIdA = `mock-phone-${fixture.phone.id}-job-${jobA.id}`;
    assert.equal(
      resultA.providerMessageId,
      deterministicMockId(providerPhoneIdA, expectedPayload("+15559990001", "Alice", "ORD-1001", "ALPHA10")),
      "the exact Meta payload sent for contact A must carry contact A's own header/body/button values",
    );

    const resolvedB = await resolveJobTemplate(jobB);
    assert.deepEqual(resolvedB.payload.resolvedParameters, {
      header: { "1": "Bob Household" }, body: { "1": "ORD-2002", "2": "Acme Co" }, button: { "0:1": "BETA99" },
    });
    const resultB = await sender.send(resolvedB, { signal: new AbortController().signal, idempotencyKey: resolvedB.idempotencyKey });
    const providerPhoneIdB = `mock-phone-${fixture.phone.id}-job-${jobB.id}`;
    assert.equal(
      resultB.providerMessageId,
      deterministicMockId(providerPhoneIdB, expectedPayload("+15559990002", "Bob Household", "ORD-2002", "BETA99")),
      "the exact Meta payload sent for contact B must carry contact B's own header/body/button values, not contact A's",
    );
    assert.notEqual(resultA.providerMessageId, resultB.providerMessageId, "two contacts with different values must never collapse onto the same provider send");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("a real send fails closed instead of silently sending when a required template variable has no mapping", async () => {
  const slug = `fidelity-missing-${process.pid}-${Date.now()}`;
  const fixture = await seedFidelityFixture(slug);
  try {
    // Remove the button mapping entirely -- the template still requires it.
    await db.delete(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.templateId, fixture.template.id));
    await db.insert(campaignTemplateMappingsTable).values([
      { organizationId: fixture.organization.id, campaignId: fixture.campaign.id, templateId: fixture.template.id, component: "header", variable: "1", source: "csv", sourceValue: "headerName" },
      { organizationId: fixture.organization.id, campaignId: fixture.campaign.id, templateId: fixture.template.id, component: "body", variable: "1", source: "csv", sourceValue: "orderId" },
      { organizationId: fixture.organization.id, campaignId: fixture.campaign.id, templateId: fixture.template.id, component: "body", variable: "2", source: "static", sourceValue: "Acme Co" },
      // button:0:1 intentionally omitted
    ]);
    const [contact] = await db.insert(campaignContactsTable).values({
      organizationId: fixture.organization.id, campaignId: fixture.campaign.id, rowNumber: 1,
      rawPhone: "+15559990003", normalizedPhone: "+15559990003", status: "Valid",
      data: { headerName: "Carol", orderId: "ORD-3003", promoCode: "GAMMA1" },
      idempotencyKey: `${slug}-contact`,
    }).returning();
    const job = await makeClaimedJob(fixture, contact.id, slug);
    await assert.rejects(
      () => resolveJobTemplate(job),
      /Missing mapping button:0:1/,
      "a template variable with no configured mapping must throw, never send with a blank/undefined value",
    );
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});
