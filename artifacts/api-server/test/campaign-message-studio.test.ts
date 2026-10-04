import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignJobsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  db,
  phoneNumbersTable,
  pool,
  settlementPool,
  templatesTable,
} from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import campaignRoutesRouter from "../src/routes/campaign-routes";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { planCampaign } from "../src/services/campaign-planning";
import { validateCampaignReady } from "../src/services/campaign-preflight";
import { ALLOCATOR_VERSION } from "../src/services/campaign-planning";
import {
  createCampaign,
  createOrganization,
  deleteOrganization,
  fakeResponse,
  findRouteHandler,
  seedAudience,
  workspaceWorld,
} from "./message-studio-fixtures";

// V2-05B Message Studio selection: senders and templates come from the
// V2-04 decision, saves are revision- and lifecycle-fenced, routes are
// derived for allocator v1 only when it can run the selection, and nothing
// here plans, executes or sends.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const base = "/organizations/:organizationId/campaigns/:campaignId";
const getSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "get");
const putSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "put");
const createRoute = findRouteHandler(campaignRoutesRouter, "/campaign-routes", "post");

async function load(organizationId: number, campaignId: number) {
  const res = fakeResponse();
  await getSetup({ params: { organizationId: String(organizationId), campaignId: String(campaignId) } }, res);
  return res;
}
async function save(organizationId: number, campaignId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await putSetup({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body, authUser: { id: undefined } }, res);
  return res;
}
const slugFor = (name: string) => `studio-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

test("the setup lists real senders and provider-backed templates with V2-04 verdicts; local drafts and samples are not offered", async () => {
  const slug = slugFor("list");
  const world = await workspaceWorld(slug, {
    phones: 2,
    templates: [
      { name: "promo_a", body: "Hi {{1}}" },
      { name: "promo_b", body: "Hello {{1}}, code {{2}}" },
      { name: "local_draft", body: "Draft", providerBacked: false },
    ],
  });
  try {
    await db.insert(phoneNumbersTable).values({ organizationId: world.organization.id, phone: "+15550009999", displayName: "Sample", status: "Connected", tpsLimit: 10, isSample: true });
    await db.update(phoneNumbersTable).set({ status: "Disconnected" }).where(eq(phoneNumbersTable.id, world.phones[1]!.id));
    const campaign = await createCampaign(world.organization.id, slug);
    const res = await load(world.organization.id, campaign.id);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const setup = res.body;
    assert.equal(setup.revision, 0);
    assert.deepEqual(setup.senders.map((s: { phoneNumberId: number }) => s.phoneNumberId).sort(), world.phones.map((p) => p.id).sort(), "samples are not offered");
    const connected = setup.senders.find((s: { phoneNumberId: number }) => s.phoneNumberId === world.phones[0]!.id);
    const disconnected = setup.senders.find((s: { phoneNumberId: number }) => s.phoneNumberId === world.phones[1]!.id);
    assert.equal(connected.usable, true);
    assert.equal(connected.transport, "workspace_credential");
    assert.equal(connected.wabaLabel, "Main account");
    assert.equal(disconnected.usable, false);
    assert.equal(disconnected.code, "phone_not_connected");
    assert.deepEqual(setup.templates.map((t: { name: string }) => t.name).sort(), ["promo_a", "promo_b"], "local drafts are not candidates");
    const promoB = setup.templates.find((t: { name: string }) => t.name === "promo_b");
    assert.deepEqual(promoB.requirements.map((r: { key: string }) => r.key), ["body:1", "body:2"]);
    assert.equal(promoB.usable, true);
    const text = JSON.stringify(setup);
    assert.ok(!text.includes(TOKEN_MARKER), "no secret material");
    assert.ok(!text.includes("credentialId"), "credential ids are not part of the setup");
    assert.equal(setup.execution.code, "no_senders");
  } finally { await deleteOrganization(world.organization.id); }
});
const TOKEN_MARKER = "EAAG-";

test("saving senders + templates + per-template mappings writes v1 routes (one template per number) and fences on revision", async () => {
  const slug = slugFor("save");
  const world = await workspaceWorld(slug, { phones: 2, templates: [{ name: "a", body: "Hi {{1}}" }, { name: "b", body: "Yo {{1}}" }] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    await seedAudience(world.organization.id, campaign.id, ["phone", "first_name", "email"], [{ phone: "+15551110001", first_name: "Ada", email: "ada@test" }]);
    const [a, b] = world.templates;
    const body = {
      revision: 0,
      senderPhoneNumberIds: world.phones.map((p) => p.id),
      templateIds: [a!.id, b!.id],
      mappings: [
        { templateId: a!.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
        { templateId: b!.id, component: "body", variable: "1", source: "csv", sourceValue: "email" },
      ],
    };
    const res = await save(world.organization.id, campaign.id, body);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.revision, 1);
    assert.equal(res.body.execution.code, "ok");
    const routes = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id));
    assert.equal(routes.length, 2);
    assert.deepEqual(new Set(routes.map((r) => r.templateId)), new Set([a!.id, b!.id]), "every template has a sender");
    assert.equal(new Set(routes.map((r) => r.phoneNumberId)).size, 2, "one route (one template) per number under allocator v1");
    assert.ok(routes.every((r) => r.configuredTps === 40 && r.wabaId === world.waba.id));
    const mappings = await db.select().from(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.campaignId, campaign.id));
    assert.deepEqual(mappings.map((m) => [m.templateId, m.sourceValue]).sort(), [[a!.id, "first_name"], [b!.id, "email"]].sort());
    assert.deepEqual(await validateCampaignReady(world.organization.id, campaign.id), []);
    // Nothing was planned or executed by saving.
    assert.equal((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaign.id))).length, 0);
    assert.equal((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id))).length, 0);
    const [row] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id));
    assert.equal(row!.status, "Draft");

    // Stale revision: a second tab that read revision 0 cannot overwrite.
    const stale = await save(world.organization.id, campaign.id, { ...body, mappings: [] });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.code, "stale_revision");
    assert.equal((await db.select().from(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.campaignId, campaign.id))).length, 2);

    // Re-saving the same pairing keeps the existing route rows.
    const again = await save(world.organization.id, campaign.id, { ...body, revision: 1 });
    assert.equal(again.statusCode, 200);
    const routesAfter = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id));
    assert.deepEqual(routesAfter.map((r) => r.id).sort(), routes.map((r) => r.id).sort());

    // A legacy writer (route create) bumps the revision and fences an older tab.
    const routeRes = fakeResponse();
    await createRoute({ organizationId: world.organization.id, role: "admin", authUser: { id: undefined }, body: { campaignId: campaign.id, phoneNumberId: world.phones[0]!.id, templateId: a!.id, configuredTps: 1 } }, routeRes);
    assert.equal(routeRes.statusCode, 201, JSON.stringify(routeRes.body));
    const fenced = await save(world.organization.id, campaign.id, { ...body, revision: 2 });
    assert.equal(fenced.statusCode, 409);
    assert.equal(fenced.body.code, "stale_revision");
    const audit = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, campaign.id), eq(campaignAuditTable.action, "message_setup_saved")));
    assert.equal(audit.length, 2);
  } finally { await deleteOrganization(world.organization.id); }
});

test("a selection allocator v1 cannot run is saved WITHOUT routes and readiness explains it (1 number x 2 templates = V2-06)", async () => {
  const slug = slugFor("multi");
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "a", body: "Hi" }, { name: "b", body: "Yo" }] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    await seedAudience(world.organization.id, campaign.id, ["phone"], [{ phone: "+15551110001" }]);
    const res = await save(world.organization.id, campaign.id, {
      revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: world.templates.map((t) => t.id), mappings: [],
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.execution.executable, false);
    assert.equal(res.body.execution.code, "needs_multi_template");
    assert.match(res.body.execution.message, /V2-06/);
    assert.deepEqual(res.body.selection.templateIds, world.templates.map((t) => t.id), "no template is silently dropped");
    assert.equal((await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id))).length, 0, "no misleading routes");
    const errors = await validateCampaignReady(world.organization.id, campaign.id);
    assert.ok(errors.some((e) => e.startsWith("Message setup:") && e.includes("more than one template")), errors.join(" | "));
    await assert.rejects(planCampaign(world.organization.id, campaign.id), /Campaign is not ready|Message setup/);
  } finally { await deleteOrganization(world.organization.id); }
});

test("an incompatible pair (template on another business account) is never turned into a route", async () => {
  const slug = slugFor("incompat");
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "a", body: "Hi" }], secondWaba: true });
  try {
    await db.update(templatesTable).set({ wabaId: world.otherWaba!.id }).where(eq(templatesTable.id, world.templates[0]!.id));
    const campaign = await createCampaign(world.organization.id, slug);
    const res = await save(world.organization.id, campaign.id, { revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [world.templates[0]!.id], mappings: [] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.execution.code, "incompatible");
    const template = res.body.templates.find((t: { templateId: number }) => t.templateId === world.templates[0]!.id);
    assert.deepEqual(template.compatibleSenderIds, [], "the V2-04 decision (different business accounts) is what the UI sees");
    assert.equal((await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id))).length, 0);
    const errors = await validateCampaignReady(world.organization.id, campaign.id);
    assert.ok(errors.some((e) => e.startsWith("Message setup:")), errors.join(" | "));
  } finally { await deleteOrganization(world.organization.id); }
});

test("cross-tenant, unusable and local-draft selections fail closed", async () => {
  const slug = slugFor("tenant");
  const world = await workspaceWorld(slug, { phones: 2, templates: [{ name: "a", body: "Hi" }, { name: "draft", body: "x", providerBacked: false }] });
  const other = await workspaceWorld(`${slug}-o`, { phones: 1, templates: [{ name: "theirs", body: "Hi" }] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    const mine = { senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [world.templates[0]!.id], mappings: [] };
    const foreignSender = await save(world.organization.id, campaign.id, { revision: 0, ...mine, senderPhoneNumberIds: [other.phones[0]!.id] });
    assert.equal(foreignSender.statusCode, 404);
    assert.equal(foreignSender.body.code, "not_found");
    const foreignTemplate = await save(world.organization.id, campaign.id, { revision: 0, ...mine, templateIds: [other.templates[0]!.id] });
    assert.equal(foreignTemplate.statusCode, 404);
    const draft = await save(world.organization.id, campaign.id, { revision: 0, ...mine, templateIds: [world.templates[1]!.id] });
    assert.equal(draft.statusCode, 400);
    assert.equal(draft.body.code, "template_unusable");
    await db.update(phoneNumbersTable).set({ status: "Disconnected" }).where(eq(phoneNumbersTable.id, world.phones[1]!.id));
    const unusable = await save(world.organization.id, campaign.id, { revision: 0, ...mine, senderPhoneNumberIds: [world.phones[1]!.id] });
    assert.equal(unusable.statusCode, 400);
    assert.equal(unusable.body.code, "sender_unusable");
    // Another workspace cannot read or write this campaign.
    const foreignRead = await load(other.organization.id, campaign.id);
    assert.equal(foreignRead.statusCode, 404);
    const foreignWrite = await save(other.organization.id, campaign.id, { revision: 0, senderPhoneNumberIds: [], templateIds: [], mappings: [] });
    assert.equal(foreignWrite.statusCode, 404);
    assert.equal((await db.select().from(campaignTemplateSelectionsTable).where(eq(campaignTemplateSelectionsTable.campaignId, campaign.id))).length, 0, "nothing was written");
  } finally {
    await deleteOrganization(world.organization.id);
    await deleteOrganization(other.organization.id);
  }
});

test("lifecycle: a Ready campaign's plan is superseded atomically; edits are refused after jobs exist and for Paused (never reset)", async () => {
  const slug = slugFor("life");
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "a", body: "Hi {{1}}" }] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    await seedAudience(world.organization.id, campaign.id, ["phone", "first_name"], [{ phone: "+15551110001", first_name: "Ada" }]);
    const body = (revision: number, value: string) => ({
      revision, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [world.templates[0]!.id],
      mappings: [{ templateId: world.templates[0]!.id, component: "body", variable: "1", source: "static", sourceValue: value }],
    });
    assert.equal((await save(world.organization.id, campaign.id, body(0, "one"))).statusCode, 200);
    const planned = await planCampaign(world.organization.id, campaign.id);
    assert.equal(planned.plan.allocatorVersion, ALLOCATOR_VERSION);
    assert.equal(ALLOCATOR_VERSION, "v1");
    const ready = await save(world.organization.id, campaign.id, body(1, "two"));
    assert.equal(ready.statusCode, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.status, "Draft");
    const [plan] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, planned.plan.id));
    assert.equal(plan!.status, "Superseded", "the stale plan can never be scheduled or executed");
    assert.equal((plan!.mappingsSnapshot as Array<{ sourceValue: string }>)[0]!.sourceValue, "one", "the frozen snapshot itself is untouched");
    const reopen = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, campaign.id), eq(campaignAuditTable.action, "reopen")));
    assert.equal(reopen.length, 1);

    await planCampaign(world.organization.id, campaign.id);
    await db.insert(campaignJobsTable).values({ organizationId: world.organization.id, campaignId: campaign.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-job`, status: "Sent" });
    for (const status of ["Ready", "Running", "Paused"]) {
      await db.update(campaignsTable).set({ status }).where(eq(campaignsTable.id, campaign.id));
      const current = (await load(world.organization.id, campaign.id)).body;
      assert.equal(current.editable, false);
      const refused = await save(world.organization.id, campaign.id, body(current.revision, "three"));
      assert.equal(refused.statusCode, 409, status);
      assert.equal(refused.body.code, status === "Ready" ? "execution_history" : "setup_locked", status);
      const [after] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id));
      assert.equal(after!.status, status, "never reset to Draft");
    }
    const [active] = await db.select().from(campaignPlansTable).where(and(eq(campaignPlansTable.campaignId, campaign.id), eq(campaignPlansTable.status, "Active")));
    assert.ok(active, "the executed plan stays active");
  } finally { await deleteOrganization(world.organization.id); }
});

test("message studio mutations require a campaign-management role; reads require membership", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guards = (routePath: string, method: string): number => {
    for (const layer of (messageStudioRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: unknown[] } }> }).stack) {
      if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.length - 1;
    }
    throw new Error(`missing ${method} ${routePath}`);
  };
  for (const [routePath, method] of [[`${base}/message-setup`, "put"], [`${base}/message-setup/apply-preset`, "post"], [`${base}/message-setup/test-send`, "post"], [`${base}/media`, "post"], [`${base}/media/:mediaAssetId`, "delete"], ["/organizations/:organizationId/mapping-presets", "post"], ["/organizations/:organizationId/mapping-presets/:presetId", "put"], ["/organizations/:organizationId/mapping-presets/:presetId", "delete"]] as const) {
    assert.equal(guards(routePath, method), 4, `${method} ${routePath}: auth, org, active org, role`);
  }
  for (const [routePath, method] of [[`${base}/message-setup`, "get"], [`${base}/message-setup/preview`, "post"], [`${base}/media`, "get"], [`${base}/media/:mediaAssetId/content`, "get"], ["/organizations/:organizationId/mapping-presets", "get"]] as const) {
    assert.equal(guards(routePath, method), 3, `${method} ${routePath}: membership only`);
  }
});

void createOrganization;
