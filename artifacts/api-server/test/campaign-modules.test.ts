import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignJobsTable,
  campaignMessageSetupsTable,
  campaignMetricsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import campaignsRouter from "../src/routes/campaigns";
import campaignRoutesRouter from "../src/routes/campaign-routes";
import campaignEngineRouter from "../src/routes/campaign-engine";
import { ALLOCATOR_V2 } from "../src/services/allocator-version";
import { deleteOrganization, fakeResponse, findRouteHandler, seedAudience } from "./message-studio-fixtures";
import { campaignAction, drainWithWorker, firstNameMappings, preflight, providerLog, saveDelivery, saveSetup, v2World } from "./v2-fixtures";

// Campaign modules: a Normal ("standard") and a Rocket ("rocket") campaign
// are each created directly, run on the same engine (message setup,
// delivery setup, preflight, launch, allocator v2, unchanged runtime) and
// keep their type for life. Everything sends to the in-process mock
// provider; nothing leaves the process.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `modules-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
const createHandler = findRouteHandler(campaignsRouter, "/campaigns", "post");
const listPageHandler = findRouteHandler(campaignsRouter, "/campaigns/list", "get");
const getHandler = findRouteHandler(campaignsRouter, "/campaigns/:campaignId", "get");
const patchHandler = findRouteHandler(campaignsRouter, "/campaigns/:campaignId", "patch");
const routeCreate = findRouteHandler(campaignRoutesRouter, "/campaign-routes", "post");
const routePatch = findRouteHandler(campaignRoutesRouter, "/campaign-routes/:routeId", "patch");
const routeDelete = findRouteHandler(campaignRoutesRouter, "/campaign-routes/:routeId", "delete");
const rocketSetup = findRouteHandler(campaignRoutesRouter, "/organizations/:organizationId/campaigns/:campaignId/rocket-setup", "put");
const legacyMappings = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/template-mappings", "put");

async function create(organizationId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await createHandler({ organizationId, body, authUser: {} }, res);
  return res;
}
async function listPage(organizationId: number, query: Record<string, string>) {
  const res = fakeResponse();
  await listPageHandler({ organizationId, query }, res);
  return res;
}
async function getOne(organizationId: number, campaignId: number) {
  const res = fakeResponse();
  await getHandler({ organizationId, params: { campaignId: String(campaignId) } }, res);
  return res;
}
async function audience(organizationId: number, campaignId: number, contacts: number) {
  const rows = Array.from({ length: contacts }, (_, index) => ({ phone: `+448${String(campaignId % 100_000).padStart(5, "0")}${String(index).padStart(4, "0")}`, first_name: `M${index}` }));
  await seedAudience(organizationId, campaignId, ["phone", "first_name"], rows);
  await db.insert(campaignMetricsTable).values({ organizationId, campaignId, total: contacts, valid: contacts }).onConflictDoNothing();
}
const key = () => `key-${randomBytes(8).toString("hex")}`;
const blockers = async (org: number, id: number) => {
  const res = await preflight(org, id);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return (res.body.blockers as Array<{ code: string }>).map((issue) => issue.code);
};

test("each module is created directly with its own setup; the type is returned, replay-safe per type, and never changes", async () => {
  const slug = slugFor("create");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const normalKey = key();
    const normal = await create(org, { name: "Normal one", creationKey: normalKey, campaignType: "standard" });
    assert.equal(normal.statusCode, 201, JSON.stringify(normal.body));
    assert.equal(normal.body.campaignType, "standard");
    assert.equal(normal.body.campaignTypeInferred, false);
    assert.equal(normal.body.distributionMode, "equal_numbers", "a Normal campaign starts with the automatic distribution");
    assert.equal(normal.body.deliveryMode, "balanced", "a Normal campaign has no Delivery step: it starts at Balanced");

    const rocket = await create(org, { name: "Rocket one", creationKey: key(), campaignType: "rocket" });
    assert.equal(rocket.statusCode, 201);
    assert.equal(rocket.body.campaignType, "rocket");
    assert.equal(rocket.body.distributionMode, "equal_numbers");
    assert.equal(rocket.body.deliveryMode, null, "a Rocket campaign's speed is chosen in its Delivery step");

    // Replays: same type -> the same Draft; another type -> refused; untyped -> the same Draft.
    const replay = await create(org, { name: "Normal one", creationKey: normalKey, campaignType: "standard" });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.id, normal.body.id);
    const crossed = await create(org, { name: "Rocket", creationKey: normalKey, campaignType: "rocket" });
    assert.equal(crossed.statusCode, 409);
    assert.equal(crossed.body.code, "creation_key_conflict");
    assert.equal((await create(org, { name: "x", creationKey: normalKey })).body.id, normal.body.id);

    // Untyped create keeps the historical behaviour (no defaults) and is inferred.
    const legacy = await create(org, { name: "Legacy" });
    assert.equal(legacy.statusCode, 201);
    assert.equal(legacy.body.campaignType, "standard");
    assert.equal(legacy.body.campaignTypeInferred, true);
    assert.equal(legacy.body.distributionMode, null);
    assert.equal(legacy.body.deliveryMode, null);
    const [legacyRow] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, legacy.body.id));
    assert.equal(legacyRow!.campaignType, null, "nothing is written for an untyped campaign");

    // The type cannot be changed through PATCH (the field is not part of the update).
    const patch = fakeResponse();
    await patchHandler({ organizationId: org, params: { campaignId: String(normal.body.id) }, body: { name: "Renamed", campaignType: "rocket" }, authUser: {} }, patch);
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.body.campaignType, "standard");
    assert.equal(patch.body.name, "Renamed");
    assert.equal((await getOne(org, normal.body.id)).body.campaignType, "standard");

    const bad = await create(org, { name: "Bad", campaignType: "turbo" });
    assert.equal(bad.statusCode, 400);
  } finally { await deleteOrganization(org); }
});

test("list views are separate: the type filter returns each module, and an untyped campaign is listed by its routes", async () => {
  const slug = slugFor("list");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const normal = (await create(org, { name: "N", campaignType: "standard" })).body;
    const rocket = (await create(org, { name: "R", campaignType: "rocket" })).body;
    const legacySingle = (await create(org, { name: "L1" })).body;
    const legacyMulti = (await create(org, { name: "L2" })).body;
    for (const phone of [w.phones.X!, w.phones.Y!]) {
      await db.insert(campaignRoutesTable).values({ organizationId: org, campaignId: legacyMulti.id, phoneNumberId: phone.id, templateId: w.templates.A!.id, configuredTps: 10, wabaId: phone.wabaId });
    }
    const ids = (res: { body: { items: Array<{ id: number }> } }) => res.body.items.map((item) => item.id).sort((a, b) => a - b);
    const standardPage = await listPage(org, { type: "standard" });
    assert.equal(standardPage.statusCode, 200, JSON.stringify(standardPage.body));
    assert.deepEqual(ids(standardPage), [normal.id, legacySingle.id].sort((a, b) => a - b));
    const rocketPage = await listPage(org, { type: "rocket" });
    assert.deepEqual(ids(rocketPage), [rocket.id, legacyMulti.id].sort((a, b) => a - b));
    const item = rocketPage.body.items.find((entry: { id: number }) => entry.id === legacyMulti.id);
    assert.equal(item.campaignType, "rocket");
    assert.equal(item.campaignTypeInferred, true);
    assert.equal((await listPage(org, {})).body.items.length, 4, "no filter: every campaign");
    assert.equal((await listPage(org, { type: "turbo" })).statusCode, 400);
  } finally { await deleteOrganization(org); }
});

test("Normal campaign: one number and one template, no Delivery step, launches and sends through the unchanged engine", async () => {
  const slug = slugFor("normal");
  const log = providerLog(path.join(os.tmpdir(), `modules-normal-${process.pid}-${Date.now()}.log`));
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: 40 }, { key: "Y", tps: 40 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const campaign = (await create(org, { name: "Normal send", creationKey: key(), campaignType: "standard" })).body;
    await audience(org, campaign.id, 6);
    const { X, Y } = w.phones;
    const { A, B } = w.templates;

    const twoNumbers = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id, Y!.id], templateIds: [A!.id], mappings: firstNameMappings([A!.id]) });
    assert.equal(twoNumbers.statusCode, 400);
    assert.equal(twoNumbers.body.code, "campaign_type_limit");
    assert.match(twoNumbers.body.error, /one number/);
    const twoTemplates = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id], templateIds: [A!.id, B!.id], mappings: firstNameMappings([A!.id, B!.id]) });
    assert.equal(twoTemplates.statusCode, 400);
    assert.equal(twoTemplates.body.code, "campaign_type_limit");
    assert.equal((await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id))).length, 0, "a refused save writes nothing");

    const ok = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id], templateIds: [A!.id], mappings: firstNameMappings([A!.id]) });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.deepEqual(await blockers(org, campaign.id), [], "no Delivery step is needed: distribution and speed come with the type");

    // Legacy route tools never touch a typed campaign.
    const [lane] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id));
    assert.ok(lane!.sharedPhoneBudget, "the one route is an allocator-v2 sender lane");
    const manual = fakeResponse();
    await routeCreate({ organizationId: org, body: { campaignId: campaign.id, phoneNumberId: Y!.id, templateId: A!.id, configuredTps: 5 }, authUser: {} }, manual);
    assert.equal(manual.statusCode, 409);
    assert.equal(manual.body.code, "campaign_type_mismatch");
    const patched = fakeResponse();
    await routePatch({ organizationId: org, params: { routeId: String(lane!.id) }, body: { status: "Paused" }, authUser: {} }, patched);
    assert.equal(patched.statusCode, 409);
    const removed = fakeResponse();
    await routeDelete({ organizationId: org, params: { routeId: String(lane!.id) }, authUser: {} }, removed);
    assert.equal(removed.statusCode, 409);
    const legacySetup = fakeResponse();
    await rocketSetup({ params: { organizationId: String(org), campaignId: String(campaign.id) }, body: { numbers: [{ phoneNumberId: X!.id, configuredTps: 5 }], templateIds: [A!.id] }, authUser: {} }, legacySetup);
    assert.equal(legacySetup.statusCode, 409);
    assert.equal(legacySetup.body.code, "campaign_type_mismatch");

    // Speed preset change (the Normal Review step) through the shared delivery setup.
    const conservative = await saveDelivery(org, campaign.id, { revision: ok.body.revision, distributionMode: "equal_numbers", deliveryMode: "conservative" });
    assert.equal(conservative.statusCode, 200, JSON.stringify(conservative.body));

    const launch = await campaignAction(org, campaign.id, { action: "launch" });
    assert.equal(launch.statusCode, 200, JSON.stringify(launch.body));
    assert.equal(launch.body.launch.outcome, "launched");
    assert.equal(launch.body.launch.queuedNew, 6);
    const [plan] = await db.select().from(campaignPlansTable).where(and(eq(campaignPlansTable.campaignId, campaign.id), eq(campaignPlansTable.status, "Active")));
    assert.equal(plan!.allocatorVersion, ALLOCATOR_V2);
    await drainWithWorker(campaign.id, 6, slug);
    const sent = log.entries();
    assert.equal(sent.length, 6);
    assert.ok(sent.every((entry) => entry.phoneId === X!.providerPhoneId && entry.payload.template.name === A!.name), "one number, one template");
  } finally {
    log.stop();
    await deleteOrganization(org);
  }
});

test("Normal campaign: schedule for later freezes the plan and waits (no jobs before it is due)", async () => {
  const slug = slugFor("schedule");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const campaign = (await create(org, { name: "Scheduled", campaignType: "standard" })).body;
    await audience(org, campaign.id, 3);
    assert.equal((await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id], templateIds: [w.templates.A!.id], mappings: firstNameMappings([w.templates.A!.id]) })).statusCode, 200);
    const at = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const scheduled = await campaignAction(org, campaign.id, { action: "launch", scheduledAt: at, timezone: "Asia/Kolkata" });
    assert.equal(scheduled.statusCode, 200, JSON.stringify(scheduled.body));
    assert.equal(scheduled.body.launch.outcome, "scheduled");
    assert.equal(scheduled.body.status, "Scheduled");
    assert.equal((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id))).length, 0);
    assert.equal((await campaignAction(org, campaign.id, { action: "cancel" })).statusCode, 200);
  } finally { await deleteOrganization(org); }
});

test("Rocket campaign: several numbers and rotating templates, per-number speed, automatic distribution, live speed change (pause, adjust, resume)", async () => {
  const slug = slugFor("rocket");
  const log = providerLog(path.join(os.tmpdir(), `modules-rocket-${process.pid}-${Date.now()}.log`));
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: 60 }, { key: "Y", tps: 30 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = w.organization.id;
  try {
    // Created directly: no Normal campaign is selected or needed.
    const campaign = (await create(org, { name: "Rocket send", creationKey: key(), campaignType: "rocket" })).body;
    assert.equal(campaign.campaignType, "rocket");
    await audience(org, campaign.id, 24);
    const { X, Y } = w.phones;
    const ids = [w.templates.A!.id, w.templates.B!.id];
    const message = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id, Y!.id], templateIds: ids, mappings: firstNameMappings(ids) });
    assert.equal(message.statusCode, 200, JSON.stringify(message.body));
    assert.ok((await blockers(org, campaign.id)).includes("delivery_required"), "a Rocket campaign needs its speed");

    const tooFast = await saveDelivery(org, campaign.id, { revision: message.body.revision, distributionMode: "equal_numbers", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: X!.id, messagesPerSecond: 61 }, { phoneNumberId: Y!.id, messagesPerSecond: 10 }] } });
    assert.equal(tooFast.statusCode, 400, "a per-number speed above the number's limit is refused, never clamped");
    const delivery = await saveDelivery(org, campaign.id, { revision: message.body.revision, distributionMode: "equal_numbers", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: X!.id, messagesPerSecond: 40 }, { phoneNumberId: Y!.id, messagesPerSecond: 20 }] } });
    assert.equal(delivery.statusCode, 200, JSON.stringify(delivery.body));
    assert.deepEqual(await blockers(org, campaign.id), []);
    const lanes = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id));
    assert.equal(lanes.length, 2, "one sender lane per number");
    assert.ok(lanes.every((lane) => lane.sharedPhoneBudget));

    const launch = await campaignAction(org, campaign.id, { action: "launch" });
    assert.equal(launch.statusCode, 200, JSON.stringify(launch.body));
    assert.equal(launch.body.launch.queuedNew, 24);
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    const byPhone = new Map<number, number>();
    for (const job of jobs) {
      const lane = lanes.find((candidate) => candidate.id === job.routeId)!;
      byPhone.set(lane.phoneNumberId, (byPhone.get(lane.phoneNumberId) ?? 0) + 1);
    }
    // Automatic distribution: allocator v2's deterministic equal-by-numbers
    // share (its exact balance is the allocator suite's contract); here every
    // selected number receives part of the audience and nothing is dropped.
    assert.ok((byPhone.get(X!.id) ?? 0) > 0 && (byPhone.get(Y!.id) ?? 0) > 0, `both numbers send: ${JSON.stringify([...byPhone])}`);
    assert.equal((byPhone.get(X!.id) ?? 0) + (byPhone.get(Y!.id) ?? 0), 24);
    assert.deepEqual(new Set(jobs.map((job) => job.templateId)), new Set(ids), "templates rotate across the audience");
    assert.ok(jobs.every((job) => job.configuredTps === (lanes.find((lane) => lane.id === job.routeId)!.phoneNumberId === X!.id ? 40 : 20)), "each number runs at its own speed");

    // Live speed change: the product flow pauses, adjusts and resumes.
    const runningAdjust = await campaignAction(org, campaign.id, { action: "adjust-speed", deliveryMode: "conservative" });
    assert.equal(runningAdjust.statusCode, 409, "the engine still requires a pause first");
    assert.equal((await campaignAction(org, campaign.id, { action: "pause" })).statusCode, 200);
    const adjusted = await campaignAction(org, campaign.id, { action: "adjust-speed", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: X!.id, messagesPerSecond: 30 }, { phoneNumberId: Y!.id, messagesPerSecond: 15 }] } });
    assert.equal(adjusted.statusCode, 200, JSON.stringify(adjusted.body));
    const resumed = await campaignAction(org, campaign.id, { action: "resume" });
    assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "Running");
    const after = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.ok(after.every((job) => job.configuredTps === (lanes.find((lane) => lane.id === job.routeId)!.phoneNumberId === X!.id ? 30 : 15)), "queued jobs carry the new per-number speed");
    assert.equal((await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, campaign.id), eq(campaignAuditTable.action, "adjust-speed")))).length, 1);

    await drainWithWorker(campaign.id, 24, slug, 90_000);
    const sent = log.entries();
    assert.equal(sent.length, 24);
    assert.deepEqual(new Set(sent.map((entry) => entry.phoneId)), new Set([X!.providerPhoneId, Y!.providerPhoneId]));
    assert.deepEqual(new Set(sent.map((entry) => entry.payload.template.name)), new Set([w.templates.A!.name, w.templates.B!.name]));

    // Legacy route tools stay away from a Rocket campaign too.
    const legacySetup = fakeResponse();
    await rocketSetup({ params: { organizationId: String(org), campaignId: String(campaign.id) }, body: { numbers: [{ phoneNumberId: X!.id, configuredTps: 5 }], templateIds: [w.templates.A!.id] }, authUser: {} }, legacySetup);
    assert.equal(legacySetup.statusCode, 409);
  } finally {
    log.stop();
    await deleteOrganization(org);
  }
});

test("an untyped (pre-types) campaign keeps every legacy tool and no module rule", async () => {
  const slug = slugFor("legacy");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const campaign = (await create(org, { name: "Old style" })).body;
    const legacySetup = fakeResponse();
    await rocketSetup({ params: { organizationId: String(org), campaignId: String(campaign.id) }, body: { numbers: [{ phoneNumberId: w.phones.X!.id, configuredTps: 5 }, { phoneNumberId: w.phones.Y!.id, configuredTps: 5 }], templateIds: [w.templates.A!.id, w.templates.B!.id] }, authUser: {} }, legacySetup);
    assert.equal(legacySetup.statusCode, 200, JSON.stringify(legacySetup.body));
    const read = await getOne(org, campaign.id);
    assert.equal(read.body.campaignType, "rocket", "two routes: listed with Rocket campaigns");
    assert.equal(read.body.campaignTypeInferred, true);
    const [route] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id));
    const patched = fakeResponse();
    await routePatch({ organizationId: org, params: { routeId: String(route!.id) }, body: { priority: "High" }, authUser: {} }, patched);
    assert.equal(patched.statusCode, 200, JSON.stringify(patched.body));
    const [setupRow] = await db.select({ revision: campaignMessageSetupsTable.revision }).from(campaignMessageSetupsTable).where(eq(campaignMessageSetupsTable.campaignId, campaign.id));
    const two = await saveSetup(org, campaign.id, { revision: setupRow?.revision ?? 0, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id], templateIds: [w.templates.A!.id], mappings: firstNameMappings([w.templates.A!.id]) });
    assert.equal(two.statusCode, 200, JSON.stringify(two.body));
  } finally { await deleteOrganization(org); }
});

test("typed campaigns keep their module rules on every setup writer; a pause says whether it changed anything", async () => {
  const slug = slugFor("rules");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const { X, Y } = w.phones;
    const { A, B } = w.templates;
    const normal = (await create(org, { name: "Normal rules", campaignType: "standard" })).body;
    const rocket = (await create(org, { name: "Rocket rules", campaignType: "rocket" })).body;
    const legacy = (await create(org, { name: "Legacy rules" })).body;

    // The legacy template-mappings writer cannot add templates to a typed campaign.
    for (const campaign of [normal, rocket]) {
      const res = fakeResponse();
      await legacyMappings({ params: { organizationId: String(org), campaignId: String(campaign.id) }, body: { templateIds: [A!.id, B!.id], mappings: [] }, authUser: {} }, res);
      assert.equal(res.statusCode, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, "campaign_type_mismatch");
    }
    const legacyRes = fakeResponse();
    await legacyMappings({ params: { organizationId: String(org), campaignId: String(legacy.id) }, body: { templateIds: [A!.id, B!.id], mappings: [] }, authUser: {} }, legacyRes);
    assert.equal(legacyRes.statusCode, 200, `an untyped campaign keeps the legacy writer: ${JSON.stringify(legacyRes.body)}`);

    // A typed campaign never goes back to allocator v1 (distributionMode null).
    const toV1 = await saveSetup(org, rocket.id, { revision: 0, senderPhoneNumberIds: [X!.id, Y!.id], templateIds: [A!.id], mappings: firstNameMappings([A!.id]), distributionMode: null });
    assert.equal(toV1.statusCode, 400);
    assert.equal(toV1.body.code, "distribution_invalid");
    assert.equal((await getOne(org, rocket.id)).body.distributionMode, "equal_numbers");

    // pause: alreadySettled=false when it paused, true when the campaign was already paused.
    await audience(org, normal.id, 4);
    const setup = await saveSetup(org, normal.id, { revision: 0, senderPhoneNumberIds: [X!.id], templateIds: [A!.id], mappings: firstNameMappings([A!.id]) });
    assert.equal(setup.statusCode, 200, JSON.stringify(setup.body));
    assert.equal((await campaignAction(org, normal.id, { action: "launch" })).statusCode, 200);
    const first = await campaignAction(org, normal.id, { action: "pause" });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, "Paused");
    assert.equal(first.body.alreadySettled, false);
    const second = await campaignAction(org, normal.id, { action: "pause" });
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.alreadySettled, true, "someone else's (or an earlier) pause is reported as such");
    assert.equal((await campaignAction(org, normal.id, { action: "cancel" })).statusCode, 200);
  } finally { await deleteOrganization(org); }
});

test("live speed change never undoes a pause someone else made while it ran; plain pause retries stay audit-free", async () => {
  const slug = slugFor("hold");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const { X, Y } = w.phones;
    const rocket = (await create(org, { name: "Hold", campaignType: "rocket" })).body;
    await audience(org, rocket.id, 20);
    const message = await saveSetup(org, rocket.id, { revision: 0, senderPhoneNumberIds: [X!.id, Y!.id], templateIds: [w.templates.A!.id], mappings: firstNameMappings([w.templates.A!.id]) });
    assert.equal(message.statusCode, 200, JSON.stringify(message.body));
    assert.equal((await saveDelivery(org, rocket.id, { revision: message.body.revision, distributionMode: "equal_numbers", deliveryMode: "conservative" })).statusCode, 200);
    assert.equal((await campaignAction(org, rocket.id, { action: "launch" })).statusCode, 200);
    const pauses = async () => (await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, rocket.id), eq(campaignAuditTable.action, "pause")))).length;

    assert.equal((await campaignAction(org, rocket.id, { action: "launch", purpose: "speed_change" })).statusCode, 400, "purpose is for pause and resume only");

    // Uninterrupted: pause (speed_change) -> adjust -> resume (speed_change).
    const hold = await campaignAction(org, rocket.id, { action: "pause", purpose: "speed_change" });
    assert.equal(hold.statusCode, 200);
    assert.equal(hold.body.alreadySettled, false);
    assert.equal((await campaignAction(org, rocket.id, { action: "adjust-speed", deliveryMode: "balanced" })).statusCode, 200);
    const resumed = await campaignAction(org, rocket.id, { action: "resume", purpose: "speed_change" });
    assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "Running");

    // Interrupted: someone pauses while the speed change holds the campaign.
    assert.equal((await campaignAction(org, rocket.id, { action: "pause", purpose: "speed_change" })).statusCode, 200);
    const before = await pauses();
    const theirs = await campaignAction(org, rocket.id, { action: "pause" });
    assert.equal(theirs.statusCode, 200);
    assert.equal(theirs.body.alreadySettled, true);
    assert.equal(await pauses(), before + 1, "their pause is recorded because a speed-change hold was in place");
    const refused = await campaignAction(org, rocket.id, { action: "resume", purpose: "speed_change" });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.code, "paused_by_someone_else");
    assert.equal((await getOne(org, rocket.id)).body.status, "Paused", "their pause stands");

    // A plain pause retry on a plainly paused campaign is still a no-op without an audit row.
    const retry = await campaignAction(org, rocket.id, { action: "pause" });
    assert.equal(retry.body.alreadySettled, true);
    assert.equal(await pauses(), before + 1, "idempotent retries write nothing");

    // A plain resume (the person deciding) works as before.
    const plain = await campaignAction(org, rocket.id, { action: "resume" });
    assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
    assert.equal(plain.body.status, "Running");
    assert.equal((await campaignAction(org, rocket.id, { action: "cancel" })).statusCode, 200);
  } finally { await deleteOrganization(org); }
});
