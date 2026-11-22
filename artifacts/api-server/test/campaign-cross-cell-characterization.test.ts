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
  providerMessagesTable,
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
async function campaignAction(organizationId: number, campaignId: number, action: "pause" | "resume" | "emergency-kill") {
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
async function createFixture(slug: string, jobsPerRoute: number, campaignCount = 2, phoneCount = 2) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const phones = [];
  for (const label of ["pa", "pb"].slice(0, phoneCount)) {
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
  // A live shard appends to this NDJSON file while pollUntil reads it. A read can
  // catch the last record mid-write; only newline-terminated records are complete.
  // Do not conceal corruption in an earlier complete record: JSON.parse still throws.
  const raw = readFileSync(file, "utf8");
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline === -1) return [];
  return raw.slice(0, lastNewline + 1).split("\n").filter(Boolean).flatMap((line) => {
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

type CellOptions = {
  campaignCount?: number;
  phoneCount?: number;
  /** Runs after the fixture exists and before any cell starts. */
  beforeCells?: (fixture: Fixture) => Promise<void>;
  /** One cell per phone (default); false: the test starts its own cells with `spawn`. */
  cellPerPhone?: boolean;
};
type CellContext = {
  /** Starts a cell scoped to `phoneIds`; it is always stopped (or killed) when the test ends. */
  spawn(phoneIds: number[], env?: Record<string, string>): Promise<ChildProcess>;
};

function cellEnv(audit: string, phoneIds: number[], env: Record<string, string> = {}): Record<string, string> {
  return {
    WORKER_INTERVAL_MS: String(INTERVAL_MS),
    WORKER_LEASE_MS: String(LEASE_MS),
    BROKER_ABANDONED_DELIVERY_MS: "5000",
    CAMPAIGN_COORDINATOR_MODE: "redis",
    CAMPAIGN_REDIS_URL: redisUrl!,
    CAMPAIGN_TRANSPORT_SHARDS: "2",
    CAMPAIGN_TRANSPORT_PHONE_IDS: phoneIds.join(","),
    CAMPAIGN_TEST_PROVIDER_LOG: audit,
    ...env,
  };
}

/**
 * Creates the fixture, starts the cells, runs `body`, and always stops every cell (continuing a stopped
 * one first) and removes the fixture. The cells' stdout is drained so a chatty cell cannot block on a full
 * pipe.
 */
async function withCells(
  slug: string,
  jobsPerRoute: number,
  body: (fixture: Fixture, audit: string, context: CellContext) => Promise<void>,
  options: CellOptions = {},
) {
  const fixture = await createFixture(slug, jobsPerRoute, options.campaignCount ?? 2, options.phoneCount ?? 2);
  const audit = path.join(workDir, `${slug}-audit.log`);
  const cells: ChildProcess[] = [];
  const context: CellContext = {
    async spawn(phoneIds, env) {
      const cell = await spawnCell(cellEnv(audit, phoneIds, env));
      cell.stdout?.resume();
      cells.push(cell);
      return cell;
    },
  };
  try {
    await options.beforeCells?.(fixture);
    if (options.cellPerPhone !== false) {
      for (const phone of fixture.phones) await context.spawn([phone.id]);
    }
    await body(fixture, audit, context);
  } finally {
    for (const cell of cells) if (cell.pid && cell.exitCode === null && cell.signalCode === null) process.kill(cell.pid, "SIGCONT");
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
    return fixture.phones.every((_, p) => lines.filter((line) => line.phone === p).length >= count);
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
  // Far recipients: three C1 jobs on PA made available only 8 s after the cells start, so they are certainly
  // still unclaimed (never prepared) when the STOP arrives, however fast the cells claim the rest.
  let far: Array<{ recipient: string; jobId: number }> = [];
  const deferFar = async (fixture: Fixture) => {
    far = [...fixture.recipients].filter(([, owner]) => owner.campaign === 0 && owner.phone === 0)
      .slice(-3).map(([recipient, owner]) => ({ recipient, jobId: owner.jobId }));
    await db.update(campaignJobsTable).set({ availableAt: new Date(Date.now() + 8_000) })
      .where(inArray(campaignJobsTable.id, far.map(({ jobId }) => jobId)));
  };
  await withCells(`xcell-stop-${process.pid}-${Date.now()}`, 60, async (fixture, audit) => {
    const [c1] = fixture.campaigns.map(({ campaign }) => campaign);
    await waitForTraffic(audit, fixture, 0, 5);
    const pa = fixture.phones[0]!;
    const c1OnPa = [...fixture.recipients].filter(([, owner]) => owner.campaign === 0 && owner.phone === 0).map(([recipient, owner]) => ({ recipient, ...owner }));
    const jobs = new Map((await jobsOf(c1!.id)).map((job) => [job.id, job]));
    const sentSoFar = new Set(readAudit(audit, fixture).map((line) => line.recipient));
    // Near: already claimed (prepared, possibly in transport) and not sent yet when the STOP arrives.
    const near = c1OnPa.filter(({ recipient, jobId }) => jobs.get(jobId)?.status === "Processing" && !sentSoFar.has(recipient)).slice(0, 2);
    assert.ok(far.every(({ jobId }) => jobs.get(jobId)?.status === "Queued"), "the far recipients are still unclaimed");
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
  }, { beforeCells: deferFar });
});

const intentsOf = (jobIds: number[]) => jobIds.length
  ? db.select({ jobId: providerMessagesTable.campaignJobId, status: providerMessagesTable.status })
    .from(providerMessagesTable).where(inArray(providerMessagesTable.campaignJobId, jobIds))
  : Promise.resolve([] as Array<{ jobId: number; status: string }>);

/** Every job of the campaign Sent, polled; on timeout the error says where every other job is. */
async function allSent(campaignId: number, timeoutMs: number) {
  try {
    await pollUntil(async () => (await jobsOf(campaignId)).every((job) => job.status === "Sent"), timeoutMs, "every job Sent");
  } catch (error) {
    const pending = (await jobsOf(campaignId)).filter((job) => job.status !== "Sent");
    const intents = new Map((await intentsOf(pending.map((job) => job.id))).map((intent) => [intent.jobId, intent.status]));
    const summary = new Map<string, number>();
    for (const job of pending) {
      const key = `${job.status} attempts=${job.attempts} leased=${job.leaseToken !== null} intent=${intents.get(job.id) ?? "none"} ${job.errorReason ?? ""}`.trim();
      summary.set(key, (summary.get(key) ?? 0) + 1);
    }
    throw new Error(`${(error as Error).message}; ${pending.length} not Sent: ${JSON.stringify(Object.fromEntries(summary))}`);
  }
}

// D1 (fixed in Phase 0, docs/CROSS_CELL_DISPATCH_AUTHORIZATION.md): when a cross-cell pause leaves the other
// cell with no Running campaign on a phone, that cell drops the lane and its shard worker cancels the paced
// backlog before start. That work was never sent: it must be requeued for resume with its claim's attempt
// returned and its intent rejected (re-armed at the next preparation) -- not settled Failed ("Send aborted
// before provider start"), which lost 45 to 47 of 240 jobs per run before the fix.
test("cross-cell pause of a phone's only campaign requeues the other cell's unstarted work, never fails it (D1)", { skip }, async () => {
  await withCells(`xcell-d1-${process.pid}-${Date.now()}`, 120, async (fixture, audit) => {
    const [c1] = fixture.campaigns.map(({ campaign }) => campaign);
    await waitForTraffic(audit, fixture, 0, 5);
    await campaignAction(fixture.organization.id, c1!.id, "pause");
    await sleep(B_TODAY_MS);
    await quiesce(audit, fixture, c1!.id, 20_000);
    const lines = readAudit(audit, fixture);
    assertNoDuplicateDispatch(lines);
    const after = await jobsOf(c1!.id);
    const failed = after.filter((job) => job.status === "Failed");
    assert.deepEqual(failed.map((job) => job.errorReason), [], "a paused campaign's unsent work is never Failed");
    const queued = after.filter((job) => job.status === "Queued");
    assert.equal(queued.length + after.filter((job) => job.status === "Sent").length, after.length, "only Sent or requeued");
    assert.ok(queued.length > 0);
    for (const job of queued) assert.equal(job.attempts, 0, `job ${job.id}: no attempt spent on work never sent`);
    const pending = (await intentsOf(queued.map((job) => job.id))).filter((intent) => intent.status !== "rejected");
    assert.deepEqual(pending, [], "every requeued job's intent is rejected, so its next preparation re-arms it");
    const sent = new Set(lines.map((line) => line.recipient));
    for (const [recipient, owner] of fixture.recipients) {
      if (queued.some((job) => job.id === owner.jobId)) assert.ok(!sent.has(recipient), `${recipient} requeued but already sent`);
    }
  }, { campaignCount: 1 });
});

test("cross-cell pause, then resume: every message is sent exactly once, none Failed, one attempt each", { skip }, async () => {
  await withCells(`xcell-resume-${process.pid}-${Date.now()}`, 60, async (fixture, audit) => {
    const [c1] = fixture.campaigns.map(({ campaign }) => campaign);
    await waitForTraffic(audit, fixture, 0, 5);
    await campaignAction(fixture.organization.id, c1!.id, "pause");
    await sleep(B_TODAY_MS);
    await quiesce(audit, fixture, c1!.id, 20_000);
    await campaignAction(fixture.organization.id, c1!.id, "resume");
    await allSent(c1!.id, 60_000);
    await sleep(500);
    const lines = readAudit(audit, fixture);
    assertNoDuplicateDispatch(lines);
    assert.equal(lines.length, fixture.recipients.size, "every recipient reached exactly once");
    for (const job of await jobsOf(c1!.id)) assert.equal(job.attempts, 1, `job ${job.id}: one attempt for one send`);
  }, { campaignCount: 1 });
});

/**
 * An owner frozen (every thread: SIGSTOP) past its 5 s ownership TTL loses the phone to a standby scoped to the
 * same phone. The lease (30 s) outlives the freeze, so nothing is reaped: only ownership changes hands.
 * Returns the audit, the two cells' pids and the freeze time.
 */
async function freezeOwner(fixture: Fixture, audit: string, cells: CellContext, env: Record<string, string>, freezeMs: number) {
  const pa = fixture.phones[0]!;
  const owner = await cells.spawn([pa.id], env);
  await waitForTraffic(audit, fixture, 0, 5);
  const standby = await cells.spawn([pa.id], env);
  process.kill(owner.pid!, "SIGSTOP");
  const frozenAt = Date.now();
  await sleep(freezeMs);
  process.kill(owner.pid!, "SIGCONT");
  return { owner: owner.pid!, standby: standby.pid!, frozenAt };
}

/** The stale owner starts nothing after it froze, except the one call that may have been inside the mock provider. */
function assertStaleOwnerStartsNothing(lines: AuditLine[], owner: number, frozenAt: number) {
  const late = lines.filter((line) => line.pid === owner && line.at > frozenAt + 50);
  assert.ok(late.length <= 1, `the stale owner started ${late.length} sends after losing the phone`);
}

test("ownership race within the reclaim window: the stale owner's paced and queued work is requeued, attempt returned, and sent once by the new owner", { skip }, async () => {
  await withCells(`xcell-own-${process.pid}-${Date.now()}`, 60, async (fixture, audit, cells) => {
    const [c1] = fixture.campaigns.map(({ campaign }) => campaign);
    // The freeze (7 s) is past the ownership TTL but inside the standby's abandoned-delivery window (20 s), so
    // the standby never reclaims the frozen owner's consumed deliveries: on resume, the owner itself finds the
    // phone lost, its shard worker cancels the paced backlog before start and its lane drop discards the rest.
    const { owner, standby, frozenAt } = await freezeOwner(fixture, audit, cells, { WORKER_LEASE_MS: "30000", BROKER_ABANDONED_DELIVERY_MS: "20000" }, 7_000);
    await allSent(c1!.id, 60_000);
    await sleep(500);
    const lines = readAudit(audit, fixture);
    assertNoDuplicateDispatch(lines);
    assert.equal(lines.length, fixture.recipients.size, "every recipient reached exactly once");
    assertStaleOwnerStartsNothing(lines, owner, frozenAt);
    assert.ok(lines.some((line) => line.pid === standby), "the new owner sends the rest");
    for (const job of await jobsOf(c1!.id)) assert.equal(job.attempts, 1, `job ${job.id}: the stale owner's unstarted claim spent no attempt`);
    console.log(`# ownership race: ${lines.filter((l) => l.pid === owner).length} sent by the frozen owner, ${lines.filter((l) => l.pid === standby).length} by the new owner`);
  }, { campaignCount: 1, phoneCount: 1, cellPerPhone: false });
});

// Decision 8 (lease-aware broker reclaim). Past the abandoned-delivery window the new owner reclaims the stalled
// owner's consumed, unacknowledged deliveries, but their jobs are still Processing under the stalled owner's live
// lease (30 s), so the reclaim is deferred. On resume the stalled owner finds the phone lost and settles its own
// unstarted work as not started (requeued, attempt returned); the new owner then sends it. Before Decision 8 the
// reclaim failed those deliveries as delivery unknown although they were never sent (23 of 60 in a typical run).
test("ownership race past the reclaim window: the reclaim waits for the stalled owner's lease, and every message is sent exactly once", { skip }, async () => {
  await withCells(`xcell-own-long-${process.pid}-${Date.now()}`, 60, async (fixture, audit, cells) => {
    const [c1] = fixture.campaigns.map(({ campaign }) => campaign);
    const { owner, standby, frozenAt } = await freezeOwner(fixture, audit, cells, { WORKER_LEASE_MS: "30000", BROKER_ABANDONED_DELIVERY_MS: "5000" }, 7_000);
    await allSent(c1!.id, 60_000);
    await sleep(500);
    const lines = readAudit(audit, fixture);
    assertNoDuplicateDispatch(lines);
    assert.equal(lines.length, fixture.recipients.size, "every recipient reached exactly once");
    assertStaleOwnerStartsNothing(lines, owner, frozenAt);
    assert.ok(lines.some((line) => line.pid === standby), "the new owner sends the rest");
    for (const job of await jobsOf(c1!.id)) assert.equal(job.attempts, 1, `job ${job.id}: one attempt for one send`);
    console.log(`# ownership race past the reclaim window: ${lines.filter((l) => l.pid === owner).length} sent by the frozen owner, ${lines.filter((l) => l.pid === standby).length} by the new owner, 0 delivery-unknown`);
  }, { campaignCount: 1, phoneCount: 1, cellPerPhone: false });
});

test("recovery: a cell killed mid-send is recovered by another; nothing is sent twice, and only delivery-unknown work fails", { skip }, async () => {
  await withCells(`xcell-crash-${process.pid}-${Date.now()}`, 60, async (fixture, audit, cells) => {
    const [c1] = fixture.campaigns.map(({ campaign }) => campaign);
    const pa = fixture.phones[0]!;
    const victim = await cells.spawn([pa.id]);
    await waitForTraffic(audit, fixture, 0, 5);
    const survivor = await cells.spawn([pa.id]);
    process.kill(victim.pid!, "SIGKILL");
    // Ownership TTL (5 s), then the lease (9 s) and the abandoned-delivery window (5 s) for the survivor's
    // reaper and broker reclaim.
    await pollUntil(async () => (await jobsOf(c1!.id)).every((job) => job.status === "Sent" || job.status === "Failed"),
      90_000, "every job terminal after recovery");
    await sleep(500);
    const lines = readAudit(audit, fixture);
    assertNoDuplicateDispatch(lines);
    assert.ok(lines.some((line) => line.pid === survivor.pid), "the survivor sends the rest");
    const failed = (await jobsOf(c1!.id)).filter((job) => job.status === "Failed");
    for (const job of failed) {
      // Work the dead cell had prepared or consumed may have reached the provider: honestly unknown, never
      // replayed. Nothing else may fail, and never as "aborted before start".
      assert.match(job.errorReason ?? "", /manual reconciliation|delivery is unknown/i, `job ${job.id}: ${job.errorReason}`);
    }
    console.log(`# recovery: ${lines.filter((l) => l.pid === victim.pid).length} sent by the victim, ${lines.filter((l) => l.pid === survivor.pid).length} by the survivor, ${failed.length} delivery-unknown`);
  }, { campaignCount: 1, phoneCount: 1, cellPerPhone: false });
});
