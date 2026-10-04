// V2-03B safety correction: reconciliation evidence, bounded name lookups,
// status refresh through the generation-ordered sync, lock order against
// the real credential lifecycle writers, fencing of stalled submits, late
// provider evidence and concurrent reconciliation. Fake Graph API only;
// nothing is created at Meta.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  phoneNumbersTable,
  templateDraftsTable,
  templateSubmissionAttemptsTable,
  templatesTable,
  usersTable,
  wabasTable,
  whatsappCredentialsTable,
  type TemplateDraftContent,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import { ManualMetaClient, type FetchLike } from "../src/services/whatsapp-manual-client";
import { compareTemplateEvidence, emptyDraftContent } from "../src/services/template-authoring";
import { TemplateDraftError } from "../src/services/template-draft-errors";
import { createDraft, deleteDraft, loadDraft } from "../src/services/template-drafts";
import { reconcileDraft, refreshDraftStatus, STALE_REQUESTED_MS, submitDraft } from "../src/services/template-submission";
import { connectManualNumber, revokeCredential } from "../src/services/whatsapp-manual-connection";
import { syncWabaTemplates } from "../src/services/whatsapp-template-sync";

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-recon-${randomBytes(20).toString("hex")}`;
const PHONE_ID = "1055500000001";

type Recorded = { url: string; method: string; auth?: string; body?: unknown };
type MetaTpl = { id: string; name: string; language: string; category: string; status: string; components: Record<string, unknown>[] };

function fakeMeta(options: {
  recorded?: Recorded[];
  existing?: MetaTpl[];
  onCreate?: (payload: Record<string, unknown>) => { status: number; body: unknown } | "timeout" | "network";
  /** Parks every GET listing until resolved (for ordering tests). */
  listGate?: Promise<void>;
  onListArrive?: () => void;
  /** Serve the listing in pages of this size. */
  pageSize?: number;
  /** Break pagination on this page index: next link with no cursor. */
  breakPage?: number;
  /** Put a malformed row on this page index. */
  malformedPage?: number;
  wabaExternalId?: string;
  phones?: Array<Record<string, unknown>>;
}): FetchLike {
  const existing = options.existing ?? [];
  let nextId = 1000;
  return async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    options.recorded?.push({ url, method, auth: headers?.Authorization, body });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (headers?.Authorization !== `Bearer ${TOKEN}`) return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.endsWith("/me")) return json(200, { id: "sys-user-1", name: "Wabista System User" });
    if (options.wabaExternalId && path.endsWith(`/${options.wabaExternalId}`)) return json(200, { id: options.wabaExternalId, name: "Acme WABA" });
    if (path.endsWith("/phone_numbers")) return json(200, { data: options.phones ?? [], paging: { cursors: {} } });
    if (method === "POST" && path.endsWith("/message_templates")) {
      const decision = options.onCreate?.(body) ?? { status: 200, body: null };
      if (decision === "timeout") await new Promise(() => undefined);
      if (decision === "network") throw new TypeError("fetch failed");
      if (decision.body !== null) return json(decision.status, decision.body);
      const created: MetaTpl = { id: `tpl-${nextId++}`, name: body.name, language: body.language, category: body.category, status: "PENDING", components: body.components };
      existing.push(created);
      return json(200, { id: created.id, status: "PENDING", category: created.category });
    }
    if (method === "GET" && path.endsWith("/message_templates")) {
      options.onListArrive?.();
      if (options.listGate) await options.listGate;
      const name = parsed.searchParams.get("name");
      const rows = existing.filter((t) => !name || t.name === name);
      const size = options.pageSize ?? 100;
      const after = parsed.searchParams.get("after");
      const index = after ? Number(after.replace("cursor-", "")) : 0;
      const page: unknown[] = rows.slice(index * size, (index + 1) * size);
      if (options.malformedPage === index) page.push({ id: 7, name: null });
      const hasNext = (index + 1) * size < rows.length;
      if (hasNext && options.breakPage === index) return json(200, { data: page, paging: { next: "https://graph.facebook.com/next", cursors: {} } });
      return json(200, { data: page, paging: hasNext ? { cursors: { after: `cursor-${index + 1}` }, next: `${parsed.origin}${path}?after=cursor-${index + 1}` } : { cursors: {} } });
    }
    return json(404, { error: { message: "Unknown edge", code: 100 } });
  };
}

async function fixture() {
  const slug = `tpl-recon-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [user] = await db.insert(usersTable).values({ clerkId: `clerk-${slug}`, email: `${slug}@example.test`, name: "Owner" }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: org.id, userId: user.id, role: "owner" });
  const enc = encryptCredential(TOKEN, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(TOKEN), status: "active",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `waba-${slug}`, displayName: "Acme WABA", credentialId: credential.id }).returning();
  const content: TemplateDraftContent = { ...emptyDraftContent(), body: { text: "Hi {{1}}, your order {{2}} is ready.", examples: ["Alice", "ORD-1"] }, footer: { text: "Thanks" }, buttons: [{ type: "quick_reply", text: "Stop" }] };
  const draft = async (name = "order_ready", override?: TemplateDraftContent) => createDraft(org.id, user.id, { wabaId: waba.id, name, language: "en_US", category: "UTILITY", content: override ?? content });
  return { org, user, credential, waba, slug, draft, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

/** The exact provider body the fixture draft produces (what Meta would list back, minus examples). */
const PAYLOAD = {
  name: "order_ready", language: "en_US", category: "UTILITY",
  components: [
    { type: "BODY", text: "Hi {{1}}, your order {{2}} is ready.", example: { body_text: [["Alice", "ORD-1"]] } },
    { type: "FOOTER", text: "Thanks" },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] },
  ],
};
function listed(overrides: Partial<MetaTpl> = {}): MetaTpl {
  return { id: "tpl-x", name: "order_ready", language: "en_US", category: "MARKETING", status: "PENDING", components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready." }, { type: "FOOTER", text: "Thanks" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }], ...overrides };
}

async function attempts(draftId: number) {
  return db.select().from(templateSubmissionAttemptsTable).where(eq(templateSubmissionAttemptsTable.draftId, draftId)).orderBy(templateSubmissionAttemptsTable.id);
}
async function latestAttemptId(draftId: number) { const rows = await attempts(draftId); return rows[rows.length - 1].id; }

async function expectError(promise: Promise<unknown>, code: string): Promise<TemplateDraftError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof TemplateDraftError, `expected TemplateDraftError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  throw new Error(`expected ${code} error`);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function arrival() {
  let arrived!: () => void;
  const promise = new Promise<void>((resolve) => { arrived = resolve; });
  return { promise, arrived };
}
const withTimeout = <T,>(p: Promise<T>, ms: number, label: string) => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms (deadlock?)`)), ms))]);

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  const { pool } = await import("@workspace/db");
  await pool.end();
});

// ------------------------------------------------------------- evidence

test("evidence: exact structural comparison; examples and category ignored; every documented difference is a mismatch; missing data is insufficient, never a match", () => {
  assert.deepEqual(compareTemplateEvidence(listed(), PAYLOAD), { verdict: "match", mediaUnverified: false }, "category reassigned and examples omitted still match");
  const cases: Array<[string, MetaTpl, "mismatch" | "insufficient"]> = [
    ["language", listed({ language: "en_GB" }), "mismatch"],
    ["body text", listed({ components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready!" }, { type: "FOOTER", text: "Thanks" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }] }), "mismatch"],
    ["footer text", listed({ components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready." }, { type: "FOOTER", text: "Bye" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }] }), "mismatch"],
    ["footer missing", listed({ components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready." }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }] }), "mismatch"],
    ["extra header", listed({ components: [{ type: "HEADER", format: "TEXT", text: "Hello" }, ...listed().components] }), "mismatch"],
    ["button type", listed({ components: [listed().components[0], listed().components[1], { type: "BUTTONS", buttons: [{ type: "URL", text: "Stop", url: "https://x.test" }] }] }), "mismatch"],
    ["button label", listed({ components: [listed().components[0], listed().components[1], { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop!" }] }] }), "mismatch"],
    ["body missing", listed({ components: [{ type: "FOOTER", text: "Thanks" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }] }), "mismatch"],
    ["no components field", { ...listed(), components: undefined as unknown as Record<string, unknown>[] }, "insufficient"],
    ["body without text", listed({ components: [{ type: "BODY" }, { type: "FOOTER", text: "Thanks" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }] }), "insufficient"],
    ["malformed button", listed({ components: [listed().components[0], listed().components[1], { type: "BUTTONS", buttons: [null] }] }), "insufficient"],
  ];
  for (const [label, template, verdict] of cases) assert.equal(compareTemplateEvidence(template, PAYLOAD).verdict, verdict, label);

  // URL and phone destinations and button order.
  const payload = {
    name: "cta", language: "en_US", category: "MARKETING",
    components: [
      { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["ORD-1"] } },
      { type: "BODY", text: "Track it." },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://example.test/o/{{1}}", example: ["ORD-1"] }, { type: "PHONE_NUMBER", text: "Call", phone_number: "+15550000001" }] },
    ],
  };
  const good = { name: "cta", language: "en_US", components: [{ type: "HEADER", format: "TEXT", text: "Order {{1}}" }, { type: "BODY", text: "Track it." }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://example.test/o/{{1}}" }, { type: "PHONE_NUMBER", text: "Call", phone_number: "+1 555-000-0001" }] }] };
  assert.equal(compareTemplateEvidence(good, payload).verdict, "match", "phone number formatting differences are normalised, nothing else");
  const reorder = { ...good, components: [good.components[0], good.components[1], { type: "BUTTONS", buttons: [good.components[2].buttons![1], good.components[2].buttons![0]] }] };
  assert.equal(compareTemplateEvidence(reorder as never, payload).verdict, "mismatch", "button order matters");
  const otherUrl = { ...good, components: [good.components[0], good.components[1], { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://evil.test/o/{{1}}" }, good.components[2].buttons![1]] }] };
  assert.equal(compareTemplateEvidence(otherUrl as never, payload).verdict, "mismatch", "URL destination matters");
  const otherPhone = { ...good, components: [good.components[0], good.components[1], { type: "BUTTONS", buttons: [good.components[2].buttons![0], { type: "PHONE_NUMBER", text: "Call", phone_number: "+15550000002" }] }] };
  assert.equal(compareTemplateEvidence(otherPhone as never, payload).verdict, "mismatch", "phone destination matters");
  const otherHeader = { ...good, components: [{ type: "HEADER", format: "TEXT", text: "Order" }, good.components[1], good.components[2]] };
  assert.equal(compareTemplateEvidence(otherHeader as never, payload).verdict, "mismatch", "header text matters");

  // Media header: format is evidence, the media itself is not comparable.
  const media = { name: "promo", language: "en_US", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4:abc"] } }, { type: "BODY", text: "Festive!" }] };
  assert.deepEqual(compareTemplateEvidence({ name: "promo", language: "en_US", components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.example/img.jpg"] } }, { type: "BODY", text: "Festive!" }] }, media), { verdict: "match", mediaUnverified: true });
  assert.equal(compareTemplateEvidence({ name: "promo", language: "en_US", components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Festive!" }] }, media).verdict, "mismatch", "a different media format is a mismatch");
  assert.equal(compareTemplateEvidence({ name: "promo", language: "en_US", components: [{ type: "HEADER" }, { type: "BODY", text: "Festive!" }] }, media).verdict, "insufficient", "a header without format is not evidence");
});

test("name lookups page completely and fail closed: a broken cursor or a malformed row refuses the listing (nothing linked), several matches stay unresolved, a media match is recorded as format-only evidence", async () => {
  const f = await fixture();
  try {
    const client = new ManualMetaClient({ accessToken: TOKEN, fetchImpl: fakeMeta({ existing: [listed({ id: "a" }), listed({ id: "b", name: "other" }), listed({ id: "c" }), listed({ id: "d" })], pageSize: 2 }) });
    const rows = await client.findTemplatesByName(f.waba.externalId, "order_ready");
    assert.deepEqual(rows.map((r) => r.id), ["a", "c", "d"], "every page of the filtered listing is followed");
    await assert.rejects(new ManualMetaClient({ accessToken: TOKEN, fetchImpl: fakeMeta({ existing: [listed({ id: "a" }), listed({ id: "c" }), listed({ id: "d" })], pageSize: 2, breakPage: 0 }) }).findTemplatesByName(f.waba.externalId, "order_ready"), /incomplete/);
    await assert.rejects(new ManualMetaClient({ accessToken: TOKEN, fetchImpl: fakeMeta({ existing: [listed({ id: "a" })], malformedPage: 0 }) }).findTemplatesByName(f.waba.externalId, "order_ready"), /malformed/);

    // Through reconciliation: pagination failure -> provider_unavailable, attempt untouched.
    const draft = await f.draft();
    const uncertain = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ onCreate: () => "network" }) });
    assert.equal(uncertain.attempt.state, "uncertain");
    await expectError(reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ existing: [listed({ id: "a" }), listed({ id: "c" }), listed({ id: "d" })], pageSize: 2, breakPage: 0 }) }), "provider_unavailable");
    await expectError(reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ existing: [listed({ id: "a" })], malformedPage: 0 }) }), "provider_unavailable");
    assert.equal((await attempts(draft.id))[0].state, "uncertain");
    assert.equal((await attempts(draft.id))[0].providerTemplateId, null);

    // Two exact matches: unresolved, neither linked.
    const two = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ existing: [listed({ id: "a" }), listed({ id: "c" })] }) });
    assert.equal(two.attempt.state, "uncertain");
    assert.match(two.attempt.reconcileNote!, /2 templates matching/);
    assert.equal(two.draft.providerTemplateId, null);

    // A match next to an incomparable row: unresolved too (the incomparable one could be ours).
    const mixed = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ existing: [listed({ id: "a" }), listed({ id: "c", components: [{ type: "BODY" }, { type: "FOOTER", text: "Thanks" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }] })] }) });
    assert.equal(mixed.attempt.state, "uncertain");
    assert.match(mixed.attempt.reconcileNote!, /could not be compared/);

    // One exact match: linked with a note that says exactly what was compared.
    const one = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ existing: [listed({ id: "a" })] }) });
    assert.equal(one.attempt.state, "succeeded");
    assert.equal(one.attempt.providerTemplateId, "a");
    assert.match(one.attempt.reconcileNote!, /every component match/);

    // Media header: linked with the limitation stated.
    const mediaDraft = await f.draft("promo_img", { ...emptyDraftContent(), header: { kind: "image", mediaUploadId: null }, body: { text: "Festive!", examples: [] } });
    await db.insert(templateSubmissionAttemptsTable).values({ organizationId: f.org.id, draftId: mediaDraft.id, draftRevision: 1, wabaId: f.waba.id, wabaExternalId: f.waba.externalId, credentialId: f.credential.id, payload: { name: "promo_img", language: "en_US", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4:h"] } }, { type: "BODY", text: "Festive!" }] }, state: "uncertain", error: "timeout" });
    await db.update(templateDraftsTable).set({ state: "reconcile_required" }).where(eq(templateDraftsTable.id, mediaDraft.id));
    const media = await reconcileDraft({ organizationId: f.org.id, draftId: mediaDraft.id, attemptId: await latestAttemptId(mediaDraft.id), userId: f.user.id, fetchImpl: fakeMeta({ existing: [{ id: "m", name: "promo_img", language: "en_US", category: "MARKETING", status: "PENDING", components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.example/x.jpg"] } }, { type: "BODY", text: "Festive!" }] }] }) });
    assert.equal(media.attempt.state, "succeeded");
    assert.match(media.attempt.reconcileNote!, /media example itself cannot be compared/);
  } finally { await f.cleanup(); }
});

// -------------------------------------------------------- refresh vs sync

test("refresh versus sync: a delayed Approved listing never overwrites a newer applied Removed or Paused snapshot; the refresh reports superseded and the draft shows the applied status", async () => {
  for (const newer of ["removed", "paused"] as const) {
    const f = await fixture();
    try {
      const draft = await f.draft();
      const existing: MetaTpl[] = [];
      const submitted = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
      assert.equal(submitted.draft.providerStatus, "Pending");
      const created = existing[0];

      // Refresh R1 fetches a listing that says APPROVED but is parked before it returns.
      const r1 = gate();
      const r1Arrived = arrival();
      const approvedListing = fakeMeta({ existing: [{ ...created, status: "APPROVED" }], listGate: r1.promise, onListArrive: r1Arrived.arrived });
      const refresh = refreshDraftStatus({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: approvedListing });
      const refreshSettled = refresh.then((d) => ({ ok: true as const, d }), (e: unknown) => ({ ok: false as const, e }));
      await r1Arrived.promise;

      // A newer sync S2 applies meanwhile: the template is gone (Removed) or PAUSED.
      const newerListing = newer === "removed" ? [] : [{ ...created, status: "PAUSED" }];
      const s2 = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ existing: newerListing }) });
      assert.equal(s2.status, "synced");
      const expected = newer === "removed" ? "Removed" : "Paused";
      assert.equal((await loadDraft(f.org.id, draft.id)).providerStatus, expected);

      r1.release();
      const outcome = await refreshSettled;
      assert.equal(outcome.ok, false, "the delayed refresh does not report a fresh status");
      if (!outcome.ok) {
        assert.ok(outcome.e instanceof TemplateDraftError);
        assert.equal(outcome.e.code, "sync_superseded");
      }
      const [row] = await db.select().from(templatesTable).where(eq(templatesTable.organizationId, f.org.id));
      assert.equal(row.status, expected, "the applied snapshot stands");
      assert.equal((row.metadata as Record<string, unknown>).providerStatus, newer === "removed" ? "PENDING" : "PAUSED", "raw provider status and removal metadata are consistent with the applied snapshot");
      assert.equal((row.metadata as Record<string, unknown>).providerMissing, newer === "removed");
      assert.equal((await loadDraft(f.org.id, draft.id)).providerStatus, expected, "the draft shows the applied result, never the stale Approved");
    } finally { await f.cleanup(); }
  }
});

test("credential mutation during refresh: a revocation while the listing is in flight makes the refresh fail closed; nothing is written and the draft keeps the last applied status", async () => {
  const f = await fixture();
  try {
    const draft = await f.draft();
    const existing: MetaTpl[] = [];
    await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
    const g = gate();
    const arrived = arrival();
    const refresh = refreshDraftStatus({ organizationId: f.org.id, draftId: draft.id, userId: f.user.id, fetchImpl: fakeMeta({ existing: [{ ...existing[0], status: "APPROVED" }], listGate: g.promise, onListArrive: arrived.arrived }) });
    const settled = refresh.then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
    await arrived.promise;
    await revokeCredential(f.org.id, f.credential.id);
    g.release();
    const outcome = await settled;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal((outcome.e as TemplateDraftError).code, "credential_inactive");
    const [row] = await db.select().from(templatesTable).where(eq(templatesTable.organizationId, f.org.id));
    assert.equal(row.status, "Pending", "the validated-then-revoked snapshot was not applied");
    assert.equal((await loadDraft(f.org.id, draft.id)).providerStatus, "Pending");
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------ lock order

test("lock order with the real lifecycle writers: a submit claim holding credential -> WABA -> draft and a concurrent reconnect/revoke finish without deadlock and with the right binding", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const draft = await f.draft();
    const phones = [{ id: PHONE_ID, display_phone_number: "+1 555-000-0001", verified_name: "Acme", quality_rating: "GREEN", code_verification_status: "NOT_VERIFIED" }];
    const connectFetch = fakeMeta({ wabaExternalId: f.waba.externalId, phones, existing: [] });

    // Reconnect (connectManualNumber with the same token) is started while the claim holds its locks.
    const locksHeld = arrival();
    const proceed = gate();
    let reconnectDone = false;
    let reconnect!: Promise<unknown>;
    const submit = submitDraft({
      organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ recorded, existing: [] }),
      hooks: { afterClaimLocks: async () => {
        reconnect = connectManualNumber({ organizationId: f.org.id, phoneNumber: "1 (555) 000-0001", accessToken: TOKEN, wabaId: f.waba.externalId, fetchImpl: connectFetch }).then((r) => { reconnectDone = true; return r; });
        locksHeld.arrived();
        await proceed.promise;
      } },
    });
    await locksHeld.promise;
    // Give the reconnect its Meta reads and let it reach the credential/WABA locks.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(reconnectDone, false, "the reconnect waits behind the claim's row locks (credential FOR SHARE, WABA FOR SHARE)");
    proceed.release();
    const result = await withTimeout(submit, 10_000, "submit");
    const reconnected = await withTimeout(reconnect, 10_000, "reconnect");
    assert.equal((reconnected as { outcome: string }).outcome, "connected");
    assert.equal(result.attempt.state, "succeeded");
    assert.equal(result.attempt.credentialId, f.credential.id, "the attempt is bound to the credential that was active at the claim");
    const [waba] = await db.select().from(wabasTable).where(eq(wabasTable.id, f.waba.id));
    assert.equal(waba.credentialId, f.credential.id, "same token re-submitted keeps the same credential row");
    assert.equal(recorded.filter((r) => r.method === "POST" && r.url.endsWith("/message_templates")).length, 1);
    await db.delete(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, f.org.id));

    // Revoke started while the claim holds its locks: it waits, then wins before the request -> no POST.
    const draft2 = await f.draft("order_ready_two");
    const held2 = arrival();
    const proceed2 = gate();
    let revoke!: Promise<unknown>;
    const posts: Recorded[] = [];
    const submit2 = submitDraft({
      organizationId: f.org.id, draftId: draft2.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ recorded: posts, existing: [] }),
      hooks: {
        afterClaimLocks: async () => { revoke = revokeCredential(f.org.id, f.credential.id); held2.arrived(); await proceed2.promise; },
        beforeProviderCall: async () => { await withTimeout(revoke, 10_000, "revoke"); },
      },
    });
    await held2.promise;
    proceed2.release();
    const result2 = await withTimeout(submit2, 10_000, "submit2");
    assert.equal(result2.attempt.state, "failed");
    assert.equal(result2.attempt.errorCode, "credential_inactive");
    assert.equal(posts.filter((r) => r.method === "POST").length, 0, "no request with a credential revoked after the claim");
  } finally { await f.cleanup(); }
});

// ----------------------------------------------- unknown outcomes & fencing

test("stalled submit resumed after reconciliation: the fence stops the POST; the reconciled state stands (both when reconciliation linked a template and when it stayed unresolved)", async () => {
  const f = await fixture();
  try {
    for (const atMeta of [true, false]) {
      const draft = await f.draft(atMeta ? "order_ready" : "order_ready_b");
      const payloadName = atMeta ? "order_ready" : "order_ready_b";
      const recorded: Recorded[] = [];
      const existing: MetaTpl[] = atMeta ? [listed({ id: "tpl-prior", name: payloadName })] : [];
      const result = await submitDraft({
        organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ recorded, existing }),
        hooks: { beforeProviderCall: async (attempt) => {
          // The process stalls long enough for an operator to reconcile the crash window.
          await db.update(templateSubmissionAttemptsTable).set({ startedAt: new Date(Date.now() - STALE_REQUESTED_MS - 1000) }).where(eq(templateSubmissionAttemptsTable.id, attempt.id));
          await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
        } },
      });
      assert.equal(recorded.filter((r) => r.method === "POST").length, 0, "no POST after the attempt was settled or re-examined");
      if (atMeta) {
        assert.equal(result.attempt.state, "succeeded");
        assert.equal(result.attempt.providerTemplateId, "tpl-prior");
        assert.equal(result.draft.state, "submitted");
      } else {
        assert.equal(result.attempt.state, "uncertain");
        assert.equal(result.draft.state, "reconcile_required");
        assert.equal(existing.length, 0, "nothing was created");
      }
    }
  } finally { await f.cleanup(); }
});

test("timeout after provider acceptance, then an empty listing: stays unresolved; the provider's late confirmed reply settles it; a late reply disagreeing with a reconciliation is stored, not applied", async () => {
  const f = await fixture();
  try {
    // Late confirmed success: Meta's reply is in hand while a reconciliation (empty listing) runs first.
    const draft = await f.draft();
    const existing: MetaTpl[] = [];
    const result = await submitDraft({
      organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing }),
      hooks: { beforeOutcome: async (attempt) => {
        await db.update(templateSubmissionAttemptsTable).set({ startedAt: new Date(Date.now() - STALE_REQUESTED_MS - 1000) }).where(eq(templateSubmissionAttemptsTable.id, attempt.id));
        const r = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ existing: [] }) });
        assert.equal(r.attempt.state, "uncertain", "empty listing while the outcome is unknown stays unresolved");
        assert.equal(r.draft.state, "reconcile_required");
      } },
    });
    assert.equal(result.attempt.state, "succeeded", "the late confirmed id is the missing proof and settles the uncertain attempt");
    assert.equal(result.attempt.providerTemplateId, existing[0].id);
    assert.match(result.attempt.reconcileNote!, /delayed reply confirmed creation/);
    assert.equal(result.draft.state, "submitted");
    assert.equal(result.draft.providerTemplateId, existing[0].id);

    // Late reply after a reconciliation already linked a different template: evidence persisted, settled state kept.
    const draft2 = await f.draft("order_ready_two");
    const existing2: MetaTpl[] = [listed({ id: "tpl-linked", name: "order_ready_two" })];
    const result2 = await submitDraft({
      organizationId: f.org.id, draftId: draft2.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing: existing2 }),
      hooks: { beforeOutcome: async (attempt) => {
        await db.update(templateSubmissionAttemptsTable).set({ startedAt: new Date(Date.now() - STALE_REQUESTED_MS - 1000) }).where(eq(templateSubmissionAttemptsTable.id, attempt.id));
        await reconcileDraft({ organizationId: f.org.id, draftId: draft2.id, attemptId: attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ existing: [existing2[0]] }) });
      } },
    });
    assert.equal(result2.attempt.state, "succeeded");
    assert.equal(result2.attempt.providerTemplateId, "tpl-linked", "the reconciliation's link is kept");
    assert.equal(result2.attempt.lateProviderTemplateId, existing2[1].id, "the late reply's id is persisted as evidence");
    assert.equal((result2.attempt.lateOutcome as Record<string, unknown>).kind, "succeeded");
    assert.ok(result2.attempt.lateOutcomeAt);
    assert.match(result2.attempt.reconcileNote!, /recorded, not applied/);
    assert.equal(result2.draft.providerTemplateId, "tpl-linked");
  } finally { await f.cleanup(); }
});

test("concurrent reconciliation converges on one settled attempt; a stale attempt id or a foreign attempt is refused; settled attempts are idempotent", async () => {
  const f = await fixture();
  try {
    const draft = await f.draft();
    const uncertain = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ onCreate: () => "network" }) });
    const g = gate();
    let arrivals = 0;
    const both = arrival();
    const listing = fakeMeta({ existing: [listed({ id: "tpl-real" })], listGate: g.promise, onListArrive: () => { arrivals += 1; if (arrivals === 2) both.arrived(); } });
    const a = reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: listing });
    const b = reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: listing });
    const settled = Promise.allSettled([a, b]);
    await both.promise;
    g.release();
    const outcomes = await settled;
    assert.ok(outcomes.every((o) => o.status === "fulfilled"), JSON.stringify(outcomes));
    for (const o of outcomes) if (o.status === "fulfilled") { assert.equal(o.value.attempt.state, "succeeded"); assert.equal(o.value.attempt.providerTemplateId, "tpl-real"); }
    assert.equal((await attempts(draft.id)).length, 1);
    assert.equal((await loadDraft(f.org.id, draft.id)).state, "submitted");
    // Idempotent afterwards, without a provider request.
    const recorded: Recorded[] = [];
    const again = await reconcileDraft({ organizationId: f.org.id, draftId: draft.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: fakeMeta({ recorded }) });
    assert.equal(again.attempt.state, "succeeded");
    assert.equal(recorded.length, 0);

    // Attempt fencing.
    const other = await f.draft("order_ready_two");
    const otherUncertain = await submitDraft({ organizationId: f.org.id, draftId: other.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ onCreate: () => "network" }) });
    await expectError(reconcileDraft({ organizationId: f.org.id, draftId: other.id, attemptId: uncertain.attempt.id, userId: f.user.id, fetchImpl: fakeMeta({}) }), "not_found");
    const [older] = await db.insert(templateSubmissionAttemptsTable).values({ organizationId: f.org.id, draftId: other.id, draftRevision: 1, wabaId: f.waba.id, wabaExternalId: f.waba.externalId, credentialId: f.credential.id, payload: { name: "order_ready_two" }, state: "failed", id: otherUncertain.attempt.id - 1000 }).returning();
    await expectError(reconcileDraft({ organizationId: f.org.id, draftId: other.id, attemptId: older.id, userId: f.user.id, fetchImpl: fakeMeta({}) }), "stale_attempt");
  } finally { await f.cleanup(); }
});

test("deletion: expectedRevision guards a stale client; a submitted draft's attempts survive its deletion as detached evidence", async () => {
  const f = await fixture();
  try {
    const draft = await f.draft();
    const existing: MetaTpl[] = [];
    const submitted = await submitDraft({ organizationId: f.org.id, draftId: draft.id, expectedRevision: 1, userId: f.user.id, fetchImpl: fakeMeta({ existing }) });
    await expectError(deleteDraft(f.org.id, draft.id, { expectedRevision: 99 }), "stale_revision");
    await deleteDraft(f.org.id, draft.id, { expectedRevision: submitted.draft.revision });
    await expectError(loadDraft(f.org.id, draft.id), "not_found");
    const [evidence] = await db.select().from(templateSubmissionAttemptsTable).where(eq(templateSubmissionAttemptsTable.id, submitted.attempt.id));
    assert.ok(evidence, "the attempt row survives");
    assert.equal(evidence.draftId, null);
    assert.equal(evidence.organizationId, f.org.id);
    assert.equal(evidence.wabaId, f.waba.id);
    assert.equal(evidence.providerTemplateId, existing[0].id);
    assert.deepEqual(evidence.payload, PAYLOAD);
    assert.equal((await db.select().from(templatesTable).where(eq(templatesTable.organizationId, f.org.id))).length, 1, "the synced provider row is untouched");
  } finally { await f.cleanup(); }
});
