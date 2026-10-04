// V2-04 acceptance correction: eligibility initialization is a prerequisite
// for consuming campaign work. These tests drive the SAME orchestrator the
// production entry point (src/index.ts) builds, with controllable barriers,
// and one upgrade-shaped database scenario against the real backfill and
// the real sender preparation.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignRoutesTable,
  campaignTemplateSelectionsTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  providerConnectionsTable,
  templateEligibilityTable,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import { createStartupOrchestrator, getStartupState, registerStartupOrchestrator } from "../src/services/startup";
import { backfillTemplateEligibility } from "../src/services/template-eligibility";
import { resolveJobTemplate } from "../src/services/template-resolution";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import healthRouter from "../src/routes/health";

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-startup-${randomBytes(20).toString("hex")}`;
const quiet = { info: () => undefined, error: () => undefined };

function gate() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  return { promise, release, fail };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handler(router: any, path: string) {
  for (const layer of router.stack) if (layer.route?.path === path) return layer.route.stack[layer.route.stack.length - 1].handle;
  throw new Error(`no handler ${path}`);
}
function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  const { pool, settlementPool } = await import("@workspace/db");
  await Promise.all([pool.end(), settlementPool.end()]);
});

test("1. backfill pending: the runtime has not started and readiness is 503 'initializing'", async () => {
  const init = gate();
  let started = 0;
  const orchestrator = createStartupOrchestrator({ initialize: () => init.promise, startRuntime: () => { started += 1; }, stopRuntime: async () => undefined, logger: quiet });
  registerStartupOrchestrator(orchestrator);
  const settled = orchestrator.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, 0, "no consumption before initialization completes");
  assert.equal(orchestrator.state().phase, "initializing");
  const res = fakeResponse();
  await handler(healthRouter, "/readyz")({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, "not_ready");
  assert.equal(res.body.initialization.phase, "initializing");
  const live = fakeResponse();
  await handler(healthRouter, "/healthz")({}, live);
  assert.equal(live.statusCode, 200, "liveness is unaffected by initialization");
  assert.equal(live.body.initialization.phase, "initializing");
  init.release();
  await settled;
});

test("2. backfill successful: the runtime starts exactly once, after initialization, and readiness becomes 200", async () => {
  const order: string[] = [];
  const orchestrator = createStartupOrchestrator({
    initialize: async () => { order.push("init"); return { ok: true }; },
    startRuntime: () => { order.push("runtime"); },
    stopRuntime: async () => { order.push("stop"); },
    logger: quiet,
  });
  registerStartupOrchestrator(orchestrator);
  const [a, b] = await Promise.all([orchestrator.start(), orchestrator.start()]);
  assert.deepEqual(order, ["init", "runtime"], "initialization strictly precedes the runtime; a second start() call does not start it again");
  assert.equal(a.phase, "ready"); assert.equal(b.phase, "ready");
  assert.equal(getStartupState().runtimeStarted, true);
  const res = fakeResponse();
  await handler(healthRouter, "/readyz")({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "ready");
  await orchestrator.shutdown();
  assert.deepEqual(order, ["init", "runtime", "stop"]);
  assert.equal(orchestrator.state().phase, "stopped");
});

test("3. backfill failed: the runtime never starts, the failure callback fires, readiness reports the failure", async () => {
  let started = 0;
  let failedWith: unknown;
  const orchestrator = createStartupOrchestrator({
    initialize: async () => { throw new Error("relation template_eligibility does not exist"); },
    startRuntime: () => { started += 1; },
    stopRuntime: async () => undefined,
    logger: quiet,
    onInitializationFailed: (error) => { failedWith = error; },
  });
  registerStartupOrchestrator(orchestrator);
  const state = await orchestrator.start();
  assert.equal(state.phase, "failed");
  assert.match(state.error!, /template_eligibility/);
  assert.equal(started, 0);
  assert.ok(failedWith instanceof Error);
  const res = fakeResponse();
  await handler(healthRouter, "/readyz")({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.initialization.phase, "failed");
  assert.match(res.body.initialization.error, /template_eligibility/);
  await orchestrator.shutdown();
  assert.equal(started, 0, "shutdown after a failed initialization still never starts the runtime");
  assert.equal(orchestrator.state().phase, "failed");
});

test("4. shutdown during backfill: no runtime start afterwards, shutdown waits for initialization to settle", async () => {
  const init = gate();
  let started = 0;
  let stopped = 0;
  const orchestrator = createStartupOrchestrator({ initialize: () => init.promise, startRuntime: () => { started += 1; }, stopRuntime: async () => { stopped += 1; }, logger: quiet });
  const startSettled = orchestrator.start();
  let shutdownDone = false;
  const shutdown = orchestrator.shutdown().then(() => { shutdownDone = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(shutdownDone, false, "shutdown waits for the in-flight initialization");
  init.release();
  await shutdown;
  const state = await startSettled;
  assert.equal(started, 0, "a backfill resolving after a shutdown request must not start the runtime");
  assert.equal(stopped, 0, "nothing to stop");
  assert.equal(state.phase, "stopped");
});

test("5. upgrade-shaped database: provider-backed template with queued work and no evidence rows; initialization completes before any job can be prepared, so nothing is rejected as evidence_missing", async () => {
  const slug = `startup-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  try {
    const enc = encryptCredential(TOKEN, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
    const [credential] = await db.insert(whatsappCredentialsTable).values({ organizationId: org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion, tokenFingerprint: credentialFingerprint(TOKEN), status: "active" }).returning();
    const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `${slug}-waba`, displayName: "WABA", credentialId: credential.id }).returning();
    await db.insert(providerConnectionsTable).values({ organizationId: org.id, provider: "whatsapp-business", mode: "mock", status: "configured" });
    const [phone] = await db.insert(phoneNumbersTable).values({ organizationId: org.id, wabaId: waba.id, phone: "+15550009001", providerPhoneId: `${slug}-pn`, displayName: "P", status: "Connected", setupState: "active", tpsLimit: 80, sendingCredentialId: credential.id, credentialId: credential.id }).returning();
    // A template synced BEFORE V2-04 existed: provider id, no evidence row.
    const [template] = await db.insert(templatesTable).values({ organizationId: org.id, wabaId: waba.id, providerTemplateId: `${slug}-tpl`, name: "legacy_synced", language: "en_US", category: "Marketing", status: "Approved", body: "Hi", components: [{ type: "BODY", text: "Hi" }], metadata: { source: "workspace_credential", providerStatus: "APPROVED" }, lastSyncedAt: new Date() }).returning();
    const [campaign] = await db.insert(campaignsTable).values({ organizationId: org.id, name: slug, status: "Running" }).returning();
    await db.insert(campaignTemplateSelectionsTable).values({ organizationId: org.id, campaignId: campaign.id, templateId: template.id });
    const [route] = await db.insert(campaignRoutesTable).values({ organizationId: org.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 10, wabaId: waba.id }).returning();
    const [contact] = await db.insert(campaignContactsTable).values({ organizationId: org.id, campaignId: campaign.id, rowNumber: 1, rawPhone: "+15550009101", normalizedPhone: "+15550009101", status: "Valid", data: {}, idempotencyKey: `${slug}-c1` }).returning();
    const [job] = await db.insert(campaignJobsTable).values({ organizationId: org.id, campaignId: campaign.id, routeId: route.id, contactId: contact.id, templateId: template.id, type: "ResolveTemplateAndSend", status: "Processing", lockedBy: "test", leaseToken: `${slug}-lease`, idempotencyKey: `${slug}-send` }).returning();
    assert.equal((await db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.organizationId, org.id))).length, 0, "upgrade shape: no evidence yet");

    // Without initialization the sender (unchanged) refuses the job: this is
    // exactly what sequencing must prevent from being observable.
    const sender = new WhatsAppTemplateSender();
    const resolved = await resolveJobTemplate(job);
    await assert.rejects(sender.prepareBatch([resolved], new AbortController().signal), /evidence_missing/);

    // Real wiring: initialize = the real backfill; "runtime" = a consumer
    // that prepares the job as soon as it is started. The barrier holds
    // the backfill so a premature start would be observable.
    const hold = gate();
    const prepared: Array<{ at: number; ok: boolean; error?: string }> = [];
    let initializedAt = 0;
    const orchestrator = createStartupOrchestrator({
      initialize: async () => { await hold.promise; const result = await backfillTemplateEligibility(org.id); initializedAt = Date.now(); return result; },
      startRuntime: () => {
        void sender.prepareBatch([resolved], new AbortController().signal)
          .then((map) => prepared.push({ at: Date.now(), ok: map.has(job.id) }), (error: Error) => prepared.push({ at: Date.now(), ok: false, error: error.message }));
      },
      stopRuntime: async () => undefined,
      logger: quiet,
    });
    const settled = orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(prepared.length, 0, "no consumption attempt while the backfill is pending");
    hold.release();
    const state = await settled;
    assert.equal(state.phase, "ready");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(prepared.length, 1, JSON.stringify(prepared));
    assert.equal(prepared[0].ok, true, `job must be prepared once evidence exists: ${prepared[0].error ?? ""}`);
    assert.ok(prepared[0].at >= initializedAt, "consumption happened after initialization completed");
    const [evidence] = await db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.templateId, template.id));
    assert.equal(evidence.evidenceSource, "backfill");
    assert.equal(evidence.sendable, true);
    // Backfill stays idempotent and never overwrites sync evidence.
    await db.update(templateEligibilityTable).set({ evidenceSource: "workspace_credential", sendable: false }).where(eq(templateEligibilityTable.templateId, template.id));
    await backfillTemplateEligibility(org.id);
    const [kept] = await db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.templateId, template.id));
    assert.equal(kept.evidenceSource, "workspace_credential");
    assert.equal(kept.sendable, false);
    assert.equal((await db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.organizationId, org.id))).length, 1);
    await orchestrator.shutdown();
  } finally { await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)); }
});
