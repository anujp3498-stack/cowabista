import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignAuditTable,
  campaignJobsTable,
  campaignPlansTable,
  campaignsTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign, setExecutePageHookForTests } from "../src/services/campaign-planning";
import { launchCampaign } from "../src/services/campaign-launch";
import { deleteOrganization } from "./message-studio-fixtures";
import { campaignAction, firstNameMappings, saveDelivery, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06C product Launch: one lifecycle lock around plan + execute (or plan +
// Scheduled), modern preflight gate, and retry safety (double click, lost
// response, failure mid-execute) without ever freezing a second plan.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { setExecutePageHookForTests(undefined); delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2launch-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

/** A modern-ready campaign: 2 numbers x 2 templates, equal_numbers + balanced. */
async function readyCampaign(slug: string, contacts: number) {
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: 80 }, { key: "Y", tps: 20 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const { campaign } = await v2Campaign(w.organization.id, slug, contacts);
  const ids = [w.templates.A!.id, w.templates.B!.id];
  const message = await saveSetup(w.organization.id, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id], templateIds: ids, mappings: firstNameMappings(ids) });
  assert.equal(message.statusCode, 200, JSON.stringify(message.body));
  const delivery = await saveDelivery(w.organization.id, campaign.id, { revision: message.body.revision, distributionMode: "equal_numbers", deliveryMode: "balanced" });
  assert.equal(delivery.statusCode, 200, JSON.stringify(delivery.body));
  return { ...w, campaign, revision: delivery.body.revision as number };
}

async function state(campaignId: number) {
  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  const plans = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaignId)).orderBy(asc(campaignPlansTable.id));
  const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId));
  return { campaign: campaign!, plans, jobs };
}

test("send now: ONE request freezes the plan and creates every job under one lock; the campaign is Running", async () => {
  const slug = slugFor("now");
  const w = await readyCampaign(slug, 40);
  const org = w.organization.id;
  try {
    const res = await campaignAction(org, w.campaign.id, { action: "launch" });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "Running");
    assert.equal(res.body.launch.outcome, "launched");
    assert.equal(res.body.launch.queuedNew, 40);
    const s = await state(w.campaign.id);
    assert.equal(s.plans.length, 1);
    assert.equal(s.plans[0]!.status, "Active");
    assert.equal(s.plans[0]!.allocatorVersion, "v2");
    assert.equal(s.plans[0]!.deliveryMode, "balanced");
    assert.equal(res.body.launch.planId, s.plans[0]!.id);
    assert.equal(s.jobs.length, 40);
    assert.ok(s.jobs.every((job) => job.planId === s.plans[0]!.id && job.idempotencyKey.startsWith("send:")), "the job key contract (send:<contact key>) is unchanged");
    assert.equal(new Set(s.jobs.map((job) => job.idempotencyKey)).size, 40);
    const audit = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, w.campaign.id), eq(campaignAuditTable.action, "launch")));
    assert.deepEqual(audit.map((row) => (row.metadata as { outcome: string }).outcome), ["launched"]);

    // A lost-response retry is the same operation: success, nothing new.
    const retry = await campaignAction(org, w.campaign.id, { action: "launch" });
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(retry.body.launch, { outcome: "already_running", planId: s.plans[0]!.id, queuedNew: 0 });
    assert.equal((await state(w.campaign.id)).plans.length, 1);
    // Setup is locked once launched.
    const late = await saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "equal_templates", deliveryMode: "balanced" });
    assert.equal(late.statusCode, 409);
  } finally { await deleteOrganization(org); }
});

test("double click: two concurrent launches give one plan, one job per recipient, Running, and two successes", async () => {
  const slug = slugFor("double");
  const w = await readyCampaign(slug, 60);
  const org = w.organization.id;
  try {
    const [a, b] = await Promise.all([campaignAction(org, w.campaign.id, { action: "launch" }), campaignAction(org, w.campaign.id, { action: "launch" })]);
    assert.equal(a.statusCode, 200, JSON.stringify(a.body));
    assert.equal(b.statusCode, 200, JSON.stringify(b.body));
    assert.deepEqual([a.body.launch.outcome, b.body.launch.outcome].sort(), ["already_running", "launched"]);
    assert.equal(a.body.launch.planId, b.body.launch.planId);
    const s = await state(w.campaign.id);
    assert.equal(s.campaign.status, "Running");
    assert.equal(s.plans.length, 1);
    assert.equal(s.jobs.length, 60);
    assert.equal(new Set(s.jobs.map((job) => job.contactId)).size, 60, "no duplicate job");
  } finally { await deleteOrganization(org); }
});

test("a failure mid-execute is resumed on retry with the SAME plan (never a second plan); keys unchanged", async () => {
  const slug = slugFor("resume");
  const w = await readyCampaign(slug, 1_200); // 3 execute pages of 500
  const org = w.organization.id;
  try {
    setExecutePageHookForTests((page) => { if (page === 0) throw new Error("injected crash after the first page"); });
    const failed = await campaignAction(org, w.campaign.id, { action: "launch" }).catch((error: unknown) => error);
    setExecutePageHookForTests(undefined);
    assert.ok(failed instanceof Error && /injected crash/.test(failed.message), "the launch request failed");
    const partial = await state(w.campaign.id);
    assert.equal(partial.campaign.status, "Ready", "not Running: execute did not finish");
    assert.equal(partial.plans.length, 1);
    assert.equal(partial.jobs.length, 500, "the first page committed");
    const p1 = partial.plans[0]!.id;
    const keysBefore = new Map(partial.jobs.map((job) => [job.contactId, job.idempotencyKey]));

    const retry = await campaignAction(org, w.campaign.id, { action: "launch" });
    assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body.launch, { outcome: "resumed", planId: p1, queuedNew: 700 });
    const done = await state(w.campaign.id);
    assert.equal(done.campaign.status, "Running");
    assert.equal(done.plans.length, 1, "no second plan was frozen");
    assert.equal(done.jobs.length, 1_200);
    assert.ok(done.jobs.every((job) => job.planId === p1), "every job is bound to the one plan");
    for (const job of done.jobs) if (keysBefore.has(job.contactId)) assert.equal(job.idempotencyKey, keysBefore.get(job.contactId), "existing job keys untouched");
    assert.equal(new Set(done.jobs.map((job) => job.idempotencyKey)).size, 1_200);
  } finally {
    setExecutePageHookForTests(undefined);
    await deleteOrganization(org);
  }
});

test("scheduled launch freezes the plan, moves to Scheduled with the time and zone, creates no job; retries are recognised; the runtime activation executes it", async () => {
  const slug = slugFor("schedule");
  const w = await readyCampaign(slug, 25);
  const org = w.organization.id;
  const at = new Date(Date.now() + 2 * 3_600_000);
  at.setMilliseconds(0);
  try {
    const past = await campaignAction(org, w.campaign.id, { action: "launch", scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(past.statusCode, 400);
    assert.equal(past.body.code, "invalid_schedule");
    const badZone = await campaignAction(org, w.campaign.id, { action: "launch", scheduledAt: at.toISOString(), timezone: "Mars/Olympus" });
    assert.equal(badZone.statusCode, 400);
    assert.equal((await state(w.campaign.id)).plans.length, 0, "refused requests froze nothing");

    const res = await campaignAction(org, w.campaign.id, { action: "launch", scheduledAt: at.toISOString(), timezone: "Europe/London" });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "Scheduled");
    assert.equal(res.body.launch.outcome, "scheduled");
    let s = await state(w.campaign.id);
    assert.equal(s.plans.length, 1);
    assert.equal(s.jobs.length, 0, "no send job before the time");
    assert.equal(s.campaign.scheduledAt!.getTime(), at.getTime());
    assert.equal(s.campaign.timezone, "Europe/London");
    assert.equal((await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, s.plans[0]!.id))).length, 25, "the allocation is frozen now");

    const same = await campaignAction(org, w.campaign.id, { action: "launch", scheduledAt: at.toISOString(), timezone: "Europe/London" });
    assert.equal(same.statusCode, 200);
    assert.equal(same.body.launch.outcome, "already_scheduled");
    const other = await campaignAction(org, w.campaign.id, { action: "launch", scheduledAt: new Date(at.getTime() + 60_000).toISOString() });
    assert.equal(other.statusCode, 409);
    assert.equal(other.body.code, "already_scheduled");
    const now = await campaignAction(org, w.campaign.id, { action: "launch" });
    assert.equal(now.statusCode, 409);
    assert.equal(now.body.code, "already_scheduled");
    assert.equal((await state(w.campaign.id)).plans.length, 1);

    // When due, the existing runtime activation (executeCampaignPlan on the
    // Scheduled campaign) creates the frozen plan's jobs.
    await db.update(campaignsTable).set({ scheduledAt: new Date(Date.now() - 1_000) }).where(eq(campaignsTable.id, w.campaign.id));
    await executeCampaignPlan(org, w.campaign.id);
    s = await state(w.campaign.id);
    assert.equal(s.campaign.status, "Running");
    assert.equal(s.jobs.length, 25);
    assert.ok(s.jobs.every((job) => job.planId === s.plans[0]!.id));
  } finally { await deleteOrganization(org); }
});

test("launch is stricter than engineering Plan: a legacy campaign is refused with structured blockers while Plan still works; non-launchable states refuse", async () => {
  const slug = slugFor("strict");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const { campaign } = await v2Campaign(org, slug, 5);
    assert.equal((await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id], templateIds: [w.templates.A!.id], mappings: firstNameMappings([w.templates.A!.id]) })).statusCode, 200);
    const refused = await campaignAction(org, campaign.id, { action: "launch" });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.code, "launch_blocked");
    assert.deepEqual(refused.body.blockers.map((b: { code: string }) => b.code).sort(), ["delivery_required", "distribution_required"]);
    let s = await state(campaign.id);
    assert.deepEqual([s.campaign.status, s.plans.length, s.jobs.length], ["Draft", 0, 0], "nothing frozen");
    // The engineering path is unchanged.
    await planCampaign(org, campaign.id);
    s = await state(campaign.id);
    assert.equal(s.campaign.status, "Ready");

    for (const status of ["Paused", "Completed", "Cancelled"]) {
      await db.update(campaignsTable).set({ status }).where(eq(campaignsTable.id, campaign.id));
      const res = await campaignAction(org, campaign.id, { action: "launch" });
      assert.equal(res.statusCode, 409, status);
      assert.equal(res.body.code, "launch_not_allowed", status);
    }
    const foreign = await launchCampaign({ organizationId: org + 100_000, campaignId: campaign.id }).catch((error: { code?: string; status?: number }) => error);
    assert.equal((foreign as { status?: number }).status, 404);
    const counts = await db.execute<{ n: number }>(sql`select count(*)::int as n from campaign_plans where campaign_id = ${campaign.id}`);
    assert.equal(counts.rows[0]!.n, 1);
  } finally { await deleteOrganization(org); }
});
