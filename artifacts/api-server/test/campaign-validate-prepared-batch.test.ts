/*
 * P7 regression coverage: batched suppression validation in reservoir
 * preparation.
 *
 * prepareBatch() screens suppressions inside the durable-intent transaction,
 * so validatePrepared()/validatePreparedBatch() only ever decide the window
 * AFTER that transaction: a suppression that commits after the intent is
 * written and before the envelope is published. The tests inject
 * suppressions at exactly that point. Every rejection keeps its existing
 * semantics, whichever path decided it:
 *   revokePrepared   provider_messages row -> 'rejected' (if still pending),
 *                    sender outcome slot released
 *   settleAborted    under campaigns + route locks, fenced on the job's own
 *                    lease: Running/Paused -> Queued, lease cleared,
 *                    available_at = now + 250 ms; kill/cancel -> Cancelled;
 *                    a superseded lease updates nothing
 *   registry/route   in-flight registration and route capacity released
 *   publication      the job is absent from the returned envelopes, which is
 *                    exactly what the reservoir publishes
 * The batch decision is one existence test on the unique
 * (organization_id, normalized_phone) key per distinct pair, so for a given
 * suppression set it equals the per-message decision. Both are
 * non-transactional reads: a suppression that commits after evaluation is
 * caught at the job's next preparation, as before.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  campaignContactsTable, campaignJobsTable, campaignMetricsTable, campaignRoutesTable, campaignTemplateMappingsTable, campaignTemplateSelectionsTable, campaignsTable,
  db, organizationsTable, phoneNumbersTable, pool, providerMessagesTable, suppressionsTable, templatesTable, wabasTable,
} from "@workspace/db";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter, type CampaignJob, type ProviderSender } from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { inFlightRegistry } from "../src/services/campaign-inflight";

after(async () => { inFlightRegistry.clear(); await pool.end(); });

/** Production sender with call counters and a hook at the post-intent window; behaviour untouched. */
class CountingSender extends WhatsAppTemplateSender {
  batchCalls = 0; batchItems = 0; perMessageCalls = 0;
  /** Runs after prepareBatch() committed durable intents and before validation: the re-check window. */
  onPrepared?: (contexts: Map<number, unknown>) => Promise<void>;
  onBatchDecided?: (rejected: ReadonlySet<number>) => Promise<void>;
  override async prepareBatch(jobs: CampaignJob[], signal?: AbortSignal) {
    const contexts = await super.prepareBatch(jobs, signal);
    if (this.onPrepared) { const hook = this.onPrepared; this.onPrepared = undefined; await hook(contexts); }
    return contexts;
  }
  override async validatePreparedBatch(items: ReadonlyArray<{ jobId: number; preparedContext: unknown }>) {
    this.batchCalls += 1; this.batchItems += items.length;
    const rejected = await super.validatePreparedBatch(items);
    if (this.onBatchDecided) { const hook = this.onBatchDecided; this.onBatchDecided = undefined; await hook(rejected); }
    return rejected;
  }
  override async validatePrepared(preparedContext: unknown) { this.perMessageCalls += 1; return super.validatePrepared(preparedContext); }
}

/** The same production sender with the batch hook absent: the fallback path. */
function withoutBatchHook(inner: CountingSender): ProviderSender & { inner: CountingSender } {
  return {
    inner,
    prepareBatch: (jobs, signal) => inner.prepareBatch(jobs, signal),
    preparedRecipient: (c) => inner.preparedRecipient(c),
    validatePrepared: (c) => inner.validatePrepared(c),
    revokePrepared: (c, r) => inner.revokePrepared(c, r),
    serializePreparedTransport: (j, c) => inner.serializePreparedTransport(j, c),
    settlePreparedTransport: (j, c, o) => inner.settlePreparedTransport(j, c, o),
    sendPreparedTransport: (j, o, c) => inner.sendPreparedTransport(j, o, c),
    send: (j, o, c) => inner.send(j, o, c),
  };
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
const suppress = (organizationId: number, phone: string) => db.insert(suppressionsTable).values({ organizationId, normalizedPhone: phone, reason: "test" }).onConflictDoNothing();
const phones = (n: number, base = 15559000000) => Array.from({ length: n }, (_, i) => `+${base + i}`);
const worker = (sender: ProviderSender, leaseMs = 30_000) => new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `p7-${Date.now()}-${Math.random()}`, leaseMs);
const jobRow = async (id: number) => (await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, id)))[0]!;
const providerRows = (jobId: number) => db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, jobId));
/** A sender whose post-intent window commits the given suppressions -- the only window validation decides. */
function senderSuppressingAfterIntent(organizationId: number, recipients: string[]) {
  const s = new CountingSender();
  s.onPrepared = async () => { for (const r of recipients) await suppress(organizationId, r); };
  return s;
}

/** Claim + prepare through the exact production path; returns accepted job ids (= what the reservoir publishes). */
async function prepare(w: CampaignWorker, phoneId: number, count: number, now = new Date()) {
  const claimed = await w.claimPhoneBatch(phoneId, count, now);
  assert.equal(claimed.length, count, "fixture jobs must all be claimable");
  const envelopes = await w.prepareReservoirBatch(claimed, now);
  return { claimed, envelopes, accepted: new Set(envelopes.map((e) => e.job.id)) };
}
async function assertRequeued(jobId: number, before: Date, after: Date) {
  const j = await jobRow(jobId);
  assert.equal(j.status, "Queued", `job ${jobId} must be requeued`);
  assert.equal(j.leaseToken, null); assert.equal(j.lockedAt, null);
  assert.ok(j.availableAt.getTime() >= before.getTime() + 250 && j.availableAt.getTime() <= after.getTime() + 250, "requeued at now + 250 ms");
  const pm = await providerRows(jobId);
  assert.ok(pm.length >= 1 && pm.at(-1)!.status === "rejected", "durable provider intent is marked rejected");
  assert.equal(pm.at(-1)!.errorReason, "Prepared campaign envelope was revoked");
}
async function assertPreparedPending(jobId: number) {
  const j = await jobRow(jobId); assert.equal(j.status, "Processing"); assert.ok(j.leaseToken);
  const pm = await providerRows(jobId); assert.equal(pm.at(-1)!.status, "pending", "accepted envelopes keep a pending durable intent");
}

test("A/G · zero suppressions: one batch query, every envelope accepted", async () => {
  const f = await fixture(`p7-none-${process.pid}-${Date.now()}`, phones(20));
  const s = new CountingSender(); const w = worker(s);
  const { accepted } = await prepare(w, f.phone.id, 20);
  assert.equal(accepted.size, 20);
  assert.equal(s.batchCalls, 1); assert.equal(s.batchItems, 20); assert.equal(s.perMessageCalls, 0, "the per-message hook is not used when the batch hook exists");
  for (const { job } of f.jobs) await assertPreparedPending(job.id);
});

test("B · one contact suppressed after intent is revoked and requeued; the other nineteen are accepted", async () => {
  const f = await fixture(`p7-one-${process.pid}-${Date.now()}`, phones(20));
  const s = senderSuppressingAfterIntent(f.organization.id, [f.jobs[7]!.recipient]); const w = worker(s);
  const before = new Date(); const { accepted } = await prepare(w, f.phone.id, 20, before); const after = new Date();
  assert.equal(accepted.size, 19); assert.ok(!accepted.has(f.jobs[7]!.job.id));
  await assertRequeued(f.jobs[7]!.job.id, before, after);
  for (const { job } of f.jobs.filter((_, i) => i !== 7)) await assertPreparedPending(job.id);
  assert.equal(s.batchCalls, 1); assert.equal(s.perMessageCalls, 0);
});

test("C/H · many suppressed contacts, mixed with accepted ones, in one query", async () => {
  const f = await fixture(`p7-many-${process.pid}-${Date.now()}`, phones(40));
  const bad = f.jobs.filter((_, i) => i % 3 === 0);
  const s = senderSuppressingAfterIntent(f.organization.id, bad.map((x) => x.recipient)); const w = worker(s);
  const before = new Date(); const { accepted } = await prepare(w, f.phone.id, 40, before); const after = new Date();
  assert.equal(accepted.size, 40 - bad.length);
  for (const { job } of bad) { assert.ok(!accepted.has(job.id)); await assertRequeued(job.id, before, after); }
  for (const { job } of f.jobs.filter((_, i) => i % 3 !== 0)) { assert.ok(accepted.has(job.id)); await assertPreparedPending(job.id); }
  assert.equal(s.batchCalls, 1); assert.equal(s.perMessageCalls, 0);
});

test("D/P · the same phone suppressed in another organization does not reject this one", async () => {
  const stamp = `${process.pid}-${Date.now()}`; const shared = "+15558887777";
  const a = await fixture(`p7-orgA-${stamp}`, [shared, "+15558887778"]);
  const b = await fixture(`p7-orgB-${stamp}`, [shared, "+15558887779"]);
  const sa = senderSuppressingAfterIntent(a.organization.id, [shared]);
  const sb = senderSuppressingAfterIntent(b.organization.id, ["+1555888777"]);   // near-miss decoy in org B: differs by one digit
  const ra = await prepare(worker(sa), a.phone.id, 2); const rb = await prepare(worker(sb), b.phone.id, 2);
  assert.deepEqual([...ra.accepted], [a.jobs[1]!.job.id], "org A: only the non-suppressed job");
  assert.equal(rb.accepted.size, 2, "org B: both accepted -- suppression is per organization and exact-match");
});

test("E · duplicate recipients share one pair and one decision", async () => {
  const same = "+15557770001";
  const f = await fixture(`p7-dup-${process.pid}-${Date.now()}`, [same, same, same, "+15557770002"]);
  const s = senderSuppressingAfterIntent(f.organization.id, [same]); const w = worker(s);
  const before = new Date(); const { accepted } = await prepare(w, f.phone.id, 4, before); const after = new Date();
  assert.deepEqual([...accepted], [f.jobs[3]!.job.id]);
  for (const { job } of f.jobs.slice(0, 3)) await assertRequeued(job.id, before, after);
  assert.equal(s.batchItems, 4);
});

test("F · every contact suppressed after intent: no envelope is returned, every job is requeued", async () => {
  const f = await fixture(`p7-all-${process.pid}-${Date.now()}`, phones(10));
  const s = senderSuppressingAfterIntent(f.organization.id, f.jobs.map((x) => x.recipient)); const w = worker(s);
  const before = new Date(); const { accepted, envelopes } = await prepare(w, f.phone.id, 10, before); const after = new Date();
  assert.equal(envelopes.length, 0); assert.equal(accepted.size, 0);
  for (const { job } of f.jobs) await assertRequeued(job.id, before, after);
});

test("I · a suppression committed after the batch decision is caught at the next preparation, not this one", async () => {
  const f = await fixture(`p7-race-${process.pid}-${Date.now()}`, phones(3, 15556660000));
  const late = f.jobs[1]!;
  const s = new CountingSender();
  s.onBatchDecided = async (rejected) => { assert.equal(rejected.size, 0); await suppress(f.organization.id, late.recipient); };
  const first = await prepare(worker(s), f.phone.id, 3);
  assert.ok(first.accepted.has(late.job.id), "documented: a post-decision suppression is not seen by the batch that already decided");
  const g = await fixture(`p7-race2-${process.pid}-${Date.now()}`, [late.recipient]);
  const t = new CountingSender(); t.onPrepared = async () => { await suppress(g.organization.id, late.recipient); };
  const second = await prepare(worker(t), g.phone.id, 1);
  assert.equal(second.accepted.size, 0, "the next preparation for that recipient is rejected");
});

test("J · a job requeued by the re-check is screened by prepareBatch on its retry (pre-existing terminal outcome)", async () => {
  const f = await fixture(`p7-retry-${process.pid}-${Date.now()}`, ["+15554440001"]);
  const s = senderSuppressingAfterIntent(f.organization.id, ["+15554440001"]); const w = worker(s);
  const t1 = new Date(); const first = await prepare(w, f.phone.id, 1, t1);
  assert.equal(first.accepted.size, 0);
  let j = await jobRow(f.jobs[0]!.job.id); assert.equal(j.status, "Queued"); assert.equal(j.attempts, 1);
  assert.equal((await providerRows(j.id)).filter((r) => r.status === "rejected").length, 1, "the revoked intent is recorded");
  await new Promise((r) => setTimeout(r, 300));
  const second = await prepare(w, f.phone.id, 1, new Date(Date.now() + 1_000));
  assert.equal(second.accepted.size, 0);
  j = await jobRow(f.jobs[0]!.job.id);
  assert.equal(j.attempts, 2, "each claim counts one attempt; rejection adds none");
  assert.equal(j.status, "Failed", "on retry the suppression is now visible to prepareBatch's own screen, which fails the job before any intent is written");
  assert.match(j.errorReason ?? "", /suppression list/);
});

test("K · a rejection against a superseded lease updates nothing (fence preserved)", async () => {
  const f = await fixture(`p7-fence-${process.pid}-${Date.now()}`, ["+15553330001", "+15553330002"]);
  const s = senderSuppressingAfterIntent(f.organization.id, ["+15553330001"]);
  s.onBatchDecided = async () => { await db.update(campaignJobsTable).set({ leaseToken: "another-owner", lockedBy: "another-worker" }).where(eq(campaignJobsTable.id, f.jobs[0]!.job.id)); };
  const { accepted } = await prepare(worker(s), f.phone.id, 2);
  assert.deepEqual([...accepted], [f.jobs[1]!.job.id]);
  const j = await jobRow(f.jobs[0]!.job.id);
  assert.equal(j.status, "Processing", "the stale lease must not requeue a job it no longer owns"); assert.equal(j.leaseToken, "another-owner");
});

test("L · STOP/kill: a rejection under the kill switch cancels instead of requeueing", async () => {
  const f = await fixture(`p7-kill-${process.pid}-${Date.now()}`, ["+15552220001", "+15552220002"]);
  const s = senderSuppressingAfterIntent(f.organization.id, ["+15552220001"]);
  s.onBatchDecided = async () => { await db.update(campaignsTable).set({ killSwitch: true }).where(eq(campaignsTable.id, f.campaign.id)); };
  const { accepted } = await prepare(worker(s), f.phone.id, 2);
  assert.ok(!accepted.has(f.jobs[0]!.job.id));
  const j = await jobRow(f.jobs[0]!.job.id);
  assert.equal(j.status, "Cancelled"); assert.equal(j.errorReason, "Emergency kill"); assert.equal(j.leaseToken, null);
});

test("M · a crash between the decision and settlement leaves the lease for recovery; the job is never published", async () => {
  const f = await fixture(`p7-crash-${process.pid}-${Date.now()}`, ["+15551110001"]);
  const dying = senderSuppressingAfterIntent(f.organization.id, ["+15551110001"]);
  let decided = false; dying.onBatchDecided = async () => { decided = true; };
  // A thrown error is handled in-process (the batch is settled Failed); a
  // crash is the process disappearing mid-settlement. Stand in for that with a
  // revoke that never returns, and abandon the worker.
  dying.revokePrepared = () => new Promise<void>(() => {});
  void prepare(worker(dying, 150), f.phone.id, 1).catch(() => {});
  for (let i = 0; i < 200 && !decided; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(decided, "the batch decision must have been reached before the crash");
  let j = await jobRow(f.jobs[0]!.job.id); assert.equal(j.status, "Processing", "durable state untouched by the dead process"); const doomed = j.leaseToken;
  await new Promise((r) => setTimeout(r, 300));
  await (new CampaignRuntime() as unknown as { reapExpiredLeases(now: Date): Promise<void> }).reapExpiredLeases(new Date(Date.now() + 3_600_000));
  j = await jobRow(f.jobs[0]!.job.id); assert.equal(j.status, "Queued"); assert.notEqual(j.leaseToken, doomed);
  const again = await prepare(worker(new CountingSender()), f.phone.id, 1, new Date(Date.now() + 3_600_000));
  assert.equal(again.accepted.size, 0, "recovered; the suppression is now visible to the screen; never published");
});

test("N · a sender without the batch hook keeps the per-message path and reaches identical decisions", async () => {
  const stamp = `${process.pid}-${Date.now()}`; const recips = phones(24, 15550100000);
  const a = await fixture(`p7-fb-a-${stamp}`, recips); const b = await fixture(`p7-fb-b-${stamp}`, recips);
  const bad = [1, 5, 6, 13, 20].map((i) => recips[i]!);
  const batched = senderSuppressingAfterIntent(a.organization.id, bad); const fallback = withoutBatchHook(senderSuppressingAfterIntent(b.organization.id, bad));
  const ra = await prepare(worker(batched), a.phone.id, 24); const rb = await prepare(worker(fallback), b.phone.id, 24);
  const idx = (f: Awaited<ReturnType<typeof fixture>>, set: Set<number>) => f.jobs.map((x, i) => set.has(x.job.id) ? i : -1).filter((i) => i >= 0);
  assert.deepEqual(idx(a, ra.accepted), idx(b, rb.accepted), "same accepted indexes on both paths");
  assert.equal(ra.accepted.size, 19);
  assert.equal(batched.batchCalls, 1); assert.equal(batched.perMessageCalls, 0);
  assert.equal(fallback.inner.batchCalls, 0); assert.equal(fallback.inner.perMessageCalls, 24, "fallback: one validatePrepared per message");
});

test("O/P · returned envelopes are exactly the accepted set: no rejected job is published, no accepted job is dropped", async () => {
  const f = await fixture(`p7-exact-${process.pid}-${Date.now()}`, phones(30, 15550200000));
  const rejectedIdx = new Set([0, 4, 9, 17, 29]);
  const s = senderSuppressingAfterIntent(f.organization.id, [...rejectedIdx].map((i) => f.jobs[i]!.recipient));
  const { envelopes } = await prepare(worker(s), f.phone.id, 30);
  const returned = new Set(envelopes.map((e) => e.job.id));
  const expected = new Set(f.jobs.filter((_, i) => !rejectedIdx.has(i)).map((x) => x.job.id));
  assert.deepEqual([...returned].sort(), [...expected].sort());
  assert.equal(envelopes.length, new Set(envelopes.map((e) => e.job.id)).size, "no duplicate envelopes");
  for (const e of envelopes) assert.ok(e.preparedContext !== undefined && e.registration, "every published envelope carries its prepared context and registration");
});

test("Z · (pre-existing, documented) a recipient suppressed BEFORE preparation fails its entire batch inside prepareBatch", async () => {
  // Not introduced by P7 and not changed by it: prepareBatch()'s own screen
  // throws for the whole batch when any recipient is suppressed, so every
  // batch-mate is settled Failed with no durable intent. Recorded here as
  // executable evidence for the follow-up that scopes the rejection to the
  // suppressed recipients only.
  const f = await fixture(`p7-prescreen-${process.pid}-${Date.now()}`, phones(20, 15550300000));
  await suppress(f.organization.id, f.jobs[3]!.recipient);
  const s = new CountingSender();
  const { accepted } = await prepare(worker(s), f.phone.id, 20);
  assert.equal(accepted.size, 0);
  assert.equal(s.batchCalls, 0, "validation never runs: preparation failed first");
  for (const { job } of f.jobs) {
    const j = await jobRow(job.id); assert.equal(j.status, "Failed"); assert.match(j.errorReason ?? "", /suppression list/);
    assert.equal((await providerRows(job.id)).length, 0, "no durable intent is written for the failed batch");
  }
});
