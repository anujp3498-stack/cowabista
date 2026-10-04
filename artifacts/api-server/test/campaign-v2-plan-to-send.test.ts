import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { after, before, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignMediaProviderBindingsTable,
  campaignPlansTable,
  campaignRoutesTable,
  db,
  pool,
  settlementPool,
} from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { previewPlanContact } from "../src/services/campaign-plan-preview";
import { previewMessage } from "../src/services/message-studio";
import { setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";
import {
  createCampaign,
  deleteOrganization,
  fakeResponse,
  findRouteHandler,
  HEADER_IMAGE,
  PNG,
  seedAudience,
  startFakeGraph,
  streamRequest,
  TOKEN,
  useLocalMediaStore,
  workspaceWorld,
} from "./message-studio-fixtures";
import { drainWithWorker, expectedBodyPayload, firstNameMappings, mockProviderId, providerLog, saveSetup, v2Campaign, v2World, type ProviderLogEntry } from "./v2-fixtures";

// V2-06A Plan -> Send fidelity for allocator v2, through the REAL chain:
// Message Studio save -> plan (allocator v2) -> execute -> the production
// CampaignWorker claims -> resolveJobTemplate -> WhatsAppTemplateSender ->
// provider. For every job: allocation == job == resolver == plan preview ==
// Message Studio preview == the provider payload actually sent (exact bytes
// and the deterministic mock message id). Local/mock provider (in-process
// deterministic double) or a fake Graph server on 127.0.0.1; nothing leaves
// the process and no real token is used.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { setCampaignMediaStoreForTests(undefined); delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2send-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
const logPath = (name: string) => path.join(os.tmpdir(), `v2-provider-${name}-${process.pid}-${Date.now()}.log`);

type World = Awaited<ReturnType<typeof v2World>>;

/** Asserts the full fidelity chain for every job of the campaign; returns the per-job evidence. */
async function assertFidelity(world: World, campaignId: number, sent: ProviderLogEntry[]) {
  const org = world.organization.id;
  const phoneById = new Map(Object.values(world.phones).map((p) => [p.id, p]));
  const templateById = new Map(Object.values(world.templates).map((t) => [t.id, t]));
  const [plan] = await db.select().from(campaignPlansTable).where(and(eq(campaignPlansTable.campaignId, campaignId), eq(campaignPlansTable.status, "Active")));
  const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId)).orderBy(asc(campaignJobsTable.id));
  const allocations = new Map((await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, plan!.id))).map((a) => [a.contactId, a]));
  const contacts = new Map((await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaignId))).map((c) => [c.id, c]));
  assert.equal(sent.length, jobs.length, "exactly one provider send per job (no duplicate, no extra)");
  assert.equal(new Set(sent.map((entry) => entry.payload.to)).size, jobs.length, "one send per recipient");
  const evidence: Array<{ phoneNumberId: number; templateId: number; routeId: number }> = [];
  for (const job of jobs) {
    const allocation = allocations.get(job.contactId!)!;
    const contact = contacts.get(job.contactId!)!;
    const payload = job.payload as { templateId: number; resolvedParameters: Record<string, Record<string, string>>; providerMessageId: string };
    assert.equal(job.status, "Sent");
    assert.equal(job.idempotencyKey, `send:${contact.idempotencyKey}`, "the execute idempotency key is the v1 contract (recipient-scoped, not template-scoped)");
    // allocation == job
    assert.equal(job.planId, plan!.id);
    assert.equal(job.routeId, allocation.routeId);
    assert.equal(job.templateId, allocation.templateId, "execute copied the allocated template onto the job");
    // job == resolver
    assert.equal(payload.templateId, job.templateId, "the resolver used the job's template (v2 precedence)");
    // == plan preview (support view) and Message Studio preview (same resolver)
    const planPreview = await previewPlanContact(org, campaignId, { contactId: contact.id });
    assert.deepEqual({ routeId: planPreview.routeId, phoneNumberId: planPreview.phoneNumberId, templateId: planPreview.templateId }, { routeId: allocation.routeId, phoneNumberId: allocation.phoneNumberId, templateId: allocation.templateId });
    assert.deepEqual(planPreview.resolvedParameters, payload.resolvedParameters);
    const studio = await previewMessage({ organizationId: org, campaignId, templateId: job.templateId!, contactId: contact.id });
    assert.deepEqual(studio.resolved, { header: payload.resolvedParameters.header, body: payload.resolvedParameters.body, button: payload.resolvedParameters.button });
    // == the provider payload actually sent, from the allocated number, with the exact mock id
    const phone = phoneById.get(allocation.phoneNumberId)!;
    const template = templateById.get(allocation.templateId!)!;
    const expected = expectedBodyPayload(contact.normalizedPhone!, template.name, (contact.data as Record<string, string>).first_name!);
    const entries = sent.filter((entry) => entry.payload.to === contact.normalizedPhone);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.phoneId, phone.providerPhoneId, "sent by the allocated number");
    assert.deepEqual(entries[0]!.payload, expected);
    assert.equal(payload.providerMessageId, mockProviderId(phone.providerPhoneId!, expected));
    evidence.push({ phoneNumberId: allocation.phoneNumberId, templateId: allocation.templateId!, routeId: allocation.routeId });
  }
  return evidence;
}

async function setUpAndExecute(world: World, slug: string, contacts: number, senders: string[], templates: string[], distributionMode: string) {
  const org = world.organization.id;
  const { campaign } = await v2Campaign(org, slug, contacts);
  const templateIds = templates.map((key) => world.templates[key]!.id);
  const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: senders.map((key) => world.phones[key]!.id), templateIds, mappings: firstNameMappings(templateIds), distributionMode });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  const { plan } = await planCampaign(org, campaign.id);
  const executed = await executeCampaignPlan(org, campaign.id);
  assert.equal(executed.queuedNew, contacts);
  return { campaign, plan };
}

test("PRIMARY 1 number x 3 templates (equal by numbers): ONE sender lane, all three templates allocated, queued and sent exactly as frozen", async () => {
  const slug = slugFor("1x3");
  const log = providerLog(logPath("1x3"));
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: 50 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }, { key: "C", body: "Charlie {{1}}" }] }] });
  try {
    const { campaign, plan } = await setUpAndExecute(world, slug, 30, ["X"], ["A", "B", "C"], "equal_numbers");
    const routes = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id));
    assert.equal(routes.length, 1, "exactly one v2 sender route");
    assert.equal(routes[0]!.sharedPhoneBudget, true);
    assert.equal(plan.allocatorVersion, "v2");
    assert.equal(plan.routes.length, 1);
    const allocations = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.planId, plan.id));
    const templateIds = Object.values(world.templates).map((t) => t.id).sort((a, b) => a - b);
    assert.deepEqual([...new Set(allocations.map((a) => a.templateId))].sort((a, b) => a! - b!), templateIds, "all 3 templates appear in allocations");
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.deepEqual([...new Set(jobs.map((j) => j.templateId))].sort((a, b) => a! - b!), templateIds, "all 3 templates appear in jobs");
    assert.deepEqual([...new Set(jobs.map((j) => j.routeId))], [routes[0]!.id], "every job is on the one lane");
    assert.deepEqual([...new Set(jobs.map((j) => j.configuredTps))], [50], "the lane's budget is the number's 50/s, not 3 x 50");

    // Execute is idempotent: a second execute queues nothing new.
    const again = await executeCampaignPlan(world.organization.id, campaign.id);
    assert.equal(again.queuedNew, 0);
    assert.equal((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id))).length, 30);

    await drainWithWorker(campaign.id, 30, slug);
    const evidence = await assertFidelity(world, campaign.id, log.entries());
    assert.deepEqual([...new Set(evidence.map((e) => e.templateId))].sort((a, b) => a - b), templateIds, "the provider received all 3 templates from the one number");
  } finally {
    log.stop();
    await deleteOrganization(world.organization.id);
  }
});

test("PRIMARY 3 numbers x 1 template: three lanes, every number sends the one template", async () => {
  const slug = slugFor("3x1");
  const log = providerLog(logPath("3x1"));
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X" }, { key: "Y" }, { key: "Z" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  try {
    const { campaign, plan } = await setUpAndExecute(world, slug, 30, ["X", "Y", "Z"], ["A"], "equal_numbers");
    assert.equal(plan.routes.length, 3);
    assert.ok(plan.routes.every((route) => route.sharedPhoneBudget && route.templateId === world.templates.A!.id));
    await drainWithWorker(campaign.id, 30, slug);
    const evidence = await assertFidelity(world, campaign.id, log.entries());
    assert.deepEqual([...new Set(evidence.map((e) => e.templateId))], [world.templates.A!.id]);
    const perSender = Object.values(world.phones).map((p) => evidence.filter((e) => e.phoneNumberId === p.id).length);
    assert.ok(perSender.every((count) => count > 0), `every number sends: ${perSender.join("/")}`);
    assert.equal(perSender.reduce((a, b) => a + b, 0), 30);
  } finally {
    log.stop();
    await deleteOrganization(world.organization.id);
  }
});

for (const mode of ["equal_numbers", "equal_templates"] as const) {
  test(`mixed 3 x 3 (${mode}): every send is a V2-04 eligible pair, exactly as allocated`, async () => {
    const slug = slugFor(`3x3-${mode}`);
    const log = providerLog(logPath(`3x3-${mode}`));
    // X, Y on account 1 (A, B); Z on account 2 (C): Z never sends A/B, X/Y never send C.
    const world = await v2World(slug, { wabas: [
      { phones: [{ key: "X", tps: 10 }, { key: "Y", tps: 20 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] },
      { phones: [{ key: "Z", tps: 30 }], templates: [{ key: "C", body: "Charlie {{1}}" }] },
    ] });
    const { X, Y, Z } = world.phones;
    const { A, B, C } = world.templates;
    const eligible = new Set([`${X!.id}:${A!.id}`, `${X!.id}:${B!.id}`, `${Y!.id}:${A!.id}`, `${Y!.id}:${B!.id}`, `${Z!.id}:${C!.id}`]);
    try {
      const { campaign, plan } = await setUpAndExecute(world, slug, 45, ["X", "Y", "Z"], ["A", "B", "C"], mode);
      assert.equal(plan.distributionMode, mode);
      assert.equal(plan.routes.length, 3);
      await drainWithWorker(campaign.id, 45, slug);
      const evidence = await assertFidelity(world, campaign.id, log.entries());
      const pairs = new Set(evidence.map((e) => `${e.phoneNumberId}:${e.templateId}`));
      for (const pair of pairs) assert.ok(eligible.has(pair), `ineligible pair sent: ${pair}`);
      assert.deepEqual([...pairs].sort(), [...eligible].sort(), "every eligible pair was used (deterministic for this audience)");
      // Each lane's jobs carry the lane's own frozen budget.
      const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
      for (const route of plan.routes) assert.ok(jobs.filter((j) => j.routeId === route.routeId).every((j) => j.configuredTps === route.configuredTps));
    } finally {
      log.stop();
      await deleteOrganization(world.organization.id);
    }
  });
}

test("the shared sender budget is the number's ONE rate: three templates on one number never send faster than its configured TPS", async () => {
  const slug = slugFor("budget");
  const log = providerLog(logPath("budget"));
  const RATE = 3;
  const N = 12;
  const world = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: RATE }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }, { key: "C", body: "Charlie {{1}}" }] }] });
  try {
    const { campaign, plan } = await setUpAndExecute(world, slug, N, ["X"], ["A", "B", "C"], "equal_numbers");
    assert.equal(plan.routes.length, 1, "one pacing lane for the number");
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(new Set(jobs.map((j) => j.templateId)).size, 3, "the jobs span all three templates");
    assert.ok(jobs.every((j) => j.configuredTps === RATE && j.routeId === plan.routes[0]!.routeId));
    await drainWithWorker(campaign.id, N, slug, 90_000);
    const times = log.entries().map((entry) => entry.at).sort((a, b) => a - b);
    assert.equal(times.length, N);
    const span = times[N - 1]! - times[0]!;
    // At RATE/s the N sends need >= (N - 1) / RATE seconds; three separate
    // per-template budgets would finish in about a third of that.
    const floor = ((N - 1) / RATE) * 1000 * 0.75;
    assert.ok(span >= floor, `${N} sends spanned ${span}ms; a single ${RATE}/s budget needs >= ${floor}ms`);
    let densest = 0;
    for (let i = 0; i < times.length; i++) densest = Math.max(densest, times.filter((t) => t >= times[i]! && t < times[i]! + 1000).length);
    assert.ok(densest <= RATE + 1, `at most ${RATE} (+1 at a window edge) sends in any one-second window; saw ${densest}`);
    await assertFidelity(world, campaign.id, log.entries());
    console.log(JSON.stringify({ sharedBudget: { rate: RATE, sends: N, spanMs: span, densestOneSecondWindow: densest } }));
  } finally {
    log.stop();
    await deleteOrganization(world.organization.id);
  }
});

const base = "/organizations/:organizationId/campaigns/:campaignId";
const upload = findRouteHandler(messageStudioRouter, `${base}/media`, "post");

test("multi-template media on one sender: one binding per number+asset serves both image templates; each number sends its OWN provider media id", async () => {
  const slug = slugFor("imgs");
  useLocalMediaStore();
  const graph = await startFakeGraph();
  const world = await workspaceWorld(slug, { phones: 2, templates: [
    { name: "img_a", body: "Hi {{1}}", components: HEADER_IMAGE("Hi {{1}}") },
    { name: "img_b", body: "Yo {{1}}", components: HEADER_IMAGE("Yo {{1}}") },
    { name: "text_c", body: "Text {{1}}" },
  ] });
  const org = world.organization.id;
  try {
    const campaign = await createCampaign(org, slug);
    const people = Array.from({ length: 24 }, (_, index) => ({ phone: `+4477118${String(index).padStart(5, "0")}`, first_name: `M${index}` }));
    await seedAudience(org, campaign.id, ["phone", "first_name"], people);
    const uploadRes = fakeResponse();
    await upload(streamRequest(PNG, { params: { organizationId: String(org), campaignId: String(campaign.id) }, headers: { "x-file-name": "banner.png", "content-type": "image/png" }, authUser: {} }), uploadRes);
    assert.equal(uploadRes.statusCode, 201, JSON.stringify(uploadRes.body));
    const asset = uploadRes.body;
    const [a, b, c] = world.templates;
    const media = (templateId: number) => ({ templateId, component: "header", variable: "media", source: "media_asset", sourceValue: String(asset.id), mediaAssetId: asset.id });
    const saved = await saveSetup(org, campaign.id, {
      revision: 0, senderPhoneNumberIds: world.phones.map((p) => p.id), templateIds: [a!.id, b!.id, c!.id], distributionMode: "equal_numbers",
      mappings: [media(a!.id), media(b!.id), ...firstNameMappings([a!.id, b!.id, c!.id])],
    });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));

    const { plan } = await planCampaign(org, campaign.id);
    const uploads = graph.requests.filter((r) => r.url.endsWith("/media"));
    assert.equal(uploads.length, 2, "one provider upload per number for the shared asset (not one per template pair)");
    const bindings = await db.select().from(campaignMediaProviderBindingsTable).where(eq(campaignMediaProviderBindingsTable.mediaAssetId, asset.id));
    assert.equal(bindings.length, 2);
    assert.deepEqual(new Set(bindings.map((binding) => binding.phoneNumberId)), new Set(world.phones.map((p) => p.id)));
    assert.notEqual(bindings[0]!.providerMediaId, bindings[1]!.providerMediaId, "media ids are per number");
    const planText = JSON.stringify(plan);
    for (const binding of bindings) assert.ok(!planText.includes(JSON.stringify(binding.providerMediaId)), "no provider media id in the frozen plan");
    assert.ok(!planText.includes(TOKEN));

    await executeCampaignPlan(org, campaign.id);
    await drainWithWorker(campaign.id, 24, slug);
    const messages = graph.requests.filter((r) => r.url.endsWith("/messages"));
    assert.equal(messages.length, 24, "one provider request per job");
    const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    const routes = new Map(plan.routes.map((route) => [route.routeId, route]));
    const phoneById = new Map(world.phones.map((p) => [p.id, p]));
    const templateById = new Map(world.templates.map((t) => [t.id, t]));
    const imageTemplatesBySender = new Map<number, Set<number>>();
    for (const job of jobs) {
      const contact = (await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.id, job.contactId!)))[0]!;
      const phoneNumberId = routes.get(job.routeId!)!.phoneNumberId;
      const phone = phoneById.get(phoneNumberId)!;
      const requests = messages.filter((r) => JSON.parse(r.body.toString()).to === contact.normalizedPhone);
      assert.equal(requests.length, 1);
      const request = requests[0]!;
      assert.equal(request.url, `/v23.0/${phone.providerPhoneId}/messages`, "sent from the allocated number");
      assert.equal(request.authorization, `Bearer ${TOKEN}`, "the token travels only in the Authorization header");
      const body = JSON.parse(request.body.toString()) as { template: { name: string; components: Array<{ type: string; parameters: Array<Record<string, unknown>> }> } };
      assert.equal(body.template.name, templateById.get(job.templateId!)!.name, "the job's template, as allocated");
      const header = body.template.components.find((component) => component.type === "header");
      if (job.templateId === c!.id) {
        assert.equal(header, undefined);
      } else {
        const binding = bindings.find((candidate) => candidate.phoneNumberId === phoneNumberId)!;
        assert.deepEqual(header!.parameters, [{ type: "image", image: { id: binding.providerMediaId } }], "THIS number's provider media id");
        imageTemplatesBySender.set(phoneNumberId, (imageTemplatesBySender.get(phoneNumberId) ?? new Set()).add(job.templateId!));
      }
      assert.deepEqual(body.template.components.find((component) => component.type === "body")!.parameters, [{ type: "text", text: (contact.data as Record<string, string>).first_name }]);
    }
    assert.ok([...imageTemplatesBySender.values()].some((templates) => templates.size === 2), "one number sent BOTH image templates with its one binding");
    assert.ok(!JSON.stringify(jobs).includes(TOKEN));
  } finally {
    await graph.close();
    await deleteOrganization(org);
  }
});
