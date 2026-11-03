/*
 * Cross-cell characterization: what TODAY's code guarantees when a control action (pause, emergency kill,
 * inbound STOP) is served by a different cell from the one sending the work.
 *
 * Two isolated runtime cells run as separate OS processes from test/worker-process-harness.ts, each scoped
 * to one phone (CAMPAIGN_TRANSPORT_PHONE_IDS) with its own in-flight registry, reservoir and transport
 * shards. They share only PostgreSQL and the test Redis (coordinator, ownership and broker), as production
 * cells share Host S. The test process plays the cell that served the request: it calls the real lifecycle
 * handler and the real opt-out processor, and its own in-flight registry holds nothing, so for both runtime
 * cells every action is cross-cell and reaches them only through PostgreSQL.
 *
 * These tests change no sending behaviour. They pin the current safety properties (no duplicate provider
 * dispatch, a bounded window, correct terminal states) and measure the cross-cell window that the proposed
 * dispatch-authorization design would close; its acceptance tests are separate and are not part of this
 * suite. Sends go to the mock provider only (no sending credential, mock workspace) and are observed
 * through CAMPAIGN_TEST_PROVIDER_LOG, which each cell's shard worker appends to on every completed send.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { and, eq, inArray } from "drizzle-orm";
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
import campaignEngineRouter from "../src/routes/campaign-engine";
import { processWhatsAppOptOut } from "../src/services/whatsapp-webhook";
import { PACING_LOOKAHEAD_MS, PACING_PREPARE_MS } from "../src/services/campaign-queue";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const redisUrl = process.env.CAMPAIGN_TEST_REDIS_URL;
const skip = redisUrl ? false : "CAMPAIGN_TEST_REDIS_URL is required: separate cells share the Redis coordinator and broker";

const TPS = 10;
const LEASE_MS = 9_000;
const INTERVAL_MS = 100;
/**
 * Today's cross-cell bound, from a control commit to the last provider start of revoked work on the other
 * cell: the queued re-check runs on the renewal pass (leaseMs / 3), a tick later at most, and work already
 * in transport pacing (lookahead plus prepare horizon) is never re-checked; plus slack for CI.
 */
const B_TODAY_MS = LEASE_MS / 3 + Math.min(INTERVAL_MS, 200) + PACING_LOOKAHEAD_MS + PACING_PREPARE_MS + 1_500;

let harnessPath: string;
let harnessDistDir: string;
let workDir: string;

before(async () => {
  if (skip) return;
  workDir = await mkdtemp(path.join(tmpdir(), "cross-cell-"));
  // Inside the package, as campaign-worker-os-crash-recovery.test.ts explains: externalized bare specifiers
  // resolve from the bundle's own path.
  harnessDistDir = path.join(artifactDir, ".test-dist", "cross-cell-harness");
  harnessPath = path.join(harnessDistDir, "worker-process-harness.mjs");
  await rm(harnessDistDir, { recursive: true, force: true });
  const banner = { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" };
  const external = ["pg-native", "pino", "pino-pretty", "thread-stream"];
  await build({
    entryPoints: [path.join(artifactDir, "test", "worker-process-harness.ts")],
    outfile: harnessPath, bundle: true, platform: "node", format: "esm", sourcemap: "inline", external, banner,
  });
  await build({
    entryPoints: [path.join(artifactDir, "src/services/campaign-transport-shard-worker.ts")],
    outfile: path.join(harnessDistDir, "campaign-transport-shard-worker.mjs"),
    bundle: true, platform: "node", format: "esm", sourcemap: "inline", external, banner,
  });
});

after(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (harnessDistDir) await rm(harnessDistDir, { recursive: true, force: true });
  await pool.end();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRouteHandler(router: any, routePath: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler registered for ${method.toUpperCase()} ${routePath}`);
}

/** The real lifecycle handler, as the serving cell runs it (its in-flight registry here is empty). */
async function campaignAction(organizationId: number, campaignId: number, action: "pause" | "emergency-kill") {
  const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/actions", "post");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  await handler({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body: { action }, authUser: undefined }, res, () => {});
  assert.equal(res.statusCode, 200, `${action} must be applied: ${JSON.stringify(res.body)}`);
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/**
 * One mock-mode organization with phones PA and PB (tpsLimit = route TPS), and two Running campaigns, each
 * with a route on both phones. C2 keeps both lanes discovered after C1 is paused or killed, so a lane drop
 * cannot stand in for the re-check being characterized.
 */
async function createFixture(slug: string, jobsPerRoute: number, campaignCount = 2) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const phones = [];
  for (const label of ["pa", "pb"]) {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization!.id, wabaId: waba!.id, phone: `+1556${organization!.id.toString().padStart(6, "0")}${label === "pa" ? 1 : 2}`,
      displayName: `${slug}-${label}`, status: "Connected", tpsLimit: TPS, providerPhoneId: `test-${label}-${slug}`,
    }).returning();
    phones.push(phone!);
  }
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${slug}-template`, status: "Approved", language: "en_US",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const campaigns = [];
  /** recipient -> { campaign index, phone index, job id } */
  const recipients = new Map<string, { campaign: number; phone: number; jobId: number }>();
  let serial = 0;
  for (let c = 0; c < campaignCount; c += 1) {
    const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: `${slug}-c${c + 1}`, status: "Running" }).returning();
    await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
    await db.insert(campaignTemplateMappingsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id,
      component: "body", variable: "1", source: "static", sourceValue: "World",
    });
    await db.insert(campaignMetricsTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, total: 2 * jobsPerRoute, valid: 2 * jobsPerRoute, queued: 2 * jobsPerRoute,
    });
    const routes = [];
    for (const [p, phone] of phones.entries()) {
      const [route] = await db.insert(campaignRoutesTable).values({
        organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone.id, templateId: template!.id,
        configuredTps: TPS, queueDepth: jobsPerRoute,
      }).returning();
      routes.push(route!);
      const numbers = Array.from({ length: jobsPerRoute }, () => {
        serial += 1;
        return `+1999${organization!.id.toString().padStart(4, "0")}${serial.toString().padStart(5, "0")}`;
      });
      const contacts = await db.insert(campaignContactsTable).values(numbers.map((recipient, index) => ({
        organizationId: organization!.id, campaignId: campaign!.id, rowNumber: p * jobsPerRoute + index + 1,
        rawPhone: recipient, normalizedPhone: recipient, data: {}, status: "Valid" as const, routeId: route!.id,
        idempotencyKey: `${slug}-c${c}-p${p}-contact-${index}`,
      }))).returning();
      // Available on the app clock (see campaign-suppression-batch-scope.test.ts for why not now()).
      const jobs = await db.insert(campaignJobsTable).values(contacts.map((contact, index) => ({
        organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id, contactId: contact.id,
        type: "ResolveTemplateAndSend" as const, idempotencyKey: `${slug}-c${c}-p${p}-send-${index}`, availableAt: new Date(),
      }))).returning({ id: campaignJobsTable.id });
      jobs.forEach((job, index) => recipients.set(numbers[index]!, { campaign: c, phone: p, jobId: job.id }));
    }
    campaigns.push({ campaign: campaign!, routes });
  }
  return { organization: organization!, phones, campaigns, recipients };
}

type AuditLine = { recipient: string; at: number; pid: number; campaign: number; phone: number };

function readAudit(file: string, fixture: Fixture): AuditLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    const entry = JSON.parse(line) as { payload: { to?: string }; at: number; pid: number };
    const owner = entry.payload.to ? fixture.recipients.get(entry.payload.to) : undefined;
    return owner ? [{ recipient: entry.payload.to!, at: entry.at, pid: entry.pid, campaign: owner.campaign, phone: owner.phone }] : [];
  });
}

function spawnCell(env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath], { cwd: artifactDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("WORKER_HARNESS_READY")) {
        child.stdout?.off("data", onData);
        child.removeAllListeners("exit");
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`cell exited before becoming ready (code=${code}, signal=${signal})`)));
  });
}

async function stopCell(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function pollUntil(check: () => Promise<boolean> | boolean, timeoutMs: number, description: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
    await sleep(50);
  }
}

/**
 * Starts one cell per phone, runs `body`, and always stops the cells and removes the fixture. The cells'
 * stdout is drained so a chatty cell cannot block on a full pipe.
 */
async function withCells(
  slug: string,
  jobsPerRoute: number,
  body: (fixture: Fixture, audit: string) => Promise<void>,
  campaignCount = 2,
) {
  const fixture = await createFixture(slug, jobsPerRoute, campaignCount);
  const audit = path.join(workDir, `${slug}-audit.log`);
  const cells: ChildProcess[] = [];
  try {
    for (const phone of fixture.phones) {
      const cell = await spawnCell({
        WORKER_INTERVAL_MS: String(INTERVAL_MS),
        WORKER_LEASE_MS: String(LEASE_MS),
        BROKER_ABANDONED_DELIVERY_MS: "5000",
        CAMPAIGN_COORDINATOR_MODE: "redis",
        CAMPAIGN_REDIS_URL: redisUrl!,
        CAMPAIGN_TRANSPORT_SHARDS: "2",
        CAMPAIGN_TRANSPORT_PHONE_IDS: String(phone.id),
        CAMPAIGN_TEST_PROVIDER_LOG: audit,
      });
      cell.stdout?.resume();
      cells.push(cell);
    }
    await body(fixture, audit);
  } finally {
    await Promise.all(cells.map((cell) => stopCell(cell)));
    await db.update(campaignsTable).set({ status: "Cancelled" }).where(inArray(campaignsTable.id, fixture.campaigns.map(({ campaign }) => campaign.id)));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
}

const jobsOf = (campaignId: number) => db.select({
  id: campaignJobsTable.id, status: campaignJobsTable.status, attempts: campaignJobsTable.attempts,
  leaseToken: campaignJobsTable.leaseToken, errorReason: campaignJobsTable.errorReason,
}).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId));

/** At least `count` sends of campaign `c` on each phone, so the control action lands on live work. */
async function waitForTraffic(audit: string, fixture: Fixture, c: number, count: number) {
  await pollUntil(() => {
    const lines = readAudit(audit, fixture).filter((line) => line.campaign === c);
    return [0, 1].every((p) => lines.filter((line) => line.phone === p).length >= count);
  }, 20_000, `${count} sends of C${c + 1} on each phone`);
}

/** No job of the campaign leased, and the audit file unchanged for a second. */
async function quiesce(audit: string, fixture: Fixture, campaignId: number, timeoutMs: number) {
  let lastSize = -1;
  let stableSince = Date.now();
  await pollUntil(async () => {
    const size = existsSync(audit) ? readFileSync(audit).length : 0;
    if (size !== lastSize) { lastSize = size; stableSince = Date.now(); }
    const leased = (await jobsOf(campaignId)).some((job) => job.status === "Processing");
    return !leased && Date.now() - stableSince >= 1_000;
  }, timeoutMs, "the campaign's work to settle");
}

function assertNoDuplicateDispatch(lines: AuditLine[]) {
  const seen = new Map<string, number>();
  for (const line of lines) seen.set(line.recipient, (seen.get(line.recipient) ?? 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1);
  assert.deepEqual(duplicates, [], "no recipient may reach the provider more than once");
}

test("baseline: two healthy cells send every job exactly once, within the per-phone rate cap", { skip }, async () => {
  await withCells(`xcell-base-${process.pid}-${Date.now()}`, 20, async (fixture, audit) => {
    const ids = fixture.campaigns.map(({ campaign }) => campaign.id);
    await pollUntil(async () => (await Promise.all(ids.map(jobsOf))).flat().every((job) => job.status === "Sent"), 40_000, "every job Sent");
    await sleep(500);
    const lines = readAudit(audit, fixture);
    assert.equal(lines.length, fixture.recipients.size, "one provider call per job");
    assertNoDuplicateDispatch(lines);
    for (const job of (await Promise.all(ids.map(jobsOf))).flat()) assert.equal(job.attempts, 1, `job ${job.id} claimed once`);
    for (const p of [0, 1]) {
      const times = lines.filter((line) => line.phone === p).map((line) => line.at).sort((a, b) => a - b);
      const pids = new Set(lines.filter((line) => line.phone === p).map((line) => line.pid));
      assert.equal(pids.size, 1, `phone ${p} is sent by exactly one cell`);
      let maxInSecond = 0;
      for (let i = 0, j = 0; j < times.length; j += 1) {
        while (times[j]! - times[i]! >= 1_000) i += 1;
        maxInSecond = Math.max(maxInSecond, j - i + 1);
      }
      // Rolling cap of TPS per second (campaign-shard-pacing.ts), plus one for timestamp granularity.
      assert.ok(maxInSecond <= TPS + 1, `phone ${p}: ${maxInSecond} sends within one second (cap ${TPS})`);
    }
  });
});

test("cross-cell pause: the other cell stops within today's bound, never sends twice, and requeues the rest", { skip }, async () => {
  await withCells(`xcell-pause-${process.pid}-${Date.now()}`, 120, async (fixture, audit) => {
    const [c1, c2] = fixture.campaigns.map(({ campaign }) => campaign);
    await waitForTraffic(audit, fixture, 0, 5);
    await campaignAction(fixture.organization.id, c1!.id, "pause");
    const committedAt = Date.now();
    await sleep(B_TODAY_MS);
    await quiesce(audit, fixture, c1!.id, 20_000);
    const lines = readAudit(audit, fixture);
    const c1After = lines.filter((line) => line.campaign === 0 && line.at > committedAt);
    const lastLatency = c1After.length ? Math.max(...c1After.map((line) => line.at)) - committedAt : 0;
    console.log(`# cross-cell pause: ${c1After.length} C1 sends after the pause commit, the last ${lastLatency} ms after it (bound ${B_TODAY_MS} ms)`);
    assert.deepEqual(c1After.filter((line) => line.at > committedAt + B_TODAY_MS), [], "no C1 send after today's bound");
    // The gap the dispatch-authorization design closes: work the other cell already had in its lane queue or
    // transport pacing still reaches the provider after the pause committed. Flip when that design lands.
    assert.ok(c1After.some((line) => line.at > committedAt + 1_000), "today, C1 work is still sent more than 1 s after a cross-cell pause");
    assertNoDuplicateDispatch(lines);
    const statuses = new Set((await jobsOf(c1!.id)).map((job) => job.status));
    assert.deepEqual([...statuses].filter((status) => status !== "Sent" && status !== "Queued"), [],
      "C1 jobs are only Sent or requeued: none Failed, Cancelled or left leased");
    for (const job of await jobsOf(c1!.id)) if (job.status === "Queued") assert.equal(job.leaseToken, null);
    // The other campaign on the same phones is not touched.
    const c2Late = lines.filter((line) => line.campaign === 1 && line.at > committedAt + B_TODAY_MS);
    assert.ok([0, 1].every((p) => c2Late.some((line) => line.phone === p)), "C2 keeps sending on both phones");
    assert.ok((await jobsOf(c2!.id)).every((job) => job.status !== "Failed" && job.status !== "Cancelled"));
  });
});

test("cross-cell emergency kill: the other cell stops within today's bound and the rest is cancelled, never sent twice", { skip }, async () => {
  await withCells(`xcell-kill-${process.pid}-${Date.now()}`, 120, async (fixture, audit) => {
    const [c1, c2] = fixture.campaigns.map(({ campaign }) => campaign);
    await waitForTraffic(audit, fixture, 0, 5);
    await campaignAction(fixture.organization.id, c1!.id, "emergency-kill");
    const committedAt = Date.now();
    await sleep(B_TODAY_MS);
    await quiesce(audit, fixture, c1!.id, 20_000);
    const lines = readAudit(audit, fixture);
    const c1After = lines.filter((line) => line.campaign === 0 && line.at > committedAt);
    console.log(`# cross-cell kill: ${c1After.length} C1 sends after the kill commit, the last ${c1After.length ? Math.max(...c1After.map((l) => l.at)) - committedAt : 0} ms after it`);
    assert.deepEqual(c1After.filter((line) => line.at > committedAt + B_TODAY_MS), [], "no C1 send after today's bound");
    assertNoDuplicateDispatch(lines);
    const [killed] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, c1!.id));
    assert.equal(killed?.killSwitch, true);
    for (const job of await jobsOf(c1!.id)) {
      assert.ok(job.status === "Sent" || job.status === "Cancelled", `C1 job ${job.id} is ${job.status}`);
      if (job.status === "Cancelled") assert.equal(job.errorReason, "Emergency kill");
    }
    assert.ok((await jobsOf(c2!.id)).every((job) => job.status !== "Failed" && job.status !== "Cancelled"), "C2 untouched");
  });
});

test("cross-cell STOP: a recipient not yet claimed is never sent; one already claimed is sent at most once, within today's bound", { skip }, async () => {
  await withCells(`xcell-stop-${process.pid}-${Date.now()}`, 60, async (fixture, audit) => {
    const [c1] = fixture.campaigns.map(({ campaign }) => campaign);
    await waitForTraffic(audit, fixture, 0, 5);
    const pa = fixture.phones[0]!;
    const c1OnPa = [...fixture.recipients].filter(([, owner]) => owner.campaign === 0 && owner.phone === 0).map(([recipient, owner]) => ({ recipient, ...owner }));
    const jobs = new Map((await jobsOf(c1!.id)).map((job) => [job.id, job]));
    const sentSoFar = new Set(readAudit(audit, fixture).map((line) => line.recipient));
    // Far: still Queued (never claimed, so never prepared) when the STOP arrives. Near: already claimed.
    const far = c1OnPa.filter(({ recipient, jobId }) => jobs.get(jobId)?.status === "Queued" && !sentSoFar.has(recipient)).slice(-3);
    const near = c1OnPa.filter(({ recipient, jobId }) => jobs.get(jobId)?.status === "Processing" && !sentSoFar.has(recipient)).slice(0, 2);
    assert.equal(far.length, 3, "three unclaimed recipients to STOP");
    for (const { recipient } of [...far, ...near]) {
      const outcome = await processWhatsAppOptOut({
        eventId: `stop-${recipient}`, phoneNumberId: pa.providerPhoneId!, from: recipient.slice(1), text: "STOP", occurredAt: new Date(),
      });
      assert.equal(outcome, "suppressed");
    }
    const committedAt = Date.now();
    // The far recipients' jobs are claimed and prepared later, where preparation screens the suppression.
    await pollUntil(async () => {
      const rows = await db.select({ status: campaignJobsTable.status }).from(campaignJobsTable)
        .where(inArray(campaignJobsTable.id, far.map(({ jobId }) => jobId)));
      return rows.every((row) => row.status === "Failed");
    }, 60_000, "the STOPped unclaimed recipients' jobs to fail at preparation");
    await sleep(Math.max(0, committedAt + B_TODAY_MS - Date.now()));
    const lines = readAudit(audit, fixture);
    for (const { recipient } of far) assert.equal(lines.filter((line) => line.recipient === recipient).length, 0, `${recipient} must never be sent`);
    for (const { recipient } of near) {
      const sends = lines.filter((line) => line.recipient === recipient);
      assert.ok(sends.length <= 1, `${recipient} at most once`);
      if (sends.length) console.log(`# cross-cell STOP: already-claimed recipient sent ${sends[0]!.at - committedAt} ms after the STOP commit`);
      assert.ok(sends.every((line) => line.at <= committedAt + B_TODAY_MS), "within today's bound");
    }
    const failed = await db.select({ errorReason: campaignJobsTable.errorReason }).from(campaignJobsTable)
      .where(and(inArray(campaignJobsTable.id, far.map(({ jobId }) => jobId)), eq(campaignJobsTable.status, "Failed")));
    assert.ok(failed.every((row) => /suppression/i.test(row.errorReason ?? "")), JSON.stringify(failed));
    assertNoDuplicateDispatch(lines);
  });
});

// Acceptance test for defect D1 (docs/CROSS_CELL_DISPATCH_AUTHORIZATION.md), recorded as `todo` until its fix,
// a sending-behaviour change, is approved: it fails today and does not fail the suite. When a cross-cell
// pause leaves the other cell with no Running campaign on a phone, that cell drops the lane; the shard
// worker cancels the lane's paced backlog before start, but the parent registration was never aborted, so
// dispatch takes the failure path and settles the never-sent jobs Failed ("Send aborted before provider
// start", not retryable) instead of requeueing them for resume. Observed: 45 of 240 jobs.
test("cross-cell pause of a phone's only campaign requeues the other cell's unstarted work, never fails it (D1)", {
  skip,
  todo: skip ? undefined : "D1: unstarted work cancelled by a lane drop is settled Failed today; fix awaits approval",
}, async () => {
  await withCells(`xcell-d1-${process.pid}-${Date.now()}`, 120, async (fixture, audit) => {
    const [c1] = fixture.campaigns.map(({ campaign }) => campaign);
    await waitForTraffic(audit, fixture, 0, 5);
    await campaignAction(fixture.organization.id, c1!.id, "pause");
    await sleep(B_TODAY_MS);
    await quiesce(audit, fixture, c1!.id, 20_000);
    assertNoDuplicateDispatch(readAudit(audit, fixture));
    const failed = (await jobsOf(c1!.id)).filter((job) => job.status === "Failed");
    console.log(`# D1: ${failed.length} C1 jobs Failed after the cross-cell pause (${JSON.stringify([...new Set(failed.map((job) => job.errorReason))])})`);
    assert.equal(failed.length, 0, "a paused campaign's unsent work must be requeued for resume, not failed");
  }, 1);
});
