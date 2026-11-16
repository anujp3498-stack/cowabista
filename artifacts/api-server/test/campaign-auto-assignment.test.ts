/*
 * V2-372 automatic phone-to-cell assignment, end to end.
 *
 * Production defect: the transport cells had fixed scopes 1-4 and 5-8, so newly connected phone 9 had no owner and
 * was never sent. Here two runtime cells run as separate OS processes (test/worker-process-harness.ts) with
 * CAMPAIGN_TRANSPORT_ASSIGNMENT=auto and NO phone scope; they share only PostgreSQL and the test Redis
 * (coordinator, ownership, membership, broker), as production cells share Host S. Every send goes to the mock
 * provider (mock workspace, no sending credential) and is recorded by the cell's shard worker in
 * CAMPAIGN_TEST_PROVIDER_LOG with the sending process id, so each test checks, from what actually reached the
 * provider:
 *   - a phone connected while the cells run is sent, with no configuration change;
 *   - the phones are spread over both cells;
 *   - no recipient reaches the provider twice, including across a takeover and a handoff;
 *   - each phone's provider-approved TPS holds in every rolling second, across cells;
 *   - a SIGKILLed cell's phones are taken over and finished by the survivor;
 *   - a cell that joins later receives its share by graceful handoff, with nothing failed and one attempt per job.
 * Assignment timings are shortened through WORKER_ASSIGNMENT_TIMINGS (a test seam of the harness only); the
 * ownership lease keeps its production TTL of 5 s.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { build } from "esbuild";
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

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const redisUrl = process.env.CAMPAIGN_TEST_REDIS_URL;
const skip = redisUrl ? false : "CAMPAIGN_TEST_REDIS_URL is required: separate cells share the Redis coordinator and broker";
/** Debugging aid: keep every cell's log and the provider audit in this directory. */
const keepDir = process.env.AUTO_ASSIGNMENT_KEEP_DIR;

const TPS = 10;
const INTERVAL_MS = 100;
const TIMINGS = {
  heartbeatIntervalMs: 250,
  membershipTtlMs: 1_500,
  evaluationIntervalMs: 200,
  fallbackGraceMs: 500,
  handoffRequestTtlMs: 1_000,
  joinStableMs: 1_000,
  minHoldMs: 1_500,
  handoffIntervalMs: 300,
  maxConcurrentHandoffs: 1,
  handoffMaxMs: 10_000,
  unownedAlertMs: 3_000,
  loadSlack: 1.25,
};

let harnessPath: string;
let harnessDistDir: string;
let workDir: string;

before(async () => {
  if (skip) return;
  workDir = await mkdtemp(path.join(tmpdir(), "auto-assign-"));
  harnessDistDir = path.join(artifactDir, ".test-dist", "auto-assignment-harness");
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

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/**
 * One mock-mode organization, `phoneCount` phones (tpsLimit = TPS) and one Running campaign with a route and
 * `jobsPerRoute` jobs on each phone. Phones listed in `pending` start as Pending (not yet connected): no runtime
 * may discover them until the test connects them.
 */
async function createFixture(slug: string, phoneCount: number, jobsPerRoute: number, pending: number[] = []) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const phones = [];
  for (let p = 0; p < phoneCount; p += 1) {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization!.id, wabaId: waba!.id,
      phone: `+1557${organization!.id.toString().padStart(6, "0")}${p}`,
      displayName: `${slug}-p${p}`, status: pending.includes(p) ? "Pending" : "Connected", tpsLimit: TPS,
      providerPhoneId: `test-p${p}-${slug}`,
    }).returning();
    phones.push(phone!);
  }
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${slug}-template`, status: "Approved", language: "en_US",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: `${slug}-c`, status: "Running" }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id,
    component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  const total = phoneCount * jobsPerRoute;
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total, valid: total, queued: total });
  /** recipient -> phone index */
  const recipients = new Map<string, number>();
  let serial = 0;
  for (const [p, phone] of phones.entries()) {
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone.id, templateId: template!.id,
      configuredTps: TPS, queueDepth: jobsPerRoute,
    }).returning();
    const numbers = Array.from({ length: jobsPerRoute }, () => {
      serial += 1;
      return `+1998${organization!.id.toString().padStart(4, "0")}${serial.toString().padStart(5, "0")}`;
    });
    const contacts = await db.insert(campaignContactsTable).values(numbers.map((recipient, index) => ({
      organizationId: organization!.id, campaignId: campaign!.id, rowNumber: p * jobsPerRoute + index + 1,
      rawPhone: recipient, normalizedPhone: recipient, data: {}, status: "Valid" as const, routeId: route!.id,
      idempotencyKey: `${slug}-p${p}-contact-${index}`,
    }))).returning();
    await db.insert(campaignJobsTable).values(contacts.map((contact, index) => ({
      organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id, contactId: contact.id,
      type: "ResolveTemplateAndSend" as const, idempotencyKey: `${slug}-p${p}-send-${index}`, availableAt: new Date(),
    })));
    numbers.forEach((recipient) => recipients.set(recipient, p));
  }
  return { organization: organization!, phones, campaign: campaign!, recipients };
}

type AuditLine = { recipient: string; at: number; pid: number; phone: number };

function readAudit(file: string, fixture: Fixture): AuditLine[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline === -1) return [];
  return raw.slice(0, lastNewline + 1).split("\n").filter(Boolean).flatMap((line) => {
    const entry = JSON.parse(line) as { payload: { to?: string }; at: number; pid: number };
    const phone = entry.payload.to ? fixture.recipients.get(entry.payload.to) : undefined;
    return phone === undefined ? [] : [{ recipient: entry.payload.to!, at: entry.at, pid: entry.pid, phone }];
  });
}

function spawnCell(env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath], { cwd: artifactDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    if (keepDir) {
      mkdirSync(keepDir, { recursive: true });
      child.stdout?.pipe(createWriteStream(path.join(keepDir, `${env.CAMPAIGN_CELL}-${child.pid}.log`)));
    }
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("WORKER_HARNESS_READY")) {
        child.stdout?.off("data", onData);
        child.removeAllListeners("exit");
        if (!keepDir) child.stdout?.resume();
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

async function killCell(child: ChildProcess) {
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
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
 * Creates the fixture, runs `body` with a cell launcher (automatic mode, unique cell names, no scope), and always
 * stops every cell and removes the fixture.
 */
async function withFleet(
  label: string,
  phoneCount: number,
  jobsPerRoute: number,
  body: (fixture: Fixture, audit: string, startCell: (name: string, staticPhones?: number[], extraEnv?: Record<string, string>) => Promise<ChildProcess>) => Promise<void>,
  pending: number[] = [],
) {
  const slug = `auto-${label}-${process.pid}-${Date.now()}`;
  const fixture = await createFixture(slug, phoneCount, jobsPerRoute, pending);
  const audit = path.join(keepDir ?? workDir, `${slug}-audit.log`);
  const cells: ChildProcess[] = [];
  /** Automatic by default; with `staticPhones` (fixture phone indexes) a legacy static cell scoped to those phones. */
  const startCell = async (name: string, staticPhones?: number[], extraEnv: Record<string, string> = {}) => {
    const assignment = staticPhones
      ? { CAMPAIGN_TRANSPORT_ASSIGNMENT: "", CAMPAIGN_TRANSPORT_PHONE_IDS: staticPhones.map((index) => fixture.phones[index]!.id).join(",") }
      : { CAMPAIGN_TRANSPORT_ASSIGNMENT: "auto", CAMPAIGN_TRANSPORT_PHONE_IDS: "" };
    const cell = await spawnCell({
      WORKER_INTERVAL_MS: String(INTERVAL_MS),
      BROKER_ABANDONED_DELIVERY_MS: "5000",
      CAMPAIGN_COORDINATOR_MODE: "redis",
      CAMPAIGN_REDIS_URL: redisUrl!,
      CAMPAIGN_TRANSPORT_SHARDS: "2",
      ...assignment,
      // Unique per test run: a cell of an earlier test must never be a member of this fleet.
      CAMPAIGN_CELL: `${name}-${slug}`.slice(0, 64),
      WORKER_ASSIGNMENT_TIMINGS: JSON.stringify(TIMINGS),
      CAMPAIGN_TEST_PROVIDER_LOG: audit,
      ...extraEnv,
    });
    cells.push(cell);
    return cell;
  };
  try {
    await body(fixture, audit, startCell);
  } finally {
    await Promise.all(cells.map((cell) => stopCell(cell)));
    await db.update(campaignsTable).set({ status: "Cancelled" }).where(eq(campaignsTable.id, fixture.campaign.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
}

const jobsOf = (campaignId: number) => db.select({
  id: campaignJobsTable.id, status: campaignJobsTable.status, attempts: campaignJobsTable.attempts,
  errorReason: campaignJobsTable.errorReason, routeId: campaignJobsTable.routeId,
}).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId));

/** Every job settled: Sent, or Failed (a send whose outcome is unknown after a crash; never re-sent). */
async function allSettled(campaignId: number, timeoutMs: number) {
  await pollUntil(async () => (await jobsOf(campaignId)).every((job) => job.status === "Sent" || job.status === "Failed"), timeoutMs, "every job settled");
}

function assertNoDuplicateDispatch(lines: AuditLine[]) {
  const seen = new Map<string, number>();
  for (const line of lines) seen.set(line.recipient, (seen.get(line.recipient) ?? 0) + 1);
  assert.deepEqual([...seen].filter(([, n]) => n > 1), [], "no recipient may reach the provider more than once");
}

/** The phone's TPS in every rolling second, whichever cells sent it (plus one for timestamp granularity). */
function assertRateCap(lines: AuditLine[], phoneCount: number) {
  for (let p = 0; p < phoneCount; p += 1) {
    const times = lines.filter((line) => line.phone === p).map((line) => line.at).sort((a, b) => a - b);
    let maxInSecond = 0;
    for (let i = 0, j = 0; j < times.length; j += 1) {
      while (times[j]! - times[i]! >= 1_000) i += 1;
      maxInSecond = Math.max(maxInSecond, j - i + 1);
    }
    assert.ok(maxInSecond <= TPS + 1, `phone ${p}: ${maxInSecond} sends within one second across cells (cap ${TPS})`);
  }
}

const sendersOf = (lines: AuditLine[], p: number) => new Set(lines.filter((line) => line.phone === p).map((line) => line.pid));

/** Connects the fixture's pending phones, as an operator finishing number setup does while the cells run. */
async function connect(fixture: Fixture, indexes: number[]) {
  await db.update(phoneNumbersTable).set({ status: "Connected" })
    .where(inArray(phoneNumbersTable.id, indexes.map((index) => fixture.phones[index]!.id)));
}

test("two automatic cells divide the phones, send every job exactly once and keep each phone within its TPS", { skip }, async () => {
  // Steady state: both cells are running (and registered) before the numbers become sendable. A cell that starts
  // alone takes everything first and rebalances later; that path is the join test below.
  await withFleet("balance", 4, 30, async (fixture, audit, startCell) => {
    const [a, b] = await Promise.all([startCell("cell-a"), startCell("cell-b")]);
    await sleep(TIMINGS.heartbeatIntervalMs * 3);
    await connect(fixture, [0, 1, 2, 3]);
    await allSettled(fixture.campaign.id, 60_000);
    await sleep(500);
    const jobs = await jobsOf(fixture.campaign.id);
    assert.deepEqual(jobs.filter((job) => job.status !== "Sent"), [], "every job Sent");
    for (const job of jobs) assert.equal(job.attempts, 1, `job ${job.id} claimed once`);
    const lines = readAudit(audit, fixture);
    assert.equal(lines.length, fixture.recipients.size, "one provider call per job");
    assertNoDuplicateDispatch(lines);
    assertRateCap(lines, 4);
    const pids = new Set(lines.map((line) => line.pid));
    assert.deepEqual([...pids].sort(), [a.pid!, b.pid!].sort(), "both cells sent: the phones were divided between them");
    for (let p = 0; p < 4; p += 1) assert.equal(sendersOf(lines, p).size, 1, `phone ${p} was sent by one cell (no churn in steady state)`);
  }, [0, 1, 2, 3]);
});

test("the production defect: a phone connected while the cells run is sent automatically, with no scope or env change", { skip }, async () => {
  await withFleet("new-phone", 3, 20, async (fixture, audit, startCell) => {
    await Promise.all([startCell("cell-a"), startCell("cell-b")]);
    // Phones 0 and 1 are connected and sending; phone 2 (the highest id, like phone 9) is not connected yet.
    await pollUntil(() => {
      const lines = readAudit(audit, fixture);
      return [0, 1].every((p) => lines.some((line) => line.phone === p));
    }, 20_000, "the connected phones to send");
    assert.equal(readAudit(audit, fixture).filter((line) => line.phone === 2).length, 0, "an unconnected phone sends nothing");
    const connectedAt = Date.now();
    await connect(fixture, [2]);
    await pollUntil(() => readAudit(audit, fixture).some((line) => line.phone === 2), 15_000, "the newly connected phone to send");
    const firstSend = Math.min(...readAudit(audit, fixture).filter((line) => line.phone === 2).map((line) => line.at));
    assert.ok(firstSend - connectedAt < 5_000, `first send of the new phone ${firstSend - connectedAt} ms after it connected`);
    await allSettled(fixture.campaign.id, 60_000);
    const jobs = await jobsOf(fixture.campaign.id);
    assert.deepEqual(jobs.filter((job) => job.status !== "Sent"), [], "every job Sent, the new phone's included");
    const lines = readAudit(audit, fixture);
    assert.equal(lines.length, fixture.recipients.size);
    assertNoDuplicateDispatch(lines);
    assertRateCap(lines, 3);
  }, [2]);
});

test("a SIGKILLed cell's phones are taken over by the survivor; nothing is sent twice and every phone stays within its TPS", { skip }, async () => {
  await withFleet("failover", 4, 120, async (fixture, audit, startCell) => {
    const [a, b] = await Promise.all([startCell("cell-a"), startCell("cell-b")]);
    await sleep(TIMINGS.heartbeatIntervalMs * 3);
    await connect(fixture, [0, 1, 2, 3]);
    await pollUntil(() => {
      const lines = readAudit(audit, fixture);
      return [0, 1, 2, 3].every((p) => lines.filter((line) => line.phone === p).length >= 10)
        && new Set(lines.map((line) => line.pid)).size === 2;
    }, 30_000, "both cells sending every phone");
    const before = readAudit(audit, fixture);
    const victimPhones = [0, 1, 2, 3].filter((p) => sendersOf(before, p).has(a.pid!));
    assert.ok(victimPhones.length >= 1, "the victim cell owns at least one phone");
    const killedAt = Date.now();
    await killCell(a);
    // Production lease TTL (5 s) and membership TTL, then the survivor resumes the victim's phones.
    await pollUntil(() => {
      const lines = readAudit(audit, fixture);
      return victimPhones.every((p) => lines.some((line) => line.phone === p && line.pid === b.pid && line.at > killedAt));
    }, 30_000, "the survivor to send the killed cell's phones");
    const resumedAt = Math.max(...victimPhones.map((p) => Math.min(...readAudit(audit, fixture)
      .filter((line) => line.phone === p && line.pid === b.pid && line.at > killedAt).map((line) => line.at))));
    assert.ok(resumedAt - killedAt < 15_000, `takeover within ${resumedAt - killedAt} ms`);
    await allSettled(fixture.campaign.id, 120_000);
    await sleep(500);
    const lines = readAudit(audit, fixture);
    assertNoDuplicateDispatch(lines);
    assertRateCap(lines, 4);
    const jobs = await jobsOf(fixture.campaign.id);
    const failed = jobs.filter((job) => job.status === "Failed");
    // The crash contract (Decision 8, unchanged by V2-372): work the dead cell had consumed may already have reached
    // the provider, so it fails as delivery-unknown for manual reconciliation and is never re-sent. It can only be
    // the victim's phones' work, and at most what their lanes could hold (lane capacity = TPS x 3 s horizon).
    // Everything else is Sent exactly once by whichever cell owned the phone.
    const routes = await db.select({ id: campaignRoutesTable.id, phoneNumberId: campaignRoutesTable.phoneNumberId })
      .from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, fixture.campaign.id));
    const phoneOfRoute = new Map(routes.map((route) => [route.id, fixture.phones.findIndex((phone) => phone.id === route.phoneNumberId)]));
    assert.equal(jobs.filter((job) => job.status === "Sent").length + failed.length, jobs.length);
    for (const job of failed) {
      assert.match(job.errorReason ?? "", /manual reconciliation|delivery is unknown/i, `job ${job.id}: ${job.errorReason}`);
      assert.ok(victimPhones.includes(phoneOfRoute.get(job.routeId!)!), `job ${job.id} failed on a phone the victim did not own`);
    }
    assert.ok(failed.length <= victimPhones.length * TPS * 3, `${failed.length} delivery-unknown jobs exceed the victim lanes' capacity`);
    const sent = new Set(lines.map((line) => line.recipient));
    assert.ok(sent.size >= jobs.length - failed.length, "every Sent job reached the provider");
    console.log(`# failover: victim owned phones ${victimPhones.join(",")}; ${lines.filter((l) => l.pid === a.pid).length} sent by the victim, ${lines.filter((l) => l.pid === b.pid).length} by the survivor, ${failed.length} delivery-unknown, takeover ${resumedAt - killedAt} ms`);
    const intents = await db.select({ status: providerMessagesTable.status }).from(providerMessagesTable)
      .where(inArray(providerMessagesTable.campaignJobId, failed.map((job) => job.id)));
    for (const intent of intents) assert.notEqual(intent.status, "sent", "a failed job was not recorded as sent");
  }, [0, 1, 2, 3]);
});

test("a cell that joins later receives its share by graceful handoff: nothing failed, nothing re-sent, one attempt per job", { skip }, async () => {
  // Long enough (15 s per phone) for the joining cell's settle-in, the minimum hold and a drained handoff to land
  // while the campaign still has work; a campaign that ends first simply finishes on the first cell.
  await withFleet("join", 4, 150, async (fixture, audit, startCell) => {
    const a = await startCell("cell-a");
    await pollUntil(() => {
      const lines = readAudit(audit, fixture);
      return [0, 1, 2, 3].every((p) => lines.some((line) => line.phone === p));
    }, 20_000, "the first cell to send every phone");
    assert.deepEqual([...new Set(readAudit(audit, fixture).map((line) => line.pid))], [a.pid], "alone, the first cell sends everything");
    const joinedAt = Date.now();
    const b = await startCell("cell-b");
    await pollUntil(() => readAudit(audit, fixture).some((line) => line.pid === b.pid), 30_000, "the joining cell to send");
    const lines0 = readAudit(audit, fixture);
    const firstB = Math.min(...lines0.filter((line) => line.pid === b.pid).map((line) => line.at));
    assert.ok(firstB - joinedAt < 15_000, `the joining cell sent ${firstB - joinedAt} ms after starting`);
    await allSettled(fixture.campaign.id, 120_000);
    await sleep(500);
    const lines = readAudit(audit, fixture);
    assertNoDuplicateDispatch(lines);
    assertRateCap(lines, 4);
    assert.equal(lines.length, fixture.recipients.size, "one provider call per job");
    const jobs = await jobsOf(fixture.campaign.id);
    assert.deepEqual(jobs.filter((job) => job.status !== "Sent").map((job) => [job.id, job.status, job.errorReason]), [], "a graceful handoff fails nothing");
    for (const job of jobs) assert.equal(job.attempts, 1, `job ${job.id}: a handoff never costs an attempt`);
    const moved = [0, 1, 2, 3].filter((p) => sendersOf(lines, p).has(b.pid!));
    assert.ok(moved.length >= 1, "at least one phone moved to the joining cell");
  });
});

/*
 * Mixed static/automatic operation during the production migration (docs/AUTO_PHONE_ASSIGNMENT.md, section 7):
 * cell-by-cell switches, an unexpected restart of the cell that is still static, the rollback, and SIGKILL of either
 * cell while the fleet is mixed. Restarts here are what systemd does: SIGTERM (graceful stop) then a new process
 * with the cell's environment; after SIGKILL, a new process.
 */

/** The longest pause between consecutive sends of a phone that overlaps [from, to] (ms). */
function longestPause(lines: AuditLine[], p: number, from: number, to: number): number {
  const times = lines.filter((line) => line.phone === p).map((line) => line.at).sort((a, b) => a - b);
  let longest = 0;
  for (let i = 1; i < times.length; i += 1) {
    if (times[i]! >= from && times[i - 1]! <= to) longest = Math.max(longest, times[i]! - times[i - 1]!);
  }
  return longest;
}

async function restart(cell: ChildProcess, start: () => Promise<ChildProcess>): Promise<{ next: ChildProcess; from: number; to: number }> {
  const from = Date.now();
  await stopCell(cell);
  const next = await start();
  return { next, from, to: Date.now() };
}

async function sendsAfter(audit: string, fixture: Fixture, phones: number[], after: number, count = 3) {
  await pollUntil(() => {
    const lines = readAudit(audit, fixture);
    return phones.every((p) => lines.filter((line) => line.phone === p && line.at > after).length >= count);
  }, 30_000, `phones ${phones.join(",")} sending after ${after}`);
}

async function assertAllSentOnce(fixture: Fixture, audit: string) {
  await allSettled(fixture.campaign.id, 120_000);
  await sleep(500);
  const jobs = await jobsOf(fixture.campaign.id);
  assert.deepEqual(jobs.filter((job) => job.status !== "Sent").map((job) => [job.id, job.status, job.errorReason]), [], "graceful restarts fail nothing");
  for (const job of jobs) assert.equal(job.attempts, 1, `job ${job.id}: a graceful restart never costs an attempt`);
  const lines = readAudit(audit, fixture);
  assertNoDuplicateDispatch(lines);
  assert.equal(lines.length, fixture.recipients.size, "one provider call per job");
  assertRateCap(lines, fixture.phones.length);
  return lines;
}

test("migration forward: static+static, then cell-2 automatic, an unexpected restart of the static cell, then both automatic; nothing fails, nothing is re-sent, unaffected phones keep sending", { skip }, async () => {
  await withFleet("mig-forward", 4, 300, async (fixture, audit, startCell) => {
    // S0: today's static scopes.
    let a = await startCell("cell-1", [0, 1]);
    let b = await startCell("cell-2", [2, 3]);
    await sendsAfter(audit, fixture, [0, 1, 2, 3], 0, 5);

    // S2: cell-2 restarts automatic (its row is auto|<scope>). Cell-1's phones must not pause.
    const step2 = await restart(b, () => startCell("cell-2"));
    b = step2.next;
    await sendsAfter(audit, fixture, [2, 3], step2.to);
    let lines = readAudit(audit, fixture);
    for (const p of [0, 1]) assert.ok(longestPause(lines, p, step2.from, step2.to) < 2_000, `phone ${p} kept sending while cell-2 switched`);

    // Unexpected restart of the still-static cell-1 in the mixed state: it starts again (static), and the automatic
    // cell covers its phones meanwhile, so they barely pause; cell-2's own phones do not pause at all.
    const unexpected = await restart(a, () => startCell("cell-1", [0, 1]));
    a = unexpected.next;
    await sendsAfter(audit, fixture, [0, 1], unexpected.to);
    lines = readAudit(audit, fixture);
    for (const p of [2, 3]) assert.ok(longestPause(lines, p, unexpected.from, unexpected.to) < 2_000, `phone ${p} kept sending while cell-1 restarted`);
    for (const p of [0, 1]) assert.ok(longestPause(lines, p, unexpected.from, unexpected.to) < 5_000, `phone ${p} was taken over while cell-1 restarted`);

    // S3: cell-1 restarts automatic; the cells then rebalance by graceful handoff.
    const step3 = await restart(a, () => startCell("cell-1"));
    a = step3.next;
    lines = await assertAllSentOnce(fixture, audit);
    for (const p of [2, 3]) assert.ok(longestPause(lines, p, step3.from, step3.to) < 2_000, `phone ${p} kept sending while cell-1 switched`);
  });
});

test("migration rollback: both automatic (a phone connected meanwhile), then cell-1 static with a widened scope, then cell-2 static; nothing fails, nothing is re-sent, every phone keeps a cell", { skip }, async () => {
  await withFleet("mig-rollback", 5, 300, async (fixture, audit, startCell) => {
    // S3: both automatic, registered before the phones are sendable (steady state).
    let a = await startCell("cell-1");
    let b = await startCell("cell-2");
    await sleep(TIMINGS.heartbeatIntervalMs * 3);
    await connect(fixture, [0, 1, 2, 3]);
    await sendsAfter(audit, fixture, [0, 1, 2, 3], 0, 5);
    // A phone connected while the fleet is automatic: in neither original static scope (0,1 / 2,3).
    await connect(fixture, [4]);
    await sendsAfter(audit, fixture, [4], 0, 5);

    // The rollback widens cell-1's scope while both cells are automatic (section 8, step 1), so phone 4 has a cell
    // in every state. S2: cell-1 static [0,1,4]; the automatic cell-2 covers everything while it restarts.
    const step2 = await restart(a, () => startCell("cell-1", [0, 1, 4]));
    a = step2.next;
    await sendsAfter(audit, fixture, [0, 1, 2, 3, 4], step2.to);

    // S1: cell-2 static [2,3]: it releases everything on stop; cell-1 takes its widened scope, cell-2 its own.
    const step1 = await restart(b, () => startCell("cell-2", [2, 3]));
    b = step1.next;
    await sendsAfter(audit, fixture, [0, 1, 2, 3, 4], step1.to);
    const lines = await assertAllSentOnce(fixture, audit);
    for (const p of [0, 1, 2, 3, 4]) {
      assert.ok(longestPause(lines, p, step2.from, Date.now()) < 5_000, `phone ${p} kept a cell through the rollback`);
    }
    // After the rollback each static scope is sent by its own cell, the widened one included.
    for (const line of lines.filter((l) => l.at > step1.to + 2_000)) {
      assert.equal(line.pid, [0, 1, 4].includes(line.phone) ? a.pid : b.pid, `phone ${line.phone} is sent by its static cell after the rollback`);
    }
  }, [0, 1, 2, 3, 4]);
});

test("migration mixed state: SIGKILL of the automatic cell, then of the static cell, each restarted as systemd would; nothing is sent twice and only the killed cell's in-flight work is delivery-unknown", { skip }, async () => {
  await withFleet("mig-kill", 4, 400, async (fixture, audit, startCell) => {
    // S2: cell-1 static (phones 0,1), cell-2 automatic.
    let a = await startCell("cell-1", [0, 1]);
    let b = await startCell("cell-2");
    await sendsAfter(audit, fixture, [0, 1, 2, 3], 0, 5);

    // Kill the automatic cell. The static cell cannot take its phones (scope), so they wait for the restart; the
    // static cell's own phones keep sending throughout.
    let lines = readAudit(audit, fixture);
    const killedAuto = { at: Date.now(), phones: [0, 1, 2, 3].filter((p) => lines.some((line) => line.phone === p && line.pid === b.pid)) };
    await killCell(b);
    await sleep(2_000); // systemd RestartSec=2
    b = await startCell("cell-2");
    await sendsAfter(audit, fixture, [2, 3], killedAuto.at);
    lines = readAudit(audit, fixture);
    for (const p of [0, 1]) assert.ok(longestPause(lines, p, killedAuto.at, Date.now()) < 2_000, `static phone ${p} kept sending while the automatic cell was down`);

    // Kill the static cell. The automatic cell takes its phones once their leases expire (5 s).
    lines = readAudit(audit, fixture);
    const killedStatic = { at: Date.now(), phones: [0, 1, 2, 3].filter((p) => lines.some((line) => line.phone === p && line.pid === a.pid && line.at > killedAuto.at)) };
    await killCell(a);
    await sendsAfter(audit, fixture, [0, 1], killedStatic.at);
    const takeoverMs = Math.max(...[0, 1].map((p) => Math.min(...readAudit(audit, fixture)
      .filter((line) => line.phone === p && line.at > killedStatic.at).map((line) => line.at)))) - killedStatic.at;
    assert.ok(takeoverMs < 12_000, `the automatic cell took the static cell's phones in ${takeoverMs} ms`);
    await sleep(2_000);
    a = await startCell("cell-1", [0, 1]);

    await allSettled(fixture.campaign.id, 180_000);
    await sleep(500);
    lines = readAudit(audit, fixture);
    assertNoDuplicateDispatch(lines);
    assertRateCap(lines, 4);
    const jobs = await jobsOf(fixture.campaign.id);
    const routes = await db.select({ id: campaignRoutesTable.id, phoneNumberId: campaignRoutesTable.phoneNumberId })
      .from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, fixture.campaign.id));
    const phoneOfRoute = new Map(routes.map((route) => [route.id, fixture.phones.findIndex((phone) => phone.id === route.phoneNumberId)]));
    const failed = jobs.filter((job) => job.status === "Failed");
    const killedPhones = new Set([...killedAuto.phones, ...killedStatic.phones]);
    for (const job of failed) {
      assert.match(job.errorReason ?? "", /manual reconciliation|delivery is unknown/i, `job ${job.id}: ${job.errorReason}`);
      assert.ok(killedPhones.has(phoneOfRoute.get(job.routeId!)!), `job ${job.id} failed on a phone no killed cell owned`);
    }
    assert.ok(failed.length <= (killedAuto.phones.length + killedStatic.phones.length) * TPS * 3, `${failed.length} delivery-unknown`);
    assert.equal(jobs.filter((job) => job.status === "Sent").length + failed.length, jobs.length);
    console.log(`# mixed kill: automatic cell owned ${killedAuto.phones.join(",")}, static cell owned ${killedStatic.phones.join(",")}; ${failed.length} delivery-unknown; static phones taken over in ${takeoverMs} ms`);
  });
});

// Every migration step is a graceful restart (systemctl restart: SIGTERM). With real network latency, sends are in
// flight when it comes. A graceful stop must let them finish: aborting an HTTP call that may already have reached
// Meta turns it into delivery-unknown (manual reconciliation). The mock provider answers instantly, so the migration
// tests above could not see this; here every send takes 400 ms and honours its abort signal like a real HTTP call.
test("a graceful restart lets sends already in flight finish: no delivery-unknown, nothing re-sent, one attempt each", { skip }, async () => {
  await withFleet("graceful-latency", 2, 60, async (fixture, audit, startCell) => {
    const latency = { CAMPAIGN_TEST_PROVIDER_DELAY_MS: "400" };
    const first = await startCell("cell-a", undefined, latency);
    await sendsAfter(audit, fixture, [0, 1], 0, 8);
    const stoppedAt = Date.now();
    await stopCell(first);
    const stopMs = Date.now() - stoppedAt;
    await startCell("cell-b", undefined, latency);
    const lines = await assertAllSentOnce(fixture, audit);
    assert.ok(lines.some((line) => line.pid === first.pid && line.at > stoppedAt), "sends in flight at SIGTERM completed during the stop");
    console.log(`# graceful stop with 400 ms provider latency took ${stopMs} ms`);
  });
});
