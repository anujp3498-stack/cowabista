import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { campaignTemplateMappingsTable, campaignsTable, db, pool, settlementPool } from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import campaignEngineRouter from "../src/routes/campaign-engine";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { validateCampaignReady } from "../src/services/campaign-preflight";
import { applySharedDefaults, describeTemplate, expandCompatibleMappings } from "../src/services/template-mapping";
import { resolveTemplateParameters, resolveTemplateVariables } from "../src/services/template-resolution";
import { createCampaign, deleteOrganization, fakeResponse, findRouteHandler, seedAudience, workspaceWorld } from "./message-studio-fixtures";

// V2-05B mappings: every selected template carries its own explicit
// mapping; header/body/button slots stay component-scoped; shared defaults
// are an authoring convenience that never overrides an explicit mapping;
// readiness (not save) refuses missing mappings and missing audience
// columns of the ACTIVE generation; pre-V2-05B mappings resolve unchanged.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const base = "/organizations/:organizationId/campaigns/:campaignId";
const putSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "put");
const legacyPut = findRouteHandler(campaignEngineRouter, `${base}/template-mappings`, "put");
const slugFor = (name: string) => `map-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

async function save(organizationId: number, campaignId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await putSetup({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body, authUser: {} }, res);
  return res;
}

const RICH = [
  { type: "HEADER", format: "TEXT", text: "Offer for {{1}}" },
  { type: "BODY", text: "Hi {{1}}, tier {{2}}" },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }, { type: "URL", text: "Open", url: "https://shop.test/u/{{1}}" }] },
];

test("two templates keep different mappings for the same slot, with header/body/button variables separately scoped", async () => {
  const slug = slugFor("independent");
  const world = await workspaceWorld(slug, { phones: 2, templates: [
    { name: "rich", body: "Hi {{1}}, tier {{2}}", components: RICH },
    { name: "plain", body: "Hello {{1}}" },
  ] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    await seedAudience(world.organization.id, campaign.id, ["phone", "first_name", "email", "customer_id", "city"], [
      { phone: "+15551110001", first_name: "Ada", email: "ada@test", customer_id: "C-77", city: "Leeds" },
    ]);
    const [rich, plain] = world.templates;
    const mappings = [
      { templateId: rich!.id, component: "header", variable: "1", source: "csv", sourceValue: "city" },
      { templateId: rich!.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
      { templateId: rich!.id, component: "body", variable: "2", source: "static", sourceValue: "VIP" },
      { templateId: rich!.id, component: "button", variable: "1:1", source: "csv", sourceValue: "customer_id" },
      { templateId: plain!.id, component: "body", variable: "1", source: "csv", sourceValue: "email" },
    ];
    const res = await save(world.organization.id, campaign.id, { revision: 0, senderPhoneNumberIds: world.phones.map((p) => p.id), templateIds: [rich!.id, plain!.id], mappings });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const richTemplate = res.body.templates.find((t: { templateId: number }) => t.templateId === rich!.id);
    assert.deepEqual(richTemplate.requirements.map((r: { key: string; label: string }) => [r.key, r.label]), [
      ["body:1", "Body {{1}}"], ["body:2", "Body {{2}}"], ["button:1:1", "Button 2 link {{1}}"], ["header:1", "Header {{1}}"],
    ]);
    const stored = await db.select().from(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.campaignId, campaign.id));
    assert.equal(stored.length, 5, "both templates' body:1 coexist with different sources");
    assert.deepEqual(await validateCampaignReady(world.organization.id, campaign.id), []);

    const contact = { first_name: "Ada", email: "ada@test", customer_id: "C-77", city: "Leeds" };
    const richResolved = resolveTemplateParameters(rich!, stored.filter((m) => m.templateId === rich!.id), contact);
    assert.deepEqual(richResolved, {
      resolved: { header: { "1": "Leeds" }, body: { "1": "Ada", "2": "VIP" }, button: { "1:1": "C-77" } },
      unresolved: [],
    });
    const plainResolved = resolveTemplateParameters(plain!, stored.filter((m) => m.templateId === plain!.id), contact);
    assert.deepEqual(plainResolved.resolved.body, { "1": "ada@test" });

    // The legacy replacement no longer rejects templates that disagree.
    const legacy = fakeResponse();
    await legacyPut({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, body: { templateIds: [rich!.id, plain!.id], mappings } }, legacy);
    assert.equal(legacy.statusCode, 200, JSON.stringify(legacy.body));
    assert.ok(legacy.body.templates.every((t: { compatible: boolean }) => t.compatible), "header kinds no longer restrict combinations");
  } finally { await deleteOrganization(world.organization.id); }
});

test("shared defaults fill only unmapped slots, never override an explicit mapping, and never guess on disagreement", () => {
  const a = describeTemplate({ id: 1, body: "Hi {{1}}", components: [] });
  const b = describeTemplate({ id: 2, body: "Hi {{1}}", components: [] });
  const c = describeTemplate({ id: 3, body: "Hi {{1}}", components: [] });
  const filled = applySharedDefaults([a, b], [{ templateId: 1, component: "body", variable: "1", source: "csv", sourceValue: "first_name" }]);
  assert.deepEqual(filled.map((m) => [m.templateId, m.sourceValue]), [[1, "first_name"], [2, "first_name"]]);
  const override = applySharedDefaults([a, b], [
    { templateId: 1, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    { templateId: 2, component: "body", variable: "1", source: "static", sourceValue: "friend" },
  ]);
  assert.deepEqual(override.map((m) => [m.templateId, m.source, m.sourceValue]), [[1, "csv", "first_name"], [2, "static", "friend"]], "per-template override wins");
  const disagreement = applySharedDefaults([a, b, c], [
    { templateId: 1, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    { templateId: 2, component: "body", variable: "1", source: "csv", sourceValue: "email" },
  ]);
  assert.equal(disagreement.filter((m) => m.templateId === 3).length, 0, "no default is guessed when explicit mappings disagree");
  // A media header default only spreads to templates of the same kind.
  const image = describeTemplate({ id: 4, body: "x", components: [{ type: "HEADER", format: "IMAGE" }] });
  const video = describeTemplate({ id: 5, body: "x", components: [{ type: "HEADER", format: "VIDEO" }] });
  const image2 = describeTemplate({ id: 6, body: "x", components: [{ type: "HEADER", format: "IMAGE" }] });
  const media = applySharedDefaults([image, video, image2], [{ templateId: 4, component: "header", variable: "media", source: "media_asset", sourceValue: "9", mediaAssetId: 9 }]);
  assert.deepEqual(media.map((m) => m.templateId).sort(), [4, 6]);
  // The historic helper keeps its documented behaviour for its callers.
  assert.throws(() => expandCompatibleMappings([a, b], [
    { templateId: 1, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    { templateId: 2, component: "body", variable: "1", source: "csv", sourceValue: "email" },
  ]), /one shared mapping/);
});

test("invalid mappings fail at save; missing mappings save but block readiness; audience columns come from the active generation", async () => {
  const slug = slugFor("readiness");
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "t", body: "Hi {{1}} {{2}}" }] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    const t = world.templates[0]!;
    const body = (mappings: unknown[], revision = 0) => ({ revision, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [t.id], mappings });
    const unknown = await save(world.organization.id, campaign.id, body([{ templateId: t.id, component: "body", variable: "3", source: "static", sourceValue: "x" }]));
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.body.code, "invalid_mappings");
    assert.match(unknown.body.details.join(" "), /Unknown variable body:3/);
    const duplicate = await save(world.organization.id, campaign.id, body([
      { templateId: t.id, component: "body", variable: "1", source: "static", sourceValue: "x" },
      { templateId: t.id, component: "body", variable: "1", source: "static", sourceValue: "y" },
    ]));
    assert.equal(duplicate.statusCode, 400);
    const scoped = await save(world.organization.id, campaign.id, body([{ templateId: t.id, component: "header", variable: "1", source: "static", sourceValue: "x" }]));
    assert.equal(scoped.statusCode, 400, "body {{1}} and header {{1}} are different slots");
    const notSelected = await save(world.organization.id, campaign.id, body([{ templateId: t.id + 99999, component: "body", variable: "1", source: "static", sourceValue: "x" }]));
    assert.equal(notSelected.statusCode, 400);

    // Generation 0 had first_name; the ACTIVE generation (1, a replace) has only email.
    await seedAudience(world.organization.id, campaign.id, ["phone", "first_name"], [{ phone: "+15551110001", first_name: "Old" }], { generation: 0 });
    await seedAudience(world.organization.id, campaign.id, ["phone", "email"], [{ phone: "+15551110002", email: "new@test" }], { generation: 1 });
    await db.update(campaignsTable).set({ audienceGeneration: 1 }).where(eq(campaignsTable.id, campaign.id));
    const partial = await save(world.organization.id, campaign.id, body([{ templateId: t.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" }]));
    assert.equal(partial.statusCode, 200, "an incomplete draft is saveable");
    assert.deepEqual(partial.body.audienceColumns, [{ name: "phone", availability: "all" }, { name: "email", availability: "all" }]);
    let errors = await validateCampaignReady(world.organization.id, campaign.id);
    assert.ok(errors.some((e) => e.includes(`missing mapping body:2`)), errors.join(" | "));
    assert.ok(errors.some((e) => e.includes(`"first_name"`) && e.includes("missing from the latest import")), "a column of a replaced audience does not count");

    // A column only some uploads of the active audience have.
    await seedAudience(world.organization.id, campaign.id, ["phone", "email", "city"], [{ phone: "+15551110003", email: "c@test", city: "York" }], { generation: 1 });
    const some = await save(world.organization.id, campaign.id, body([
      { templateId: t.id, component: "body", variable: "1", source: "csv", sourceValue: "city" },
      { templateId: t.id, component: "body", variable: "2", source: "csv", sourceValue: "email" },
    ], 1));
    assert.equal(some.statusCode, 200);
    assert.deepEqual(some.body.audienceColumns.find((c: { name: string }) => c.name === "city"), { name: "city", availability: "some" });
    errors = await validateCampaignReady(world.organization.id, campaign.id);
    assert.ok(errors.some((e) => e.includes(`"city"`) && e.includes("some uploads")), errors.join(" | "));
    const optional = await save(world.organization.id, campaign.id, body([
      { templateId: t.id, component: "body", variable: "1", source: "csv", sourceValue: "city", optional: true, fallbackValue: "your city" },
      { templateId: t.id, component: "body", variable: "2", source: "csv", sourceValue: "email" },
    ], 2));
    assert.equal(optional.statusCode, 200);
    assert.deepEqual(await validateCampaignReady(world.organization.id, campaign.id), [], "an optional mapping with a fallback may use a partial column");
  } finally { await deleteOrganization(world.organization.id); }
});

test("pre-V2-05B mapping rows (no media asset, legacy sources) resolve exactly as before", () => {
  const descriptor = { id: 7, body: "Hi {{1}}, order {{2}}", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://t.test/{{1}}" }] }] };
  const legacyRows = [
    { component: "header", variable: "media", source: "static", sourceValue: "https://cdn.test/a.jpg" },
    { component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    { component: "body", variable: "2", source: "csv", sourceValue: "order", optional: true, fallbackValue: "N/A" },
    { component: "button", variable: "0:1", source: "csv", sourceValue: "code" },
  ];
  assert.deepEqual(resolveTemplateVariables(descriptor, legacyRows, { first_name: "Ada", order: "", code: "Z9" }), {
    header: { media: "https://cdn.test/a.jpg" }, body: { "1": "Ada", "2": "N/A" }, button: { "0:1": "Z9" },
  });
  assert.throws(() => resolveTemplateVariables(descriptor, legacyRows.slice(1), { first_name: "Ada", code: "Z9" }), /^Error: Missing mapping header:media for template 7$/);
  assert.throws(() => resolveTemplateVariables(descriptor, legacyRows, { order: "1", code: "Z9" }), /^Error: Mapping body:1 resolved to an empty value$/);
});

test("presets are workspace-scoped copies: applying fills slots, editing the preset later never changes the campaign", async () => {
  const slug = slugFor("preset");
  const world = await workspaceWorld(slug, { phones: 2, templates: [{ name: "a", body: "Hi {{1}} {{2}}" }, { name: "b", body: "Yo {{1}}" }] });
  const other = await workspaceWorld(`${slug}-o`, { phones: 1, templates: [{ name: "x", body: "Hi" }] });
  const createPreset = findRouteHandler(messageStudioRouter, "/organizations/:organizationId/mapping-presets", "post");
  const listPresets = findRouteHandler(messageStudioRouter, "/organizations/:organizationId/mapping-presets", "get");
  const updatePreset = findRouteHandler(messageStudioRouter, "/organizations/:organizationId/mapping-presets/:presetId", "put");
  const deletePreset = findRouteHandler(messageStudioRouter, "/organizations/:organizationId/mapping-presets/:presetId", "delete");
  const applyPreset = findRouteHandler(messageStudioRouter, `${base}/message-setup/apply-preset`, "post");
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    await seedAudience(world.organization.id, campaign.id, ["phone", "first_name", "email"], [{ phone: "+15551110001", first_name: "Ada", email: "a@t" }]);
    const [a, b] = world.templates;
    const saved = await save(world.organization.id, campaign.id, {
      revision: 0, senderPhoneNumberIds: world.phones.map((p) => p.id), templateIds: [a!.id, b!.id],
      mappings: [{ templateId: b!.id, component: "body", variable: "1", source: "static", sourceValue: "keep me" }],
    });
    assert.equal(saved.statusCode, 200);

    const created = fakeResponse();
    await createPreset({ params: { organizationId: String(world.organization.id) }, authUser: {}, body: { name: "Standard", entries: [
      { component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
      { component: "body", variable: "2", source: "csv", sourceValue: "email" },
    ] } }, created);
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    const duplicate = fakeResponse();
    await createPreset({ params: { organizationId: String(world.organization.id) }, authUser: {}, body: { name: "Standard", entries: [] } }, duplicate);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.code, "name_conflict");
    const invalid = fakeResponse();
    await createPreset({ params: { organizationId: String(world.organization.id) }, authUser: {}, body: { name: "Bad", entries: [{ component: "header", variable: "media", source: "static", sourceValue: "x" }] } }, invalid);
    assert.equal(invalid.statusCode, 400, "presets never carry media slots");

    const applied = fakeResponse();
    await applyPreset({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, authUser: {}, body: { revision: 1, presetId: created.body.id } }, applied);
    assert.equal(applied.statusCode, 200, JSON.stringify(applied.body));
    const byKey = (rows: Array<{ templateId: number; component: string; variable: string; sourceValue: string }>) =>
      Object.fromEntries(rows.map((m) => [`${m.templateId}:${m.component}:${m.variable}`, m.sourceValue]));
    assert.deepEqual(byKey(applied.body.mappings), {
      [`${a!.id}:body:1`]: "first_name", [`${a!.id}:body:2`]: "email", [`${b!.id}:body:1`]: "keep me",
    }, "empty slots filled; an existing per-template mapping is kept");

    // Editing (then deleting) the preset never touches the configured campaign.
    const edited = fakeResponse();
    await updatePreset({ params: { organizationId: String(world.organization.id), presetId: String(created.body.id) }, authUser: {}, body: { name: "Standard", entries: [{ component: "body", variable: "1", source: "static", sourceValue: "CHANGED" }] } }, edited);
    assert.equal(edited.statusCode, 200);
    const removed = fakeResponse();
    await deletePreset({ params: { organizationId: String(world.organization.id), presetId: String(created.body.id) } }, removed);
    assert.equal(removed.statusCode, 204);
    const after = await db.select().from(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.campaignId, campaign.id));
    assert.deepEqual(byKey(after), byKey(applied.body.mappings));

    // Another workspace cannot see or apply this workspace's presets.
    const second = fakeResponse();
    await createPreset({ params: { organizationId: String(world.organization.id) }, authUser: {}, body: { name: "Mine", entries: [] } }, second);
    const foreignList = fakeResponse();
    await listPresets({ params: { organizationId: String(other.organization.id) } }, foreignList);
    assert.deepEqual(foreignList.body, []);
    const otherCampaign = await createCampaign(other.organization.id, `${slug}-o`);
    const foreignApply = fakeResponse();
    await applyPreset({ params: { organizationId: String(other.organization.id), campaignId: String(otherCampaign.id) }, authUser: {}, body: { revision: 0, presetId: second.body.id } }, foreignApply);
    assert.equal(foreignApply.statusCode, 404);
    const foreignEdit = fakeResponse();
    await updatePreset({ params: { organizationId: String(other.organization.id), presetId: String(second.body.id) }, authUser: {}, body: { name: "Stolen", entries: [] } }, foreignEdit);
    assert.equal(foreignEdit.statusCode, 404);
  } finally {
    await deleteOrganization(world.organization.id);
    await deleteOrganization(other.organization.id);
  }
});
