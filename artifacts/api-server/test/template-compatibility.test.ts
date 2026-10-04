// V2-04 sender-template compatibility, enforced end to end. Fixture: WABA X
// (TX1, TX2), WABA Y (TY1), WABA Z (TZ1, TZ2), one connected phone per WABA.
// Fake provider only; disposable database; no background worker.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignTemplateSelectionsTable,
  campaignsTable,
  db,
  organizationsTable,
  organizationMembersTable,
  phoneNumbersTable,
  providerConnectionsTable,
  templateEligibilityTable,
  templatesTable,
  usersTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign, CampaignNotReadyError, type FrozenRoute } from "../src/services/campaign-planning";
import { validateCampaignReady } from "../src/services/campaign-preflight";
import { getActivePlanSummary } from "../src/services/campaign-plan-preview";
import { backfillTemplateEligibility, buildCompatibilityMatrix, decidePair, loadCompatibilityState, pairSendersToTemplates } from "../src/services/template-eligibility";
import { resolveJobTemplate } from "../src/services/template-resolution";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { revokeCredential } from "../src/services/whatsapp-manual-connection";
import { syncWabaTemplates } from "../src/services/whatsapp-template-sync";
import type { FetchLike } from "../src/services/whatsapp-manual-client";
import campaignRoutesRouter, { assertOwnedByOrg } from "../src/routes/campaign-routes";
import compatibilityRouter from "../src/routes/compatibility";

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-compat-${randomBytes(20).toString("hex")}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handler(router: any, path: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler for ${method} ${path}`);
}
function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.send = () => res;
  res.end = () => res;
  return res;
}

type Transport = "credential" | "legacy_mock" | "legacy_real";

async function fixture(transport: Transport = "credential") {
  const slug = `compat-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [user] = await db.insert(usersTable).values({ clerkId: `clerk-${slug}`, email: `${slug}@example.test`, name: "Owner" }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: org.id, userId: user.id, role: "owner" });
  let credential: typeof whatsappCredentialsTable.$inferSelect | null = null;
  if (transport === "credential") {
    const enc = encryptCredential(TOKEN, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
    [credential] = await db.insert(whatsappCredentialsTable).values({
      organizationId: org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
      tokenFingerprint: credentialFingerprint(TOKEN), status: "active",
    }).returning();
  }
  const makeWaba = async (name: string) => (await db.insert(wabasTable).values({ organizationId: org.id, externalId: `${slug}-waba-${name}`, displayName: `WABA ${name}`, credentialId: credential?.id ?? null }).returning())[0];
  const X = await makeWaba("X"); const Y = await makeWaba("Y"); const Z = await makeWaba("Z");
  await db.insert(providerConnectionsTable).values({
    organizationId: org.id, provider: "whatsapp-business", mode: transport === "legacy_real" ? "real" : "mock", status: "configured",
    configuredWabaExternalId: transport === "legacy_real" ? X.externalId : null, connectorAccountId: transport === "legacy_real" ? `acct-${slug}` : null,
  });
  const makePhone = async (name: string, waba: { id: number }, extra: Partial<typeof phoneNumbersTable.$inferInsert> = {}) => (await db.insert(phoneNumbersTable).values({
    organizationId: org.id, wabaId: waba.id, phone: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, providerPhoneId: `${slug}-pn-${name}`, displayName: `Phone ${name}`,
    status: "Connected", setupState: transport === "credential" ? "active" : "unknown", tpsLimit: 80,
    sendingCredentialId: transport === "credential" ? credential!.id : null, credentialId: credential?.id ?? null, ...extra,
  }).returning())[0];
  const PX = await makePhone("X", X); const PY = await makePhone("Y", Y); const PZ = await makePhone("Z", Z);
  const makeTemplate = async (name: string, waba: { id: number } | null, extra: Partial<typeof templatesTable.$inferInsert> = {}) => (await db.insert(templatesTable).values({
    organizationId: org.id, wabaId: waba?.id ?? null, providerTemplateId: waba ? `${slug}-tpl-${name}` : null, name: name.toLowerCase(), language: "en_US", category: "Marketing",
    status: "Approved", body: `Hello from ${name}`, components: [{ type: "BODY", text: `Hello from ${name}` }],
    metadata: waba ? { source: transport === "credential" ? "workspace_credential" : "legacy_connector", providerStatus: "APPROVED", providerMissing: false } : { source: "local" },
    lastSyncedAt: new Date("2026-10-01T00:00:00Z"), ...extra,
  }).returning())[0];
  const TX1 = await makeTemplate("TX1", X); const TX2 = await makeTemplate("TX2", X); const TY1 = await makeTemplate("TY1", Y); const TZ1 = await makeTemplate("TZ1", Z); const TZ2 = await makeTemplate("TZ2", Z);
  await backfillTemplateEligibility(org.id);
  const campaign = async () => {
    const [row] = await db.insert(campaignsTable).values({ organizationId: org.id, name: `${slug}-campaign`, status: "Draft" }).returning();
    await db.insert(campaignMetricsTable).values({ organizationId: org.id, campaignId: row.id, total: 1, valid: 1 });
    return row;
  };
  return { org, user, credential, slug, X, Y, Z, PX, PY, PZ, TX1, TX2, TY1, TZ1, TZ2, makePhone, makeTemplate, campaign, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function rocketSetup(f: Fixture, campaignId: number, numbers: Array<{ phoneNumberId: number; configuredTps: number }>, templateIds: number[], organizationId = f.org.id) {
  const res = fakeResponse();
  await handler(campaignRoutesRouter, "/organizations/:organizationId/campaigns/:campaignId/rocket-setup", "put")(
    { params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body: { numbers, templateIds }, organizationId, role: "owner" }, res,
  );
  return res;
}
async function matrixHandler(organizationId: number, body: { numberIds?: number[]; templateIds?: number[] }) {
  const res = fakeResponse();
  await handler(compatibilityRouter, "/organizations/:organizationId/whatsapp/compatibility", "post")({ params: { organizationId: String(organizationId) }, body, organizationId, role: "agent" }, res);
  return res;
}
async function routesOf(campaignId: number) {
  return db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaignId)).orderBy(campaignRoutesTable.id);
}
function pairMap(m: Awaited<ReturnType<typeof buildCompatibilityMatrix>>) {
  return new Set(m.numbers.flatMap((n) => n.eligibleTemplateIds.map((t) => `${n.phoneNumberId}:${t}`)));
}

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  const { pool, settlementPool } = await import("@workspace/db");
  await Promise.all([pool.end(), settlementPool.end()]);
});

test("matrix: exactly the eligible pairs for X/Y/Z; Y cannot send TX1; both derived modes are bounded; evidence source and time are reported", async () => {
  const f = await fixture();
  try {
    const m = await buildCompatibilityMatrix(f.org.id, { phoneIds: [f.PX.id, f.PY.id, f.PZ.id], templateIds: [f.TX1.id, f.TX2.id, f.TY1.id, f.TZ1.id, f.TZ2.id] });
    assert.deepEqual([...pairMap(m)].sort(), [`${f.PX.id}:${f.TX1.id}`, `${f.PX.id}:${f.TX2.id}`, `${f.PY.id}:${f.TY1.id}`, `${f.PZ.id}:${f.TZ1.id}`, `${f.PZ.id}:${f.TZ2.id}`].sort());
    const yx = m.incompatiblePairs.find((p) => p.phoneNumberId === f.PY.id && p.templateId === f.TX1.id)!;
    assert.equal(yx.code, "waba_mismatch");
    assert.equal(m.incompatiblePairs.length, 15 - 5);
    assert.deepEqual(m.numbersWithoutTemplate, []);
    assert.deepEqual(m.templatesWithoutNumber, []);
    const tx1 = m.templates.find((t) => t.templateId === f.TX1.id)!;
    assert.equal(tx1.evidence?.source, "backfill");
    assert.equal(tx1.evidence?.verifiedAt?.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(m.numbers.find((n) => n.phoneNumberId === f.PX.id)!.transport, "workspace_credential");
    assert.equal(m.numbers.find((n) => n.phoneNumberId === f.PX.id)!.wabaExternalId, f.X.externalId);

    // Derived sides.
    const forPhone = await buildCompatibilityMatrix(f.org.id, { phoneIds: [f.PZ.id] });
    assert.deepEqual(forPhone.templates.map((t) => t.templateId).sort(), [f.TZ1.id, f.TZ2.id].sort(), "only the number's own WABA templates are derived");
    const forTemplate = await buildCompatibilityMatrix(f.org.id, { templateIds: [f.TY1.id] });
    assert.deepEqual(forTemplate.numbers.map((n) => n.phoneNumberId), [f.PY.id]);
    await assert.rejects(buildCompatibilityMatrix(f.org.id, { phoneIds: Array.from({ length: 51 }, (_, i) => i + 1) }), /At most 50/);
    await assert.rejects(buildCompatibilityMatrix(f.org.id, {}), /at least one/);

    // Through the handler (membership read): same result, zod-validated.
    const res = await matrixHandler(f.org.id, { numberIds: [f.PY.id], templateIds: [f.TX1.id, f.TY1.id] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.numbers[0].eligibleTemplateIds, [f.TY1.id]);
    assert.deepEqual(res.body.templatesWithoutNumber, [f.TX1.id]);
    const tooMany = await matrixHandler(f.org.id, { numberIds: Array.from({ length: 51 }, (_, i) => i + 1) });
    assert.equal(tooMany.statusCode, 400);
  } finally { await f.cleanup(); }
});

test("rejections: sample, Pending, Paused, Removed, Unknown and local templates; disconnected, sample and credential-less numbers; revoked and misbound credentials", async () => {
  const f = await fixture();
  try {
    const cases: Array<[string, Partial<typeof templatesTable.$inferInsert>, string]> = [
      ["sample", { isSample: true }, "template_sample"],
      ["pending", { status: "Pending", metadata: { source: "workspace_credential", providerStatus: "PENDING" } }, "template_not_approved"],
      ["paused", { status: "Paused", metadata: { source: "workspace_credential", providerStatus: "PAUSED" } }, "template_not_approved"],
      ["removed", { status: "Removed", metadata: { source: "workspace_credential", providerStatus: null, providerMissing: true } }, "template_removed"],
      ["unknown", { status: "Unknown", metadata: { source: "workspace_credential", providerStatus: "SOMETHING_NEW" } }, "template_not_approved"],
    ];
    for (const [name, extra, code] of cases) {
      const template = await f.makeTemplate(`T${name}`, f.X, extra);
      await backfillTemplateEligibility(f.org.id);
      const state = await loadCompatibilityState(f.org.id, { phoneIds: [f.PX.id], templateIds: [template.id] });
      assert.equal(decidePair(state, f.PX.id, template.id).code, code, name);
    }
    // Approved locally but the provider evidence says otherwise: not eligible.
    await db.update(templateEligibilityTable).set({ sendable: false, status: "Paused" }).where(eq(templateEligibilityTable.templateId, f.TX2.id));
    let state = await loadCompatibilityState(f.org.id, { phoneIds: [f.PX.id], templateIds: [f.TX2.id] });
    assert.equal(decidePair(state, f.PX.id, f.TX2.id).code, "evidence_not_sendable");
    // No evidence row at all for a provider template: not eligible until a sync or backfill verifies it.
    await db.delete(templateEligibilityTable).where(eq(templateEligibilityTable.templateId, f.TX2.id));
    state = await loadCompatibilityState(f.org.id, { phoneIds: [f.PX.id], templateIds: [f.TX2.id] });
    assert.equal(decidePair(state, f.PX.id, f.TX2.id).code, "evidence_missing");
    // Local draft template for a workspace-credential sender.
    const local = await f.makeTemplate("Tlocal", null);
    await db.update(templatesTable).set({ wabaId: f.X.id }).where(eq(templatesTable.id, local.id));
    state = await loadCompatibilityState(f.org.id, { phoneIds: [f.PX.id], templateIds: [local.id] });
    assert.equal(decidePair(state, f.PX.id, local.id).code, "template_not_provider_backed");

    // Numbers.
    const pending = await f.makePhone("pending", f.X, { status: "Pending" });
    const sample = await f.makePhone("sample", f.X, { isSample: true });
    const noIdentity = await f.makePhone("noid", f.X, { providerPhoneId: null });
    const unbound = await f.makePhone("unbound", f.X, { wabaId: null });
    state = await loadCompatibilityState(f.org.id, { phoneIds: [pending.id, sample.id, noIdentity.id, unbound.id], templateIds: [f.TX1.id] });
    assert.equal(decidePair(state, pending.id, f.TX1.id).code, "phone_not_connected");
    assert.equal(decidePair(state, sample.id, f.TX1.id).code, "phone_sample");
    assert.equal(decidePair(state, noIdentity.id, f.TX1.id).code, "phone_no_provider_identity");
    assert.equal(decidePair(state, unbound.id, f.TX1.id).code, "phone_no_waba");

    // Misbound: the WABA is associated with another credential than the phone sends with.
    const enc = encryptCredential(`${TOKEN}-2`, { organizationId: f.org.id, kind: "manual_token", provider: "whatsapp-business" });
    const [other] = await db.insert(whatsappCredentialsTable).values({ organizationId: f.org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion, tokenFingerprint: credentialFingerprint(`${TOKEN}-2`), status: "active" }).returning();
    await db.update(wabasTable).set({ credentialId: other.id }).where(eq(wabasTable.id, f.Y.id));
    state = await loadCompatibilityState(f.org.id, { phoneIds: [f.PY.id], templateIds: [f.TY1.id] });
    assert.equal(decidePair(state, f.PY.id, f.TY1.id).code, "credential_unbound");
    // Revoked: the cached evidence row is unchanged, the live credential decides.
    await revokeCredential(f.org.id, f.credential!.id);
    state = await loadCompatibilityState(f.org.id, { phoneIds: [f.PX.id], templateIds: [f.TX1.id] });
    assert.equal(decidePair(state, f.PX.id, f.TX1.id).code, "phone_not_connected", "revocation demoted the phone");
    await db.update(phoneNumbersTable).set({ status: "Connected", sendingCredentialId: f.credential!.id }).where(eq(phoneNumbersTable.id, f.PX.id));
    state = await loadCompatibilityState(f.org.id, { phoneIds: [f.PX.id], templateIds: [f.TX1.id] });
    assert.equal(decidePair(state, f.PX.id, f.TX1.id).code, "credential_inactive");
    assert.equal((await db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.templateId, f.TX1.id)))[0].sendable, true, "evidence stays what the provider said; it never outranks live credential state");
  } finally { await f.cleanup(); }
});

test("no null-WABA bypass into real sending; the local/mock exception is explicit, isolated to mock mode without a credential, and never grants on a null WABA alone", async () => {
  const credential = await fixture("credential");
  const mock = await fixture("legacy_mock");
  const real = await fixture("legacy_real");
  try {
    // Workspace credential: a null-WABA template is never eligible.
    const nullTemplate = await credential.makeTemplate("Tnull", null, { providerTemplateId: `${credential.slug}-null`, metadata: { source: "workspace_credential" } });
    let state = await loadCompatibilityState(credential.org.id, { phoneIds: [credential.PX.id], templateIds: [nullTemplate.id] });
    assert.equal(decidePair(state, credential.PX.id, nullTemplate.id).code, "waba_mismatch", "credential sender + null-WABA template");

    // Legacy real connector: only the claimed WABA on both sides.
    state = await loadCompatibilityState(real.org.id, { phoneIds: [real.PX.id, real.PY.id], templateIds: [real.TX1.id, real.TY1.id] });
    assert.equal(decidePair(state, real.PX.id, real.TX1.id).code, "eligible");
    assert.equal(decidePair(state, real.PY.id, real.TY1.id).code, "legacy_waba_not_claimed");
    assert.equal(decidePair(state, real.PX.id, real.TY1.id).code, "legacy_waba_not_claimed");
    const realLocal = await real.makeTemplate("Tlocal", null);
    const realUnbound = await real.makePhone("unbound", real.X, { wabaId: null });
    state = await loadCompatibilityState(real.org.id, { phoneIds: [real.PX.id, realUnbound.id], templateIds: [realLocal.id] });
    assert.equal(decidePair(state, real.PX.id, realLocal.id).code, "template_not_provider_backed");
    assert.equal(decidePair(state, realUnbound.id, realLocal.id).code, "phone_no_waba");

    // Local/mock exception.
    const local = await mock.makeTemplate("Tlocal", null);
    const unbound = await mock.makePhone("unbound", mock.X, { wabaId: null, providerPhoneId: null });
    state = await loadCompatibilityState(mock.org.id, { phoneIds: [mock.PX.id, unbound.id], templateIds: [mock.TX1.id, mock.TY1.id, local.id] });
    assert.equal(decidePair(state, mock.PX.id, mock.TX1.id).code, "eligible_local_mock", "provider template on the same WABA, mock mode");
    assert.equal(decidePair(state, unbound.id, local.id).code, "eligible_local_mock", "both unbound: the explicit local/test pairing");
    assert.equal(decidePair(state, mock.PX.id, local.id).code, "waba_mismatch", "a null-WABA template does not get a WABA-bound number");
    assert.equal(decidePair(state, unbound.id, mock.TX1.id).code, "waba_mismatch", "a null-WABA number does not get a WABA template");
    assert.equal(decidePair(state, mock.PX.id, mock.TY1.id).code, "waba_mismatch", "mock PX + TY1");
    // Flip the same workspace to real: the exception is gone.
    await db.update(providerConnectionsTable).set({ mode: "real", configuredWabaExternalId: mock.X.externalId }).where(eq(providerConnectionsTable.organizationId, mock.org.id));
    state = await loadCompatibilityState(mock.org.id, { phoneIds: [mock.PX.id, unbound.id], templateIds: [mock.TX1.id, local.id] });
    assert.equal(decidePair(state, unbound.id, local.id).code, "phone_no_provider_identity");
    assert.equal(decidePair(state, mock.PX.id, local.id).code, "template_not_provider_backed");
    assert.equal(decidePair(state, mock.PX.id, mock.TX1.id).code, "eligible");
  } finally { await credential.cleanup(); await mock.cleanup(); await real.cleanup(); }
});

test("pairing: deterministic, covers a feasible combination the rotating greedy pass missed, stable tie-breaking, actionable failure", () => {
  // phones: C(Z), A(X), B(X); templates: T1(X), T3(Z), T2(X). Greedy (start at
  // own index) gives C->T3, A->T2, B->T2 and leaves T1 uncovered; a covering
  // assignment exists.
  const waba = new Map([["C", "Z"], ["A", "X"], ["B", "X"]]);
  const twaba = new Map([["T1", "X"], ["T3", "Z"], ["T2", "X"]]);
  const ids = { C: 1, A: 2, B: 3, T1: 11, T3: 13, T2: 12 } as const;
  const name = (id: number) => Object.entries(ids).find(([, v]) => v === id)![0];
  const eligible = (p: number, t: number) => waba.get(name(p)) === twaba.get(name(t));
  const result = pairSendersToTemplates([ids.C, ids.A, ids.B], [ids.T1, ids.T3, ids.T2], eligible);
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.assignments, [{ phoneNumberId: ids.C, templateId: ids.T3 }, { phoneNumberId: ids.A, templateId: ids.T1 }, { phoneNumberId: ids.B, templateId: ids.T2 }]);
    assert.deepEqual(pairSendersToTemplates([ids.C, ids.A, ids.B], [ids.T1, ids.T3, ids.T2], eligible), result, "same inputs, same output");
  }
  // Extra numbers go to the least-loaded eligible template, ties by request order.
  const more = pairSendersToTemplates([ids.A, ids.B, 4, 5], [ids.T1, ids.T2], (p, t) => [ids.A, ids.B, 4, 5].includes(p) && [ids.T1, ids.T2].includes(t));
  assert.ok(more.ok);
  if (more.ok) assert.deepEqual(more.assignments.map((a) => a.templateId), [ids.T1, ids.T2, ids.T1, ids.T2]);
  // Different request order: still valid, still deterministic.
  const reordered = pairSendersToTemplates([ids.B, ids.A, ids.C], [ids.T2, ids.T1, ids.T3], eligible);
  assert.ok(reordered.ok);
  if (reordered.ok) assert.deepEqual(reordered.assignments, [{ phoneNumberId: ids.B, templateId: ids.T2 }, { phoneNumberId: ids.A, templateId: ids.T1 }, { phoneNumberId: ids.C, templateId: ids.T3 }]);
  // Impossible coverage.
  const impossible = pairSendersToTemplates([ids.A, ids.B], [ids.T1, ids.T3], eligible);
  assert.equal(impossible.ok, false);
  if (!impossible.ok) { assert.deepEqual(impossible.uncoveredTemplateIds, [ids.T3]); assert.match(impossible.message, /cannot be covered/); }
});

test("Rocket setup: valid mixed-WABA setup succeeds with per-route WABA; greedy-missed combination succeeds; impossible coverage fails atomically; cross-tenant ids refused", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const campaign = await f.campaign();
    const ok = await rocketSetup(f, campaign.id, [{ phoneNumberId: f.PX.id, configuredTps: 10 }, { phoneNumberId: f.PY.id, configuredTps: 10 }, { phoneNumberId: f.PZ.id, configuredTps: 10 }], [f.TX1.id, f.TY1.id, f.TZ1.id]);
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    const routes = await routesOf(campaign.id);
    assert.deepEqual(routes.map((r) => [r.phoneNumberId, r.templateId, r.wabaId]), [[f.PX.id, f.TX1.id, f.X.id], [f.PY.id, f.TY1.id, f.Y.id], [f.PZ.id, f.TZ1.id, f.Z.id]]);
    assert.equal(ok.body.routes[0].wabaId, f.X.id);
    assert.deepEqual(await validateCampaignReady(f.org.id, campaign.id), []);

    // Greedy-missed: numbers [PZ, PX, PX2], templates [TX1, TZ1, TX2].
    const PX2 = await f.makePhone("X2", f.X);
    const tricky = await rocketSetup(f, campaign.id, [{ phoneNumberId: f.PZ.id, configuredTps: 10 }, { phoneNumberId: f.PX.id, configuredTps: 10 }, { phoneNumberId: PX2.id, configuredTps: 10 }], [f.TX1.id, f.TZ1.id, f.TX2.id]);
    assert.equal(tricky.statusCode, 200, JSON.stringify(tricky.body));
    const trickyRoutes = await routesOf(campaign.id);
    assert.deepEqual(trickyRoutes.map((r) => [r.phoneNumberId, r.templateId]), [[f.PZ.id, f.TZ1.id], [f.PX.id, f.TX1.id], [PX2.id, f.TX2.id]]);

    // Impossible: nothing changes, previous routes/selections stay.
    const before = JSON.stringify(trickyRoutes.map((r) => [r.id, r.phoneNumberId, r.templateId]));
    const impossible = await rocketSetup(f, campaign.id, [{ phoneNumberId: f.PX.id, configuredTps: 10 }, { phoneNumberId: f.PZ.id, configuredTps: 10 }], [f.TX1.id, f.TY1.id]);
    assert.equal(impossible.statusCode, 409);
    assert.match(impossible.body.error, /cannot be set up/);
    assert.match(impossible.body.error, /different WhatsApp Business Accounts/);
    assert.equal(JSON.stringify((await routesOf(campaign.id)).map((r) => [r.id, r.phoneNumberId, r.templateId])), before, "no partial setup written");
    assert.deepEqual((await db.select().from(campaignTemplateSelectionsTable).where(eq(campaignTemplateSelectionsTable.campaignId, campaign.id))).map((s) => s.templateId).sort(), [f.TX1.id, f.TZ1.id, f.TX2.id].sort());

    // A selected number that can send nothing is also refused.
    const PY2 = await f.makePhone("Y2", f.Y);
    const stranded = await rocketSetup(f, campaign.id, [{ phoneNumberId: f.PX.id, configuredTps: 10 }, { phoneNumberId: PY2.id, configuredTps: 10 }], [f.TX1.id]);
    assert.equal(stranded.statusCode, 409);
    assert.match(stranded.body.error, /cannot send any selected template/);

    // Cross-tenant: another workspace's phone or template never qualifies.
    const foreignPhone = await rocketSetup(f, campaign.id, [{ phoneNumberId: other.PX.id, configuredTps: 10 }], [f.TX1.id]);
    assert.equal(foreignPhone.statusCode, 409);
    assert.match(foreignPhone.body.error, /belong to this organization/);
    const foreignTemplate = await rocketSetup(f, campaign.id, [{ phoneNumberId: f.PX.id, configuredTps: 10 }], [other.TX1.id]);
    assert.equal(foreignTemplate.statusCode, 409);
    // Cross-tenant matrix: ids are reported not_found, nothing revealed.
    const peek = await buildCompatibilityMatrix(other.org.id, { phoneIds: [f.PX.id], templateIds: [f.TX1.id] });
    assert.equal(peek.numbers[0].code, "not_found");
    assert.equal(peek.numbers[0].phone, "");
    assert.equal(peek.templates[0].code, "not_found");
    assert.equal(peek.templates[0].name, "");
  } finally { await f.cleanup(); await other.cleanup(); }
});

test("sibling mutation paths share the rule: route create/update refuse incompatible pairs with the stable reason; readiness names the blockers", async () => {
  const f = await fixture();
  try {
    const campaign = await f.campaign();
    assert.match((await assertOwnedByOrg(f.org.id, campaign.id, f.PY.id, f.TX1.id, 10)) ?? "", /waba_mismatch/);
    assert.equal(await assertOwnedByOrg(f.org.id, campaign.id, f.PY.id, f.TY1.id, 10), null);
    const local = await f.makeTemplate("Tlocal", null);
    assert.match((await assertOwnedByOrg(f.org.id, campaign.id, f.PX.id, local.id, 10)) ?? "", /template_not_provider_backed|waba_mismatch/);
    // Readiness: a route written around the API (wrong pair) is flagged with the code, and a selected-but-unrouted template is flagged.
    await db.insert(campaignRoutesTable).values({ organizationId: f.org.id, campaignId: campaign.id, phoneNumberId: f.PY.id, templateId: f.TX1.id, configuredTps: 10, wabaId: f.Y.id });
    await db.insert(campaignTemplateSelectionsTable).values([{ organizationId: f.org.id, campaignId: campaign.id, templateId: f.TX1.id }, { organizationId: f.org.id, campaignId: campaign.id, templateId: f.TZ1.id }]);
    const errors = await validateCampaignReady(f.org.id, campaign.id);
    assert.ok(errors.some((e) => /waba_mismatch/.test(e)), errors.join("\n"));
    assert.ok(errors.some((e) => e === `Template ${f.TZ1.id} has no eligible sending route`), errors.join("\n"));
    assert.ok(errors.some((e) => e === `Template ${f.TX1.id} has no eligible sending route`));
    // A route whose stored WABA no longer matches its phone is flagged, not repaired.
    await db.update(campaignRoutesTable).set({ phoneNumberId: f.PX.id }).where(eq(campaignRoutesTable.campaignId, campaign.id));
    const stale = await validateCampaignReady(f.org.id, campaign.id);
    assert.ok(stale.some((e) => /different WhatsApp Business Account than its phone now belongs to/.test(e)), stale.join("\n"));
    await assert.rejects(planCampaign(f.org.id, campaign.id), (error: unknown) => error instanceof CampaignNotReadyError);
  } finally { await f.cleanup(); }
});

test("evidence freshness: a failed or superseded sync writes no evidence; repeated backfill and sync create no duplicates; sync rows outrank backfill rows", async () => {
  const f = await fixture();
  try {
    const listing = (templates: Array<{ id: string; name: string; status: string }>, options: { fail?: boolean; gate?: Promise<void>; onArrive?: () => void } = {}): FetchLike => async (url, init) => {
      const headers = init.headers as Record<string, string>;
      const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (headers?.Authorization !== `Bearer ${TOKEN}`) return json(401, { error: { message: "bad token", code: 190 } });
      options.onArrive?.();
      if (options.gate) await options.gate;
      if (options.fail) return json(500, { error: { message: "down", code: 2 } });
      return json(200, { data: templates.map((t) => ({ ...t, language: "en_US", category: "MARKETING", components: [{ type: "BODY", text: "Hi" }] })), paging: { cursors: {} } });
    };
    const countRows = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(templateEligibilityTable).where(eq(templateEligibilityTable.organizationId, f.org.id)))[0].n;
    const initial = await countRows();
    assert.equal(initial, 5);
    await backfillTemplateEligibility(f.org.id);
    await backfillTemplateEligibility();
    assert.equal(await countRows(), 5, "backfill is idempotent");

    // Failed sync: no evidence for a template Meta would have added.
    const failed = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.X.id, fetchImpl: listing([{ id: "tpl-new", name: "brand_new", status: "APPROVED" }], { fail: true }) });
    assert.equal(failed.status, "failed");
    assert.equal(await countRows(), 5);
    assert.equal((await db.select().from(templatesTable).where(and(eq(templatesTable.organizationId, f.org.id), eq(templatesTable.providerTemplateId, "tpl-new")))).length, 0);

    // Applied sync: TX1 and TX2 re-verified by the credential path (fresher provenance), TX1 paused.
    const applied = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.X.id, fetchImpl: listing([{ id: f.TX1.providerTemplateId!, name: "tx1", status: "PAUSED" }, { id: f.TX2.providerTemplateId!, name: "tx2", status: "APPROVED" }]) });
    assert.equal(applied.status, "synced");
    assert.equal(await countRows(), 5, "no duplicates from sync");
    const tx1 = (await db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.templateId, f.TX1.id)))[0];
    assert.equal(tx1.evidenceSource, "workspace_credential");
    assert.equal(tx1.sendable, false);
    assert.equal(tx1.providerStatus, "PAUSED");
    assert.equal(tx1.syncGeneration, applied.generation);
    assert.equal(tx1.credentialId, f.credential!.id);
    await backfillTemplateEligibility(f.org.id);
    assert.equal((await db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.templateId, f.TX1.id)))[0].evidenceSource, "workspace_credential", "backfill never overwrites sync-written evidence");

    // Superseded sync: an older listing (TX1 APPROVED) parked before apply; a newer sync (TX1 missing) applies first.
    let release!: () => void;
    let arrive!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrived = new Promise<void>((resolve) => { arrive = resolve; });
    const older = syncWabaTemplates({ organizationId: f.org.id, wabaId: f.X.id, fetchImpl: listing([{ id: f.TX1.providerTemplateId!, name: "tx1", status: "APPROVED" }, { id: f.TX2.providerTemplateId!, name: "tx2", status: "APPROVED" }], { gate, onArrive: arrive }) });
    await arrived;
    const newer = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.X.id, fetchImpl: listing([{ id: f.TX2.providerTemplateId!, name: "tx2", status: "APPROVED" }]) });
    assert.equal(newer.status, "synced");
    release();
    const olderResult = await older;
    assert.equal(olderResult.status, "superseded");
    const removed = (await db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.templateId, f.TX1.id)))[0];
    assert.equal(removed.sendable, false);
    assert.equal(removed.providerMissing, true);
    assert.equal(removed.syncGeneration, newer.generation, "the superseded listing wrote nothing");
    const state = await loadCompatibilityState(f.org.id, { phoneIds: [f.PX.id], templateIds: [f.TX1.id, f.TX2.id] });
    assert.equal(decidePair(state, f.PX.id, f.TX1.id).code, "template_removed");
    assert.equal(decidePair(state, f.PX.id, f.TX2.id).code, "eligible");
    assert.equal(await countRows(), 5);
  } finally { await f.cleanup(); }
});

test("frozen evidence: planning freezes WABA, eligible templates, verification time and source from one evaluation; it survives later edits; preparation re-checks live state and never switches template, credential or plan; older plans grant nothing", async () => {
  const f = await fixture();
  try {
    const campaign = await f.campaign();
    const setup = await rocketSetup(f, campaign.id, [{ phoneNumberId: f.PX.id, configuredTps: 10 }, { phoneNumberId: f.PZ.id, configuredTps: 10 }], [f.TX1.id, f.TZ1.id]);
    assert.equal(setup.statusCode, 200);
    await db.insert(campaignContactsTable).values([
      { organizationId: f.org.id, campaignId: campaign.id, rowNumber: 1, rawPhone: "+15550000101", normalizedPhone: "+15550000101", status: "Valid", data: {}, idempotencyKey: `${f.slug}-c1` },
      { organizationId: f.org.id, campaignId: campaign.id, rowNumber: 2, rawPhone: "+15550000102", normalizedPhone: "+15550000102", status: "Valid", data: {}, idempotencyKey: `${f.slug}-c2` },
    ]);
    const { plan } = await planCampaign(f.org.id, campaign.id);
    const frozen = plan.routes as FrozenRoute[];
    const routeX = frozen.find((r) => r.phoneNumberId === f.PX.id)!;
    assert.equal(routeX.wabaId, f.X.id);
    assert.equal(routeX.wabaExternalId, f.X.externalId);
    assert.deepEqual(routeX.eligibleTemplateIds, [f.TX1.id], "among the SELECTED templates, only TX1 is eligible for the X phone");
    assert.equal(routeX.eligibilitySource, "backfill");
    assert.equal(routeX.eligibilityVerifiedAt, "2026-10-01T00:00:00.000Z");
    const summary = await getActivePlanSummary(f.org.id, campaign.id);
    assert.equal(summary!.routes.find((r) => r.phoneNumberId === f.PX.id)!.wabaExternalId, f.X.externalId);

    // Later configuration edits do not touch the frozen plan.
    await db.update(campaignRoutesTable).set({ configuredTps: 5, templateId: f.TX2.id }).where(and(eq(campaignRoutesTable.campaignId, campaign.id), eq(campaignRoutesTable.phoneNumberId, f.PX.id)));
    await db.update(wabasTable).set({ externalId: `${f.X.externalId}-renamed` }).where(eq(wabasTable.id, f.X.id));
    const [again] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, plan.id));
    assert.deepEqual(again.routes, plan.routes);

    const { queuedNew } = await executeCampaignPlan(f.org.id, campaign.id);
    assert.equal(queuedNew, 2);
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id)).orderBy(campaignJobsTable.id);
    const jobX = jobs.find((j) => j.routeId === routeX.routeId)!;
    assert.equal(jobX.templateId, f.TX1.id);
    assert.equal(jobX.planId, plan.id);
    await db.update(campaignJobsTable).set({ status: "Processing", lockedBy: "test", leaseToken: `${f.slug}-lease` }).where(eq(campaignJobsTable.id, jobX.id));
    const sender = new WhatsAppTemplateSender();
    const resolved = await resolveJobTemplate((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, jobX.id)))[0]);
    const prepared = await sender.prepareBatch([resolved], new AbortController().signal);
    const context = prepared.get(jobX.id) as { templateName: string; transportAuth: { kind: string; credentialId?: number } };
    assert.equal(context.templateName, "tx1", "the frozen template is sent although the live route now points at TX2");
    assert.equal(context.transportAuth.credentialId, f.credential!.id);

    // Provider status change after planning blocks preparation; the job is untouched.
    await db.update(templatesTable).set({ status: "Paused" }).where(eq(templatesTable.id, f.TX1.id));
    await db.update(templateEligibilityTable).set({ sendable: false, status: "Paused", providerStatus: "PAUSED" }).where(eq(templateEligibilityTable.templateId, f.TX1.id));
    await assert.rejects(sender.prepareBatch([resolved], new AbortController().signal), /approved|not_approved/);
    const [jobAfter] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, jobX.id));
    assert.equal(jobAfter.templateId, f.TX1.id);
    assert.equal(jobAfter.planId, plan.id);
    assert.equal(jobAfter.routeId, routeX.routeId);
    // Credential revoked after planning: blocked too, frozen evidence is not permission.
    await db.update(templatesTable).set({ status: "Approved" }).where(eq(templatesTable.id, f.TX1.id));
    await db.update(templateEligibilityTable).set({ sendable: true, status: "Approved", providerStatus: "APPROVED" }).where(eq(templateEligibilityTable.templateId, f.TX1.id));
    await revokeCredential(f.org.id, f.credential!.id);
    await assert.rejects(sender.prepareBatch([resolved], new AbortController().signal), /not connected|not active|credential/);

    // An older plan without the V2-04 fields: nothing inferred, live eligibility decides, summary shows nulls.
    const other = await fixture();
    try {
      const c2 = await other.campaign();
      await rocketSetup(other, c2.id, [{ phoneNumberId: other.PX.id, configuredTps: 10 }], [other.TX1.id]);
      await db.insert(campaignContactsTable).values({ organizationId: other.org.id, campaignId: c2.id, rowNumber: 1, rawPhone: "+15550000201", normalizedPhone: "+15550000201", status: "Valid", data: {}, idempotencyKey: `${other.slug}-c1` });
      const planned = await planCampaign(other.org.id, c2.id);
      const legacyRoutes = (planned.plan.routes as FrozenRoute[]).map(({ wabaId: _w, wabaExternalId: _e, eligibleTemplateIds: _t, eligibilityVerifiedAt: _v, eligibilitySource: _s, ...rest }) => rest);
      await db.update(campaignPlansTable).set({ routes: legacyRoutes }).where(eq(campaignPlansTable.id, planned.plan.id));
      const legacySummary = await getActivePlanSummary(other.org.id, c2.id);
      assert.equal(legacySummary!.routes[0].wabaExternalId, null);
      assert.deepEqual(legacySummary!.routes[0].eligibleTemplateIds, []);
      assert.equal(legacySummary!.routes[0].eligibilitySource, null);
      await executeCampaignPlan(other.org.id, c2.id);
      const [legacyJob] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, c2.id));
      await db.update(campaignJobsTable).set({ status: "Processing", lockedBy: "test", leaseToken: `${other.slug}-lease` }).where(eq(campaignJobsTable.id, legacyJob.id));
      const legacyResolved = await resolveJobTemplate((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, legacyJob.id)))[0]);
      assert.ok((await sender.prepareBatch([legacyResolved], new AbortController().signal)).has(legacyJob.id), "live-eligible: sends");
      await db.update(templatesTable).set({ status: "Removed", metadata: { source: "workspace_credential", providerMissing: true } }).where(eq(templatesTable.id, other.TX1.id));
      await assert.rejects(sender.prepareBatch([legacyResolved], new AbortController().signal), /approved|removed|Removed/);
    } finally { await other.cleanup(); }
  } finally { await f.cleanup(); }
});

test("sender preparation enforces WABA compatibility in mock mode too (legacy connector, local/mock exception) and a mismatch is refused before any send", async () => {
  const f = await fixture("legacy_mock");
  try {
    const campaign = await f.campaign();
    // Route written around the API with a cross-WABA pair.
    await db.insert(campaignTemplateSelectionsTable).values({ organizationId: f.org.id, campaignId: campaign.id, templateId: f.TX1.id });
    const [route] = await db.insert(campaignRoutesTable).values({ organizationId: f.org.id, campaignId: campaign.id, phoneNumberId: f.PY.id, templateId: f.TX1.id, configuredTps: 10 }).returning();
    const [contact] = await db.insert(campaignContactsTable).values({ organizationId: f.org.id, campaignId: campaign.id, rowNumber: 1, rawPhone: "+15550000301", normalizedPhone: "+15550000301", status: "Valid", data: {}, idempotencyKey: `${f.slug}-c1` }).returning();
    const [job] = await db.insert(campaignJobsTable).values({ organizationId: f.org.id, campaignId: campaign.id, routeId: route.id, contactId: contact.id, templateId: f.TX1.id, type: "ResolveTemplateAndSend", status: "Processing", lockedBy: "test", leaseToken: `${f.slug}-lease`, idempotencyKey: `${f.slug}-send` }).returning();
    const sender = new WhatsAppTemplateSender();
    const resolved = await resolveJobTemplate(job);
    await assert.rejects(sender.prepareBatch([resolved], new AbortController().signal), /waba_mismatch/);
    // Same-WABA pair in mock mode is accepted under the explicit exception.
    await db.update(campaignRoutesTable).set({ phoneNumberId: f.PX.id }).where(eq(campaignRoutesTable.id, route.id));
    const okResolved = await resolveJobTemplate((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, job.id)))[0]);
    assert.ok((await sender.prepareBatch([okResolved], new AbortController().signal)).has(job.id));
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------ UI (static)

test("UI static assertions (source-level, not a rendered DOM test): Rocket uses the compatibility endpoint keyed by selection and blocks invalid combinations before save; Number Center and Template Center show honest can-send / available-on; bounded requests", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = resolve(process.cwd(), "../wabista-nexus/src");
  const lib = readFileSync(resolve(root, "lib/compatibility.ts"), "utf8");
  const matrix = readFileSync(resolve(root, "components/campaigns/compatibility-matrix.tsx"), "utf8");
  const rocket = readFileSync(resolve(root, "pages/rocket-campaigns.tsx"), "utf8");
  const numbers = readFileSync(resolve(root, "pages/phone-numbers.tsx"), "utf8");
  const preview = readFileSync(resolve(root, "components/templates/template-preview-dialog.tsx"), "utf8");

  assert.match(lib, /COMPATIBILITY_MAX_IDS = 50/);
  assert.match(lib, /slice\(0, COMPATIBILITY_MAX_IDS\)/, "requests are bounded");
  assert.match(lib, /queryKey: compatibilityQueryKey\(organizationId, numbers, templates\)/, "responses are keyed by the exact selection and workspace, so stale ones are discarded");
  assert.doesNotMatch(lib, /keepPreviousData|placeholderData/, "no stale data is shown for a changed selection");
  assert.match(matrix, /isLoading/); assert.match(matrix, /isError/); assert.match(matrix, /Select numbers and templates to see/);
  assert.match(matrix, /compatibility-template-problem-/);
  assert.match(matrix, /The server still enforces it when you save/);
  assert.match(rocket, /useCompatibility\(organizationId, selectedNumberIds, form\.templateIds/);
  assert.match(rocket, /!compatibilityBlocks &&/, "save is disabled while the selection has an uncovered template or a stranded number");
  assert.match(rocket, /<CompatibilityMatrix/);
  assert.match(numbers, /useNumberCompatibility\(organizationId/);
  assert.match(numbers, /text-number-can-send-/);
  assert.match(numbers, /Couldn't check/);
  assert.match(preview, /template-available-on-/);
  assert.match(preview, /useCompatibility\(organizationId, \[\], \[template\.id\]\)/, "numbers derived server-side for one template");
  assert.doesNotMatch(rocket, /template\.wabaId === number\.wabaId|wabaId === phone\.wabaId/, "no client-side WABA rule; the server decides");
});
