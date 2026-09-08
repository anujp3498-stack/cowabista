// Closes the roadmap audit's remaining multi-template proof gap: prior tests
// each cover one segment of the pipeline in isolation (fidelity tests send
// directly-inserted jobs without a plan; planning tests freeze/execute but
// never call the sender). Nothing exercised the FULL production chain in one
// run: plan() -> freeze templates+mappings -> a live template/mapping/route
// edit made AFTER freezing -> execute() -> the real DatabaseJobQueue claims
// the job -> resolveJobTemplate resolves it -> WhatsAppTemplateSender
// dispatches it -> the actual provider payload is verified, for TWO
// different templates in one campaign at once. No real external credentials
// are used: the provider connection defaults to "mock" mode
// (getOrCreateProviderConnection), so the send goes through
// MockWhatsAppProviderClient, a deterministic in-process test double.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  campaignsTable,
  contactImportSessionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  providerMessagesTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter } from "../src/services/campaign-queue";
import { partitionFor } from "../src/services/contact-processing";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";

after(async () => {
  await pool.end();
});

function deterministicMockId(phoneId: string, payload: Record<string, unknown>): string {
  const value = `${phoneId}:${JSON.stringify(payload)}`;
  return `wamid.mock_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function expectedPayload(templateName: string, recipient: string, header: string, body1: string, buttonVar: string) {
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
        { type: "body", parameters: [{ type: "text", text: body1 }, { type: "text", text: "Static" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: buttonVar }] },
      ],
    },
  };
}

test("a multi-template campaign's plan survives post-freeze template/mapping/route edits all the way through execute, claim, resolve, and a real dispatched send", async () => {
  const slug = `plan-to-send-${process.pid}-${Date.now()}`;
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

    // Campaign starts Draft, as it would through the real plan/execute
    // lifecycle (not directly stamped Running like the fidelity-only tests).
    const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Draft" }).returning();
    const [routeA] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phoneA.id, templateId: templateA.id, configuredTps: 5,
    }).returning();
    const [routeB] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phoneB.id, templateId: templateB.id, configuredTps: 5,
    }).returning();
    await db.insert(campaignTemplateSelectionsTable).values([
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateA.id },
      { organizationId: organization.id, campaignId: campaign.id, templateId: templateB.id },
    ]);
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
    await db.insert(contactImportSessionsTable).values({
      organizationId: organization.id, campaignId: campaign.id, idempotencyKey: `${slug}-import`,
      fileName: "contacts.csv", status: "Completed",
      columns: ["headerName", "orderId", "promoCode", "vipName", "ticketId", "couponCode"],
    });

    // Route ids are inserted in ascending order (routeA, routeB), so bucket 0
    // of the campaign's fixed 64-way partitioning allocates to routeA and
    // bucket 1 to routeB -- same convention as the passing multi-route
    // planning test. Pick one real phone number per bucket deterministically.
    const partitionCount = 64;
    let phoneForA: string | undefined;
    let phoneForB: string | undefined;
    for (let index = 0; !(phoneForA && phoneForB); index += 1) {
      const candidate = `+1777${String(index).padStart(7, "0")}`;
      const bucket = partitionFor(candidate, partitionCount) % 2;
      if (bucket === 0 && !phoneForA) phoneForA = candidate;
      else if (bucket === 1 && !phoneForB) phoneForB = candidate;
    }

    await db.insert(campaignContactsTable).values({
      organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
      rawPhone: phoneForA!, normalizedPhone: phoneForA!, status: "Valid",
      // Also carries template B's column names populated with values that
      // must never leak into template A's frozen resolution/send.
      data: { headerName: "Alice", orderId: "ORD-1001", promoCode: "ALPHA10", vipName: "WRONG", ticketId: "WRONG", couponCode: "WRONG" },
      idempotencyKey: `${slug}-contact-a`,
    });
    await db.insert(campaignContactsTable).values({
      organizationId: organization.id, campaignId: campaign.id, rowNumber: 2,
      rawPhone: phoneForB!, normalizedPhone: phoneForB!, status: "Valid",
      data: { headerName: "WRONG", orderId: "WRONG", promoCode: "WRONG", vipName: "Priya", ticketId: "TCK-500", couponCode: "GOLD50" },
      idempotencyKey: `${slug}-contact-b`,
    });
    await db.insert(campaignMetricsTable).values({
      organizationId: organization.id, campaignId: campaign.id, total: 2, valid: 2,
    });

    // 1) PLAN: freezes templatesSnapshot + mappingsSnapshot + route TPS/template.
    await planCampaign(organization.id, campaign.id);

    // 2) Mutate every piece of LIVE source data the frozen plan drew from --
    // template content/name, mapping source columns, and route TPS/template
    // assignment (cross-swapped between A and B, and pushed above each
    // phone's provider TPS cap) -- to prove none of it can reach an
    // already-frozen plan's execution.
    await db.update(templatesTable).set({
      name: `${slug}-tpl-a-renamed`,
      body: "Completely different order body {{1}}",
      components: [
        { type: "HEADER", format: "TEXT", text: "Different header {{1}}" },
        { type: "BODY", text: "Completely different order body {{1}}" },
      ],
    }).where(eq(templatesTable.id, templateA.id));
    await db.update(templatesTable).set({
      name: `${slug}-tpl-b-renamed`,
      body: "Completely different ticket body {{1}}",
      components: [
        { type: "HEADER", format: "TEXT", text: "Different header {{1}}" },
        { type: "BODY", text: "Completely different ticket body {{1}}" },
      ],
    }).where(eq(templatesTable.id, templateB.id));
    await db.update(campaignTemplateMappingsTable).set({ sourceValue: "doesNotExistColumn" }).where(and(
      eq(campaignTemplateMappingsTable.campaignId, campaign.id),
      eq(campaignTemplateMappingsTable.templateId, templateA.id),
      eq(campaignTemplateMappingsTable.component, "header"),
      eq(campaignTemplateMappingsTable.variable, "1"),
    ));
    await db.update(campaignTemplateMappingsTable).set({ sourceValue: "doesNotExistColumn" }).where(and(
      eq(campaignTemplateMappingsTable.campaignId, campaign.id),
      eq(campaignTemplateMappingsTable.templateId, templateB.id),
      eq(campaignTemplateMappingsTable.component, "header"),
      eq(campaignTemplateMappingsTable.variable, "1"),
    ));
    // Cross-swap templates and push TPS above each phone's 10-TPS cap --
    // an unsafe/wrong config if the worker ever read it live instead of the
    // plan's frozen snapshot.
    await db.update(campaignRoutesTable).set({ configuredTps: 20, templateId: templateB.id }).where(eq(campaignRoutesTable.id, routeA.id));
    await db.update(campaignRoutesTable).set({ configuredTps: 20, templateId: templateA.id }).where(eq(campaignRoutesTable.id, routeB.id));

    // 3) EXECUTE: creates jobs from the frozen plan, not the mutated live rows.
    await executeCampaignPlan(organization.id, campaign.id);
    const jobsAfterExecute = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(jobsAfterExecute.length, 2);
    const jobForA = jobsAfterExecute.find((job) => job.routeId === routeA.id);
    const jobForB = jobsAfterExecute.find((job) => job.routeId === routeB.id);
    assert.ok(jobForA && jobForB);
    assert.equal(jobForA.templateId, templateA.id, "job A must carry the frozen template A id, not the live route's swapped template B");
    assert.equal(jobForA.configuredTps, 5, "job A must carry the frozen safe TPS, not the live route's unsafe 20");
    assert.equal(jobForB.templateId, templateB.id, "job B must carry the frozen template B id, not the live route's swapped template A");
    assert.equal(jobForB.configuredTps, 5, "job B must carry the frozen safe TPS, not the live route's unsafe 20");

    // 4) CLAIM + RESOLVE + SEND, through the real production worker (the same
    // DatabaseJobQueue.claim / resolveJobTemplate / WhatsAppTemplateSender
    // path CampaignRuntime uses), not a hand-called resolution shortcut.
    const worker = new CampaignWorker(new DatabaseJobQueue(), new WhatsAppTemplateSender(), new RouteTpsLimiter(), `${slug}-worker`);
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 10 && outcomes.filter((outcome) => outcome === "sent").length < 2; attempt += 1) {
      outcomes.push(await worker.processOne());
    }
    assert.equal(outcomes.filter((outcome) => outcome === "sent").length, 2, `both jobs must be claimed, resolved, and sent through the real pipeline; outcomes were: ${outcomes.join(",")}`);

    // 5) VERIFY the actual dispatched payload used the frozen mapping AND the
    // frozen template identity/content -- never the post-freeze rename,
    // content edit, mapping-column swap, or route template/TPS swap.
    const jobsAfterSend = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    const sentA = jobsAfterSend.find((job) => job.id === jobForA.id)!;
    const sentB = jobsAfterSend.find((job) => job.id === jobForB.id)!;
    assert.equal(sentA.status, "Sent");
    assert.equal(sentB.status, "Sent");

    const paramsA = (sentA.payload as { resolvedParameters?: Record<string, Record<string, string>> }).resolvedParameters;
    assert.deepEqual(paramsA, {
      header: { "1": "Alice" }, body: { "1": "ORD-1001", "2": "Static" }, button: { "0:1": "ALPHA10" },
    }, "job A must resolve strictly from its frozen mapping and contact data, immune to the post-freeze mapping-column edit and never mixing in template B's values");
    const paramsB = (sentB.payload as { resolvedParameters?: Record<string, Record<string, string>> }).resolvedParameters;
    assert.deepEqual(paramsB, {
      header: { "1": "Priya" }, body: { "1": "TCK-500", "2": "Static" }, button: { "0:1": "GOLD50" },
    }, "job B must resolve strictly from its frozen mapping and contact data, immune to the post-freeze mapping-column edit and never mixing in template A's values");

    const providerIdA = (sentA.payload as { providerMessageId?: string }).providerMessageId;
    const expectedIdA = deterministicMockId(
      `mock-phone-${phoneA.id}-job-${sentA.id}`,
      expectedPayload(`${slug}-tpl-a`, phoneForA!, "Alice", "ORD-1001", "ALPHA10"),
    );
    assert.equal(providerIdA, expectedIdA, "the dispatched payload for job A must use the frozen template's original name/content, not the post-freeze rename/content edit");

    const providerIdB = (sentB.payload as { providerMessageId?: string }).providerMessageId;
    const expectedIdB = deterministicMockId(
      `mock-phone-${phoneB.id}-job-${sentB.id}`,
      expectedPayload(`${slug}-tpl-b`, phoneForB!, "Priya", "TCK-500", "GOLD50"),
    );
    assert.equal(providerIdB, expectedIdB, "the dispatched payload for job B must use the frozen template's original name/content, not the post-freeze rename/content edit");

    const providerRows = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.organizationId, organization.id));
    assert.equal(providerRows.length, 2);
    assert.ok(providerRows.every((row) => row.status === "sent" && row.providerMessageId));

    // 6) The frozen safe TPS must be what claim() actually enforced --
    // otherwise the live 20-TPS edit (over each phone's 10-TPS cap) would
    // have tripped the unsafe-configuration throttle and left the route
    // Throttled instead of Active.
    const [routeAAfter] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.id, routeA.id));
    const [routeBAfter] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.id, routeB.id));
    assert.equal(routeAAfter?.status, "Active", "claim must have used the frozen safe TPS, not the live unsafe edit");
    assert.equal(routeBAfter?.status, "Active", "claim must have used the frozen safe TPS, not the live unsafe edit");

    const [campaignAfter] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id));
    assert.equal(campaignAfter?.sent, 2);
    const [metricsAfter] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaign.id));
    assert.equal(metricsAfter?.sent, 2);
    assert.equal(metricsAfter?.processing, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});
