import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  phoneNumbersTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, decryptCredential } from "../src/services/credential-crypto";
import {
  connectManualNumber,
  ManualConnectError,
  revokeCredential,
  serializeCredential,
} from "../src/services/whatsapp-manual-connection";
import { ManualMetaClient } from "../src/services/whatsapp-manual-client";
import { providerClient, MockWhatsAppProviderClient, RealWhatsAppProviderClient } from "../src/services/whatsapp-provider";
import type { FetchLike } from "../src/services/whatsapp-manual-client";
import whatsappManualRouter from "../src/routes/whatsapp-manual";

// V2-02A manual number discovery against a fake Meta Graph API. Nothing here
// talks to the network: every fetch goes through the recorded fake below.

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG${randomBytes(24).toString("hex")}`;
const WABA_ID = "100200300400500";
const PHONE_ID = "111222333444555";

interface Recorded { url: string; auth?: string }

function fakeMeta(options: {
  identityStatus?: number;
  wabaStatus?: number;
  phones?: Array<{ id: string; display_phone_number: string; verified_name?: string; quality_rating?: string; code_verification_status?: string }>;
  recorded?: Recorded[];
  tokenEchoInError?: boolean;
}): FetchLike {
  return async (url, init) => {
    const headers = init.headers as Record<string, string>;
    options.recorded?.push({ url, auth: headers?.Authorization });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (headers?.Authorization !== `Bearer ${TOKEN}`) {
      return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    }
    const path = new URL(url).pathname;
    if (path.endsWith("/me")) {
      if (options.identityStatus && options.identityStatus !== 200) {
        return json(options.identityStatus, { error: { message: options.tokenEchoInError ? `bad ${TOKEN}` : "Invalid token", code: 190 } });
      }
      return json(200, { id: "sys-user-1", name: "Wabista System User" });
    }
    if (path.endsWith(`/${WABA_ID}`)) {
      if (options.wabaStatus && options.wabaStatus !== 200) {
        return json(options.wabaStatus, { error: { message: "Unsupported get request", code: 100 } });
      }
      return json(200, { id: WABA_ID, name: "Acme WABA" });
    }
    if (path.endsWith(`/${WABA_ID}/phone_numbers`)) {
      return json(200, { data: options.phones ?? [], paging: { cursors: {} } });
    }
    return json(404, { error: { message: "Unknown edge", code: 100 } });
  };
}

const goodPhones = [
  { id: PHONE_ID, display_phone_number: "+1 555-000-0001", verified_name: "Acme Support", quality_rating: "GREEN", code_verification_status: "NOT_VERIFIED" },
  { id: "999", display_phone_number: "+44 20 7946 0000", verified_name: "Other", quality_rating: "YELLOW", code_verification_status: "VERIFIED" },
];

async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  return organization;
}

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("discovers a phone, persists encrypted credential + WABA + phone, and keeps it non-sendable", async () => {
  const org = await createOrganization(`manual-ok-${process.pid}-${Date.now()}`);
  const recorded: Recorded[] = [];
  try {
    const result = await connectManualNumber({
      organizationId: org.id,
      phoneNumber: "1 (555) 000-0001",
      accessToken: TOKEN,
      wabaId: WABA_ID,
      fetchImpl: fakeMeta({ phones: goodPhones, recorded }),
    });
    assert.equal(result.outcome, "connected");
    if (result.outcome !== "connected") return;

    // Token only ever travelled in the Authorization header.
    assert.ok(recorded.length >= 3);
    for (const call of recorded) {
      assert.ok(!call.url.includes(TOKEN), "token must never be in a URL");
      assert.equal(call.auth, `Bearer ${TOKEN}`);
      assert.ok(call.url.startsWith("https://graph.facebook.com/v23.0/"));
    }

    // Credential: ciphertext only, decryptable only under this org's AAD.
    const [credential] = await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.id, result.credential.id));
    assert.equal(credential.organizationId, org.id);
    assert.equal(credential.status, "active");
    assert.equal(credential.providerIdentity, "sys-user-1");
    assert.notEqual(credential.tokenCiphertext, TOKEN);
    assert.ok(!JSON.stringify(credential).includes(TOKEN), "plaintext token must not be in the row");
    const enc = { ciphertext: credential.tokenCiphertext, iv: credential.tokenIv, authTag: credential.tokenAuthTag, keyVersion: credential.keyVersion };
    assert.equal(decryptCredential(enc, { organizationId: org.id, kind: "manual_token" }), TOKEN);
    assert.throws(() => decryptCredential(enc, { organizationId: org.id + 1, kind: "manual_token" }));

    // Public shape has no secret material.
    const publicShape = serializeCredential(credential);
    const serialized = JSON.stringify(publicShape);
    assert.ok(!serialized.includes(TOKEN));
    assert.ok(!serialized.includes(credential.tokenCiphertext));
    assert.ok(!serialized.includes(credential.tokenIv));
    assert.ok(!serialized.includes(credential.tokenAuthTag));
    assert.equal(publicShape.fingerprint.length, 8);

    // WABA and phone rows.
    assert.equal(result.waba.externalId, WABA_ID);
    assert.equal(result.waba.displayName, "Acme WABA");
    assert.equal(result.waba.credentialId, credential.id);
    const phone = result.phoneNumber;
    assert.equal(phone.phone, "+15550000001");
    assert.equal(phone.providerPhoneId, PHONE_ID);
    assert.equal(phone.displayName, "Acme Support");
    assert.equal(phone.wabaId, result.waba.id);
    assert.equal(phone.credentialId, credential.id);
    assert.equal(phone.status, "Pending", "discovered numbers are never Connected");
    assert.equal(phone.setupState, "discovered");
    assert.equal(phone.tpsLimit, 50, "no TPS cap is granted by discovery");
    assert.equal(phone.quality, "High");
    assert.equal(phone.providerMetadata.source, "manual");
    assert.equal(phone.providerMetadata.approvedTpsLimit, undefined);
    assert.equal(phone.isSample, false);

    // Only the requested number is persisted, not every number in the WABA.
    const rows = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, org.id));
    assert.equal(rows.length, 1);

    // Re-connecting with the same token reuses the credential row and is idempotent.
    const again = await connectManualNumber({
      organizationId: org.id, phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID,
      fetchImpl: fakeMeta({ phones: goodPhones }),
    });
    assert.equal(again.outcome, "connected");
    if (again.outcome !== "connected") return;
    assert.equal(again.credential.id, credential.id);
    assert.equal(again.phoneNumber.id, phone.id);
    const credentialRows = await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.organizationId, org.id));
    assert.equal(credentialRows.length, 1);

    // Revoke only flips status; it never deletes the phone row.
    const revoked = await revokeCredential(org.id, credential.id);
    assert.equal(revoked?.credential.status, "revoked");
    assert.deepEqual(revoked?.disabledPhoneIds, [], "a discovered-only phone was never sending with it");
    assert.equal(await revokeCredential(org.id + 100000, credential.id), null, "revoke is tenant scoped");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
  }
});

test("asks for the WABA ID when it is missing and persists nothing", async () => {
  const org = await createOrganization(`manual-waba-${process.pid}-${Date.now()}`);
  try {
    const result = await connectManualNumber({
      organizationId: org.id, phoneNumber: "+15550000001", accessToken: TOKEN,
      fetchImpl: fakeMeta({ phones: goodPhones }),
    });
    assert.equal(result.outcome, "waba_id_required");
    const credentials = await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.organizationId, org.id));
    assert.equal(credentials.length, 0);
    const phones = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, org.id));
    assert.equal(phones.length, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
  }
});

test("validation failures persist nothing and never leak the token", async () => {
  const org = await createOrganization(`manual-fail-${process.pid}-${Date.now()}`);
  try {
    const expectFailure = async (code: string, status: number, input: Parameters<typeof connectManualNumber>[0]) => {
      try {
        await connectManualNumber(input);
        assert.fail(`expected ${code}`);
      } catch (error) {
        assert.ok(error instanceof ManualConnectError, `expected ManualConnectError, got ${String(error)}`);
        assert.equal(error.code, code);
        assert.equal(error.httpStatus, status);
        assert.ok(!error.message.includes(TOKEN));
        assert.ok(!JSON.stringify(error.details ?? {}).includes(TOKEN));
      }
    };
    const base = { organizationId: org.id, phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID };
    await expectFailure("invalid_phone", 400, { ...base, phoneNumber: "abc", fetchImpl: fakeMeta({}) });
    await expectFailure("token_rejected", 400, { ...base, fetchImpl: fakeMeta({ identityStatus: 401, tokenEchoInError: true }) });
    await expectFailure("token_rejected", 400, { ...base, accessToken: "wrong-token", fetchImpl: fakeMeta({}) });
    await expectFailure("waba_denied", 400, { ...base, fetchImpl: fakeMeta({ wabaStatus: 403 }) });
    await expectFailure("phone_not_found", 404, { ...base, phoneNumber: "+15550009999", fetchImpl: fakeMeta({ phones: goodPhones }) });
    await expectFailure("provider_unavailable", 502, { ...base, fetchImpl: fakeMeta({ identityStatus: 503 }) });
    await expectFailure("provider_unavailable", 502, { ...base, fetchImpl: async () => { throw new Error(`socket hang up ${TOKEN}`); } });

    const credentials = await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.organizationId, org.id));
    assert.equal(credentials.length, 0);
    const phones = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, org.id));
    assert.equal(phones.length, 0);
    const wabas = await db.select().from(wabasTable).where(eq(wabasTable.organizationId, org.id));
    assert.equal(wabas.length, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
  }
});

test("fails closed with 503 when the encryption key is not configured -- before any network call", async () => {
  const org = await createOrganization(`manual-nokey-${process.pid}-${Date.now()}`);
  const saved = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  let calls = 0;
  try {
    await assert.rejects(
      connectManualNumber({
        organizationId: org.id, phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID,
        fetchImpl: async (...args) => { calls += 1; return fakeMeta({ phones: goodPhones })(...args); },
      }),
      (error: unknown) => error instanceof ManualConnectError && error.code === "encryption_unavailable" && error.httpStatus === 503,
    );
    assert.equal(calls, 0, "token must not be sent anywhere when it cannot be stored safely");
  } finally {
    process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = saved;
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
  }
});

test("a number or WABA claimed by another workspace is refused with 409 and no tenant leak", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const orgA = await createOrganization(`manual-claim-a-${stamp}`);
  const orgB = await createOrganization(`manual-claim-b-${stamp}`);
  try {
    const first = await connectManualNumber({
      organizationId: orgA.id, phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID,
      fetchImpl: fakeMeta({ phones: goodPhones }),
    });
    assert.equal(first.outcome, "connected");

    await assert.rejects(
      connectManualNumber({
        organizationId: orgB.id, phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID,
        fetchImpl: fakeMeta({ phones: goodPhones }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManualConnectError);
        assert.equal(error.code, "number_claimed");
        assert.equal(error.httpStatus, 409);
        assert.equal(error.message, "This WhatsApp number is already connected to another workspace.");
        assert.ok(!error.message.includes(String(orgA.id)) && !error.message.includes(orgA.slug));
        return true;
      },
    );
    // Same WABA, a different (unclaimed) number: the WABA itself is claimed.
    await assert.rejects(
      connectManualNumber({
        organizationId: orgB.id, phoneNumber: "+442079460000", accessToken: TOKEN, wabaId: WABA_ID,
        fetchImpl: fakeMeta({ phones: goodPhones }),
      }),
      (error: unknown) => error instanceof ManualConnectError && error.code === "waba_claimed" && error.httpStatus === 409,
    );
    const credentialsB = await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.organizationId, orgB.id));
    assert.equal(credentialsB.length, 0);
    const phonesB = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, orgB.id));
    assert.equal(phonesB.length, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.id));
  }
});

// Barrier: a fake fetch that lets every participant complete token and WABA
// lookups but holds the final phone-list response until `arrivals`
// requests have reached it. All Meta work is then done for everyone at the
// same instant, so the competing transactions enter persistence together
// and only the advisory locks decide the order. No sleeps.
function gatedMeta(arrivals: number, phones = goodPhones): FetchLike {
  const inner = fakeMeta({ phones });
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async (url, init) => {
    if (new URL(url).pathname.endsWith("/phone_numbers")) {
      waiting += 1;
      if (waiting >= arrivals) release();
      await gate;
    }
    return inner(url, init);
  };
}

test("concurrent cross-workspace claims of the same phone/WABA: exactly one wins, the other gets a safe 409", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const orgA = await createOrganization(`manual-race-a-${stamp}`);
  const orgB = await createOrganization(`manual-race-b-${stamp}`);
  const fetchImpl = gatedMeta(2);
  try {
    const attempt = (organizationId: number) =>
      connectManualNumber({ organizationId, phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID, fetchImpl });
    const settled = await Promise.allSettled([attempt(orgA.id), attempt(orgB.id)]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one workspace succeeds");
    assert.equal(rejected.length, 1, "exactly one workspace is refused");
    const error = rejected[0].reason;
    assert.ok(error instanceof ManualConnectError, String(error));
    assert.ok(error.code === "number_claimed" || error.code === "waba_claimed", error.code);
    assert.equal(error.httpStatus, 409);
    for (const org of [orgA, orgB]) {
      assert.ok(!error.message.includes(String(org.id)) && !error.message.includes(org.slug), "no tenant identity leaks");
    }
    assert.ok(!JSON.stringify(error.details ?? {}).includes(TOKEN));

    const phoneOwners = await db.select({ organizationId: phoneNumbersTable.organizationId }).from(phoneNumbersTable)
      .where(eq(phoneNumbersTable.providerPhoneId, PHONE_ID));
    const wabaOwners = await db.select({ organizationId: wabasTable.organizationId }).from(wabasTable)
      .where(eq(wabasTable.externalId, WABA_ID));
    assert.equal(phoneOwners.length, 1, "the provider phone is owned by exactly one workspace");
    assert.equal(wabaOwners.length, 1, "the WABA is owned by exactly one workspace");
    assert.equal(phoneOwners[0].organizationId, wabaOwners[0].organizationId);
    const loser = phoneOwners[0].organizationId === orgA.id ? orgB : orgA;
    const loserCredentials = await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.organizationId, loser.id));
    assert.equal(loserCredentials.length, 0, "the refused workspace persisted nothing");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.id));
  }
});

test("concurrent identical connects in one workspace are idempotent: one credential, one WABA, one phone", async () => {
  const org = await createOrganization(`manual-same-${process.pid}-${Date.now()}`);
  const fetchImpl = gatedMeta(3);
  try {
    const attempt = () =>
      connectManualNumber({ organizationId: org.id, phoneNumber: "+1 555 000 0001", accessToken: TOKEN, wabaId: WABA_ID, fetchImpl });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    for (const result of results) assert.equal(result.outcome, "connected");
    const credentialIds = new Set(results.map((r) => (r.outcome === "connected" ? r.credential.id : -1)));
    assert.equal(credentialIds.size, 1, "all requests resolved to the same credential row");

    const credentials = await db.select().from(whatsappCredentialsTable).where(and(
      eq(whatsappCredentialsTable.organizationId, org.id),
      eq(whatsappCredentialsTable.status, "active"),
    ));
    assert.equal(credentials.length, 1, "only one active credential row for the fingerprint");
    const phones = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, org.id));
    assert.equal(phones.length, 1);
    assert.equal(phones[0].status, "Pending");
    const wabas = await db.select().from(wabasTable).where(eq(wabasTable.organizationId, org.id));
    assert.equal(wabas.length, 1);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
  }
});

test("re-discovery does not demote a Connected number or reset its TPS cap", async () => {
  const org = await createOrganization(`manual-keep-${process.pid}-${Date.now()}`);
  try {
    const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: WABA_ID, displayName: "typed" }).returning();
    await db.insert(phoneNumbersTable).values({
      organizationId: org.id, wabaId: waba.id, providerPhoneId: PHONE_ID, phone: "+15550000001", displayName: "Legacy",
      status: "Connected", tpsLimit: 80, providerMetadata: { approvedTpsLimit: 80 },
    });
    const result = await connectManualNumber({
      organizationId: org.id, phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID,
      fetchImpl: fakeMeta({ phones: goodPhones }),
    });
    assert.equal(result.outcome, "connected");
    if (result.outcome !== "connected") return;
    assert.equal(result.phoneNumber.status, "Connected");
    assert.equal(result.phoneNumber.tpsLimit, 80);
    assert.equal(result.phoneNumber.setupState, "discovered");
    assert.equal(result.phoneNumber.credentialId, result.credential.id);
    assert.equal(result.waba.id, waba.id);
    assert.equal(result.waba.displayName, "Acme WABA");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
  }
});

test("route: owner/admin guard chain and error body shape, with no token in any response", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (whatsappManualRouter as any).stack.find((l: any) => l.route?.path === "/organizations/:organizationId/whatsapp/manual/connect");
  assert.ok(layer, "route registered");
  const names = layer.route.stack.map((s: { name: string }) => s.name);
  assert.deepEqual(names.slice(0, 3), ["requireAuth", "attachOrgContext", "requireActiveOrganization"]);
  assert.equal(layer.route.stack.length, 5, "requireRole + handler follow the three named guards");

  const org = await createOrganization(`manual-route-${process.pid}-${Date.now()}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = async (body: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    await handler({ params: { organizationId: String(org.id) }, body, organizationId: org.id, role: "admin" }, res);
    assert.ok(!JSON.stringify(res.body).includes(TOKEN), "token must never be echoed");
    return res;
  };
  try {
    // Both cases below are decided before any network call, so this test
    // never reaches Meta.
    const invalid = await call({ phoneNumber: "abc", accessToken: TOKEN, wabaId: WABA_ID });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, "invalid_phone");
    assert.equal(typeof invalid.body.error, "string");

    const missingBody = await call({ phoneNumber: "+15550000001" });
    assert.equal(missingBody.statusCode, 400);

    const saved = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    try {
      const noKey = await call({ phoneNumber: "+15550000001", accessToken: TOKEN, wabaId: WABA_ID });
      assert.equal(noKey.statusCode, 503);
      assert.equal(noKey.body.code, "encryption_unavailable");
    } finally {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = saved;
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
  }
});

test("legacy connector provider is untouched by the manual client", async () => {
  assert.ok(providerClient("mock") instanceof MockWhatsAppProviderClient);
  assert.ok(providerClient("real") instanceof RealWhatsAppProviderClient);
  const client = new ManualMetaClient({ accessToken: TOKEN, fetchImpl: fakeMeta({ phones: goodPhones }) });
  assert.ok(!("send" in client), "manual client must not expose a send method yet (V2-02C)");
  assert.throws(() => new ManualMetaClient({ accessToken: "" }));
});
