import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignPlansTable,
  campaignRoutesTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import campaignDeliveryRouter from "../src/routes/campaign-delivery";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { planCampaign } from "../src/services/campaign-planning";
import { getLaunchProjection, previewLaunchRecipient } from "../src/services/campaign-review";
import { deleteOrganization, fakeResponse, findRouteHandler } from "./message-studio-fixtures";
import { campaignAction, firstNameMappings, saveDelivery, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06C Review reads: the recipient preview decides with Planning's own
// inputs and functions, so for an unchanged configuration it equals the
// allocation Launch freezes, recipient by recipient; the projection is
// cheap and approximate. Neither writes anything.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2review-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
const previewRoute = findRouteHandler(campaignDeliveryRouter, "/organizations/:organizationId/campaigns/:campaignId/review/preview", "post");
const projectionRoute = findRouteHandler(campaignDeliveryRouter, "/organizations/:organizationId/campaigns/:campaignId/review", "get");

async function writes(campaignId: number) {
  const count = async (table: string) => (await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table} where campaign_id = ${campaignId}`))).rows[0]!.n;
  return { plans: await count("campaign_plans"), allocations: await count("campaign_allocations"), jobs: await count("campaign_jobs"), audit: await count("campaign_audit"), routes: JSON.stringify(await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaignId)).orderBy(asc(campaignRoutesTable.id))) };
}

for (const scenario of [
  { name: "equal_templates + advanced (mixed 3x3)", distributionMode: "equal_templates", deliveryMode: "advanced" },
  { name: "equal_numbers + conservative (mixed 3x3)", distributionMode: "equal_numbers", deliveryMode: "conservative" },
] as const) {
  test(`recipient preview == the allocation Launch freezes, for every recipient: ${scenario.name}`, async () => {
    const slug = slugFor(scenario.deliveryMode);
    const w = await v2World(slug, { wabas: [
      { phones: [{ key: "X", tps: 100 }, { key: "Y", tps: 40 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] },
      { phones: [{ key: "Z", tps: 60 }], templates: [{ key: "C", body: "Charlie {{1}}" }] },
    ] });
    const org = w.organization.id;
    const { X, Y, Z } = w.phones;
    try {
      const { campaign } = await v2Campaign(org, slug, 60);
      const ids = [w.templates.A!.id, w.templates.B!.id, w.templates.C!.id];
      const message = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id, Y!.id, Z!.id], templateIds: ids, mappings: firstNameMappings(ids) });
      assert.equal(message.statusCode, 200, JSON.stringify(message.body));
      const delivery = await saveDelivery(org, campaign.id, {
        revision: message.body.revision, distributionMode: scenario.distributionMode, deliveryMode: scenario.deliveryMode,
        ...(scenario.deliveryMode === "advanced" ? { deliverySettings: { perNumberRates: [{ phoneNumberId: X!.id, messagesPerSecond: 10 }, { phoneNumberId: Y!.id, messagesPerSecond: 40 }, { phoneNumberId: Z!.id, messagesPerSecond: 7 }] } } : {}),
      });
      assert.equal(delivery.statusCode, 200, JSON.stringify(delivery.body));

      const contacts = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaign.id)).orderBy(asc(campaignContactsTable.id));
      const before = await writes(campaign.id);
      const previews = new Map<number, { routeId: number; phoneNumberId: number; templateId: number; body: Record<string, string> }>();
      for (const contact of contacts) {
        const preview = await previewLaunchRecipient(org, campaign.id, contact.id);
        assert.equal(preview.willSend, true);
        assert.equal(preview.decision!.allocatorVersion, "v2");
        previews.set(contact.id, { routeId: preview.decision!.routeId, phoneNumberId: preview.decision!.sender.phoneNumberId, templateId: preview.decision!.template.templateId, body: preview.message!.resolved.body });
        assert.deepEqual(preview.message!.resolved.body, { "1": (contact.data as Record<string, string>).first_name }, "same resolver, live mappings");
      }
      // Through the route too (first valid recipient when no id is given).
      const viaRoute = fakeResponse();
      await previewRoute({ params: { organizationId: String(org), campaignId: String(campaign.id) }, body: {} }, viaRoute);
      assert.equal(viaRoute.statusCode, 200, JSON.stringify(viaRoute.body));
      assert.equal(viaRoute.body.contactId, contacts[0]!.id);
      const projection = await getLaunchProjection(org, campaign.id);
      assert.equal(projection.approximate, true);
      assert.deepEqual(await writes(campaign.id), before, "previews and the projection wrote nothing (no plan, allocation, job, audit or route change)");

      const launched = await campaignAction(org, campaign.id, { action: "launch" });
      assert.equal(launched.statusCode, 200, JSON.stringify(launched.body));
      const allocations = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, launched.body.launch.planId));
      assert.equal(allocations.length, contacts.length);
      for (const allocation of allocations) {
        const preview = previews.get(allocation.contactId)!;
        assert.deepEqual({ routeId: allocation.routeId, phoneNumberId: allocation.phoneNumberId, templateId: allocation.templateId }, { routeId: preview.routeId, phoneNumberId: preview.phoneNumberId, templateId: preview.templateId }, `contact ${allocation.contactId}`);
      }
      const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
      for (const job of jobs) assert.equal(job.templateId, previews.get(job.contactId!)!.templateId);
      // The projection's approximate template shares are close to the frozen counts.
      const frozenByTemplate = new Map<number, number>();
      for (const allocation of allocations) frozenByTemplate.set(allocation.templateId!, (frozenByTemplate.get(allocation.templateId!) ?? 0) + 1);
      for (const template of projection.templates as Array<{ templateId: number; approxRecipients: number }>) {
        assert.ok(Math.abs((frozenByTemplate.get(template.templateId) ?? 0) - template.approxRecipients) <= 15, `template ${template.templateId}: projected ~${template.approxRecipients}, frozen ${frozenByTemplate.get(template.templateId)}`);
      }
    } finally { await deleteOrganization(org); }
  });
}

test("projection math: equal by numbers splits numbers equally and rotates each number's templates; equal by templates splits templates equally and numbers by speed", async () => {
  const slug = slugFor("projection");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: 100 }, { key: "Y", tps: 100 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = w.organization.id;
  const { X, Y } = w.phones;
  const { A, B } = w.templates;
  try {
    const { campaign } = await v2Campaign(org, slug, 1_000);
    const ids = [A!.id, B!.id];
    const message = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id, Y!.id], templateIds: ids, mappings: firstNameMappings(ids) });
    const numbers = await saveDelivery(org, campaign.id, { revision: message.body.revision, distributionMode: "equal_numbers", deliveryMode: "fastest_safe" });
    const res = fakeResponse();
    await projectionRoute({ params: { organizationId: String(org), campaignId: String(campaign.id) } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.available, true);
    assert.deepEqual(res.body.senders.map((s: { approxShare: number; approxRecipients: number }) => [s.approxShare, s.approxRecipients]), [[0.5, 500], [0.5, 500]]);
    assert.deepEqual(res.body.senders[0].templates.map((t: { approxRecipients: number }) => t.approxRecipients), [250, 250]);

    const templates = await saveDelivery(org, campaign.id, { revision: numbers.body.revision, distributionMode: "equal_templates", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: X!.id, messagesPerSecond: 20 }, { phoneNumberId: Y!.id, messagesPerSecond: 80 }] } });
    assert.equal(templates.statusCode, 200);
    const weighted = await getLaunchProjection(org, campaign.id);
    assert.deepEqual((weighted.templates as Array<{ approxShare: number }>).map((t) => t.approxShare), [0.5, 0.5]);
    assert.deepEqual((weighted.senders as Array<{ approxRecipients: number }>).map((s) => s.approxRecipients), [200, 800], "within each template, 20 : 80 by planned speed");
    assert.equal((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaign.id))).length, 0, "no plan");

    // Without a distribution the projection says why instead of guessing.
    const legacy = await v2Campaign(org, `${slug}-legacy`, 3);
    const none = await getLaunchProjection(org, legacy.campaign.id);
    assert.equal(none.available, false);
    assert.ok(none.reason);
  } finally { await deleteOrganization(org); }
});

test("a legacy (allocator v1) campaign's preview follows the historical v1 decision and equals its plan", async () => {
  const slug = slugFor("v1");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const { campaign } = await v2Campaign(org, slug, 20);
    const ids = [w.templates.A!.id, w.templates.B!.id];
    assert.equal((await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id], templateIds: ids, mappings: firstNameMappings(ids) })).statusCode, 200);
    const contacts = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaign.id));
    const decided = new Map<number, { routeId: number; templateId: number }>();
    for (const contact of contacts) {
      const preview = await previewLaunchRecipient(org, campaign.id, contact.id);
      assert.equal(preview.decision!.allocatorVersion, "v1");
      decided.set(contact.id, { routeId: preview.decision!.routeId, templateId: preview.decision!.template.templateId });
    }
    const { plan } = await planCampaign(org, campaign.id);
    const allocations = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, plan.id));
    for (const allocation of allocations) assert.deepEqual({ routeId: allocation.routeId, templateId: allocation.templateId }, decided.get(allocation.contactId));
  } finally { await deleteOrganization(org); }
});
