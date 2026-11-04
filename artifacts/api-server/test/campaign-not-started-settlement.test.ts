/*
 * Phase 0 (docs/CROSS_CELL_DISPATCH_AUTHORIZATION.md): work that never reached the provider is never lost.
 *
 * Through the production path -- the real CampaignWorker, its transport shard threads, and the WhatsApp
 * template sender in a mock workspace with real durable intents -- these pin:
 *   D1   an envelope cancelled before provider start (here: its phone's transport ownership revoked while
 *        it waits in shard pacing, as a lane drop does) is requeued, not settled Failed; its intent is
 *        rejected, not left pending or delivery_unknown; and its claim's attempt is returned;
 *   D1b  a dispatch refused because transport ownership is unavailable is the same not-started case;
 *   then the requeued work is deliverable: re-claimed, re-prepared (the rejected intent re-armed) and sent
 *   exactly once, with attempts 1;
 *   and the intent revoke is fenced to the caller's exact lease: it applies only while the job is
 *   Processing under that lease, never for another lease's job, a reaped job or a caller without a token.
 * Mock sends only, observed through CAMPAIGN_TEST_PROVIDER_LOG (written by the shard worker thread).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  providerMessagesTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter, type PreparedCampaignEnvelope } from "../src/services/campaign-queue";
import { DelegatingWhatsAppSender, WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { inFlightRegistry } from "../src/services/campaign-inflight";

const workDir = mkdtempSync(path.join(tmpdir(), "not-started-"));
const providerLog = path.join(workDir, "provider.log");
// The shard worker threads read it from the inherited environment.
process.env.CAMPAIGN_TEST_PROVIDER_LOG = providerLog;

const organizationIds: number[] = [];
const workers: CampaignWorker[] = [];
after(async () => {
  for (const worker of workers) {
    await worker.waitForIdle(5_000).catch(() => false);
    await worker.closeDispatchScheduler().catch(() => {});
  }
  inFlightRegistry.clear();
  if (organizationIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  rmSync(workDir, { recursive: true, force: true });
  await pool.end();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TPS = 2;

async function fixture(slug: string, count: number) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  organizationIds.push(organization!.id);
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization!.id, wabaId: waba!.id, phone: `+1557${organization!.id.toString().padStart(7, "0")}`,
    displayName: slug, status: "Connected", tpsLimit: TPS, providerPhoneId: `test-${slug}`,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: slug, status: "Approved", language: "en_US",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: slug, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone!.id, templateId: template!.id, configuredTps: TPS, queueDepth: count,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id, component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total: count, valid: count, queued: count });
  const recipients = Array.from({ length: count }, (_, i) => `+1998${organization!.id.toString().padStart(5, "0")}${i.toString().padStart(4, "0")}`);
  const contacts = await db.insert(campaignContactsTable).values(recipients.map((recipient, i) => ({
    organizationId: organization!.id, campaignId: campaign!.id, rowNumber: i + 1, rawPhone: recipient, normalizedPhone: recipient,
    status: "Valid" as const, partitionKey: 1, routeId: route!.id, idempotencyKey: `${slug}-c${i}`, data: {},
  }))).returning({ id: campaignContactsTable.id });
  // Available on the app clock (see campaign-suppression-batch-scope.test.ts).
  await db.insert(campaignJobsTable).values(contacts.map((contact, i) => ({
    organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id, contactId: contact.id, templateId: template!.id,
    type: "ResolveTemplateAndSend" as const, idempotencyKey: `${slug}-j${i}`, availableAt: new Date(),
  })));
  return { organization: organization!, phone: phone!, campaign: campaign!, recipients };
}

function newWorker() {
  // The production runtime's sender (campaign-runtime.ts), so every hook goes through its forwarding.
  const worker = new CampaignWorker(new DatabaseJobQueue(), new DelegatingWhatsAppSender(), new RouteTpsLimiter(), `p0-${Date.now()}-${Math.random()}`, 30_000);
  workers.push(worker);
  return worker;
}

const sentTo = () => existsSync(providerLog)
  ? readFileSync(providerLog, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { payload: { to: string } }).payload.to)
  : [];
const jobs = (campaignId: number) => db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(campaignJobsTable.id);
const intents = (jobIds: number[]) => db.select().from(providerMessagesTable).where(inArray(providerMessagesTable.campaignJobId, jobIds));

/** Claim and prepare every claimable job on the phone (pacing may need a few claims). */
async function claimAndPrepare(worker: CampaignWorker, phoneId: number, count: number): Promise<PreparedCampaignEnvelope[]> {
  const envelopes: PreparedCampaignEnvelope[] = [];
  for (let round = 0; round < 100 && envelopes.length < count; round += 1) {
    const claimed = await worker.claimPhoneBatch(phoneId, count - envelopes.length);
    if (!claimed.length) { await sleep(50); continue; }
    envelopes.push(...await worker.prepareReservoirBatch(claimed));
  }
  assert.equal(envelopes.length, count, "every job claimed and prepared");
  return envelopes;
}

function dispatchAll(worker: CampaignWorker, envelopes: PreparedCampaignEnvelope[]) {
  return envelopes.map((envelope) => {
    assert.ok(worker.tryReserveSettlementSlot(), "a settlement slot for each dispatch");
    return worker.dispatchReservoirEnvelope(envelope, new Date(), true);
  });
}

async function settledStatuses(campaignId: number, done: (statuses: string[]) => boolean) {
  for (let i = 0; i < 200; i += 1) {
    const statuses = (await jobs(campaignId)).map((job) => job.status);
    if (done(statuses)) return statuses;
    await sleep(50);
  }
  throw new Error("jobs did not settle");
}

test("D1: work cancelled before provider start by a lane drop is requeued with its attempt returned, then sent exactly once", async () => {
  const COUNT = 6;
  const f = await fixture(`p0-d1-${process.pid}-${Date.now()}`, COUNT);
  const worker = newWorker();
  worker.updateTransportOwnership(f.phone.id, 11, Date.now() + 60_000);
  const envelopes = await claimAndPrepare(worker, f.phone.id, COUNT);
  const dispatches = dispatchAll(worker, envelopes);
  // At 2/s the first starts at once and the rest wait in shard pacing. Drop the lane after the first send.
  for (let i = 0; i < 100 && sentTo().filter((to) => f.recipients.includes(to)).length < 1; i += 1) await sleep(20);
  worker.revokeTransportOwnership(f.phone.id, 11);
  await Promise.all(dispatches);
  const first = sentTo().filter((to) => f.recipients.includes(to));
  assert.ok(first.length >= 1 && first.length < COUNT, `some sent before the drop, some cancelled in pacing (${first.length})`);

  const statuses = await settledStatuses(f.campaign.id, (s) => s.every((status) => status === "Sent" || status === "Queued"));
  const afterDrop = await jobs(f.campaign.id);
  assert.equal(statuses.filter((status) => status === "Failed").length, 0, "nothing that was never sent is Failed");
  const requeued = afterDrop.filter((job) => job.status === "Queued");
  assert.equal(requeued.length, COUNT - first.length, "every unsent envelope is requeued");
  for (const job of requeued) {
    assert.equal(job.attempts, 0, `job ${job.id}: the claim's attempt is returned, not spent`);
    assert.equal(job.leaseToken, null);
  }
  for (const intent of await intents(requeued.map((job) => job.id))) {
    assert.equal(intent.status, "rejected", "the never-sent intent is rejected, so re-preparation re-arms it");
  }

  // Deliverable after the drop: a new owner claims, re-prepares and sends each exactly once.
  await sleep(300); // requeued work becomes available 250 ms later
  worker.updateTransportOwnership(f.phone.id, 12, Date.now() + 60_000);
  const again = await claimAndPrepare(worker, f.phone.id, requeued.length);
  await Promise.all(dispatchAll(worker, again));
  await settledStatuses(f.campaign.id, (s) => s.every((status) => status === "Sent"));
  const finalJobs = await jobs(f.campaign.id);
  for (const job of finalJobs) assert.equal(job.attempts, 1, `job ${job.id}: one attempt for one send`);
  const sends = sentTo().filter((to) => f.recipients.includes(to));
  assert.equal(sends.length, COUNT);
  assert.equal(new Set(sends).size, COUNT, "no duplicate provider dispatch");
  for (const intent of await intents(finalJobs.map((job) => job.id))) assert.equal(intent.status, "sent");
});

test("D1b: a dispatch refused for unavailable transport ownership is not started: requeued, never Failed or delivery_unknown", async () => {
  const f = await fixture(`p0-d1b-${process.pid}-${Date.now()}`, 2);
  const worker = newWorker();
  worker.updateTransportOwnership(f.phone.id, 21, Date.now() + 60_000);
  const envelopes = await claimAndPrepare(worker, f.phone.id, 2);
  worker.revokeTransportOwnership(f.phone.id, 21);
  await Promise.all(dispatchAll(worker, envelopes));
  await settledStatuses(f.campaign.id, (s) => s.every((status) => status === "Queued"));
  for (const job of await jobs(f.campaign.id)) {
    assert.equal(job.status, "Queued");
    assert.equal(job.attempts, 0);
  }
  for (const intent of await intents(envelopes.map(({ job }) => job.id))) assert.equal(intent.status, "rejected");
  assert.equal(sentTo().filter((to) => f.recipients.includes(to)).length, 0);
});

for (const [name, makeSender] of [
  ["WhatsAppTemplateSender", () => new WhatsAppTemplateSender()],
  // The runtime's sender must forward the lease token: dropped, the fence sees the caller's own live lease as
  // another holder's and skips every revoke.
  ["DelegatingWhatsAppSender", () => new DelegatingWhatsAppSender()],
] as const) test(`the intent revoke is fenced to the caller's lease (${name})`, async () => {
  const f = await fixture(`p0-fence-${name.slice(0, 4)}-${process.pid}-${Date.now()}`, 1);
  const worker = newWorker();
  worker.updateTransportOwnership(f.phone.id, 31, Date.now() + 60_000);
  const [envelope] = await claimAndPrepare(worker, f.phone.id, 1);
  const sender = makeSender();
  const job = envelope!.job;
  const intentOf = async () => (await intents([job.id]))[0]!;
  assert.equal((await intentOf()).status, "pending");

  // The job is now held by ANOTHER lease (re-claimed after this envelope's lease was lost): a stale revoke
  // under the old lease must not reject the newer lease's intent.
  await db.update(campaignJobsTable).set({ leaseToken: "a-newer-lease" }).where(eq(campaignJobsTable.id, job.id));
  await sender.revokePrepared(envelope!.preparedContext, new Error("stale"), job.leaseToken);
  assert.equal((await intentOf()).status, "pending", "a stale lease never revokes another live lease's intent");

  // The live lease itself can revoke; without its token it cannot.
  await sender.revokePrepared(envelope!.preparedContext, new Error("no token"));
  assert.equal((await intentOf()).status, "pending", "a revoke without the holder's token never rejects a live lease's intent");
  await sender.revokePrepared(envelope!.preparedContext, new Error("live"), "a-newer-lease");
  assert.equal((await intentOf()).status, "rejected");

  // Reaped (no lease holds the job any more): nothing records which lease armed the pending intent, and a
  // later lease's call may have started, so a revoke after the caller's lease is gone does nothing. The job's
  // re-preparation then fails it for manual reconciliation: never a second send.
  await db.update(providerMessagesTable).set({ status: "pending", errorReason: null }).where(eq(providerMessagesTable.campaignJobId, job.id));
  await db.update(campaignJobsTable).set({ status: "Queued", leaseToken: null, leaseExpiresAt: null }).where(eq(campaignJobsTable.id, job.id));
  await sender.revokePrepared(envelope!.preparedContext, new Error("reaped"), job.leaseToken);
  assert.equal((await intentOf()).status, "pending", "a revoke after the caller's lease is gone never rejects");
  inFlightRegistry.release(envelope!.registration.key);
});
