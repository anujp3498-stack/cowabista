import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignAuditTable,
  campaignJobsTable,
  campaignMediaAssetsTable,
  campaignMetricsTable,
  campaignPlansTable,
  campaignsTable,
  db,
  pool,
  providerMessagesTable,
  settlementPool,
  suppressionsTable,
  templatesTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { planCampaign } from "../src/services/campaign-planning";
import { setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";
import { buildMetaTemplatePayload } from "../src/services/whatsapp-template-sender";
import {
  createCampaign,
  deleteOrganization,
  fakeResponse,
  findRouteHandler,
  HEADER_IMAGE,
  mockWorld,
  PNG,
  seedAudience,
  startFakeGraph,
  streamRequest,
  TOKEN,
  useLocalMediaStore,
  workspaceWorld,
} from "./message-studio-fixtures";

// V2-05B isolated test send: the real resolver and payload builder after
// the same checks sending enforces, every refusal before any provider
// request, and no effect on jobs, allocations, metrics, plans or status.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); useLocalMediaStore(); });
after(async () => { setCampaignMediaStoreForTests(undefined); delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const base = "/organizations/:organizationId/campaigns/:campaignId";
const upload = findRouteHandler(messageStudioRouter, `${base}/media`, "post");
const putSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "put");
const testSendRoute = findRouteHandler(messageStudioRouter, `${base}/message-setup/test-send`, "post");

async function testSend(organizationId: number, campaignId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await testSendRoute({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body, authUser: { id: undefined } }, res);
  return res;
}

async function snapshot(campaignId: number) {
  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  const organizationId = campaign!.organizationId;
  const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaignId));
  const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId));
  const allocations = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.campaignId, campaignId));
  const plans = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaignId));
  const providerMessages = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.organizationId, organizationId));
  return {
    status: campaign!.status, sent: campaign!.sent, delivered: campaign!.delivered, failed: campaign!.failed,
    metrics: metrics ? { sent: metrics.sent, failed: metrics.failed, queued: metrics.queued, delivered: metrics.delivered } : null,
    jobs: jobs.length,
    allocations: allocations.map((a) => `${a.id}:${a.planId}:${a.routeId}:${a.templateId}`).sort(),
    plans: plans.map((p) => `${p.id}:${p.status}:${p.version}`).sort(),
    providerMessages: providerMessages.length,
  };
}

async function readyWorld(slug: string) {
  const graph = await startFakeGraph();
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "promo", body: "Hi {{1}}", components: HEADER_IMAGE("Hi {{1}}") }], secondWaba: true });
  const campaign = await createCampaign(world.organization.id, slug);
  const { contacts } = await seedAudience(world.organization.id, campaign.id, ["phone", "first_name"], [{ phone: "+15553330001", first_name: "Ada" }]);
  await db.insert(campaignMetricsTable).values({ organizationId: world.organization.id, campaignId: campaign.id, total: 1, valid: 1 });
  const uploadRes = fakeResponse();
  await upload(streamRequest(PNG, { params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, headers: { "x-file-name": "banner.png", "content-type": "image/png" }, authUser: {} }), uploadRes);
  const asset = uploadRes.body;
  const template = world.templates[0]!;
  const saveRes = fakeResponse();
  await putSetup({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, authUser: {}, body: {
    revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [template.id],
    mappings: [
      { templateId: template.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(asset.id), mediaAssetId: asset.id },
      { templateId: template.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    ],
  } }, saveRes);
  assert.equal(saveRes.statusCode, 200, JSON.stringify(saveRes.body));
  return { graph, world, campaign, contact: contacts[0]!, asset, template, phone: world.phones[0]! };
}

test("a test send uses the real payload and touches no job, allocation, metric, plan or status", async () => {
  const slug = `ts-ok-${process.pid}-${Date.now()}`;
  const f = await readyWorld(slug);
  try {
    await planCampaign(f.world.organization.id, f.campaign.id); // Ready, with allocations
    const before = await snapshot(f.campaign.id);
    assert.equal(before.status, "Ready");
    assert.ok(before.allocations.length >= 1);
    const uploadsBefore = f.graph.requests.filter((r) => r.url.endsWith("/media")).length;

    const res = await testSend(f.world.organization.id, f.campaign.id, { phoneNumberId: f.phone.id, templateId: f.template.id, contactId: f.contact.id });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.result, "sent");
    assert.match(res.body.providerMessageId, /^wamid\.test\./);
    assert.ok(!JSON.stringify(res.body).includes(TOKEN) && !JSON.stringify(res.body).includes("media-"), "no token or provider media id in the response");

    const messages = f.graph.requests.filter((r) => r.url.endsWith("/messages"));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.url, `/v23.0/${f.phone.providerPhoneId}/messages`);
    assert.equal(messages[0]!.authorization, `Bearer ${TOKEN}`);
    assert.equal(f.graph.requests.filter((r) => r.url.endsWith("/media")).length, uploadsBefore, "the binding made at planning is reused");
    const { campaignMediaProviderBindingsTable } = await import("@workspace/db");
    const [binding] = await db.select().from(campaignMediaProviderBindingsTable).where(eq(campaignMediaProviderBindingsTable.mediaAssetId, f.asset.id));
    const expected = buildMetaTemplatePayload("+15553330001", "promo", "en_US", { header: {}, body: { "1": "Ada" }, button: {}, headerMedia: { assetId: String(f.asset.id), id: binding!.providerMediaId } }, HEADER_IMAGE("Hi {{1}}"));
    assert.deepEqual(JSON.parse(messages[0]!.body.toString()), expected, "exact provider payload from the real builder");

    assert.deepEqual(await snapshot(f.campaign.id), before, "jobs, allocations, metrics, plans and status are unchanged");
    const audit = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, f.campaign.id), eq(campaignAuditTable.action, "test_send_requested")));
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.metadata.result, "sent");
    assert.equal(audit[0]!.metadata.templateId, f.template.id);
    assert.equal(audit[0]!.metadata.senderPhoneNumberId, f.phone.id);
    assert.ok(!JSON.stringify(audit[0]).includes(TOKEN) && !JSON.stringify(audit[0]).includes("Ada"), "audit has no secret and no payload");

    // An explicit test number works too; an opted-out one is refused before HTTP.
    const explicit = await testSend(f.world.organization.id, f.campaign.id, { phoneNumberId: f.phone.id, templateId: f.template.id, recipientPhone: "+447700900123" });
    assert.equal(explicit.body.result, "sent");
    assert.equal(JSON.parse(f.graph.requests.at(-1)!.body.toString()).to, "+447700900123");
    await db.insert(suppressionsTable).values({ organizationId: f.world.organization.id, normalizedPhone: "+447700900124" });
    const count = f.graph.requests.length;
    const suppressed = await testSend(f.world.organization.id, f.campaign.id, { phoneNumberId: f.phone.id, templateId: f.template.id, recipientPhone: "+447700900124" });
    assert.equal(suppressed.statusCode, 409);
    assert.equal(suppressed.body.code, "recipient_suppressed");
    const invalid = await testSend(f.world.organization.id, f.campaign.id, { phoneNumberId: f.phone.id, templateId: f.template.id, recipientPhone: "07700 900123" });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, "recipient_invalid");
    assert.equal(f.graph.requests.length, count, "no provider request for refused test sends");
    assert.deepEqual(await snapshot(f.campaign.id), before);
  } finally {
    await f.graph.close();
    await deleteOrganization(f.world.organization.id);
  }
});

test("every refusal happens before any provider request: compatibility, credential, template status, media, mapping, selection, tenant", async () => {
  const slug = `ts-refuse-${process.pid}-${Date.now()}`;
  const f = await readyWorld(slug);
  const other = await workspaceWorld(`${slug}-o`, { phones: 1, templates: [{ name: "theirs", body: "Hi" }] });
  try {
    const org = f.world.organization.id;
    const call = (body: Record<string, unknown>) => testSend(org, f.campaign.id, { phoneNumberId: f.phone.id, templateId: f.template.id, contactId: f.contact.id, ...body });
    const expectRefusal = async (label: string, res: { statusCode: number; body: { code: string } }, code: string) => {
      assert.ok(res.statusCode >= 400, `${label}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, code, label);
      assert.equal(f.graph.requests.length, 0, `${label}: no provider request`);
    };

    await db.update(templatesTable).set({ wabaId: f.world.otherWaba!.id }).where(eq(templatesTable.id, f.template.id));
    await expectRefusal("different business account", await call({}), "incompatible");
    await db.update(templatesTable).set({ wabaId: f.world.waba.id }).where(eq(templatesTable.id, f.template.id));

    await db.update(whatsappCredentialsTable).set({ status: "revoked" }).where(eq(whatsappCredentialsTable.id, f.world.credential.id));
    await expectRefusal("credential revoked", await call({}), "credential_inactive");
    await db.update(whatsappCredentialsTable).set({ status: "active" }).where(eq(whatsappCredentialsTable.id, f.world.credential.id));

    await db.update(templatesTable).set({ status: "Paused" }).where(eq(templatesTable.id, f.template.id));
    await expectRefusal("template paused at Meta", await call({}), "template_unusable");
    await db.update(templatesTable).set({ status: "Approved" }).where(eq(templatesTable.id, f.template.id));

    await db.update(campaignMediaAssetsTable).set({ kind: "video" }).where(eq(campaignMediaAssetsTable.id, f.asset.id));
    await expectRefusal("media kind mismatch", await call({}), "media_kind_mismatch");
    await db.update(campaignMediaAssetsTable).set({ kind: "image", status: "deleted" }).where(eq(campaignMediaAssetsTable.id, f.asset.id));
    await expectRefusal("media deleted", await call({}), "media_unavailable");
    await db.update(campaignMediaAssetsTable).set({ status: "ready" }).where(eq(campaignMediaAssetsTable.id, f.asset.id));

    const { campaignContactsTable } = await import("@workspace/db");
    await db.update(campaignContactsTable).set({ data: { phone: "+15553330001", first_name: "" } }).where(eq(campaignContactsTable.id, f.contact.id));
    await expectRefusal("unresolved variable", await call({}), "mapping_unresolved");

    await expectRefusal("number not in the saved setup", await call({ phoneNumberId: other.phones[0]!.id }), "not_selected");
    await expectRefusal("template not in the saved setup", await call({ templateId: other.templates[0]!.id }), "not_selected");
    const foreign = await testSend(other.organization.id, f.campaign.id, { phoneNumberId: f.phone.id, templateId: f.template.id, contactId: f.contact.id });
    assert.equal(foreign.statusCode, 404, "another workspace cannot test-send from this campaign");
    assert.equal(f.graph.requests.length, 0);
    assert.equal((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, f.campaign.id))).length, 0);
    const refusals = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, f.campaign.id), eq(campaignAuditTable.action, "test_send_requested")));
    assert.ok(refusals.length >= 8 && refusals.every((row) => row.metadata.result === "refused"));
  } finally {
    await f.graph.close();
    await deleteOrganization(f.world.organization.id);
    await deleteOrganization(other.organization.id);
  }
});

test("a provider refusal is reported as failed (no retry); the local mock sends without any HTTP", async () => {
  const slug = `ts-fail-${process.pid}-${Date.now()}`;
  const f = await readyWorld(slug);
  await f.graph.close();
  const rejecting = await startFakeGraph({ messageStatus: 400 });
  try {
    const res = await testSend(f.world.organization.id, f.campaign.id, { phoneNumberId: f.phone.id, templateId: f.template.id, contactId: f.contact.id });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result, "failed");
    assert.equal(res.body.code, "provider_rejected");
    assert.equal(rejecting.requests.filter((r) => r.url.endsWith("/messages")).length, 1, "exactly one attempt");
  } finally {
    await rejecting.close();
    await deleteOrganization(f.world.organization.id);
  }

  const mock = await mockWorld(`${slug}-mock`, { templates: [{ name: "hello", body: "Hello {{1}}" }] });
  try {
    const campaign = await createCampaign(mock.organization.id, `${slug}-mock`);
    const { contacts } = await seedAudience(mock.organization.id, campaign.id, ["phone", "first_name"], [{ phone: "+15554440001", first_name: "Mo" }]);
    const saveRes = fakeResponse();
    await putSetup({ params: { organizationId: String(mock.organization.id), campaignId: String(campaign.id) }, authUser: {}, body: {
      revision: 0, senderPhoneNumberIds: [mock.phones[0]!.id], templateIds: [mock.templates[0]!.id],
      mappings: [{ templateId: mock.templates[0]!.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" }],
    } }, saveRes);
    assert.equal(saveRes.statusCode, 200, JSON.stringify(saveRes.body));
    const res = await testSend(mock.organization.id, campaign.id, { phoneNumberId: mock.phones[0]!.id, templateId: mock.templates[0]!.id, contactId: contacts[0]!.id });
    assert.equal(res.body.result, "sent", JSON.stringify(res.body));
    assert.match(res.body.providerMessageId, /^wamid\.mock_/);
  } finally {
    await deleteOrganization(mock.organization.id);
  }
});
