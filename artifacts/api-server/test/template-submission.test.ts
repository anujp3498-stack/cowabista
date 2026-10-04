// V2-03B: safe submission of a draft through the workspace credential.
// The provider is a fake Graph API inside this process; no request leaves
// the machine and nothing is ever created at Meta. The suite pins the
// claim -> POST -> outcome lifecycle, the DB-enforced single active
// attempt, uncertain outcomes and evidence-based reconciliation.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
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
import type { FetchLike } from "../src/services/whatsapp-manual-client";
import { emptyDraftContent } from "../src/services/template-authoring";
import { TemplateDraftError } from "../src/services/template-draft-errors";
import { createDraft, loadDraft, updateDraft } from "../src/services/template-drafts";
import { reconcileDraft, refreshDraftStatus, STALE_REQUESTED_MS, submitDraft } from "../src/services/template-submission";
import { revokeCredential } from "../src/services/whatsapp-manual-connection";

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-submit-${randomBytes(20).toString("hex")}`;

type Recorded = { url: string; method: string; auth?: string; body?: unknown };
type MetaTpl = { id: string; name: string; language: string; category: string; status: string; components: Record<string, unknown>[] };

/**
 * Fake Graph API. `existing` is the WABA's current template list (served
 * to sync, name lookups and GET by id). `onCreate` decides what a POST
 * does; by default it appends a PENDING template and replies with its id.
 */
function fakeMeta(options: {
  recorded?: Recorded[];
  existing?: MetaTpl[];
  onCreate?: (payload: Record<string, unknown>) => { status: number; body: unknown } | "timeout" | "network";
  gate?: Promise<void>;
  onPostArrive?: () => void;
  token?: string;
}): FetchLike {
  const existing = options.existing ?? [];
  let nextId = 1000;
  return async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    options.recorded?.push({ url, method, auth: headers?.Authorization, body });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (headers?.Authorization !== `Bearer ${options.token ?? TOKEN}`) return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    const parsed = new URL(url);
    if (method === "POST" && parsed.pathname.endsWith("/message_templates")) {
      options.onPostArrive?.();
      if (options.gate) await options.gate;
      const decision = options.onCreate?.(body) ?? { status: 200, body: null };
      if (decision === "timeout") { await new Promise(() => undefined); }
      if (decision === "network") throw new TypeError("fetch failed");
      if (decision.body !== null) return json(decision.status, decision.body);
      const created: MetaTpl = { id: `tpl-${nextId++}`, name: body.name, language: body.language, category: body.category, status: "PENDING", components: body.components };
      existing.push(created);
      return json(200, { id: created.id, status: "PENDING", category: created.category });
    }
    if (method === "GET" && parsed.pathname.endsWith("/message_templates")) {
      const name = parsed.searchParams.get("name");
      return json(200, { data: existing.filter((t) => !name || t.name === name), paging: { cursors: {} } });
    }
    if (method === "GET") {
      const id = parsed.pathname.split("/").pop();
      const found = existing.find((t) => t.id === id);
      return found ? json(200, found) : json(404, { error: { message: "Unsupported get request", code: 100 } });
    }
    return json(404, { error: { message: "Unknown edge", code: 100 } });
  };
}

async function fixture() {
  const slug = `tpl-submit-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [user] = await db.insert(usersTable).values({ clerkId: `clerk-${slug}`, email: `${slug}@example.test`, name: "Owner" }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: org.id, userId: user.id, role: "owner" });
  const enc = encryptCredential(TOKEN, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(TOKEN), status: "active",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `waba-${slug}`, displayName: "Acme WABA", credentialId: credential.id }).returning();
  const draft = async (name = "order_ready", content?: TemplateDraftContent) => createDraft(org.id, user.id, {
    wabaId: waba.id, name, language: "en_US", category: "UTILITY",
    content: content ?? { ...emptyDraftContent(), body: { text: "Hi {{1}}, your order {{2}} is ready.", examples: ["Alice", "ORD-1"] }, footer: { text: "Thanks" }, buttons: [{ type: "quick_reply", text: "Stop" }] },
  });
  return { org, user, credential, waba, slug, draft, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

async function attempts(draftId: number) {
  return db.select().from(templateSubmissionAttemptsTable).where(eq(templateSubmissionAttemptsTable.draftId, draftId)).orderBy(templateSubmissionAttemptsTable.id);
}

async function expectError(promise: Promise<unknown>, code: string): Promise<TemplateDraftError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof TemplateDraftError, `expected TemplateDraftError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  throw new Error(`expected ${code} error`);
}

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("happy path: one POST with the exact payload and bearer header only; attempt + draft recorded from Meta's reply; sync links the local template row", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const draft = await f.draft();
    const result = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ recorded }) });
    assert.equal(result.attempt.state, "succeeded");
    assert.equal(result.draft.state, "submitted");
    assert.equal(result.draft.providerTemplateId, "tpl-1000");
    assert.equal(result.draft.providerStatus, "Pending", "status is Meta's, never a local approval");
    assert.equal(result.draft.latestAttempt?.id, result.attempt.id);

    const posts = recorded.filter((r) => r.method === "POST");
    assert.equal(posts.length, 1, "exactly one creation request");
    assert.equal(posts[0].url, `https://graph.facebook.com/v23.0/${f.waba.externalId}/message_templates`);
    assert.equal(posts[0].auth, `Bearer ${TOKEN}`);
    assert.ok(!posts[0].url.includes(TOKEN));
    assert.deepEqual(posts[0].body, {
      name: "order_ready", language: "en_US", category: "UTILITY",
      components: [
        { type: "BODY", text: "Hi {{1}}, your order {{2}} is ready.", example: { body_text: [["Alice", "ORD-1"]] } },
        { type: "FOOTER", text: "Thanks" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] },
      ],
    });
    const [attempt] = await attempts(draft.id);
    assert.deepEqual(attempt.payload, posts[0].body, "the stored attempt payload is exactly what was sent");
    assert.equal(attempt.credentialId, f.credential.id);
    assert.equal(attempt.wabaExternalId, f.waba.externalId);
    assert.ok(!JSON.stringify(attempt).includes(TOKEN));

    // The hardened sync ran after success (GET listing) and the draft points at the synced row.
    assert.ok(recorded.some((r) => r.method === "GET" && r.url.includes("/message_templates?")), "post-success sync listed the WABA's templates");
    const [template] = await db.select().from(templatesTable).where(eq(templatesTable.organizationId, f.org.id));
    assert.equal(template.providerTemplateId, "tpl-1000");
    assert.equal(template.status, "Pending");
    assert.equal(result.draft.templateId, template.id);

    // Submitted drafts are frozen and a second submit is refused without a request.
    await expectError(updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: result.draft.revision, name: "x" }), "not_editable");
    await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: result.draft.revision, userId: f.user.id, fetchImpl: fakeMeta({ recorded }) }), "not_editable");
    assert.equal(recorded.filter((r) => r.method === "POST").length, 1);
  } finally { await f.cleanup(); }
});

test("definitive refusal: Meta's 4xx marks the attempt failed and the draft failed + editable; a 190 marks the credential inactive", async () => {
  const f = await fixture();
  try {
    const draft = await f.draft();
    const refused = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ onCreate: () => ({ status: 400, body: { error: { message: "Invalid parameter: name", code: 100, error_subcode: 2388023 } } }) }) });
    assert.equal(refused.attempt.state, "failed");
    assert.equal(refused.attempt.errorCode, "100");
    assert.match(refused.attempt.error!, /Invalid parameter/);
    assert.equal(refused.draft.state, "failed");
    assert.match(refused.draft.lastError!, /Meta refused/);
    const edited = await updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: refused.draft.revision, name: "order_ready_v2" });
    assert.equal(edited.state, "draft");

    const expired = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: edited.revision, userId: f.user.id, fetchImpl: fakeMeta({ onCreate: () => ({ status: 401, body: { error: { message: "Error validating access token", code: 190 } } }) }) });
    assert.equal(expired.attempt.state, "failed");
    assert.equal(expired.attempt.errorCode, "190");
    assert.equal(expired.draft.state, "failed");
    assert.match(expired.draft.lastError!, /Reconnect/);
    assert.equal((await attempts(draft.id)).length, 2, "every attempt is kept as history");
  } finally { await f.cleanup(); }
});

test("timeout after Meta actually accepted: attempt uncertain, draft reconcile_required, NO automatic resubmission; reconciliation links the template by evidence", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  const existing: MetaTpl[] = [];
  try {
    const draft = await f.draft();
    // The fake "accepts" (appends the template) and then never answers.
    const fetchImpl = fakeMeta({ recorded, existing, onCreate: (payload) => { existing.push({ id: "tpl-real", name: String(payload.name), language: "en_US", category: "UTILITY", status: "PENDING", components: payload.components as Record<string, unknown>[] }); return "timeout"; } });
    const { ManualMetaClient } = await import("../src/services/whatsapp-manual-client");
    // Shorten the client timeout for this test only via a wrapping fetch that aborts quickly.
    const fast: FetchLike = (url, init) => {
      if (init.method === "POST") {
        return new Promise((_, reject) => {
          const signal = init.signal as AbortSignal;
          fetchImpl(url, init).catch(() => undefined);
          setTimeout(() => { const err = new Error("aborted"); err.name = "AbortError"; reject(err); }, 50);
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }
      return fetchImpl(url, init);
    };
    void ManualMetaClient;
    const result = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fast });
    assert.equal(result.attempt.state, "uncertain");
    assert.equal(result.draft.state, "reconcile_required");
    assert.equal(recorded.filter((r) => r.method === "POST").length, 1);

    // Nothing retries on its own: a second submit is refused, and editing is refused.
    await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fast }), "reconcile_required");
    await expectError(updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: 1, name: "x" }), "reconcile_required");
    assert.equal(recorded.filter((r) => r.method === "POST").length, 1, "no second POST");

    const reconciled = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl });
    assert.equal(reconciled.attempt.state, "succeeded");
    assert.equal(reconciled.attempt.providerTemplateId, "tpl-real");
    assert.match(reconciled.attempt.reconcileNote!, /Confirmed from Meta/);
    assert.equal(reconciled.draft.state, "submitted");
    assert.equal(reconciled.draft.providerTemplateId, "tpl-real");
    assert.equal(reconciled.draft.providerStatus, "Pending");
    assert.equal(recorded.filter((r) => r.method === "POST").length, 1, "reconciliation never re-sends the creation request");
    const lookups = recorded.filter((r) => r.method === "GET" && r.url.includes("name=order_ready"));
    assert.ok(lookups.length >= 1, "reconciliation read the provider by name");
    assert.equal(lookups[0].auth, `Bearer ${TOKEN}`);
  } finally { await f.cleanup(); }
});

test("network failure / 5xx / malformed reply are uncertain; reconciling with no template at Meta keeps it uncertain until the person discards it, which makes the draft editable", async () => {
  const f = await fixture();
  try {
    const draft = await f.draft();
    const existing: MetaTpl[] = [];
    const dropped = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing, onCreate: () => "network" }) });
    assert.equal(dropped.attempt.state, "uncertain");
    assert.equal(dropped.attempt.errorCode, "network");

    const stillUnknown = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
    assert.equal(stillUnknown.attempt.state, "uncertain");
    assert.match(stillUnknown.attempt.reconcileNote!, /no template with the submitted name/);
    assert.equal(stillUnknown.draft.state, "reconcile_required");

    const discarded = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, discardUnconfirmed: true, fetchImpl: fakeMeta({ existing }) });
    assert.equal(discarded.attempt.state, "failed");
    assert.equal(discarded.attempt.errorCode, "discarded_unconfirmed");
    assert.equal(discarded.draft.state, "failed");
    const edited = await updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: discarded.draft.revision, name: "order_ready_b" });
    assert.equal(edited.state, "draft");

    for (const onCreate of [
      () => ({ status: 503, body: { error: { message: "Service temporarily unavailable", code: 2 } } }),
      () => ({ status: 200, body: { success: true } }),
    ]) {
      const again = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: (await loadDraft(f.org.id, draft.id)).revision, userId: f.user.id, fetchImpl: fakeMeta({ existing, onCreate }) });
      assert.equal(again.attempt.state, "uncertain", JSON.stringify(again.attempt));
      const reset = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, discardUnconfirmed: true, fetchImpl: fakeMeta({ existing }) });
      assert.equal(reset.draft.state, "failed");
      await updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: reset.draft.revision });
    }
    assert.equal((await attempts(draft.id)).filter((a) => a.state === "requested" || a.state === "uncertain").length, 0);
  } finally { await f.cleanup(); }
});

test("name conflict at Meta is never linked: a same-name template with different content stays unconfirmed and is reported", async () => {
  const f = await fixture();
  try {
    const draft = await f.draft("order_ready");
    const existing: MetaTpl[] = [{ id: "tpl-other", name: "order_ready", language: "en_US", category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: "Totally different body" }] }];
    const uncertain = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing, onCreate: () => "network" }) });
    assert.equal(uncertain.attempt.state, "uncertain");
    const reconciled = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
    assert.equal(reconciled.attempt.state, "uncertain");
    assert.equal(reconciled.attempt.providerTemplateId, null);
    assert.match(reconciled.attempt.reconcileNote!, /exists at Meta but its language or content differs/);
    assert.equal(reconciled.draft.state, "reconcile_required");
    assert.equal(reconciled.draft.providerTemplateId, null, "the unrelated template is not attached");

    // Same name, different language: also not linked.
    existing[0] = { ...existing[0], components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready." }], language: "hi" };
    const again = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
    assert.equal(again.attempt.state, "uncertain");
    assert.equal(again.draft.providerTemplateId, null);
  } finally { await f.cleanup(); }
});

test("two concurrent submits of one draft produce exactly one POST; the loser gets the existing attempt; retrying while in flight returns attempt_in_progress", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const arrivedAtProvider = new Promise<void>((resolve) => { arrived = resolve; });
  try {
    const draft = await f.draft();
    const fetchImpl = fakeMeta({ recorded, gate, onPostArrive: () => arrived() });
    const common = { organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl };
    const first = submitDraft(common);
    const second = submitDraft(common);
    // Settle handlers are attached up front: the loser may reject while the
    // winner's request is still parked at the fake provider.
    const settled = Promise.allSettled([first, second]);
    await arrivedAtProvider;
    // While the first POST is in flight, a third caller is refused with the live attempt.
    const retry = await expectError(submitDraft(common), "attempt_in_progress");
    assert.equal(retry.attempt?.state, "requested");
    const live = await attempts(draft.id);
    assert.equal(live.length, 1, "only one attempt row exists");
    release();
    const outcomes = await settled;
    const fulfilled = outcomes.filter((o): o is PromiseFulfilledResult<Awaited<typeof first>> => o.status === "fulfilled");
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const loser = rejected[0].reason as TemplateDraftError;
    assert.ok(loser instanceof TemplateDraftError);
    assert.ok(loser.code === "attempt_in_progress" || loser.code === "not_editable", loser.code);
    assert.equal(fulfilled[0].value.attempt.state, "succeeded");
    assert.equal(recorded.filter((r) => r.method === "POST").length, 1, "one creation request for two callers");
    assert.equal((await attempts(draft.id)).length, 1);
  } finally { release?.(); await f.cleanup(); }
});

test("the database refuses a second active attempt even if a caller bypasses the draft lock (partial unique index)", async () => {
  const f = await fixture();
  try {
    const draft = await f.draft();
    await db.insert(templateSubmissionAttemptsTable).values({ organizationId: f.org.id, draftId: draft.id, draftRevision: 1, wabaId: f.waba.id, wabaExternalId: f.waba.externalId, credentialId: f.credential.id, payload: { name: "x" }, state: "uncertain" });
    await assert.rejects(
      db.insert(templateSubmissionAttemptsTable).values({ organizationId: f.org.id, draftId: draft.id, draftRevision: 1, wabaId: f.waba.id, wabaExternalId: f.waba.externalId, credentialId: f.credential.id, payload: { name: "x" }, state: "requested" }),
      (error: { code?: string; cause?: { code?: string } }) => (error.code ?? error.cause?.code) === "23505",
    );
    // Settled attempts do not count.
    await db.insert(templateSubmissionAttemptsTable).values({ organizationId: f.org.id, draftId: draft.id, draftRevision: 1, wabaId: f.waba.id, wabaExternalId: f.waba.externalId, credentialId: f.credential.id, payload: { name: "x" }, state: "failed" });
  } finally { await f.cleanup(); }
});

test("crash window: an attempt left 'requested' (process died between claim and outcome) is reconciled from provider evidence once it is stale, never re-sent; a fresh one is left alone", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const draft = await f.draft();
    const existing: MetaTpl[] = [];
    // Simulate the crash: the claim committed, the POST may or may not have happened.
    const [attempt] = await db.insert(templateSubmissionAttemptsTable).values({
      organizationId: f.org.id, draftId: draft.id, draftRevision: 1, wabaId: f.waba.id, wabaExternalId: f.waba.externalId, credentialId: f.credential.id,
      payload: { name: "order_ready", language: "en_US", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready.", example: { body_text: [["Alice", "ORD-1"]] } }, { type: "FOOTER", text: "Thanks" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }] },
      state: "requested", startedAt: new Date(),
    }).returning();
    await db.update(templateDraftsTable).set({ state: "submitting" }).where(eq(templateDraftsTable.id, draft.id));

    // Too fresh: it may still be in flight in another process.
    await expectError(reconcileDraft({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ recorded, existing }) }), "attempt_in_progress");
    assert.equal(recorded.length, 0, "no provider read while the attempt may be in flight");

    await db.update(templateSubmissionAttemptsTable).set({ startedAt: new Date(Date.now() - STALE_REQUESTED_MS - 1000) }).where(eq(templateSubmissionAttemptsTable.id, attempt.id));
    // Case A: the POST had reached Meta.
    existing.push({ id: "tpl-crash", name: "order_ready", language: "en_US", category: "UTILITY", status: "PENDING", components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready." }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }] });
    const linked = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ recorded, existing }) });
    assert.equal(linked.attempt.state, "succeeded");
    assert.equal(linked.draft.state, "submitted");
    assert.equal(linked.draft.providerTemplateId, "tpl-crash");
    assert.equal(recorded.filter((r) => r.method === "POST").length, 0, "reconciliation never POSTs");

    // Case B: the POST never reached Meta -> stays uncertain, person discards, draft editable.
    const draftB = await f.draft("order_ready_b");
    const [attemptB] = await db.insert(templateSubmissionAttemptsTable).values({
      organizationId: f.org.id, draftId: draftB.id, draftRevision: 1, wabaId: f.waba.id, wabaExternalId: f.waba.externalId, credentialId: f.credential.id,
      payload: { name: "order_ready_b", language: "en_US", category: "UTILITY", components: [] }, state: "requested", startedAt: new Date(Date.now() - STALE_REQUESTED_MS - 1000),
    }).returning();
    await db.update(templateDraftsTable).set({ state: "submitting" }).where(eq(templateDraftsTable.id, draftB.id));
    const unknown = await reconcileDraft({ organizationId: f.org.id, draftId: draftB.id, userId: f.user.id, fetchImpl: fakeMeta({ recorded, existing }) });
    assert.equal(unknown.attempt.id, attemptB.id);
    assert.equal(unknown.attempt.state, "uncertain");
    assert.equal(unknown.draft.state, "reconcile_required");
    const discarded = await reconcileDraft({ organizationId: f.org.id, draftId: draftB.id, userId: f.user.id, discardUnconfirmed: true, fetchImpl: fakeMeta({ recorded, existing }) });
    assert.equal(discarded.draft.state, "failed");
    assert.equal(recorded.filter((r) => r.method === "POST").length, 0);
  } finally { await f.cleanup(); }
});

test("credential revoked or WABA re-associated between the claim and the request: no POST is made and the attempt fails as credential_inactive", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const draft = await f.draft();
    const revoked = await submitDraft({
      organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ recorded }),
      hooks: { beforeProviderCall: async () => { await revokeCredential(f.org.id, f.credential.id); } },
    });
    assert.equal(revoked.attempt.state, "failed");
    assert.equal(revoked.attempt.errorCode, "credential_inactive");
    assert.equal(revoked.draft.state, "failed");
    assert.equal(recorded.filter((r) => r.method === "POST").length, 0, "no request with a revoked credential");

    // Revoked credential: the claim itself is refused (WABA no longer credential-backed / credential inactive).
    const edited = await updateDraft(f.org.id, f.user.id, draft.id, { expectedRevision: revoked.draft.revision });
    const [wabaNow] = await db.select().from(wabasTable).where(eq(wabasTable.id, f.waba.id));
    const code = wabaNow.credentialId === null ? "waba_not_eligible" : "credential_inactive";
    await expectError(submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: edited.revision, userId: f.user.id, fetchImpl: fakeMeta({ recorded }) }), code);

    // Re-association to a different credential after the claim: refused before any request.
    const g = await fixture();
    try {
      const other = encryptCredential(`${TOKEN}-2`, { organizationId: g.org.id, kind: "manual_token", provider: "whatsapp-business" });
      const [second] = await db.insert(whatsappCredentialsTable).values({ organizationId: g.org.id, tokenCiphertext: other.ciphertext, tokenIv: other.iv, tokenAuthTag: other.authTag, keyVersion: other.keyVersion, tokenFingerprint: credentialFingerprint(`${TOKEN}-2`), status: "active" }).returning();
      const gd = await g.draft();
      const moved = await submitDraft({
        organizationId: g.org.id, draftId: gd.id, expectedRevision: 1, userId: g.user.id, fetchImpl: fakeMeta({ recorded }),
        hooks: { beforeProviderCall: async () => { await db.update(wabasTable).set({ credentialId: second.id }).where(eq(wabasTable.id, g.waba.id)); } },
      });
      assert.equal(moved.attempt.state, "failed");
      assert.equal(moved.attempt.errorCode, "credential_inactive");
      assert.equal(recorded.filter((r) => r.method === "POST").length, 0);
    } finally { await g.cleanup(); }
  } finally { await f.cleanup(); }
});

test("status refresh is one bounded provider read; it only applies to submitted drafts and keeps the synced row honest", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  const existing: MetaTpl[] = [];
  try {
    const draft = await f.draft();
    await expectError(refreshDraftStatus({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ existing }) }), "not_submitted");
    const submitted = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
    assert.equal(submitted.draft.providerStatus, "Pending");
    existing[0].status = "APPROVED";
    const refreshed = await refreshDraftStatus({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ recorded, existing }) });
    assert.equal(refreshed.providerStatus, "Approved");
    assert.ok(refreshed.providerStatusCheckedAt);
    assert.equal(recorded.length, 1, "one GET");
    assert.equal(recorded[0].method, "GET");
    assert.ok(recorded[0].url.startsWith(`https://graph.facebook.com/v23.0/${existing[0].id}?`));
    const [template] = await db.select().from(templatesTable).where(eq(templatesTable.organizationId, f.org.id));
    assert.equal(template.status, "Approved");
    existing[0].status = "REJECTED";
    assert.equal((await refreshDraftStatus({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ existing }) })).providerStatus, "Rejected");
    await expectError(refreshDraftStatus({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ existing, token: "other" }) }), "credential_inactive");
  } finally { await f.cleanup(); }
});

test("sync interaction: a later sync of the WABA keeps the submitted draft's template row and status in step with Meta; sync never creates drafts", async () => {
  const f = await fixture();
  const existing: MetaTpl[] = [];
  try {
    const draft = await f.draft();
    const submitted = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
    existing[0].status = "APPROVED";
    existing.push({ id: "tpl-foreign", name: "made_in_manager", language: "en_US", category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: "Made elsewhere" }] });
    const { syncWabaTemplates } = await import("../src/services/whatsapp-template-sync");
    const sync = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ existing }) });
    assert.equal(sync.status, "synced");
    const rows = await db.select().from(templatesTable).where(eq(templatesTable.organizationId, f.org.id)).orderBy(templatesTable.providerTemplateId);
    assert.deepEqual(rows.map((r) => [r.providerTemplateId, r.status]), [["tpl-1000", "Approved"], ["tpl-foreign", "Approved"]]);
    assert.equal((await db.select().from(templateDraftsTable).where(eq(templateDraftsTable.organizationId, f.org.id))).length, 1, "sync does not invent drafts for provider templates");
    assert.equal(rows[0].id, submitted.draft.templateId);
  } finally { await f.cleanup(); }
});
