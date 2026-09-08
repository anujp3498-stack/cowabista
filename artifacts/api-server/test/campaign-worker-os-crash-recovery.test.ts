// Real OS-process crash recovery. Every other crash-recovery test in this
// repo (campaign-worker-crash-recovery.test.ts) simulates a "crash" by
// abandoning an in-process claim and calling a private reap method directly
// -- no process ever actually dies. This test spawns the campaign runtime
// as its OWN OS process (test/worker-process-harness.ts, built via esbuild),
// waits until it has a real send genuinely in flight (a `provider_messages`
// row already committed as "pending", proven by an artificial delay inside
// the mock provider that only a real kill can interrupt), and sends it a
// real SIGKILL -- the same signal an OOM killer or `docker kill` would send.
// It then spawns a completely independent replacement process pointed at
// the same database and proves: no job is ever lost or stuck forever, the
// interrupted job is never delivered twice (a cross-process, file-based
// provider audit log is the only fully independent witness), leases are
// recovered instead of hand-waved, per-number TPS is respected across the
// crash boundary, and every successfully-sent job still carries its own
// template's exact header/body/button values.
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

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let harnessPath: string;
let harnessDistDir: string;
let workDir: string;
// Separate OS processes cannot share an in-process coordinator.  The crash
// test therefore deliberately uses the test Redis coordinator, which is the
// same durable timeline production processes use.
const redisCoordinatorUrl = process.env.CAMPAIGN_TEST_REDIS_URL;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "campaign-os-crash-"));
  // The built harness MUST live inside the package directory (not /tmp):
  // Node's ESM resolver looks for node_modules by walking up from the
  // importing file's own path, not from cwd, so an externalized bare
  // specifier like "pino" only resolves if the bundle sits somewhere under
  // artifactDir/node_modules's ancestry -- exactly how build-and-run.mjs's
  // own .test-dist output already works for every other test in this repo.
  harnessDistDir = path.join(artifactDir, ".test-dist", "worker-harness");
  harnessPath = path.join(harnessDistDir, "worker-process-harness.mjs");
  await rm(harnessDistDir, { recursive: true, force: true });
  await build({
    entryPoints: [path.join(artifactDir, "test", "worker-process-harness.ts")],
    outfile: harnessPath,
    bundle: true,
    platform: "node",
    format: "esm",
    sourcemap: "inline",
    external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);",
    },
  });
  await build({
    entryPoints: [path.join(artifactDir, "src/services/campaign-transport-shard-worker.ts")],
    outfile: path.join(harnessDistDir, "campaign-transport-shard-worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    sourcemap: "inline",
    external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
  });
});

after(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (harnessDistDir) await rm(harnessDistDir, { recursive: true, force: true });
  await pool.end();
});

/** Spawns the built harness, resolving once it prints its own readiness line. */
function spawnHarness(env: Record<string, string | undefined>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath], {
      cwd: artifactDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("WORKER_HARNESS_READY")) {
        child.stdout?.off("data", onData);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`Harness process exited before becoming ready (code=${code}, signal=${signal})`));
    });
  });
}

/** Sends SIGKILL and waits for the OS to actually report the process gone, returning the exit signal. */
function killAndAwaitExit(child: ChildProcess, signal: NodeJS.Signals): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    child.once("exit", (_code, exitSignal) => resolve(exitSignal));
    child.kill(signal);
  });
}

async function pollUntil<T>(check: () => Promise<T | undefined>, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

type Contact = { headerName: string; bodyName: string; promoCode: string };

async function createCampaignFixture(slug: string, contacts: Contact[]) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({
    organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug,
  }).returning();
  // tpsLimit=3 is deliberately low and shared with the route's configuredTps
  // below: with 6 jobs total, this guarantees at least one job is still
  // sitting Queued (rate-limited, never even claimed) when worker A dies --
  // proving the replacement process resumes the untouched backlog under the
  // SAME live per-number cap, not just the interrupted one.
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id, phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: slug, status: "Connected", tpsLimit: 3,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: `${slug}-template`, status: "Approved", language: "en_US",
    body: "Order {{1}} for {{2}}",
    components: [
      { type: "HEADER", format: "TEXT", text: "Hi {{1}}" },
      { type: "BODY", text: "Order {{1}} for {{2}}" },
      { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/promo/{{1}}" }] },
    ],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 3,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
  });
  await db.insert(campaignTemplateMappingsTable).values([
    { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "header", variable: "1", source: "csv", sourceValue: "headerName" },
    { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "1", source: "csv", sourceValue: "bodyName" },
    { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "2", source: "static", sourceValue: "Static" },
    { organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "button", variable: "0:1", source: "csv", sourceValue: "promoCode" },
  ]);
  const insertedContacts = await db.insert(campaignContactsTable).values(contacts.map((c, i) => ({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: i + 1,
    rawPhone: `+1555${organization.id}${(9000 + i).toString()}`, normalizedPhone: `+1555${organization.id}${(9000 + i).toString()}`,
    status: "Valid" as const, data: c, idempotencyKey: `${slug}-contact-${i}`,
  }))).returning();
  await db.insert(campaignMetricsTable).values({
    organizationId: organization.id, campaignId: campaign.id, total: contacts.length, valid: contacts.length, queued: contacts.length,
  });
  const jobs = await db.insert(campaignJobsTable).values(insertedContacts.map((contact, i) => ({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contact.id,
    type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-send-${i}`,
  }))).returning();
  return { organization, waba, phone, template, campaign, route, contacts: insertedContacts, jobs };
}

function expectedPayload(templateName: string, recipient: string, header: string, body1: string, buttonVar: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
      components: [
        { type: "header", parameters: [{ type: "text", text: header }] },
        { type: "body", parameters: [{ type: "text", text: body1 }, { type: "text", text: "Static" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: buttonVar }] },
      ],
    },
  };
}

test("a job whose worker process is genuinely SIGKILLed mid-send is recovered exactly once by a fresh process, without breaking TPS or template fidelity for the rest of the backlog", {
  skip: redisCoordinatorUrl ? false : "CAMPAIGN_TEST_REDIS_URL is required to share the pacing coordinator across OS processes",
}, async () => {
  const slug = `os-crash-${process.pid}-${Date.now()}`;
  const contacts: Contact[] = Array.from({ length: 6 }, (_, i) => ({
    headerName: `Header-${i}`, bodyName: `Body-${i}`, promoCode: `PROMO-${i}`,
  }));
  const fixture = await createCampaignFixture(slug, contacts);
  const jobIds = fixture.jobs.map((j) => j.id);
  const auditLogPath = path.join(workDir, `${slug}-audit.log`);
  let workerA: ChildProcess | undefined;
  let workerB: ChildProcess | undefined;

  try {
    // Worker A gets a short 1200ms lease (so we don't wait 30s for recovery)
    // and a 5s one-time send delay: the FIRST job any of its lanes actually
    // calls the provider for will block there. Because the provider_messages
    // "pending" row is inserted (and committed) BEFORE that delay even
    // starts, by the time we observe it in the database a real, otherwise-
    // indistinguishable-from-production send is genuinely in flight.
    workerA = await spawnHarness({
      WORKER_INTERVAL_MS: "50",
      WORKER_LEASE_MS: "1200",
      BROKER_ABANDONED_DELIVERY_MS: "1200",
      CAMPAIGN_TEST_PROVIDER_DELAY_ONCE_MS: "5000",
      CAMPAIGN_TEST_PROVIDER_LOG: auditLogPath,
      CAMPAIGN_COORDINATOR_MODE: "redis",
      CAMPAIGN_REDIS_URL: redisCoordinatorUrl,
    });

    const pendingRow = await pollUntil(async () => {
      const [row] = await db.select().from(providerMessagesTable)
        .where(and(inArray(providerMessagesTable.campaignJobId, jobIds), eq(providerMessagesTable.status, "pending")));
      return row;
    }, 4_000, "a provider_messages row reaching status=pending (a real send actually in flight)");
    const victimJobId = pendingRow.campaignJobId;
    const [crashedClaim] = await db.select({
      scheduledSendAt: campaignJobsTable.scheduledSendAt,
    }).from(campaignJobsTable).where(eq(campaignJobsTable.id, victimJobId));
    assert.ok(crashedClaim?.scheduledSendAt, "the killed worker's in-flight claim must have a durable pacing slot");
    const crashedClaimSlot = crashedClaim.scheduledSendAt.getTime();

    // Give other concurrent lanes on the SAME process a brief window to
    // finish their own (non-delayed) sends first, so the crash lands on a
    // realistic MIX of states: some already Sent, one genuinely mid-flight,
    // and (thanks to tpsLimit=3 vs 6 jobs) some still untouched in Queued.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const preKillJobs = await db.select({
      id: campaignJobsTable.id,
      status: campaignJobsTable.status,
      scheduledSendAt: campaignJobsTable.scheduledSendAt,
    })
      .from(campaignJobsTable).where(inArray(campaignJobsTable.id, jobIds));
    console.log(`[os-crash-test] state right before kill: ${JSON.stringify(preKillJobs)}`);

    const exitSignal = await killAndAwaitExit(workerA, "SIGKILL");
    assert.equal(exitSignal, "SIGKILL", "the process must have been forcibly terminated by the OS, not shut down gracefully");
    workerA = undefined;

    // Immediately after the kill (well before the 1200ms lease can have
    // expired), the victim's job row and provider_messages row must show
    // exactly the state a real crash leaves behind: still "Processing",
    // still "pending" -- because the dead process never got to run the
    // status-update code that follows the provider call.
    const [victimRightAfterKill] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, victimJobId));
    assert.equal(victimRightAfterKill?.status, "Processing", "a genuinely killed process cannot have settled its own claimed job");
    const [victimMessageRightAfterKill] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, victimJobId));
    assert.equal(victimMessageRightAfterKill?.status, "pending");

    // Let the lease clock (real wall-clock time this time, since it's a
    // completely separate process reading it) actually pass 1200ms before
    // any new process exists to reap it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // The replacement process shares nothing with the dead one except the
    // database: no in-memory state, no shared object, a brand-new PID and
    // workerId. Its own housekeeping loop (started inside spawnHarness's
    // CampaignRuntime.start()) is what actually reaps the stale lease.
    workerB = await spawnHarness({
      WORKER_INTERVAL_MS: "50",
      WORKER_LEASE_MS: "5000",
      BROKER_ABANDONED_DELIVERY_MS: "1200",
      CAMPAIGN_TEST_PROVIDER_LOG: auditLogPath,
      CAMPAIGN_COORDINATOR_MODE: "redis",
      CAMPAIGN_REDIS_URL: redisCoordinatorUrl,
    });

    let finalJobs;
    try {
      finalJobs = await pollUntil(async () => {
        const rows = await db.select({
          id: campaignJobsTable.id,
          status: campaignJobsTable.status,
          scheduledSendAt: campaignJobsTable.scheduledSendAt,
        })
          .from(campaignJobsTable).where(inArray(campaignJobsTable.id, jobIds));
        const settled = rows.every((r) => r.status === "Sent" || r.status === "Failed");
        return settled ? rows : undefined;
      }, 8_000, "every job reaching a terminal state (Sent or Failed) after the replacement process takes over");
    } catch (error) {
      const stuckJobs = await db.select().from(campaignJobsTable).where(inArray(campaignJobsTable.id, jobIds));
      const providerRows = await db.select().from(providerMessagesTable)
        .where(inArray(providerMessagesTable.campaignJobId, jobIds));
      console.error(`[os-crash-test] recovery diagnostics: ${JSON.stringify({ stuckJobs, providerRows })}`);
      throw error;
    }

    // (a) Full drain: nothing left Queued or Processing forever.
    const stuck = finalJobs.filter((j) => j.status !== "Sent" && j.status !== "Failed");
    assert.deepEqual(stuck, [], "no job may remain stuck in Queued/Processing after recovery");
    const sentJobIds = new Set(finalJobs.filter((j) => j.status === "Sent").map((j) => j.id));
    const failedJobIds = new Set(finalJobs.filter((j) => j.status === "Failed").map((j) => j.id));
    assert.ok(failedJobIds.has(victimJobId), "the job that was mid-flight during the real kill must resolve to Failed, not silently Sent or stuck");
    assert.equal(sentJobIds.size + failedJobIds.size, jobIds.length);

    // (b) Lease fully cleared on the recovered job -- not just "moved on",
    // actually released.
    const [victimFinal] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, victimJobId));
    assert.equal(victimFinal?.status, "Failed");
    assert.equal(victimFinal?.lockedBy, null);
    assert.equal(victimFinal?.leaseToken, null);
    assert.equal(victimFinal?.leaseExpiresAt, null);
    assert.match(victimFinal?.errorReason ?? "", /manual reconciliation/i, "the victim must fail via the duplicate-send guard, proving the system knew delivery was ambiguous rather than blindly retrying it");
    assert.ok(victimFinal?.scheduledSendAt, "the stale-lease recovery must make a new durable paced claim");
    assert.ok(
      victimFinal.scheduledSendAt.getTime() > crashedClaimSlot,
      "the recovered claim must consume a strictly later shared-coordinator slot, never refund or reuse the crashed claim's permit",
    );

    // (c) Duplicate-send protection: exactly one provider_messages row per
    // job -- including the victim -- across the whole crash+restart. Its
    // status is forever "pending": nobody ever calls the provider for it a
    // second time (see whatsapp-template-sender.ts's "prior row exists"
    // branch, which throws before ever touching the provider), so it is
    // correctly left as an honest, permanent "we don't know" record rather
    // than a fabricated success or a silently dropped one.
    const providerRows = await db.select().from(providerMessagesTable).where(inArray(providerMessagesTable.campaignJobId, jobIds));
    const rowsByJob = new Map<number, typeof providerRows>();
    for (const row of providerRows) rowsByJob.set(row.campaignJobId, [...(rowsByJob.get(row.campaignJobId) ?? []), row]);
    for (const jobId of jobIds) {
      const finalJob = finalJobs.find((job) => job.id === jobId);
      assert.equal(
        rowsByJob.get(jobId)?.length ?? 0,
        1,
        `job ${jobId} must have exactly one provider_messages row (final status=${finalJob?.status})`,
      );
    }
    const victimRow = rowsByJob.get(victimJobId)![0];
    assert.equal(
      victimRow.status,
      "delivery_unknown",
      "the interrupted provider boundary must be recorded as unknown and never fabricated as sent or replayed",
    );

    // (d) Independent, cross-process proof of "at most once": the mock
    // provider's own audit log (written by each OS process as it actually
    // invokes the provider) must show the victim's recipient phone was
    // NEVER actually dispatched -- not once, let alone twice -- across
    // either process.
    const auditText = await readFile(auditLogPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const auditLines = auditText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const victimJob = fixture.jobs.find((j) => j.id === victimJobId)!;
    const [victimContactRow] = await db.select({ normalizedPhone: campaignContactsTable.normalizedPhone })
      .from(campaignContactsTable).where(eq(campaignContactsTable.id, victimJob.contactId!));
    assert.ok(!auditLines.some((entry) => entry.payload?.to === victimContactRow!.normalizedPhone), "the provider must never have actually been invoked for the interrupted job, from either process");

    // (e) Every job that DID reach Sent has exactly one real audit entry,
    // and that entry's payload carries its OWN contact's exact header/body/
    // button values -- proving multi-template variable resolution survived
    // the crash and restart intact.
    for (const job of fixture.jobs) {
      if (!sentJobIds.has(job.id)) continue;
      const contactIndex = fixture.jobs.indexOf(job);
      const contact = fixture.contacts[contactIndex]!;
      const [contactRow] = await db.select({ normalizedPhone: campaignContactsTable.normalizedPhone })
        .from(campaignContactsTable).where(eq(campaignContactsTable.id, job.contactId!));
      const matches = auditLines.filter((entry) => entry.payload?.to === contactRow!.normalizedPhone);
      assert.equal(matches.length, 1, `job ${job.id} (Sent) must have exactly one real provider invocation`);
      const inputContact = contacts[contactIndex]!;
      assert.deepEqual(
        matches[0].payload,
        expectedPayload(`${slug}-template`, contactRow!.normalizedPhone, inputContact.headerName, inputContact.bodyName, inputContact.promoCode),
        `job ${job.id}'s sent payload must carry its own contact's header/body/button values, not another job's or a corrupted one`,
      );
    }

    // (f) The Redis coordinator's durable slots are written onto each claim.
    // Preserve the first-process slots, then add only claims whose final slot
    // changed (the stale-lease recovery) or which were first claimed after the
    // kill. This is the complete durable claim history visible from the jobs,
    // including both attempts of the victim. A permit refund would reuse the
    // crashed slot; catch-up would compact this shared 3 TPS timeline.
    const preKillSlots = new Map(
      preKillJobs
        .filter((job) => job.scheduledSendAt !== null)
        .map((job) => [job.id, job.scheduledSendAt!.getTime()]),
    );
    const claimSlotHistory = [...preKillSlots.values()];
    for (const job of finalJobs) {
      assert.ok(job.scheduledSendAt, `job ${job.id} must retain its durable scheduledSendAt evidence`);
      const finalSlot = job.scheduledSendAt.getTime();
      if (preKillSlots.get(job.id) !== finalSlot) claimSlotHistory.push(finalSlot);
    }
    const orderedClaimSlots = claimSlotHistory.sort((left, right) => left - right);
    assert.equal(
      new Set(orderedClaimSlots).size,
      orderedClaimSlots.length,
      "no shared-coordinator permit may be refunded or reused after the crash",
    );
    assert.ok(
      orderedClaimSlots.every((slot, index) => index === 0 || slot - orderedClaimSlots[index - 1]! >= 333),
      "recovery must not catch up by compacting the shared 3 TPS pacing timeline",
    );

    console.log(`[os-crash-test] final: ${finalJobs.length} jobs, ${sentJobIds.size} Sent, ${failedJobIds.size} Failed (victim=${victimJobId}), ${orderedClaimSlots.length} durable shared-coordinator claim slots`);
  } finally {
    if (workerA) { try { workerA.kill("SIGKILL"); } catch { /* already dead */ } }
    if (workerB) {
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => workerB!.once("exit", () => resolve(true))).then(() => true),
        new Promise<boolean>((resolve) => { workerB!.kill("SIGTERM"); setTimeout(() => resolve(false), 2_000); }),
      ]);
      if (!exited) { try { workerB.kill("SIGKILL"); } catch { /* already dead */ } }
    }
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});
