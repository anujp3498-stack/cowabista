import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignPlansTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { ALLOCATOR_VERSION, executeCampaignPlan, planCampaign, type FrozenRoute } from "../src/services/campaign-planning";
import { ALLOCATOR_V1, ALLOCATOR_V2, effectiveFrozenTemplateId } from "../src/services/allocator-version";
import { assignRoute, partitionFor } from "../src/services/contact-processing";
import { deleteOrganization } from "./message-studio-fixtures";
import { drainWithWorker, firstNameMappings, providerLog, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06A must leave allocator v1 byte-for-byte unchanged for every campaign
// without a distribution mode and for every plan frozen before V2-06:
//  - the v1 formula (partitionFor -> assignRoute over the frozen route ids,
//    route.templateId) is pinned by a golden digest;
//  - a v1 plan's allocations, frozen route shape and jobs follow it exactly;
//  - template precedence is gated by the PLAN's allocator version, never by
//    whether a job happens to carry a templateId.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v1reg-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
const logPath = (name: string) => path.join(os.tmpdir(), `v1-provider-${name}-${process.pid}-${Date.now()}.log`);

// The exact key set of a v1 frozen route before V2-06A (f0030cc).
const V1_FROZEN_ROUTE_KEYS = [
  "configuredTps", "displayName", "eligibilitySource", "eligibilityVerifiedAt", "eligibleTemplateIds", "phone", "phoneNumberId",
  "providerTpsLimit", "routeId", "sendingCredentialId", "templateId", "wabaExternalId", "wabaId",
];

test("the allocator version constants and the historical v1 formula are pinned (golden digest over 20,000 recipients)", () => {
  assert.equal(ALLOCATOR_VERSION, "v1", "the historical constant keeps its value");
  assert.equal(ALLOCATOR_V1, "v1");
  assert.equal(ALLOCATOR_V2, "v2");
  const routeIds = [11, 22, 33];
  const lines: string[] = [];
  for (let index = 0; index < 20_000; index++) {
    const phone = `+1555${String(index * 7919 % 9_999_999).padStart(7, "0")}`;
    const partition = partitionFor(phone, 64);
    lines.push(`${phone}>${partition}>${assignRoute(partition, routeIds)}`);
  }
  // Computed from the unchanged contact-processing.ts (identical at f0030cc,
  // the V2-06A starting point). Any change to the v1 formula breaks this.
  assert.equal(createHash("sha256").update(lines.join("\n")).digest("hex"), "bbc0428c6e950ea16c6286ffaf7c9539b1ebba9c21f7469b37b0c30bd4f1db0f");
});

test("a v1 campaign (no distribution mode) plans, executes and sends exactly as before: partitionFor -> assignRoute -> route template", async () => {
  const slug = slugFor("golden");
  const log = providerLog(logPath("golden"));
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = world.organization.id;
  try {
    const { campaign } = await v2Campaign(org, slug, 40);
    assert.equal(campaign.distributionMode, null);
    const templateIds = [world.templates.A!.id, world.templates.B!.id];
    const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [world.phones.X!.id, world.phones.Y!.id], templateIds, mappings: firstNameMappings(templateIds) });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.distributionMode, null);
    assert.equal(saved.body.execution.allocatorVersion, "v1");

    const { plan } = await planCampaign(org, campaign.id);
    assert.equal(plan.allocatorVersion, "v1");
    assert.equal(plan.distributionMode, null);
    assert.equal(plan.partitionCount, 64);
    for (const route of plan.routes) assert.deepEqual(Object.keys(route).sort(), V1_FROZEN_ROUTE_KEYS, "the v1 frozen route shape is unchanged (no v2 fields)");
    const routeIds = plan.routes.map((route) => route.routeId);
    assert.deepEqual(routeIds, [...routeIds].sort((a, b) => a - b));

    const allocations = await db.select({ allocation: campaignAllocationsTable, phone: campaignContactsTable.normalizedPhone })
      .from(campaignAllocationsTable).innerJoin(campaignContactsTable, eq(campaignContactsTable.id, campaignAllocationsTable.contactId))
      .where(eq(campaignAllocationsTable.planId, plan.id));
    assert.equal(allocations.length, 40);
    for (const { allocation, phone } of allocations) {
      const partitionKey = partitionFor(phone!, plan.partitionCount);
      const routeId = assignRoute(partitionKey, routeIds);
      const route = plan.routes.find((candidate) => candidate.routeId === routeId)!;
      assert.deepEqual(
        { partitionKey: allocation.partitionKey, routeId: allocation.routeId, phoneNumberId: allocation.phoneNumberId, templateId: allocation.templateId },
        { partitionKey, routeId, phoneNumberId: route.phoneNumberId, templateId: route.templateId },
      );
    }

    await executeCampaignPlan(org, campaign.id);
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    for (const job of jobs) {
      const route = plan.routes.find((candidate) => candidate.routeId === job.routeId)!;
      assert.equal(job.templateId, route.templateId, "v1 execute copies the route's frozen template");
      assert.equal(job.configuredTps, route.configuredTps);
    }
    await drainWithWorker(campaign.id, 40, slug);
    const templateName = new Map(Object.values(world.templates).map((t) => [t.id, t.name]));
    const providerPhone = new Map(Object.values(world.phones).map((p) => [p.id, p.providerPhoneId]));
    const sent = log.entries();
    assert.equal(sent.length, 40);
    for (const { allocation, phone } of allocations) {
      const entry = sent.find((candidate) => candidate.payload.to === phone)!;
      assert.equal(entry.payload.template.name, templateName.get(allocation.templateId!));
      assert.equal(entry.phoneId, providerPhone.get(allocation.phoneNumberId));
    }
  } finally {
    log.stop();
    await deleteOrganization(world.organization.id);
  }
});

test("an old (pre-V2-06) v1 plan row keeps v1 precedence: the ROUTE template is sent even when the job carries another templateId; the plan version, not the job, decides", async () => {
  const slug = slugFor("old-plan");
  const log = providerLog(logPath("old-plan"));
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = world.organization.id;
  const { A, B } = world.templates;
  try {
    const run = async (name: string, rewritePlan: (plan: typeof campaignPlansTable.$inferSelect) => Partial<typeof campaignPlansTable.$inferInsert>) => {
      const { campaign } = await v2Campaign(org, `${slug}-${name}`, 8);
      const templateIds = [A!.id, B!.id];
      const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [world.phones.X!.id, world.phones.Y!.id], templateIds, mappings: firstNameMappings(templateIds) });
      assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
      const { plan } = await planCampaign(org, campaign.id);
      await executeCampaignPlan(org, campaign.id);
      await db.update(campaignPlansTable).set(rewritePlan(plan)).where(eq(campaignPlansTable.id, plan.id));
      // Every job on the A route is given template B on the JOB row only.
      const routeA = plan.routes.find((route) => route.templateId === A!.id)!;
      await db.update(campaignJobsTable).set({ templateId: B!.id }).where(and(eq(campaignJobsTable.campaignId, campaign.id), eq(campaignJobsTable.routeId, routeA.routeId)));
      const jobs = await db.select().from(campaignJobsTable).where(and(eq(campaignJobsTable.campaignId, campaign.id), eq(campaignJobsTable.routeId, routeA.routeId))).orderBy(asc(campaignJobsTable.id));
      assert.ok(jobs.length > 0, "the audience reaches the A route");
      const earlier = log.entries().length;
      await drainWithWorker(campaign.id, 8, `${slug}-${name}`);
      const contacts = new Map((await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaign.id))).map((c) => [c.id, c.normalizedPhone]));
      const sent = log.entries().slice(earlier);
      assert.equal(sent.length, 8, "one send per job of this campaign");
      return jobs.map((job) => ({
        sentName: sent.find((entry) => entry.payload.to === contacts.get(job.contactId!))!.payload.template.name,
        jobId: job.id,
      }));
    };

    // A plan frozen before V2-06: allocator v1, no distribution mode, the
    // oldest frozen-route shape (no V2-04 evidence, no lane fields).
    const old = await run("v1", (plan) => ({
      allocatorVersion: "v1",
      distributionMode: null,
      routes: plan.routes.map(({ routeId, phoneNumberId, templateId, configuredTps, providerTpsLimit, phone, displayName, sendingCredentialId }) => ({ routeId, phoneNumberId, templateId, configuredTps, providerTpsLimit, phone, displayName, sendingCredentialId })) as FrozenRoute[],
    }));
    assert.ok(old.every((row) => row.sentName === A!.name), "v1: the route's frozen template A is sent; the job's templateId B is NOT a v2 signal");
    for (const row of old) {
      const [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, row.jobId));
      assert.equal((job!.payload as { templateId: number }).templateId, A!.id, "the resolver agrees (v1 precedence)");
      assert.equal(job!.templateId, B!.id, "the job row itself is not rewritten");
    }

    // The same rows under an allocator-v2 plan: the job's template is authoritative.
    const gated = await run("v2", (plan) => ({ allocatorVersion: "v2", distributionMode: "equal_numbers", routes: plan.routes.map((route) => ({ ...route, sharedPhoneBudget: true })) }));
    assert.ok(gated.every((row) => row.sentName === B!.name), "v2: the job's allocated template B is sent");

    // The one shared precedence helper, directly.
    const routes = [{ routeId: 1, templateId: A!.id }];
    assert.equal(effectiveFrozenTemplateId({ allocatorVersion: "v1", routes }, 1, B!.id), A!.id);
    assert.equal(effectiveFrozenTemplateId({ allocatorVersion: "v1", routes }, 1, null), A!.id);
    assert.equal(effectiveFrozenTemplateId({ allocatorVersion: "v1", routes }, 2, B!.id), B!.id, "v1 falls back to the job only when the route is not frozen (unchanged)");
    assert.equal(effectiveFrozenTemplateId({ allocatorVersion: "v2", routes }, 1, B!.id), B!.id);
    assert.equal(effectiveFrozenTemplateId({ allocatorVersion: "v2", routes }, 1, null), A!.id);
  } finally {
    log.stop();
    await deleteOrganization(world.organization.id);
  }
});
