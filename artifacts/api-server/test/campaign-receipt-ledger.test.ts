/*
 * B13 R7: duplicate delivery is measured, not inferred. A permanent regression for at-most-once delivery across a
 * real SIGKILL: the campaign runtime runs as its own OS process (worker-process-harness.ts), is killed while sends
 * are genuinely in flight, and a fresh process recovers the backlog. Every provider receipt (the mock provider's
 * own cross-process log, written at the provider call) is reconciled against the job rows and provider intents
 * (receipt-ledger.ts): no job may be delivered twice, no Sent job may lack a receipt, no definite failure may have
 * been delivered, nothing may stay open, and delivery-unknown outcomes are split into delivered once / not
 * delivered. A negative control proves the reconciliation detects a duplicate. Mock provider only.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { build } from "esbuild";
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
import { parseProviderLog, reconcileReceipts, type ReconciledJob } from "./receipt-ledger";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const redisUrl = process.env.CAMPAIGN_TEST_REDIS_URL;
let harnessDir: string;
let harnessPath: string;
let workDir: string;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "receipt-ledger-"));
  harnessDir = path.join(artifactDir, ".test-dist", "receipt-ledger-harness");
  harnessPath = path.join(harnessDir, "worker-process-harness.mjs");
  await rm(harnessDir, { recursive: true, force: true });
  const common = {
    bundle: true, platform: "node" as const, format: "esm" as const, sourcemap: "inline" as const,
    external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
  };
  await build({ ...common, entryPoints: [path.join(artifactDir, "test", "worker-process-harness.ts")], outfile: harnessPath });
  await build({ ...common, entryPoints: [path.join(artifactDir, "src/services/campaign-transport-shard-worker.ts")], outfile: path.join(harnessDir, "campaign-transport-shard-worker.mjs") });
});

after(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (harnessDir) await rm(harnessDir, { recursive: true, force: true });
  await pool.end();
});

const job = (jobId: number, status: string, extra: Partial<ReconciledJob> = {}): ReconciledJob =>
  ({ jobId, key: `+1${jobId}`, status, attempts: 1, errorReason: null, intentStatus: null, ...extra });

test("ledger · malformed nonempty provider receipts fail closed instead of disappearing", () => {
  assert.throws(
    () => parseProviderLog('{"payload":{"to":""}}\n'),
    /Provider receipt at line 1 has no recipient/,
  );
  assert.throws(
    () => parseProviderLog('{"payload":{}}\n'),
    /Provider receipt at line 1 has no recipient/,
  );
  assert.deepEqual(parseProviderLog("\n  \n"), []);
});

test("ledger · classifies every outcome, and a duplicate receipt is always detected", () => {
  const unknown = "Provider delivery is unknown; manual reconciliation is required";
  const jobs = [
    job(1, "Sent"), job(2, "Sent"), job(3, "Failed", { errorReason: unknown }), job(4, "Failed", { errorReason: unknown }),
    job(5, "Failed", { errorReason: "Recipient is on the suppression list (STOP)" }), job(6, "Processing"),
  ];
  const receipts = [{ key: "+11", line: 1 }, { key: "+13", line: 2 }];
  const result = reconcileReceipts(receipts, jobs);
  assert.deepEqual(result.byClass, {
    sent_once: 1, unknown_delivered_once: 1, unknown_not_delivered: 1, failed_not_delivered: 1,
    DUPLICATE_DELIVERY: 0, SENT_WITHOUT_RECEIPT: 1, FAILED_BUT_DELIVERED: 0, OPEN: 1,
  });
  assert.equal(result.clean, false, "a Sent job without a receipt and an open job are anomalies");
  const duplicated = reconcileReceipts([...receipts, { key: "+11", line: 3 }], [job(1, "Sent"), job(3, "Failed", { errorReason: unknown })]);
  assert.equal(duplicated.byClass.DUPLICATE_DELIVERY, 1);
  assert.equal(duplicated.duplicates[0]!.job.jobId, 1);
  assert.equal(duplicated.clean, false);
  assert.deepEqual(reconcileReceipts([{ key: "+19", line: 1 }], [job(1, "Failed")]).orphanKeys, ["+19"], "a receipt for no job is reported");
});

function spawnHarness(env: Record<string, string | undefined>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath], { cwd: artifactDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("WORKER_HARNESS_READY")) { child.stdout?.off("data", onData); resolve(child); }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`harness exited before ready (code=${code}, signal=${signal})`)));
  });
}
const killed = (child: ChildProcess) => new Promise<NodeJS.Signals | null>((resolve) => { child.once("exit", (_c, s) => resolve(s)); child.kill("SIGKILL"); });
async function until<T>(check: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function fixture(slug: string, count: number, tps: number, phoneCount = 1) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const phones = await db.insert(phoneNumbersTable).values(Array.from({ length: phoneCount }, (_, p) => ({
    organizationId: organization!.id, wabaId: waba!.id, phone: `+1559${organization!.id.toString().padStart(6, "0")}${p}`,
    displayName: `${slug}-${p}`, status: "Connected" as const, tpsLimit: tps,
  }))).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${slug}-t`, status: "Approved", language: "en_US",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: slug, status: "Running" }).returning();
  const routes = await db.insert(campaignRoutesTable).values(phones.map((phone) => ({
    organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone.id, templateId: template!.id, configuredTps: tps,
    queueDepth: Math.ceil(count / phoneCount),
  }))).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id, component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total: count, valid: count, queued: count });
  // The organization id, unpadded, then a separator digit 9: recipients of different organizations never collide.
  const prefix = `+1996${organization!.id}9`;
  const contacts = [];
  for (let start = 0; start < count; start += 2_000) {
    contacts.push(...await db.insert(campaignContactsTable).values(Array.from({ length: Math.min(2_000, count - start) }, (_, j) => {
      const i = start + j;
      return {
        organizationId: organization!.id, campaignId: campaign!.id, rowNumber: i + 1, rawPhone: `${prefix}${i.toString().padStart(5, "0")}`,
        normalizedPhone: `${prefix}${i.toString().padStart(5, "0")}`, status: "Valid" as const, routeId: routes[i % phoneCount]!.id, partitionKey: 1,
        idempotencyKey: `${slug}-c${i}`, data: {},
      };
    })).returning({ id: campaignContactsTable.id, phone: campaignContactsTable.normalizedPhone, routeId: campaignContactsTable.routeId }));
  }
  for (let start = 0; start < contacts.length; start += 2_000) {
    await db.insert(campaignJobsTable).values(contacts.slice(start, start + 2_000).map((contact, j) => ({
      organizationId: organization!.id, campaignId: campaign!.id, routeId: contact.routeId!, contactId: contact.id,
      type: "ResolveTemplateAndSend" as const, idempotencyKey: `${slug}-j${start + j}`,
    })));
  }
  return { organization: organization!, campaign: campaign!, prefix, phoneByContact: new Map(contacts.map((c) => [c.id, c.phone])) };
}

async function reconcileCampaign(f: Awaited<ReturnType<typeof fixture>>, receipts: ReturnType<typeof parseProviderLog>) {
  const rows = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, f.campaign.id));
  const intents = await db.select({ jobId: providerMessagesTable.campaignJobId, status: providerMessagesTable.status })
    .from(providerMessagesTable).where(inArray(providerMessagesTable.campaignJobId, rows.map((row) => row.id)));
  const intentByJob = new Map(intents.map((intent) => [intent.jobId, intent.status]));
  const reconciledJobs: ReconciledJob[] = rows.map((row) => ({
    jobId: row.id, key: f.phoneByContact.get(row.contactId!)!, status: row.status, attempts: row.attempts,
    errorReason: row.errorReason, intentStatus: intentByJob.get(row.id) ?? null,
  }));
  return { reconciledJobs, result: reconcileReceipts(receipts, reconciledJobs) };
}

test("no fault, at outcome-capacity pressure · every job is Sent with exactly one receipt; nothing fails for manual reconciliation", {
  skip: redisUrl ? false : "CAMPAIGN_TEST_REDIS_URL is required for the runtime process's Redis coordinator",
  timeout: 240_000,
}, async () => {
  // Four phones at 1,000/s each keep more prepared work in their lanes than the sender's 4,096 durable-outcome
  // slots: the condition that, on 2884382f, requeued whole batches with pending intents and then failed them for
  // manual reconciliation at re-preparation (B13 T2: 0.3-2.6% of a no-fault run). Here nothing is killed, so
  // every job must be Sent: no delivery-unknown or manual-reconciliation outcome is acceptable.
  const PHONES = 4;
  const COUNT = 10_000;
  const slug = `nofault-${process.pid}-${Date.now()}`;
  const f = await fixture(slug, COUNT, 1_000, PHONES);
  const log = path.join(workDir, `${slug}.log`);
  let runtime: ChildProcess | undefined;
  try {
    runtime = await spawnHarness({
      CAMPAIGN_TEST_PROVIDER_LOG: log, CAMPAIGN_COORDINATOR_MODE: "redis", CAMPAIGN_REDIS_URL: redisUrl, WORKER_INTERVAL_MS: "20",
    });
    await until(async () => {
      const [open] = await db.select({ id: campaignJobsTable.id }).from(campaignJobsTable)
        .where(and(eq(campaignJobsTable.campaignId, f.campaign.id), inArray(campaignJobsTable.status, ["Queued", "Processing"]))).limit(1);
      return open ? undefined : true;
    }, 200_000, "every job terminal");
    const receipts = parseProviderLog(await readFile(log, "utf8").catch(() => "")).filter((receipt) => receipt.key.startsWith(f.prefix));
    const { result } = await reconcileCampaign(f, receipts);
    console.log(`[receipt-ledger no-fault] ${JSON.stringify({ receipts: result.receipts, ...result.byClass, orphans: result.orphanKeys.length })}`);
    assert.equal(result.byClass.sent_once, COUNT, `every job Sent exactly once: ${JSON.stringify(result.byClass)}`);
    assert.equal(result.receipts, COUNT);
    assert.ok(result.clean);
  } finally {
    if (runtime) {
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => runtime!.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => { runtime!.kill("SIGTERM"); setTimeout(() => resolve(false), 5_000); }),
      ]);
      if (!exited) { try { runtime.kill("SIGKILL"); } catch { /* gone */ } }
    }
    await db.update(campaignsTable).set({ status: "Cancelled" }).where(eq(campaignsTable.id, f.campaign.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, f.organization.id));
  }
});

test("SIGKILL mid-campaign · every provider receipt reconciles: no duplicate delivery, nothing sent without a receipt", {
  skip: redisUrl ? false : "CAMPAIGN_TEST_REDIS_URL is required to share the pacing coordinator across OS processes",
  timeout: 180_000,
}, async () => {
  const COUNT = 160;
  const slug = `receipts-${process.pid}-${Date.now()}`;
  const f = await fixture(slug, COUNT, 40);
  const log = path.join(workDir, `${slug}.log`);
  const env = { CAMPAIGN_TEST_PROVIDER_LOG: log, CAMPAIGN_COORDINATOR_MODE: "redis", CAMPAIGN_REDIS_URL: redisUrl, WORKER_INTERVAL_MS: "50", BROKER_ABANDONED_DELIVERY_MS: "1200" };
  const ours = async () => parseProviderLog(await readFile(log, "utf8").catch(() => "")).filter((receipt) => receipt.key.startsWith(f.prefix));
  let a: ChildProcess | undefined;
  let b: ChildProcess | undefined;
  try {
    // A short lease so recovery does not wait 30 s; one send held 5 s at the provider so the kill lands mid-call.
    a = await spawnHarness({ ...env, WORKER_LEASE_MS: "1500", CAMPAIGN_TEST_PROVIDER_DELAY_ONCE_MS: "5000" });
    await until(async () => ((await ours()).length >= 30 ? true : undefined), 30_000, "30 receipts from the first process");
    assert.equal(await killed(a), "SIGKILL");
    a = undefined;
    await new Promise((resolve) => setTimeout(resolve, 1_800)); // let the dead leases expire
    b = await spawnHarness({ ...env, WORKER_LEASE_MS: "5000" });
    const rows = await until(async () => {
      const current = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, f.campaign.id));
      return current.every((row) => row.status === "Sent" || row.status === "Failed") ? current : undefined;
    }, 120_000, "every job terminal after recovery");
    const intents = await db.select({ jobId: providerMessagesTable.campaignJobId, status: providerMessagesTable.status })
      .from(providerMessagesTable).where(inArray(providerMessagesTable.campaignJobId, rows.map((row) => row.id)));
    const intentByJob = new Map(intents.map((intent) => [intent.jobId, intent.status]));
    const reconciledJobs: ReconciledJob[] = rows.map((row) => ({
      jobId: row.id, key: f.phoneByContact.get(row.contactId!)!, status: row.status, attempts: row.attempts,
      errorReason: row.errorReason, intentStatus: intentByJob.get(row.id) ?? null,
    }));
    const receipts = await ours();
    const result = reconcileReceipts(receipts, reconciledJobs);
    console.log(`[receipt-ledger] ${JSON.stringify({ receipts: result.receipts, ...result.byClass, orphans: result.orphanKeys.length })}`);
    assert.equal(result.byClass.DUPLICATE_DELIVERY, 0, `no job delivered twice: ${JSON.stringify(result.duplicates.slice(0, 3))}`);
    assert.equal(result.byClass.SENT_WITHOUT_RECEIPT, 0, "every Sent job reached the provider");
    assert.equal(result.byClass.FAILED_BUT_DELIVERED, 0, "no definite failure was delivered");
    assert.equal(result.byClass.OPEN, 0);
    assert.deepEqual(result.orphanKeys, []);
    assert.ok(result.clean);
    assert.equal(result.receipts, result.byClass.sent_once + result.byClass.unknown_delivered_once, "every receipt is accounted for exactly once");
    // Every job is accounted for: Sent with its one receipt, or failed closed as delivery-unknown (the killed
    // process's in-flight and prepared lookahead, which may or may not have reached the provider; the receipts
    // split them). No job fails for any other reason.
    assert.equal(result.byClass.failed_not_delivered, 0, "no definite failure");
    assert.equal(result.byClass.sent_once + result.byClass.unknown_delivered_once + result.byClass.unknown_not_delivered, COUNT);
    assert.ok(result.byClass.sent_once > 0 && result.byClass.unknown_delivered_once + result.byClass.unknown_not_delivered > 0,
      "the kill landed mid-campaign: some work was sent, some was in flight");
    // Negative control: the same reconciliation on a copy with one receipt repeated must report it.
    const control = reconcileReceipts([...receipts, { ...receipts[0]!, line: receipts.length + 1 }], reconciledJobs);
    assert.equal(control.byClass.DUPLICATE_DELIVERY, 1, "the reconciliation detects an injected duplicate");
  } finally {
    if (a) { try { a.kill("SIGKILL"); } catch { /* gone */ } }
    if (b) {
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => b!.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => { b!.kill("SIGTERM"); setTimeout(() => resolve(false), 3_000); }),
      ]);
      if (!exited) { try { b.kill("SIGKILL"); } catch { /* gone */ } }
    }
    await db.update(campaignsTable).set({ status: "Cancelled" }).where(and(eq(campaignsTable.id, f.campaign.id), eq(campaignsTable.organizationId, f.organization.id)));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, f.organization.id));
  }
});
