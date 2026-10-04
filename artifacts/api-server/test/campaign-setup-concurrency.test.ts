import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, desc, eq } from "drizzle-orm";
import {
  campaignJobsTable,
  campaignMediaAssetsTable,
  campaignPlansTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  contactImportSessionsTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import campaignEngineRouter from "../src/routes/campaign-engine";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { planCampaign, withCampaignLifecycleLock } from "../src/services/campaign-planning";
import { setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  createCampaign,
  deleteOrganization,
  fakeResponse,
  findRouteHandler,
  HEADER_IMAGE,
  mockWorld,
  PNG,
  seedAudience,
  streamRequest,
  useLocalMediaStore,
} from "./message-studio-fixtures";

// V2-05B.1 integrity closure.
//  A. The legacy template-mappings PUT obeys the setup lifecycle: on a
//     Ready campaign without jobs it supersedes the Active plan and returns
//     to Draft in the same transaction; with jobs, during an import, or for
//     Scheduled/Running/Paused it refuses. Frozen plans are never modified.
//  B. Plan vs legacy PUT and media delete vs Message Studio save are
//     serialized by the campaign lifecycle lock. Ordering is made
//     deterministic by holding that lock in the test, queueing the two
//     operations one after the other (confirmed through pg_locks; Postgres
//     grants conflicting waiters in queue order), then releasing it.
//  C. A media upload cannot finalize after the campaign became locked.

const LOCK_NAMESPACE = 875_611_204; // campaign-planning.ts CAMPAIGN_LIFECYCLE_LOCK_NAMESPACE
let storeRoot = "";
before(() => {
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64");
  storeRoot = (useLocalMediaStore() as unknown as { root: string }).root;
});
after(async () => { setCampaignMediaStoreForTests(undefined); delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const base = "/organizations/:organizationId/campaigns/:campaignId";
const legacyPut = findRouteHandler(campaignEngineRouter, `${base}/template-mappings`, "put");
const putSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "put");
const upload = findRouteHandler(messageStudioRouter, `${base}/media`, "post");
const remove = findRouteHandler(messageStudioRouter, `${base}/media/:mediaAssetId`, "delete");
const slugFor = (name: string) => `conc-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

async function callLegacyPut(organizationId: number, campaignId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await legacyPut({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body, authUser: {} }, res, () => {});
  return res;
}
async function callSave(organizationId: number, campaignId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await putSetup({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body, authUser: {} }, res);
  return res;
}
async function callDelete(organizationId: number, campaignId: number, assetId: number) {
  const res = fakeResponse();
  await remove({ params: { organizationId: String(organizationId), campaignId: String(campaignId), mediaAssetId: String(assetId) } }, res);
  return res;
}

async function lockWaiters(campaignId: number): Promise<number> {
  const result = await pool.query(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and classid = $1 and objid = $2",
    [LOCK_NAMESPACE, campaignId],
  );
  return result.rows[0].n as number;
}
async function untilWaiters(campaignId: number, n: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await lockWaiters(campaignId) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${n} lifecycle-lock waiter(s)`);
}

/** Holds the campaign lifecycle lock until release() is called. */
function holdLifecycleLock(campaignId: number) {
  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { held = resolve; });
  const done = withCampaignLifecycleLock(campaignId, async () => { held(); await gate; });
  return { acquired, release: () => { release(); return done; } };
}

/** Runs `first` then `second` in that order of lock acquisition. */
async function ordered<A, B>(campaignId: number, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const holder = holdLifecycleLock(campaignId);
  await holder.acquired;
  const a = first();
  let b: Promise<B> | undefined;
  try {
    await untilWaiters(campaignId, 1);
    b = second();
    // Both operations must be queued on the lifecycle lock; an operation
    // that bypasses it would run now, under the held lock, and fail this.
    await untilWaiters(campaignId, 2);
  } finally {
    await holder.release();
  }
  return Promise.all([a, b!]);
}

async function readyCampaign(slug: string) {
  const world = await mockWorld(slug, { templates: [{ name: "hello", body: "Hello {{1}}" }] });
  const campaign = await createCampaign(world.organization.id, slug);
  await seedAudience(world.organization.id, campaign.id, ["phone", "first_name"], [{ phone: "+15556660001", first_name: "Ada" }, { phone: "+15556660002", first_name: "Bo" }]);
  const template = world.templates[0]!;
  const saved = await callSave(world.organization.id, campaign.id, {
    revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [template.id],
    mappings: [{ templateId: template.id, component: "body", variable: "1", source: "static", sourceValue: "OLD" }],
  });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  return { world, campaign, template };
}
const NEW_MAPPING = (templateId: number) => ({ templateIds: [templateId], mappings: [{ templateId, component: "body", variable: "1", source: "csv", sourceValue: "first_name" }] });
const statusOf = async (campaignId: number) => (await db.select({ status: campaignsTable.status }).from(campaignsTable).where(eq(campaignsTable.id, campaignId)))[0]!.status;
const liveMappings = async (campaignId: number) => (await db.select().from(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.campaignId, campaignId)))
  .map((m) => `${m.templateId}:${m.component}:${m.variable}=${m.source}:${m.sourceValue}`).sort();

test("legacy mapping PUT on a Ready campaign without jobs supersedes P1, returns to Draft, never rewrites P1, and the next plan freezes the new mapping", async () => {
  const f = await readyCampaign(slugFor("ready"));
  try {
    const { plan: p1 } = await planCampaign(f.world.organization.id, f.campaign.id);
    assert.equal(await statusOf(f.campaign.id), "Ready");
    const [p1Before] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, p1.id));
    const snapshotBefore = JSON.stringify({ routes: p1Before!.routes, templatesSnapshot: p1Before!.templatesSnapshot, mappingsSnapshot: p1Before!.mappingsSnapshot, templateIds: p1Before!.templateIds, version: p1Before!.version });

    const res = await callLegacyPut(f.world.organization.id, f.campaign.id, NEW_MAPPING(f.template.id));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const [p1After] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, p1.id));
    assert.equal(p1After!.status, "Superseded", "P1 can no longer be scheduled or executed");
    assert.equal(await statusOf(f.campaign.id), "Draft");
    assert.deepEqual(await liveMappings(f.campaign.id), [`${f.template.id}:body:1=csv:first_name`]);
    assert.equal(JSON.stringify({ routes: p1After!.routes, templatesSnapshot: p1After!.templatesSnapshot, mappingsSnapshot: p1After!.mappingsSnapshot, templateIds: p1After!.templateIds, version: p1After!.version }), snapshotBefore, "the frozen P1 snapshot is byte-identical");
    assert.equal((p1After!.mappingsSnapshot as Array<{ sourceValue: string }>)[0]!.sourceValue, "OLD");
    assert.equal((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, f.campaign.id))).length, 0, "no jobs were created or changed");

    const { plan: p2 } = await planCampaign(f.world.organization.id, f.campaign.id);
    assert.equal(p2.version, p1.version + 1);
    assert.deepEqual((p2.mappingsSnapshot as Array<{ source: string; sourceValue: string }>).map((m) => `${m.source}:${m.sourceValue}`), ["csv:first_name"], "P2 freezes the new mapping");
  } finally { await deleteOrganization(f.world.organization.id); }
});

test("legacy mapping PUT refuses with execution history, during an import, and for Scheduled/Running/Paused, changing nothing; another workspace gets 404", async () => {
  const f = await readyCampaign(slugFor("refuse"));
  const other = await mockWorld(slugFor("other"), { templates: [{ name: "x", body: "Hi" }] });
  try {
    const { plan } = await planCampaign(f.world.organization.id, f.campaign.id);
    const [job] = await db.insert(campaignJobsTable).values({
      organizationId: f.world.organization.id, campaignId: f.campaign.id, planId: plan.id, templateId: f.template.id,
      type: "ResolveTemplateAndSend", idempotencyKey: `${f.campaign.id}-job`, status: "Queued", payload: { marker: 1 },
    }).returning();
    const planBefore = JSON.stringify((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, plan.id)))[0]);
    const mappingsBefore = await liveMappings(f.campaign.id);

    const history = await callLegacyPut(f.world.organization.id, f.campaign.id, NEW_MAPPING(f.template.id));
    assert.equal(history.statusCode, 409);
    assert.equal(history.body.code, "execution_history");
    assert.equal(await statusOf(f.campaign.id), "Ready");
    assert.deepEqual(await liveMappings(f.campaign.id), mappingsBefore);
    assert.equal(JSON.stringify((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, plan.id)))[0]), planBefore, "the Active plan is untouched");
    const [jobAfter] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, job!.id));
    assert.equal(JSON.stringify(jobAfter), JSON.stringify(job), "the job is untouched");

    for (const status of ["Scheduled", "Running", "Paused"]) {
      await db.update(campaignsTable).set({ status }).where(eq(campaignsTable.id, f.campaign.id));
      const refused = await callLegacyPut(f.world.organization.id, f.campaign.id, NEW_MAPPING(f.template.id));
      assert.equal(refused.statusCode, 409, status);
      assert.equal(refused.body.code, "setup_locked", status);
      assert.equal(await statusOf(f.campaign.id), status, `${status} is never reset to Draft`);
      assert.deepEqual(await liveMappings(f.campaign.id), mappingsBefore);
    }

    // An import in progress (a Draft campaign without jobs).
    const draft = await readyCampaign(slugFor("import"));
    await db.insert(contactImportSessionsTable).values({ organizationId: draft.world.organization.id, campaignId: draft.campaign.id, idempotencyKey: `${draft.campaign.id}-busy`, fileName: "x.csv", status: "Processing" });
    const busy = await callLegacyPut(draft.world.organization.id, draft.campaign.id, NEW_MAPPING(draft.template.id));
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.body.code, "import_in_progress");
    await deleteOrganization(draft.world.organization.id);

    const foreign = await callLegacyPut(other.organization.id, f.campaign.id, NEW_MAPPING(f.template.id));
    assert.equal(foreign.statusCode, 404);
  } finally {
    await deleteOrganization(f.world.organization.id);
    await deleteOrganization(other.organization.id);
  }
});

test("Plan vs legacy mapping PUT is serialized: write-first freezes the new mapping; plan-first is superseded; never Ready with a stale Active plan", async () => {
  // Order 1: the mapping write wins the lifecycle lock, then Plan runs.
  const writeFirst = await readyCampaign(slugFor("write-first"));
  try {
    const [put, planned] = await ordered(writeFirst.campaign.id,
      () => callLegacyPut(writeFirst.world.organization.id, writeFirst.campaign.id, NEW_MAPPING(writeFirst.template.id)),
      () => planCampaign(writeFirst.world.organization.id, writeFirst.campaign.id));
    assert.equal(put.statusCode, 200, JSON.stringify(put.body));
    assert.deepEqual((planned.plan.mappingsSnapshot as Array<{ sourceValue: string }>).map((m) => m.sourceValue), ["first_name"], "the plan freezes the accepted mapping");
    assert.equal(planned.plan.status, "Active");
    assert.equal(await statusOf(writeFirst.campaign.id), "Ready");
  } finally { await deleteOrganization(writeFirst.world.organization.id); }

  // Order 2: Plan wins the lock, then the mapping write runs.
  const planFirst = await readyCampaign(slugFor("plan-first"));
  try {
    const [planned, put] = await ordered(planFirst.campaign.id,
      () => planCampaign(planFirst.world.organization.id, planFirst.campaign.id),
      () => callLegacyPut(planFirst.world.organization.id, planFirst.campaign.id, NEW_MAPPING(planFirst.template.id)));
    assert.equal(put.statusCode, 200, JSON.stringify(put.body));
    const [frozen] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, planned.plan.id));
    assert.equal(frozen!.status, "Superseded", "the plan that froze the old mapping was superseded by the accepted write");
    assert.deepEqual((frozen!.mappingsSnapshot as Array<{ sourceValue: string }>).map((m) => m.sourceValue), ["OLD"], "and its snapshot was not rewritten");
    assert.equal(await statusOf(planFirst.campaign.id), "Draft");
    assert.deepEqual(await liveMappings(planFirst.campaign.id), [`${planFirst.template.id}:body:1=csv:first_name`]);
  } finally { await deleteOrganization(planFirst.world.organization.id); }

  // The invalid outcome, checked for both orders above and stated here: an
  // accepted write while the campaign stays Ready with an Active plan that
  // froze the replaced mapping.
  for (const campaignId of [writeFirst.campaign.id, planFirst.campaign.id]) {
    const [active] = await db.select().from(campaignPlansTable).where(and(eq(campaignPlansTable.campaignId, campaignId), eq(campaignPlansTable.status, "Active"))).orderBy(desc(campaignPlansTable.id));
    if (active) assert.ok(!(active.mappingsSnapshot as Array<{ sourceValue: string }>).some((m) => m.sourceValue === "OLD"), "no Active plan freezes the replaced mapping");
  }
});

async function mediaCampaign(slug: string) {
  const world = await mockWorld(slug, { templates: [{ name: "img", body: "Hi {{1}}", components: HEADER_IMAGE("Hi {{1}}") }] });
  const campaign = await createCampaign(world.organization.id, slug);
  await seedAudience(world.organization.id, campaign.id, ["phone", "first_name"], [{ phone: "+15556660003", first_name: "Cy" }]);
  const uploaded = fakeResponse();
  await upload(streamRequest(PNG, { params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) }, headers: { "x-file-name": "banner.png", "content-type": "image/png" }, authUser: {} }), uploaded);
  assert.equal(uploaded.statusCode, 201, JSON.stringify(uploaded.body));
  const template = world.templates[0]!;
  const assign = (revision: number) => ({
    revision, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [template.id],
    mappings: [
      { templateId: template.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(uploaded.body.id), mediaAssetId: uploaded.body.id },
      { templateId: template.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    ],
  });
  return { world, campaign, template, asset: uploaded.body as { id: number }, assign };
}

test("media save vs delete: save-first keeps the file in use; delete-first makes the save refuse; never a mapping to a deleted file", async () => {
  const saveFirst = await mediaCampaign(slugFor("save-first"));
  try {
    const [saved, deleted] = await ordered(saveFirst.campaign.id,
      () => callSave(saveFirst.world.organization.id, saveFirst.campaign.id, saveFirst.assign(0)),
      () => callDelete(saveFirst.world.organization.id, saveFirst.campaign.id, saveFirst.asset.id));
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal(deleted.statusCode, 409);
    assert.equal(deleted.body.code, "media_in_use");
    const [asset] = await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.id, saveFirst.asset.id));
    assert.equal(asset!.status, "ready");
    assert.ok(existsSync(path.join(storeRoot, asset!.storageKey)), "bytes kept");
    const [mapping] = await db.select().from(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.mediaAssetId, saveFirst.asset.id));
    assert.ok(mapping, "the mapping references a ready file");
  } finally { await deleteOrganization(saveFirst.world.organization.id); }

  const deleteFirst = await mediaCampaign(slugFor("delete-first"));
  try {
    const [deleted, saved] = await ordered(deleteFirst.campaign.id,
      () => callDelete(deleteFirst.world.organization.id, deleteFirst.campaign.id, deleteFirst.asset.id),
      () => callSave(deleteFirst.world.organization.id, deleteFirst.campaign.id, deleteFirst.assign(0)));
    assert.equal(deleted.statusCode, 204, JSON.stringify(deleted.body));
    assert.equal(saved.statusCode, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.code, "invalid_mappings");
    assert.match(saved.body.details.join(" "), /not available/);
    const [asset] = await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.id, deleteFirst.asset.id));
    assert.equal(asset!.status, "deleted");
    assert.equal((await db.select().from(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.mediaAssetId, deleteFirst.asset.id))).length, 0, "no mapping to the deleted file was committed");
  } finally { await deleteOrganization(deleteFirst.world.organization.id); }

  // Deleting an unreferenced file on a Ready campaign does not supersede its plan.
  const ready = await readyCampaign(slugFor("ready-media"));
  try {
    const assetRes = fakeResponse();
    await upload(streamRequest(PNG, { params: { organizationId: String(ready.world.organization.id), campaignId: String(ready.campaign.id) }, headers: { "x-file-name": "spare.png", "content-type": "image/png" }, authUser: {} }), assetRes);
    const { plan } = await planCampaign(ready.world.organization.id, ready.campaign.id);
    const deleted = await callDelete(ready.world.organization.id, ready.campaign.id, assetRes.body.id);
    assert.equal(deleted.statusCode, 204);
    const [still] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, plan.id));
    assert.equal(still!.status, "Active");
    assert.equal(await statusOf(ready.campaign.id), "Ready");
  } finally { await deleteOrganization(ready.world.organization.id); }
});

test("an upload that started while editable does not finalize after the campaign gained execution history", async () => {
  const f = await readyCampaign(slugFor("upload-final"));
  try {
    async function* body() {
      yield PNG.subarray(0, 16);
      // While the bytes stream in, the campaign is planned and executed.
      await db.update(campaignsTable).set({ status: "Running" }).where(eq(campaignsTable.id, f.campaign.id));
      await db.insert(campaignJobsTable).values({ organizationId: f.world.organization.id, campaignId: f.campaign.id, type: "ResolveTemplateAndSend", idempotencyKey: `${f.campaign.id}-late`, status: "Queued" });
      yield PNG.subarray(16);
    }
    // A plain async iterable (Readable.from would read ahead and could flip
    // the campaign before the handler's own pre-check, proving nothing about
    // finalization).
    const req: Record<string | symbol, unknown> = { [Symbol.asyncIterator]: body, readableEnded: true, resume() {} };
    Object.assign(req, { log: { warn() {}, info() {}, error() {} }, params: { organizationId: String(f.world.organization.id), campaignId: String(f.campaign.id) }, headers: { "x-file-name": "late.png", "content-type": "image/png" }, authUser: {} });
    const res = fakeResponse();
    await upload(req, res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.ok(["setup_locked", "execution_history"].includes(res.body.code), res.body.code);
    assert.equal((await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.campaignId, f.campaign.id))).length, 0, "no asset row");
    const files = readdirSync(storeRoot, { recursive: true }).filter((entry) => String(entry).includes(`campaigns/${f.campaign.id}/media/`));
    assert.equal(files.length, 0, "the just-written object was removed");
  } finally { await deleteOrganization(f.world.organization.id); }
});
