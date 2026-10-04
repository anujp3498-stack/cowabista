import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  db,
  phoneNumbersTable,
  pool,
  settlementPool,
  templatesTable,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter } from "../src/services/campaign-queue";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { deleteOrganization } from "./message-studio-fixtures";
import { drainWithWorker, firstNameMappings, providerLog, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06A: a frozen recipient -> sender -> template decision is immutable.
// The live prepare checks are permission gates, not a second allocator: when
// a frozen pair becomes unsendable after planning the job fails closed and is
// NEVER moved to another template or sender. A replan never changes what an
// already-created job sends. Local/mock provider only.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2inv-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
const logPath = (name: string) => path.join(os.tmpdir(), `v2inv-provider-${name}-${process.pid}-${Date.now()}.log`);

/** Gives the worker extra passes so refused jobs are claimed (and refused) too. */
async function extraPasses(label: string, passes = 30) {
  const worker = new CampaignWorker(new DatabaseJobQueue(), new WhatsAppTemplateSender(), new RouteTpsLimiter(), `${label}-extra`);
  const outcomes: string[] = [];
  for (let i = 0; i < passes; i++) {
    const outcome = await worker.processOne();
    outcomes.push(outcome);
    if (outcome !== "sent") await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return outcomes;
}

async function decisions(campaignId: number) {
  const jobs = await db.select({ id: campaignJobsTable.id, contactId: campaignJobsTable.contactId, routeId: campaignJobsTable.routeId, templateId: campaignJobsTable.templateId, planId: campaignJobsTable.planId })
    .from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(asc(campaignJobsTable.id));
  const allocations = await db.select({ contactId: campaignAllocationsTable.contactId, routeId: campaignAllocationsTable.routeId, phoneNumberId: campaignAllocationsTable.phoneNumberId, templateId: campaignAllocationsTable.templateId, planId: campaignAllocationsTable.planId })
    .from(campaignAllocationsTable).where(eq(campaignAllocationsTable.campaignId, campaignId)).orderBy(asc(campaignAllocationsTable.contactId));
  const routes = await db.select({ id: campaignRoutesTable.id, phoneNumberId: campaignRoutesTable.phoneNumberId, templateId: campaignRoutesTable.templateId }).from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaignId)).orderBy(asc(campaignRoutesTable.id));
  return { jobs, allocations, routes };
}

async function recipients(campaignId: number) {
  return new Map((await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaignId))).map((c) => [c.id, c.normalizedPhone!]));
}

test("a template made unsendable after planning: its jobs fail closed; no other template or sender is ever used", async () => {
  const slug = slugFor("template");
  const log = providerLog(logPath("template"));
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }, { key: "C", body: "Charlie {{1}}" }] }] });
  const org = world.organization.id;
  const { A, B, C } = world.templates;
  try {
    const { campaign } = await v2Campaign(org, slug, 18);
    const ids = [A!.id, B!.id, C!.id];
    assert.equal((await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [world.phones.X!.id], templateIds: ids, mappings: firstNameMappings(ids), distributionMode: "equal_numbers" })).statusCode, 200);
    await planCampaign(org, campaign.id);
    await executeCampaignPlan(org, campaign.id);
    const frozen = await decisions(campaign.id);
    const bJobs = frozen.jobs.filter((job) => job.templateId === B!.id);
    assert.ok(bJobs.length > 0 && bJobs.length < frozen.jobs.length, "the audience spans B and other templates");

    // After the freeze, Meta pauses template B.
    await db.update(templatesTable).set({ status: "Paused" }).where(eq(templatesTable.id, B!.id));
    await drainWithWorker(campaign.id, frozen.jobs.length - bJobs.length, slug);
    await extraPasses(slug);

    const to = await recipients(campaign.id);
    const bRecipients = new Set(bJobs.map((job) => to.get(job.contactId!)));
    const sent = log.entries();
    assert.equal(sent.length, frozen.jobs.length - bJobs.length, "only the still-sendable pairs were sent");
    assert.ok(sent.every((entry) => entry.payload.template.name !== B!.name), "the paused template is never sent");
    assert.ok(sent.every((entry) => !bRecipients.has(entry.payload.to)), "no B recipient was sent another template instead");
    const jobsAfter = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    for (const job of jobsAfter.filter((candidate) => candidate.templateId === B!.id)) {
      assert.notEqual(job.status, "Sent");
      assert.match(String(job.errorReason ?? ""), /approved/i, `job ${job.id}: ${job.errorReason}`);
    }
    assert.deepEqual(await decisions(campaign.id), frozen, "allocations, jobs (route + template) and routes are untouched: nothing was reassigned");
  } finally {
    log.stop();
    await deleteOrganization(world.organization.id);
  }
});

test("a sender made unusable after planning: its jobs fail closed; they are never moved to another sender", async () => {
  const slug = slugFor("sender");
  const log = providerLog(logPath("sender"));
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const org = world.organization.id;
  const { X, Y } = world.phones;
  try {
    const { campaign } = await v2Campaign(org, slug, 16);
    const ids = [world.templates.A!.id, world.templates.B!.id];
    assert.equal((await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [X!.id, Y!.id], templateIds: ids, mappings: firstNameMappings(ids), distributionMode: "equal_templates" })).statusCode, 200);
    const { plan } = await planCampaign(org, campaign.id);
    await executeCampaignPlan(org, campaign.id);
    const frozen = await decisions(campaign.id);
    const yRoute = plan.routes.find((route) => route.phoneNumberId === Y!.id)!;
    const yJobs = frozen.jobs.filter((job) => job.routeId === yRoute.routeId);
    assert.ok(yJobs.length > 0 && yJobs.length < frozen.jobs.length, "the audience spans both senders");

    // After the freeze, sender Y disconnects.
    await db.update(phoneNumbersTable).set({ status: "Disconnected" }).where(eq(phoneNumbersTable.id, Y!.id));
    await drainWithWorker(campaign.id, frozen.jobs.length - yJobs.length, slug);
    await extraPasses(slug);

    const to = await recipients(campaign.id);
    const yRecipients = new Set(yJobs.map((job) => to.get(job.contactId!)));
    const sent = log.entries();
    assert.equal(sent.length, frozen.jobs.length - yJobs.length);
    assert.ok(sent.every((entry) => entry.phoneId === X!.providerPhoneId), "only X sent");
    assert.ok(sent.every((entry) => !yRecipients.has(entry.payload.to)), "no Y recipient was rerouted to X");
    const jobsAfter = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    for (const job of jobsAfter.filter((candidate) => candidate.routeId === yRoute.routeId)) {
      assert.notEqual(job.status, "Sent");
      assert.ok(job.errorReason, `job ${job.id} records why it was refused`);
    }
    assert.deepEqual(await decisions(campaign.id), frozen, "nothing was reassigned");
  } finally {
    log.stop();
    await deleteOrganization(world.organization.id);
  }
});

test("replan isolation: jobs of plan P1 keep P1's sender, template and mappings after a configuration change and replan P2; P2's jobs use P2", async () => {
  const slug = slugFor("replan");
  const log = providerLog(logPath("replan"));
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }, { key: "C", body: "Charlie {{1}}" }] }] });
  const org = world.organization.id;
  const { A, B, C } = world.templates;
  try {
    const { campaign, contacts } = await v2Campaign(org, slug, 16);
    const p1Ids = [A!.id, B!.id];
    const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [world.phones.X!.id, world.phones.Y!.id], templateIds: p1Ids, mappings: firstNameMappings(p1Ids), distributionMode: "equal_numbers" });
    assert.equal(saved.statusCode, 200);
    const { plan: p1 } = await planCampaign(org, campaign.id);
    await executeCampaignPlan(org, campaign.id);
    const p1Jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(p1Jobs.length, 16);

    // The setup API refuses once jobs exist ...
    const refused = await saveSetup(org, campaign.id, { revision: saved.body.revision, senderPhoneNumberIds: [world.phones.X!.id], templateIds: [A!.id], mappings: firstNameMappings([A!.id]), distributionMode: "equal_templates" });
    assert.equal(refused.statusCode, 409);
    // ... so force the worst case below it: an operator-level change of mode,
    // templates and mappings, new recipients, and a replan while P1's jobs are queued.
    await db.update(campaignsTable).set({ status: "Ready", distributionMode: "equal_templates" }).where(eq(campaignsTable.id, campaign.id));
    await db.insert(campaignTemplateSelectionsTable).values({ organizationId: org, campaignId: campaign.id, templateId: C!.id });
    await db.insert(campaignTemplateMappingsTable).values({ organizationId: org, campaignId: campaign.id, templateId: C!.id, component: "body", variable: "1", source: "csv", sourceValue: "first_name" });
    await db.update(campaignTemplateMappingsTable).set({ source: "static", sourceValue: "CHANGED" }).where(and(eq(campaignTemplateMappingsTable.campaignId, campaign.id), eq(campaignTemplateMappingsTable.templateId, A!.id)));
    const [session] = contacts.length ? [contacts[0]!.importSessionId] : [];
    const added = await db.insert(campaignContactsTable).values(Array.from({ length: 8 }, (_, index) => ({
      organizationId: org, campaignId: campaign.id, importSessionId: session ?? null, rowNumber: 100 + index,
      rawPhone: `+448${String(campaign.id % 100_000).padStart(5, "0")}${String(index).padStart(4, "0")}`,
      normalizedPhone: `+448${String(campaign.id % 100_000).padStart(5, "0")}${String(index).padStart(4, "0")}`,
      data: { phone: "x", first_name: `New${index}` }, status: "Valid" as const, idempotencyKey: `${slug}-new-${index}`,
    }))).returning();
    const { plan: p2 } = await planCampaign(org, campaign.id);
    assert.notEqual(p2.id, p1.id);
    assert.equal(p2.distributionMode, "equal_templates");
    const [oldPlan] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, p1.id));
    assert.equal(oldPlan!.status, "Superseded");
    const executed = await executeCampaignPlan(org, campaign.id);
    assert.equal(executed.queuedNew, 8, "only the new recipients get P2 jobs; P1's are not duplicated");

    // P2 reallocated some old recipients differently -- their P1 jobs must not follow.
    const p2Allocations = new Map((await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, p2.id))).map((a) => [a.contactId, a]));
    const moved = p1Jobs.filter((job) => p2Allocations.get(job.contactId!)!.templateId !== job.templateId);
    assert.ok(moved.length > 0, "the replan changed at least one old recipient's allocation");

    await drainWithWorker(campaign.id, 24, slug);
    const sent = log.entries();
    assert.equal(sent.length, 24);
    const to = await recipients(campaign.id);
    const nameOf = new Map(Object.values(world.templates).map((t) => [t.id, t.name]));
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    for (const job of jobs) {
      const original = p1Jobs.find((candidate) => candidate.id === job.id);
      const entry = sent.find((candidate) => candidate.payload.to === to.get(job.contactId!))!;
      const body = (entry.payload.template.components as Array<{ type: string; parameters: Array<{ text: string }> }>).find((c) => c.type === "body")!.parameters[0]!.text;
      if (original) {
        assert.equal(job.planId, p1.id, "a P1 job stays bound to P1");
        assert.equal(job.routeId, original.routeId);
        assert.equal(job.templateId, original.templateId);
        assert.equal(entry.payload.template.name, nameOf.get(original.templateId!), "P1's template, not the replanned one");
        assert.notEqual(body, "CHANGED", "P1's frozen mapping, not the live edit");
        assert.ok(original.templateId !== C!.id);
      } else {
        assert.equal(job.planId, p2.id);
        assert.ok(added.some((contact) => contact.id === job.contactId));
        assert.equal(job.templateId, p2Allocations.get(job.contactId!)!.templateId);
        assert.equal(entry.payload.template.name, nameOf.get(job.templateId!));
        assert.equal(body, job.templateId === A!.id ? "CHANGED" : `New${added.findIndex((contact) => contact.id === job.contactId)}`, "P2's frozen mapping");
      }
    }
  } finally {
    log.stop();
    await deleteOrganization(world.organization.id);
  }
});
