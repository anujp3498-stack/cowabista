import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMediaProviderBindingsTable,
  campaignRoutesTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { previewMessage } from "../src/services/message-studio";
import { resolveJobTemplates } from "../src/services/template-resolution";
import { buildMetaTemplatePayload } from "../src/services/whatsapp-template-sender";
import { setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";
import {
  createCampaign,
  deleteOrganization,
  fakeResponse,
  findRouteHandler,
  HEADER_IMAGE,
  PNG,
  seedAudience,
  startFakeGraph,
  streamRequest,
  useLocalMediaStore,
  workspaceWorld,
} from "./message-studio-fixtures";

// Acceptance rule (V2-05B): for a sampled contact, the parameters Message
// Studio previews are exactly the parameters send preparation resolves for
// that contact's job -- same resolver, same requirement keys -- and a slot
// that cannot be resolved fails the same way in both.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); useLocalMediaStore(); });
after(async () => { setCampaignMediaStoreForTests(undefined); delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const base = "/organizations/:organizationId/campaigns/:campaignId";
const upload = findRouteHandler(messageStudioRouter, `${base}/media`, "post");
const putSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "put");
const previewRoute = findRouteHandler(messageStudioRouter, `${base}/message-setup/preview`, "post");

const RICH = HEADER_IMAGE("Hi {{1}}, you are {{2}}", [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://shop.test/c/{{1}}" }, { type: "PHONE_NUMBER", text: "Call", phone_number: "+15550001111" }] }]);
const TEXT_HEADER = [{ type: "HEADER", format: "TEXT", text: "News for {{1}}" }, { type: "BODY", text: "Dear {{1}}" }, { type: "FOOTER", text: "Reply STOP to opt out" }];

test("preview parameters equal prepared-send parameters for every job, across templates, media, URL buttons, statics and CSV values", async () => {
  const slug = `parity-${process.pid}-${Date.now()}`;
  const graph = await startFakeGraph();
  const world = await workspaceWorld(slug, { phones: 2, templates: [
    { name: "rich", body: "Hi {{1}}, you are {{2}}", components: RICH },
    { name: "news", body: "Dear {{1}}", components: TEXT_HEADER },
  ] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    const people = Array.from({ length: 12 }, (_, index) => ({
      phone: `+1555222${String(index).padStart(4, "0")}`, first_name: `Name${index}`, customer_id: `C-${index}`, email: `p${index}@test`,
    }));
    await seedAudience(world.organization.id, campaign.id, ["phone", "first_name", "customer_id", "email"], people);
    const uploadRes = fakeResponse();
    await upload(streamRequest(PNG, { params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, headers: { "x-file-name": "banner.png", "content-type": "image/png" }, authUser: {} }), uploadRes);
    const asset = uploadRes.body;
    const [rich, news] = world.templates;
    const saveRes = fakeResponse();
    await putSetup({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, authUser: {}, body: {
      revision: 0, senderPhoneNumberIds: world.phones.map((p) => p.id), templateIds: [rich!.id, news!.id],
      mappings: [
        { templateId: rich!.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(asset.id), mediaAssetId: asset.id },
        { templateId: rich!.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
        { templateId: rich!.id, component: "body", variable: "2", source: "static", sourceValue: "VIP" },
        { templateId: rich!.id, component: "button", variable: "0:1", source: "csv", sourceValue: "customer_id" },
        { templateId: news!.id, component: "header", variable: "1", source: "static", sourceValue: "October" },
        { templateId: news!.id, component: "body", variable: "1", source: "csv", sourceValue: "email" },
      ],
    } }, saveRes);
    assert.equal(saveRes.statusCode, 200, JSON.stringify(saveRes.body));

    await planCampaign(world.organization.id, campaign.id);
    await executeCampaignPlan(world.organization.id, campaign.id);
    await db.update(campaignJobsTable).set({
      status: "Processing", leaseToken: randomUUID(), lockedBy: "parity-test", lockedAt: sql`statement_timestamp()`, leaseExpiresAt: sql`statement_timestamp() + interval '60 seconds'`,
    }).where(eq(campaignJobsTable.campaignId, campaign.id));
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(jobs.length, 12);
    const results = await resolveJobTemplates(jobs);
    const bindings = await db.select().from(campaignMediaProviderBindingsTable).where(eq(campaignMediaProviderBindingsTable.mediaAssetId, asset.id));
    const contacts = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaign.id));
    const routesByTemplate = new Set<number>();
    for (const result of results) {
      assert.ok(result.resolvedJob, String(result.error));
      const job = result.resolvedJob!;
      const prepared = (job.payload as { resolvedParameters: { header: Record<string, string>; body: Record<string, string>; button: Record<string, string>; headerMedia?: { assetId: string; id?: string } } }).resolvedParameters;
      const templateId = (job.payload as { templateId: number }).templateId;
      routesByTemplate.add(templateId);
      const preview = await previewMessage({ organizationId: world.organization.id, campaignId: campaign.id, templateId, contactId: job.contactId! });
      assert.deepEqual(preview.unresolved, []);
      assert.deepEqual(preview.resolved, { header: prepared.header, body: prepared.body, button: prepared.button }, "preview == prepared parameters");
      if (templateId === rich!.id) {
        assert.equal(preview.headerMedia?.mediaAssetId, asset.id);
        assert.equal(prepared.headerMedia?.assetId, String(asset.id));
        const contact = contacts.find((c) => c.id === job.contactId)!;
        const [route] = await db.select({ phoneNumberId: campaignRoutesTable.phoneNumberId }).from(campaignRoutesTable).where(eq(campaignRoutesTable.id, job.routeId!));
        const binding = bindings.find((b) => b.phoneNumberId === route!.phoneNumberId);
        assert.equal(prepared.headerMedia?.id, binding?.providerMediaId, "send preparation used THIS sender's provider media id");
        const payload = buildMetaTemplatePayload(contact.normalizedPhone!, "rich", "en_US", prepared, RICH) as { template: { components: unknown[] } };
        assert.deepEqual(payload.template.components, [
          { type: "header", parameters: [{ type: "image", image: { id: binding!.providerMediaId } }] },
          { type: "body", parameters: [{ type: "text", text: contact.data.first_name }, { type: "text", text: "VIP" }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: contact.data.customer_id }] },
        ]);
      } else {
        assert.equal(preview.headerMedia, null);
        assert.deepEqual(prepared.header, { "1": "October" });
      }
    }
    assert.equal(routesByTemplate.size, 2, "both templates were sampled");

    // The preview endpoint (unsaved editor state) uses the same resolver.
    const draftPreview = fakeResponse();
    await previewRoute({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, body: {
      templateId: news!.id, contactId: contacts[0]!.id,
      mappings: [{ templateId: news!.id, component: "header", variable: "1", source: "csv", sourceValue: "first_name" }],
    } }, draftPreview);
    assert.equal(draftPreview.statusCode, 200, JSON.stringify(draftPreview.body));
    assert.deepEqual(draftPreview.body.resolved.header, { "1": contacts[0]!.data.first_name });
    assert.deepEqual(draftPreview.body.unresolved, [{ key: "body:1", reason: "unmapped" }], "an unmapped slot is reported, never invented");
    assert.ok(!JSON.stringify(draftPreview.body).includes(bindings[0]!.providerMediaId));
  } finally {
    await graph.close();
    await deleteOrganization(world.organization.id);
  }
});

test("a missing value is unresolved in preview AND fails send resolution with the same requirement key", async () => {
  const slug = `parity-missing-${process.pid}-${Date.now()}`;
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "news", body: "Dear {{1}}", components: TEXT_HEADER }] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    await seedAudience(world.organization.id, campaign.id, ["phone", "email"], [{ phone: "+15552220001", email: "" }]);
    const t = world.templates[0]!;
    const saveRes = fakeResponse();
    await putSetup({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, authUser: {}, body: {
      revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [t.id],
      mappings: [
        { templateId: t.id, component: "header", variable: "1", source: "static", sourceValue: "October" },
        { templateId: t.id, component: "body", variable: "1", source: "csv", sourceValue: "email" },
      ],
    } }, saveRes);
    assert.equal(saveRes.statusCode, 200);
    await planCampaign(world.organization.id, campaign.id);
    await executeCampaignPlan(world.organization.id, campaign.id);
    await db.update(campaignJobsTable).set({ status: "Processing", leaseToken: randomUUID(), leaseExpiresAt: sql`statement_timestamp() + interval '60 seconds'` }).where(eq(campaignJobsTable.campaignId, campaign.id));
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    const [result] = await resolveJobTemplates(jobs);
    assert.match(String(result!.error), /Mapping body:1 resolved to an empty value/);
    const preview = await previewMessage({ organizationId: world.organization.id, campaignId: campaign.id, templateId: t.id, contactId: jobs[0]!.contactId! });
    assert.deepEqual(preview.unresolved, [{ key: "body:1", reason: "empty_value" }]);
    assert.deepEqual(preview.resolved.body, {}, "no value is invented");
  } finally {
    await deleteOrganization(world.organization.id);
  }
});
