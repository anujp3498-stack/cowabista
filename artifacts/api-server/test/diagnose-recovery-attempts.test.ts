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
} from "@workspace/db";
import {
  CampaignWorker,
  DatabaseJobQueue,
  RouteTpsLimiter,
  type CampaignJob,
  type ProviderSender,
} from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import {
  InMemoryPreparedDispatchBroker,
  type BrokerDelivery,
  type BrokerPartitionMetrics,
  type PreparedDispatchBroker,
} from "../src/services/campaign-prepared-broker";

after(async () => {
  await pool.end();
});

type Snapshot = {
  status: string;
  attempts: number;
  lockedBy: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  availableAt: Date;
};

async function snapshot(jobId: number): Promise<Snapshot> {
  const [row] = await db.select({
    status: campaignJobsTable.status,
    attempts: campaignJobsTable.attempts,
    lockedBy: campaignJobsTable.lockedBy,
    leaseToken: campaignJobsTable.leaseToken,
    leaseExpiresAt: campaignJobsTable.leaseExpiresAt,
    availableAt: campaignJobsTable.availableAt,
  }).from(campaignJobsTable).where(eq(campaignJobsTable.id, jobId));
  assert.ok(row);
  return row;
}

function describe(label: string, row: Snapshot): void {
  console.log(`[recovery-diagnostic] ${label} ${JSON.stringify({
    ...row,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    availableAt: row.availableAt.toISOString(),
  })}`);
}

class TracingQueue extends DatabaseJobQueue {
  readonly claims: Array<{
    at: string;
    workerId: string;
    ids: number[];
    snapshots: Snapshot[];
  }> = [];

  override async claimBatch(
    limiter: RouteTpsLimiter,
    workerId: string,
    leaseMs: number,
    batchSize: number,
    now = new Date(),
    busyRouteIds?: ReadonlyMap<number, number>,
    getMaxInFlight?: (configuredTps: number) => number,
    claimingRouteIds?: Set<number>,
    phoneNumberId?: number,
  ): Promise<CampaignJob[]> {
    const jobs = await super.claimBatch(
      limiter,
      workerId,
      leaseMs,
      batchSize,
      now,
      busyRouteIds,
      getMaxInFlight,
      claimingRouteIds,
      phoneNumberId,
    );
    const snapshots = await Promise.all(jobs.map((job) => snapshot(job.id)));
    this.claims.push({ at: new Date().toISOString(), workerId, ids: jobs.map((job) => job.id), snapshots });
    for (const [index, job] of jobs.entries()) describe(`claim #${this.claims.length} job=${job.id}`, snapshots[index]!);
    return jobs;
  }
}

class DiagnosticSender implements ProviderSender {
  readonly starts: Array<{ jobId: number; attempts: number; idempotencyKey: string }> = [];

  async send(job: CampaignJob, { idempotencyKey }: { signal: AbortSignal; idempotencyKey: string }) {
    this.starts.push({ jobId: job.id, attempts: job.attempts, idempotencyKey });
    console.log(`[recovery-diagnostic] provider-start ${JSON.stringify(this.starts.at(-1))}`);
    return { providerMessageId: `diagnostic-${idempotencyKey}-${job.attempts}` };
  }
}

class PreparedDiagnosticSender implements ProviderSender {
  readonly starts: Array<{ jobId: number; attempts: number; idempotencyKey: string; startedAt: number }> = [];

  serializePreparedTransport(job: CampaignJob) {
    return {
      kind: "benchmark" as const,
      delayMs: 1,
      providerMessageId: `prepared-diagnostic-${job.id}-${job.attempts}`,
    };
  }

  observeShardTransportStart(job: CampaignJob, startedAt: number): void {
    this.starts.push({
      jobId: job.id,
      attempts: job.attempts,
      idempotencyKey: job.idempotencyKey,
      startedAt,
    });
    console.log(`[recovery-diagnostic] prepared-provider-start ${JSON.stringify(this.starts.at(-1))}`);
  }
}

class DelayedConsumeBroker implements PreparedDispatchBroker {
  private readonly delegate = new InMemoryPreparedDispatchBroker();
  private delayed = false;

  async publish(phoneNumberId: number, fencingToken: number, envelopes: Parameters<PreparedDispatchBroker["publish"]>[2]) {
    return this.delegate.publish(phoneNumberId, fencingToken, envelopes);
  }

  async consume(phoneNumberId: number, consumerId: string, count: number): Promise<BrokerDelivery[]> {
    const deliveries = await this.delegate.consume(phoneNumberId, consumerId, count);
    if (deliveries.length && !this.delayed) {
      this.delayed = true;
      console.log("[recovery-diagnostic] delaying first broker consume beyond lease");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    return deliveries;
  }

  async reclaimAbandoned(phoneNumberId: number, consumerId: string, minIdleMs: number, count: number, cursor?: string) {
    return this.delegate.reclaimAbandoned(phoneNumberId, consumerId, minIdleMs, count, cursor);
  }

  async acknowledge(phoneNumberId: number, ids: string[]): Promise<void> {
    return this.delegate.acknowledge(phoneNumberId, ids);
  }

  async metrics(phoneNumberId: number): Promise<BrokerPartitionMetrics> {
    return this.delegate.metrics(phoneNumberId);
  }

  async close(): Promise<void> {
    return this.delegate.close();
  }
}

async function createFixture(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert((await import("@workspace/db")).wabasTable).values({
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
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: organization.id,
    name: slug,
    status: "Running",
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
  }).returning();
  return { organization, campaign, job };
}

test("diagnose interrupted lease attempt transitions", async () => {
  const slug = `recovery-diagnostic-${process.pid}-${Date.now()}`;
  const fixture = await createFixture(slug);
  const queue = new TracingQueue();
  const sender = new DiagnosticSender();
  let runtime: CampaignRuntime | undefined;
  try {
    describe("initial", await snapshot(fixture.job.id));
    const interrupted = await queue.claim(new RouteTpsLimiter(), "diagnostic-interrupted-worker", 250, new Date());
    assert.ok(interrupted);
    describe("after interrupted claim #1", await snapshot(fixture.job.id));

    await new Promise((resolve) => setTimeout(resolve, 300));
    runtime = new CampaignRuntime(sender, undefined, { queue, batchSize: 1 });
    await (runtime as unknown as { reapExpiredLeases(now: Date): Promise<void> })
      .reapExpiredLeases(new Date());
    describe("after explicit reap", await snapshot(fixture.job.id));

    const watcher = setInterval(async () => {
      try {
        describe("poll", await snapshot(fixture.job.id));
      } catch {
        // Cleanup can remove the row after the test has completed.
      }
    }, 25);
    watcher.unref();

    runtime = new CampaignRuntime(sender, undefined, { queue, batchSize: 1 });
    runtime.start(20);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = await snapshot(fixture.job.id);
      if (row.status === "Sent") break;
      if (Date.now() >= deadline) throw new Error(`diagnostic did not settle: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    clearInterval(watcher);
    const final = await snapshot(fixture.job.id);
    describe("final", final);
    console.log(`[recovery-diagnostic] claims ${JSON.stringify(queue.claims.map((claim) => ({
      ...claim,
      snapshots: claim.snapshots.map((row) => ({
        ...row,
        leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
        availableAt: row.availableAt.toISOString(),
      })),
    })))}`);
    console.log(`[recovery-diagnostic] provider-starts ${JSON.stringify(sender.starts)}`);
    assert.equal(final.attempts, 2);
    assert.equal(sender.starts.length, 1);
    assert.deepEqual(
      queue.claims.filter((claim) => claim.ids.includes(fixture.job.id)).map((claim) => claim.snapshots[0]?.attempts),
      [1, 2],
    );
  } finally {
    if (runtime) await runtime.stop();
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("prepared broker lease expiry causes one stale-envelope replacement without provider replay", async () => {
  const slug = `prepared-recovery-diagnostic-${process.pid}-${Date.now()}`;
  const fixture = await createFixture(slug);
  const queue = new TracingQueue();
  const sender = new PreparedDiagnosticSender();
  const broker = new DelayedConsumeBroker();
  let runtime: CampaignRuntime | undefined;
  try {
    const interrupted = await queue.claim(new RouteTpsLimiter(), "prepared-interrupted-worker", 250, new Date());
    assert.ok(interrupted);
    await new Promise((resolve) => setTimeout(resolve, 300));
    runtime = new CampaignRuntime(sender, 2_000, {
      queue,
      batchSize: 1,
      preparedBroker: broker,
      brokerAbandonedDeliveryMs: 10_000,
    });
    await (runtime as unknown as { reapExpiredLeases(now: Date): Promise<void> })
      .reapExpiredLeases(new Date());
    runtime.start(20);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = await snapshot(fixture.job.id);
      if (row.status === "Sent") break;
      if (Date.now() >= deadline) throw new Error(`prepared diagnostic did not settle: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const final = await snapshot(fixture.job.id);
    console.log(`[recovery-diagnostic] prepared-final ${JSON.stringify({
      ...final,
      leaseExpiresAt: final.leaseExpiresAt?.toISOString() ?? null,
      availableAt: final.availableAt.toISOString(),
    })}`);
    console.log(`[recovery-diagnostic] prepared-provider-starts ${JSON.stringify(sender.starts)}`);
    assert.equal(final.attempts, 2);
    assert.equal(sender.starts.length, 1);
    assert.equal(sender.starts[0]?.attempts, 2);
    assert.deepEqual(
      queue.claims.filter((claim) => claim.ids.includes(fixture.job.id)).map((claim) => claim.snapshots[0]?.attempts),
      [1, 2],
    );
  } finally {
    if (runtime) await runtime.stop();
    await broker.close();
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});