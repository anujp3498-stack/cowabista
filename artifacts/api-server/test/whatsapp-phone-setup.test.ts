import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  phoneNumbersTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import type { FetchLike } from "../src/services/whatsapp-manual-client";
import {
  nextSetupStep,
  PhoneSetupError,
  registerPhone,
  requestVerificationCode,
  verifyCode,
} from "../src/services/whatsapp-phone-setup";
import whatsappManualRouter from "../src/routes/whatsapp-manual";

// V2-02B: verification + registration against a fake Meta Graph API. No
// request here ever leaves the process; the verification code and the
// registration PIN must never land in a row, a log line or a response.

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG${randomBytes(24).toString("hex")}`;
const WABA_ID = "100200300400500";
const PHONE_ID = "111222333444555";

interface Recorded { url: string; method: string; auth?: string; body?: Record<string, unknown> }

function fakeMeta(options: {
  recorded?: Recorded[];
  requestCodeStatus?: number;
  verifyStatus?: number;
  registerStatus?: number;
  registerBody?: unknown;
  verifyBody?: unknown;
  errorCode?: number;
  gate?: Promise<void>;
  gateOn?: string;
  onArrive?: () => void;
}): FetchLike {
  return async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    options.recorded?.push({ url, method: init.method ?? "GET", auth: headers?.Authorization, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (headers?.Authorization !== `Bearer ${TOKEN}`) {
      return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    }
    const path = new URL(url).pathname;
    if (options.gate && options.gateOn && path.endsWith(options.gateOn)) {
      options.onArrive?.();
      await options.gate;
    }
    const fail = (status: number) => json(status, { error: { message: "Provider refused", code: options.errorCode ?? 100 } });
    if (path.endsWith(`/${PHONE_ID}/request_code`)) {
      return options.requestCodeStatus && options.requestCodeStatus !== 200 ? fail(options.requestCodeStatus) : json(200, { success: true });
    }
    if (path.endsWith(`/${PHONE_ID}/verify_code`)) {
      if (options.verifyStatus && options.verifyStatus !== 200) return fail(options.verifyStatus);
      return json(200, options.verifyBody ?? { success: true });
    }
    if (path.endsWith(`/${PHONE_ID}/register`)) {
      if (options.registerStatus && options.registerStatus !== 200) return fail(options.registerStatus);
      return json(200, options.registerBody ?? { success: true });
    }
    return json(404, { error: { message: "Unknown edge", code: 100 } });
  };
}

async function fixture(options: {
  setupState?: string;
  status?: string;
  verificationStatus?: string;
  credentialStatus?: string;
  withCredential?: boolean;
  tpsLimit?: number;
} = {}) {
  const slug = `setup-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const enc = encryptCredential(TOKEN, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: org.id,
    tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(TOKEN), status: options.credentialStatus ?? "active", providerIdentity: "sys-user-1",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: org.id, externalId: WABA_ID, displayName: "Acme WABA", credentialId: credential.id,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: org.id, wabaId: waba.id, providerPhoneId: PHONE_ID, phone: "+15550000001", displayName: "Acme Support",
    status: options.status ?? "Pending", setupState: options.setupState ?? "discovered", tpsLimit: options.tpsLimit ?? 50,
    credentialId: options.withCredential === false ? null : credential.id,
    providerMetadata: { source: "manual", verificationStatus: options.verificationStatus ?? "NOT_VERIFIED", qualityRating: "GREEN" },
  }).returning();
  return { org, credential, waba, phone, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

async function reload(id: number) {
  const [row] = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.id, id));
  return row;
}

function assertNoSecrets(value: unknown, ...secrets: string[]) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), `secret must not appear: ${secret.slice(0, 3)}…`);
}

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("SMS request: correct Meta path/body, bearer from the stored credential, state becomes verification_code_sent", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const result = await requestVerificationCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, method: "SMS", fetchImpl: fakeMeta({ recorded }) });
    assert.equal(result.setupState, "verification_code_sent");
    assert.equal(result.applied, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].method, "POST");
    assert.ok(recorded[0].url.endsWith(`/v23.0/${PHONE_ID}/request_code`));
    assert.ok(!recorded[0].url.includes(TOKEN));
    assert.equal(recorded[0].auth, `Bearer ${TOKEN}`);
    assert.deepEqual(recorded[0].body, { code_method: "SMS", locale: "en_US" });
    const row = await reload(f.phone.id);
    assert.equal(row.setupState, "verification_code_sent");
    assert.equal(row.status, "Pending");
    assert.equal(row.setupError, null);
    assert.equal(row.providerMetadata.verificationMethod, "SMS");
    assert.ok(row.providerMetadata.verificationRequestedAt);
  } finally { await f.cleanup(); }
});

test("VOICE request sends code_method VOICE", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    await requestVerificationCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, method: "VOICE", locale: "en_GB", fetchImpl: fakeMeta({ recorded }) });
    assert.deepEqual(recorded[0].body, { code_method: "VOICE", locale: "en_GB" });
    assert.equal((await reload(f.phone.id)).providerMetadata.verificationMethod, "VOICE");
  } finally { await f.cleanup(); }
});

test("verify code: path/body correct, leading zero preserved, state becomes registration_required, code never persisted", async () => {
  const f = await fixture({ setupState: "verification_code_sent" });
  const recorded: Recorded[] = [];
  try {
    const result = await verifyCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, code: "012345", fetchImpl: fakeMeta({ recorded }) });
    assert.equal(result.setupState, "registration_required");
    assert.ok(recorded[0].url.endsWith(`/v23.0/${PHONE_ID}/verify_code`));
    assert.deepEqual(recorded[0].body, { code: "012345" });
    assert.equal(typeof recorded[0].body?.code, "string");
    const row = await reload(f.phone.id);
    assert.equal(row.setupState, "registration_required");
    assert.equal(row.status, "Pending");
    assert.equal(row.providerMetadata.verificationStatus, "VERIFIED");
    assertNoSecrets(row, "012345", TOKEN);
    assert.equal(nextSetupStep(row), "register");
  } finally { await f.cleanup(); }
});

test("wrong verification code: safe error, code not persisted, number stays retryable in code-entry state", async () => {
  const f = await fixture({ setupState: "verification_code_sent" });
  try {
    await assert.rejects(
      verifyCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, code: "999999", fetchImpl: fakeMeta({ verifyStatus: 400, errorCode: 136025 }) }),
      (error: unknown) => {
        assert.ok(error instanceof PhoneSetupError);
        assert.equal(error.code, "code_rejected");
        assert.equal(error.httpStatus, 400);
        assert.equal(error.message, "That verification code was not accepted. Check the code and try again.");
        assertNoSecrets({ m: error.message, d: error.details }, "999999", TOKEN, "Bearer");
        return true;
      },
    );
    const row = await reload(f.phone.id);
    assert.equal(row.setupState, "verification_code_sent", "still retryable");
    assert.ok(row.setupError && row.setupError.length > 0);
    assertNoSecrets(row, "999999", TOKEN);
    const [credential] = await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.id, f.credential.id));
    assert.equal(credential.status, "active", "a wrong code never invalidates the credential");
    // Retry succeeds.
    const ok = await verifyCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, code: "123456", fetchImpl: fakeMeta({}) });
    assert.equal(ok.setupState, "registration_required");
    assert.equal((await reload(f.phone.id)).setupError, null);
  } finally { await f.cleanup(); }
});

test("register: correct path, messaging_product whatsapp, 6-digit PIN kept as string; new manual phone stays Pending with registered_transport_pending", async () => {
  const f = await fixture({ setupState: "registration_required" });
  const recorded: Recorded[] = [];
  try {
    const result = await registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin: "012345", fetchImpl: fakeMeta({ recorded }) });
    assert.equal(result.setupState, "registered_transport_pending");
    assert.ok(recorded[0].url.endsWith(`/v23.0/${PHONE_ID}/register`));
    assert.deepEqual(recorded[0].body, { messaging_product: "whatsapp", pin: "012345" });
    assert.equal(typeof recorded[0].body?.pin, "string");
    const row = await reload(f.phone.id);
    assert.equal(row.status, "Pending", "registration never makes a manual number sendable");
    assert.equal(row.setupState, "registered_transport_pending");
    assert.equal(row.tpsLimit, 50, "no TPS change");
    assert.equal(row.providerMetadata.registrationStatus, "registered");
    assert.ok(row.providerMetadata.registeredAt);
    assertNoSecrets(row, "012345", TOKEN);
    assert.equal(nextSetupStep(row), "done");
  } finally { await f.cleanup(); }
});

test("PIN validation rejects 12345, 1234567, 12a456 and a number; accepts 012345; nothing reaches Meta on rejection", async () => {
  const f = await fixture({ setupState: "registration_required" });
  const recorded: Recorded[] = [];
  try {
    for (const pin of ["12345", "1234567", "12a456", 123456 as unknown as string, ""]) {
      await assert.rejects(
        registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin, fetchImpl: fakeMeta({ recorded }) }),
        (error: unknown) => error instanceof PhoneSetupError && error.code === "invalid_input" && error.httpStatus === 400,
      );
    }
    assert.equal(recorded.length, 0);
    const ok = await registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin: "012345", fetchImpl: fakeMeta({ recorded }) });
    assert.equal(ok.setupState, "registered_transport_pending");
  } finally { await f.cleanup(); }
});

test("already-VERIFIED provider number skips ownership verification and may register directly", async () => {
  const f = await fixture({ setupState: "discovered", verificationStatus: "VERIFIED" });
  const recorded: Recorded[] = [];
  try {
    assert.equal(nextSetupStep(f.phone), "register");
    await assert.rejects(
      requestVerificationCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, method: "SMS", fetchImpl: fakeMeta({ recorded }) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "state_conflict" && error.httpStatus === 409,
    );
    assert.equal(recorded.length, 0, "no code is requested for a verified number");
    const result = await registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin: "246810", fetchImpl: fakeMeta({ recorded }) });
    assert.equal(result.setupState, "registered_transport_pending");
    assert.equal(recorded.length, 1);
    assert.ok(recorded[0].url.endsWith("/register"));
  } finally { await f.cleanup(); }
});

test("registration gate: discovered + NOT_VERIFIED cannot register (409), and no Meta call happens", async () => {
  const f = await fixture({ setupState: "discovered" });
  const recorded: Recorded[] = [];
  try {
    await assert.rejects(
      registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin: "123456", fetchImpl: fakeMeta({ recorded }) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "state_conflict" && error.httpStatus === 409,
    );
    assert.equal(recorded.length, 0);
    assert.equal((await reload(f.phone.id)).setupState, "discovered");
  } finally { await f.cleanup(); }
});

test("legacy Connected phone keeps status Connected after manual registration", async () => {
  const f = await fixture({ setupState: "registration_required", status: "Connected", tpsLimit: 80 });
  try {
    const result = await registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin: "111111", fetchImpl: fakeMeta({}) });
    assert.equal(result.setupState, "registered_transport_pending");
    const row = await reload(f.phone.id);
    assert.equal(row.status, "Connected", "legacy readiness is not demoted");
    assert.equal(row.tpsLimit, 80);
  } finally { await f.cleanup(); }
});

test("revoked or missing credential blocks every step with a reconnect message and no Meta request", async () => {
  const revoked = await fixture({ setupState: "verification_code_sent", credentialStatus: "revoked" });
  const missing = await fixture({ setupState: "registration_required", withCredential: false });
  const recorded: Recorded[] = [];
  try {
    const expectReconnect = (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof PhoneSetupError);
      assert.equal(error.code, "credential_inactive");
      assert.equal(error.httpStatus, 409);
      assert.match(error.message, /Reconnect the number/);
      return true;
    });
    await expectReconnect(requestVerificationCode({ organizationId: revoked.org.id, phoneNumberId: revoked.phone.id, method: "SMS", fetchImpl: fakeMeta({ recorded }) }));
    await expectReconnect(verifyCode({ organizationId: revoked.org.id, phoneNumberId: revoked.phone.id, code: "123456", fetchImpl: fakeMeta({ recorded }) }));
    await expectReconnect(registerPhone({ organizationId: missing.org.id, phoneNumberId: missing.phone.id, pin: "123456", fetchImpl: fakeMeta({ recorded }) }));
    assert.equal(recorded.length, 0);
  } finally { await revoked.cleanup(); await missing.cleanup(); }
});

test("cross-tenant phone id is 404 with no Meta request, even with an active credential in the caller's workspace", async () => {
  const owner = await fixture({ setupState: "verification_code_sent" });
  const intruder = await fixture({ setupState: "discovered" });
  const recorded: Recorded[] = [];
  try {
    for (const attempt of [
      () => requestVerificationCode({ organizationId: intruder.org.id, phoneNumberId: owner.phone.id, method: "SMS", fetchImpl: fakeMeta({ recorded }) }),
      () => verifyCode({ organizationId: intruder.org.id, phoneNumberId: owner.phone.id, code: "123456", fetchImpl: fakeMeta({ recorded }) }),
      () => registerPhone({ organizationId: intruder.org.id, phoneNumberId: owner.phone.id, pin: "123456", fetchImpl: fakeMeta({ recorded }) }),
    ]) {
      await assert.rejects(attempt(), (error: unknown) => error instanceof PhoneSetupError && error.code === "phone_not_found" && error.httpStatus === 404);
    }
    assert.equal(recorded.length, 0);
    assert.equal((await reload(owner.phone.id)).setupState, "verification_code_sent");
  } finally { await owner.cleanup(); await intruder.cleanup(); }
});

test("routes: owner/admin guard chain on all three setup endpoints; responses never echo code or PIN", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (whatsappManualRouter as any).stack as any[];
  const paths = [
    "/organizations/:organizationId/whatsapp/numbers/:phoneNumberId/verification/request",
    "/organizations/:organizationId/whatsapp/numbers/:phoneNumberId/verification/verify",
    "/organizations/:organizationId/whatsapp/numbers/:phoneNumberId/register",
  ];
  for (const path of paths) {
    const layer = stack.find((l) => l.route?.path === path && l.route.methods.post);
    assert.ok(layer, `${path} registered`);
    const names = layer.route.stack.map((s: { name: string }) => s.name);
    assert.deepEqual(names.slice(0, 3), ["requireAuth", "attachOrgContext", "requireActiveOrganization"]);
    assert.equal(layer.route.stack.length, 5, "requireRole(admin) + handler");
  }
  // requireRole("admin") refuses manager and agent before the handler.
  const { requireRole } = await import("../src/middlewares/auth");
  for (const role of ["manager", "agent"]) {
    let nextCalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = { statusCode: 200 };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = () => res;
    requireRole("admin")({ role } as never, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, `${role} must not pass`);
    assert.equal(res.statusCode, 403);
  }

  const f = await fixture({ setupState: "registration_required" });
  try {
    const layer = stack.find((l) => l.route?.path === paths[2]);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    // Invalid PIN is rejected by the contract before the service runs; the
    // body never names the submitted value.
    await handler({ params: { organizationId: String(f.org.id), phoneNumberId: String(f.phone.id) }, body: { pin: "12a456" }, organizationId: f.org.id, role: "admin" }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "invalid_input");
    assertNoSecrets(res.body, "12a456", TOKEN);
    // Missing-verification path answers 409 through the route, with no secrets.
    const unverified = await fixture({ setupState: "discovered" });
    try {
      const res2: any = { statusCode: 200, body: undefined };
      res2.status = (code: number) => { res2.statusCode = code; return res2; };
      res2.json = (payload: unknown) => { res2.body = payload; return res2; };
      await handler({ params: { organizationId: String(unverified.org.id), phoneNumberId: String(unverified.phone.id) }, body: { pin: "123456" }, organizationId: unverified.org.id, role: "admin" }, res2);
      assert.equal(res2.statusCode, 409);
      assert.equal(res2.body.code, "state_conflict");
      assertNoSecrets(res2.body, "123456", TOKEN);
    } finally { await unverified.cleanup(); }
  } finally { await f.cleanup(); }
});

test("unexpected Meta success shape never advances local state", async () => {
  const f = await fixture({ setupState: "registration_required" });
  try {
    await assert.rejects(
      registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin: "123456", fetchImpl: fakeMeta({ registerBody: { ok: 1 } }) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "provider_unavailable",
    );
    let row = await reload(f.phone.id);
    assert.equal(row.setupState, "registration_required");
    assert.equal(row.providerMetadata.registrationStatus, undefined);
    const g = await fixture({ setupState: "verification_code_sent" });
    try {
      await assert.rejects(
        verifyCode({ organizationId: g.org.id, phoneNumberId: g.phone.id, code: "123456", fetchImpl: fakeMeta({ verifyBody: {} }) }),
        (error: unknown) => error instanceof PhoneSetupError && error.code === "provider_unavailable",
      );
      row = await reload(g.phone.id);
      assert.equal(row.setupState, "verification_code_sent");
      assert.notEqual(row.providerMetadata.verificationStatus, "VERIFIED");
    } finally { await g.cleanup(); }
  } finally { await f.cleanup(); }
});

test("transient Meta failure keeps the current state and records a retryable error; token-invalid moves to action_required", async () => {
  const f = await fixture({ setupState: "discovered" });
  try {
    await assert.rejects(
      requestVerificationCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, method: "SMS", fetchImpl: fakeMeta({ requestCodeStatus: 503 }) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "provider_unavailable" && error.httpStatus === 502,
    );
    let row = await reload(f.phone.id);
    assert.equal(row.setupState, "discovered");
    assert.ok(row.setupError);
    await assert.rejects(
      requestVerificationCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, method: "SMS", fetchImpl: fakeMeta({ requestCodeStatus: 401, errorCode: 190 }) }),
      (error: unknown) => error instanceof PhoneSetupError && error.code === "credential_inactive",
    );
    row = await reload(f.phone.id);
    assert.equal(row.setupState, "action_required");
    assertNoSecrets(row, TOKEN);
    const [credential] = await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.id, f.credential.id));
    assert.equal(credential.status, "active", "credential rows are not auto-invalidated here");
  } finally { await f.cleanup(); }
});

test("monotonic: a late request-code success cannot regress a number that already advanced", async () => {
  const f = await fixture({ setupState: "verification_code_sent" });
  try {
    // request_code's Meta call is held open until verify_code has fully
    // completed, so the slow request's persistence runs after the row is
    // already at registration_required.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let arrive!: () => void;
    const arrived = new Promise<void>((resolve) => { arrive = resolve; });
    const slow = requestVerificationCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, method: "SMS", fetchImpl: fakeMeta({ gate, gateOn: "/request_code", onArrive: arrive }) });
    await arrived; // the slow request has passed its pre-checks and is "at Meta"
    const verified = await verifyCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, code: "123456", fetchImpl: fakeMeta({}) });
    assert.equal(verified.setupState, "registration_required");
    release();
    const late = await slow;
    assert.equal(late.applied, false);
    assert.equal(late.setupState, "registration_required");
    assert.equal((await reload(f.phone.id)).setupState, "registration_required");

    // And after registration, a late verify success cannot regress either.
    let release2!: () => void;
    const gate2 = new Promise<void>((resolve) => { release2 = resolve; });
    let arrive2!: () => void;
    const arrived2 = new Promise<void>((resolve) => { arrive2 = resolve; });
    // Simulate a verify that reached Meta while the row still allowed it:
    // reset the row to code-entry, start verify, hold it at Meta, then
    // move the row forward through registration.
    await db.update(phoneNumbersTable).set({ setupState: "verification_code_sent" }).where(eq(phoneNumbersTable.id, f.phone.id));
    const slowVerify = verifyCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, code: "123456", fetchImpl: fakeMeta({ gate: gate2, gateOn: "/verify_code", onArrive: arrive2 }) });
    await arrived2;
    await db.update(phoneNumbersTable).set({ setupState: "registration_required" }).where(eq(phoneNumbersTable.id, f.phone.id));
    const registered = await registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin: "123456", fetchImpl: fakeMeta({}) });
    assert.equal(registered.setupState, "registered_transport_pending");
    release2();
    const lateVerify = await slowVerify;
    assert.equal(lateVerify.applied, false);
    assert.equal((await reload(f.phone.id)).setupState, "registered_transport_pending");
    assert.equal((await reload(f.phone.id)).providerMetadata.registrationStatus, "registered");
  } finally { await f.cleanup(); }
});

test("setup actions never create credential, WABA or phone rows", async () => {
  const f = await fixture({ setupState: "discovered" });
  try {
    await requestVerificationCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, method: "SMS", fetchImpl: fakeMeta({}) });
    await verifyCode({ organizationId: f.org.id, phoneNumberId: f.phone.id, code: "123456", fetchImpl: fakeMeta({}) });
    await registerPhone({ organizationId: f.org.id, phoneNumberId: f.phone.id, pin: "123456", fetchImpl: fakeMeta({}) });
    assert.equal((await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.organizationId, f.org.id))).length, 1);
    assert.equal((await db.select().from(wabasTable).where(eq(wabasTable.organizationId, f.org.id))).length, 1);
    assert.equal((await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, f.org.id))).length, 1);
  } finally { await f.cleanup(); }
});

test("UI static assertions: guided setup offers SMS and voice, masked 6-digit PIN with confirmation, no token field, no Ready-to-send", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = resolve(process.cwd(), "../wabista-nexus/src");
  const dialog = readFileSync(resolve(root, "components/numbers/complete-number-setup-dialog.tsx"), "utf8");
  const page = readFileSync(resolve(root, "pages/phone-numbers.tsx"), "utf8");
  const status = readFileSync(resolve(root, "lib/status.ts"), "utf8");

  assert.match(dialog, /Send SMS code/);
  assert.match(dialog, /Call me with code/);
  assert.match(dialog, /data-testid="input-verification-code"/);
  assert.match(dialog, /autoComplete="one-time-code"/);
  assert.match(dialog, /data-testid="input-registration-pin"[\s\S]*?type="password"/);
  assert.match(dialog, /data-testid="input-registration-pin-confirm"[\s\S]*?type="password"/);
  assert.match(dialog, /maxLength=\{6\}/);
  assert.match(dialog, /Wabista does not store it/);
  assert.match(dialog, /This is a 6-digit PIN you choose/);
  assert.match(dialog, /Enter the code Meta sent to this phone number/);
  assert.doesNotMatch(dialog, /accessToken|access token|input-connect-token/i, "no token entry inside setup");
  assert.doesNotMatch(dialog, /Ready to send/, "registration never claims readiness");
  assert.doesNotMatch(dialog, /localStorage|sessionStorage/);
  assert.doesNotMatch(dialog, /providerPhoneId|wabaExternalId/, "technical IDs stay out of the normal flow");
  assert.match(dialog, /sending activation/i);

  assert.match(page, /canConnect && needsSetup\(row\)/, "setup actions are gated to owner/admin on the client");
  assert.match(page, /Sending activation pending/);
  assert.match(status, /registered_transport_pending: \{ label: "Registered"/);
  assert.doesNotMatch(status, /registered_transport_pending: \{ label: "Connected"/);
});
