import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateSelectionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  providerMessagesTable,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { InMemoryPacingCoordinator } from "../src/services/campaign-pacing-coordinator";
import { InMemoryPreparedDispatchBroker, type BrokerEnvelope } from "../src/services/campaign-prepared-broker";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { backfillTemplateEligibility } from "../src/services/template-eligibility";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import { revokeCredential } from "../src/services/whatsapp-manual-connection";

// V2-02C end to end through the real runtime: lane setup binds the
// workspace credential on the owning shard, sends go straight to (a fake)
// Meta with the token only in the Authorization header, ownership failover
// re-binds on the new runtime, and credential revocation drops the lane so
// queued work never starts another HTTP call. The broker is instrumented to
// prove no token ever enters a published envelope.

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-runtime-${randomBytes(20).toString("hex")}`;

type Recorded = { receivedAt: number; authorization?: string; url: string; to: string };
const recorded: Recorded[] = [];
let server: Server;
let holdMs = 0;

before(async () => {
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const to = (() => { try { return JSON.parse(body).to as string; } catch { return ""; } })();
      recorded.push({ receivedAt: Date.now(), authorization: req.headers.authorization, url: req.url ?? "", to });
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messages: [{ id: `wamid.rt.${recorded.length}.${randomBytes(4).toString("hex")}` }] }));
      }, holdMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.CAMPAIGN_TEST_GRAPH_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  delete process.env.CAMPAIGN_TEST_GRAPH_BASE_URL;
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { pool } = await import("@workspace/db");
  await pool.end();
});

/** Broker wrapper that asserts every published envelope is token-free. */
class AuditedBroker extends InMemoryPreparedDispatchBroker {
  published = 0;
  override async publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]): Promise<void> {
    for (const envelope of envelopes) {
      const serialized = JSON.stringify(envelope);
      assert.ok(!serialized.includes(TOKEN), "a broker envelope must never carry the access token");
      assert.ok(!serialized.includes("accessToken"), "a broker envelope must never carry a token field");
    }
    this.published += envelopes.length;
    return super.publish(phoneNumberId, fencingToken, envelopes);
  }
}

async function seed(contacts: number, tps: number) {
  const slug = `cred-rt-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const enc = encryptCredential(TOKEN, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(TOKEN), status: "active",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `waba-${slug}`, displayName: "WABA", credentialId: credential.id }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: org.id, wabaId: waba.id, providerPhoneId: `pp-${slug}`, phone: `+1555${String(org.id).padStart(7, "0")}`,
    displayName: "Manual", status: "Connected", setupState: "active", tpsLimit: Math.max(tps, 50),
    credentialId: credential.id, sendingCredentialId: credential.id,
  }).returning();
  // V2-04: provider-backed template with evidence (see sending-activation fixture).
  const [template] = await db.insert(templatesTable).values({
    organizationId: org.id, wabaId: waba.id, providerTemplateId: `tpl-rt-${org.id}`, metadata: { source: "workspace_credential", providerStatus: "APPROVED" },
    name: "rt-template", status: "Approved", language: "en_US", body: "Hello", components: [{ type: "BODY", text: "Hello" }],
  }).returning();
  await backfillTemplateEligibility(org.id);
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: org.id, name: slug, status: "Draft" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({ organizationId: org.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: tps }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: org.id, campaignId: campaign.id, templateId: template.id });
  await db.insert(campaignContactsTable).values(Array.from({ length: contacts }, (_, index) => ({
    organizationId: org.id, campaignId: campaign.id, rowNumber: index + 1,
    rawPhone: `+1777${String(index + 1).padStart(7, "0")}`, normalizedPhone: `+1777${String(index + 1).padStart(7, "0")}`,
    status: "Valid" as const, data: {}, idempotencyKey: `${slug}-contact-${index + 1}`,
  })));
  await db.insert(campaignMetricsTable).values({ organizationId: org.id, campaignId: campaign.id, total: contacts, valid: contacts });
  await planCampaign(org.id, campaign.id);
  await executeCampaignPlan(org.id, campaign.id);
  return { org, credential, waba, phone, template, campaign, route, slug, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("failover: runtime A binds and sends; after its lease lapses runtime B independently re-binds and continues, A drops its lane and binding", async () => {
  holdMs = 0;
  recorded.length = 0;
  const coordinator = new InMemoryPacingCoordinator();
  const broker = new AuditedBroker();
  const f = await seed(4, 50);
  const scope = new Set([f.phone.id]);
  const runtimeA = new CampaignRuntime(undefined, 2_000, { pacingCoordinator: coordinator, preparedBroker: broker, phoneScope: scope, brokerAbandonedDeliveryMs: 1_000 });
  const runtimeB = new CampaignRuntime(undefined, 2_000, { pacingCoordinator: coordinator, preparedBroker: broker, phoneScope: scope, brokerAbandonedDeliveryMs: 1_000 });
  try {
    await runtimeA.runTickForTest();
    await until(() => recorded.length >= 4, 10_000, "runtime A to send the first campaign");
    assert.deepEqual(runtimeA.boundTransportCredential(f.phone.id), { organizationId: f.org.id, credentialId: f.credential.id, credentialRevision: 1 });
    assert.equal(runtimeB.boundTransportCredential(f.phone.id), undefined, "B never bound anything while A owned the phone");
    for (const request of recorded) {
      assert.equal(request.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.url, `/v23.0/${f.phone.providerPhoneId}/messages`);
    }
    assert.ok(broker.published >= 4);

    // Second campaign on the same phone while A's ownership lease (5s TTL,
    // renewed only on ticks) lapses. A is idle -- not stopped -- so this is
    // a genuine takeover, not a clean handover.
    const [campaign2] = await db.insert(campaignsTable).values({ organizationId: f.org.id, name: `${f.slug}-2`, status: "Draft" }).returning();
    await db.insert(campaignRoutesTable).values({ organizationId: f.org.id, campaignId: campaign2.id, phoneNumberId: f.phone.id, templateId: f.template.id, configuredTps: 50 });
    await db.insert(campaignTemplateSelectionsTable).values({ organizationId: f.org.id, campaignId: campaign2.id, templateId: f.template.id });
    await db.insert(campaignContactsTable).values(Array.from({ length: 3 }, (_, index) => ({
      organizationId: f.org.id, campaignId: campaign2.id, rowNumber: index + 1,
      rawPhone: `+1888${String(index + 1).padStart(7, "0")}`, normalizedPhone: `+1888${String(index + 1).padStart(7, "0")}`,
      status: "Valid" as const, data: {}, idempotencyKey: `${f.slug}-c2-${index + 1}`,
    })));
    await db.insert(campaignMetricsTable).values({ organizationId: f.org.id, campaignId: campaign2.id, total: 3, valid: 3 });
    await planCampaign(f.org.id, campaign2.id);
    await executeCampaignPlan(f.org.id, campaign2.id);
    await new Promise((resolve) => setTimeout(resolve, 5_300)); // let A's 5s ownership lease expire
    const before = recorded.length;

    await runtimeB.runTickForTest();
    await until(() => recorded.length >= before + 3, 10_000, "runtime B to send the second campaign");
    assert.deepEqual(runtimeB.boundTransportCredential(f.phone.id), { organizationId: f.org.id, credentialId: f.credential.id, credentialRevision: 1 }, "B decrypted and bound on its own");
    for (const request of recorded.slice(before)) assert.equal(request.authorization, `Bearer ${TOKEN}`);
    const tos = recorded.map((request) => request.to);
    assert.equal(new Set(tos).size, tos.length, "no recipient was ever sent twice across the takeover");

    // A notices it lost ownership on its next tick: lane and binding gone.
    await runtimeA.runTickForTest();
    assert.equal(runtimeA.phoneLaneMetrics().length, 0, "A no longer owns a lane for the phone");
    assert.equal(runtimeA.boundTransportCredential(f.phone.id), undefined, "A's binding is cleared with its ownership");
    assert.equal(recorded.length, before + 3, "A started no provider call after losing ownership");
  } finally {
    await runtimeA.stop();
    await runtimeB.stop();
    await f.cleanup();
  }
});

test("revocation during running work: lane drops, ownership and binding are revoked, queued work never starts another HTTP call, in-flight work stays at-most-once", async () => {
  holdMs = 350;
  recorded.length = 0;
  const coordinator = new InMemoryPacingCoordinator();
  const broker = new AuditedBroker();
  const f = await seed(12, 4); // 4 TPS -> ~3s of paced sends
  const runtime = new CampaignRuntime(undefined, 2_000, { pacingCoordinator: coordinator, preparedBroker: broker, phoneScope: new Set([f.phone.id]), brokerAbandonedDeliveryMs: 1_000 });
  try {
    runtime.start(50);
    await until(() => recorded.length >= 3, 10_000, "a few sends to be in progress");
    assert.ok(runtime.phoneLaneMetrics().some((lane) => lane.phoneNumberId === f.phone.id && lane.sendingCredentialId === f.credential.id));

    const revokedAt = Date.now();
    const revoked = await revokeCredential(f.org.id, f.credential.id);
    assert.deepEqual(revoked?.disabledPhoneIds, [f.phone.id]);
    const phone = (await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.id, f.phone.id)))[0]!;
    assert.equal(phone.status, "Pending");
    assert.equal(phone.setupState, "action_required");
    assert.equal(phone.sendingCredentialId, null);

    await until(() => runtime.phoneLaneMetrics().length === 0, 5_000, "the reservoir to drop the lane");
    const laneDroppedAt = Date.now();
    assert.equal(runtime.boundTransportCredential(f.phone.id), undefined, "binding cleared with the lane");
    // Anything the shard had already started before the drop may still be
    // answered by the fake provider; nothing may START afterwards.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settled = recorded.length;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(recorded.length, settled, "no HTTP call started after the lane was revoked");
    const startedAfterDrop = recorded.filter((request) => request.receivedAt > laneDroppedAt + 50);
    assert.equal(startedAfterDrop.length, 0, `requests started after lane drop: ${startedAfterDrop.length}`);
    assert.ok(recorded.length < 12, `revocation at +${laneDroppedAt - revokedAt}ms stopped the campaign short (${recorded.length} of 12 sent)`);

    // At-most-once: no recipient hit twice, and an interrupted in-flight send
    // is settled delivery_unknown (never retried), never re-queued.
    const tos = recorded.map((request) => request.to);
    assert.equal(new Set(tos).size, tos.length);
    const messages = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.organizationId, f.org.id));
    const byStatus = new Map<string, number>();
    for (const message of messages) byStatus.set(message.status, (byStatus.get(message.status) ?? 0) + 1);
    assert.equal(byStatus.get("sent") ?? 0, recorded.filter((request) => request.receivedAt <= laneDroppedAt + 50).length - (byStatus.get("delivery_unknown") ?? 0),
      `sent + delivery_unknown must equal the provider's accepted/started requests: ${JSON.stringify([...byStatus])}`);
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, f.campaign.id));
    for (const job of jobs) {
      const message = messages.find((row) => row.campaignJobId === job.id);
      if (message?.status === "delivery_unknown") assert.notEqual(job.status, "Queued", "a delivery_unknown job is never re-queued for another attempt");
    }
  } finally {
    await runtime.stop();
    await f.cleanup();
  }
});
