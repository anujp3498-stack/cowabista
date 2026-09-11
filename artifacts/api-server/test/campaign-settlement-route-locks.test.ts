import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  campaignContactsTable, campaignJobsTable, campaignMetricsTable, campaignRoutesTable, campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable, campaignsTable, db, organizationsTable, phoneNumbersTable, pool, settlementDb,
  settlementPool, templatesTable, wabasTable,
} from "@workspace/db";
import {
  CampaignWorker, DatabaseJobQueue, RouteTpsLimiter, decrementRouteQueueDepths, lockCampaignRoutes, type ProviderSender,
} from "../src/services/campaign-queue";
import { inFlightRegistry } from "../src/services/campaign-inflight";

// P12: success settlement takes every affected route lock in ONE ordered
// statement and applies every route queue-depth decrement in ONE set-based
// statement. These tests pin that the locked set, the lock order, and the
// resulting queue_depth values are exactly what the per-route loops produced.

const createdCampaignIds: number[] = [];
after(async () => {
  inFlightRegistry.clear();
  if (createdCampaignIds.length) await db.update(campaignsTable).set({ status: "Cancelled" }).where(inArray(campaignsTable.id, createdCampaignIds));
  await pool.end();
  await settlementPool.end();
});

class SuccessfulSender implements ProviderSender {
  async send(_job: typeof campaignJobsTable.$inferSelect, options: { idempotencyKey: string }) {
    return { providerMessageId: `provider-${options.idempotencyKey}` };
  }
}
type Job = typeof campaignJobsTable.$inferSelect;

async function fixture(slug: string, routeCount: number, jobsPerRoute: number) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${slug}-template`, status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: slug, status: "Running" }).returning();
  createdCampaignIds.push(campaign!.id);
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id, component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total: routeCount * jobsPerRoute, valid: routeCount * jobsPerRoute, queued: routeCount * jobsPerRoute });
  const routes = []; const jobsByRoute = new Map<number, Job[]>();
  for (let r = 0; r < routeCount; r += 1) {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization!.id, wabaId: waba!.id, phone: `+1555${organization!.id.toString().padStart(4, "0")}${r.toString().padStart(3, "0")}`,
      displayName: `${slug}-${r}`, status: "Connected", tpsLimit: 50,
    }).returning();
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone!.id, templateId: template!.id, configuredTps: 50, queueDepth: jobsPerRoute,
    }).returning();
    routes.push(route!);
    const jobs: Job[] = [];
    for (let index = 0; index < jobsPerRoute; index += 1) {
      const [contact] = await db.insert(campaignContactsTable).values({
        organizationId: organization!.id, campaignId: campaign!.id, rowNumber: r * jobsPerRoute + index + 1, rawPhone: phone!.phone, normalizedPhone: phone!.phone,
        data: { phone: phone!.phone }, status: "Valid", partitionKey: 1, routeId: route!.id, idempotencyKey: `${slug}-r${r}-c${index}`,
      }).returning();
      const [job] = await db.insert(campaignJobsTable).values({
        organizationId: organization!.id, campaignId: campaign!.id, routeId: route!.id, contactId: contact!.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-r${r}-j${index}`,
      }).returning();
      jobs.push(job!);
    }
    jobsByRoute.set(route!.id, jobs);
  }
  return { organization: organization!, campaign: campaign!, routes, jobsByRoute };
}
async function lease(jobs: Job[], token: string): Promise<Job[]> {
  const now = new Date();
  return db.update(campaignJobsTable).set({
    status: "Processing", leaseToken: token, lockedAt: now, lockedBy: "p12-test", leaseExpiresAt: new Date(now.getTime() + 60_000), attempts: 1,
  }).where(inArray(campaignJobsTable.id, jobs.map((job) => job.id))).returning();
}
const worker = () => new CampaignWorker(new DatabaseJobQueue(), new SuccessfulSender(), new RouteTpsLimiter(), `p12-${process.pid}-${Date.now()}`);
function settle(w: CampaignWorker, campaignId: number, jobs: Job[], payloadOverride?: unknown): Promise<void> {
  const successful = jobs.map((job) => ({ job, resolvedJob: payloadOverride === undefined ? job : { ...job, payload: payloadOverride }, providerMessageId: `pm-${job.id}` }));
  return (w as any).enqueueSuccessfulSettlement({ campaignId, successful, now: new Date() });
}
async function depths(routeIds: number[]): Promise<Map<number, number>> {
  const rows = await db.select({ id: campaignRoutesTable.id, depth: campaignRoutesTable.queueDepth }).from(campaignRoutesTable).where(inArray(campaignRoutesTable.id, routeIds));
  return new Map(rows.map((row) => [row.id, row.depth]));
}
async function statuses(jobIds: number[]): Promise<Map<number, { status: string; leaseToken: string | null }>> {
  const rows = await db.select({ id: campaignJobsTable.id, status: campaignJobsTable.status, leaseToken: campaignJobsTable.leaseToken }).from(campaignJobsTable).where(inArray(campaignJobsTable.id, jobIds));
  return new Map(rows.map((row) => [row.id, { status: row.status, leaseToken: row.leaseToken }]));
}
async function outstandingByRoute(routeIds: number[]): Promise<Map<number, number>> {
  const rows = await db.select({ id: campaignJobsTable.routeId, count: sql<number>`count(*)::int` }).from(campaignJobsTable)
    .where(and(inArray(campaignJobsTable.routeId, routeIds), inArray(campaignJobsTable.status, ["Queued", "Processing"]))).groupBy(campaignJobsTable.routeId);
  return new Map(routeIds.map((id) => [id, rows.find((row) => row.id === id)?.count ?? 0]));
}
const cleanup = (organizationId: number) => db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
const slug = (name: string) => `p12-${name}-${process.pid}-${Date.now()}`;

test("A · one route: every job in the batch settles and queue_depth drops by exactly the batch size", async () => {
  const f = await fixture(slug("one"), 1, 5);
  try {
    const route = f.routes[0]!; const jobs = await lease(f.jobsByRoute.get(route.id)!, "t-a");
    await settle(worker(), f.campaign.id, jobs);
    assert.ok([...(await statuses(jobs.map((j) => j.id))).values()].every((s) => s.status === "Sent" && s.leaseToken === null));
    assert.equal((await depths([route.id])).get(route.id), 0);
  } finally { await cleanup(f.organization.id); }
});

test("B · four routes in one batch: each route is decremented by its own count only", async () => {
  const f = await fixture(slug("four"), 4, 3);
  try {
    const batch: Job[] = [];
    for (const route of f.routes) batch.push(...(await lease(f.jobsByRoute.get(route.id)!.slice(0, 2), "t-b")));
    await settle(worker(), f.campaign.id, batch);
    const d = await depths(f.routes.map((r) => r.id));
    for (const route of f.routes) assert.equal(d.get(route.id), 1, `route ${route.id} must go 3 -> 1`);
    assert.equal([...(await statuses(batch.map((j) => j.id))).values()].filter((s) => s.status === "Sent").length, 8);
  } finally { await cleanup(f.organization.id); }
});

test("C · a route deleted after claim (its jobs cascade away): the batch still carrying them settles the rest, no error", async () => {
  const f = await fixture(slug("missing"), 3, 2);
  try {
    const batch: Job[] = [];
    for (const route of f.routes) batch.push(...(await lease(f.jobsByRoute.get(route.id)!, "t-c")));
    const gone = f.routes[1]!;
    await db.delete(campaignRoutesTable).where(eq(campaignRoutesTable.id, gone.id)); // campaign_jobs on this route cascade-delete
    await settle(worker(), f.campaign.id, batch); // the in-memory batch still lists the deleted route and its jobs
    const survivors = batch.filter((job) => job.routeId !== gone.id);
    const s = await statuses(batch.map((j) => j.id));
    assert.equal(s.size, survivors.length, "the deleted route's jobs no longer exist");
    assert.ok(survivors.every((job) => s.get(job.id)!.status === "Sent"));
    const d = await depths([f.routes[0]!.id, f.routes[2]!.id]);
    assert.equal(d.get(f.routes[0]!.id), 0); assert.equal(d.get(f.routes[2]!.id), 0);
  } finally { await cleanup(f.organization.id); }
});

test("D · many jobs on one route and a job listed twice: one lock, one decrement per job row, never per input row", async () => {
  const f = await fixture(slug("dup"), 2, 6);
  try {
    const route = f.routes[0]!; const jobs = await lease(f.jobsByRoute.get(route.id)!, "t-d");
    await settle(worker(), f.campaign.id, [...jobs, jobs[0]!, jobs[1]!]);
    assert.equal((await depths([route.id])).get(route.id), 0, "6 jobs settle once each: 6 -> 0, not 6 -> -2 floored");
    assert.equal((await depths([f.routes[1]!.id])).get(f.routes[1]!.id), 6, "an untouched route is untouched");
  } finally { await cleanup(f.organization.id); }
});

test("E/H · mixed batch with a fenced job: only rows the UPDATE actually changed count toward queue_depth; the fenced lease is untouched", async () => {
  const f = await fixture(slug("fence"), 2, 3);
  try {
    const a = await lease(f.jobsByRoute.get(f.routes[0]!.id)!, "t-e"); const b = await lease(f.jobsByRoute.get(f.routes[1]!.id)!, "t-e");
    // another worker took over one job on route b: its token changed under us
    await db.update(campaignJobsTable).set({ leaseToken: "taken-over" }).where(eq(campaignJobsTable.id, b[0]!.id));
    await settle(worker(), f.campaign.id, [...a, ...b]);
    const s = await statuses([...a, ...b].map((j) => j.id));
    assert.deepEqual(s.get(b[0]!.id), { status: "Processing", leaseToken: "taken-over" });
    assert.equal([...s.values()].filter((x) => x.status === "Sent").length, 5);
    const d = await depths(f.routes.map((r) => r.id));
    assert.equal(d.get(f.routes[0]!.id), 0); assert.equal(d.get(f.routes[1]!.id), 1, "route b: 3 - 2 updated rows");
  } finally { await cleanup(f.organization.id); }
});

test("F · concurrent batches on different campaigns settle independently with exact depths", async () => {
  const f1 = await fixture(slug("c1"), 2, 4); const f2 = await fixture(slug("c2"), 2, 4);
  try {
    const w = worker();
    const j1 = [...(await lease(f1.jobsByRoute.get(f1.routes[0]!.id)!, "t-f1")), ...(await lease(f1.jobsByRoute.get(f1.routes[1]!.id)!.slice(0, 1), "t-f1"))];
    const j2 = [...(await lease(f2.jobsByRoute.get(f2.routes[0]!.id)!.slice(0, 2), "t-f2")), ...(await lease(f2.jobsByRoute.get(f2.routes[1]!.id)!, "t-f2"))];
    await Promise.all([settle(w, f1.campaign.id, j1), settle(w, f2.campaign.id, j2)]);
    const d1 = await depths(f1.routes.map((r) => r.id)); const d2 = await depths(f2.routes.map((r) => r.id));
    assert.deepEqual([d1.get(f1.routes[0]!.id), d1.get(f1.routes[1]!.id)], [0, 3]);
    assert.deepEqual([d2.get(f2.routes[0]!.id), d2.get(f2.routes[1]!.id)], [2, 0]);
  } finally { await cleanup(f1.organization.id); await cleanup(f2.organization.id); }
});

test("G · same-campaign contention: concurrent batches serialize and every route ends exactly right", async () => {
  const f = await fixture(slug("same"), 4, 8);
  try {
    const w = worker(); const batches: Job[][] = [[], [], [], []];
    for (const route of f.routes) {
      const leased = await lease(f.jobsByRoute.get(route.id)!, "t-g");
      leased.forEach((job, index) => batches[index % 4]!.push(job));
    }
    await Promise.all(batches.map((batch) => settle(w, f.campaign.id, batch)));
    const d = await depths(f.routes.map((r) => r.id));
    for (const route of f.routes) assert.equal(d.get(route.id), 0);
    assert.deepEqual(await outstandingByRoute(f.routes.map((r) => r.id)), new Map(f.routes.map((r) => [r.id, 0])));
  } finally { await cleanup(f.organization.id); }
});

test("I · a batch that fails inside its transaction leaves leases, statuses and depths untouched, and a later batch recovers them", async () => {
  const f = await fixture(slug("crash"), 2, 3);
  try {
    const w = worker(); const jobs = [...(await lease(f.jobsByRoute.get(f.routes[0]!.id)!, "t-i")), ...(await lease(f.jobsByRoute.get(f.routes[1]!.id)!, "t-i"))];
    // JSON.stringify of a BigInt payload throws after the campaign and route locks are held: the transaction rolls back.
    await assert.rejects(() => settle(w, f.campaign.id, jobs, { poison: 1n }), /BigInt/);
    const s = await statuses(jobs.map((j) => j.id));
    assert.ok([...s.values()].every((x) => x.status === "Processing" && x.leaseToken === "t-i"));
    assert.deepEqual([...(await depths(f.routes.map((r) => r.id))).values()], [3, 3]);
    await settle(w, f.campaign.id, jobs);
    assert.ok([...(await statuses(jobs.map((j) => j.id))).values()].every((x) => x.status === "Sent"));
    assert.deepEqual([...(await depths(f.routes.map((r) => r.id))).values()], [0, 0]);
  } finally { await cleanup(f.organization.id); }
});

test("J · STOP/kill after the provider accepted: settlement still records Sent and decrements depth (unchanged semantics)", async () => {
  const f = await fixture(slug("stop"), 1, 3);
  try {
    const jobs = await lease(f.jobsByRoute.get(f.routes[0]!.id)!, "t-j");
    await db.update(campaignsTable).set({ status: "Cancelled", killSwitch: true }).where(eq(campaignsTable.id, f.campaign.id));
    await settle(worker(), f.campaign.id, jobs);
    assert.ok([...(await statuses(jobs.map((j) => j.id))).values()].every((x) => x.status === "Sent"));
    assert.equal((await depths([f.routes[0]!.id])).get(f.routes[0]!.id), 0);
  } finally { await cleanup(f.organization.id); }
});

test("K · queue_depth exactness across mixed batches: depth always equals the outstanding job count per route", async () => {
  const f = await fixture(slug("exact"), 4, 10);
  try {
    const w = worker(); const all = new Map<number, Job[]>();
    for (const route of f.routes) all.set(route.id, await lease(f.jobsByRoute.get(route.id)!, "t-k"));
    const plan = [[3, 0, 5, 1], [4, 7, 2, 0], [3, 3, 3, 9]];
    for (const counts of plan) {
      const batch: Job[] = [];
      f.routes.forEach((route, index) => { const jobs = all.get(route.id)!; batch.push(...jobs.splice(0, counts[index]!)); });
      await settle(w, f.campaign.id, batch);
      const d = await depths(f.routes.map((r) => r.id)); const o = await outstandingByRoute(f.routes.map((r) => r.id));
      for (const route of f.routes) assert.equal(d.get(route.id), o.get(route.id), `route ${route.id} after batch ${JSON.stringify(counts)}`);
    }
  } finally { await cleanup(f.organization.id); }
});

test("L1 · the set-based FOR UPDATE locks exactly the listed rows and nothing else (NOWAIT probe from another connection)", async () => {
  const f = await fixture(slug("lockset"), 4, 1);
  try {
    const listed = f.routes.slice(0, 3).map((r) => ({ organizationId: f.organization.id, campaignId: f.campaign.id, routeId: r.id }));
    await settlementDb.transaction(async (tx) => {
      const locked = await lockCampaignRoutes(tx, [listed[2]!, listed[0]!, listed[1]!, { organizationId: f.organization.id, campaignId: f.campaign.id, routeId: 999_999_999 }]);
      assert.deepEqual(locked, listed.map((l) => l.routeId).sort((a, b) => a - b), "rows come back in (organization, campaign, route) order; a missing route is absent");
      for (const route of f.routes.slice(0, 3)) {
        await assert.rejects(
          () => db.execute(sql`select id from campaign_routes where id = ${route.id} for update nowait`),
          (error: any) => (error?.cause?.code ?? error?.code) === "55P03",
          `route ${route.id} must be locked`,
        );
      }
      const free = await db.execute(sql`select id from campaign_routes where id = ${f.routes[3]!.id} for update nowait`);
      assert.equal(free.rows.length, 1, "a route not in the batch is not locked");
      assert.equal(await decrementRouteQueueDepths(tx, listed.map((l) => ({ ...l, count: 1 }))), 3);
    });
    const d = await depths(f.routes.map((r) => r.id));
    assert.deepEqual([...d.values()], [0, 0, 0, 1]);
  } finally { await cleanup(f.organization.id); }
});

test("L2 · the lock statement sorts before locking (LockRows above Sort), preserving the per-route acquisition order", async () => {
  const plan = await db.execute<{ "QUERY PLAN": string }>(sql`explain select route.id from campaign_routes as route
    where (route.organization_id, route.campaign_id, route.id) in ((1, 1, 1), (1, 1, 2)) order by route.organization_id, route.campaign_id, route.id for update`);
  const lines = plan.rows.map((row) => row["QUERY PLAN"]);
  assert.match(lines[0]!, /^LockRows/, lines.join("\n"));
  assert.ok(lines.slice(1).some((line) => /Sort/.test(line)), lines.join("\n"));
});

test("L3 · settlement batches interleaved with concurrent claims on the same campaign and routes: everything completes, zero deadlocks", async () => {
  const f = await fixture(slug("deadlock"), 4, 12);
  try {
    const w = worker(); const queue = new DatabaseJobQueue(); const limiter = new RouteTpsLimiter();
    const before = (await db.execute<{ deadlocks: number }>(sql`select deadlocks::int from pg_stat_database where datname = current_database()`)).rows[0]!.deadlocks;
    const batches: Job[][] = [[], [], [], [], [], []];
    for (const route of f.routes) (await lease(f.jobsByRoute.get(route.id)!.slice(0, 6), "t-l")).forEach((job, i) => batches[i]!.push(job));
    const claims = Array.from({ length: 6 }, () => queue.claimBatch(limiter, `p12-claimer-${Math.random()}`, 30_000, 4, new Date()));
    await Promise.all([...batches.map((batch) => settle(w, f.campaign.id, batch)), ...claims]);
    const after_ = (await db.execute<{ deadlocks: number }>(sql`select deadlocks::int from pg_stat_database where datname = current_database()`)).rows[0]!.deadlocks;
    assert.equal(after_ - before, 0, "no deadlock between set-based route locking and concurrent claims");
    const d = await depths(f.routes.map((r) => r.id)); const o = await outstandingByRoute(f.routes.map((r) => r.id));
    for (const route of f.routes) assert.equal(d.get(route.id), o.get(route.id));
  } finally { await cleanup(f.organization.id); }
});
