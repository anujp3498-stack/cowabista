// V2-03B: template drafts are durable, workspace-scoped, optimistic-locked
// and never a provider template. Nothing here talks to Meta: submission
// paths that would are covered in template-submission.test.ts with a fake
// Graph API, and this suite only pins the local lifecycle rules.
//
// HTTP-level checks boot src/app.ts with syntactically valid non-production
// Clerk keys so anonymous requests hit the real middleware chain.
process.env.CLERK_SECRET_KEY = "sk_test_wabista_template_drafts_only";
process.env.CLERK_PUBLISHABLE_KEY = "pk_test_Y2xlcmsudGVzdCQ=";
delete process.env.WHATSAPP_APP_ID;

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  templateDraftsTable,
  templateSubmissionAttemptsTable,
  templatesTable,
  usersTable,
  wabasTable,
  whatsappCredentialsTable,
  type TemplateDraftContent,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import { buildTemplateCreatePayload, emptyDraftContent, validateDraft } from "../src/services/template-authoring";
import { TemplateDraftError } from "../src/services/template-draft-errors";
import { createDraft, deleteDraft, listAuthoringWabas, listDrafts, loadDraft, updateDraft } from "../src/services/template-drafts";
import { submitDraft } from "../src/services/template-submission";
import templateDraftsRouter from "../src/routes/template-drafts";
import { requireRole } from "../src/middlewares/auth";

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-draft-${randomBytes(20).toString("hex")}`;

async function fixture(options: { legacy?: boolean; credentialStatus?: string } = {}) {
  const slug = `tpl-draft-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [user] = await db.insert(usersTable).values({ clerkId: `clerk-${slug}`, email: `${slug}@example.test`, name: "Owner" }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: org.id, userId: user.id, role: "owner" });
  let credential: typeof whatsappCredentialsTable.$inferSelect | null = null;
  if (!options.legacy) {
    const enc = encryptCredential(TOKEN, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
    [credential] = await db.insert(whatsappCredentialsTable).values({
      organizationId: org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
      tokenFingerprint: credentialFingerprint(TOKEN), status: options.credentialStatus ?? "active",
    }).returning();
  }
  const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `waba-${slug}`, displayName: options.legacy ? "Legacy WABA" : "Acme WABA", credentialId: credential?.id ?? null }).returning();
  return { org, user, credential, waba, slug, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

function content(overrides: Partial<TemplateDraftContent> = {}): TemplateDraftContent {
  return { ...emptyDraftContent(), body: { text: "Hi {{1}}, your order {{2}} is ready.", examples: ["Alice", "ORD-1"] }, ...overrides };
}

async function expectError(promise: Promise<unknown>, code: string, status?: number): Promise<TemplateDraftError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TemplateDraftError, `expected TemplateDraftError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (status !== undefined) assert.equal(error.httpStatus, status);
    return error;
  }
  throw new Error(`expected ${code} error`);
}

let server: Server | undefined;
let baseUrl = "";

before(async () => {
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY;
  const { default: app } = await import("../src/app");
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => { server!.once("listening", () => resolve()); server!.once("error", reject); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  const { pool, settlementPool } = await import("@workspace/db");
  await Promise.all([pool.end(), settlementPool.end()]);
});

// ---------------------------------------------------------------- validation

test("validation: structural rules always apply, completeness only for submission; variables are scoped per component", () => {
  const base = { name: "promo_1", language: "en_US", category: "MARKETING", wabaId: 1 };
  assert.deepEqual(validateDraft({ ...base, content: emptyDraftContent() }, { forSubmission: false }), [], "an empty body is a saveable draft");
  const incomplete = validateDraft({ ...base, content: emptyDraftContent() }, { forSubmission: true });
  assert.ok(incomplete.some((e) => e.field === "body.text"), "an empty body cannot be submitted");

  const missingExample = validateDraft({ ...base, content: content({ body: { text: "Hi {{1}} and {{2}}", examples: ["Alice"] } }) }, { forSubmission: true });
  assert.deepEqual(missingExample.map((e) => e.field), ["body.examples.1"]);

  const gap = validateDraft({ ...base, content: content({ body: { text: "Hi {{2}}", examples: ["", "x"] } }) }, { forSubmission: false });
  assert.ok(gap.some((e) => e.field === "body.text" && /order/.test(e.message)), "body variables must be sequential from {{1}}");

  const header = validateDraft({ ...base, content: content({ header: { kind: "text", text: "Hello {{1}}", example: "" } }) }, { forSubmission: true });
  assert.deepEqual(header.map((e) => e.field), ["header.example"], "the header's {{1}} is its own variable with its own example");

  const badName = validateDraft({ ...base, name: "Promo One", content: content() }, { forSubmission: false });
  assert.ok(badName.some((e) => e.field === "name"));
  const badLang = validateDraft({ ...base, language: "english", content: content() }, { forSubmission: false });
  assert.ok(badLang.some((e) => e.field === "language"));
  const badCategory = validateDraft({ ...base, category: "AUTHENTICATION", content: content() }, { forSubmission: false });
  assert.ok(badCategory.some((e) => e.field === "category"), "authentication templates are not offered in this slice");

  const tooLong = validateDraft({ ...base, content: content({ header: { kind: "text", text: "x".repeat(61) }, footer: { text: "f".repeat(61) } }) }, { forSubmission: false });
  assert.deepEqual(tooLong.map((e) => e.field).sort(), ["footer.text", "header.text"]);

  const buttons = validateDraft({ ...base, content: content({ buttons: [
    { type: "url", text: "Track", url: "https://x.test/{{1}}/more", example: "" },
    { type: "phone", text: "Call", phoneNumber: "12345" },
    { type: "quick_reply", text: "Stop" },
    { type: "url", text: "Site", url: "ftp://x" },
    { type: "quick_reply", text: "More" },
  ] }) }, { forSubmission: true });
  const fields = buttons.map((e) => e.field);
  assert.ok(fields.includes("buttons.0.url"), "{{1}} must be at the end of a URL");
  assert.ok(fields.includes("buttons.1.phoneNumber"));
  assert.ok(fields.includes("buttons.3.url"));
  assert.ok(fields.includes("buttons"), "quick replies interleaved with other buttons are refused");

  const noWaba = validateDraft({ ...base, wabaId: null, content: content() }, { forSubmission: true });
  assert.deepEqual(noWaba.map((e) => e.field), ["wabaId"]);
  assert.deepEqual(validateDraft({ ...base, wabaId: null, content: content() }, { forSubmission: false }), [], "a draft may be saved before a business account is chosen");
});

test("payload exactness: the provider body is built from the draft field by field, with examples where Meta expects them and nothing else", () => {
  const payload = buildTemplateCreatePayload({
    name: "order_ready", language: "en_US", category: "UTILITY",
    content: {
      header: { kind: "text", text: "Order {{1}}", example: "ORD-1" },
      body: { text: "Hi {{1}}, your order {{2}} is ready.", examples: ["Alice", "ORD-1"] },
      footer: { text: "Reply STOP to opt out" },
      buttons: [
        { type: "url", text: "Track", url: "https://example.test/orders/{{1}}", example: "ORD-1" },
        { type: "phone", text: "Call us", phoneNumber: "+1 (555) 000-0001" },
        { type: "quick_reply", text: "Stop" },
      ],
    },
  });
  assert.deepEqual(payload, {
    name: "order_ready", language: "en_US", category: "UTILITY",
    components: [
      { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["ORD-1"] } },
      { type: "BODY", text: "Hi {{1}}, your order {{2}} is ready.", example: { body_text: [["Alice", "ORD-1"]] } },
      { type: "FOOTER", text: "Reply STOP to opt out" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "Track", url: "https://example.test/orders/{{1}}", example: ["ORD-1"] },
        { type: "PHONE_NUMBER", text: "Call us", phone_number: "+15550000001" },
        { type: "QUICK_REPLY", text: "Stop" },
      ] },
    ],
  });
  const media = buildTemplateCreatePayload({ name: "promo", language: "hi", category: "MARKETING", content: { header: { kind: "image", mediaUploadId: 7 }, body: { text: "Festive!", examples: [] }, footer: null, buttons: [] } }, "4:handle");
  assert.deepEqual(media.components, [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4:handle"] } }, { type: "BODY", text: "Festive!" }]);
  assert.ok(!JSON.stringify(media).includes("mediaUploadId"), "internal upload ids never reach the provider");
});

// --------------------------------------------------------------- lifecycle

test("drafts: create incomplete, list newest first with keyset paging, load, patch with revision, name conflict, delete", async () => {
  const f = await fixture();
  try {
    const first = await createDraft(f.org.id, f.user.id, { name: "welcome", language: "en_US", category: "MARKETING", content: emptyDraftContent() });
    assert.equal(first.state, "draft");
    assert.equal(first.revision, 1);
    assert.equal(first.wabaId, null);
    assert.ok(first.validation.some((e) => e.field === "body.text"), "the response tells the client what still blocks submission");
    assert.equal(first.latestAttempt, null);

    const second = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "order_ready", language: "en_US", category: "UTILITY", content: content() });
    assert.equal(second.wabaDisplayName, "Acme WABA");
    assert.deepEqual(second.validation, []);

    const page1 = await listDrafts(f.org.id, { limit: 1 });
    assert.deepEqual(page1.items.map((d) => d.id), [second.id]);
    assert.equal(page1.nextCursor, second.id);
    const page2 = await listDrafts(f.org.id, { limit: 1, cursor: page1.nextCursor! });
    assert.deepEqual(page2.items.map((d) => d.id), [first.id]);
    assert.equal(page2.nextCursor, null);

    await expectError(createDraft(f.org.id, f.user.id, { name: "Welcome!", language: "en_US", category: "MARKETING", content: emptyDraftContent() }), "invalid_draft", 400);
    await expectError(createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "order_ready", language: "en_US", category: "UTILITY", content: content() }), "name_conflict", 409);

    const patched = await updateDraft(f.org.id, f.user.id, first.id, { expectedRevision: 1, content: content(), wabaId: f.waba.id });
    assert.equal(patched.revision, 2);
    assert.deepEqual(patched.validation, []);
    await expectError(updateDraft(f.org.id, f.user.id, first.id, { expectedRevision: 1, name: "welcome_v2" }), "stale_revision", 409);
    await expectError(updateDraft(f.org.id, f.user.id, first.id, { expectedRevision: 2, name: "order_ready" }), "name_conflict", 409);
    assert.equal((await loadDraft(f.org.id, first.id)).revision, 2, "a refused patch does not bump the revision");

    await deleteDraft(f.org.id, first.id);
    await expectError(loadDraft(f.org.id, first.id), "not_found", 404);
  } finally { await f.cleanup(); }
});

test("tenant isolation: another workspace's draft, WABA and upload ids behave as missing or ineligible", async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    const draft = await createDraft(a.org.id, a.user.id, { wabaId: a.waba.id, name: "promo", language: "en_US", category: "MARKETING", content: content() });
    await expectError(loadDraft(b.org.id, draft.id), "not_found", 404);
    await expectError(updateDraft(b.org.id, b.user.id, draft.id, { expectedRevision: 1, name: "x" }), "not_found", 404);
    await expectError(deleteDraft(b.org.id, draft.id), "not_found", 404);
    await expectError(submitDraft({ organizationId: b.org.id, draftId: draft.id, expectedRevision: 1, userId: b.user.id }), "not_found", 404);
    await expectError(createDraft(b.org.id, b.user.id, { wabaId: a.waba.id, name: "promo", language: "en_US", category: "MARKETING", content: content() }), "waba_not_eligible", 400);
    await expectError(createDraft(b.org.id, b.user.id, { name: "promo", language: "en_US", category: "MARKETING", content: content({ header: { kind: "image", mediaUploadId: 999999 } }) }), "media_unavailable", 400);
    assert.deepEqual((await listDrafts(b.org.id)).items, []);
    assert.deepEqual((await listAuthoringWabas(b.org.id)).map((w) => w.id), [b.waba.id]);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test("WABA selection: credential WABAs are eligible by internal id; the legacy connector WABA is listed but refused; inactive credentials are refused", async () => {
  const f = await fixture();
  const legacy = await fixture({ legacy: true });
  const inactive = await fixture({ credentialStatus: "revoked" });
  try {
    const eligible = await listAuthoringWabas(f.org.id);
    assert.deepEqual(eligible, [{ id: f.waba.id, displayName: "Acme WABA", externalId: f.waba.externalId, authoringSupported: true, reason: null, mediaSupported: false }]);

    const legacyOptions = await listAuthoringWabas(legacy.org.id);
    assert.equal(legacyOptions.length, 1);
    assert.equal(legacyOptions[0].authoringSupported, false);
    assert.match(legacyOptions[0].reason!, /legacy connector/);
    await expectError(createDraft(legacy.org.id, legacy.user.id, { wabaId: legacy.waba.id, name: "promo", language: "en_US", category: "MARKETING", content: content() }), "waba_not_eligible", 400);

    const inactiveOptions = await listAuthoringWabas(inactive.org.id);
    assert.equal(inactiveOptions[0].authoringSupported, false);
    assert.match(inactiveOptions[0].reason!, /not active/);
    await expectError(createDraft(inactive.org.id, inactive.user.id, { wabaId: inactive.waba.id, name: "promo", language: "en_US", category: "MARKETING", content: content() }), "waba_not_eligible", 400);
  } finally { await f.cleanup(); await legacy.cleanup(); await inactive.cleanup(); }
});

test("incomplete drafts save but refuse submission with field errors; nothing is claimed and no attempt row is written", async () => {
  const f = await fixture();
  try {
    const draft = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "promo", language: "en_US", category: "MARKETING", content: content({ body: { text: "Hi {{1}}", examples: [] } }) });
    const error = await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id }), "invalid_draft", 400);
    assert.deepEqual(error.fields.map((e) => e.field), ["body.examples.0"]);
    assert.equal((await loadDraft(f.org.id, draft.id)).state, "draft");
    assert.equal((await db.select().from(templateSubmissionAttemptsTable).where(eq(templateSubmissionAttemptsTable.draftId, draft.id))).length, 0);

    const noWaba = await createDraft(f.org.id, f.user.id, { name: "promo_2", language: "en_US", category: "MARKETING", content: content() });
    const missing = await expectError(submitDraft({ organizationId: f.org.id, draftId: noWaba.id, expectedRevision: 1, userId: f.user.id }), "invalid_draft", 400);
    assert.deepEqual(missing.fields.map((e) => e.field), ["wabaId"]);
    await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 7, userId: f.user.id }), "stale_revision", 409);
  } finally { await f.cleanup(); }
});

test("a draft mid-submission or awaiting reconciliation cannot be edited or deleted; a submitted draft is read-only and its status is only ever Meta's", async () => {
  const f = await fixture();
  try {
    const draft = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "promo", language: "en_US", category: "MARKETING", content: content() });
    for (const [state, code] of [["submitting", "not_editable"], ["reconcile_required", "reconcile_required"]] as const) {
      await db.update(templateDraftsTable).set({ state }).where(eq(templateDraftsTable.id, draft.id));
      await expectError(updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: 1, name: "promo_x" }), code, 409);
      await expectError(deleteDraft(f.org.id, draft.id), code, 409);
      await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id }), state === "submitting" ? "attempt_in_progress" : "reconcile_required", 409);
    }
    await db.update(templateDraftsTable).set({ state: "submitted", providerTemplateId: "tpl-9", providerStatus: "Pending" }).where(eq(templateDraftsTable.id, draft.id));
    await expectError(updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: 1, name: "promo_x" }), "not_editable", 409);
    await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id }), "not_editable", 409);
    const loaded = await loadDraft(f.org.id, draft.id);
    assert.equal(loaded.providerStatus, "Pending", "status is whatever Meta last said");
    assert.equal(loaded.state, "submitted");
    assert.ok(!("approved" in loaded), "there is no local approval field to flip");
    // A submitted draft may be deleted (its attempts are detached and kept);
    // the provider template itself is untouched -- provider-side deletion
    // is out of scope.
    await deleteDraft(f.org.id, draft.id, { expectedRevision: 1 });
    assert.equal((await db.select().from(templatesTable).where(eq(templatesTable.organizationId, f.org.id))).length, 0);

    const failed = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "promo_f", language: "en_US", category: "MARKETING", content: content() });
    await db.update(templateDraftsTable).set({ state: "failed", lastError: "Meta refused" }).where(eq(templateDraftsTable.id, failed.id));
    const edited = await updateDraft(f.org.id, f.user.id, failed.id, { expectedRevision: 1, name: "promo_f2" });
    assert.equal(edited.state, "draft", "editing a refused draft makes it a draft again");
    assert.equal(edited.lastError, null);
  } finally { await f.cleanup(); }
});

test("content is normalised defensively: unknown fields are dropped and media header ids are validated for kind and business account", async () => {
  const f = await fixture();
  try {
    const draft = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "promo", language: "en_US", category: "MARKETING", content: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      header: { kind: "text", text: "Hey", example: "", secret: "nope" } as any,
      body: { text: "Body", examples: [] },
      footer: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buttons: [{ type: "quick_reply", text: "Yes", url: "https://sneaky" } as any],
    } });
    assert.deepEqual(draft.content, { header: { kind: "text", text: "Hey", example: "" }, body: { text: "Body", examples: [] }, footer: null, buttons: [{ type: "quick_reply", text: "Yes" }] });
    await expectError(updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: 1, content: content({ header: { kind: "image", mediaUploadId: 123456789 } }) }), "media_unavailable", 400);
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------ authorization

test("HTTP: every template authoring endpoint rejects anonymous requests with 401 through the real middleware chain", async () => {
  const paths: Array<[string, string]> = [
    ["GET", "/api/organizations/1/template-authoring/wabas"],
    ["GET", "/api/organizations/1/template-drafts"],
    ["POST", "/api/organizations/1/template-drafts"],
    ["GET", "/api/organizations/1/template-drafts/1"],
    ["PATCH", "/api/organizations/1/template-drafts/1"],
    ["DELETE", "/api/organizations/1/template-drafts/1"],
    ["POST", "/api/organizations/1/template-drafts/1/submit"],
    ["POST", "/api/organizations/1/template-drafts/1/reconcile"],
    ["POST", "/api/organizations/1/template-drafts/1/refresh-status"],
    ["POST", "/api/organizations/1/template-media?wabaId=1&fileName=a.png&contentType=image%2Fpng"],
    // V2-04 compatibility reads go through the same chain.
    ["POST", "/api/organizations/1/whatsapp/compatibility"],
    ["GET", "/api/organizations/1/campaigns/1/compatibility"],
  ];
  for (const [method, path] of paths) {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { "content-type": method === "POST" && path.includes("template-media") ? "application/octet-stream" : "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("role enforcement (handler-level): write endpoints carry requireRole(admin) after the three named guards and reads do not", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = (templateDraftsRouter as any).stack.filter((layer: any) => layer.route).map((layer: any) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods), stack: layer.route.stack.length }));
  const writes = routes.filter((r: { methods: string[]; path: string }) => !r.methods.includes("get"));
  const reads = routes.filter((r: { methods: string[] }) => r.methods.includes("get"));
  assert.equal(writes.length, 7);
  assert.equal(reads.length, 3);
  for (const route of reads) assert.equal(route.stack, 4, `${route.path}: requireAuth, attachOrgContext, requireActiveOrganization, handler`);
  for (const route of writes) assert.ok(route.stack >= 5, `${route.path}: requireAuth, attachOrgContext, requireActiveOrganization, requireRole, handler`);
  // requireRole("admin") itself refuses agents and managers and lets owners/admins pass.
  const guard = requireRole("admin");
  for (const [role, expected] of [["agent", 403], ["manager", 403], ["admin", 200], ["owner", 200]] as const) {
    let status = 200;
    let nextCalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guard({ role } as any, { status: (code: number) => { status = code; return { json: () => undefined }; } } as any, () => { nextCalled = true; });
    assert.equal(status, expected, role);
    assert.equal(nextCalled, expected === 200, role);
  }
});

test("no draft response or stored row carries a token, ciphertext or provider handle", async () => {
  const f = await fixture();
  try {
    const draft = await createDraft(f.org.id, f.user.id, { wabaId: f.waba.id, name: "promo", language: "en_US", category: "MARKETING", content: content() });
    const text = JSON.stringify([draft, await listDrafts(f.org.id), await listAuthoringWabas(f.org.id)]);
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes(f.credential!.tokenCiphertext));
    assert.ok(!/providerHandle|accessToken|tokenCiphertext/.test(text));
    const [row] = await db.select().from(templateDraftsTable).where(and(eq(templateDraftsTable.id, draft.id), eq(templateDraftsTable.organizationId, f.org.id)));
    assert.ok(!JSON.stringify(row).includes(TOKEN));
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------ UI (static)

test("UI static assertions: Drafts tab, editor, shared preview and honest sync summary (source-level checks, not a rendered DOM test)", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = resolve(process.cwd(), "../wabista-nexus/src");
  const page = readFileSync(resolve(root, "pages/templates.tsx"), "utf8");
  const tab = readFileSync(resolve(root, "components/templates/template-drafts-tab.tsx"), "utf8");
  const editor = readFileSync(resolve(root, "components/templates/template-draft-editor.tsx"), "utf8");
  const status = readFileSync(resolve(root, "lib/status.ts"), "utf8");
  const model = readFileSync(resolve(root, "lib/template-draft-model.ts"), "utf8");

  // Tabs and authorship.
  assert.match(page, /data-testid="tab-templates-meta"/);
  assert.match(page, /data-testid="tab-templates-drafts"/);
  assert.match(page, /canAuthor = canSync/, "authoring is offered to owner/admin only; the server enforces it regardless");
  assert.match(tab, /disabled=\{!canAuthor\}/);
  assert.match(tab, /data-testid="button-create-template"/);

  // Superseded syncs are not presented as success.
  assert.match(page, /item\.status === "superseded"/);
  assert.match(page, /Already up to date/);
  assert.doesNotMatch(page, /templates from \$\{synced\.length\} business \$\{synced\.length === 1 \? "account" : "accounts"\}\.` \}\)/, "the old unconditional success toast is gone");

  // Editor: explicit submit, revision-carrying writes, WABA by internal id from server options, no token/handle entry.
  assert.match(editor, /expectedRevision: current\.revision/);
  assert.match(editor, /expectedRevision: saved\.revision/);
  assert.match(editor, /useListTemplateAuthoringWabas/);
  assert.match(editor, /disabled=\{!item\.authoringSupported\}/, "legacy / inactive WABAs are visible but not selectable");
  assert.match(editor, /data-testid="button-draft-submit"/);
  assert.match(editor, /data-testid="button-draft-save"/);
  assert.match(editor, /uploadTemplateMedia\(organizationId, file, \{ wabaId: form\.wabaId, fileName: file\.name, contentType/);
  assert.doesNotMatch(editor, /accessToken|providerHandle|header_handle|input-connect-token/, "no token or handle in the editor");
  assert.doesNotMatch(editor, /fetch\(["'`]https?:/, "no direct remote fetches from the browser");
  assert.match(editor, /alert-edit-on-desktop/, "mobile is read-only");
  assert.match(editor, /stale_revision/, "revision conflicts are explained, not overwritten");
  assert.match(editor, /media_not_configured/);
  assert.doesNotMatch(editor, /Approved/, "the editor never shows or sets a local approval");

  // Status refresh and reconcile are explicit, bounded actions; polling is conditional.
  assert.match(tab, /useRefreshTemplateDraftStatus/);
  assert.match(tab, /useReconcileTemplateDraft/);
  assert.doesNotMatch(tab, /discardUnconfirmed|button-confirm-discard-unconfirmed|Discard if not at Meta/, "no discard-to-retry action: an unknown outcome stays unresolved");
  assert.match(tab, /data: \{ attemptId \}/, "reconciliation is fenced by the attempt the person is looking at");
  assert.match(tab, /sync_superseded/, "a superseded refresh is explained, not shown as fresh");
  assert.match(tab, /params: \{ expectedRevision: deleting\.revision \}/, "deletion carries the loaded revision");
  assert.match(tab, /d\.state === "submitting"\) && typeof document !== "undefined" && document\.visibilityState === "visible" \? SUBMITTING_POLL_MS : false/);
  assert.match(tab, /button-drafts-load-more/);
  assert.match(tab, /StatusChip kind="template" value=\{draft\.providerStatus/, "Meta's status is shown with the template chip, never a local value");

  // Shared preview and status tables.
  assert.match(editor, /TemplatePreview components=\{previewComponents\}/);
  assert.match(model, /draftComponents/);
  assert.match(status, /templateDraft: \{/);
  assert.match(status, /reconcile_required: \{ label: "Outcome unknown"/);
  assert.match(status, /submitted: \{ label: "Submitted"/);
});
