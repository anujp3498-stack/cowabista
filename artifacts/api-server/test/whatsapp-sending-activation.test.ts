import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateSelectionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import type { FetchLike } from "../src/services/whatsapp-manual-client";
import { connectManualNumber, revokeCredential } from "../src/services/whatsapp-manual-connection";
import { activateSending, PhoneSetupError } from "../src/services/whatsapp-phone-setup";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter } from "../src/services/campaign-queue";
import { validateCampaignReady } from "../src/services/campaign-preflight";
import { planCampaign } from "../src/services/campaign-planning";
import { ProviderRequestError } from "../src/services/whatsapp-provider";

// V2-02C control plane: explicit sending activation, revocation, and the
// fail-closed checks at planning, preparation and broker adoption. No
// request leaves the process: Meta is a fake fetch, and no campaign send
// ever happens here.

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-activate-${randomBytes(20).toString("hex")}`;
const OTHER_TOKEN = `EAAG-other-${randomBytes(20).toString("hex")}`;
const WABA_ID = "100200300400500";
const PHONE_ID = "111222333444555";

type Recorded = { url: string; method: string; auth?: string };

function fakeMeta(options: { recorded?: Recorded[]; phoneStatus?: number; phoneId?: string; token?: string } = {}): FetchLike {
  return async (url, init) => {
    const headers = init.headers as Record<string, string>;
    options.recorded?.push({ url, method: init.method ?? "GET", auth: headers?.Authorization });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (headers?.Authorization !== `Bearer ${options.token ?? TOKEN}`) return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    const path = new URL(url).pathname;
    if (path.endsWith("/me")) return json(200, { id: "sys-user-1", name: "System User" });
    if (path.endsWith(`/${WABA_ID}`)) return json(200, { id: WABA_ID, name: "Acme WABA" });
    if (path.endsWith(`/${WABA_ID}/phone_numbers`)) {
      return json(200, { data: [{ id: PHONE_ID, display_phone_number: "+1 555-000-0001", verified_name: "Acme", quality_rating: "GREEN", code_verification_status: "VERIFIED" }], paging: { cursors: {} } });
    }
    if (path.endsWith(`/${PHONE_ID}`)) {
      if (options.phoneStatus && options.phoneStatus !== 200) return json(options.phoneStatus, { error: { message: "Unsupported get request", code: 100 } });
      return json(200, { id: options.phoneId ?? PHONE_ID, display_phone_number: "+1 555-000-0001", verified_name: "Acme", quality_rating: "GREEN", code_verification_status: "VERIFIED" });
    }
    if (path.endsWith("/messages")) throw new Error("activation must never send a message");
    return json(404, { error: { message: "Unknown edge", code: 100 } });
  };
}

async function fixture(options: {
  setupState?: string;
  status?: string;
  withCredential?: boolean;
  credentialStatus?: string;
  wabaCredentialMatches?: boolean;
  providerPhoneId?: string | null;
  isSample?: boolean;
  token?: string;
} = {}) {
  const slug = `activate-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const token = options.token ?? TOKEN;
  const enc = encryptCredential(token, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: org.id,
    tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(token), status: options.credentialStatus ?? "active", providerIdentity: "sys-user-1",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: org.id, externalId: `${WABA_ID}-${slug}`, displayName: "Acme WABA",
    credentialId: options.wabaCredentialMatches === false ? null : credential.id,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: org.id, wabaId: waba.id, providerPhoneId: options.providerPhoneId === undefined ? `${PHONE_ID}-${slug}` : options.providerPhoneId,
    phone: `+1555${String(org.id).padStart(7, "0")}`, displayName: "Acme Support",
    status: options.status ?? "Pending", setupState: options.setupState ?? "registered_transport_pending", tpsLimit: 50,
    credentialId: options.withCredential === false ? null : credential.id, isSample: options.isSample ?? false,
    providerMetadata: { source: "manual", verificationStatus: "VERIFIED", registrationStatus: "registered" },
  }).returning();
  return { org, credential, waba, phone, slug, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

async function reload(id: number) {
  const [row] = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.id, id));
  return row;
}

// Fake fetch that answers the fixture's own provider phone id.
function metaFor(f: Awaited<ReturnType<typeof fixture>>, options: Parameters<typeof fakeMeta>[0] = {}): FetchLike {
  const inner = fakeMeta({ ...options, phoneId: options.phoneId ?? f.phone.providerPhoneId ?? undefined });
  return (url, init) => inner(url.replace(f.phone.providerPhoneId ?? "", PHONE_ID), init);
}

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("activation: registered + active credential + matching WABA -> Connected / active / sendingCredentialId, with a read-only provider check", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const result = await activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f, { recorded }) });
    assert.equal(result.setupState, "active");
    assert.equal(result.applied, true);
    assert.equal(recorded.length, 1, "exactly one provider read");
    assert.equal(recorded[0]!.method, "GET");
    // metaFor() maps the fixture's provider id onto the fake server's; the
    // request is a plain phone read with the discovery field list.
    assert.ok(recorded[0]!.url.endsWith(`/v23.0/${PHONE_ID}?fields=id%2Cdisplay_phone_number%2Cverified_name%2Cquality_rating%2Ccode_verification_status`), recorded[0]!.url);
    assert.ok(!recorded[0]!.url.includes(TOKEN));
    assert.equal(recorded[0]!.auth, `Bearer ${TOKEN}`);
    const row = await reload(f.phone.id);
    assert.equal(row.status, "Connected");
    assert.equal(row.setupState, "active");
    assert.equal(row.sendingCredentialId, f.credential.id);
    assert.equal(row.setupError, null);
    assert.equal(row.tpsLimit, 50);
    assert.ok(!JSON.stringify(row).includes(TOKEN));
    // Idempotent re-activation.
    const again = await activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f) });
    assert.equal(again.setupState, "active");
    assert.equal((await reload(f.phone.id)).sendingCredentialId, f.credential.id);
  } finally { await f.cleanup(); }
});

test("activation refuses every unsafe precondition before any provider call and never marks Connected", async () => {
  const cases: Array<{ name: string; options: Parameters<typeof fixture>[0]; code: string; meta?: Parameters<typeof fakeMeta>[0] }> = [
    { name: "discovered", options: { setupState: "discovered" }, code: "state_conflict" },
    { name: "verification_code_sent", options: { setupState: "verification_code_sent" }, code: "state_conflict" },
    { name: "registration_required", options: { setupState: "registration_required" }, code: "state_conflict" },
    { name: "sample", options: { isSample: true }, code: "phone_not_eligible" },
    { name: "revoked credential", options: { credentialStatus: "revoked" }, code: "credential_inactive" },
    { name: "missing credential", options: { withCredential: false }, code: "credential_inactive" },
    { name: "missing providerPhoneId", options: { providerPhoneId: null }, code: "phone_not_eligible" },
    { name: "WABA linked to another credential", options: { wabaCredentialMatches: false }, code: "credential_inactive" },
  ];
  for (const item of cases) {
    const f = await fixture(item.options);
    const recorded: Recorded[] = [];
    try {
      await assert.rejects(
        activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f, { recorded }) }),
        (error: unknown) => error instanceof PhoneSetupError && error.code === item.code,
        item.name,
      );
      assert.equal(recorded.length, 0, `${item.name}: no provider call`);
      const row = await reload(f.phone.id);
      assert.notEqual(row.status, "Connected", item.name);
      assert.equal(row.sendingCredentialId, null, item.name);
    } finally { await f.cleanup(); }
  }
  // Provider denies access: stays registered, not Connected.
  const denied = await fixture();
  try {
    await assert.rejects(
      activateSending({ organizationId: denied.org.id, phoneNumberId: denied.phone.id, fetchImpl: metaFor(denied, { phoneStatus: 403 }) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "activation_rejected",
    );
    const row = await reload(denied.phone.id);
    assert.equal(row.status, "Pending");
    assert.equal(row.setupState, "registered_transport_pending");
    assert.equal(row.sendingCredentialId, null);
    assert.ok(row.setupError);
  } finally { await denied.cleanup(); }
  // Encryption key missing: fails closed with 503, nothing changes.
  const noKey = await fixture();
  const saved = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  try {
    await assert.rejects(
      activateSending({ organizationId: noKey.org.id, phoneNumberId: noKey.phone.id, fetchImpl: metaFor(noKey) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "encryption_unavailable",
    );
    assert.equal((await reload(noKey.phone.id)).status, "Pending");
  } finally {
    process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = saved;
    await noKey.cleanup();
  }
});

test("cross-tenant: a phone can never be activated with, or onto, another workspace's credential", async () => {
  const a = await fixture();
  const b = await fixture({ token: OTHER_TOKEN });
  try {
    // Org B addressing org A's phone: not found, no provider call.
    const recorded: Recorded[] = [];
    await assert.rejects(
      activateSending({ organizationId: b.org.id, phoneNumberId: a.phone.id, fetchImpl: metaFor(a, { recorded }) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "phone_not_found",
    );
    assert.equal(recorded.length, 0);
    // Org A's phone pointed (by a corrupt association) at org B's credential: refused.
    await db.update(phoneNumbersTable).set({ credentialId: b.credential.id }).where(eq(phoneNumbersTable.id, a.phone.id));
    await assert.rejects(
      activateSending({ organizationId: a.org.id, phoneNumberId: a.phone.id, fetchImpl: metaFor(a, { recorded }) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "credential_inactive",
    );
    assert.equal(recorded.length, 0);
    assert.equal((await reload(a.phone.id)).sendingCredentialId, null);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test("revocation disables only phones that SEND with the credential; a legacy Connected phone merely discovered by it is untouched", async () => {
  const f = await fixture();
  try {
    await activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f) });
    const [legacy] = await db.insert(phoneNumbersTable).values({
      organizationId: f.org.id, wabaId: f.waba.id, providerPhoneId: `legacy-${f.slug}`, phone: "+15550000002", displayName: "Legacy",
      status: "Connected", setupState: "discovered", credentialId: f.credential.id, sendingCredentialId: null, tpsLimit: 80,
    }).returning();

    const revoked = await revokeCredential(f.org.id, f.credential.id);
    assert.equal(revoked?.credential.status, "revoked");
    assert.deepEqual(revoked?.disabledPhoneIds, [f.phone.id]);

    const manual = await reload(f.phone.id);
    assert.equal(manual.status, "Pending");
    assert.equal(manual.setupState, "action_required");
    assert.equal(manual.sendingCredentialId, null);
    assert.match(manual.setupError ?? "", /Reconnect the number/);

    const kept = await reload(legacy.id);
    assert.equal(kept.status, "Connected", "legacy connector phone is not demoted");
    assert.equal(kept.setupState, "discovered");
    assert.equal(kept.tpsLimit, 80);

    // Activation is impossible again until a new credential is connected.
    await assert.rejects(
      activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "credential_inactive",
    );
    // Revoke is tenant scoped.
    assert.equal(await revokeCredential(f.org.id + 100000, f.credential.id), null);
  } finally { await f.cleanup(); }
});

test("reconnecting with a different credential restarts setup and disables sending; the same credential changes nothing", async () => {
  const f = await fixture();
  try {
    await activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f) });
    // Point the WABA external id at what the fake Meta reports so discovery matches.
    await db.update(wabasTable).set({ externalId: WABA_ID }).where(eq(wabasTable.id, f.waba.id));
    await db.update(phoneNumbersTable).set({ providerPhoneId: PHONE_ID }).where(eq(phoneNumbersTable.id, f.phone.id));

    // Same token -> same credential row: active sending is left exactly as is.
    const same = await connectManualNumber({ organizationId: f.org.id, phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID, fetchImpl: fakeMeta({}) });
    assert.equal(same.outcome, "connected");
    if (same.outcome !== "connected") return;
    assert.equal(same.credential.id, f.credential.id);
    assert.equal(same.phoneNumber.status, "Connected");
    assert.equal(same.phoneNumber.setupState, "active");
    assert.equal(same.phoneNumber.sendingCredentialId, f.credential.id);

    // Different token -> new credential: sending is disabled until registered and activated again.
    const other = await connectManualNumber({ organizationId: f.org.id, phoneNumber: "+15550000001", accessToken: OTHER_TOKEN, wabaId: WABA_ID, fetchImpl: fakeMeta({ token: OTHER_TOKEN }) });
    assert.equal(other.outcome, "connected");
    if (other.outcome !== "connected") return;
    assert.notEqual(other.credential.id, f.credential.id);
    assert.equal(other.phoneNumber.status, "Pending", "discovery never restores Connected");
    assert.equal(other.phoneNumber.setupState, "discovered");
    assert.equal(other.phoneNumber.sendingCredentialId, null);
    assert.equal(other.phoneNumber.credentialId, other.credential.id);
  } finally { await f.cleanup(); }
});

// ---- planning / preparation / adoption ---------------------------------

async function campaignFixture(f: Awaited<ReturnType<typeof fixture>>, options: { templateWabaId?: number | null } = {}) {
  const [template] = await db.insert(templatesTable).values({
    organizationId: f.org.id, wabaId: options.templateWabaId === undefined ? f.waba.id : options.templateWabaId,
    name: "activation-template", status: "Approved", language: "en_US", body: "Hello there",
    components: [{ type: "BODY", text: "Hello there" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: f.org.id, name: f.slug, status: "Draft" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: f.org.id, campaignId: campaign.id, phoneNumberId: f.phone.id, templateId: template.id, configuredTps: 10,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: f.org.id, campaignId: campaign.id, templateId: template.id });
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId: f.org.id, campaignId: campaign.id, rowNumber: 1, rawPhone: "+15559990001", normalizedPhone: "+15559990001",
    status: "Valid", data: {}, idempotencyKey: `${f.slug}-contact`,
  }).returning();
  return { template, campaign, route, contact };
}

async function claimedJob(f: Awaited<ReturnType<typeof fixture>>, c: Awaited<ReturnType<typeof campaignFixture>>, planId: number | null, suffix = "") {
  const [job] = await db.insert(campaignJobsTable).values({
    organizationId: f.org.id, campaignId: c.campaign.id, routeId: c.route.id, contactId: c.contact.id, templateId: c.template.id,
    planId, type: "ResolveTemplateAndSend", status: "Processing", lockedBy: "test-worker",
    leaseToken: `${f.slug}-lease${suffix}`, leaseExpiresAt: new Date(Date.now() + 60_000), idempotencyKey: `${f.slug}-send${suffix}`,
    payload: { resolvedParameters: {} },
  }).returning();
  return job;
}

test("planning freezes the sending credential (never a token); readiness fails closed on an inactive sending credential", async () => {
  const f = await fixture();
  try {
    await activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f) });
    const c = await campaignFixture(f);
    assert.deepEqual(await validateCampaignReady(f.org.id, c.campaign.id), []);
    const { plan } = await planCampaign(f.org.id, c.campaign.id);
    assert.equal(plan.routes[0]!.sendingCredentialId, f.credential.id);
    assert.ok(!JSON.stringify(plan).includes(TOKEN));
    const [stored] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, plan.id));
    assert.equal(stored.routes[0]!.sendingCredentialId, f.credential.id);
    assert.ok(!JSON.stringify(stored).includes(TOKEN));

    await db.update(whatsappCredentialsTable).set({ status: "revoked" }).where(eq(whatsappCredentialsTable.id, f.credential.id));
    const errors = await validateCampaignReady(f.org.id, c.campaign.id);
    assert.ok(errors.some((error) => /sending credential is not active/.test(error)), errors.join("; "));
  } finally { await f.cleanup(); }
});

test("preparation: a workspace-credential route yields a token-free transport reference; WABA mismatch and frozen-credential drift fail before any HTTP", async () => {
  const f = await fixture();
  const sender = new WhatsAppTemplateSender();
  try {
    await activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f) });
    const c = await campaignFixture(f);
    const { plan } = await planCampaign(f.org.id, c.campaign.id);
    await db.update(campaignsTable).set({ status: "Running" }).where(eq(campaignsTable.id, c.campaign.id));
    const job = await claimedJob(f, c, plan.id);

    const contexts = await sender.prepareBatch([job]);
    const context = contexts.get(job.id) as { transportAuth: unknown; providerPhoneId: string };
    assert.deepEqual(context.transportAuth, { kind: "workspace_credential", organizationId: f.org.id, credentialId: f.credential.id, credentialRevision: 1 });
    assert.ok(!JSON.stringify(context).includes(TOKEN), "prepared context (what the broker publishes) carries no token");
    const transport = sender.serializePreparedTransport(job, context)!;
    assert.equal(transport.kind, "whatsapp");
    if (transport.kind === "whatsapp") {
      assert.deepEqual(transport.auth, context.transportAuth);
      assert.equal(transport.providerPhoneId, f.phone.providerPhoneId);
    }
    assert.ok(!JSON.stringify(transport).includes(TOKEN));
    await sender.revokePrepared(context, new Error("test cleanup"));

    // Adoption re-validation accepts it while everything still matches…
    const worker = new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), "activation-test", 30_000);
    try {
      const fresh = await worker.validatePreparedBrokerEnvelopes([{ job, preparedContext: context }]);
      assert.equal(fresh.valid.length, 1);
      // …and rejects it once the credential is revoked (phone demoted in the same transaction).
      await revokeCredential(f.org.id, f.credential.id);
      const afterRevoke = await worker.validatePreparedBrokerEnvelopes([{ job, preparedContext: context }]);
      assert.equal(afterRevoke.valid.length, 0);
      assert.equal(afterRevoke.stale.length, 1);
    } finally {
      await worker.closeDispatchScheduler();
    }

    // Frozen credential A, phone re-activated onto credential B: no silent switch.
    const encB = encryptCredential(OTHER_TOKEN, { organizationId: f.org.id, kind: "manual_token", provider: "whatsapp-business" });
    const [credentialB] = await db.insert(whatsappCredentialsTable).values({
      organizationId: f.org.id, tokenCiphertext: encB.ciphertext, tokenIv: encB.iv, tokenAuthTag: encB.authTag, keyVersion: encB.keyVersion,
      tokenFingerprint: credentialFingerprint(OTHER_TOKEN), status: "active",
    }).returning();
    await db.update(wabasTable).set({ credentialId: credentialB.id }).where(eq(wabasTable.id, f.waba.id));
    await db.update(phoneNumbersTable).set({ status: "Connected", setupState: "active", credentialId: credentialB.id, sendingCredentialId: credentialB.id }).where(eq(phoneNumbersTable.id, f.phone.id));
    const driftedJob = await claimedJob(f, c, plan.id, "-drift");
    await assert.rejects(
      sender.prepareBatch([driftedJob]),
      (error: unknown) => error instanceof ProviderRequestError && !error.retryable && /changed after planning; re-plan/.test(error.message),
    );
  } finally { await f.cleanup(); }
});

test("preparation rejects a template on a different WABA than the phone, and a phone whose WABA is not linked to its sending credential", async () => {
  const f = await fixture();
  const sender = new WhatsAppTemplateSender();
  try {
    await activateSending({ organizationId: f.org.id, phoneNumberId: f.phone.id, fetchImpl: metaFor(f) });
    const [otherWaba] = await db.insert(wabasTable).values({ organizationId: f.org.id, externalId: `other-${f.slug}`, displayName: "Other" }).returning();
    const c = await campaignFixture(f, { templateWabaId: otherWaba.id });
    const job = await claimedJob(f, c, null);
    await assert.rejects(
      sender.prepareBatch([job]),
      (error: unknown) => error instanceof ProviderRequestError && /same WhatsApp Business Account/.test(error.message),
    );
    // Fix the template, break the WABA/credential association instead.
    await db.update(templatesTable).set({ wabaId: f.waba.id }).where(eq(templatesTable.id, c.template.id));
    await db.update(wabasTable).set({ credentialId: null }).where(eq(wabasTable.id, f.waba.id));
    const job2 = await claimedJob(f, c, null, "-waba");
    await assert.rejects(
      sender.prepareBatch([job2]),
      (error: unknown) => error instanceof ProviderRequestError && /not associated with its sending credential/.test(error.message),
    );
  } finally { await f.cleanup(); }
});

test("cross-tenant at preparation: a phone pointed at another workspace's credential is refused", async () => {
  const a = await fixture();
  const b = await fixture({ token: OTHER_TOKEN });
  const sender = new WhatsAppTemplateSender();
  try {
    await activateSending({ organizationId: a.org.id, phoneNumberId: a.phone.id, fetchImpl: metaFor(a) });
    const c = await campaignFixture(a);
    await db.update(phoneNumbersTable).set({ sendingCredentialId: b.credential.id }).where(eq(phoneNumbersTable.id, a.phone.id));
    await db.update(wabasTable).set({ credentialId: b.credential.id }).where(eq(wabasTable.id, a.waba.id));
    const job = await claimedJob(a, c, null);
    await assert.rejects(
      sender.prepareBatch([job]),
      (error: unknown) => error instanceof ProviderRequestError && /sending credential is not active for this phone/.test(error.message),
    );
  } finally { await a.cleanup(); await b.cleanup(); }
});

test("legacy connector route: preparation yields legacy_connector auth and needs no credential at all", async () => {
  const f = await fixture({ status: "Connected", setupState: "unknown", withCredential: false });
  const sender = new WhatsAppTemplateSender();
  try {
    await db.update(wabasTable).set({ credentialId: null }).where(eq(wabasTable.id, f.waba.id));
    await db.delete(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.id, f.credential.id));
    const c = await campaignFixture(f);
    const job = await claimedJob(f, c, null);
    const contexts = await sender.prepareBatch([job]);
    const context = contexts.get(job.id) as { transportAuth: unknown };
    assert.deepEqual(context.transportAuth, { kind: "legacy_connector" });
    const transport = sender.serializePreparedTransport(job, context)!;
    assert.equal(transport.kind, "whatsapp");
    if (transport.kind === "whatsapp") assert.equal(transport.auth, undefined, "legacy payload shape is unchanged");
    await sender.revokePrepared(context, new Error("test cleanup"));
  } finally { await f.cleanup(); }
});
