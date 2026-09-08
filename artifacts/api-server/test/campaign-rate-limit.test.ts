import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignJobsTable,
  campaignMetricDeltasTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
} from "@workspace/db";
import {
  CLAIM_CANDIDATE_LIMIT,
  DatabaseJobQueue,
  PACING_LOOKAHEAD_MS,
  RouteTpsLimiter,
  flushCampaignMetricDeltas,
} from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { InMemoryPacingCoordinator } from "../src/services/campaign-pacing-coordinator";

function testLimiter(now = () => Date.now()): RouteTpsLimiter {
  return new RouteTpsLimiter(new InMemoryPacingCoordinator(now));
}

const testAvailableAt = new Date(Date.now() + 60 * 60 * 1000);
const testClaimNow = new Date(testAvailableAt.getTime() + 60 * 60 * 1000);

after(async () => {
  await pool.end();
});

async function createCampaignFixture(options: {
  slug: string;
  phoneLimit: number;
  routeLimits: number[];
  jobsPerRoute: number;
}) {
  const [organization] = await db.insert(organizationsTable).values({
    name: options.slug,
    slug: options.slug,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id,
    phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: options.slug,
    status: "Connected",
    tpsLimit: options.phoneLimit,
  }).returning();

  const routes = [];
  for (const [routeIndex, configuredTps] of options.routeLimits.entries()) {
    const [campaign] = await db.insert(campaignsTable).values({
      organizationId: organization.id,
      name: `${options.slug}-${routeIndex}`,
      status: "Running",
      audienceSize: options.jobsPerRoute,
    }).returning();
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: organization.id,
      campaignId: campaign.id,
      phoneNumberId: phone.id,
      configuredTps,
      queueDepth: options.jobsPerRoute,
    }).returning();
    await db.insert(campaignMetricsTable).values({
      organizationId: organization.id,
      campaignId: campaign.id,
      total: options.jobsPerRoute,
      valid: options.jobsPerRoute,
      queued: options.jobsPerRoute,
    });
    await db.insert(campaignJobsTable).values(Array.from({ length: options.jobsPerRoute }, (_, jobIndex) => ({
      organizationId: organization.id,
      campaignId: campaign.id,
      routeId: route.id,
      type: "Send",
      idempotencyKey: `${options.slug}-${routeIndex}-${jobIndex}`,
      availableAt: testAvailableAt,
    })));
    routes.push(route);
  }
  return { organization, phone, routes };
}

test("multiple queues share route and phone throughput atomically", async () => {
  const slug = `rate-limit-${process.pid}-${Date.now()}`;
  const fixture = await createCampaignFixture({
    slug,
    phoneLimit: 3,
    routeLimits: [2, 2],
    jobsPerRoute: 10,
  });
  let clock = 1_000_000;
  const limiter = testLimiter(() => clock);

  try {
    const claimed = [];
    // At 2 TPS a route exposes only a bounded number of permits in each
    // one-second lookahead. Advance the test coordinator clock between waves
    // instead of relying on wall-clock sleeps, until both routes are drained.
    for (let wave = 0; wave < 20; wave += 1) {
      const job = await new DatabaseJobQueue().claim(limiter, `worker-${wave}`, 30_000, testClaimNow);
      if (job) claimed.push(job);
      clock += 1_000;
    }
    assert.equal(
      new Set(claimed.map((job) => job.id)).size,
      claimed.length,
      "concurrent workers must never claim the same send job twice",
    );
    assert.equal(
      new Set(claimed.map((job) => job.idempotencyKey)).size,
      claimed.length,
      "concurrent workers must preserve unique send idempotency keys",
    );

    assert.equal(claimed.length, 20, "each queued job must receive one durable lease");
    assert.equal(new Set(claimed.map((job) => job.routeId)).size, 2, "both routes must receive shared-phone permits");
    const scheduled = claimed.map((job) => job.scheduledSendAt!.getTime()).sort((a, b) => a - b);
    assert.ok(scheduled.every((at, index) => index === 0 || at - scheduled[index - 1]! >= (1_000 / 3)),
      "shared-phone Redis reservations must produce a unique durable timeline");

    const processing = await db.select({ count: sql<number>`count(*)::int` }).from(campaignJobsTable)
      .where(and(
        eq(campaignJobsTable.organizationId, fixture.organization.id),
        eq(campaignJobsTable.status, "Processing"),
      ));
    assert.equal(processing[0]?.count, claimed.length);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("a recovered attempt consumes exactly one new token and tenant windows stay isolated", async () => {
  const prefix = `rate-recovery-${process.pid}-${Date.now()}`;
  const first = await createCampaignFixture({ slug: `${prefix}-a`, phoneLimit: 2, routeLimits: [2], jobsPerRoute: 1 });
  const second = await createCampaignFixture({ slug: `${prefix}-b`, phoneLimit: 2, routeLimits: [2], jobsPerRoute: 2 });
  const limiter = testLimiter();

  try {
    const initial = await new DatabaseJobQueue().claim(limiter, "worker-a", 200, testClaimNow);
    assert.ok(initial);
    assert.ok(initial.lockedAt && initial.lockedAt.getTime() > Date.now() - 5_000, "leases must use the database claim clock");

    await db.update(campaignsTable).set({ status: "Paused" }).where(eq(campaignsTable.id, initial.campaignId));
    const runtime = new CampaignRuntime();
    await (runtime as unknown as { reapExpiredLeases(now: Date): Promise<void> })
      .reapExpiredLeases(new Date(Date.now() + 60 * 60 * 1000));
    const [beforeDatabaseExpiry] = await db.select({ status: campaignJobsTable.status }).from(campaignJobsTable)
      .where(eq(campaignJobsTable.id, initial.id));
    assert.equal(beforeDatabaseExpiry?.status, "Processing", "a fast replica clock must not reap a valid DB-clock lease");

    await new Promise((resolve) => setTimeout(resolve, 350));
    await (runtime as unknown as { reapExpiredLeases(now: Date): Promise<void> })
      .reapExpiredLeases(new Date(Date.now() + 60 * 60 * 1000));
    const [afterDatabaseExpiry] = await db.select({ status: campaignJobsTable.status }).from(campaignJobsTable)
      .where(eq(campaignJobsTable.id, initial.id));
    assert.equal(afterDatabaseExpiry?.status, "Queued", "the database must reap the lease after its own clock reaches expiry");
    await db.update(campaignJobsTable).set({ availableAt: testAvailableAt })
      .where(eq(campaignJobsTable.id, initial.id));
    const whilePaused = await new DatabaseJobQueue().claim(limiter, "worker-paused", 30_000, testClaimNow);
    assert.notEqual(whilePaused?.organizationId, first.organization.id, "a paused tenant must not release or spend another token");
    await db.update(campaignsTable).set({ status: "Running" }).where(eq(campaignsTable.id, initial.campaignId));

    const concurrentClaims = await Promise.all([
      new DatabaseJobQueue().claim(limiter, "worker-b", 30_000, testClaimNow),
      new DatabaseJobQueue().claim(limiter, "worker-c", 30_000, testClaimNow),
      new DatabaseJobQueue().claim(limiter, "worker-d", 30_000, testClaimNow),
    ]);
    const firstTenantClaims = concurrentClaims.filter((job) => job?.organizationId === first.organization.id);
    const secondTenantClaims = concurrentClaims.filter((job) => job?.organizationId === second.organization.id);
    // A 2 TPS timeline intentionally exposes only one slot per 500ms rather
    // than allowing both claims to burst at once. Wait for the second paced
    // slot and prove the other tenant continues independently.
    await new Promise((resolve) => setTimeout(resolve, 550));
    const pacedSecondTenantClaim = await new DatabaseJobQueue().claim(
      limiter,
      "worker-paced-second-tenant",
      30_000,
      testClaimNow,
    );
    assert.equal(firstTenantClaims.length, 1, "the recovered attempt must use the first tenant's final token");
    assert.equal(firstTenantClaims[0]?.id, initial.id, "stale recovery must reclaim the same job");
    assert.equal(firstTenantClaims[0]?.attempts, 2, "stale recovery must consume exactly one new attempt");
    assert.equal(
      secondTenantClaims.length
        + (whilePaused?.organizationId === second.organization.id ? 1 : 0)
        + (pacedSecondTenantClaim?.organizationId === second.organization.id ? 1 : 0),
      2,
      "another tenant must have an independent provider window",
    );

    assert.ok(firstTenantClaims[0]!.scheduledSendAt!.getTime() > initial.scheduledSendAt!.getTime(),
      "a recovered claim consumes a later coordinator permit");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, first.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, second.organization.id));
  }
});

test("claim selection has a fixed candidate bound and favors older eligible work", async () => {
  assert.equal(CLAIM_CANDIDATE_LIMIT, 100, "one claim attempt must inspect no more than 100 candidates");
  const slug = `claim-order-${process.pid}-${Date.now()}`;
  const fixture = await createCampaignFixture({
    slug,
    phoneLimit: 2,
    routeLimits: [1, 1],
    jobsPerRoute: 1,
  });
  try {
    const oldAvailableAt = new Date(testClaimNow.getTime() - 2_000);
    const newAvailableAt = new Date(testClaimNow.getTime() - 1_000);
    await db.update(campaignJobsTable).set({ availableAt: oldAvailableAt })
      .where(eq(campaignJobsTable.routeId, fixture.routes[0]!.id));
    await db.update(campaignJobsTable).set({ availableAt: newAvailableAt })
      .where(eq(campaignJobsTable.routeId, fixture.routes[1]!.id));

    const claimed = await new DatabaseJobQueue().claim(new RouteTpsLimiter(), "ordering-worker", 30_000, testClaimNow);
    assert.equal(claimed?.routeId, fixture.routes[0]?.id, "older eligible work must win before priority tie-breaking");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("batch claims replenish the least-loaded independent phone route first", async () => {
  const prefix = `batch-route-balance-${process.pid}-${Date.now()}`;
  const first = await createCampaignFixture({
    slug: `${prefix}-a`,
    phoneLimit: 1_000,
    routeLimits: [1_000],
    jobsPerRoute: 96,
  });
  const second = await createCampaignFixture({
    slug: `${prefix}-b`,
    phoneLimit: 1_000,
    routeLimits: [1_000],
    jobsPerRoute: 96,
  });
  try {
    const queue = new DatabaseJobQueue();
    const busy = new Map<number, number>();
    const claiming = new Set<number>();
    const initial = await queue.claimBatch(
      new RouteTpsLimiter(),
      "batch-balance-a",
      30_000,
      32,
      testClaimNow,
      busy,
      (configuredTps) => configuredTps * 3,
      claiming,
    );
    assert.equal(initial.length, 32);
    const firstRouteId = initial[0]!.routeId!;
    assert.ok(initial.every((job) => job.routeId === firstRouteId));
    busy.set(firstRouteId, initial.length);

    const replenished = await queue.claimBatch(
      new RouteTpsLimiter(),
      "batch-balance-b",
      30_000,
      32,
      testClaimNow,
      busy,
      (configuredTps) => configuredTps * 3,
      claiming,
    );
    assert.equal(replenished.length, 32);
    assert.ok(
      replenished.every((job) => job.routeId !== firstRouteId),
      "a zero-load independent phone must replenish before an already-loaded route",
    );
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, first.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, second.organization.id));
  }
});

test("batch claim persists a durable metrics delta without waiting on the hot campaign counter", async () => {
  const fixture = await createCampaignFixture({
    slug: `claim-metric-delta-${process.pid}-${Date.now()}`,
    phoneLimit: 1_000,
    routeLimits: [1_000],
    jobsPerRoute: 32,
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select campaign_id from campaign_metrics where campaign_id = $1 for update",
      [fixture.routes[0]!.campaignId],
    );

    const claimed = await Promise.race([
      new DatabaseJobQueue().claimBatch(
        new RouteTpsLimiter(),
        "metric-delta-claim",
        30_000,
        32,
        testClaimNow,
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("claim waited on locked campaign_metrics row")), 2_000);
      }),
    ]);
    assert.equal(claimed.length, 32);

    const [beforeFlush] = await db.select({
      queued: campaignMetricsTable.queued,
      processing: campaignMetricsTable.processing,
    }).from(campaignMetricsTable)
      .where(eq(campaignMetricsTable.campaignId, fixture.routes[0]!.campaignId));
    assert.deepEqual(beforeFlush, { queued: 32, processing: 0 });
    const [pending] = await db.select({
      count: sql<number>`count(*)::int`,
      queued: sql<number>`sum(${campaignMetricDeltasTable.queuedDelta})::int`,
      processing: sql<number>`sum(${campaignMetricDeltasTable.processingDelta})::int`,
    }).from(campaignMetricDeltasTable)
      .where(eq(campaignMetricDeltasTable.campaignId, fixture.routes[0]!.campaignId));
    assert.deepEqual(pending, { count: 1, queued: -32, processing: 32 });

    await client.query("commit");
    assert.equal(await flushCampaignMetricDeltas(fixture.routes[0]!.campaignId), 1);
    const [afterFlush] = await db.select({
      queued: campaignMetricsTable.queued,
      processing: campaignMetricsTable.processing,
    }).from(campaignMetricsTable)
      .where(eq(campaignMetricsTable.campaignId, fixture.routes[0]!.campaignId));
    assert.deepEqual(afterFlush, { queued: 0, processing: 32 });
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

test("multiple saturated phones cannot fill the bound and hide another phone", async () => {
  const prefix = `phone-fairness-${process.pid}-${Date.now()}`;
  const blocked = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    createCampaignFixture({
      slug: `${prefix}-blocked-${index}`,
      phoneLimit: 1,
      routeLimits: [1],
      jobsPerRoute: CLAIM_CANDIDATE_LIMIT + 10,
    })));
  const eligible = await createCampaignFixture({
    slug: `${prefix}-eligible`,
    phoneLimit: 1,
    routeLimits: [1],
    jobsPerRoute: 1,
  });
  try {
    const clock = 2_000_000;
    const coordinator = new InMemoryPacingCoordinator(() => clock);
    const limiter = new RouteTpsLimiter(coordinator);
    // Fill each blocked phone's current horizon through the same atomic
    // coordinator. The slots are deliberately wasted, just as a DB claim
    // race may waste a Redis permit; an unrelated phone must remain claimable.
    await Promise.all(blocked.map((fixture) => coordinator.reserveBatch({
      organizationId: fixture.organization.id,
      phoneNumberId: fixture.phone.id,
      routeId: fixture.routes[0]!.id,
      phoneTps: 1,
      routeTps: 1,
      requested: (PACING_LOOKAHEAD_MS / 1_000) + 1,
      prepareMs: 250,
      maxLookaheadMs: PACING_LOOKAHEAD_MS,
    })));
    const queue = new DatabaseJobQueue();
    const next = await queue.claim(limiter, "fairness-second", 30_000, testClaimNow);
    assert.equal(
      next?.organizationId,
      eligible.organization.id,
      "one saturated phone must not fill the bounded candidate prefix",
    );
  } finally {
    for (const fixture of blocked) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
    }
    await db.delete(organizationsTable).where(eq(organizationsTable.id, eligible.organization.id));
  }
});

test("a claim re-reads a lowered phone cap while holding the provider row lock", async () => {
  const slug = `cap-race-${process.pid}-${Date.now()}`;
  const fixture = await createCampaignFixture({
    slug,
    phoneLimit: 2,
    routeLimits: [2],
    jobsPerRoute: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select id from phone_numbers where id = $1 for update", [fixture.phone.id]);
    const claiming = new DatabaseJobQueue().claim(
      new RouteTpsLimiter(),
      "cap-race-worker",
      30_000,
      testClaimNow,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.query("update phone_numbers set tps_limit = 1 where id = $1", [fixture.phone.id]);
    await client.query("commit");

    assert.equal(await claiming, undefined, "the stale pre-lock cap must never authorize a claim");
    const [job] = await db.select({ status: campaignJobsTable.status }).from(campaignJobsTable)
      .where(eq(campaignJobsTable.organizationId, fixture.organization.id));
    assert.equal(job?.status, "Queued");
  } finally {
    if ((client as unknown as { _ending?: boolean })._ending !== true) {
      try {
        await client.query("rollback");
      } catch {
        // Transaction already committed.
      }
    }
    client.release();
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});