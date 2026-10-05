import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { asc, eq } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignJobsTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  phoneNumbersTable,
  pool,
  settlementPool,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { allocatorInputFromPlan, CampaignNotReadyError, executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { getActivePlanSummary } from "../src/services/campaign-plan-preview";
import { validateCampaignReady } from "../src/services/campaign-preflight";
import { deleteOrganization } from "./message-studio-fixtures";
import { firstNameMappings, preflight, saveDelivery, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06B: the planned rate is ONE value end to end:
//   preflight plannedRate == frozen lane configuredTps == allocator v2
//   weight (equal_templates) == every job's configuredTps.
// A null delivery mode keeps the pre-V2-06B behaviour (the route's own
// configured rate is frozen). The runtime is unchanged: it paces each job at
// its frozen configuredTps.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2dp-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

async function setUp(slug: string, phones: Array<{ key: string; tps: number }>, contacts: number) {
  const w = await v2World(slug, { wabas: [{ phones, templates: [{ key: "T", body: "Hello {{1}}" }] }] });
  const { campaign } = await v2Campaign(w.organization.id, slug, contacts);
  const message = await saveSetup(w.organization.id, campaign.id, { revision: 0, senderPhoneNumberIds: phones.map((p) => w.phones[p.key]!.id), templateIds: [w.templates.T!.id], mappings: firstNameMappings([w.templates.T!.id]) });
  assert.equal(message.statusCode, 200, JSON.stringify(message.body));
  return { ...w, campaign, revision: message.body.revision as number };
}

test("equal by templates weights senders by the RESOLVED delivery rate (20 : 80), and that exact rate is what the plan, the allocator and every job carry", async () => {
  const slug = slugFor("weights");
  const w = await setUp(slug, [{ key: "A", tps: 100 }, { key: "B", tps: 100 }], 400);
  const org = w.organization.id;
  const A = w.phones.A!.id, B = w.phones.B!.id;
  try {
    const saved = await saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "equal_templates", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: A, messagesPerSecond: 20 }, { phoneNumberId: B, messagesPerSecond: 80 }] } });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    // The live route rows keep the Message step's rate (the provider cap, 100):
    // if planning or the allocator read them, the split would be 1 : 1.
    assert.deepEqual((await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, w.campaign.id)).orderBy(asc(campaignRoutesTable.phoneNumberId))).map((r) => r.configuredTps), [100, 100]);

    const report = (await preflight(org, w.campaign.id)).body;
    assert.equal(report.ready, true, JSON.stringify(report.blockers));
    const preflightRates = report.delivery.perSender.map((s: { phoneNumberId: number; plannedRate: number }) => [s.phoneNumberId, s.plannedRate]);
    assert.deepEqual(preflightRates, [[A, 20], [B, 80]]);

    const { plan } = await planCampaign(org, w.campaign.id);
    assert.equal(plan.deliveryMode, "advanced");
    const frozen = plan.routes.map((route) => [route.phoneNumberId, route.configuredTps]);
    assert.deepEqual(frozen, preflightRates, "preflight planned rate == frozen lane rate");
    for (const route of plan.routes) assert.deepEqual(route.delivery, { deliveryMode: "advanced", providerApprovedRate: 100, platformRate: 1_000, effectiveCeiling: 100, plannedRate: route.configuredTps });
    const weights = allocatorInputFromPlan(plan).lanes.map((lane) => [lane.phoneNumberId, lane.rate]);
    assert.deepEqual(weights, preflightRates, "frozen lane rate == allocator v2 weight");

    const allocations = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, plan.id));
    const toA = allocations.filter((a) => a.phoneNumberId === A).length;
    // Expected 80 of 400 (20%); binomial sd = 8. +/- 40 (5 sd) catches a 1:1
    // split (200) or the live route weights while never failing on noise.
    assert.ok(Math.abs(toA - 80) <= 40, `A received ${toA} of 400; a 20:80 weighting expects ~80`);
    console.log(JSON.stringify({ equalTemplatesWeights: { A: 20, B: 80 }, allocated: { A: toA, B: allocations.length - toA } }));

    await executeCampaignPlan(org, w.campaign.id);
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, w.campaign.id));
    assert.equal(jobs.length, 400);
    const laneRate = new Map(plan.routes.map((route) => [route.routeId, route.configuredTps]));
    for (const job of jobs) assert.equal(job.configuredTps, laneRate.get(job.routeId!), "job configuredTps == frozen lane rate");
    assert.deepEqual([...new Set(jobs.map((j) => j.configuredTps))].sort((a, b) => a! - b!), [20, 80]);
    assert.equal((await getActivePlanSummary(org, w.campaign.id))!.deliveryMode, "advanced");
  } finally { await deleteOrganization(org); }
});

test("presets freeze the resolver's rate per number: fastest safe (platform-capped), balanced 60%, conservative 25% / floor 5", async () => {
  const cases = [
    { mode: "fastest_safe", phones: [{ key: "A", tps: 2_000 }, { key: "B", tps: 7 }], expected: [1_000, 7] },
    { mode: "balanced", phones: [{ key: "A", tps: 50 }, { key: "B", tps: 3 }], expected: [30, 1] },
    { mode: "conservative", phones: [{ key: "A", tps: 100 }, { key: "B", tps: 10 }], expected: [25, 5] },
  ];
  for (const { mode, phones, expected } of cases) {
    const slug = slugFor(mode);
    const w = await setUp(slug, phones, 20);
    const org = w.organization.id;
    try {
      const saved = await saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "equal_numbers", deliveryMode: mode });
      assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body.senders.map((s: { plannedRate: number }) => s.plannedRate), expected, `${mode}: delivery setup`);
      const report = (await preflight(org, w.campaign.id)).body;
      assert.deepEqual(report.delivery.perSender.map((s: { plannedRate: number }) => s.plannedRate), expected, `${mode}: preflight`);
      assert.equal(report.estimate.messagesPerSecond, expected[0]! + expected[1]!);
      assert.equal(report.estimate.durationSeconds, Math.ceil(20 / (expected[0]! + expected[1]!)));
      const { plan } = await planCampaign(org, w.campaign.id);
      assert.equal(plan.deliveryMode, mode);
      assert.deepEqual(plan.routes.map((route) => route.configuredTps), expected, `${mode}: frozen lanes`);
      await executeCampaignPlan(org, w.campaign.id);
      const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, w.campaign.id));
      const laneRate = new Map(plan.routes.map((route) => [route.routeId, route.configuredTps]));
      assert.ok(jobs.length === 20 && jobs.every((job) => job.configuredTps === laneRate.get(job.routeId!)), `${mode}: jobs`);
    } finally { await deleteOrganization(org); }
  }
});

test("null delivery keeps the pre-V2-06B behaviour: the route's configured rate is frozen and Plan works, while the modern preflight requires a speed", async () => {
  const slug = slugFor("null");
  const w = await setUp(slug, [{ key: "A", tps: 50 }, { key: "B", tps: 50 }], 12);
  const org = w.organization.id;
  try {
    // An allocator-v2 campaign configured before V2-06B: distribution only.
    await db.update(campaignsTable).set({ distributionMode: "equal_numbers" }).where(eq(campaignsTable.id, w.campaign.id));
    const resaved = await saveSetup(org, w.campaign.id, { revision: w.revision, senderPhoneNumberIds: [w.phones.A!.id, w.phones.B!.id], templateIds: [w.templates.T!.id], mappings: firstNameMappings([w.templates.T!.id]) });
    assert.equal(resaved.statusCode, 200);
    await db.update(campaignRoutesTable).set({ configuredTps: 7 }).where(eq(campaignRoutesTable.campaignId, w.campaign.id));

    const report = (await preflight(org, w.campaign.id)).body;
    assert.equal(report.ready, false);
    assert.deepEqual(report.blockers.map((b: { code: string }) => b.code), ["delivery_required"]);
    assert.deepEqual(report.technicalDetails.readinessErrors, []);
    assert.deepEqual(await validateCampaignReady(org, w.campaign.id), []);

    const { plan } = await planCampaign(org, w.campaign.id);
    assert.equal(plan.deliveryMode, null);
    assert.deepEqual(plan.routes.map((route) => route.configuredTps), [7, 7], "the route's own configured rate");
    assert.ok(plan.routes.every((route) => !("delivery" in route)), "no delivery evidence on a pre-V2-06B lane");
    await executeCampaignPlan(org, w.campaign.id);
    assert.ok((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, w.campaign.id))).every((job) => job.configuredTps === 7));
  } finally { await deleteOrganization(org); }
});

test("a speed without a distribution, or a ceiling that dropped below an advanced rate, refuses readiness AND Plan with the same rule", async () => {
  const slug = slugFor("refuse");
  const w = await setUp(slug, [{ key: "A", tps: 40 }], 5);
  const org = w.organization.id;
  try {
    await db.update(campaignsTable).set({ deliveryMode: "balanced" }).where(eq(campaignsTable.id, w.campaign.id));
    const errors = await validateCampaignReady(org, w.campaign.id);
    assert.ok(errors.includes("A sending speed applies to a distribution; choose a distribution in the Delivery step"), errors.join(" | "));
    await assert.rejects(planCampaign(org, w.campaign.id), CampaignNotReadyError);
    assert.ok((await preflight(org, w.campaign.id)).body.blockers.some((b: { code: string }) => b.code === "distribution_required"));

    const saved = await saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "equal_numbers", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: w.phones.A!.id, messagesPerSecond: 40 }] } });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    await db.update(phoneNumbersTable).set({ tpsLimit: 25 }).where(eq(phoneNumbersTable.id, w.phones.A!.id));
    const after = await validateCampaignReady(org, w.campaign.id);
    assert.deepEqual(after, [`number ${w.phones.A!.id}: 40 messages/second is above its maximum of 25`], "never clamped to 25");
    await assert.rejects(planCampaign(org, w.campaign.id), CampaignNotReadyError);
  } finally { await deleteOrganization(org); }
});
