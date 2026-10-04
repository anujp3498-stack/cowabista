import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import {
  campaignJobsTable,
  campaignMediaAssetsTable,
  campaignMediaProviderBindingsTable,
  campaignPlansTable,
  db,
  pool,
  providerConnectionsTable,
  settlementPool,
  whatsappCredentialsTable,
} from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { planCampaign } from "../src/services/campaign-planning";
import { validateCampaignReady } from "../src/services/campaign-preflight";
import { setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";
import {
  createCampaign,
  deleteOrganization,
  fakeResponse,
  findRouteHandler,
  HEADER_DOCUMENT,
  HEADER_IMAGE,
  HEADER_VIDEO,
  JPEG,
  mockWorld,
  MP4,
  PDF,
  PNG,
  seedAudience,
  startFakeGraph,
  streamRequest,
  TOKEN,
  useLocalMediaStore,
  workspaceWorld,
} from "./message-studio-fixtures";

// V2-05B campaign media: uploaded once from the authenticated request body,
// bounded and type-checked, stored by a server key, reusable by every
// compatible template; provider media ids are created server-side per
// sending number at planning and never leave the server.

let storeDir = "";
function freshStore() {
  storeDir = (useLocalMediaStore() as unknown as { root: string }).root;
}
before(() => {
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64");
  freshStore();
});
after(async () => {
  setCampaignMediaStoreForTests(undefined);
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  await Promise.all([pool.end(), settlementPool.end()]);
});

/** A real Writable so the handler can pipe the stored bytes into it. */
class CaptureResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  headersSent = false;
  body: unknown;
  status(code: number) { this.statusCode = code; return this; }
  setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  json(body: unknown) { this.body = body; this.end(); return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
}

const base = "/organizations/:organizationId/campaigns/:campaignId";
const upload = findRouteHandler(messageStudioRouter, `${base}/media`, "post");
const list = findRouteHandler(messageStudioRouter, `${base}/media`, "get");
const remove = findRouteHandler(messageStudioRouter, `${base}/media/:mediaAssetId`, "delete");
const content = findRouteHandler(messageStudioRouter, `${base}/media/:mediaAssetId/content`, "get");
const putSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "put");
const getSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "get");
const slugFor = (name: string) => `media-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

async function send(organizationId: number, campaignId: number, bytes: Buffer, contentType: string, fileName = "file.bin", length?: number) {
  const res = fakeResponse();
  const req = streamRequest(bytes, {
    params: { organizationId: String(organizationId), campaignId: String(campaignId) },
    headers: { "x-file-name": fileName, "content-type": contentType, ...(length !== undefined ? { "content-length": String(length) } : {}) },
    authUser: {},
  });
  await upload(req, res);
  return res;
}
async function save(organizationId: number, campaignId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await putSetup({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body, authUser: {} }, res);
  return res;
}

test("uploads are type-checked by declared type AND leading bytes, bounded, named safely and campaign-scoped", async () => {
  const slug = slugFor("upload");
  const world = await mockWorld(slug, { templates: [{ name: "t", body: "Hi" }] });
  const other = await mockWorld(`${slug}-o`, { templates: [{ name: "t", body: "Hi" }] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    const png = await send(world.organization.id, campaign.id, PNG, "image/png", "banner.png");
    assert.equal(png.statusCode, 201, JSON.stringify(png.body));
    assert.deepEqual(Object.keys(png.body).sort(), ["byteLength", "campaignId", "contentType", "createdAt", "fileName", "id", "kind", "status"], "no storage key, hash or provider data in the response");
    assert.equal(png.body.kind, "image");
    assert.equal((await send(world.organization.id, campaign.id, JPEG, "image/jpeg", "photo.jpg")).body.kind, "image");
    assert.equal((await send(world.organization.id, campaign.id, MP4, "video/mp4", "clip.mp4")).body.kind, "video");
    assert.equal((await send(world.organization.id, campaign.id, PDF, "application/pdf", "terms.pdf")).body.kind, "document");

    const unsupported = await send(world.organization.id, campaign.id, Buffer.from("GIF89a....."), "image/gif", "x.gif");
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.body.code, "media_invalid");
    const mislabelled = await send(world.organization.id, campaign.id, PNG, "application/pdf", "fake.pdf");
    assert.equal(mislabelled.statusCode, 400, "bytes must match the declared type");
    const declaredTooBig = await send(world.organization.id, campaign.id, PNG, "image/png", "big.png", 6 * 1024 * 1024);
    assert.equal(declaredTooBig.statusCode, 400);
    const streamedTooBig = await send(world.organization.id, campaign.id, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), "image/png", "big.png");
    assert.equal(streamedTooBig.statusCode, 400, "the streamed size is enforced even without a declared length");
    const empty = await send(world.organization.id, campaign.id, Buffer.alloc(0), "image/png", "empty.png");
    assert.equal(empty.statusCode, 400);
    const traversal = await send(world.organization.id, campaign.id, PNG, "image/png", "../../etc/passwd");
    assert.equal(traversal.statusCode, 400, "unsafe file names are refused");

    const rows = await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.campaignId, campaign.id));
    assert.equal(rows.length, 4, "refused uploads leave no row");
    assert.ok(rows.every((row) => row.storageKey.startsWith(`organizations/${world.organization.id}/campaigns/${campaign.id}/media/`)));
    assert.ok(rows.every((row) => existsSync(path.join(storeDir, row.storageKey))));

    const foreignUpload = await send(other.organization.id, campaign.id, PNG, "image/png", "x.png");
    assert.equal(foreignUpload.statusCode, 404);
    const foreignList = fakeResponse();
    await list({ params: { organizationId: String(other.organization.id), campaignId: String(campaign.id) } }, foreignList);
    assert.deepEqual(foreignList.body, []);
    const foreignContent = fakeResponse();
    await content({ params: { organizationId: String(other.organization.id), campaignId: String(campaign.id), mediaAssetId: String(png.body.id) } }, foreignContent);
    assert.equal(foreignContent.statusCode, 404);

    // After execution history exists, media can no longer change.
    await db.insert(campaignJobsTable).values({ organizationId: world.organization.id, campaignId: campaign.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-job`, status: "Sent" });
    const locked = await send(world.organization.id, campaign.id, PNG, "image/png", "late.png");
    assert.equal(locked.statusCode, 409);
    assert.equal(locked.body.code, "execution_history");

    setCampaignMediaStoreForTests(null);
    const campaign2 = await createCampaign(world.organization.id, `${slug}-2`);
    const unavailable = await send(world.organization.id, campaign2.id, PNG, "image/png", "x.png");
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.body.code, "media_storage_unavailable");
  } finally {
    freshStore();
    await deleteOrganization(world.organization.id);
    await deleteOrganization(other.organization.id);
  }
});

test("one uploaded image serves several image templates; provider media ids are bound per sending number server-side and reused", async () => {
  const slug = slugFor("reuse");
  const graph = await startFakeGraph();
  const world = await workspaceWorld(slug, { phones: 2, templates: [
    { name: "img_a", body: "Hi {{1}}", components: HEADER_IMAGE("Hi {{1}}") },
    { name: "img_b", body: "Yo", components: HEADER_IMAGE("Yo") },
  ] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    await seedAudience(world.organization.id, campaign.id, ["phone", "first_name"], [{ phone: "+15551110001", first_name: "Ada" }, { phone: "+15551110002", first_name: "Bo" }]);
    const asset = (await send(world.organization.id, campaign.id, PNG, "image/png", "banner.png")).body;
    const [a, b] = world.templates;
    const saved = await save(world.organization.id, campaign.id, {
      revision: 0, senderPhoneNumberIds: world.phones.map((p) => p.id), templateIds: [a!.id, b!.id],
      mappings: [
        { templateId: a!.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(asset.id), mediaAssetId: asset.id },
        { templateId: a!.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
        { templateId: b!.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(asset.id), mediaAssetId: asset.id },
      ],
    });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal((await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.campaignId, campaign.id))).length, 1, "one upload, two templates");
    assert.equal(graph.requests.length, 0, "saving does not call the provider");
    assert.deepEqual(await validateCampaignReady(world.organization.id, campaign.id), []);

    const { plan } = await planCampaign(world.organization.id, campaign.id);
    const uploads = graph.requests.filter((r) => r.url.endsWith("/media"));
    assert.equal(uploads.length, 2, "one provider upload per sending number");
    assert.deepEqual(uploads.map((r) => r.url).sort(), world.phones.map((p) => `/v23.0/${p.providerPhoneId}/media`).sort());
    assert.ok(uploads.every((r) => r.authorization === `Bearer ${TOKEN}` && (r.contentType ?? "").startsWith("multipart/form-data")));
    assert.ok(uploads.every((r) => r.body.includes(Buffer.from("messaging_product")) && r.body.includes(PNG)), "the stored bytes are what is uploaded");
    const bindings = await db.select().from(campaignMediaProviderBindingsTable).where(eq(campaignMediaProviderBindingsTable.mediaAssetId, asset.id));
    assert.equal(bindings.length, 2);
    assert.deepEqual(new Set(bindings.map((binding) => binding.phoneNumberId)), new Set(world.phones.map((p) => p.id)));

    // The frozen plan keeps the asset id only; nothing provider-side leaks.
    const planText = JSON.stringify(plan);
    assert.ok(!planText.includes("media-1") && !planText.includes("media-2"), "no provider media id in the frozen plan");
    assert.ok(!planText.includes(TOKEN));
    assert.ok((plan.mappingsSnapshot as Array<{ source: string; sourceValue: string }>).some((m) => m.source === "media_asset" && m.sourceValue === String(asset.id)));
    const setup = fakeResponse();
    await getSetup({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id) } }, setup);
    const setupText = JSON.stringify(setup.body);
    assert.ok(!setupText.includes("media-1") && !setupText.includes("providerMediaId") && !setupText.includes("storageKey") && !setupText.includes(TOKEN));

    // Replanning reuses the bindings (no second upload).
    await planCampaign(world.organization.id, campaign.id);
    assert.equal(graph.requests.filter((r) => r.url.endsWith("/media")).length, 2);

    // Content is served tenant-scoped, inline, with nosniff.
    const bytes = new CaptureResponse();
    await content({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id), mediaAssetId: String(asset.id) } }, bytes);
    await finished(bytes);
    const piped = bytes.chunks;
    assert.equal(bytes.headers["content-type"], "image/png");
    assert.equal(bytes.headers["x-content-type-options"], "nosniff");
    assert.ok(Buffer.concat(piped).equals(PNG));
  } finally {
    await graph.close();
    await deleteOrganization(world.organization.id);
  }
});

test("kind mismatch, deleted assets, a refused provider upload and the shared connector all fail closed", async () => {
  const slug = slugFor("closed");
  const graph = await startFakeGraph({ mediaStatus: 400 });
  const world = await workspaceWorld(slug, { phones: 1, templates: [
    { name: "vid", body: "Watch", components: HEADER_VIDEO("Watch") },
    { name: "doc", body: "Read", components: HEADER_DOCUMENT("Read") },
  ] });
  try {
    const campaign = await createCampaign(world.organization.id, slug);
    await seedAudience(world.organization.id, campaign.id, ["phone"], [{ phone: "+15551110001" }]);
    const image = (await send(world.organization.id, campaign.id, PNG, "image/png", "banner.png")).body;
    const video = (await send(world.organization.id, campaign.id, MP4, "video/mp4", "clip.mp4")).body;
    const [vid] = world.templates;
    const body = (assetId: number) => ({
      revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [vid!.id],
      mappings: [{ templateId: vid!.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(assetId), mediaAssetId: assetId }],
    });
    const mismatch = await save(world.organization.id, campaign.id, body(image.id));
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.body.code, "media_kind_mismatch", "a VIDEO template cannot take an image");
    const ok = await save(world.organization.id, campaign.id, body(video.id));
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));

    // Referenced files cannot be deleted; unreferenced ones can (bytes removed).
    const inUse = fakeResponse();
    await remove({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id), mediaAssetId: String(video.id) } }, inUse);
    assert.equal(inUse.statusCode, 409);
    assert.equal(inUse.body.code, "media_in_use");
    const [imageRow] = await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.id, image.id));
    const deleted = fakeResponse();
    await remove({ params: { organizationId: String(world.organization.id), campaignId: String(campaign.id), mediaAssetId: String(image.id) } }, deleted);
    assert.equal(deleted.statusCode, 204);
    assert.ok(!existsSync(path.join(storeDir, imageRow!.storageKey)));

    // A refused provider upload refuses the plan (no other file or number is substituted).
    await assert.rejects(planCampaign(world.organization.id, campaign.id), (error: Error & { errors?: string[] }) => {
      assert.ok(error.errors?.some((e) => e.includes("Meta did not accept clip.mp4")), JSON.stringify(error.errors));
      return true;
    });
    assert.equal((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaign.id))).length, 0);

    // An asset that became unavailable blocks readiness.
    await db.update(campaignMediaAssetsTable).set({ status: "deleted" }).where(eq(campaignMediaAssetsTable.id, video.id));
    let errors = await validateCampaignReady(world.organization.id, campaign.id);
    assert.ok(errors.some((e) => e.includes("no longer available")), errors.join(" | "));
    await db.update(campaignMediaAssetsTable).set({ status: "ready" }).where(eq(campaignMediaAssetsTable.id, video.id));
    // A kind that no longer matches (defence in depth) blocks readiness.
    await db.update(campaignMediaAssetsTable).set({ kind: "image" }).where(eq(campaignMediaAssetsTable.id, video.id));
    errors = await validateCampaignReady(world.organization.id, campaign.id);
    assert.ok(errors.some((e) => e.includes("needs a video header")), errors.join(" | "));
    await db.update(campaignMediaAssetsTable).set({ kind: "video" }).where(eq(campaignMediaAssetsTable.id, video.id));

    // The shared (legacy) connector cannot upload campaign media: readiness says so.
    await db.update(whatsappCredentialsTable).set({ status: "active" }).where(eq(whatsappCredentialsTable.id, world.credential.id));
    await db.delete(providerConnectionsTable).where(eq(providerConnectionsTable.organizationId, world.organization.id));
    await db.insert(providerConnectionsTable).values({ organizationId: world.organization.id, provider: "whatsapp-business", mode: "real", status: "configured", configuredWabaExternalId: world.waba.externalId });
    const { phoneNumbersTable } = await import("@workspace/db");
    await db.update(phoneNumbersTable).set({ sendingCredentialId: null }).where(eq(phoneNumbersTable.id, world.phones[0]!.id));
    errors = await validateCampaignReady(world.organization.id, campaign.id);
    assert.ok(errors.some((e) => e.includes("shared connector cannot upload")), errors.join(" | "));
    assert.equal((await db.select().from(campaignMediaProviderBindingsTable).where(and(eq(campaignMediaProviderBindingsTable.mediaAssetId, video.id)))).length, 0, "nothing was bound");
  } finally {
    await graph.close();
    await deleteOrganization(world.organization.id);
  }
});
