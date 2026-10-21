import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { campaignMediaAssetsTable, campaignPlansTable, db, pool, settlementPool } from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { planCampaign } from "../src/services/campaign-planning";
import { createS3Client, S3_MIN_PART_BYTES, S3MediaStore, setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";
import {
  createCampaign,
  deleteOrganization,
  fakeResponse,
  findRouteHandler,
  HEADER_IMAGE,
  PDF,
  PNG,
  seedAudience,
  startFakeGraph,
  streamRequest,
  workspaceWorld,
} from "./message-studio-fixtures";
import { startFakeS3 } from "./fake-s3-server";

// R-D2 (R1b): the campaign media routes and planning with the S3-compatible store (the production backend,
// MinIO on the dedicated servers) over an in-process fake S3, end to end through the real handlers: upload
// lands in the bucket under the prefix, content streams the stored bytes, planning uploads exactly those
// bytes to the (fake) Graph API, delete removes the object, and a storage outage fails closed with fixed
// messages. Never a real bucket or Meta.

const BUCKET = "wabista-media-test";
let fake: Awaited<ReturnType<typeof startFakeS3>>;
const storeAt = (endpoint: string) => new S3MediaStore(createS3Client({
  kind: "s3", endpoint, region: "us-east-1", bucket: BUCKET, prefix: "campaign-media", forcePathStyle: true,
  accessKeyId: "test-access-key", secretAccessKey: `test-secret-${randomBytes(8).toString("hex")}`,
}), BUCKET, "campaign-media", S3_MIN_PART_BYTES);

before(async () => {
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64");
  fake = await startFakeS3({ bucket: BUCKET });
  setCampaignMediaStoreForTests(storeAt(fake.endpoint));
});
after(async () => {
  setCampaignMediaStoreForTests(undefined);
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  await fake.close();
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
  removeHeader(name: string) { delete this.headers[name.toLowerCase()]; }
  json(body: unknown) { this.body = body; this.end(); return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
}

const base = "/organizations/:organizationId/campaigns/:campaignId";
const upload = findRouteHandler(messageStudioRouter, `${base}/media`, "post");
const remove = findRouteHandler(messageStudioRouter, `${base}/media/:mediaAssetId`, "delete");
const content = findRouteHandler(messageStudioRouter, `${base}/media/:mediaAssetId/content`, "get");
const putSetup = findRouteHandler(messageStudioRouter, `${base}/message-setup`, "put");
const slugFor = (name: string) => `media-s3-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
const params = (organizationId: number, campaignId: number, extra: Record<string, string> = {}) => ({ organizationId: String(organizationId), campaignId: String(campaignId), ...extra });

async function send(organizationId: number, campaignId: number, bytes: Buffer, contentType: string, fileName: string) {
  const res = fakeResponse();
  await upload(streamRequest(bytes, { params: params(organizationId, campaignId), headers: { "x-file-name": fileName, "content-type": contentType }, authUser: {} }), res);
  return res;
}

async function readContent(organizationId: number, campaignId: number, assetId: number) {
  const res = new CaptureResponse();
  await content({ params: params(organizationId, campaignId, { mediaAssetId: String(assetId) }) }, res);
  await finished(res);
  return res;
}

async function setupWithImage(slug: string) {
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "img", body: "Hi", components: HEADER_IMAGE("Hi") }] });
  const campaign = await createCampaign(world.organization.id, slug);
  await seedAudience(world.organization.id, campaign.id, ["phone"], [{ phone: "+15551110001" }]);
  const image = await send(world.organization.id, campaign.id, PNG, "image/png", "banner.png");
  assert.equal(image.statusCode, 201, JSON.stringify(image.body));
  const saved = fakeResponse();
  await putSetup({ params: params(world.organization.id, campaign.id), authUser: {}, body: {
    revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [world.templates[0]!.id],
    mappings: [{ templateId: world.templates[0]!.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(image.body.id), mediaAssetId: image.body.id }],
  } }, saved);
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  const [row] = await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.id, image.body.id));
  return { world, campaign, image: image.body as { id: number }, objectKey: `campaign-media/${row!.storageKey}` };
}

test("uploads land in the bucket under the prefix, content streams them, planning sends those bytes to the provider and delete removes the object", async () => {
  const slug = slugFor("flow");
  const graph = await startFakeGraph();
  const { world, campaign, image, objectKey } = await setupWithImage(slug);
  try {
    assert.ok(fake.objects.get(objectKey)?.equals(PNG), "stored under campaign-media/organizations/<org>/campaigns/<campaign>/media/<uuid>");
    assert.ok(objectKey.startsWith(`campaign-media/organizations/${world.organization.id}/campaigns/${campaign.id}/media/`));

    // A document above one part goes up as a multipart upload and round-trips.
    const largePdf = Buffer.concat([PDF, randomBytes(6 * 1024 * 1024)]);
    const before = fake.requests.length;
    const pdf = await send(world.organization.id, campaign.id, largePdf, "application/pdf", "terms.pdf");
    assert.equal(pdf.statusCode, 201, JSON.stringify(pdf.body));
    assert.ok(fake.requests.slice(before).some((r) => r.method === "POST" && r.query.has("uploads")), "multipart upload");
    assert.equal(fake.uploads.size, 0, "no upload left open");
    const [pdfRow] = await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.id, pdf.body.id));
    assert.ok(fake.objects.get(`campaign-media/${pdfRow!.storageKey}`)?.equals(largePdf));
    assert.ok(Buffer.concat((await readContent(world.organization.id, campaign.id, pdf.body.id)).chunks).equals(largePdf));

    const served = await readContent(world.organization.id, campaign.id, image.id);
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers["content-type"], "image/png");
    assert.equal(served.headers["cache-control"], "private, no-store");
    assert.ok(Buffer.concat(served.chunks).equals(PNG));

    await planCampaign(world.organization.id, campaign.id);
    const uploads = graph.requests.filter((r) => r.url.endsWith("/media"));
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0]!.body.includes(PNG), "the bytes read from the bucket are what the provider receives");

    const deleted = fakeResponse();
    await remove({ params: params(world.organization.id, campaign.id, { mediaAssetId: String(pdf.body.id) }) }, deleted);
    assert.equal(deleted.statusCode, 204);
    assert.ok(!fake.objects.has(`campaign-media/${pdfRow!.storageKey}`), "the object is removed after the soft delete commits");
  } finally {
    await graph.close();
    await deleteOrganization(world.organization.id);
  }
});

test("a storage outage or a lost object fails closed with fixed messages (no endpoint, bucket or key)", async () => {
  const slug = slugFor("outage");
  const graph = await startFakeGraph();
  const { world, campaign, image, objectKey } = await setupWithImage(slug);
  const down = await startFakeS3({ bucket: BUCKET });
  const downEndpoint = down.endpoint;
  await down.close();
  const leaks = (text: string) => [downEndpoint, fake.endpoint, BUCKET, objectKey, "127.0.0.1"].filter((value) => text.includes(value));
  try {
    setCampaignMediaStoreForTests(storeAt(downEndpoint));
    const refused = await send(world.organization.id, campaign.id, PNG, "image/png", "late.png");
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.body.code, "media_storage_unavailable");
    assert.deepEqual(leaks(JSON.stringify(refused.body)), []);
    assert.equal((await db.select().from(campaignMediaAssetsTable).where(eq(campaignMediaAssetsTable.campaignId, campaign.id))).length, 1, "a failed upload leaves no row");

    const unavailableContent = await readContent(world.organization.id, campaign.id, image.id);
    assert.equal(unavailableContent.statusCode, 503, "an outage is not reported as a missing file");
    assert.equal(unavailableContent.headers["content-length"], undefined, "no file length is declared for an error body");
    assert.equal(unavailableContent.headers["content-disposition"], undefined);
    assert.deepEqual(unavailableContent.body, { error: "Media storage is unavailable. Try again shortly." });

    await assert.rejects(planCampaign(world.organization.id, campaign.id), (error: Error & { errors?: string[] }) => {
      const text = JSON.stringify(error.errors ?? error.message);
      assert.ok(text.includes("Media storage could not provide banner.png"), text);
      assert.deepEqual(leaks(text), []);
      return true;
    });

    setCampaignMediaStoreForTests(storeAt(fake.endpoint));
    fake.objects.delete(objectKey);
    const missingContent = await readContent(world.organization.id, campaign.id, image.id);
    assert.equal(missingContent.statusCode, 404);
    assert.equal(missingContent.headers["content-length"], undefined);
    await assert.rejects(planCampaign(world.organization.id, campaign.id), (error: Error & { errors?: string[] }) => {
      const text = JSON.stringify(error.errors ?? error.message);
      assert.ok(text.includes("banner.png is no longer available"), text);
      assert.deepEqual(leaks(text), []);
      return true;
    });
    assert.equal((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaign.id))).length, 0, "no plan without its media");
    assert.equal(graph.requests.length, 0, "nothing reached the provider");
  } finally {
    setCampaignMediaStoreForTests(storeAt(fake.endpoint));
    await graph.close();
    await deleteOrganization(world.organization.id);
  }
});
