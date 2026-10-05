// Meta request-contract verification (external gate: Meta media and
// template-authoring contract). Captures the EXACT outbound HTTP requests
// Wabista makes to a fake Graph API (never the real one, no real token) and
// compares them, whole body, with the shapes in Meta's official
// "Business Messaging - WhatsApp API" OpenAPI specification v23.0
// (github.com/facebook/openapi, business-messaging-api_v23.0.yaml) and
// Meta's official samples (fbsamples/whatsapp-business-jaspers-market
// template.sh). Line references are to that spec file.
//
// Template authoring (POST /{WABA-ID}/message_templates, JSON, Bearer):
//   1 text-only body, 2 text header + BODY variables + footer,
//   3 image / 4 video / 5 document header through the Resumable Upload API
//   (session on /{app-id}/uploads, bytes with "Authorization: OAuth" and
//   file_offset 0, reply "h" -> example.header_handle), 6 URL button with a
//   variable (button-level example array) + phone button.
// Campaign sending (POST /{Phone-Number-ID}/messages, JSON, Bearer) through
// the real chain (Message Studio save -> plan -> execute -> production
// worker -> direct transport): 7 text-only approved template, 8 image /
// 9 document and video header by WhatsApp media id, 10 body variables,
// 11 dynamic URL button; plus the /{Phone-Number-ID}/media multipart upload
// that produces those media ids. Every request must match the job's frozen
// allocation (sender, route, template).
//
// This file only observes; it pins what the code sends today. Points the
// official sources leave open (session-id encoding in the upload URL, the
// '+' in phone_number, VIDEO header format) are noted where they occur.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignMediaProviderBindingsTable,
  campaignPlansTable,
  db,
  organizationMembersTable,
  organizationsTable,
  pool,
  settlementPool,
  usersTable,
  wabasTable,
  whatsappCredentialsTable,
  type TemplateDraftContent,
} from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";
import { emptyDraftContent } from "../src/services/template-authoring";
import { createDraft } from "../src/services/template-drafts";
import { TEMPLATE_MEDIA_APP_ID_ENV, uploadTemplateMedia } from "../src/services/template-media";
import { submitDraft } from "../src/services/template-submission";
import type { FetchLike } from "../src/services/whatsapp-manual-client";
import {
  createCampaign,
  deleteOrganization,
  fakeResponse,
  findRouteHandler,
  HEADER_DOCUMENT,
  HEADER_IMAGE,
  HEADER_VIDEO,
  JPEG,
  MP4,
  PDF,
  seedAudience,
  startFakeGraph,
  streamRequest,
  TOKEN,
  useLocalMediaStore,
  workspaceWorld,
} from "./message-studio-fixtures";
import { drainWithWorker, firstNameMappings, saveSetup } from "./v2-fixtures";

const APP_ID = "123456789012345";
const AUTHOR_TOKEN = `EAAG-contract-${randomBytes(20).toString("hex")}`;
const HANDLES: Record<string, string> = {
  "image/jpeg": "4::aW1hZ2UvanBlZw==:ARcontract-image:e:1900000000:123456789012345:100000000000001:ARx",
  "video/mp4": "4::dmlkZW8vbXA0:ARcontract-video:e:1900000000:123456789012345:100000000000001:ARy",
  "application/pdf": "4::YXBwbGljYXRpb24vcGRm:ARcontract-pdf:e:1900000000:123456789012345:100000000000001:ARz",
};

before(() => {
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64");
  process.env[TEMPLATE_MEDIA_APP_ID_ENV] = APP_ID;
});
after(async () => {
  setCampaignMediaStoreForTests(undefined);
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  delete process.env[TEMPLATE_MEDIA_APP_ID_ENV];
  await Promise.all([pool.end(), settlementPool.end()]);
});

// ---------------------------------------------------------------- authoring

type Captured = { method: string; url: string; headers: Record<string, string>; bytes?: Uint8Array; json?: unknown };

/**
 * Fake Graph for the management client. It answers the documented happy
 * path and refuses anything off-contract (wrong auth form, wrong offset,
 * non-JSON template body), so a wrong request fails the test, not only an
 * assertion on the capture.
 */
function fakeManagementGraph(captured: Captured[]): FetchLike {
  const sessions = new Map<string, string>();
  const created: Array<Record<string, unknown>> = [];
  return async (url, init) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const method = init.method ?? "GET";
    const entry: Captured = { method, url, headers };
    if (init.body instanceof Uint8Array) entry.bytes = new Uint8Array(init.body);
    else if (typeof init.body === "string") entry.json = JSON.parse(init.body);
    captured.push(entry);
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const parsed = new URL(url);
    if (method === "POST" && parsed.pathname === `/v23.0/${APP_ID}/uploads`) {
      if (headers.Authorization !== `Bearer ${AUTHOR_TOKEN}`) return reply(401, { error: { message: "Invalid OAuth access token", code: 190 } });
      const type = parsed.searchParams.get("file_type") ?? "";
      const id = `upload:session-${sessions.size + 1}`;
      sessions.set(id, type);
      return reply(200, { id });
    }
    if (method === "POST" && parsed.pathname.startsWith("/v23.0/upload")) {
      if (headers.Authorization !== `OAuth ${AUTHOR_TOKEN}`) return reply(401, { error: { message: "Invalid OAuth access token", code: 190 } });
      if (headers.file_offset !== "0") return reply(400, { error: { message: "Bad offset", code: 100 } });
      const sessionId = decodeURIComponent(parsed.pathname.slice("/v23.0/".length));
      const type = sessions.get(sessionId);
      if (!type) return reply(400, { error: { message: "Unknown upload session", code: 100 } });
      return reply(200, { h: HANDLES[type] });
    }
    if (headers.Authorization !== `Bearer ${AUTHOR_TOKEN}`) return reply(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    if (method === "POST" && parsed.pathname.endsWith("/message_templates")) {
      if (headers["Content-Type"] !== "application/json") return reply(400, { error: { message: "Expected JSON", code: 100 } });
      const body = entry.json as Record<string, unknown>;
      created.push({ id: `tpl-${created.length + 1}`, name: body.name, language: body.language, category: body.category, status: "PENDING", components: body.components });
      return reply(200, { id: `tpl-${created.length}`, status: "PENDING", category: body.category });
    }
    if (method === "GET" && parsed.pathname.endsWith("/message_templates")) return reply(200, { data: created, paging: { cursors: { before: "b", after: "a" } } });
    return reply(404, { error: { message: "Unknown edge", code: 100 } });
  };
}

async function authoringWorld() {
  const slug = `meta-contract-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [user] = await db.insert(usersTable).values({ clerkId: `clerk-${slug}`, email: `${slug}@example.test`, name: "Owner" }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
  const enc = encryptCredential(AUTHOR_TOKEN, { organizationId: org!.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: org!.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(AUTHOR_TOKEN), status: "active",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: org!.id, externalId: `1029384756${String(org!.id).padStart(5, "0")}`, displayName: "Contract WABA", credentialId: credential!.id }).returning();
  return { org: org!, user: user!, waba: waba! };
}

async function submitAndCapture(world: Awaited<ReturnType<typeof authoringWorld>>, name: string, category: string, content: TemplateDraftContent) {
  const draft = await createDraft(world.org.id, world.user.id, { wabaId: world.waba.id, name, language: "en_US", category, content });
  assert.deepEqual(draft.validation, [], `${name} is complete`);
  const captured: Captured[] = [];
  const result = await submitDraft({ organizationId: world.org.id, draftId: draft.id, expectedRevision: draft.revision, userId: world.user.id, fetchImpl: fakeManagementGraph(captured) });
  assert.equal(result.attempt.state, "succeeded", `${name} accepted by the fake Graph`);
  const creates = captured.filter((c) => c.method === "POST" && c.url.endsWith("/message_templates"));
  assert.equal(creates.length, 1, "exactly one creation request");
  const create = creates[0]!;
  // Endpoint, method, WABA id in the path, JSON body, Bearer auth (spec 28243, 28464-28480, 262-266).
  assert.equal(create.url, `https://graph.facebook.com/v23.0/${world.waba.externalId}/message_templates`);
  assert.equal(create.headers.Authorization, `Bearer ${AUTHOR_TOKEN}`);
  assert.equal(create.headers["Content-Type"], "application/json");
  assert.ok(!create.url.includes(AUTHOR_TOKEN) && !JSON.stringify(create.json).includes(AUTHOR_TOKEN), "the token is only in the Authorization header");
  assert.deepEqual(Object.keys(create.json as object).sort(), ["category", "components", "language", "name"], "the documented top-level fields only");
  return { create, captured, result };
}

async function uploadAndCapture(world: Awaited<ReturnType<typeof authoringWorld>>, fileName: string, contentType: string, bytes: Uint8Array) {
  const captured: Captured[] = [];
  const upload = await uploadTemplateMedia({ organizationId: world.org.id, userId: world.user.id, wabaId: world.waba.id, fileName, contentType, bytes, fetchImpl: fakeManagementGraph(captured) });
  assert.equal(upload.state, "ready");
  assert.equal(captured.length, 2, "session + one byte upload");
  const [session, chunk] = captured as [Captured, Captured];
  // Step 1 (py-application.py create_upload: file_length, file_name, file_type; template.sh:26).
  const sessionUrl = new URL(session.url);
  assert.equal(session.method, "POST");
  assert.equal(sessionUrl.origin + sessionUrl.pathname, `https://graph.facebook.com/v23.0/${APP_ID}/uploads`);
  assert.deepEqual([...sessionUrl.searchParams.keys()].sort(), ["file_length", "file_name", "file_type"]);
  assert.equal(sessionUrl.searchParams.get("file_length"), String(bytes.byteLength));
  assert.equal(sessionUrl.searchParams.get("file_type"), contentType);
  assert.equal(sessionUrl.searchParams.get("file_name"), fileName);
  assert.equal(session.headers.Authorization, `Bearer ${AUTHOR_TOKEN}`, "token in the header, never as access_token in the query");
  // Step 2 (template.sh:31-34): POST /{session id}, Authorization: OAuth, file_offset: 0, raw bytes; reply .h.
  // NOTE: the session id is percent-encoded into the path ('upload%3Asession-1'); Meta's samples interpolate it raw.
  assert.equal(chunk.method, "POST");
  assert.equal(chunk.url, "https://graph.facebook.com/v23.0/upload%3Asession-1");
  assert.equal(chunk.headers.Authorization, `OAuth ${AUTHOR_TOKEN}`);
  assert.equal(chunk.headers.file_offset, "0");
  assert.deepEqual(chunk.bytes, new Uint8Array(bytes), "the exact file bytes, single chunk");
  return upload;
}

test("authoring 1: text-only template -> {name, language, category, components:[BODY]} with no example (spec 28477-28538)", async () => {
  const world = await authoringWorld();
  try {
    const { create } = await submitAndCapture(world, "contract_text_only", "UTILITY", { ...emptyDraftContent(), body: { text: "Your order has shipped.", examples: [] } });
    assert.deepEqual(create.json, { name: "contract_text_only", language: "en_US", category: "UTILITY", components: [{ type: "BODY", text: "Your order has shipped." }] });
  } finally { await deleteOrganization(world.org.id); }
});

test("authoring 2: text header variable -> example.header_text [v]; BODY variables -> example.body_text [[v1, v2, v3]]; footer text (spec 28736-28762)", async () => {
  const world = await authoringWorld();
  try {
    const { create } = await submitAndCapture(world, "contract_vars", "MARKETING", {
      header: { kind: "text", text: "Our {{1}} is on!", example: "Summer Sale" },
      body: { text: "Shop now through {{1}} and use code {{2}} to get {{3}} off of all merchandise.", examples: ["the end of August", "25OFF", "25%"] },
      footer: { text: "Use the buttons below to manage your marketing subscriptions" },
      buttons: [],
    });
    assert.deepEqual(create.json, {
      name: "contract_vars", language: "en_US", category: "MARKETING",
      components: [
        { type: "HEADER", format: "TEXT", text: "Our {{1}} is on!", example: { header_text: ["Summer Sale"] } },
        { type: "BODY", text: "Shop now through {{1}} and use code {{2}} to get {{3}} off of all merchandise.", example: { body_text: [["the end of August", "25OFF", "25%"]] } },
        { type: "FOOTER", text: "Use the buttons below to manage your marketing subscriptions" },
      ],
    });
  } finally { await deleteOrganization(world.org.id); }
});

for (const media of [
  { n: 3, kind: "image", format: "IMAGE", fileName: "banner.jpg", contentType: "image/jpeg", bytes: new Uint8Array(JPEG), ref: "spec 28682-28715" },
  { n: 4, kind: "video", format: "VIDEO", fileName: "clip.mp4", contentType: "video/mp4", bytes: new Uint8Array(MP4), ref: "no official VIDEO creation example in the v23.0 spec; same shape as IMAGE/DOCUMENT" },
  { n: 5, kind: "document", format: "DOCUMENT", fileName: "receipt.pdf", contentType: "application/pdf", bytes: new Uint8Array(PDF), ref: "spec 28657-28681" },
] as const) {
  test(`authoring ${media.n}: ${media.kind} header -> Resumable Upload handle 'h' in example.header_handle, never a media id or internal id (${media.ref})`, async () => {
    const world = await authoringWorld();
    try {
      const upload = await uploadAndCapture(world, media.fileName, media.contentType, media.bytes);
      assert.ok(!JSON.stringify(upload).includes(HANDLES[media.contentType]!), "the handle never leaves the server");
      const { create } = await submitAndCapture(world, `contract_${media.kind}`, "UTILITY", {
        header: { kind: media.kind, mediaUploadId: upload.id },
        body: { text: "Thank you for your order, {{1}}!", examples: ["Mark"] },
        footer: null,
        buttons: [],
      });
      assert.deepEqual(create.json, {
        name: `contract_${media.kind}`, language: "en_US", category: "UTILITY",
        components: [
          { type: "HEADER", format: media.format, example: { header_handle: [HANDLES[media.contentType]] } },
          { type: "BODY", text: "Thank you for your order, {{1}}!", example: { body_text: [["Mark"]] } },
        ],
      });
      const sent = JSON.stringify(create.json);
      assert.ok(!sent.includes(`"${upload.id}"`) && !sent.includes(`:${upload.id}]`), "the internal upload row id is not sent");
    } finally { await deleteOrganization(world.org.id); }
  });
}

test("authoring 6: URL button with a variable -> button-level example [value]; phone button (spec 28699-28713)", async () => {
  const world = await authoringWorld();
  try {
    const { create } = await submitAndCapture(world, "contract_buttons", "MARKETING", {
      header: { kind: "none" },
      body: { text: "Hi {{1}}! Tap below for the offer.", examples: ["Mark"] },
      footer: null,
      buttons: [
        { type: "phone", text: "Call", phoneNumber: "+1 646-704-3595" },
        { type: "url", text: "Shop Now", url: "https://shop.example.test/shop?promo={{1}}", example: "summer2023" },
      ],
    });
    assert.deepEqual(create.json, {
      name: "contract_buttons", language: "en_US", category: "MARKETING",
      components: [
        { type: "BODY", text: "Hi {{1}}! Tap below for the offer.", example: { body_text: [["Mark"]] } },
        { type: "BUTTONS", buttons: [
          // NOTE: Meta's examples show phone_number digits-only ('16467043595'); Wabista sends E.164 with '+'.
          { type: "PHONE_NUMBER", text: "Call", phone_number: "+16467043595" },
          { type: "URL", text: "Shop Now", url: "https://shop.example.test/shop?promo={{1}}", example: ["summer2023"] },
        ] },
      ],
    });
  } finally { await deleteOrganization(world.org.id); }
});

// ---------------------------------------------------------------- sending

const base = "/organizations/:organizationId/campaigns/:campaignId";
const uploadRoute = findRouteHandler(messageStudioRouter, `${base}/media`, "post");

test("sending 7-11 + /media: every /messages request equals the documented template shape for the job's FROZEN template and sender; header media by the WhatsApp media id bound to that sender", async () => {
  const slug = `meta-send-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
  useLocalMediaStore();
  const graph = await startFakeGraph();
  const world = await workspaceWorld(slug, { phones: 1, templates: [
    { name: "c_text", body: "Your parcel is on its way.", components: [{ type: "BODY", text: "Your parcel is on its way." }] },
    { name: "c_image", body: "Hi {{1}}", components: HEADER_IMAGE("Hi {{1}}") },
    { name: "c_document", body: "Invoice for {{1}}", components: HEADER_DOCUMENT("Invoice for {{1}}") },
    { name: "c_video", body: "Watch this, {{1}}", components: HEADER_VIDEO("Watch this, {{1}}") },
    { name: "c_url", body: "Your code, {{1}}", components: [{ type: "BODY", text: "Your code, {{1}}" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop", url: "https://shop.example.test/p/{{1}}" }] }] },
  ] });
  const org = world.organization.id;
  const phone = world.phones[0]!;
  try {
    const campaign = await createCampaign(org, slug);
    const people = Array.from({ length: 25 }, (_, index) => ({ phone: `+4477229${String(index).padStart(5, "0")}`, first_name: `Ann${index}`, promo: `P-${index}-x` }));
    await seedAudience(org, campaign.id, ["phone", "first_name", "promo"], people);

    const assets: Record<string, { id: number; bytes: Buffer; contentType: string; fileName: string }> = {};
    for (const [kind, fileName, contentType, bytes] of [["image", "banner.jpg", "image/jpeg", JPEG], ["document", "invoice.pdf", "application/pdf", PDF], ["video", "clip.mp4", "video/mp4", MP4]] as const) {
      const res = fakeResponse();
      await uploadRoute(streamRequest(bytes, { params: { organizationId: String(org), campaignId: String(campaign.id) }, headers: { "x-file-name": fileName, "content-type": contentType }, authUser: {} }), res);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assets[kind] = { id: res.body.id, bytes, contentType, fileName };
    }
    const [tText, tImage, tDocument, tVideo, tUrl] = world.templates as [typeof world.templates[0], typeof world.templates[0], typeof world.templates[0], typeof world.templates[0], typeof world.templates[0]];
    const media = (templateId: number, assetId: number) => ({ templateId, component: "header", variable: "media", source: "media_asset", sourceValue: String(assetId), mediaAssetId: assetId });
    const saved = await saveSetup(org, campaign.id, {
      revision: 0, senderPhoneNumberIds: [phone.id], distributionMode: "equal_numbers",
      templateIds: [tText.id, tImage.id, tDocument.id, tVideo.id, tUrl.id],
      mappings: [
        media(tImage.id, assets.image!.id), media(tDocument.id, assets.document!.id), media(tVideo.id, assets.video!.id),
        ...firstNameMappings([tImage.id, tDocument.id, tVideo.id, tUrl.id]),
        { templateId: tUrl.id, component: "button", variable: "0:1", source: "csv", sourceValue: "promo" },
      ],
    });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));

    // ---- /media (spec 12525-12608): multipart with messaging_product=whatsapp and the file part; reply {id}.
    const { plan } = await planCampaign(org, campaign.id);
    const uploads = graph.requests.filter((r) => r.url.endsWith("/media"));
    assert.equal(uploads.length, 3, "one upload per asset for the one sender");
    const bindings = await db.select().from(campaignMediaProviderBindingsTable).where(eq(campaignMediaProviderBindingsTable.phoneNumberId, phone.id));
    assert.equal(bindings.length, 3);
    for (const request of uploads) {
      assert.equal(request.method, "POST");
      assert.equal(request.url, `/v23.0/${phone.providerPhoneId}/media`, "the PROVIDER phone-number id, not an internal id");
      assert.equal(request.authorization, `Bearer ${TOKEN}`);
      assert.match(request.contentType ?? "", /^multipart\/form-data; boundary=/);
      const form = await new Response(request.body, { headers: { "content-type": request.contentType! } }).formData();
      assert.deepEqual([...form.keys()].sort(), ["file", "messaging_product", "type"]);
      assert.equal(form.get("messaging_product"), "whatsapp");
      const file = form.get("file") as File;
      const asset = Object.values(assets).find((candidate) => candidate.fileName === file.name)!;
      assert.ok(asset, `file part named after the asset (${file.name})`);
      assert.equal(file.type, asset.contentType);
      assert.equal(form.get("type"), asset.contentType);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), asset.bytes, "the stored asset bytes");
      assert.ok(!request.body.toString("latin1").includes(TOKEN));
    }
    const mediaIdByAsset = new Map(bindings.map((binding) => [binding.mediaAssetId, binding.providerMediaId]));
    for (const asset of Object.values(assets)) {
      const mediaId = mediaIdByAsset.get(asset.id)!;
      assert.match(mediaId, /^media-\d+$/, "the id Meta returned, verbatim");
      assert.notEqual(mediaId, String(asset.id), "never the internal asset id");
    }
    assert.ok(!JSON.stringify(plan).includes(TOKEN));

    // ---- /messages (spec 12622-13620, template examples 12920-13010).
    await executeCampaignPlan(org, campaign.id);
    await drainWithWorker(campaign.id, 25, slug);
    const messages = graph.requests.filter((r) => r.url.endsWith("/messages"));
    assert.equal(messages.length, 25, "exactly one provider request per job");
    const [activePlan] = await db.select().from(campaignPlansTable).where(and(eq(campaignPlansTable.campaignId, campaign.id), eq(campaignPlansTable.status, "Active")));
    const allocations = new Map((await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, activePlan!.id))).map((a) => [a.contactId, a]));
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id)).orderBy(asc(campaignJobsTable.id));
    const contacts = new Map((await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaign.id))).map((c) => [c.id, c]));
    const templateById = new Map(world.templates.map((t) => [t.id, t]));
    const sentByTemplate = new Map<string, number>();
    assert.equal(jobs.length, 25);
    for (const job of jobs) {
      const contact = contacts.get(job.contactId!)!;
      const allocation = allocations.get(contact.id)!;
      assert.equal(job.status, "Sent");
      assert.equal(job.planId, activePlan!.id);
      assert.equal(job.routeId, allocation.routeId, "frozen route");
      assert.equal(job.templateId, allocation.templateId, "frozen template");
      assert.equal(allocation.phoneNumberId, phone.id, "frozen sender");
      const requests = messages.filter((r) => JSON.parse(r.body.toString()).to === contact.normalizedPhone);
      assert.equal(requests.length, 1, "one request per recipient");
      const request = requests[0]!;
      assert.equal(request.method, "POST");
      assert.equal(request.url, `/v23.0/${phone.providerPhoneId}/messages`, "sent by the frozen sender's provider phone id");
      assert.equal(request.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.contentType, "application/json");
      assert.ok(!request.body.toString().includes(TOKEN), "no token in the body");
      const data = contact.data as Record<string, string>;
      const template = templateById.get(job.templateId!)!;
      const body = (text: string) => ({ type: "body", parameters: [{ type: "text", text }] });
      const header = (kind: "image" | "document" | "video") => ({ type: "header", parameters: [{ type: kind, [kind]: { id: mediaIdByAsset.get(assets[kind]!.id)! } }] });
      const components: Record<string, unknown>[] | undefined = {
        c_text: undefined,
        c_image: [header("image"), body(data.first_name!)],
        c_document: [header("document"), body(data.first_name!)],
        c_video: [header("video"), body(data.first_name!)],
        c_url: [body(data.first_name!), { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: data.promo! }] }],
      }[template.name];
      assert.deepEqual(JSON.parse(request.body.toString()), {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: contact.normalizedPhone,
        type: "template",
        template: { name: template.name, language: { code: "en_US" }, ...(components ? { components } : {}) },
      }, `${template.name} for contact ${contact.id}`);
      sentByTemplate.set(template.name, (sentByTemplate.get(template.name) ?? 0) + 1);
    }
    assert.deepEqual([...sentByTemplate.keys()].sort(), ["c_document", "c_image", "c_text", "c_url", "c_video"], "all five shapes were sent");
    assert.ok(!JSON.stringify(jobs).includes(TOKEN));
    console.log(JSON.stringify({ metaContractSends: Object.fromEntries(sentByTemplate), mediaUploads: uploads.length }));
  } finally {
    await graph.close();
    await deleteOrganization(org);
  }
});
