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
  campaignsTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { deleteOrganization } from "./message-studio-fixtures";
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
