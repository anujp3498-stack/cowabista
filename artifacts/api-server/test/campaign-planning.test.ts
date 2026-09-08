import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignAllocationsTable,
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
import { CampaignNotReadyError, executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { resolveJobTemplate } from "../src/services/template-resolution";
import { describeTemplate, expandCompatibleMappings } from "../src/services/template-mapping";
import { partitionFor } from "../src/services/contact-processing";
import { DatabaseJobQueue, RouteTpsLimiter } from "../src/services/campaign-queue";

after(async () => {
  await pool.end();
});

async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  return organization;
}

async function createWaba(organizationId: number, slug: string) {
  const [waba] = await db.insert(wabasTable).values({
    organizationId,
    externalId: `${slug}-waba`,
    displayName: slug,
  }).returning();
  return waba;
}

async function createPhone(organizationId: number, wabaId: number, slug: string, tpsLimit: number) {
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId,
    wabaId,
    phone: `+1555${organizationId.toString().padStart(4, "0")}${Math.floor(Math.random() * 900 + 100)}`,
    displayName: slug,
    status: "Connected",
    tpsLimit,
  }).returning();
  return phone;
}

async function createTemplate(organizationId: number, wabaId: number, slug: string, body: string, components: Record<string, unknown>[] = [{ type: "BODY", text: body }]) {
  const [template] = await db.insert(templatesTable).values({
    organizationId,
    wabaId,
    name: slug,
    status: "Approved",
    body,
    components,
  }).returning();
  return template;
}

async function createCampaign(organizationId: number, name: string, status = "Draft") {
  const [campaign] = await db.insert(campaignsTable).values({ organizationId, name, status }).returning();
  return campaign;
}

async function createRoute(organizationId: number, campaignId: number, phoneNumberId: number, templateId: number, configuredTps: number) {
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId, campaignId, phoneNumberId, templateId, configuredTps,
  }).returning();
  return route;
}

async function selectTemplate(organizationId: number, campaignId: number, templateId: number) {
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId, campaignId, templateId });
}

async function mapVariable(
  organizationId: number,
  campaignId: number,
  templateId: number,
  component: "header" | "body" | "button",
  variable: string,
  source: "csv" | "static",
  sourceValue: string,
  extra: { optional?: boolean; fallbackValue?: string | null } = {},
) {
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId, campaignId, templateId, component, variable, source, sourceValue, ...extra,
  });
}

async function insertContact(organizationId: number, campaignId: number, rowNumber: number, normalizedPhone: string, data: Record<string, unknown> = {}) {
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId,
    campaignId,
    rowNumber,
    rawPhone: normalizedPhone,
    normalizedPhone,
    data,
    status: "Valid",
    idempotencyKey: `contact-${organizationId}-${campaignId}-${rowNumber}`,
  }).returning();
  return contact;
}

async function completeImport(organizationId: number, campaignId: number, columns: string[]) {
  await db.insert(contactImportSessionsTable).values({
    organizationId,
    campaignId,
    idempotencyKey: `import-${organizationId}-${campaignId}`,
    fileName: "contacts.csv",
    status: "Completed",
    columns,
  });
}

test("planCampaign freezes a reproducible snapshot and deterministically allocates contacts across multiple routes and templates", async () => {
  const slug = `plan-multi-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const waba = await createWaba(organization.id, slug);
    const phoneA = await createPhone(organization.id, waba.id, `${slug}-a`, 10);
    const phoneB = await createPhone(organization.id, waba.id, `${slug}-b`, 10);
    const templateA = await createTemplate(organization.id, waba.id, `${slug}-tpl-a`, "Hello {{1}}");
    const templateB = await createTemplate(organization.id, waba.id, `${slug}-tpl-b`, "Hi {{1}}");
    const campaign = await createCampaign(organization.id, slug);
    const routeA = await createRoute(organization.id, campaign.id, phoneA.id, templateA.id, 5);
    const routeB = await createRoute(organization.id, campaign.id, phoneB.id, templateB.id, 5);
    await selectTemplate(organization.id, campaign.id, templateA.id);
    await selectTemplate(organization.id, campaign.id, templateB.id);
    await mapVariable(organization.id, campaign.id, templateA.id, "body", "1", "static", "World");
    await mapVariable(organization.id, campaign.id, templateB.id, "body", "1", "static", "There");

    // Route ids are assigned in ascending insertion order, so bucket 0 maps to
    // routeA and bucket 1 maps to routeB (partitionCount is fixed at 64 for
    // any campaign with fewer than 64 routes -- see ALLOCATION partitioning).
    const partitionCount = 64;
    const bucketA: string[] = [];
    const bucketB: string[] = [];
    for (let index = 0; bucketA.length < 4 || bucketB.length < 4; index += 1) {
      const candidate = `+1777${String(index).padStart(7, "0")}`;
      const bucket = partitionFor(candidate, partitionCount) % 2;
      if (bucket === 0 && bucketA.length < 4) bucketA.push(candidate);
      else if (bucket === 1 && bucketB.length < 4) bucketB.push(candidate);
    }
    let rowNumber = 1;
    for (const phone of [...bucketA, ...bucketB]) {
      await insertContact(organization.id, campaign.id, rowNumber, phone);
      rowNumber += 1;
    }

    const first = await planCampaign(organization.id, campaign.id);
    assert.equal(first.plan.version, 1);
    assert.equal(first.allocated, 8);
    const [afterFirst] = await db.select({ status: campaignsTable.status }).from(campaignsTable)
      .where(eq(campaignsTable.id, campaign.id));
    assert.equal(afterFirst?.status, "Ready");

    const allocationsAfterFirst = await db.select().from(campaignAllocationsTable)
      .where(eq(campaignAllocationsTable.campaignId, campaign.id));
    assert.equal(allocationsAfterFirst.length, 8);
    for (const allocation of allocationsAfterFirst) {
      assert.equal(allocation.planId, first.plan.id);
      const expectRouteA = allocation.partitionKey % 2 === 0;
      assert.equal(allocation.routeId, expectRouteA ? routeA.id : routeB.id);
      assert.equal(allocation.templateId, expectRouteA ? templateA.id : templateB.id);
      assert.equal(allocation.phoneNumberId, expectRouteA ? phoneA.id : phoneB.id);
    }
    const routeACount = allocationsAfterFirst.filter((allocation) => allocation.routeId === routeA.id).length;
    const routeBCount = allocationsAfterFirst.filter((allocation) => allocation.routeId === routeB.id).length;
    assert.equal(routeACount, 4);
    assert.equal(routeBCount, 4);

    // Re-planning (e.g. after a config fix) must reproduce the exact same
    // per-contact allocation, superseding the old plan without duplicating
    // or reassigning any contact.
    const second = await planCampaign(organization.id, campaign.id);
    assert.equal(second.plan.version, 2);
    assert.equal(second.allocated, 8);

    const [firstPlanRow] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, first.plan.id));
    assert.equal(firstPlanRow?.status, "Superseded");
    const [secondPlanRow] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, second.plan.id));
    assert.equal(secondPlanRow?.status, "Active");

    const allocationsAfterSecond = await db.select().from(campaignAllocationsTable)
      .where(eq(campaignAllocationsTable.campaignId, campaign.id));
    assert.equal(allocationsAfterSecond.length, 8, "re-planning must not create duplicate allocation rows");
    for (const allocation of allocationsAfterSecond) {
      assert.equal(allocation.planId, second.plan.id);
      const before = allocationsAfterFirst.find((row) => row.contactId === allocation.contactId);
      assert.ok(before);
      assert.equal(allocation.routeId, before.routeId, "reproducing a plan must keep the same route for each contact");
      assert.equal(allocation.templateId, before.templateId);
      assert.equal(allocation.partitionKey, before.partitionKey);
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("planCampaign rejects unsafe configuration instead of silently reducing combined TPS on a shared phone", async () => {
  const slug = `plan-tps-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const waba = await createWaba(organization.id, slug);
    const phone = await createPhone(organization.id, waba.id, slug, 10);
    const templateA = await createTemplate(organization.id, waba.id, `${slug}-a`, "Hello {{1}}");
    const templateB = await createTemplate(organization.id, waba.id, `${slug}-b`, "Hi {{1}}");
    const campaign = await createCampaign(organization.id, slug);
    await createRoute(organization.id, campaign.id, phone.id, templateA.id, 6);
    await createRoute(organization.id, campaign.id, phone.id, templateB.id, 6);
    await selectTemplate(organization.id, campaign.id, templateA.id);
    await selectTemplate(organization.id, campaign.id, templateB.id);
    await mapVariable(organization.id, campaign.id, templateA.id, "body", "1", "static", "World");
    await mapVariable(organization.id, campaign.id, templateB.id, "body", "1", "static", "There");

    await assert.rejects(
      planCampaign(organization.id, campaign.id),
      (error: unknown) => {
        assert.ok(error instanceof CampaignNotReadyError);
        assert.ok(error.errors.some((message) => /combined TPS/.test(message)));
        return true;
      },
    );
    const [campaignRow] = await db.select({ status: campaignsTable.status }).from(campaignsTable)
      .where(eq(campaignsTable.id, campaign.id));
    assert.equal(campaignRow?.status, "Draft", "a rejected plan must not move the campaign toward Ready");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("executeCampaignPlan is idempotent across repeated calls and reconciles counters with persisted jobs", async () => {
  const slug = `execute-idem-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const waba = await createWaba(organization.id, slug);
    const phone = await createPhone(organization.id, waba.id, slug, 10);
    const template = await createTemplate(organization.id, waba.id, slug, "Hello {{1}}");
    const campaign = await createCampaign(organization.id, slug);
    const route = await createRoute(organization.id, campaign.id, phone.id, template.id, 5);
    await selectTemplate(organization.id, campaign.id, template.id);
    await mapVariable(organization.id, campaign.id, template.id, "body", "1", "static", "World");
    for (let index = 0; index < 5; index += 1) {
      await insertContact(organization.id, campaign.id, index + 1, `+1888${String(index).padStart(7, "0")}`);
    }
    await db.insert(campaignMetricsTable).values({
      organizationId: organization.id, campaignId: campaign.id, total: 5, valid: 5,
    });

    const { plan } = await planCampaign(organization.id, campaign.id);
    const first = await executeCampaignPlan(organization.id, campaign.id);
    assert.equal(first.queuedNew, 5);
    assert.equal(first.campaign.status, "Running");

    const second = await executeCampaignPlan(organization.id, campaign.id);
    assert.equal(second.queuedNew, 0, "re-executing an active plan must not create duplicate jobs");
    assert.equal(second.campaign.status, "Running");

    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(jobs.length, 5);
    assert.equal(new Set(jobs.map((job) => job.idempotencyKey)).size, 5);
    for (const job of jobs) assert.equal(job.routeId, route.id);

    const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaign.id));
    assert.equal(metrics?.queued, 5, "executing twice must not double-count the queued metric");

    const [routeRow] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.id, route.id));
    assert.equal(routeRow?.queueDepth, 5);

    const [executedAudits] = await db.select({ count: sql<number>`count(*)::int` }).from(campaignAuditTable)
      .where(and(eq(campaignAuditTable.campaignId, campaign.id), eq(campaignAuditTable.action, "executed")));
    assert.equal(executedAudits?.count, 1, "only the transition into Running is audited, not every idempotent replay");

    const allocations = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.campaignId, campaign.id));
    assert.equal(allocations.length, 5);
    assert.equal(new Set(allocations.map((allocation) => allocation.planId)).size, 1);
    assert.equal(allocations[0]?.planId, plan.id);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("executeCampaignPlan refuses to run without a frozen plan or from an unready status", async () => {
  const slug = `execute-guard-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const draftCampaign = await createCampaign(organization.id, `${slug}-draft`, "Draft");
    await assert.rejects(
      executeCampaignPlan(organization.id, draftCampaign.id),
      /cannot be executed from status Draft/,
    );

    const readyNoPlanCampaign = await createCampaign(organization.id, `${slug}-ready`, "Ready");
    await assert.rejects(
      executeCampaignPlan(organization.id, readyNoPlanCampaign.id),
      (error: unknown) => {
        assert.ok(error instanceof CampaignNotReadyError);
        assert.ok(error.errors.some((message) => /no frozen execution plan/.test(message)));
        return true;
      },
    );
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("resolveJobTemplate resolves from the frozen plan snapshot, ignoring a later live mapping edit, and applies an optional fallback", async () => {
  const slug = `resolve-frozen-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const waba = await createWaba(organization.id, slug);
    const phone = await createPhone(organization.id, waba.id, slug, 10);
    const template = await createTemplate(organization.id, waba.id, slug, "Hello {{1}}, code {{2}}");
    const campaign = await createCampaign(organization.id, slug);
    const route = await createRoute(organization.id, campaign.id, phone.id, template.id, 5);
    await selectTemplate(organization.id, campaign.id, template.id);
    await mapVariable(organization.id, campaign.id, template.id, "body", "1", "csv", "first_name");
    await mapVariable(organization.id, campaign.id, template.id, "body", "2", "csv", "promo_code", {
      optional: true,
      fallbackValue: "SAVE10",
    });
    await completeImport(organization.id, campaign.id, ["first_name", "promo_code"]);
    const contact = await insertContact(organization.id, campaign.id, 1, "+18990001111", { first_name: "Ada" });

    await planCampaign(organization.id, campaign.id);

    // Edit the live mapping after freezing -- the frozen plan must still be
    // used to resolve any job created from it.
    await db.update(campaignTemplateMappingsTable).set({ sourceValue: "last_name" }).where(and(
      eq(campaignTemplateMappingsTable.campaignId, campaign.id),
      eq(campaignTemplateMappingsTable.templateId, template.id),
      eq(campaignTemplateMappingsTable.component, "body"),
      eq(campaignTemplateMappingsTable.variable, "1"),
    ));

    await executeCampaignPlan(organization.id, campaign.id);
    const [queuedJob] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.ok(queuedJob);
    const [leased] = await db.update(campaignJobsTable).set({
      status: "Processing",
      leaseToken: "test-lease",
      lockedAt: sql`now()`,
    }).where(eq(campaignJobsTable.id, queuedJob.id)).returning();
    assert.ok(leased);

    const resolved = await resolveJobTemplate(leased);
    const parameters = (resolved.payload as { resolvedParameters: Record<string, Record<string, string>> }).resolvedParameters;
    assert.equal(parameters.body?.["1"], "Ada", "must use the frozen mapping (first_name), not the post-plan live edit (last_name)");
    assert.equal(parameters.body?.["2"], "SAVE10", "must fall back when the CSV value is missing from contact data");
    assert.equal(route.id, leased.routeId);
    assert.equal(contact.id, leased.contactId);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("executeCampaignPlan freezes route TPS and template onto each job, so a live route edit after planning cannot change what already-created jobs send or how fast", async () => {
  const slug = `execute-freeze-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const waba = await createWaba(organization.id, slug);
    const phone = await createPhone(organization.id, waba.id, slug, 10);
    const template = await createTemplate(organization.id, waba.id, slug, "Hello {{1}}");
    const otherTemplate = await createTemplate(organization.id, waba.id, `${slug}-other`, "Hi {{1}}");
    const campaign = await createCampaign(organization.id, slug);
    const route = await createRoute(organization.id, campaign.id, phone.id, template.id, 5);
    await selectTemplate(organization.id, campaign.id, template.id);
    await mapVariable(organization.id, campaign.id, template.id, "body", "1", "static", "World");
    await insertContact(organization.id, campaign.id, 1, "+18880001111");
    await db.insert(campaignMetricsTable).values({
      organizationId: organization.id, campaignId: campaign.id, total: 1, valid: 1,
    });

    await planCampaign(organization.id, campaign.id);

    // Simulate route edits made after the plan froze a safe TPS/template --
    // TPS now exceeds the phone's provider limit and the template points
    // elsewhere. Either would be unsafe/wrong if the worker read the route
    // live at claim/resolution time instead of the frozen plan.
    await db.update(campaignRoutesTable).set({ configuredTps: 20, templateId: otherTemplate.id })
      .where(eq(campaignRoutesTable.id, route.id));

    await executeCampaignPlan(organization.id, campaign.id);
    const [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.ok(job);
    assert.equal(job.configuredTps, 5, "the job must carry the plan's frozen TPS, not the route's current value");
    assert.equal(job.templateId, template.id, "the job must carry the plan's frozen template, not the route's current one");

    // The worker must honor the frozen 5/10 TPS (safe) rather than the live
    // 20/10 (unsafe) -- claiming must succeed and the route must stay Active
    // instead of being marked Throttled by an unsafe-config rejection.
    const queue = new DatabaseJobQueue();
    const claimed = await queue.claim(new RouteTpsLimiter(), "freeze-test-worker", 30_000);
    assert.ok(claimed, "claim must succeed using the frozen TPS despite the live route now exceeding the phone's limit");
    assert.equal(claimed?.id, job.id);
    const [routeAfterClaim] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.id, route.id));
    assert.equal(routeAfterClaim?.status, "Active", "the frozen TPS must not trip the unsafe-configuration throttle");

    // Template resolution must also use the frozen template, not the route's
    // current (now different) one.
    const resolved = await resolveJobTemplate(claimed!);
    assert.equal((resolved.payload as { templateId: number }).templateId, template.id);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("concurrent planCampaign calls for the same campaign serialize, so the Active plan's allocations never reference a superseded plan", async () => {
  const slug = `plan-concurrent-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const waba = await createWaba(organization.id, slug);
    const phone = await createPhone(organization.id, waba.id, slug, 10);
    const template = await createTemplate(organization.id, waba.id, slug, "Hello {{1}}");
    const campaign = await createCampaign(organization.id, slug);
    await createRoute(organization.id, campaign.id, phone.id, template.id, 5);
    await selectTemplate(organization.id, campaign.id, template.id);
    await mapVariable(organization.id, campaign.id, template.id, "body", "1", "static", "World");
    for (let index = 0; index < 6; index += 1) {
      await insertContact(organization.id, campaign.id, index + 1, `+1889${String(index).padStart(7, "0")}`);
    }

    // Three overlapping replans race for the same campaign. Without a
    // campaign-scoped lock held for the whole plan() operation, their
    // paginated allocation writes can commit out of order relative to which
    // plan ends up Active, leaving allocation rows stamped with a
    // superseded plan's id -- exactly the corruption execute() cannot
    // tolerate, since it strictly filters allocations by the Active plan id.
    const results = await Promise.all([
      planCampaign(organization.id, campaign.id),
      planCampaign(organization.id, campaign.id),
      planCampaign(organization.id, campaign.id),
    ]);
    assert.equal(new Set(results.map((result) => result.plan.version)).size, 3, "each concurrent call must produce its own plan version, never colliding");

    const plans = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaign.id));
    assert.equal(plans.length, 3);
    const activePlan = plans.find((planRow) => planRow.status === "Active");
    assert.ok(activePlan);
    assert.equal(activePlan.version, Math.max(...plans.map((planRow) => planRow.version)), "the highest version must be the one left Active");
    for (const planRow of plans) {
      if (planRow.id !== activePlan.id) assert.equal(planRow.status, "Superseded");
    }

    const allocations = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.campaignId, campaign.id));
    assert.equal(allocations.length, 6, "concurrent replans of the same contacts must not create duplicate allocation rows");
    for (const allocation of allocations) {
      assert.equal(allocation.planId, activePlan.id, "every allocation must belong to the Active plan, never a superseded one");
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("a replan racing execute() never lets a job resolve against a plan other than the one it was actually created from", async () => {
  const slug = `plan-execute-race-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const waba = await createWaba(organization.id, slug);
    const phone = await createPhone(organization.id, waba.id, slug, 10);
    const template = await createTemplate(organization.id, waba.id, slug, "Hello {{1}}");
    const campaign = await createCampaign(organization.id, slug);
    await createRoute(organization.id, campaign.id, phone.id, template.id, 5);
    await selectTemplate(organization.id, campaign.id, template.id);
    await mapVariable(organization.id, campaign.id, template.id, "body", "1", "static", "World");
    await insertContact(organization.id, campaign.id, 1, "+18890002222");
    await db.insert(campaignMetricsTable).values({
      organizationId: organization.id, campaignId: campaign.id, total: 1, valid: 1,
    });

    const { plan: planV1 } = await planCampaign(organization.id, campaign.id);

    // Change the mapping so a replan (v2) would freeze a different value
    // than v1 froze -- this makes it possible to detect, after the race,
    // exactly which plan a job actually resolves against.
    await db.update(campaignTemplateMappingsTable).set({ sourceValue: "Updated" }).where(and(
      eq(campaignTemplateMappingsTable.campaignId, campaign.id),
      eq(campaignTemplateMappingsTable.templateId, template.id),
    ));

    // A manager clicks Execute while another replans at the same moment.
    // The campaign-lifecycle lock forces one to fully finish before the
    // other starts, so exactly one consistent outcome results -- but which
    // one wins the race is not guaranteed, so assert the invariant that
    // holds under either ordering: a created job's resolved value must
    // always match the plan it was actually stamped with (job.planId), not
    // whichever plan happens to be Active by the time resolution runs.
    const [replanResult, executeResult] = await Promise.allSettled([
      planCampaign(organization.id, campaign.id),
      executeCampaignPlan(organization.id, campaign.id),
    ]);
    assert.ok(replanResult.status === "fulfilled" || executeResult.status === "fulfilled", "at least one of the racing calls must succeed");

    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    if (executeResult.status === "fulfilled" && executeResult.value.queuedNew > 0) {
      assert.equal(jobs.length, 1);
      const [job] = jobs;
      assert.ok(job?.planId, "an executed job must carry the exact plan it was created from");
      const expectedValue = job!.planId === planV1.id ? "World" : "Updated";

      const [leased] = await db.update(campaignJobsTable).set({
        status: "Processing", leaseToken: "race-lease", lockedAt: sql`now()`,
      }).where(eq(campaignJobsTable.id, job!.id)).returning();
      const resolved = await resolveJobTemplate(leased!);
      const parameters = (resolved.payload as { resolvedParameters: Record<string, Record<string, string>> }).resolvedParameters;
      assert.equal(
        parameters.body?.["1"],
        expectedValue,
        "resolution must use the plan the job was actually stamped with, never whichever plan is currently Active",
      );
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("expandCompatibleMappings expands one shared body and button mapping to every template requiring the same key, and rejects disagreement", () => {
  const descriptors = [
    describeTemplate({
      id: 501,
      body: "Hello {{1}}",
      components: [{ type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/{{1}}" }] }],
    }),
    describeTemplate({
      id: 502,
      body: "Hello {{1}}, order {{2}}",
      components: [{ type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/{{1}}" }] }],
    }),
  ];
  const expanded = expandCompatibleMappings(descriptors, [
    { templateId: 501, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    { templateId: 501, component: "button", variable: "0:1", source: "csv", sourceValue: "code" },
    { templateId: 502, component: "body", variable: "2", source: "csv", sourceValue: "order_id" },
  ]);
  const bodyOneMappings = expanded.filter((mapping) => mapping.component === "body" && mapping.variable === "1");
  const buttonMappings = expanded.filter((mapping) => mapping.component === "button");
  assert.equal(bodyOneMappings.length, 2, "body:1 is required by both templates so it must expand to both");
  assert.ok(bodyOneMappings.every((mapping) => mapping.sourceValue === "first_name"));
  assert.equal(buttonMappings.length, 2, "the shared button url variable must expand to both templates");
  assert.ok(buttonMappings.every((mapping) => mapping.sourceValue === "code"));
  assert.equal(expanded.filter((mapping) => mapping.component === "body" && mapping.variable === "2").length, 1);

  assert.throws(
    () => expandCompatibleMappings(descriptors, [
      { templateId: 501, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
      { templateId: 502, component: "body", variable: "1", source: "csv", sourceValue: "given_name" },
    ]),
    /Compatible templates must use one shared mapping for body:1/,
  );
});
