import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
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
  type ProviderSender,
} from "../src/services/campaign-queue";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import { InMemoryPacingCoordinator } from "../src/services/campaign-pacing-coordinator";
import { InMemoryPreparedDispatchBroker } from "../src/services/campaign-prepared-broker";
import type { PreparedDispatchBroker } from "../src/services/campaign-prepared-broker";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";
import { inFlightRegistry } from "../src/services/campaign-inflight";
import {
  assertContactImportWritable,
  CampaignImportFencedError,
  initializeContactImport,
} from "../src/services/campaign-import-lifecycle";
import { ProviderRequestError } from "../src/services/whatsapp-provider";
import { assertOwnedByOrg } from "../src/routes/campaign-routes";
import { parseCsv } from "../src/services/contact-processing";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import campaignEngineRouter from "../src/routes/campaign-engine";
import campaignRoutesRouter from "../src/routes/campaign-routes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRouteHandler(router: any, path: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler registered for ${method.toUpperCase()} ${path}`);
}

function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.send = (body?: unknown) => { res.body = body; return res; };
  return res;
}

after(async () => {
  inFlightRegistry.clear();
  await pool.end();
});

async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  return organization;
}

async function createCampaign(organizationId: number, name: string, status = "Draft") {
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId,
    name,
    status,
  }).returning();
  return campaign;
}

async function createWorkerFixture(slug: string, options: { maxAttempts?: number; killSwitchFromStart?: boolean } = {}) {
  const organization = await createOrganization(slug);
  const [waba] = await db.insert(wabasTable).values({
    organizationId: organization.id,
    externalId: `${slug}-waba`,
    displayName: slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id,
    wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: slug,
    status: "Connected",
    tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id,
    wabaId: waba.id,
    name: `${slug}-template`,
    status: "Approved",
    body: "Hello {{1}}",
    components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  // killSwitchFromStart sets killSwitch in the very same INSERT that creates
  // the campaign as "Running" -- not a separate UPDATE afterward -- so there
  // is never a moment where the row exists as Running+killSwitch=false and
  // visible to the live api-server process's own CampaignRuntime background
  // worker. See the killSwitch-toggle comment on the "concurrent workers"
  // test for why that window matters.
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: organization.id,
    name: slug,
    status: "Running",
    killSwitch: options.killSwitchFromStart ?? false,
  }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    phoneNumberId: phone.id,
    templateId: template.id,
    configuredTps: 10,
    queueDepth: 1,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    templateId: template.id,
  });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    templateId: template.id,
    component: "body",
    variable: "1",
    source: "static",
    sourceValue: "World",
  });
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    rowNumber: 2,
    rawPhone: phone.phone,
    normalizedPhone: phone.phone,
    data: { phone: phone.phone },
    status: "Valid",
    partitionKey: 1,
    routeId: route.id,
    idempotencyKey: `${slug}-contact`,
  }).returning();
  await db.insert(campaignMetricsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    total: 1,
    valid: 1,
    queued: 1,
  });
  const [job] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    routeId: route.id,
    contactId: contact.id,
    type: "ResolveTemplateAndSend",
    idempotencyKey: `${slug}-send`,
    maxAttempts: options.maxAttempts ?? 5,
  }).returning();
  return { organization, waba, phone, template, campaign, route, job };
}

async function attemptStart(organizationId: number, campaignId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx.select().from(campaignsTable).where(and(
      eq(campaignsTable.id, campaignId),
      eq(campaignsTable.organizationId, organizationId),
    )).for("update");
    if (!campaign || campaign.status !== "Draft") return false;
    const [activeImport] = await tx.select({ id: contactImportSessionsTable.id })
      .from(contactImportSessionsTable)
      .where(and(
        eq(contactImportSessionsTable.organizationId, organizationId),
        eq(contactImportSessionsTable.campaignId, campaignId),
        eq(contactImportSessionsTable.status, "Processing"),
      ))
      .limit(1);
    if (activeImport) return false;
    const [started] = await tx.update(campaignsTable).set({ status: "Running" }).where(and(
      eq(campaignsTable.id, campaignId),
      eq(campaignsTable.status, "Draft"),
    )).returning();
    return Boolean(started);
  });
}

class AbortableSender implements ProviderSender {
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async send(_job: typeof campaignJobsTable.$inferSelect, { signal }: { signal: AbortSignal }) {
    this.markStarted();
    return new Promise<{ providerMessageId: string }>((_resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class SuccessfulSender implements ProviderSender {
  readonly idempotencyKeys: string[] = [];
  readonly startedAt: number[] = [];
  async send(_job: typeof campaignJobsTable.$inferSelect, options: { idempotencyKey: string }) {
    this.idempotencyKeys.push(options.idempotencyKey);
    this.startedAt.push(performance.now());
    return { providerMessageId: `provider-${options.idempotencyKey}` };
  }
}

class DelayedClaimQueue extends DatabaseJobQueue {
  constructor(private readonly delayMs: number) { super(); }
  override async claimBatch(...args: Parameters<DatabaseJobQueue["claimBatch"]>) {
    await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    return super.claimBatch(...args);
  }
}

class FailingPublishBroker extends InMemoryPreparedDispatchBroker {
  override async publish(): Promise<void> {
    throw new Error("injected broker outage");
  }
}

class TransitionAfterClaimQueue extends DatabaseJobQueue {
  constructor(
    private readonly campaignId: number,
    private readonly routeId: number,
    private readonly transition: "pause" | "kill",
  ) {
    super();
  }

  override async claim(...args: Parameters<DatabaseJobQueue["claim"]>) {
    const job = await super.claim(...args);
    if (!job) return job;
    await db.transaction(async (tx) => {
      await tx.update(campaignsTable).set(this.transition === "pause" ? {
        status: "Paused",
      } : {
        status: "Cancelled",
        killSwitch: true,
      }).where(eq(campaignsTable.id, this.campaignId));
      await tx.update(campaignRoutesTable).set({ status: "Paused" })
        .where(eq(campaignRoutesTable.id, this.routeId));
    });
    return job;
  }
}

class RetryableFailureSender implements ProviderSender {
  async send() {
    throw new ProviderRequestError("temporary provider failure", true, "429", 429);
  }
}

test("streaming CSV parsing preserves rows across arbitrary chunk boundaries", async () => {
  const csv = [
    "phone,name,notes",
    ...Array.from({ length: 2_000 }, (_, index) =>
      `+1555${String(index).padStart(7, "0")},Contact ${index},\"chunked, row ${index}\"`),
  ].join("\r\n");
  async function* chunks() {
    for (let offset = 0; offset < csv.length; offset += 37) {
      yield Buffer.from(csv.slice(offset, offset + 37));
    }
  }
  const rows: string[][] = [];
  for await (const row of parseCsv(chunks())) rows.push(row);
  assert.equal(rows.length, 2_001);
  assert.deepEqual(rows[0], ["phone", "name", "notes"]);
  assert.deepEqual(rows[2_000], ["+15550001999", "Contact 1999", "chunked, row 1999"]);
});

test("concurrent imports, replays, and campaign start serialize safely", async () => {
  const slug = `import-race-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  const campaign = await createCampaign(organization.id, `${slug}-a`);
  const otherCampaign = await createCampaign(organization.id, `${slug}-b`);
  const input = {
    organizationId: organization.id,
    campaignId: campaign.id,
    fileName: "contacts.csv",
    phoneColumn: "phone",
  };
  try {
    const importResults = await Promise.all([
      initializeContactImport({ ...input, idempotencyKey: `${slug}-key-a` }),
      initializeContactImport({ ...input, idempotencyKey: `${slug}-key-b` }),
    ]);
    assert.equal(importResults.filter((result) => result.ok).length, 1);
    assert.equal(importResults.filter((result) => !result.ok && result.status === 409).length, 1);
    const accepted = importResults.find((result) => result.ok);
    assert.ok(accepted?.ok);
    await db.update(contactImportSessionsTable).set({ status: "Completed" })
      .where(eq(contactImportSessionsTable.id, accepted.session.id));
    const replay = await initializeContactImport({ ...input, idempotencyKey: accepted.session.idempotencyKey });
    assert.ok(replay.ok && replay.replay, "completed import must replay without creating work");
    const wrongCampaign = await initializeContactImport({
      ...input,
      campaignId: otherCampaign.id,
      idempotencyKey: accepted.session.idempotencyKey,
    });
    assert.ok(!wrongCampaign.ok && wrongCampaign.status === 409);

    await db.delete(contactImportSessionsTable).where(eq(contactImportSessionsTable.campaignId, campaign.id));
    const raceKey = `${slug}-start-race`;
    const [initialized, started] = await Promise.all([
      initializeContactImport({ ...input, idempotencyKey: raceKey }),
      attemptStart(organization.id, campaign.id),
    ]);
    assert.notEqual(initialized.ok, started, "import initialization and start cannot both win");
    const [state] = await db.select({ status: campaignsTable.status }).from(campaignsTable)
      .where(eq(campaignsTable.id, campaign.id));
    const [active] = await db.select({ count: sql<number>`count(*)::int` }).from(contactImportSessionsTable)
      .where(and(
        eq(contactImportSessionsTable.campaignId, campaign.id),
        eq(contactImportSessionsTable.status, "Processing"),
      ));
    assert.ok(
      (state?.status === "Draft" && active?.count === 1) ||
      (state?.status === "Running" && active?.count === 0),
      "campaign must never run while an import is processing",
    );
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("cancellation fences a streaming import before reconciliation can miss later jobs", async () => {
  const slug = `cancel-import-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  const campaign = await createCampaign(organization.id, slug);
  try {
    const initialized = await initializeContactImport({
      organizationId: organization.id,
      campaignId: campaign.id,
      idempotencyKey: `${slug}-key`,
      fileName: "contacts.csv",
      phoneColumn: "phone",
    });
    assert.ok(initialized.ok);
    const session = initialized.session;

    let signalFenceLocked!: () => void;
    let releaseBatch!: () => void;
    const fenceLocked = new Promise<void>((resolve) => {
      signalFenceLocked = resolve;
    });
    const batchMayCommit = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const batchWrite = db.transaction(async (tx) => {
      await assertContactImportWritable(tx, organization.id, campaign.id, session.id);
      signalFenceLocked();
      await batchMayCommit;
      await tx.insert(campaignJobsTable).values({
        organizationId: organization.id,
        campaignId: campaign.id,
        type: "ResolveTemplateAndSend",
        idempotencyKey: `${slug}-queued-before-cancel`,
      });
    });
    await fenceLocked;
    const cancel = db.transaction(async (tx) => {
        await tx.select({ id: campaignsTable.id }).from(campaignsTable)
          .where(eq(campaignsTable.id, campaign.id))
          .for("update");
        await tx.update(campaignsTable).set({ status: "Cancelled" })
          .where(eq(campaignsTable.id, campaign.id));
        await tx.update(contactImportSessionsTable).set({
          status: "Failed",
          error: "Campaign cancelled during contact import",
        }).where(and(
          eq(contactImportSessionsTable.id, session.id),
          eq(contactImportSessionsTable.status, "Processing"),
        ));
        await tx.update(campaignJobsTable).set({ status: "Cancelled" }).where(and(
          eq(campaignJobsTable.campaignId, campaign.id),
          eq(campaignJobsTable.status, "Queued"),
        ));
    });
    releaseBatch();
    await Promise.all([batchWrite, cancel]);

    const [liveJobs] = await db.select({ count: sql<number>`count(*)::int` }).from(campaignJobsTable)
      .where(and(
        eq(campaignJobsTable.campaignId, campaign.id),
        sql`${campaignJobsTable.status} in ('Queued', 'Processing')`,
      ));
    const [failedSession] = await db.select().from(contactImportSessionsTable)
      .where(eq(contactImportSessionsTable.id, session.id));
    assert.equal(liveJobs?.count, 0);
    assert.equal(failedSession?.status, "Failed");

    await assert.rejects(
      db.transaction(async (tx) => {
        await assertContactImportWritable(tx, organization.id, campaign.id, session.id);
        await tx.insert(campaignJobsTable).values({
          organizationId: organization.id,
          campaignId: campaign.id,
          type: "ResolveTemplateAndSend",
          idempotencyKey: `${slug}-must-not-exist`,
        });
      }),
      CampaignImportFencedError,
    );
    const [lateJob] = await db.select({ count: sql<number>`count(*)::int` }).from(campaignJobsTable)
      .where(and(
        eq(campaignJobsTable.campaignId, campaign.id),
        eq(campaignJobsTable.idempotencyKey, `${slug}-must-not-exist`),
      ));
    assert.equal(lateJob?.count, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("pause requeues one leased send, resume sends it once, and cancel settles processing work", async () => {
  const first = await createWorkerFixture(`pause-resume-${process.pid}-${Date.now()}`);
  const abortable = new AbortableSender();
  const worker = new CampaignWorker(new DatabaseJobQueue(), abortable, new RouteTpsLimiter(), "pause-worker");
  try {
    const processing = worker.processOne();
    await abortable.started;
    await db.update(campaignsTable).set({ status: "Paused" }).where(eq(campaignsTable.id, first.campaign.id));
    await db.update(campaignRoutesTable).set({ status: "Paused" }).where(eq(campaignRoutesTable.id, first.route.id));
    inFlightRegistry.abortCampaign(first.campaign.id, "test pause");
    assert.equal(await processing, "idle");
    let [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, first.job.id));
    let [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, first.campaign.id));
    assert.equal(job?.status, "Queued");
    assert.equal(metrics?.queued, 1);
    assert.equal(metrics?.processing, 0);

    await db.update(campaignsTable).set({ status: "Running" }).where(eq(campaignsTable.id, first.campaign.id));
    await db.update(campaignRoutesTable).set({ status: "Active" }).where(eq(campaignRoutesTable.id, first.route.id));
    await db.update(campaignJobsTable).set({ availableAt: sql`statement_timestamp()` })
      .where(eq(campaignJobsTable.id, first.job.id));
    const successful = new SuccessfulSender();
    const resumed = new CampaignWorker(new DatabaseJobQueue(), successful, new RouteTpsLimiter(), "resume-worker");
    assert.equal(await resumed.processOne(new Date(Date.now() + 1_000)), "sent");
    [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, first.job.id));
    [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, first.campaign.id));
    assert.equal(job?.status, "Sent");
    assert.deepEqual(successful.idempotencyKeys, [first.job.idempotencyKey]);
    assert.equal(metrics?.queued, 0);
    assert.equal(metrics?.processing, 0);
    assert.equal(metrics?.sent, 1);

    const second = await createWorkerFixture(`cancel-${process.pid}-${Date.now()}`);
    try {
      const cancelSender = new AbortableSender();
      const cancelWorker = new CampaignWorker(new DatabaseJobQueue(), cancelSender, new RouteTpsLimiter(), "cancel-worker");
      const cancelling = cancelWorker.processOne();
      await cancelSender.started;
      await db.update(campaignsTable).set({ status: "Cancelled" }).where(eq(campaignsTable.id, second.campaign.id));
      await db.update(campaignRoutesTable).set({ status: "Paused" }).where(eq(campaignRoutesTable.id, second.route.id));
      inFlightRegistry.abortCampaign(second.campaign.id, "test cancel");
      assert.equal(await cancelling, "idle");
      const [cancelledJob] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, second.job.id));
      const [cancelMetrics] = await db.select().from(campaignMetricsTable)
        .where(eq(campaignMetricsTable.campaignId, second.campaign.id));
      assert.equal(cancelledJob?.status, "Cancelled");
      assert.equal(cancelMetrics?.queued, 0);
      assert.equal(cancelMetrics?.processing, 0);
    } finally {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, second.organization.id));
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, first.organization.id));
  }
});

test("a pause or kill committed after claim but before worker registration never reaches the provider", async () => {
  for (const transition of ["pause", "kill"] as const) {
    const fixture = await createWorkerFixture(
      `post-claim-${transition}-${process.pid}-${Date.now()}`,
    );
    const sender = new SuccessfulSender();
    const worker = new CampaignWorker(
      new TransitionAfterClaimQueue(fixture.campaign.id, fixture.route.id, transition),
      sender,
      new RouteTpsLimiter(),
      `post-claim-${transition}-worker`,
    );
    try {
      assert.equal(await worker.processOne(), "idle");
      assert.deepEqual(sender.idempotencyKeys, [], `${transition} must fence the provider call`);
      let [job] = await db.select().from(campaignJobsTable)
        .where(eq(campaignJobsTable.id, fixture.job.id));
      let [metrics] = await db.select().from(campaignMetricsTable)
        .where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
      assert.equal(job?.attempts, 1);
      assert.equal(job?.status, transition === "pause" ? "Queued" : "Cancelled");
      assert.equal(metrics?.processing, 0);
      assert.equal(metrics?.queued, transition === "pause" ? 1 : 0);

      if (transition === "pause") {
        await db.update(campaignsTable).set({ status: "Running" })
          .where(eq(campaignsTable.id, fixture.campaign.id));
        await db.update(campaignRoutesTable).set({ status: "Active" })
          .where(eq(campaignRoutesTable.id, fixture.route.id));
        await db.update(campaignJobsTable).set({ availableAt: sql`statement_timestamp()` })
          .where(eq(campaignJobsTable.id, fixture.job.id));
        const resumed = new CampaignWorker(
          new DatabaseJobQueue(),
          sender,
          new RouteTpsLimiter(),
          "post-claim-resume-worker",
        );
        assert.equal(await resumed.processOne(new Date(Date.now() + 1_000)), "sent");
        [job] = await db.select().from(campaignJobsTable)
          .where(eq(campaignJobsTable.id, fixture.job.id));
        [metrics] = await db.select().from(campaignMetricsTable)
          .where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
        assert.equal(job?.status, "Sent");
        assert.equal(job?.attempts, 2);
        assert.deepEqual(sender.idempotencyKeys, [fixture.job.idempotencyKey]);
        assert.equal(metrics?.queued, 0);
        assert.equal(metrics?.processing, 0);
        assert.equal(metrics?.sent, 1);
      }
    } finally {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
    }
  }
});

test("retry exhaustion, queue idempotency, and provider TPS validation remain safe", async () => {
  const fixture = await createWorkerFixture(`retry-${process.pid}-${Date.now()}`, { maxAttempts: 2 });
  try {
    const worker = new CampaignWorker(
      new DatabaseJobQueue(),
      new RetryableFailureSender(),
      new RouteTpsLimiter(),
      "retry-worker",
    );
    assert.equal(await worker.processOne(), "retry");
    await db.update(campaignJobsTable).set({ availableAt: sql`statement_timestamp()` })
      .where(eq(campaignJobsTable.id, fixture.job.id));
    assert.equal(await worker.processOne(new Date(Date.now() + 1_000)), "failed");
    const [failedJob] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
    const [metrics] = await db.select().from(campaignMetricsTable)
      .where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    assert.equal(failedJob?.status, "Failed");
    assert.equal(failedJob?.attempts, 2);
    assert.equal(metrics?.failed, 1);
    assert.equal(metrics?.retryCount, 1);
    assert.equal(metrics?.queued, 0);
    assert.equal(metrics?.processing, 0);

    const otherCampaign = await createCampaign(fixture.organization.id, `${fixture.organization.slug}-other`);
    const queue = new DatabaseJobQueue();
    await assert.rejects(
      queue.enqueue({
        organizationId: fixture.organization.id,
        campaignId: otherCampaign.id,
        type: "Send",
        idempotencyKey: fixture.job.idempotencyKey,
      }),
      /different campaign/,
    );
    assert.equal(
      await assertOwnedByOrg(
        fixture.organization.id,
        fixture.campaign.id,
        fixture.phone.id,
        fixture.template.id,
        fixture.phone.tpsLimit + 1,
      ),
      `Configured TPS cannot exceed this phone number's provider limit of ${fixture.phone.tpsLimit}`,
    );
    assert.equal(
      await assertOwnedByOrg(
        fixture.organization.id,
        fixture.campaign.id,
        fixture.phone.id,
        fixture.template.id,
        fixture.phone.tpsLimit,
      ),
      null,
    );
    assert.equal(
      await assertOwnedByOrg(
        fixture.organization.id,
        fixture.campaign.id,
        fixture.phone.id,
        fixture.template.id,
        0,
      ),
      "Configured TPS must be a positive integer",
    );
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("a cancel racing a multi-page execute() never leaves stale queued jobs or inflated counters", async () => {
  const slug = `cancel-execute-race-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
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
    const campaign = await createCampaign(organization.id, slug);
    // This campaign is briefly a real "Running" campaign with real Queued
    // jobs (that is the whole point -- see the multi-page comment below).
    // The live api-server process's own CampaignRuntime background worker
    // polls this same database for exactly that shape of work (see
    // campaign-runtime.ts / campaign-queue.ts's claim(), which requires
    // killSwitch = false), so without this flag it can race in and claim or
    // send a few of these jobs itself, corrupting the very counts this test
    // asserts on -- and, worse, keeping busy right as later tests in this
    // file create their own small job batches, making unrelated tests flaky
    // too. killSwitch is otherwise only touched by the "emergency-kill"
    // action, so setting it here does not affect planCampaign()/
    // executeCampaignPlan()/the cancel action under test.
    await db.update(campaignsTable).set({ killSwitch: true }).where(eq(campaignsTable.id, campaign.id));
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id,
      templateId: template.id, configuredTps: 1_000,
    }).returning();
    await db.insert(campaignTemplateSelectionsTable).values({
      organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
    });
    await db.insert(campaignTemplateMappingsTable).values({
      organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
      component: "body", variable: "1", source: "static", sourceValue: "World",
    });
    // More than one execute() page (EXECUTE_PAGE_SIZE = 500), so a fix that
    // only serializes a single internal transaction -- rather than the whole
    // multi-page operation -- would still let a concurrent cancel interleave
    // between pages.
    const contactCount = 650;
    await db.insert(campaignContactsTable).values(Array.from({ length: contactCount }, (_, index) => ({
      organizationId: organization.id,
      campaignId: campaign.id,
      rowNumber: index + 1,
      rawPhone: `+1777${String(index).padStart(7, "0")}`,
      normalizedPhone: `+1777${String(index).padStart(7, "0")}`,
      data: {},
      status: "Valid" as const,
      idempotencyKey: `${slug}-contact-${index}`,
    })));
    await db.insert(campaignMetricsTable).values({
      organizationId: organization.id, campaignId: campaign.id, total: contactCount, valid: contactCount,
    });

    const planned = await planCampaign(organization.id, campaign.id);
    assert.equal(planned.allocated, contactCount);

    const cancelAction = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/actions", "post");
    const [executeResult, cancelRes] = await Promise.all([
      executeCampaignPlan(organization.id, campaign.id).catch((error: Error) => error),
      (async () => {
        const res = fakeResponse();
        await cancelAction(
          {
            params: { organizationId: String(organization.id), campaignId: String(campaign.id) },
            body: { action: "cancel" },
            authUser: undefined,
          },
          res,
          () => {},
        );
        return res;
      })(),
    ]);

    // Because withCampaignLifecycleLock serializes the whole execute()
    // operation against the whole cancel action, exactly one of two clean
    // orderings must have happened -- never an interleaving that leaves
    // stale work behind.
    const executeSucceeded = !(executeResult instanceof Error);
    if (executeSucceeded) {
      assert.equal((executeResult as { queuedNew: number }).queuedNew, contactCount);
    } else {
      assert.match((executeResult as Error).message, /cannot be executed from status/);
    }
    assert.equal(cancelRes.statusCode, 200, JSON.stringify(cancelRes.body));

    const [finalCampaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id));
    assert.equal(finalCampaign?.status, "Cancelled");

    const [jobCounts] = await db.select({
      total: sql<number>`count(*)::int`,
      queued: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Queued')::int`,
      cancelled: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Cancelled')::int`,
    }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(jobCounts?.queued, 0, "no job may remain Queued once the campaign is Cancelled");
    assert.equal(jobCounts?.total, executeSucceeded ? contactCount : 0, "jobs must exist iff execute() actually ran before cancel");
    assert.equal(jobCounts?.cancelled, executeSucceeded ? contactCount : 0);

    const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaign.id));
    assert.equal(metrics?.queued, 0, "queued counter must reconcile to exactly zero live queued jobs");

    const [routeAfter] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.id, route.id));
    assert.equal(routeAfter?.queueDepth, 0, "route queue depth must reconcile to zero once every job is settled");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("plan() racing a concurrent template-mappings replacement never freezes a mismatched snapshot", async () => {
  const slug = `plan-mapping-race-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const [waba] = await db.insert(wabasTable).values({
      organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug,
    }).returning();
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id, wabaId: waba.id,
      phone: `+1555${organization.id.toString().padStart(7, "0")}`,
      displayName: slug, status: "Connected", tpsLimit: 100,
    }).returning();
    const [templateA] = await db.insert(templatesTable).values({
      organizationId: organization.id, wabaId: waba.id, name: `${slug}-template-a`,
      status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
    }).returning();
    const [templateB] = await db.insert(templatesTable).values({
      organizationId: organization.id, wabaId: waba.id, name: `${slug}-template-b`,
      status: "Approved", body: "Hi {{1}}", components: [{ type: "BODY", text: "Hi {{1}}" }],
    }).returning();
    const campaign = await createCampaign(organization.id, slug);
    await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id,
      templateId: templateA.id, configuredTps: 10,
    });
    await db.insert(campaignTemplateSelectionsTable).values({
      organizationId: organization.id, campaignId: campaign.id, templateId: templateA.id,
    });
    await db.insert(campaignTemplateMappingsTable).values({
      organizationId: organization.id, campaignId: campaign.id, templateId: templateA.id,
      component: "body", variable: "1", source: "static", sourceValue: "World",
    });
    await db.insert(campaignContactsTable).values(Array.from({ length: 20 }, (_, index) => ({
      organizationId: organization.id,
      campaignId: campaign.id,
      rowNumber: index + 1,
      rawPhone: `+1888${String(index).padStart(7, "0")}`,
      normalizedPhone: `+1888${String(index).padStart(7, "0")}`,
      data: {},
      status: "Valid" as const,
      idempotencyKey: `${slug}-contact-${index}`,
    })));
    await db.insert(campaignMetricsTable).values({
      organizationId: organization.id, campaignId: campaign.id, total: 20, valid: 20,
    });

    // Swaps the campaign's template selection/mapping away from templateA
    // (the route's assigned template) to templateB entirely -- exactly the
    // shape of change that, without withCampaignLifecycleLock also guarding
    // this endpoint, could interleave between planCampaignLocked's separate
    // reads of the selections and mappings tables and freeze a snapshot
    // pairing a selection from one write with mappings from another.
    const replaceMappings = findRouteHandler(
      campaignEngineRouter,
      "/organizations/:organizationId/campaigns/:campaignId/template-mappings",
      "put",
    );
    const [planResult, replaceRes] = await Promise.all([
      planCampaign(organization.id, campaign.id).catch((error: Error) => error),
      (async () => {
        const res = fakeResponse();
        await replaceMappings(
          {
            params: { organizationId: String(organization.id), campaignId: String(campaign.id) },
            body: {
              templateIds: [templateB.id],
              mappings: [{
                templateId: templateB.id, component: "body", variable: "1",
                source: "static", sourceValue: "Universe",
              }],
            },
            authUser: undefined,
          },
          res,
          () => {},
        );
        return res;
      })(),
    ]);
    assert.equal(replaceRes.statusCode, 200, JSON.stringify(replaceRes.body));

    const planSucceeded = !(planResult instanceof Error);
    if (planSucceeded) {
      // The lock serialized the two operations as plan-then-replace: at the
      // moment planCampaignLocked took its snapshot, the route's assigned
      // template (A) was still the selected/mapped one, so freezing it was
      // correct -- the later replacement does not retroactively invalidate
      // an already-frozen plan. Assert the frozen snapshot is fully
      // self-consistent for the template the route actually points to,
      // which is exactly the invariant a mismatched interleaving would
      // have violated.
      const [activePlan] = await db.select().from(campaignPlansTable).where(and(
        eq(campaignPlansTable.campaignId, campaign.id),
        eq(campaignPlansTable.status, "Active"),
      ));
      assert.ok(activePlan, "a successful plan() must persist an Active plan row");
      const frozenRouteTemplateIds = new Set((activePlan!.routes as { templateId: number }[]).map((route) => route.templateId));
      assert.deepEqual([...frozenRouteTemplateIds], [templateA.id]);
      assert.ok(
        (activePlan!.templateIds as number[]).includes(templateA.id),
        "every route's frozen templateId must be present in the plan's templateIds",
      );
      const snapshotIds = new Set((activePlan!.templatesSnapshot as { id: number }[]).map((template) => template.id));
      assert.ok(snapshotIds.has(templateA.id), "the frozen templatesSnapshot must contain every route's template");
      const mappingKeys = new Set((activePlan!.mappingsSnapshot as { templateId: number; component: string; variable: string }[])
        .map((mapping) => `${mapping.templateId}:${mapping.component}:${mapping.variable}`));
      assert.ok(mappingKeys.has(`${templateA.id}:body:1`), "the frozen mappingsSnapshot must satisfy every requirement of every frozen template");
    } else {
      // The lock serialized the two operations as replace-then-plan: the
      // route still points at templateA, which the replacement just
      // unselected, so planCampaignLocked's own fresh readiness check must
      // correctly refuse to freeze an inconsistent plan rather than silently
      // producing one.
      assert.ok(planResult instanceof Object && "errors" in (planResult as object), "plan() must fail with CampaignNotReadyError, not an unrelated error");
      assert.match((planResult as Error).message, /not selected|missing mapping/);
      const [activePlan] = await db.select().from(campaignPlansTable).where(and(
        eq(campaignPlansTable.campaignId, campaign.id),
        eq(campaignPlansTable.status, "Active"),
      ));
      assert.equal(activePlan, undefined, "a refused plan() must not leave behind an Active plan row");
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("plan() racing a concurrent route TPS update never freezes an unsafe combined-TPS snapshot", async () => {
  const slug = `plan-tps-race-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const [waba] = await db.insert(wabasTable).values({
      organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug,
    }).returning();
    // One phone number, shared by two routes, capped at 10 combined TPS.
    // A single-route PATCH only ever validates that route's own TPS against
    // the phone's cap (assertOwnedByOrg), never the *combined* total across
    // routes sharing the phone -- only planCampaignLocked's readiness check
    // (validateCampaignReady's phoneTpsTotals pass) catches that. So a PATCH
    // that pushes the combined total over the cap can commit successfully
    // on its own, and only racing it against plan() proves the lock forces
    // one consistent before/after ordering instead of a snapshot built from
    // a still-safe total that silently becomes unsafe underneath it.
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id, wabaId: waba.id,
      phone: `+1555${organization.id.toString().padStart(7, "0")}`,
      displayName: slug, status: "Connected", tpsLimit: 10,
    }).returning();
    const [template] = await db.insert(templatesTable).values({
      organizationId: organization.id, wabaId: waba.id, name: `${slug}-template`,
      status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
    }).returning();
    const campaign = await createCampaign(organization.id, slug);
    const [routeA] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id,
      templateId: template.id, configuredTps: 5,
    }).returning();
    const [routeB] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id,
      templateId: template.id, configuredTps: 5,
    }).returning();
    await db.insert(campaignTemplateSelectionsTable).values({
      organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
    });
    await db.insert(campaignTemplateMappingsTable).values({
      organizationId: organization.id, campaignId: campaign.id, templateId: template.id,
      component: "body", variable: "1", source: "static", sourceValue: "World",
    });
    await db.insert(campaignContactsTable).values(Array.from({ length: 20 }, (_, index) => ({
      organizationId: organization.id,
      campaignId: campaign.id,
      rowNumber: index + 1,
      rawPhone: `+1888${String(index).padStart(7, "0")}`,
      normalizedPhone: `+1888${String(index).padStart(7, "0")}`,
      data: {},
      status: "Valid" as const,
      idempotencyKey: `${slug}-contact-${index}`,
    })));
    await db.insert(campaignMetricsTable).values({
      organizationId: organization.id, campaignId: campaign.id, total: 20, valid: 20,
    });

    const patchRoute = findRouteHandler(campaignRoutesRouter, "/campaign-routes/:routeId", "patch");
    const [planResult, patchRes] = await Promise.all([
      planCampaign(organization.id, campaign.id).catch((error: Error) => error),
      (async () => {
        const res = fakeResponse();
        await patchRoute(
          {
            params: { routeId: String(routeB.id) },
            body: { configuredTps: 8 },
            organizationId: organization.id,
          },
          res,
          () => {},
        );
        return res;
      })(),
    ]);
    assert.equal(patchRes.statusCode, 200, JSON.stringify(patchRes.body));

    const planSucceeded = !(planResult instanceof Error);
    const [activePlan] = await db.select().from(campaignPlansTable).where(and(
      eq(campaignPlansTable.campaignId, campaign.id),
      eq(campaignPlansTable.status, "Active"),
    ));
    if (planSucceeded) {
      // The lock serialized plan-then-patch: at the moment planCampaignLocked
      // read the routes table, the combined TPS was still the safe 5+5=10,
      // so freezing it was correct -- the PATCH committing afterward does
      // not retroactively invalidate an already-frozen plan. The frozen
      // snapshot must reflect exactly that pre-PATCH total, not a mix.
      assert.ok(activePlan, "a successful plan() must persist an Active plan row");
      const frozenRoutes = activePlan!.routes as { routeId: number; configuredTps: number }[];
      const frozenTotal = frozenRoutes
        .filter((route) => route.routeId === routeA.id || route.routeId === routeB.id)
        .reduce((sum, route) => sum + route.configuredTps, 0);
      assert.equal(frozenTotal, 10, "the frozen snapshot must capture the safe pre-PATCH combined TPS, not a partially-updated total");
    } else {
      // The lock serialized patch-then-plan: routeB's TPS was already 8 by
      // the time planCampaignLocked ran its own fresh readiness check, so
      // the now-unsafe 5+8=13 combined total on one phone (over its cap of
      // 10) must be caught there and refuse to freeze a plan at all.
      assert.ok(planResult instanceof Object && "errors" in (planResult as object), "plan() must fail with CampaignNotReadyError, not an unrelated error");
      assert.match((planResult as Error).message, /combined TPS/);
      assert.equal(activePlan, undefined, "a refused plan() must not leave behind an Active plan row");
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("retrying cancel/pause after the response is lost is a safe no-op, not a 409", async () => {
  const slug = `retry-idempotent-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const [waba] = await db.insert(wabasTable).values({
      organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug,
    }).returning();
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id, wabaId: waba.id,
      phone: `+1555${organization.id.toString().padStart(7, "0")}`,
      displayName: slug, status: "Connected", tpsLimit: 10,
    }).returning();
    const [template] = await db.insert(templatesTable).values({
      organizationId: organization.id, wabaId: waba.id, name: `${slug}-template`,
      status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
    }).returning();
    const campaign = await createCampaign(organization.id, slug, "Running");
    await db.insert(campaignRoutesTable).values({
      organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id,
      templateId: template.id, configuredTps: 10,
    });

    const actions = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/actions", "post");
    const callAction = async (action: string) => {
      const res = fakeResponse();
      await actions(
        { params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { action }, authUser: undefined },
        res,
        () => {},
      );
      return res;
    };

    const first = await callAction("cancel");
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    const [afterFirst] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id));
    assert.equal(afterFirst?.status, "Cancelled");
    // The cancel action itself writes one "cancel" audit row; the abort/
    // reconcile side effects that follow a genuine transition separately
    // write their own "reconciled" row -- neither should double up on a
    // retry, which is what the rest of this test checks.
    const cancelAudits = () => db.select().from(campaignAuditTable).where(and(
      eq(campaignAuditTable.campaignId, campaign.id),
      eq(campaignAuditTable.action, "cancel"),
    ));
    assert.equal((await cancelAudits()).length, 1);

    // Simulates a client that never saw the first response (e.g. the
    // connection dropped) and retries the exact same request. The campaign
    // is already Cancelled, which the strict transition table alone does
    // not allow starting from -- this must still report success with the
    // current state, not a 409, or the action can never be retried safely.
    const retry = await callAction("cancel");
    assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((retry.body as any).status, "Cancelled");
    const [afterRetry] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id));
    assert.equal(afterRetry?.status, "Cancelled");
    // The idempotent no-op must not write a second "cancel" audit row for an
    // action that never actually re-applied.
    assert.equal((await cancelAudits()).length, 1);

    // A genuinely invalid action from this settled state (never valid, not
    // just already-applied) must still be rejected.
    const resumeFromCancelled = await callAction("resume");
    assert.equal(resumeFromCancelled.statusCode, 409, JSON.stringify(resumeFromCancelled.body));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("detached success settlement cannot hold a route's dispatch capacity", async () => {
  const fixture = await createWorkerFixture(
    `deferred-settlement-${process.pid}-${Date.now()}`,
    { killSwitchFromStart: true },
  );
  const total = 33;
  const client = await pool.connect();
  try {
    await db.update(phoneNumbersTable).set({ tpsLimit: 1_000 })
      .where(eq(phoneNumbersTable.id, fixture.phone.id));
    await db.update(campaignRoutesTable).set({ configuredTps: 1_000, queueDepth: total })
      .where(eq(campaignRoutesTable.id, fixture.route.id));
    await db.update(campaignMetricsTable).set({ total, valid: total, queued: total })
      .where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    await db.insert(campaignJobsTable).values(Array.from({ length: total - 1 }, (_, index) => ({
      organizationId: fixture.organization.id,
      campaignId: fixture.campaign.id,
      routeId: fixture.route.id,
      contactId: fixture.job.contactId,
      type: "ResolveTemplateAndSend" as const,
      idempotencyKey: `${fixture.organization.slug}-deferred-${index}`,
    })));
    await db.update(campaignsTable).set({ killSwitch: false })
      .where(eq(campaignsTable.id, fixture.campaign.id));

    await client.query("begin");
    await client.query("select id from campaigns where id = $1 for update", [fixture.campaign.id]);

    const sender = new SuccessfulSender();
    const worker = new CampaignWorker(
      new DatabaseJobQueue(),
      sender,
      new RouteTpsLimiter(),
      "deferred-settlement-worker",
    );
    for (let index = 0; index < total; index += 1) {
      const outcome = await worker.processBatchDetached(1);
      assert.equal(
        outcome,
        "sent",
        `dispatch ${index + 1} must not be blocked by earlier settlement`,
      );
      const deadline = Date.now() + 2_000;
      while (sender.idempotencyKeys.length <= index && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      assert.equal(sender.idempotencyKeys.length, index + 1);
    }

    assert.equal(
      await worker.waitForIdle(25),
      false,
      "the worker must report non-idle while exact-lease settlement is blocked",
    );
    const [blocked] = await db.select({
      processing: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Processing')::int`,
      sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int`,
    }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, fixture.campaign.id));
    assert.deepEqual(blocked, { processing: total, sent: 0 });

    await client.query("commit");
    assert.equal(await worker.waitForIdle(5_000), true);
    const [settled] = await db.select({
      processing: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Processing')::int`,
      sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int`,
    }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, fixture.campaign.id));
    assert.deepEqual(settled, { processing: 0, sent: total });
  } finally {
    try {
      await client.query("rollback");
    } catch {
      // The transaction may already have committed.
    }
    client.release();
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("four prefetched phone lanes keep dispatching while settlement is fully blocked", async () => {
  const fixtures = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    createWorkerFixture(`supply-broker-${index}-${process.pid}-${Date.now()}`, { killSwitchFromStart: true })));
  const jobsPerPhone = 64;
  const total = fixtures.length * jobsPerPhone;
  const client = await pool.connect();
  const coordinator = new InMemoryPacingCoordinator();
  const sender = new SuccessfulSender();
  const worker = new CampaignWorker(
    new DatabaseJobQueue(),
    sender,
    new RouteTpsLimiter(coordinator),
    "bounded-supply-broker-worker",
  );
  const reservoir = new CampaignPhoneReservoir(
    worker,
    32,
    coordinator,
    "bounded-supply-broker-owner",
    16_384,
    new Set(fixtures.map((fixture) => fixture.phone.id)),
  );
  try {
    for (const fixture of fixtures) {
      await db.update(phoneNumbersTable).set({ tpsLimit: 1_000 }).where(eq(phoneNumbersTable.id, fixture.phone.id));
      await db.update(campaignRoutesTable).set({ configuredTps: 1_000, queueDepth: jobsPerPhone })
        .where(eq(campaignRoutesTable.id, fixture.route.id));
      await db.update(campaignMetricsTable).set({ total: jobsPerPhone, valid: jobsPerPhone, queued: jobsPerPhone })
        .where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
      await db.insert(campaignJobsTable).values(Array.from({ length: jobsPerPhone - 1 }, (_, index) => ({
        organizationId: fixture.organization.id,
        campaignId: fixture.campaign.id,
        routeId: fixture.route.id,
        contactId: fixture.job.contactId,
        type: "ResolveTemplateAndSend" as const,
        idempotencyKey: `${fixture.organization.slug}-broker-${index}`,
      })));
      await db.update(campaignsTable).set({ killSwitch: false }).where(eq(campaignsTable.id, fixture.campaign.id));
    }
    await client.query("begin");
    await client.query(
      "select id from campaigns where id = any($1::int[]) order by id for update",
      [fixtures.map((fixture) => fixture.campaign.id)],
    );

    const deadline = Date.now() + 8_000;
    while (sender.idempotencyKeys.length < total && Date.now() < deadline) {
      await reservoir.tick();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const supplyDiagnostics = await Promise.all(fixtures.map(async (fixture) => {
      const [counts] = await db.select({
        queued: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Queued')::int`,
        processing: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Processing')::int`,
        sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int`,
      }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, fixture.campaign.id));
      return { campaignId: fixture.campaign.id, phoneId: fixture.phone.id, counts };
    }));
    assert.equal(
      sender.idempotencyKeys.length,
      total,
      `settlement backpressure must not stop provider dispatch: ${JSON.stringify({
        supplyDiagnostics,
        lanes: reservoir.metrics(),
      })}`,
    );
    assert.ok(
      reservoir.metrics().every((lane) => lane.providerInFlight === 0),
      "provider transport capacity must be released before settlement drains",
    );
    assert.equal(
      await worker.waitForIdle(25),
      false,
      "durable exact-lease settlements must remain pending while the campaign row is locked",
    );

    await client.query("commit");
    assert.equal(await worker.waitForIdle(8_000), true);
    const settled = await Promise.all(fixtures.map(async (fixture) => {
      const [counts] = await db.select({
        processing: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Processing')::int`,
        sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int`,
      }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, fixture.campaign.id));
      return counts;
    }));
    assert.ok(settled.every((counts) => counts?.processing === 0 && counts.sent === jobsPerPhone));
  } finally {
    try { await client.query("rollback"); } catch { /* already committed */ }
    client.release();
    await reservoir.stop();
    await worker.closeDispatchScheduler();
    await coordinator.close();
    await Promise.all(fixtures.map((fixture) =>
      db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id))));
  }
});

test("200ms PostgreSQL claim latency is hidden behind prepared broker watermarks", async () => {
  const fixture = await createWorkerFixture(
    `broker-claim-latency-${process.pid}-${Date.now()}`,
    { killSwitchFromStart: true },
  );
  const total = 768;
  const coordinator = new InMemoryPacingCoordinator();
  const sender = new SuccessfulSender();
  const broker = new InMemoryPreparedDispatchBroker();
  const worker = new CampaignWorker(
    new DelayedClaimQueue(200),
    sender,
    new RouteTpsLimiter(coordinator),
    "claim-latency-broker-worker",
  );
  const reservoir = new CampaignPhoneReservoir(
    worker,
    256,
    coordinator,
    "claim-latency-broker-owner",
    4_096,
    new Set([fixture.phone.id]),
    broker,
    50,
  );
  const before = campaignDispatchMetrics.snapshot();
  const startedAt = performance.now();
  try {
    await db.update(phoneNumbersTable).set({ tpsLimit: 1_000 }).where(eq(phoneNumbersTable.id, fixture.phone.id));
    await db.update(campaignRoutesTable).set({ configuredTps: 1_000, queueDepth: total })
      .where(eq(campaignRoutesTable.id, fixture.route.id));
    await db.update(campaignMetricsTable).set({ total, valid: total, queued: total })
      .where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    await db.insert(campaignJobsTable).values(Array.from({ length: total - 1 }, (_, index) => ({
      organizationId: fixture.organization.id,
      campaignId: fixture.campaign.id,
      routeId: fixture.route.id,
      contactId: fixture.job.contactId,
      type: "ResolveTemplateAndSend" as const,
      idempotencyKey: `${fixture.organization.slug}-latency-${index}`,
    })));
    await db.update(campaignsTable).set({ killSwitch: false }).where(eq(campaignsTable.id, fixture.campaign.id));

    const deadline = Date.now() + 8_000;
    while (sender.idempotencyKeys.length < total && Date.now() < deadline) {
      await reservoir.tick();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(sender.idempotencyKeys.length, total);
    const gaps = sender.startedAt.slice(1).map((value, index) => value - sender.startedAt[index]!);
    assert.ok(
      Math.max(...gaps) < 100,
      `prefetched broker supply must hide 200ms claims; maximum provider-start gap was ${Math.max(...gaps).toFixed(2)}ms`,
    );
    const after = campaignDispatchMetrics.snapshot();
    const claims = after.supplyClaimSamples - before.supplyClaimSamples;
    const emptyClaims = after.supplyEmptyClaims - before.supplyEmptyClaims;
    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    assert.ok(claims <= 4, `watermark producer must avoid polling claims; observed ${claims}`);
    assert.ok(emptyClaims <= 1, `watermark producer must make at most one terminal empty claim; observed ${emptyClaims}`);
    assert.ok(after.brokerPublished - before.brokerPublished >= total);
    assert.ok(after.brokerConsumed - before.brokerConsumed >= total);
    assert.equal(after.reservoirStarvationEvents - before.reservoirStarvationEvents, 0);
    assert.ok((after.transportStarts - before.transportStarts) / elapsedSeconds > 100);
    assert.ok(after.supplyRefillSamples > before.supplyRefillSamples);
    assert.ok(reservoir.metrics().every((lane) => lane.brokerDepth === 0 && lane.brokerConsumerLag === 0));
    assert.equal(await worker.waitForIdle(8_000), true);
  } finally {
    await reservoir.stop();
    await worker.closeDispatchScheduler();
    await coordinator.close();
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("a broker outage requeues exact prepared leases and never reaches the provider", async () => {
  const fixture = await createWorkerFixture(
    `broker-outage-${process.pid}-${Date.now()}`,
    { killSwitchFromStart: true },
  );
  const coordinator = new InMemoryPacingCoordinator();
  const sender = new SuccessfulSender();
  const broker: PreparedDispatchBroker = new FailingPublishBroker();
  const worker = new CampaignWorker(
    new DatabaseJobQueue(),
    sender,
    new RouteTpsLimiter(coordinator),
    "broker-outage-worker",
  );
  const reservoir = new CampaignPhoneReservoir(
    worker,
    32,
    coordinator,
    "broker-outage-owner",
    128,
    new Set([fixture.phone.id]),
    broker,
  );
  try {
    await db.update(campaignsTable).set({ killSwitch: false }).where(eq(campaignsTable.id, fixture.campaign.id));
    const deadline = Date.now() + 2_000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      await reservoir.tick();
      const [job] = await db.select({ status: campaignJobsTable.status })
        .from(campaignJobsTable).where(eq(campaignJobsTable.id, fixture.job.id));
      status = job?.status;
      if (status === "Queued") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status, "Queued");
    assert.equal(sender.idempotencyKeys.length, 0);
  } finally {
    await reservoir.stop();
    await worker.closeDispatchScheduler();
    await coordinator.close();
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("concurrent workers settle one campaign without lock-order deadlocks", async () => {
  // This test needs its own test-owned workers (below) to claim real Queued
  // jobs, so it cannot use killSwitch=true the way other races in this file
  // do (claim() refuses every worker, test-owned or live, once killSwitch is
  // set -- see campaign-queue.ts). Instead, killSwitchFromStart keeps the
  // campaign fenced off from the moment it becomes "Running" through this
  // whole multi-step fixture and setup, and only the flip back to false
  // immediately below (right before starting the worker loop) opens it up.
  // This shrinks the window during which the live api-server process's own
  // CampaignRuntime background worker could poll in and steal/claim one of
  // these jobs itself from the entire fixture-plus-setup duration down to
  // effectively zero, without blocking this test's own workers.
  const fixture = await createWorkerFixture(`settlement-lock-order-${process.pid}-${Date.now()}`, { killSwitchFromStart: true });
  const total = 16;
  try {
    await db.update(phoneNumbersTable).set({ tpsLimit: 1_000 })
      .where(eq(phoneNumbersTable.id, fixture.phone.id));
    await db.update(campaignRoutesTable).set({ configuredTps: 1_000, queueDepth: total })
      .where(eq(campaignRoutesTable.id, fixture.route.id));
    await db.update(campaignMetricsTable).set({ total, valid: total, queued: total })
      .where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    await db.insert(campaignJobsTable).values(Array.from({ length: total - 1 }, (_, index) => ({
      organizationId: fixture.organization.id,
      campaignId: fixture.campaign.id,
      routeId: fixture.route.id,
      contactId: fixture.job.contactId,
      type: "ResolveTemplateAndSend" as const,
      idempotencyKey: `${fixture.organization.slug}-lock-order-${index}`,
    })));
    await db.update(campaignsTable).set({ killSwitch: false }).where(eq(campaignsTable.id, fixture.campaign.id));

    const sender = new SuccessfulSender();
    const workers = Array.from({ length: 4 }, (_, index) =>
      new CampaignWorker(new DatabaseJobQueue(), sender, new RouteTpsLimiter(), `lock-order-worker-${index}`));
    const outcomes = await Promise.all(workers.map(async (worker) => {
      for (let attempts = 0; attempts < total; attempts += 1) {
        if (await worker.processOne() === "idle") return;
      }
    }));
    assert.equal(outcomes.length, workers.length, "all concurrent worker loops must finish without a database error");

    const [jobs] = await db.select({
      queued: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Queued')::int`,
      processing: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Processing')::int`,
      sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int`,
      failed: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Failed')::int`,
    }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, fixture.campaign.id));
    const [metrics] = await db.select().from(campaignMetricsTable)
      .where(eq(campaignMetricsTable.campaignId, fixture.campaign.id));
    assert.deepEqual(jobs, { queued: 0, processing: 0, sent: total, failed: 0 });
    assert.equal(metrics?.queued, 0);
    assert.equal(metrics?.processing, 0);
    assert.equal(metrics?.sent, total);
    assert.equal(metrics?.failed, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});