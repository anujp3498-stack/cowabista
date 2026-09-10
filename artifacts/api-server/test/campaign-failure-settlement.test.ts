/*
 * P4 regression coverage: provider failures from the reservoir dispatch path
 * settle through the same batched, per-campaign-serialized pipeline as
 * successes.
 *
 * State transition preserved by batching (settleFailedBatch, one transaction
 * under `campaigns FOR UPDATE` + `campaign_routes FOR UPDATE`, sorted order):
 *   fence     status = 'Processing' AND lease_token = <the lease the sender
 *             held> AND (org, campaign, route) match -- otherwise 0 rows, the
 *             job is untouched and lease recovery owns it
 *   exhausted !retryable OR attempts >= maxAttempts
 *   status    exhausted ? 'Failed' : 'Queued'
 *   lease     locked_at/locked_by/lease_token/lease_expires_at cleared
 *   clock     available_at = exhausted ? observedAt : retryAt(attempts, observedAt)
 *             where observedAt is the moment THAT job's provider call failed
 *   attempts  unchanged (claim increments; settlement never does)
 *   metrics   one campaign_metric_deltas row per campaign per batch
 *             (processing -N, queued +retries, retry +retries, failed +failed)
 *   after     flushAllCampaignMetricDeltas(campaign); completeIfDrained when
 *             a retry exhausted, decided by its own transactional check
 * The slot the reservoir reserved before dispatch stays held until the
 * failure is durable, so the failure queue is bounded by the 4,096 cap and
 * drained by waitForIdle(). The queue is never a source of truth: a process
 * that dies with failures queued leaves them 'Processing' under their lease,
 * and lease expiry recovers them exactly as a crash mid-send always has.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
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
  templatesTable,
  wabasTable,
} from "@workspace/db";
import {
  CampaignWorker,
  DatabaseJobQueue,
  RouteTpsLimiter,
  flushAllCampaignMetricDeltas,
  retryAt,
  type CampaignWorkerObserver,
  type ProviderSender,
} from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { ProviderRequestError } from "../src/services/whatsapp-provider";
import { inFlightRegistry } from "../src/services/campaign-inflight";

after(async () => {
  inFlightRegistry.clear();
  await pool.end();
});

const retryable = () => new ProviderRequestError("provider 503", true);
const terminal = () => new ProviderRequestError("provider 400", false);

class ScriptedSender implements ProviderSender {
  readonly calls: string[] = [];
  readonly failures = new Map<string, () => Error>();
  onSend?: (job: typeof campaignJobsTable.$inferSelect) => void;
  async send(job: typeof campaignJobsTable.$inferSelect, options: { idempotencyKey: string }) {
    this.calls.push(options.idempotencyKey);
    this.onSend?.(job);
    const fail = this.failures.get(options.idempotencyKey);
    if (fail) throw fail();
    return { providerMessageId: `provider-${options.idempotencyKey}` };
  }
}

class Observer implements CampaignWorkerObserver {
  readonly records: Array<{ phase: string; jobs: number }> = [];
  record(phase: string, _ms: number, jobs: number) { this.records.push({ phase, jobs }); }
  failureBatches() { return this.records.filter((r) => r.phase === "failure_settlement"); }
}

async function fixture(slug: string, jobCount: number, options: { attempts?: number; maxAttempts?: number } = {}) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: slug, status: "Connected", tpsLimit: 1_000,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: `${slug}-template`,
    status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: organization.id, name: slug, status: "Running",
  }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id,
    templateId: template.id, configuredTps: 1_000, queueDepth: jobCount,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
  });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
    component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({
    organizationId: organization.id, campaignId: campaign.id,
    total: jobCount, valid: jobCount, queued: jobCount,
  });
  const jobs = [];
  for (let index = 0; index < jobCount; index += 1) {
    const [contact] = await db.insert(campaignContactsTable).values({
      organizationId: organization.id, campaignId: campaign.id, rowNumber: index + 1,
      rawPhone: phone.phone, normalizedPhone: phone.phone, data: { phone: phone.phone },
      status: "Valid", partitionKey: 1, routeId: route.id, idempotencyKey: `${slug}-c${index}`,
    }).returning();
    const [job] = await db.insert(campaignJobsTable).values({
      organizationId: organization.id, campaignId: campaign.id, routeId: route.id,
      contactId: contact.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-j${index}`,
      attempts: options.attempts ?? 0, maxAttempts: options.maxAttempts ?? 5,
    }).returning();
    jobs.push(job);
  }
  return { organization, phone, campaign, route, jobs };
}

const worker = (sender: ProviderSender, observer?: Observer, leaseMs = 30_000) =>
  new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `failure-settlement-${Date.now()}`, leaseMs, observer);

/** Drives the exact production path: claim -> prepare -> slot -> dispatch. */
async function dispatchAll(w: CampaignWorker, phoneId: number, count: number, now = new Date()) {
  let dispatched = 0;
  for (let round = 0; round < 50 && dispatched < count; round += 1) {
    const claimed = await w.claimPhoneBatch(phoneId, count - dispatched, now);
    if (!claimed.length) { await new Promise((r) => setTimeout(r, 20)); continue; }
    const prepared = await w.prepareReservoirBatch(claimed, now);
    for (const envelope of prepared) {
      assert.ok(w.tryReserveSettlementSlot(), "the reservoir must hold a settlement slot before dispatch");
      void w.dispatchReservoirEnvelope(envelope, now, true);
      dispatched += 1;
    }
  }
  assert.equal(dispatched, count, "every job must have been claimed and dispatched");
  return dispatched;
}

const jobRows = (campaignId: number) =>
  db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(campaignJobsTable.id);
const pending = (w: CampaignWorker) => (w as any).successSettlementsPending as number;
const queued = (w: CampaignWorker) => ((w as any).failureSettlementQueue as unknown[]).length;
const until = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  return predicate();
};

test("A · a single provider failure settles through the batched pipeline with its retry state intact", async () => {
  const f = await fixture(`p4-single-${process.pid}-${Date.now()}`, 1);
  const sender = new ScriptedSender();
  sender.failures.set(f.jobs[0]!.idempotencyKey, retryable);
  const observer = new Observer();
  const w = worker(sender, observer);
  const before = new Date();
  await dispatchAll(w, f.phone.id, 1, before);
  assert.ok(await w.waitForIdle(10_000), "the queued failure must drain");
  const after = new Date();

  const [job] = await jobRows(f.campaign.id);
  assert.equal(job!.status, "Queued");
  assert.equal(job!.attempts, 1, "settlement never changes attempts; the claim did");
  assert.equal(job!.leaseToken, null);
  assert.equal(job!.lockedAt, null);
  assert.equal(job!.leaseExpiresAt, null);
  assert.equal(job!.errorReason, "provider 503");
  assert.ok(
    job!.availableAt.getTime() >= retryAt(1, before).getTime() && job!.availableAt.getTime() <= retryAt(1, after).getTime(),
    "backoff is computed from the dispatch clock the failure was observed on",
  );
  assert.deepEqual(observer.failureBatches(), [{ phase: "failure_settlement", jobs: 1 }]);
  assert.equal(pending(w), 0, "the slot held through settlement must be released");
  assert.equal(queued(w), 0);
});

test("B · many failures in one campaign collapse into bounded batches, not one transaction each", async () => {
  const f = await fixture(`p4-many-${process.pid}-${Date.now()}`, 40);
  const sender = new ScriptedSender();
  for (const job of f.jobs) sender.failures.set(job.idempotencyKey, retryable);
  const observer = new Observer();
  const w = worker(sender, observer);
  await dispatchAll(w, f.phone.id, 40);
  assert.ok(await w.waitForIdle(15_000));

  const rows = await jobRows(f.campaign.id);
  assert.equal(rows.filter((j) => j.status === "Queued" && j.leaseToken === null).length, 40);
  const batches = observer.failureBatches();
  assert.equal(batches.reduce((s, b) => s + b.jobs, 0), 40, "every failure settled exactly once");
  assert.ok(batches.length < 40, `expected batching, got ${batches.length} transactions for 40 failures`);
  assert.ok(batches.length >= 1);
  assert.equal(pending(w), 0);
});

test("C · successes and failures in the same campaign settle to the right states and counters", async () => {
  const f = await fixture(`p4-mixed-${process.pid}-${Date.now()}`, 12);
  const sender = new ScriptedSender();
  sender.failures.set(f.jobs[1]!.idempotencyKey, retryable);
  sender.failures.set(f.jobs[4]!.idempotencyKey, retryable);
  sender.failures.set(f.jobs[7]!.idempotencyKey, terminal);
  sender.failures.set(f.jobs[10]!.idempotencyKey, terminal);
  const w = worker(sender, new Observer());
  await dispatchAll(w, f.phone.id, 12);
  assert.ok(await w.waitForIdle(15_000));
  await flushAllCampaignMetricDeltas(f.campaign.id);

  const rows = await jobRows(f.campaign.id);
  const by = (status: string) => rows.filter((j) => j.status === status).map((j) => j.idempotencyKey).sort();
  assert.deepEqual(by("Sent").length, 8);
  assert.deepEqual(by("Queued"), [f.jobs[1]!.idempotencyKey, f.jobs[4]!.idempotencyKey].sort());
  assert.deepEqual(by("Failed"), [f.jobs[7]!.idempotencyKey, f.jobs[10]!.idempotencyKey].sort());
  assert.ok(rows.every((j) => j.leaseToken === null), "no lease survives settlement");
  const [m] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, f.campaign.id));
  assert.equal(m!.sent, 8);
  assert.equal(m!.failed, 2);
  assert.equal(m!.retryCount, 2);
  assert.equal(m!.queued, 2);
  assert.equal(m!.processing, 0);
  const [c] = await db.select({ status: campaignsTable.status }).from(campaignsTable).where(eq(campaignsTable.id, f.campaign.id));
  assert.equal(c!.status, "Running", "two retries are still queued, so the campaign is not complete");
});

test("D · failures from several campaigns on one worker settle per campaign with no leakage", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const a = await fixture(`p4-multi-a-${stamp}`, 10);
  const b = await fixture(`p4-multi-b-${stamp}`, 10);
  const sender = new ScriptedSender();
  for (const job of [...a.jobs.slice(0, 6), ...b.jobs.slice(0, 3)]) sender.failures.set(job.idempotencyKey, retryable);
  const observer = new Observer();
  const w = worker(sender, observer);
  await Promise.all([dispatchAll(w, a.phone.id, 10), dispatchAll(w, b.phone.id, 10)]);
  assert.ok(await w.waitForIdle(15_000));

  const rowsA = await jobRows(a.campaign.id);
  const rowsB = await jobRows(b.campaign.id);
  assert.equal(rowsA.filter((j) => j.status === "Queued").length, 6);
  assert.equal(rowsA.filter((j) => j.status === "Sent").length, 4);
  assert.equal(rowsB.filter((j) => j.status === "Queued").length, 3);
  assert.equal(rowsB.filter((j) => j.status === "Sent").length, 7);
  assert.ok(rowsA.every((j) => j.campaignId === a.campaign.id && j.organizationId === a.organization.id));
  assert.ok(rowsB.every((j) => j.campaignId === b.campaign.id && j.organizationId === b.organization.id));
  assert.equal(observer.failureBatches().reduce((s, x) => s + x.jobs, 0), 9);
  assert.equal(pending(w), 0);
});

test("E · retry backoff, exhaustion and terminal errors follow attempts exactly as before", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  // attempts=3 in the fixture becomes 4 after the claim; maxAttempts 5 -> one retry left
  const canRetry = await fixture(`p4-retry-${stamp}`, 1, { attempts: 3, maxAttempts: 5 });
  // attempts=4 becomes 5 == maxAttempts -> exhausted
  const exhausted = await fixture(`p4-exhaust-${stamp}`, 1, { attempts: 4, maxAttempts: 5 });
  // a terminal provider error fails on the first attempt regardless
  const term = await fixture(`p4-terminal-${stamp}`, 1);
  const sender = new ScriptedSender();
  sender.failures.set(canRetry.jobs[0]!.idempotencyKey, retryable);
  sender.failures.set(exhausted.jobs[0]!.idempotencyKey, retryable);
  sender.failures.set(term.jobs[0]!.idempotencyKey, terminal);
  const w = worker(sender, new Observer());
  const before = new Date();
  await Promise.all([
    dispatchAll(w, canRetry.phone.id, 1, before),
    dispatchAll(w, exhausted.phone.id, 1, before),
    dispatchAll(w, term.phone.id, 1, before),
  ]);
  assert.ok(await w.waitForIdle(15_000));
  const after = new Date();

  const [r] = await jobRows(canRetry.campaign.id);
  assert.equal(r!.status, "Queued");
  assert.equal(r!.attempts, 4);
  assert.ok(r!.availableAt.getTime() >= retryAt(4, before).getTime() && r!.availableAt.getTime() <= retryAt(4, after).getTime(),
    `retry must be scheduled at retryAt(4): got ${r!.availableAt.toISOString()}`);

  const [x] = await jobRows(exhausted.campaign.id);
  assert.equal(x!.status, "Failed", "attempts == maxAttempts exhausts the job");
  assert.equal(x!.attempts, 5);
  assert.equal(x!.leaseToken, null);
  const [xc] = await db.select({ status: campaignsTable.status }).from(campaignsTable).where(eq(campaignsTable.id, exhausted.campaign.id));
  assert.equal(xc!.status, "Completed", "an exhausted last job completes its campaign via completeIfDrained");

  const [t] = await jobRows(term.campaign.id);
  assert.equal(t!.status, "Failed", "a non-retryable provider error fails immediately");
  assert.equal(t!.attempts, 1);
  assert.equal(t!.errorReason, "provider 400");
});

test("F · a failure whose lease was taken over in flight touches nothing (fence preserved)", async () => {
  const f = await fixture(`p4-fence-${process.pid}-${Date.now()}`, 1);
  const sender = new ScriptedSender();
  sender.failures.set(f.jobs[0]!.idempotencyKey, retryable);
  const w = worker(sender, new Observer());
  const claimed = await w.claimPhoneBatch(f.phone.id, 1);
  const prepared = await w.prepareReservoirBatch(claimed);
  assert.equal(prepared.length, 1);
  // Between prepare and the provider call, recovery hands the lease to
  // another owner (what a reaper does after this process is presumed dead).
  await db.update(campaignJobsTable).set({ leaseToken: "another-owner", lockedBy: "another-worker" })
    .where(eq(campaignJobsTable.id, f.jobs[0]!.id));
  assert.ok(w.tryReserveSettlementSlot());
  void w.dispatchReservoirEnvelope(prepared[0]!, new Date(), true);
  assert.ok(await w.waitForIdle(10_000));

  const [job] = await jobRows(f.campaign.id);
  assert.equal(job!.status, "Processing", "the stale lease must not requeue a job it no longer owns");
  assert.equal(job!.leaseToken, "another-owner");
  assert.equal(job!.errorReason, null);
  assert.equal(job!.attempts, 1);
  assert.equal(pending(w), 0, "the slot is still released even when the fence rejects the write");
});

test("G · a process dying with failures queued loses nothing: the durable lease is recovered, the zombie batch is fenced", async () => {
  const f = await fixture(`p4-crash-${process.pid}-${Date.now()}`, 1);
  const sender = new ScriptedSender();
  sender.failures.set(f.jobs[0]!.idempotencyKey, retryable);
  const dying = worker(sender, new Observer(), 150);
  // The failure reaches the in-memory queue but the process never drains it.
  const originalPump = (dying as any).pumpFailedSettlements;
  (dying as any).pumpFailedSettlements = () => {};
  await dispatchAll(dying, f.phone.id, 1);
  assert.ok(await until(() => queued(dying) === 1), "the failure must be sitting in the queue");

  let [job] = await jobRows(f.campaign.id);
  assert.equal(job!.status, "Processing", "an in-memory queue is not a source of truth; PostgreSQL still shows the lease");
  const doomedLease = job!.leaseToken;
  assert.ok(doomedLease);

  await new Promise((r) => setTimeout(r, 300));
  await (new CampaignRuntime() as unknown as { reapExpiredLeases(now: Date): Promise<void> })
    .reapExpiredLeases(new Date(Date.now() + 60 * 60 * 1000));
  [job] = await jobRows(f.campaign.id);
  assert.equal(job!.status, "Queued", "lease expiry recovers the job exactly as a crash mid-send always has");
  assert.notEqual(job!.leaseToken, doomedLease);

  const recoveredSender = new ScriptedSender();
  const recovered = worker(recoveredSender, new Observer());
  await dispatchAll(recovered, f.phone.id, 1, new Date(Date.now() + 60 * 60 * 1000));
  assert.ok(await recovered.waitForIdle(10_000));
  [job] = await jobRows(f.campaign.id);
  assert.equal(job!.status, "Sent");
  assert.deepEqual(recoveredSender.calls, [f.jobs[0]!.idempotencyKey], "delivered exactly once after recovery");

  // The dead process's queue finally drains (a zombie): its stale lease must
  // affect zero rows.
  (dying as any).pumpFailedSettlements = originalPump;
  originalPump.call(dying);
  assert.ok(await dying.waitForIdle(10_000));
  [job] = await jobRows(f.campaign.id);
  assert.equal(job!.status, "Sent", "a zombie failure settlement against a superseded lease is fenced out");
  assert.equal(job!.errorReason, null);
  assert.equal(pending(dying), 0, "the zombie still releases its slots");
});

test("H · STOP / kill-switch aborts never enter the failure queue", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  // Killed before the provider call: the envelope is aborted at dispatch entry.
  const killedEarly = await fixture(`p4-kill-early-${stamp}`, 1);
  const observer = new Observer();
  const sender = new ScriptedSender();
  const w = worker(sender, observer);
  const claimed = await w.claimPhoneBatch(killedEarly.phone.id, 1);
  const prepared = await w.prepareReservoirBatch(claimed);
  inFlightRegistry.abortCampaign(killedEarly.campaign.id, "Campaign kill");
  assert.ok(w.tryReserveSettlementSlot());
  await w.dispatchReservoirEnvelope(prepared[0]!, new Date(), true);
  assert.deepEqual(sender.calls, [], "a killed campaign never reaches the provider");

  // Killed while the provider call is in flight: the failure is classified
  // as aborted, not as a retry.
  const killedMid = await fixture(`p4-kill-mid-${stamp}`, 1);
  sender.failures.set(killedMid.jobs[0]!.idempotencyKey, retryable);
  sender.onSend = (job) => inFlightRegistry.abortCampaign(job.campaignId, "Campaign kill");
  await dispatchAll(w, killedMid.phone.id, 1);
  assert.ok(await w.waitForIdle(10_000));

  assert.deepEqual(observer.failureBatches(), [], "aborts settle through settleAborted, never the batched failure path");
  assert.equal(queued(w), 0);
  for (const f of [killedEarly, killedMid]) {
    const [job] = await jobRows(f.campaign.id);
    assert.notEqual(job!.status, "Processing", "an aborted job must not be left leased");
    assert.notEqual(job!.status, "Failed", "an abort is not a provider failure");
    assert.equal(job!.leaseToken, null);
  }
  assert.equal(pending(w), 0);
});

test("I · shutdown drains every queued failure before reporting idle", async () => {
  const f = await fixture(`p4-drain-${process.pid}-${Date.now()}`, 30);
  const sender = new ScriptedSender();
  for (const job of f.jobs) sender.failures.set(job.idempotencyKey, retryable);
  const w = worker(sender, new Observer());
  await dispatchAll(w, f.phone.id, 30);
  // No settling has been awaited; this is exactly what CampaignRuntime.stop()
  // relies on.
  const idle = await w.waitForIdle(15_000);
  assert.equal(idle, true, "waitForIdle must not return before queued failures are durable");
  assert.equal(queued(w), 0);
  assert.equal(pending(w), 0);
  const rows = await jobRows(f.campaign.id);
  assert.equal(rows.filter((j) => j.status === "Queued" && j.leaseToken === null).length, 30);
});

test("J · no failure settlement is ever lost under load", async () => {
  const f = await fixture(`p4-lossless-${process.pid}-${Date.now()}`, 200);
  const sender = new ScriptedSender();
  for (const job of f.jobs) sender.failures.set(job.idempotencyKey, retryable);
  const observer = new Observer();
  const w = worker(sender, observer);
  await dispatchAll(w, f.phone.id, 200);
  assert.ok(await w.waitForIdle(30_000));

  const rows = await jobRows(f.campaign.id);
  assert.equal(rows.length, 200);
  assert.equal(rows.filter((j) => j.status === "Queued").length, 200, "every failure is durably requeued");
  assert.ok(rows.every((j) => j.leaseToken === null && j.errorReason === "provider 503"));
  const batches = observer.failureBatches();
  assert.equal(batches.reduce((s, b) => s + b.jobs, 0), 200, "each failure settled exactly once");
  assert.ok(batches.length < 200, `expected bounded batches, got ${batches.length}`);
  assert.ok(batches.every((b) => b.jobs <= 256), "no batch exceeds the bound");
  assert.equal(pending(w), 0, "slot accounting is balanced");
  assert.equal(queued(w), 0);
});
