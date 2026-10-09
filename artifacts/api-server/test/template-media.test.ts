// V2-03B: media examples for template headers through Meta's Resumable
// Upload API, against a fake Graph API in this process. Pins the two-step
// flow, the bounds, tenant scoping, configuration gating and that neither
// the token nor the provider handle ever leaves the server.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  templateMediaUploadsTable,
  usersTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import { resumableUploadUrl, type FetchLike } from "../src/services/whatsapp-manual-client";
import { emptyDraftContent } from "../src/services/template-authoring";
import { TemplateDraftError } from "../src/services/template-draft-errors";
import { createDraft, listAuthoringWabas, updateDraft } from "../src/services/template-drafts";
import { isTemplateMediaConfigured, TEMPLATE_MEDIA_APP_ID_ENV, TEMPLATE_MEDIA_HANDLE_TTL_MS, uploadTemplateMedia } from "../src/services/template-media";
import { submitDraft } from "../src/services/template-submission";
import { fakeUploadSession, resolveUploadStep2, type FakeUploadSession } from "./meta-upload-fixtures";

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-media-${randomBytes(20).toString("hex")}`;
const APP_ID = "123456789012345";
const HANDLE = "4:ZmlsZQ==:aW1hZ2UvcG5n:ARZ...:e:1700000000:ARY";

type Recorded = { url: string; method: string; headers: Record<string, string>; bodyBytes?: number; body?: unknown };

function fakeMeta(options: { recorded?: Recorded[]; sessionStatus?: number; uploadStatus?: number; hang?: "session" | "upload"; existing?: Array<Record<string, unknown>>; sessions?: FakeUploadSession[]; sessionId?: string } = {}): FetchLike {
  const sessions = options.sessions ?? [];
  const existing = options.existing ?? [];
  return async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const method = init.method ?? "GET";
    const record: Recorded = { url, method, headers };
    if (init.body instanceof Uint8Array) record.bodyBytes = init.body.byteLength;
    else if (typeof init.body === "string") record.body = JSON.parse(init.body);
    options.recorded?.push(record);
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const parsed = new URL(url);
    const signal = init.signal as AbortSignal | undefined;
    const hang = () => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    if (method === "POST" && parsed.pathname === `/v23.0/${APP_ID}/uploads`) {
      if (headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
      if (options.hang === "session") return hang();
      if (options.sessionStatus) return json(options.sessionStatus, { error: { message: "Session refused", code: 100 } });
      if (options.sessionId !== undefined) return json(200, { id: options.sessionId });
      const session = fakeUploadSession(parsed.searchParams.get("file_name") ?? "", Number(parsed.searchParams.get("file_length")), parsed.searchParams.get("file_type") ?? "");
      sessions.push(session);
      return json(200, { id: session.id });
    }
    if (method === "POST" && parsed.pathname.startsWith("/v23.0/upload")) {
      if (headers.Authorization !== `OAuth ${TOKEN}`) return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
      if (options.hang === "upload") return hang();
      if (options.uploadStatus) return json(options.uploadStatus, { error: { message: "Upload failed", code: options.uploadStatus >= 500 ? 2 : 100 } });
      if (headers.file_offset !== "0") return json(400, { error: { message: "Bad offset", code: 100 } });
      // Meta resolves the decoded path segment as the object id and needs `sig` as a query parameter.
      const resolved = resolveUploadStep2(url, "v23.0", sessions);
      if ("status" in resolved) return json(resolved.status, resolved.body);
      return json(200, { h: HANDLE });
    }
    if (headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    if (method === "POST" && parsed.pathname.endsWith("/message_templates")) {
      const body = JSON.parse(init.body as string);
      existing.push({ id: "tpl-media", name: body.name, language: body.language, category: body.category, status: "PENDING", components: body.components });
      return json(200, { id: "tpl-media", status: "PENDING", category: body.category });
    }
    if (method === "GET" && parsed.pathname.endsWith("/message_templates")) return json(200, { data: existing, paging: { cursors: {} } });
    return json(404, { error: { message: "Unknown edge", code: 100 } });
  };
}

async function fixture() {
  const slug = `tpl-media-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [user] = await db.insert(usersTable).values({ clerkId: `clerk-${slug}`, email: `${slug}@example.test`, name: "Owner" }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: org.id, userId: user.id, role: "owner" });
  const enc = encryptCredential(TOKEN, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(TOKEN), status: "active",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `waba-${slug}`, displayName: "Acme WABA", credentialId: credential.id }).returning();
  return { org, user, credential, waba, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...randomBytes(2048)]);

async function expectError(promise: Promise<unknown>, code: string, status?: number): Promise<TemplateDraftError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof TemplateDraftError, `expected TemplateDraftError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (status !== undefined) assert.equal(error.httpStatus, status);
    return error;
  }
  throw new Error(`expected ${code} error`);
}

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; process.env[TEMPLATE_MEDIA_APP_ID_ENV] = APP_ID; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  delete process.env[TEMPLATE_MEDIA_APP_ID_ENV];
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("valid upload: session opened on the configured app with Bearer, bytes posted once with OAuth + file_offset 0, handle stored server-side and absent from the response; the draft can reference it and submit with header_handle", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const upload = await uploadTemplateMedia({ organizationId: f.org.id, userId: f.user.id, wabaId: f.waba.id, fileName: "banner.png", contentType: "image/png", bytes: PNG, fetchImpl: fakeMeta({ recorded }) });
    assert.equal(upload.state, "ready");
    assert.equal(upload.kind, "image");
    assert.equal(upload.byteLength, PNG.byteLength);
    assert.ok(!("providerHandle" in upload) && !JSON.stringify(upload).includes(HANDLE), "the handle is server-side only");
    assert.ok(upload.expiresAt.getTime() > Date.now() + TEMPLATE_MEDIA_HANDLE_TTL_MS - 60_000);

    assert.equal(recorded.length, 2);
    const [session, chunk] = recorded;
    const sessionUrl = new URL(session.url);
    assert.equal(sessionUrl.pathname, `/v23.0/${APP_ID}/uploads`);
    assert.equal(sessionUrl.searchParams.get("file_length"), String(PNG.byteLength));
    assert.equal(sessionUrl.searchParams.get("file_type"), "image/png");
    assert.equal(sessionUrl.searchParams.get("file_name"), "banner.png");
    assert.equal(session.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!session.url.includes(TOKEN) && !sessionUrl.searchParams.has("access_token"));
    assert.equal(chunk.headers.Authorization, `OAuth ${TOKEN}`);
    assert.equal(chunk.headers.file_offset, "0");
    assert.equal(chunk.bodyBytes, PNG.byteLength);

    const [row] = await db.select().from(templateMediaUploadsTable).where(eq(templateMediaUploadsTable.id, upload.id));
    // Step 2 uses Meta's session id VERBATIM: `upload:<opaque>` in the path, `?sig=<opaque>` as the query.
    assert.match(row.providerSessionId!, /^upload:[^?]+\?sig=[^?]+$/);
    assert.equal(chunk.url, `https://graph.facebook.com/v23.0/${row.providerSessionId}`);
    const chunkUrl = new URL(chunk.url);
    assert.equal(decodeURIComponent(chunkUrl.pathname), `/v23.0/${row.providerSessionId!.split("?")[0]}`);
    assert.equal(chunkUrl.search, `?${row.providerSessionId!.split("?")[1]}`, "sig travels as the query string");
    assert.ok(chunkUrl.searchParams.get("sig"), "Meta reads sig as a query parameter");
    assert.ok(!chunk.url.includes("%3F") && !chunk.url.includes("%3A"), "the session id is not percent-encoded");
    assert.equal(row.providerHandle, HANDLE);
    assert.equal(row.appId, APP_ID);
    assert.equal(row.credentialId, f.credential.id);
    assert.ok(!JSON.stringify(row).includes(TOKEN));

    const draft = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "promo_img", language: "en_US", category: "MARKETING", content: { ...emptyDraftContent(), header: { kind: "image", mediaUploadId: upload.id }, body: { text: "Festive!", examples: [] } } });
    assert.deepEqual(draft.validation, []);
    const posts: Recorded[] = [];
    const result = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ recorded: posts }) });
    assert.equal(result.attempt.state, "succeeded");
    const post = posts.find((r) => r.method === "POST" && r.url.endsWith("/message_templates"))!;
    assert.deepEqual((post.body as { components: unknown[] }).components[0], { type: "HEADER", format: "IMAGE", example: { header_handle: [HANDLE] } });
    assert.ok(!JSON.stringify(result.draft).includes(HANDLE), "the draft response never exposes the handle");
  } finally { await f.cleanup(); }
});

test("bounds: unsupported type, empty file, oversize file and odd file names are refused before any provider call", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  const base = { organizationId: f.org.id, userId: f.user.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ recorded }) };
  try {
    await expectError(uploadTemplateMedia({ ...base, fileName: "x.gif", contentType: "image/gif", bytes: PNG }), "media_invalid", 400);
    await expectError(uploadTemplateMedia({ ...base, fileName: "x.svg", contentType: "image/svg+xml", bytes: PNG }), "media_invalid", 400);
    await expectError(uploadTemplateMedia({ ...base, fileName: "x.png", contentType: "image/png", bytes: new Uint8Array(0) }), "media_invalid", 400);
    await expectError(uploadTemplateMedia({ ...base, fileName: "x.png", contentType: "image/png", bytes: new Uint8Array(5 * 1024 * 1024 + 1) }), "media_invalid", 400);
    await expectError(uploadTemplateMedia({ ...base, fileName: "../x.png", contentType: "image/png", bytes: PNG }), "media_invalid", 400);
    assert.equal(recorded.length, 0);
    assert.equal((await db.select().from(templateMediaUploadsTable).where(eq(templateMediaUploadsTable.organizationId, f.org.id))).length, 0);
  } finally { await f.cleanup(); }
});

test("missing WHATSAPP_APP_ID: media upload answers 503 with an actionable message, WABAs report mediaSupported=false, and text-only drafts still save", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  delete process.env[TEMPLATE_MEDIA_APP_ID_ENV];
  try {
    assert.equal(isTemplateMediaConfigured(), false);
    const error = await expectError(uploadTemplateMedia({ organizationId: f.org.id, userId: f.user.id, wabaId: f.waba.id, fileName: "x.png", contentType: "image/png", bytes: PNG, fetchImpl: fakeMeta({ recorded }) }), "media_not_configured", 503);
    assert.match(error.message, /WHATSAPP_APP_ID/);
    assert.equal(recorded.length, 0);
    const [waba] = await listAuthoringWabas(f.org.id);
    assert.equal(waba.authoringSupported, true);
    assert.equal(waba.mediaSupported, false);
    const draft = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "text_only", language: "en_US", category: "MARKETING", content: { ...emptyDraftContent(), body: { text: "Hello", examples: [] } } });
    assert.deepEqual(draft.validation, []);
  } finally { process.env[TEMPLATE_MEDIA_APP_ID_ENV] = APP_ID; await f.cleanup(); }
});

test("tenant and account scoping: another workspace's WABA, a legacy WABA and an upload for a different WABA are refused; uploads are invisible across workspaces", async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    await expectError(uploadTemplateMedia({ organizationId: b.org.id, userId: b.user.id, wabaId: a.waba.id, fileName: "x.png", contentType: "image/png", bytes: PNG, fetchImpl: fakeMeta() }), "waba_not_eligible", 400);
    const [legacy] = await db.insert(wabasTable).values({ organizationId: a.org.id, externalId: `legacy-${a.waba.externalId}`, displayName: "Legacy", credentialId: null }).returning();
    await expectError(uploadTemplateMedia({ organizationId: a.org.id, userId: a.user.id, wabaId: legacy.id, fileName: "x.png", contentType: "image/png", bytes: PNG, fetchImpl: fakeMeta() }), "waba_not_eligible", 400);

    const upload = await uploadTemplateMedia({ organizationId: a.org.id, userId: a.user.id, wabaId: a.waba.id, fileName: "x.png", contentType: "image/png", bytes: PNG, fetchImpl: fakeMeta() });
    await expectError(createDraft(b.org.id, b.user.id, { wabaId: b.waba.id, name: "p", language: "en_US", category: "MARKETING", content: { ...emptyDraftContent(), header: { kind: "image", mediaUploadId: upload.id }, body: { text: "x", examples: [] } } }), "media_unavailable", 400);
    const [otherWaba] = await db.insert(wabasTable).values({ organizationId: a.org.id, externalId: `second-${a.waba.externalId}`, displayName: "Second", credentialId: a.credential.id }).returning();
    await expectError(createDraft(a.org.id, a.user.id, { wabaId: otherWaba.id, name: "p", language: "en_US", category: "MARKETING", content: { ...emptyDraftContent(), header: { kind: "image", mediaUploadId: upload.id }, body: { text: "x", examples: [] } } }), "media_invalid", 400);
    await expectError(createDraft(a.org.id, a.user.id, { wabaId: a.waba.id, name: "p", language: "en_US", category: "MARKETING", content: { ...emptyDraftContent(), header: { kind: "video", mediaUploadId: upload.id }, body: { text: "x", examples: [] } } }), "media_invalid", 400);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test("expired or failed uploads block submission with a field error, not a provider request", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const upload = await uploadTemplateMedia({ organizationId: f.org.id, userId: f.user.id, wabaId: f.waba.id, fileName: "x.png", contentType: "image/png", bytes: PNG, fetchImpl: fakeMeta() });
    const draft = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "promo_img", language: "en_US", category: "MARKETING", content: { ...emptyDraftContent(), header: { kind: "image", mediaUploadId: upload.id }, body: { text: "x", examples: [] } } });
    await db.update(templateMediaUploadsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(templateMediaUploadsTable.id, upload.id));
    const expired = await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ recorded }) }), "invalid_draft", 400);
    assert.deepEqual(expired.fields.map((e) => e.field), ["header.mediaUploadId"]);
    assert.equal(recorded.length, 0);
    assert.equal((await db.select().from(templateMediaUploadsTable).where(eq(templateMediaUploadsTable.id, upload.id)))[0].state, "ready", "nothing was mutated by the refused submit");

    // No upload referenced at all.
    const none = await updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: 1, content: { ...emptyDraftContent(), header: { kind: "document", mediaUploadId: null }, body: { text: "x", examples: [] } } });
    const missing = await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: none.revision, userId: f.user.id, fetchImpl: fakeMeta({ recorded }) }), "invalid_draft", 400);
    assert.match(missing.fields[0].message, /Upload a document example/);
    assert.equal(recorded.length, 0);
  } finally { await f.cleanup(); }
});

test("provider failures: timeout, session refusal, upload refusal and an invalid token each leave no upload row and a secret-free error", async () => {
  const f = await fixture();
  const base = { organizationId: f.org.id, userId: f.user.id, wabaId: f.waba.id, fileName: "x.png", contentType: "image/png", bytes: PNG };
  try {
    const { ManualMetaClient } = await import("../src/services/whatsapp-manual-client");
    void ManualMetaClient;
    // A hanging session request: the client's own timeout fires. Shortened by aborting from the fake.
    const hanging = fakeMeta({ hang: "session" });
    const quick: FetchLike = (url, init) => {
      const signal = init.signal as AbortSignal;
      setTimeout(() => (signal as unknown as { dispatchEvent?: (e: Event) => void }).dispatchEvent?.(new Event("abort")), 30);
      return hanging(url, init);
    };
    const timeout = await expectError(uploadTemplateMedia({ ...base, fetchImpl: quick }), "provider_unavailable", 502);
    assert.ok(!timeout.message.includes(TOKEN));

    await expectError(uploadTemplateMedia({ ...base, fetchImpl: fakeMeta({ sessionStatus: 400 }) }), "provider_rejected", 502);
    await expectError(uploadTemplateMedia({ ...base, fetchImpl: fakeMeta({ uploadStatus: 500 }) }), "provider_unavailable", 502);
    await expectError(uploadTemplateMedia({ ...base, fetchImpl: fakeMeta({ uploadStatus: 400 }) }), "provider_rejected", 502);
    await db.update(whatsappCredentialsTable).set({ status: "invalid" }).where(eq(whatsappCredentialsTable.id, f.credential.id));
    await expectError(uploadTemplateMedia({ ...base, fetchImpl: fakeMeta() }), "credential_inactive", 409);
    assert.equal((await db.select().from(templateMediaUploadsTable).where(eq(templateMediaUploadsTable.organizationId, f.org.id))).length, 0);
  } finally { await f.cleanup(); }
});

test("Resumable Upload step 2 contract (real Meta, Graph v25.0): the raw session id is accepted; the whole-id percent-encoded form is refused with code 100 / subcode 33", async () => {
  const sessions: FakeUploadSession[] = [];
  const meta = fakeMeta({ sessions });
  const open = await meta(`https://graph.facebook.com/v23.0/${APP_ID}/uploads?file_length=10&file_type=image%2Fpng&file_name=a.png`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  const { id } = await open.json() as { id: string };
  assert.match(id, /^upload:[^?]+\?sig=[^?]+$/, "Meta's shape: upload:<opaque>?sig=<opaque>");
  const step2 = (url: string) => meta(url, { method: "POST", headers: { Authorization: `OAuth ${TOKEN}`, file_offset: "0", "Content-Type": "application/octet-stream" }, body: new Uint8Array(10) });

  const raw = await step2(`https://graph.facebook.com/v23.0/${id}`);
  assert.equal(raw.status, 200);
  assert.equal((await raw.json() as { h: string }).h, HANDLE);

  // The previous URL construction (encodeURIComponent of the whole id).
  const encoded = await step2(`https://graph.facebook.com/v23.0/${encodeURIComponent(id)}`);
  assert.equal(encoded.status, 400);
  const error = (await encoded.json() as { error: { type: string; code: number; error_subcode: number; message: string } }).error;
  assert.deepEqual([error.type, error.code, error.error_subcode], ["GraphMethodException", 100, 33]);
  assert.ok(error.message.includes(id), "Meta resolved the whole decoded id, sig included, as the object id");

  // What the client builds now is exactly the raw form.
  assert.equal(resumableUploadUrl("https://graph.facebook.com", id), `https://graph.facebook.com/v23.0/${id}`);
});

test("resumableUploadUrl: Meta's id is used verbatim (base64 '+', '/', '=' and the sig query kept); anything that could re-target the request is refused", () => {
  const base = "https://graph.facebook.com";
  for (const id of [
    "upload:MTphdHRhY2htZW50OjZjNDU3+/abc==?sig=ARZx-_9yQ",
    "upload:MTphdHRhY2htZW50OjZjNDU3NjgzLTlmNjc=",
    "upload:YWJj?sig=AR1&extra=1",
  ]) assert.equal(resumableUploadUrl(base, id), `${base}/v23.0/${id}`, id);
  assert.equal(resumableUploadUrl("http://127.0.0.1:4010/", "upload:abc?sig=x"), "http://127.0.0.1:4010/v23.0/upload:abc?sig=x");
  for (const id of [
    "", "upload:", "notupload:abc?sig=x", "me", "../me",
    "upload:abc#frag", "upload:abc\\..\\me", "upload:ab c", "upload:abc\n", "upload:abc\u00e9",
    "upload:abc/../../me", "upload:abc/./x", "upload:abc/%2e%2e/%2E%2E/me", "upload:abc?sig=<x>", "upload:abc?sig=x\\y",
  ]) {
    assert.throws(() => resumableUploadUrl(base, id), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "bad_upload_session", JSON.stringify(id));
  }
});

test("an unusable session id from step 1 fails closed: no step-2 request, no upload row, a provider_rejected error", async () => {
  const f = await fixture();
  try {
    for (const sessionId of ["upload:abc#frag", "upload:abc/../../me?sig=x", "1234567890", "upload:with space?sig=x"]) {
      const recorded: Recorded[] = [];
      const error = await expectError(uploadTemplateMedia({ organizationId: f.org.id, userId: f.user.id, wabaId: f.waba.id, fileName: "x.png", contentType: "image/png", bytes: PNG, fetchImpl: fakeMeta({ recorded, sessionId }) }), "provider_rejected", 502);
      assert.match(error.message, /unusable upload session id/);
      assert.ok(!error.message.includes(TOKEN));
      assert.equal(recorded.length, 1, `${sessionId}: only the session request was made`);
    }
    assert.equal((await db.select().from(templateMediaUploadsTable).where(eq(templateMediaUploadsTable.organizationId, f.org.id))).length, 0);
  } finally { await f.cleanup(); }
});

