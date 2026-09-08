// Closes a coverage gap identified during the roadmap audit: the existing
// send-fidelity test proves header+body+button correctness for a SINGLE
// template, and the planning test proves multi-template contact allocation
// for BODY-only templates -- but nothing exercised a real send across two
// DIFFERENT templates, each with its own independent header+body+button
// mapping, in one campaign. This test closes exactly that gap: it seeds two
// fully-mapped multi-component templates on two routes, resolves and sends a
// real job for each, and proves each template's payload uses its own
// mapping/column set -- never leaking a value or mapping from the other
// template.
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

function expectedPayload(templateName: string, recipient: string, header: string, body2: string, buttonVar: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
      components: [
        { type: "header", parameters: [{ type: "text", text: header }] },
        { type: "body", parameters: [{ type: "text", text: body2 }, { type: "text", text: "Static" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: buttonVar }] },
      ],
    },
  };
}

test("a multi-template campaign resolves and sends each template's own header/body/button values, never mixing templates", async () => {
  const slug = `multi-tpl-fidelity-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  try {
    const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
    const [phoneA] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id, wabaId: waba.id, phone: `+1555${organization.id}0001`,
      displayName: `${slug}-phone-a`, status: "Connected", tpsLimit: 10,
    }).returning();
    const [phoneB] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id, wabaId: waba.id, phone: `+1555${organization.id}0002`,
      displayName: `${slug}-phone-b`, status: "Connected", tpsLimit: 10,
    }).returning();

    const [templateA] = await db.insert(templatesTable).values({
      organizationId: organization.id, wabaId: waba.id, name: `${slug}-tpl-a`, status: "Approved", language: "en_US",
      body: "Order {{1}} for {{2}}",
      components: [
        { type: "HEADER", format: "TEXT", text: "Hello {{1}}" },
        { type: "BODY", text: "Order {{1}} for {{2}}" },
        { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/promo/{{1}}" }] },
      ],
    }).returning();
    const [templateB] = await db.insert(templatesTable).values({
      organizationId: organization.id, wabaId: waba.id, name: `${slug}-tpl-b`, status: "Approved", language: "en_US",
      body: "Ticket {{1}} for {{2}}",
      components: [
        { type: "HEADER", format: "TEXT", text: "Welcome {{1}}" },
        { type: "BODY", text: "Ticket {{1}} for {{2}}" },
        { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/vip/{{1}}" }] },
      ],
    }).returning();

    const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
    const [routeA] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phoneA.id, templateId: templateA.id, configuredTps: 10,
    }).returning();
    const [routeB] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phoneB.id, templateId: templateB.id, configuredTps: 10,
    }).returning();
    await db.insert(campaignTemplateSelectionsTable).values([
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateA.id },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateB.id },
    ]);
    // Each template gets its OWN mapping set, pointed at entirely different
    // CSV columns -- the point being that resolving template B must never
    // read template A's columns (or vice-versa), even though both templates
    // share the same component/variable numbering scheme (header:1, body:1,
    // body:2, button:0:1).
    await db.insert(campaignTemplateMappingsTable).values([
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateA.id, component: "header", variable: "1", source: "csv", sourceValue: "headerName" },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateA.id, component: "body", variable: "1", source: "csv", sourceValue: "orderId" },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateA.id, component: "body", variable: "2", source: "static", sourceValue: "Static" },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateA.id, component: "button", variable: "0:1", source: "csv", sourceValue: "promoCode" },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateB.id, component: "header", variable: "1", source: "csv", sourceValue: "vipName" },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateB.id, component: "body", variable: "1", source: "csv", sourceValue: "ticketId" },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateB.id, component: "body", variable: "2", source: "static", sourceValue: "Static" },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateB.id, component: "button", variable: "0:1", source: "csv", sourceValue: "couponCode" },
    ]);

    const [contactA] = await db.insert(campaignContactsTable).values({
      organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
      rawPhone: "+15559991001", normalizedPhone: "+15559991001", status: "Valid",
      // Contact A's row also carries template B's column names, populated
      // with values that must NEVER appear in template A's own send.
      data: { headerName: "Alice", orderId: "ORD-1001", promoCode: "ALPHA10", vipName: "WRONG", ticketId: "WRONG", couponCode: "WRONG" },
      idempotencyKey: `${slug}-contact-a`,
    }).returning();
    const [contactB] = await db.insert(campaignContactsTable).values({
      organizationId: organization.id, campaignId: campaign.id, rowNumber: 2,
      rawPhone: "+15559992002", normalizedPhone: "+15559992002", status: "Valid",
      data: { headerName: "WRONG", orderId: "WRONG", promoCode: "WRONG", vipName: "Priya", ticketId: "TCK-500", couponCode: "GOLD50" },
      idempotencyKey: `${slug}-contact-b`,
    }).returning();

    const [jobA] = await db.insert(campaignJobsTable).values({
      organizationId: organization.id, campaignId: campaign.id, routeId: routeA.id, contactId: contactA.id,
      templateId: templateA.id, type: "ResolveTemplateAndSend", status: "Processing", lockedBy: "test-worker",
      leaseToken: `${slug}-lease-a`, idempotencyKey: `${slug}-send-a`,
    }).returning();
    const [jobB] = await db.insert(campaignJobsTable).values({
      organizationId: organization.id, campaignId: campaign.id, routeId: routeB.id, contactId: contactB.id,
      templateId: templateB.id, type: "ResolveTemplateAndSend", status: "Processing", lockedBy: "test-worker",
      leaseToken: `${slug}-lease-b`, idempotencyKey: `${slug}-send-b`,
    }).returning();

    const sender = new WhatsAppTemplateSender();

    const resolvedA = await resolveJobTemplate(jobA);
    assert.deepEqual(resolvedA.payload.resolvedParameters, {
      header: { "1": "Alice" }, body: { "1": "ORD-1001", "2": "Static" }, button: { "0:1": "ALPHA10" },
    }, "template A must resolve strictly from its own mapping set, never template B's columns");
    const resolvedB = await resolveJobTemplate(jobB);
    assert.deepEqual(resolvedB.payload.resolvedParameters, {
      header: { "1": "Priya" }, body: { "1": "TCK-500", "2": "Static" }, button: { "0:1": "GOLD50" },
    }, "template B must resolve strictly from its own mapping set, never template A's columns");
    // The two resolved jobs are deliberately prefetched together: their
    // frozen snapshots have the same variable numbering but distinct
    // component definitions and values.
    const prepared = await sender.prepareBatch([resolvedA, resolvedB], new AbortController().signal);
    assert.ok(prepared.has(jobA.id));
    assert.ok(prepared.has(jobB.id));
    const resultA = await sender.send(resolvedA, { signal: new AbortController().signal, idempotencyKey: resolvedA.idempotencyKey }, prepared.get(jobA.id));
    assert.equal(
      resultA.providerMessageId,
      deterministicMockId(`mock-phone-${phoneA.id}-job-${jobA.id}`, expectedPayload(`${slug}-tpl-a`, "+15559991001", "Alice", "ORD-1001", "ALPHA10")),
      "template A's real send payload must carry template A's own name and values",
    );

    const resultB = await sender.send(resolvedB, { signal: new AbortController().signal, idempotencyKey: resolvedB.idempotencyKey }, prepared.get(jobB.id));
    assert.equal(
      resultB.providerMessageId,
      deterministicMockId(`mock-phone-${phoneB.id}-job-${jobB.id}`, expectedPayload(`${slug}-tpl-b`, "+15559992002", "Priya", "TCK-500", "GOLD50")),
      "template B's real send payload must carry template B's own name and values, never template A's",
    );
    assert.notEqual(resultA.providerMessageId, resultB.providerMessageId, "two different templates in one campaign must never collapse onto the same provider send");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});
