import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignContactsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  contactImportSessionsTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import { CreateCampaignBody, SaveMessageSetupBody, UpdateCampaignBody } from "@workspace/api-zod";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { allocatorInputFromPlan, CampaignNotReadyError, executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { createAllocatorV2 } from "../src/services/campaign-allocator-v2";
import { getActivePlanSummary } from "../src/services/campaign-plan-preview";
import { validateCampaignReady } from "../src/services/campaign-preflight";
import { deleteOrganization } from "./message-studio-fixtures";
import { firstNameMappings, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06A allocator v2 setup and planning: the distribution mode is a
// lifecycle- and revision-fenced setup write; Message Studio derives ONE
// sender lane per number; readiness and planning refuse an incomplete
// selection; the frozen plan carries the mode, the lanes and per-template
// V2-04 evidence, and its allocation is reproducible from the plan row
// alone. Local/mock provider context only: nothing is sent here.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2plan-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

/** WABA-realizable mixed eligibility: X, Y share account 1 (templates A, B); Z is on account 2 (template C). */
const MIXED = (tps: { X?: number; Y?: number; Z?: number } = {}) => ({
  wabas: [
    { phones: [{ key: "X", tps: tps.X }, { key: "Y", tps: tps.Y }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] },
    { phones: [{ key: "Z", tps: tps.Z }], templates: [{ key: "C", body: "Charlie {{1}}" }] },
  ],
});

async function routesOf(campaignId: number) {
  return db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaignId)).orderBy(asc(campaignRoutesTable.phoneNumberId));
}
async function modeOf(campaignId: number) {
  const [row] = await db.select({ mode: campaignsTable.distributionMode, status: campaignsTable.status }).from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  return row!;
}

test("the distribution mode is a setup write: lifecycle- and revision-fenced, tenant-scoped; allocatorVersion is never client-writable", async () => {
  const slug = slugFor("fence");
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Hi {{1}}" }, { key: "B", body: "Yo {{1}}" }] }] });
  const other = await v2World(`${slug}-o`, { wabas: [{ phones: [{ key: "Q" }], templates: [{ key: "Q", body: "Hey {{1}}" }] }] });
  const org = world.organization.id;
  try {
    const { campaign } = await v2Campaign(org, slug, 6);
    assert.equal(campaign.distributionMode, null, "a new campaign has no mode (allocator v1): no silent v2 default");
    const ids = [world.templates.A!.id, world.templates.B!.id];
    const body = (revision: number, distributionMode?: unknown) => ({
      revision, senderPhoneNumberIds: [world.phones.X!.id], templateIds: ids, mappings: firstNameMappings(ids),
      ...(distributionMode !== undefined ? { distributionMode } : {}),
    });

    // Draft: saved, in the same write as the rest of the setup.
    const first = await saveSetup(org, campaign.id, body(0, "equal_numbers"));
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.distributionMode, "equal_numbers");
    assert.equal(first.body.execution.allocatorVersion, "v2");
    assert.equal(first.body.execution.executable, true);
    assert.equal((await modeOf(campaign.id)).mode, "equal_numbers");

    // A stale revision is refused and changes nothing.
    const stale = await saveSetup(org, campaign.id, body(0, "equal_templates"));
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.code, "stale_revision");
    assert.equal((await modeOf(campaign.id)).mode, "equal_numbers");

    // Omitting the field keeps the mode.
    const kept = await saveSetup(org, campaign.id, body(first.body.revision));
    assert.equal(kept.statusCode, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.distributionMode, "equal_numbers");

    // allocatorVersion is derived, never an input: not in any write contract,
    // and a client-sent value is ignored.
    assert.ok(!("allocatorVersion" in SaveMessageSetupBody.shape));
    for (const shape of [UpdateCampaignBody.shape, CreateCampaignBody.shape]) {
      assert.ok(!("allocatorVersion" in shape) && !("distributionMode" in shape), "campaign create/update cannot set the distribution");
    }
    const forced = await saveSetup(org, campaign.id, { ...body(kept.body.revision), allocatorVersion: "v1" });
    assert.equal(forced.statusCode, 200, JSON.stringify(forced.body));
    assert.equal(forced.body.execution.allocatorVersion, "v2");

    // An unsupported mode (e.g. Smart Capacity) is refused.
    const unsupported = await saveSetup(org, campaign.id, body(forced.body.revision, "smart_capacity"));
    assert.equal(unsupported.statusCode, 400);
    assert.equal((await modeOf(campaign.id)).mode, "equal_numbers");

    // Ready without jobs: the plan is superseded and the campaign returns to Draft atomically.
    const planned = await planCampaign(org, campaign.id);
    assert.equal(planned.plan.allocatorVersion, "v2");
    assert.equal(planned.plan.distributionMode, "equal_numbers");
    const reopened = await saveSetup(org, campaign.id, body(forced.body.revision, "equal_templates"));
    assert.equal(reopened.statusCode, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.status, "Draft");
    assert.equal((await modeOf(campaign.id)).mode, "equal_templates");
    const [superseded] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, planned.plan.id));
    assert.equal(superseded!.status, "Superseded");
    assert.equal(superseded!.distributionMode, "equal_numbers", "the frozen plan keeps the mode it was made with");

    // A processing import fences the write.
    const [importing] = await db.insert(contactImportSessionsTable).values({ organizationId: org, campaignId: campaign.id, idempotencyKey: `${slug}-importing`, fileName: "more.csv", status: "Processing" }).returning();
    const duringImport = await saveSetup(org, campaign.id, body(reopened.body.revision, "equal_numbers"));
    assert.equal(duringImport.statusCode, 409);
    assert.equal(duringImport.body.code, "import_in_progress");
    assert.equal((await modeOf(campaign.id)).mode, "equal_templates");
    await db.delete(contactImportSessionsTable).where(eq(contactImportSessionsTable.id, importing!.id));

    // After jobs exist, and for every non-editable status: refused, never reset.
    await planCampaign(org, campaign.id);
    await executeCampaignPlan(org, campaign.id);
    for (const status of ["Running", "Paused", "Scheduled", "Ready"]) {
      await db.update(campaignsTable).set({ status }).where(eq(campaignsTable.id, campaign.id));
      const refused = await saveSetup(org, campaign.id, body(reopened.body.revision, "equal_numbers"));
      assert.equal(refused.statusCode, 409, status);
      assert.equal(refused.body.code, status === "Ready" ? "execution_history" : "setup_locked", status);
      assert.deepEqual(await modeOf(campaign.id), { mode: "equal_templates", status }, `${status}: mode and status unchanged`);
    }

    // Another workspace can neither see nor change it.
    const foreign = await saveSetup(other.organization.id, campaign.id, body(reopened.body.revision, "equal_numbers"));
    assert.equal(foreign.statusCode, 404);
    assert.equal((await modeOf(campaign.id)).mode, "equal_templates");
  } finally {
    await deleteOrganization(world.organization.id);
    await deleteOrganization(other.organization.id);
  }
});

test("allocator v2 derives exactly ONE sender lane per number with a deterministic default; switching modes rebuilds the route model both ways", async () => {
  const slug = slugFor("lanes");
  const world = await v2World(slug, MIXED({ X: 40, Y: 30, Z: 20 }));
  const org = world.organization.id;
  const { X, Y, Z } = world.phones as Record<string, { id: number }>;
  const { A, B, C } = world.templates as Record<string, { id: number }>;
  try {
    const { campaign } = await v2Campaign(org, slug, 6);
    const save = (revision: number, senders: number[], templates: number[], distributionMode: string | null) =>
      saveSetup(org, campaign.id, { revision, senderPhoneNumberIds: senders, templateIds: templates, mappings: firstNameMappings(templates), distributionMode });

    // A legacy 1 x N selection: allocator v1 cannot run it (no routes, readiness says so) ...
    const v1 = await save(0, [X!.id], [A!.id, B!.id], null);
    assert.equal(v1.statusCode, 200, JSON.stringify(v1.body));
    assert.equal(v1.body.execution.allocatorVersion, "v1");
    assert.equal(v1.body.execution.code, "needs_multi_template");
    assert.equal((await routesOf(campaign.id)).length, 0);
    const v1Errors = await validateCampaignReady(org, campaign.id);
    assert.ok(v1Errors.some((e) => e.startsWith("Message setup:") && e.includes("more than one template")), v1Errors.join(" | "));

    // ... allocator v2 runs it with ONE lane whose default is the lowest eligible template.
    const v2 = await save(v1.body.revision, [X!.id], [A!.id, B!.id], "equal_numbers");
    assert.equal(v2.statusCode, 200, JSON.stringify(v2.body));
    let routes = await routesOf(campaign.id);
    assert.equal(routes.length, 1, "1 number x 2 templates = exactly one sender lane");
    assert.deepEqual({ phone: routes[0]!.phoneNumberId, template: routes[0]!.templateId, shared: routes[0]!.sharedPhoneBudget, tps: routes[0]!.configuredTps }, { phone: X!.id, template: A!.id, shared: true, tps: 40 });
    assert.deepEqual(await validateCampaignReady(org, campaign.id), []);

    // Back to v1: the lane is never reused as a v1 route.
    const back = await save(v2.body.revision, [X!.id], [A!.id, B!.id], null);
    assert.equal(back.statusCode, 200);
    assert.equal((await routesOf(campaign.id)).length, 0);

    // A v1-runnable selection keeps v1 routes (one template per number) ...
    const v1Runnable = await save(back.body.revision, [X!.id, Z!.id], [A!.id, C!.id], null);
    assert.equal(v1Runnable.body.execution.executable, true);
    routes = await routesOf(campaign.id);
    assert.deepEqual(routes.map((r) => [r.phoneNumberId, r.templateId, r.sharedPhoneBudget]), [[X!.id, A!.id, false], [Z!.id, C!.id, false]]);
    await db.update(campaignRoutesTable).set({ configuredTps: 7 }).where(eq(campaignRoutesTable.id, routes[0]!.id));
    const v1RouteIds = routes.map((r) => r.id);

    // ... and switching to v2 replaces them by lanes, carrying each number's configured speed.
    const mixed = await save(v1Runnable.body.revision, [X!.id, Y!.id, Z!.id], [A!.id, B!.id, C!.id], "equal_templates");
    assert.equal(mixed.statusCode, 200, JSON.stringify(mixed.body));
    routes = await routesOf(campaign.id);
    assert.deepEqual(routes.map((r) => [r.phoneNumberId, r.templateId, r.sharedPhoneBudget, r.configuredTps]), [
      [X!.id, A!.id, true, 7], [Y!.id, A!.id, true, 30], [Z!.id, C!.id, true, 20],
    ], "3 numbers x 3 templates = 3 lanes; Z's default is C (it cannot send A or B)");
    assert.ok(routes.every((r) => !v1RouteIds.includes(r.id)), "no v1 route survives as a lane");
    assert.deepEqual(mixed.body.execution.assignments, [
      { phoneNumberId: X!.id, templateId: A!.id }, { phoneNumberId: X!.id, templateId: B!.id },
      { phoneNumberId: Y!.id, templateId: A!.id }, { phoneNumberId: Y!.id, templateId: B!.id },
      { phoneNumberId: Z!.id, templateId: C!.id },
    ], "every V2-04 eligible pair, none invented");
    assert.deepEqual(await validateCampaignReady(org, campaign.id), []);

    // Saving again (or switching v2 mode) keeps the same lanes.
    const again = await save(mixed.body.revision, [Z!.id, Y!.id, X!.id], [C!.id, B!.id, A!.id], "equal_numbers");
    assert.equal(again.statusCode, 200);
    assert.deepEqual((await routesOf(campaign.id)).map((r) => r.id), routes.map((r) => r.id), "lanes are stable across saves and request order");
  } finally {
    await deleteOrganization(world.organization.id);
  }
});

test("an incomplete v2 selection is saved without dropping anything, and readiness and planning refuse it (no lane or template is skipped)", async () => {
  const slug = slugFor("incomplete");
  const world = await v2World(slug, MIXED());
  const org = world.organization.id;
  const { X, Z } = world.phones as Record<string, { id: number }>;
  const { A, C } = world.templates as Record<string, { id: number }>;
  try {
    const { campaign } = await v2Campaign(org, slug, 6);
    // Z (account 2) cannot send A: its lane is kept with NO default template.
    const noTemplate = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id, Z!.id], templateIds: [A!.id], mappings: firstNameMappings([A!.id]), distributionMode: "equal_numbers" });
    assert.equal(noTemplate.statusCode, 200, JSON.stringify(noTemplate.body));
    assert.equal(noTemplate.body.execution.code, "incompatible");
    assert.match(noTemplate.body.execution.message, /cannot send any selected template/);
    assert.deepEqual(noTemplate.body.selection.senderPhoneNumberIds, [X!.id, Z!.id], "no number is silently dropped");
    const routes = await routesOf(campaign.id);
    assert.deepEqual(routes.map((r) => [r.phoneNumberId, r.templateId]), [[X!.id, A!.id], [Z!.id, null]]);
    const errors = await validateCampaignReady(org, campaign.id);
    assert.ok(errors.some((e) => e.startsWith(`Route ${routes[1]!.id}: the number cannot send any selected template`)), errors.join(" | "));
    await assert.rejects(planCampaign(org, campaign.id), CampaignNotReadyError);

    // Template C has no selected number that can send it.
    const noSender = await saveSetup(org, campaign.id, { revision: noTemplate.body.revision, senderPhoneNumberIds: [X!.id], templateIds: [A!.id, C!.id], mappings: firstNameMappings([A!.id, C!.id]), distributionMode: "equal_templates" });
    assert.equal(noSender.statusCode, 200);
    assert.equal(noSender.body.execution.code, "incompatible");
    assert.deepEqual(noSender.body.selection.templateIds, [A!.id, C!.id], "no template is silently dropped");
    const coverage = await validateCampaignReady(org, campaign.id);
    assert.ok(coverage.includes(`Template ${C!.id} has no eligible sending route`), coverage.join(" | "));
    await assert.rejects(planCampaign(org, campaign.id), CampaignNotReadyError);

    // A legacy route writer's v1 route under a v2 campaign is not a lane: refused.
    const complete = await saveSetup(org, campaign.id, { revision: noSender.body.revision, senderPhoneNumberIds: [X!.id], templateIds: [A!.id], mappings: firstNameMappings([A!.id]), distributionMode: "equal_numbers" });
    assert.equal(complete.statusCode, 200);
    assert.deepEqual(await validateCampaignReady(org, campaign.id), []);
    const [legacy] = await db.insert(campaignRoutesTable).values({ organizationId: org, campaignId: campaign.id, phoneNumberId: X!.id, templateId: A!.id, configuredTps: 5 }).returning();
    const legacyErrors = await validateCampaignReady(org, campaign.id);
    assert.ok(legacyErrors.includes(`Route ${legacy!.id} is not a sender lane for the chosen distribution; save the message setup again`), legacyErrors.join(" | "));
    assert.ok(legacyErrors.includes(`Number ${X!.id} has more than one sender lane; save the message setup again`), legacyErrors.join(" | "));
    await assert.rejects(planCampaign(org, campaign.id), CampaignNotReadyError);
    assert.equal((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaign.id))).length, 0, "nothing was frozen");
  } finally {
    await deleteOrganization(world.organization.id);
  }
});

test("a v2 plan freezes the mode, one shared-budget lane per number with per-template evidence, and its allocation is reproducible from the plan row alone", async () => {
  const slug = slugFor("frozen");
  const world = await v2World(slug, MIXED({ X: 10, Y: 20, Z: 30 }));
  const org = world.organization.id;
  const { X, Y, Z } = world.phones as Record<string, { id: number }>;
  const { A, B, C } = world.templates as Record<string, { id: number }>;
  const eligible = new Map([[X!.id, [A!.id, B!.id]], [Y!.id, [A!.id, B!.id]], [Z!.id, [C!.id]]]);
  try {
    const { campaign } = await v2Campaign(org, slug, 90);
    const templateIds = [C!.id, A!.id, B!.id];
    const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id, Y!.id, Z!.id], templateIds, mappings: firstNameMappings(templateIds), distributionMode: "equal_templates" });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));

    const { plan, allocated } = await planCampaign(org, campaign.id);
    assert.equal(allocated, 90);
    assert.equal(plan.allocatorVersion, "v2");
    assert.equal(plan.distributionMode, "equal_templates");
    assert.deepEqual([...(plan.templateIds as number[])].sort((a, b) => a - b), [A!.id, B!.id, C!.id]);
    assert.equal(plan.routes.length, 3);
    for (const route of plan.routes) {
      const expected = eligible.get(route.phoneNumberId)!;
      assert.equal(route.sharedPhoneBudget, true);
      assert.deepEqual(route.eligibleTemplateIds, expected);
      assert.deepEqual(route.eligibleTemplates, expected.map((templateId) => ({ templateId, verifiedAt: null, source: "local_mock" })), "per-template evidence from one V2-04 evaluation");
      assert.equal(route.templateId, expected[0], "the default is the lowest eligible template");
    }
    assert.deepEqual(plan.routes.map((r) => [r.phoneNumberId, r.configuredTps]), [[X!.id, 10], [Y!.id, 20], [Z!.id, 30]]);
    assert.doesNotMatch(JSON.stringify(plan), /token|ciphertext|providerMediaId|storageKey|authTag/i, "no secret or provider handle in the frozen plan");

    // Every allocation is a V2-04 eligible pair on its lane ...
    const allocations = await db.select({ contactId: campaignAllocationsTable.contactId, routeId: campaignAllocationsTable.routeId, phoneNumberId: campaignAllocationsTable.phoneNumberId, templateId: campaignAllocationsTable.templateId, phone: campaignContactsTable.normalizedPhone })
      .from(campaignAllocationsTable).innerJoin(campaignContactsTable, eq(campaignContactsTable.id, campaignAllocationsTable.contactId))
      .where(eq(campaignAllocationsTable.planId, plan.id)).orderBy(asc(campaignAllocationsTable.contactId));
    assert.equal(allocations.length, 90);
    for (const row of allocations) {
      assert.ok(eligible.get(row.phoneNumberId)!.includes(row.templateId!), `ineligible pair ${row.phoneNumberId}/${row.templateId}`);
      assert.equal(plan.routes.find((r) => r.routeId === row.routeId)!.phoneNumberId, row.phoneNumberId);
    }
    assert.equal(new Set(allocations.map((r) => r.templateId)).size, 3, "all three templates are used");
    assert.equal(new Set(allocations.map((r) => r.phoneNumberId)).size, 3, "all three numbers are used");

    // ... and reproducible from the stored plan row alone (fresh read, JSON round trip).
    const [stored] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, plan.id));
    const rebuilt = createAllocatorV2(JSON.parse(JSON.stringify(allocatorInputFromPlan(stored!))));
    for (const row of allocations) {
      assert.deepEqual(rebuilt.allocate(row.phone!), { routeId: row.routeId, phoneNumberId: row.phoneNumberId, templateId: row.templateId });
    }

    // The plan summary is version-aware.
    const summary = (await getActivePlanSummary(org, campaign.id))!;
    assert.equal(summary.allocatorVersion, "v2");
    assert.equal(summary.distributionMode, "equal_templates");
    assert.equal(summary.allocationCounts.total, 90);
    assert.equal(summary.allocationCounts.byTemplate.reduce((sum, row) => sum + row.count, 0), 90);
    assert.equal(summary.allocationCounts.bySender.reduce((sum, row) => sum + row.count, 0), 90);
    for (const pair of summary.allocationCounts.byPair) assert.ok(eligible.get(pair.phoneNumberId)!.includes(pair.templateId));
    assert.ok(summary.routes.every((route) => route.sharedPhoneBudget === true && (route.eligibleTemplates?.length ?? 0) > 0));

    // Replanning the same inputs reproduces every assignment under a new version.
    const second = await planCampaign(org, campaign.id);
    assert.equal(second.plan.version, plan.version + 1);
    const replanned = await db.select({ contactId: campaignAllocationsTable.contactId, routeId: campaignAllocationsTable.routeId, phoneNumberId: campaignAllocationsTable.phoneNumberId, templateId: campaignAllocationsTable.templateId })
      .from(campaignAllocationsTable).where(and(eq(campaignAllocationsTable.campaignId, campaign.id), eq(campaignAllocationsTable.planId, second.plan.id))).orderBy(asc(campaignAllocationsTable.contactId));
    assert.deepEqual(replanned, allocations.map(({ phone: _phone, ...row }) => row));
  } finally {
    await deleteOrganization(world.organization.id);
  }
});
