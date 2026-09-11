/*
 * P8 regression coverage: a suppressed recipient is rejected on its own.
 *
 * prepareBatch() screens suppressions inside the durable-intent transaction,
 * under the same advisory fences an inbound STOP takes. It used to throw for
 * the whole batch when any recipient was suppressed, so one STOP'd contact
 * settled up to 255 unrelated recipients Failed with no durable intent.
 *
 * Preserved per suppressed job: a non-retryable failure carrying the
 * suppression reason, settled Failed, no provider_messages row. Preserved per
 * accepted job: a pending durable intent, a prepared envelope, and exactly
 * the returned envelopes are what the reservoir publishes.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  campaignContactsTable, campaignJobsTable, campaignMetricsTable, campaignRoutesTable, campaignTemplateMappingsTable, campaignTemplateSelectionsTable, campaignsTable,
  db, organizationsTable, phoneNumbersTable, pool, providerMessagesTable, suppressionsTable, templatesTable, wabasTable,
} from "@workspace/db";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter, type CampaignJob, type ProviderSender } from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { inFlightRegistry } from "../src/services/campaign-inflight";

after(async () => {
  inFlightRegistry.clear();
  if (createdCampaignIds.length) await db.update(campaignsTable).set({ status: "Cancelled" }).where(inArray(campaignsTable.id, createdCampaignIds));
  await pool.end();
});
const createdCampaignIds: number[] = [];

class HookedSender extends WhatsAppTemplateSender {
  /** Runs after the intent transaction, before the pre-publication re-check. */
  onPrepared?: (contexts: Map<number, unknown>) => Promise<void>;
  override async prepareBatch(jobs: CampaignJob[], signal?: AbortSignal) {
    const contexts = await super.prepareBatch(jobs, signal);
    if (this.onPrepared) { const hook = this.onPrepared; this.onPrepared = undefined; await hook(contexts); }
    return contexts;
  }
}

async function fixture(slug: string, recipients: string[]) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id, phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: slug, status: "Connected", tpsLimit: 1_000, providerPhoneId: `${slug}-provider-phone`,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: slug, status: "Approved", language: "en_US",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
  createdCampaignIds.push(campaign.id);
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 1_000, queueDepth: recipients.length,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization.id, campaignId: campaign.id, templateId: template.id });
  await db.insert(campaignTemplateMappingsTable).values({ organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "1", source: "static", sourceValue: "World" });
  await db.insert(campaignMetricsTable).values({ organizationId: organization.id, campaignId: campaign.id, total: recipients.length, valid: recipients.length, queued: recipients.length });
  const jobs = [];
  for (const [index, recipient] of recipients.entries()) {
    const [contact] = await db.insert(campaignContactsTable).values({
      organizationId: organization.id, campaignId: campaign.id, rowNumber: index + 1, rawPhone: recipient, normalizedPhone: recipient,
      status: "Valid", partitionKey: 1, routeId: route.id, idempotencyKey: `${slug}-c${index}`,
    }).returning();
    const [job] = await db.insert(campaignJobsTable).values({
      organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contact.id, templateId: template.id,
      type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-j${index}`,
    }).returning();
    jobs.push({ job, recipient });
  }
  return { organization, phone, campaign, route, jobs };
}
const suppress = (organizationId: number, phone: string, reason = "STOP") => db.insert(suppressionsTable).values({ organizationId, normalizedPhone: phone, reason }).onConflictDoNothing();
const phones = (n: number, base: number) => Array.from({ length: n }, (_, i) => `+${base + i}`);
const worker = (sender: ProviderSender, leaseMs = 30_000) => new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `p8-${Date.now()}-${Math.random()}`, leaseMs);
const jobRow = async (id: number) => (await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, id)))[0]!;
const providerRows = (jobId: number) => db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, jobId));

async function prepare(w: CampaignWorker, phoneId: number, count: number, now = new Date()) {
  const claimed = await w.claimPhoneBatch(phoneId, count, now);
  assert.equal(claimed.length, count, "fixture jobs must all be claimable");
  const envelopes = await w.prepareReservoirBatch(claimed, now);
  return { claimed, envelopes, accepted: new Set(envelopes.map((e) => e.job.id)) };
}
async function assertSuppressedFailed(jobId: number, reason = "STOP") {
  const j = await jobRow(jobId);
  assert.equal(j.status, "Failed", `suppressed job ${jobId} is settled Failed`);
  assert.equal(j.errorReason, `Recipient is on the suppression list (${reason})`);
  assert.equal(j.leaseToken, null);
  assert.equal((await providerRows(jobId)).length, 0, "no durable intent is written for a suppressed recipient");
}
async function assertArmed(jobId: number) {
  const j = await jobRow(jobId); assert.equal(j.status, "Processing", `accepted job ${jobId} stays leased and prepared`); assert.ok(j.leaseToken);
  const pm = await providerRows(jobId); assert.equal(pm.length, 1); assert.equal(pm[0]!.status, "pending", "accepted recipients carry a pending durable intent");
}
async function assertExact(f: Awaited<ReturnType<typeof fixture>>, accepted: Set<number>, suppressedIdx: Set<number>, reason?: string) {
  const expected = f.jobs.filter((_, i) => !suppressedIdx.has(i)).map((x) => x.job.id);
  assert.deepEqual([...accepted].sort((a, b) => a - b), expected.sort((a, b) => a - b), "returned envelopes are exactly the non-suppressed jobs");
  for (const [i, { job }] of f.jobs.entries()) { if (suppressedIdx.has(i)) await assertSuppressedFailed(job.id, reason); else await assertArmed(job.id); }
}

test("A · one suppressed recipient in a full 256 batch: it alone fails, the other 255 are armed", async () => {
  const f = await fixture(`p8-one-${process.pid}-${Date.now()}`, phones(256, 15560000000));
  await suppress(f.organization.id, f.jobs[100]!.recipient);
  const { accepted } = await prepare(worker(new HookedSender()), f.phone.id, 256);
  assert.equal(accepted.size, 255);
  await assertExact(f, accepted, new Set([100]));
});

test("B · many suppressed recipients mixed with accepted ones", async () => {
  const f = await fixture(`p8-many-${process.pid}-${Date.now()}`, phones(60, 15560100000));
  const bad = new Set([0, 3, 7, 11, 19, 23, 31, 42, 55, 59]);
  for (const i of bad) await suppress(f.organization.id, f.jobs[i]!.recipient, "Unsubscribed");
  const { accepted } = await prepare(worker(new HookedSender()), f.phone.id, 60);
  assert.equal(accepted.size, 50);
  await assertExact(f, accepted, bad, "Unsubscribed");
});

test("C · every recipient suppressed: no envelope, every job Failed, no intent written", async () => {
  const f = await fixture(`p8-all-${process.pid}-${Date.now()}`, phones(12, 15560200000));
  for (const { recipient } of f.jobs) await suppress(f.organization.id, recipient);
  const { envelopes, accepted } = await prepare(worker(new HookedSender()), f.phone.id, 12);
  assert.equal(envelopes.length, 0);
  await assertExact(f, accepted, new Set(f.jobs.map((_, i) => i)));
});

test("D · mixed organizations: a phone suppressed in one organization does not affect another's batch", async () => {
  const stamp = `${process.pid}-${Date.now()}`; const shared = "+15560300009";
  const a = await fixture(`p8-orgA-${stamp}`, [shared, "+15560300010", "+15560300011"]);
  const b = await fixture(`p8-orgB-${stamp}`, [shared, "+15560300012"]);
  await suppress(a.organization.id, shared);
  const ra = await prepare(worker(new HookedSender()), a.phone.id, 3); const rb = await prepare(worker(new HookedSender()), b.phone.id, 2);
  await assertExact(a, ra.accepted, new Set([0]));
  await assertExact(b, rb.accepted, new Set());
});

test("E · duplicate recipients: every job for the suppressed phone fails, the others proceed", async () => {
  const same = "+15560400001";
  const f = await fixture(`p8-dup-${process.pid}-${Date.now()}`, [same, "+15560400002", same, same, "+15560400003"]);
  await suppress(f.organization.id, same);
  const { accepted } = await prepare(worker(new HookedSender()), f.phone.id, 5);
  await assertExact(f, accepted, new Set([0, 2, 3]));
});

test("F · STOP during preparation: before the intent fence it fails the recipient alone; after it, the re-check requeues the recipient alone", async () => {
  const f = await fixture(`p8-stop-${process.pid}-${Date.now()}`, phones(6, 15560500000));
  // (1) STOP committed before the intent transaction takes its fence.
  await suppress(f.organization.id, f.jobs[1]!.recipient);
  // (2) STOP committed after the intent transaction, before the re-check.
  const s = new HookedSender(); s.onPrepared = async () => { await suppress(f.organization.id, f.jobs[4]!.recipient); };
  const before = new Date(); const { accepted } = await prepare(worker(s), f.phone.id, 6, before); const after = new Date();
  assert.deepEqual([...accepted].sort((a, b) => a - b), [0, 2, 3, 5].map((i) => f.jobs[i]!.job.id).sort((a, b) => a - b));
  await assertSuppressedFailed(f.jobs[1]!.job.id);
  const late = await jobRow(f.jobs[4]!.job.id);
  assert.equal(late.status, "Queued", "a STOP after the intent is caught by the re-check and requeued");
  assert.ok(late.availableAt.getTime() >= before.getTime() + 250 && late.availableAt.getTime() <= after.getTime() + 250);
  assert.equal((await providerRows(late.id)).at(-1)!.status, "rejected", "its durable intent is revoked");
  for (const i of [0, 2, 3, 5]) await assertArmed(f.jobs[i]!.job.id);
});

test("G · retry/recovery: a crash mid-batch is recovered by lease expiry with the same per-job outcomes and no double arming", async () => {
  const f = await fixture(`p8-recover-${process.pid}-${Date.now()}`, phones(8, 15560600000));
  await suppress(f.organization.id, f.jobs[2]!.recipient);
  // The dying process reaches the intent transaction and then vanishes:
  // its post-intent hook never returns.
  const dying = new HookedSender(); let reached = false;
  dying.onPrepared = () => { reached = true; return new Promise<void>(() => {}); };
  // The reaper expires leases against database time (its clock argument is
  // unused), so the lease must genuinely expire; 600 ms is short enough to
  // wait for and still leaves pacing a 100 ms claim horizon for eight jobs.
  void prepare(worker(dying, 600), f.phone.id, 8).catch(() => {});
  for (let i = 0; i < 300 && !reached; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(reached);
  // The decision was made inside the committed intent transaction (no intent
  // row for the suppressed recipient), but its Failed settlement happens in
  // prepareReservoirBatch after prepareBatch returns -- past the crash. So
  // the dead process leaves every job, suppressed or not, leased and
  // untouched in PostgreSQL, which is what lease recovery is for.
  for (const { job } of f.jobs) { const j = await jobRow(job.id); assert.equal(j.status, "Processing", "durable state untouched by the dead process"); }
  assert.equal((await providerRows(f.jobs[2]!.job.id)).length, 0, "no intent was written for the suppressed recipient");
  await new Promise((r) => setTimeout(r, 900));
  await (new CampaignRuntime() as unknown as { reapExpiredLeases(now: Date): Promise<void> }).reapExpiredLeases(new Date(Date.now() + 3_600_000));
  for (const { job } of f.jobs) assert.equal((await jobRow(job.id)).status, "Queued", "leases recovered");
  const again = await prepare(worker(new HookedSender()), f.phone.id, 8, new Date(Date.now() + 3_600_000));
  // The seven whose intent the dead process already armed are never re-sent:
  // re-preparation sees a prior pending intent and fails closed for manual
  // reconciliation (the existing duplicate-send guard). The suppressed one is
  // failed with its own reason. Nothing is armed twice.
  assert.equal(again.accepted.size, 0, "no recovered job is re-armed once a pending intent exists");
  for (const i of [0, 1, 3, 4, 5, 6, 7]) {
    const j = await jobRow(f.jobs[i]!.job.id);
    assert.equal(j.status, "Failed"); assert.match(j.errorReason ?? "", /delivery is unknown/);
    const pm = await providerRows(j.id);
    assert.equal(pm.length, 1, "exactly one durable intent row survives recovery"); assert.equal(pm[0]!.status, "pending", "kept pending for reconciliation");
  }
  await assertSuppressedFailed(f.jobs[2]!.job.id);
});

test("H/I · exact publication set under a scattered suppression pattern: no rejected job published, no accepted job lost", async () => {
  const f = await fixture(`p8-exact-${process.pid}-${Date.now()}`, phones(128, 15560700000));
  const bad = new Set(f.jobs.map((_, i) => i).filter((i) => i % 7 === 3));
  for (const i of bad) await suppress(f.organization.id, f.jobs[i]!.recipient);
  const { envelopes, accepted } = await prepare(worker(new HookedSender()), f.phone.id, 128);
  assert.equal(envelopes.length, new Set(envelopes.map((e) => e.job.id)).size, "no duplicate envelopes");
  for (const e of envelopes) assert.ok(e.preparedContext !== undefined && e.registration);
  await assertExact(f, accepted, bad);
  assert.equal(accepted.size, 128 - bad.size);
});
