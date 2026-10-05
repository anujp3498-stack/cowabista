import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignAuditTable,
  campaignJobsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import campaignEngineRouter from "../src/routes/campaign-engine";
import { deleteOrganization, fakeResponse, findRouteHandler } from "./message-studio-fixtures";
import { campaignAction, drainWithWorker, firstNameMappings, providerLog, saveDelivery, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06C paused speed adjustment: only while Paused, under the lifecycle
// lock; the shared resolver's new rate is copied onto Queued jobs only. The
// frozen plan, allocations, job templates and in-flight (Processing) jobs
// are untouched, and the unchanged runtime then paces at the new rate.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2speed-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

async function launched(slug: string, contacts: number, tps: { X: number; Y: number }) {
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: tps.X }, { key: "Y", tps: tps.Y }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const { campaign } = await v2Campaign(w.organization.id, slug, contacts);
  const ids = [w.templates.A!.id, w.templates.B!.id];
  const message = await saveSetup(w.organization.id, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id], templateIds: ids, mappings: firstNameMappings(ids) });
  assert.equal((await saveDelivery(w.organization.id, campaign.id, { revision: message.body.revision, distributionMode: "equal_templates", deliveryMode: "fastest_safe" })).statusCode, 200);
  const launch = await campaignAction(w.organization.id, campaign.id, { action: "launch" });
  assert.equal(launch.statusCode, 200, JSON.stringify(launch.body));
  return { ...w, campaign, planId: launch.body.launch.planId as number };
}

const snapshot = async (campaignId: number, planId: number) => ({
  plan: JSON.stringify((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, planId)))[0]),
  allocations: JSON.stringify(await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, planId)).orderBy(asc(campaignAllocationsTable.contactId))),
  jobTemplates: JSON.stringify((await db.select({ id: campaignJobsTable.id, routeId: campaignJobsTable.routeId, templateId: campaignJobsTable.templateId, key: campaignJobsTable.idempotencyKey, planId: campaignJobsTable.planId }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(asc(campaignJobsTable.id)))),
});

test("Paused only: the new speed is resolved for the frozen lanes and copied onto Queued jobs; plan, allocations, templates and in-flight jobs are untouched", async () => {
  const slug = slugFor("paused");
  const w = await launched(slug, 30, { X: 80, Y: 40 });
  const org = w.organization.id;
  const { X, Y } = w.phones;
  try {
    const running = await campaignAction(org, w.campaign.id, { action: "adjust-speed", deliveryMode: "conservative" });
    assert.equal(running.statusCode, 409, "a running campaign must be paused first");
    assert.match(running.body.error, /Pause the campaign/);

    assert.equal((await campaignAction(org, w.campaign.id, { action: "pause" })).statusCode, 200);
    // One job is in flight (leased): it must keep its rate.
    const [inFlight] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, w.campaign.id)).orderBy(asc(campaignJobsTable.id)).limit(1);
    await db.update(campaignJobsTable).set({ status: "Processing" }).where(eq(campaignJobsTable.id, inFlight!.id));
    const before = await snapshot(w.campaign.id, w.planId);

    // Advanced above a ceiling: refused, never clamped, nothing changes.
    const tooFast = await campaignAction(org, w.campaign.id, { action: "adjust-speed", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: X!.id, messagesPerSecond: 200 }, { phoneNumberId: Y!.id, messagesPerSecond: 5 }] } });
    assert.equal(tooFast.statusCode, 400);
    assert.ok(tooFast.body.details.some((d: string) => /at most 80 messages\/sec/.test(d)));
    const rates = async () => (await db.select({ id: campaignJobsTable.id, routeId: campaignJobsTable.routeId, status: campaignJobsTable.status, rate: campaignJobsTable.configuredTps }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, w.campaign.id)));
    assert.ok((await rates()).every((job) => job.rate === 80 || job.rate === 40), "still the launch speed");

    const adjusted = await campaignAction(org, w.campaign.id, { action: "adjust-speed", deliveryMode: "conservative" });
    assert.equal(adjusted.statusCode, 200, JSON.stringify(adjusted.body));
    assert.equal(adjusted.body.status, "Paused", "adjusting never resumes");
    assert.deepEqual(adjusted.body.speed.perSender.map((s: { plannedRate: number }) => s.plannedRate), [20, 10], "conservative: 25% of 80 and max(5, 25% of 40)");
    assert.equal(adjusted.body.speed.jobsUpdated, 29);
    const [plan] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, w.planId));
    const laneRate = new Map(plan!.routes.map((route) => [route.routeId, route.phoneNumberId === X!.id ? 20 : 10]));
    for (const job of await rates()) {
      if (job.id === inFlight!.id) assert.equal(job.rate, inFlight!.configuredTps, "the in-flight job keeps its rate");
      else assert.equal(job.rate, laneRate.get(job.routeId!), "queued jobs carry the new lane rate");
    }
    assert.deepEqual(await snapshot(w.campaign.id, w.planId), before, "frozen plan, allocations, job templates/keys/plan untouched");
    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, w.campaign.id));
    assert.equal(campaign!.deliveryMode, "conservative");
    const audit = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, w.campaign.id), eq(campaignAuditTable.action, "adjust-speed")));
    assert.equal(audit.length, 1);
    assert.equal((audit[0]!.metadata as { jobsUpdated: number }).jobsUpdated, 29);

    // Resume works with the adjusted setup (readiness resolves the same speed).
    await db.update(campaignJobsTable).set({ status: "Queued" }).where(eq(campaignJobsTable.id, inFlight!.id));
    const resumed = await campaignAction(org, w.campaign.id, { action: "resume" });
    assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "Running");
  } finally { await deleteOrganization(org); }
});

test("after a paused speed change the unchanged runtime paces at the new rate", async () => {
  const slug = slugFor("pace");
  const log = providerLog(path.join(os.tmpdir(), `v2speed-${process.pid}-${Date.now()}.log`));
  const w = await launched(slug, 10, { X: 50, Y: 50 });
  const org = w.organization.id;
  try {
    assert.equal((await campaignAction(org, w.campaign.id, { action: "pause" })).statusCode, 200);
    const adjusted = await campaignAction(org, w.campaign.id, { action: "adjust-speed", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: w.phones.X!.id, messagesPerSecond: 2 }, { phoneNumberId: w.phones.Y!.id, messagesPerSecond: 2 }] } });
    assert.equal(adjusted.statusCode, 200, JSON.stringify(adjusted.body));
    assert.equal((await campaignAction(org, w.campaign.id, { action: "resume" })).statusCode, 200);
    await drainWithWorker(w.campaign.id, 10, slug, 90_000);
    const sent = log.entries();
    assert.equal(sent.length, 10);
    // Per number: n sends at 2/s need >= (n - 1) / 2 s; at the launch speed
    // (50/s) they would finish in a fraction of a second.
    for (const phone of [w.phones.X!, w.phones.Y!]) {
      const times = sent.filter((entry) => entry.phoneId === phone.providerPhoneId).map((entry) => entry.at).sort((a, b) => a - b);
      if (times.length < 2) continue;
      const span = times[times.length - 1]! - times[0]!;
      assert.ok(span >= ((times.length - 1) / 2) * 1000 * 0.75, `${phone.displayName}: ${times.length} sends spanned ${span}ms at 2/s`);
    }
  } finally {
    log.stop();
    await deleteOrganization(org);
  }
});

test("a legacy (allocator v1) paused campaign cannot change speed here", async () => {
  const slug = slugFor("v1");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const { campaign } = await v2Campaign(org, slug, 3);
    assert.equal((await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id], templateIds: [w.templates.A!.id], mappings: firstNameMappings([w.templates.A!.id]) })).statusCode, 200);
    await planCampaign(org, campaign.id);
    await executeCampaignPlan(org, campaign.id);
    await db.update(campaignsTable).set({ status: "Paused" }).where(eq(campaignsTable.id, campaign.id));
    const res = await campaignAction(org, campaign.id, { action: "adjust-speed", deliveryMode: "balanced" });
    assert.equal(res.statusCode, 409);
    assert.ok((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id))).every((job) => job.configuredTps === 50));
  } finally { await deleteOrganization(org); }
});

// ------------------------------------------------------------ V2-06C.1
// The live route target (campaign_routes.configured_tps) is the current
// operational speed monitoring and its ETA read; adjust-speed now keeps it
// equal to the queued jobs' rate. The frozen plan keeps the launch rate.

const monitoringRoute = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/monitoring", "get");
async function monitoring(organizationId: number, campaignId: number) {
  const res = fakeResponse();
  await monitoringRoute({ params: { organizationId: String(organizationId), campaignId: String(campaignId) } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body as { effectiveConfiguredTps: number; pending: number; estimatedCompletionAt: string | null; routes: Array<{ routeId: number; configuredTps: number; currentTps: number; queueDepth: number; status: string }> };
}
const etaSeconds = (body: { estimatedCompletionAt: string | null }, at: number) => (new Date(body.estimatedCompletionAt!).getTime() - at) / 1000;

test("V2-06C.1 multi-sender: live route targets, queued jobs and monitoring follow the adjusted speed; ETA uses it after resume; the plan keeps the launch rates", async () => {
  const slug = slugFor("monitor");
  const w = await launched(slug, 300, { X: 80, Y: 40 });
  const org = w.organization.id;
  const { X, Y } = w.phones;
  try {
    // Launch (fastest safe): 80 + 40.
    let at = Date.now();
    let view = await monitoring(org, w.campaign.id);
    assert.equal(view.effectiveConfiguredTps, 120);
    assert.equal(view.pending, 300);
    const etaBefore = etaSeconds(view, at);
    assert.ok(etaBefore >= 2 && etaBefore <= 4.5, `before: ETA ${etaBefore}s for 300 at 120/s`);
    // The monitoring response identifies routes by id; map them to numbers.
    const routeIdOf = new Map((await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, w.campaign.id))).map((r) => [r.phoneNumberId, r.id]));
    const routeOf = (phoneNumberId: number) => view.routes.find((route) => route.routeId === routeIdOf.get(phoneNumberId))!;
    assert.deepEqual([routeOf(X!.id).configuredTps, routeOf(Y!.id).configuredTps], [80, 40]);

    assert.equal((await campaignAction(org, w.campaign.id, { action: "pause" })).statusCode, 200);
    const pausedRoutes = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, w.campaign.id)).orderBy(asc(campaignRoutesTable.id));
    const [inFlight] = await db.select().from(campaignJobsTable).where(and(eq(campaignJobsTable.campaignId, w.campaign.id), eq(campaignJobsTable.routeId, pausedRoutes.find((r) => r.phoneNumberId === X!.id)!.id))).orderBy(asc(campaignJobsTable.id)).limit(1);
    await db.update(campaignJobsTable).set({ status: "Processing" }).where(eq(campaignJobsTable.id, inFlight!.id));
    const before = await snapshot(w.campaign.id, w.planId);

    const adjusted = await campaignAction(org, w.campaign.id, { action: "adjust-speed", deliveryMode: "conservative" });
    assert.equal(adjusted.statusCode, 200, JSON.stringify(adjusted.body));
    assert.equal(adjusted.body.status, "Paused");

    // Live routes: only configured_tps changed (status, current TPS, queue depth preserved; none created/deleted).
    const afterRoutes = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, w.campaign.id)).orderBy(asc(campaignRoutesTable.id));
    assert.deepEqual(afterRoutes.map((r) => r.id), pausedRoutes.map((r) => r.id));
    for (const route of afterRoutes) {
      const old = pausedRoutes.find((r) => r.id === route.id)!;
      assert.equal(route.configuredTps, route.phoneNumberId === X!.id ? 20 : 10);
      assert.deepEqual({ status: route.status, currentTps: route.currentTps, queueDepth: route.queueDepth, templateId: route.templateId, phoneNumberId: route.phoneNumberId, sharedPhoneBudget: route.sharedPhoneBudget },
        { status: old.status, currentTps: old.currentTps, queueDepth: old.queueDepth, templateId: old.templateId, phoneNumberId: old.phoneNumberId, sharedPhoneBudget: old.sharedPhoneBudget });
    }
    // Monitoring's per-route targets are the new rates. (Paused routes are
    // excluded from the effective total by design: a paused campaign sends at 0.)
    view = await monitoring(org, w.campaign.id);
    assert.deepEqual([routeOf(X!.id).configuredTps, routeOf(Y!.id).configuredTps], [20, 10]);
    assert.equal(view.effectiveConfiguredTps, 0);
    // Queued jobs carry the live target; the in-flight job keeps its launch rate.
    const laneRate = new Map(afterRoutes.map((r) => [r.id, r.configuredTps]));
    for (const job of await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, w.campaign.id))) {
      if (job.id === inFlight!.id) assert.equal(job.configuredTps, 80);
      else assert.equal(job.configuredTps, laneRate.get(job.routeId!), "queued job == live route target");
    }
    // The frozen plan (launch rates 80 / 40), allocations, templates and keys are byte-identical.
    assert.deepEqual(await snapshot(w.campaign.id, w.planId), before);
    const [plan] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, w.planId));
    assert.deepEqual(plan!.routes.map((r) => [r.phoneNumberId, r.configuredTps]).sort((a, b) => a[0]! - b[0]!), [[X!.id, 80], [Y!.id, 40]]);

    // Resume: monitoring and its ETA follow the operational speed (30/s), not the launch speed (120/s).
    await db.update(campaignJobsTable).set({ status: "Queued" }).where(eq(campaignJobsTable.id, inFlight!.id));
    assert.equal((await campaignAction(org, w.campaign.id, { action: "resume" })).statusCode, 200);
    at = Date.now();
    view = await monitoring(org, w.campaign.id);
    assert.equal(view.effectiveConfiguredTps, 30);
    const etaAfter = etaSeconds(view, at);
    assert.ok(Math.abs(etaAfter - Math.ceil(300 / 30)) <= 1.5, `after: ETA ${etaAfter}s, expected ~${Math.ceil(300 / 30)}s at 30/s (the launch speed would give ~3s)`);
  } finally { await deleteOrganization(org); }
});

test("V2-06C.1 a second adjustment (80 -> 20 -> 10) audits from the CURRENT live rate; a job claimed between adjustments keeps its rate; no plan, allocation, template or job changes", async () => {
  const slug = slugFor("second");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: 80 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = w.organization.id;
  const X = w.phones.X!;
  try {
    const { campaign } = await v2Campaign(org, slug, 12);
    const ids = [w.templates.A!.id, w.templates.B!.id];
    const message = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X.id], templateIds: ids, mappings: firstNameMappings(ids) });
    assert.equal((await saveDelivery(org, campaign.id, { revision: message.body.revision, distributionMode: "equal_numbers", deliveryMode: "fastest_safe" })).statusCode, 200);
    const launch = await campaignAction(org, campaign.id, { action: "launch" });
    assert.equal(launch.statusCode, 200, JSON.stringify(launch.body));
    const planId = launch.body.launch.planId as number;
    assert.equal((await campaignAction(org, campaign.id, { action: "pause" })).statusCode, 200);
    const jobsBefore = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id)).orderBy(asc(campaignJobsTable.id));
    const before = await snapshot(campaign.id, planId);
    const advanced = (rate: number) => campaignAction(org, campaign.id, { action: "adjust-speed", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: X.id, messagesPerSecond: rate }] } });

    assert.equal((await advanced(20)).statusCode, 200);
    // A worker claims one job between the two adjustments (claim race): it keeps 20.
    await db.update(campaignJobsTable).set({ status: "Processing" }).where(eq(campaignJobsTable.id, jobsBefore[0]!.id));
    const second = await advanced(10);
    assert.equal(second.statusCode, 200, JSON.stringify(second.body));
    assert.equal(second.body.speed.jobsUpdated, 11);

    const [route] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id));
    assert.equal(route!.configuredTps, 10, "live target");
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id)).orderBy(asc(campaignJobsTable.id));
    assert.equal(jobs.length, 12, "no job duplication");
    assert.equal(jobs[0]!.configuredTps, 20, "claimed between adjustments: keeps the rate it was claimed with");
    assert.ok(jobs.slice(1).every((job) => job.status === "Queued" && job.configuredTps === 10));
    assert.deepEqual(await snapshot(campaign.id, planId), before, "plan, allocations, templates, keys untouched");
    assert.equal((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaign.id))).length, 1, "no second plan");
    const [plan] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, planId));
    assert.equal(plan!.routes[0]!.configuredTps, 80, "the frozen plan still records the launch rate");

    const audits = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, campaign.id), eq(campaignAuditTable.action, "adjust-speed"))).orderBy(asc(campaignAuditTable.id));
    const lanes = audits.map((row) => (row.metadata as { lanes: Array<{ from: number; to: number; launchRate: number }> }).lanes[0]!);
    assert.deepEqual(lanes.map((lane) => [lane.from, lane.to, lane.launchRate]), [[80, 20, 80], [20, 10, 80]], "the second audit is 20 -> 10 (current live rate), with the launch rate kept separately");
    const view = await monitoring(org, campaign.id);
    assert.equal(view.routes[0]!.configuredTps, 10);
  } finally { await deleteOrganization(org); }
});
