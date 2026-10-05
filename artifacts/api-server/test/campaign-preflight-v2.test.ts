import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignAuditTable,
  campaignJobsTable,
  campaignMediaAssetsTable,
  campaignMediaProviderBindingsTable,
  campaignMessageSetupsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  contactImportSessionsTable,
  db,
  phoneNumbersTable,
  pool,
  providerConnectionsTable,
  settlementPool,
  suppressionsTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { CampaignNotReadyError, planCampaign } from "../src/services/campaign-planning";
import { validateCampaignReady } from "../src/services/campaign-preflight";
import { setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";
import { PREFLIGHT_CATALOGUE } from "../src/services/campaign-preflight-issues";
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
import { firstNameMappings, preflight, saveDelivery, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06B structured preflight: a read-only, business-facing report whose
// blockers are the shared readiness rules Plan enforces (plus the modern
// Rocket requirements: audience, distribution, speed). For every scenario
// here: the stable code is reported, `technicalDetails.readinessErrors` is
// exactly what validateCampaignReady says, and Plan agrees (a shared-rule
// blocker refuses Plan; ready => Plan succeeds).

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); useLocalMediaStore(); });
after(async () => { setCampaignMediaStoreForTests(undefined); delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2pf-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
const codes = (issues: Array<{ code: string }>) => issues.map((issue) => issue.code).sort();

/** One account: X (80/s), Y (20/s), templates A, B; account 2: Z, template C. Message + Delivery (equal_numbers, balanced) saved. */
async function readyWorld(slug: string, contacts = 30) {
  const w = await v2World(slug, { wabas: [
    { phones: [{ key: "X", tps: 80 }, { key: "Y", tps: 20 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] },
    { phones: [{ key: "Z", tps: 30 }], templates: [{ key: "C", body: "Charlie {{1}}" }] },
  ] });
  const { campaign } = await v2Campaign(w.organization.id, slug, contacts);
  const ids = [w.templates.A!.id, w.templates.B!.id];
  const message = await saveSetup(w.organization.id, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id], templateIds: ids, mappings: firstNameMappings(ids) });
  assert.equal(message.statusCode, 200, JSON.stringify(message.body));
  const delivery = await saveDelivery(w.organization.id, campaign.id, { revision: message.body.revision, distributionMode: "equal_numbers", deliveryMode: "balanced" });
  assert.equal(delivery.statusCode, 200, JSON.stringify(delivery.body));
  return { ...w, campaign, revision: delivery.body.revision as number };
}

/** The consistency contract between the report, readiness and Plan. */
async function expectConsistent(org: number, campaignId: number, report: { ready: boolean; blockers: Array<{ code: string }>; technicalDetails: { readinessErrors: string[] } }) {
  assert.deepEqual(report.technicalDetails.readinessErrors, await validateCampaignReady(org, campaignId), "the report carries exactly the readiness strings");
  for (const issue of report.blockers) assert.ok(issue.code in PREFLIGHT_CATALOGUE, `catalogued code ${issue.code}`);
  if (report.technicalDetails.readinessErrors.length) {
    await assert.rejects(planCampaign(org, campaignId), CampaignNotReadyError, "a shared-rule blocker refuses Plan");
  }
  if (report.ready) await planCampaign(org, campaignId);
}

test("a ready campaign: counts from the active audience, real sender/template state, speed, estimate and no secrets", async () => {
  const slug = slugFor("ready");
  const w = await readyWorld(slug);
  const org = w.organization.id;
  const { X, Y } = w.phones;
  const { A, B } = w.templates;
  try {
    const res = await preflight(org, w.campaign.id);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const report = res.body;
    assert.deepEqual(report.blockers, []);
    assert.equal(report.ready, true);
    assert.deepEqual(report.recipients, { audienceGeneration: 0, total: 30, valid: 30, invalid: 0, duplicate: 0, suppressed: 0, suppressedSinceImport: 0 });
    assert.deepEqual(report.senders.map((s: Record<string, unknown>) => [s.phoneNumberId, s.setupState, s.quality, s.usable, s.providerApprovedRate, s.effectiveCeiling, s.plannedRate, s.eligibleTemplateIds]), [
      [X!.id, "active", null, true, 80, 80, 48, [A!.id, B!.id]],
      [Y!.id, "active", null, true, 20, 20, 12, [A!.id, B!.id]],
    ], "quality is unknown (null) until synced from the provider");
    assert.deepEqual(report.templates.map((t: Record<string, unknown>) => [t.templateId, t.status, t.headerKind, t.usable, t.eligibleSenderIds, t.missingVariables, t.missingColumns]), [
      [A!.id, "Approved", "none", true, [X!.id, Y!.id], [], []],
      [B!.id, "Approved", "none", true, [X!.id, Y!.id], [], []],
    ]);
    assert.deepEqual(report.distribution, { mode: "equal_numbers", allocatorVersion: "v2" });
    assert.deepEqual(report.delivery, { mode: "balanced", totalMessagesPerSecond: 60, perSender: [{ phoneNumberId: X!.id, effectiveCeiling: 80, plannedRate: 48 }, { phoneNumberId: Y!.id, effectiveCeiling: 20, plannedRate: 12 }] });
    assert.deepEqual(report.estimate, { messagesPerSecond: 60, durationSeconds: 1 });
    assert.deepEqual(report.compatibility, { valid: true, problems: [] });
    assert.deepEqual(report.provider, { mode: "mock", status: "configured", health: "unknown", ready: true });
    assert.deepEqual(report.health, { lastWebhookEventAt: null, lastProviderHealthAt: null }, "no fabricated webhook health");
    assert.equal(report.technicalDetails.platformMaxMessagesPerSecond, 1_000);
    assert.doesNotMatch(JSON.stringify(report), /token|ciphertext|providerMediaId|storageKey|secret/i);

    // Opt-outs since import and a synced low quality rating are warnings, not blockers.
    const contact = (await db.execute<{ phone: string }>(sql`select normalized_phone as phone from campaign_contacts where campaign_id = ${w.campaign.id} order by id limit 1`)).rows[0]!;
    await db.insert(suppressionsTable).values({ organizationId: org, normalizedPhone: contact.phone, reason: "STOP" });
    await db.update(phoneNumbersTable).set({ quality: "Low", lastSyncedAt: new Date() }).where(eq(phoneNumbersTable.id, Y!.id));
    const later = (await preflight(org, w.campaign.id)).body;
    assert.equal(later.ready, true);
    assert.equal(later.recipients.suppressedSinceImport, 1);
    assert.deepEqual(codes(later.warnings), ["sender_quality_low", "suppressed_skipped"]);
    assert.equal(later.senders.find((s: { phoneNumberId: number }) => s.phoneNumberId === Y!.id).quality, "Low");
    await expectConsistent(org, w.campaign.id, later);
  } finally { await deleteOrganization(org); }
});

test("a legacy (no distribution/speed) campaign: the modern report blocks with distribution_required + delivery_required while engineering Plan still works", async () => {
  const slug = slugFor("legacy");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const { campaign } = await v2Campaign(org, slug, 5);
    assert.equal((await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id], templateIds: [w.templates.A!.id], mappings: firstNameMappings([w.templates.A!.id]) })).statusCode, 200);
    const report = (await preflight(org, campaign.id)).body;
    assert.equal(report.ready, false);
    assert.deepEqual(codes(report.blockers), ["delivery_required", "distribution_required"]);
    assert.deepEqual(report.technicalDetails.readinessErrors, [], "no shared rule is violated");
    assert.deepEqual(report.distribution, { mode: null, allocatorVersion: "v1" });
    assert.deepEqual(report.estimate, { messagesPerSecond: null, durationSeconds: null }, "no speed, no estimate");
    const { plan } = await planCampaign(org, campaign.id);
    assert.equal(plan.allocatorVersion, "v1");
    assert.equal(plan.deliveryMode, null);
  } finally { await deleteOrganization(org); }
});

test("configuration problems carry stable codes and business copy, and Plan agrees with every shared-rule blocker", async () => {
  const scenarios: Array<{ name: string; mutate: (w: Awaited<ReturnType<typeof readyWorld>>) => Promise<void>; expect: string[]; check?: (report: Record<string, any>, w: Awaited<ReturnType<typeof readyWorld>>) => void }> = [
    {
      name: "mapping",
      mutate: async (w) => { await db.delete(campaignTemplateMappingsTable).where(and(eq(campaignTemplateMappingsTable.campaignId, w.campaign.id), eq(campaignTemplateMappingsTable.templateId, w.templates.B!.id))); },
      expect: ["mapping_missing"],
      check: (r, w) => assert.deepEqual(r.templates.find((t: { templateId: number }) => t.templateId === w.templates.B!.id).missingVariables, ["body:1"]),
    },
    {
      name: "column",
      mutate: async (w) => { await db.update(campaignTemplateMappingsTable).set({ sourceValue: "city" }).where(and(eq(campaignTemplateMappingsTable.campaignId, w.campaign.id), eq(campaignTemplateMappingsTable.templateId, w.templates.A!.id))); },
      expect: ["csv_column_missing"],
      check: (r, w) => {
        assert.deepEqual(r.templates.find((t: { templateId: number }) => t.templateId === w.templates.A!.id).missingColumns, ["city"]);
        assert.equal(r.blockers[0].message, 'The column "city" is not available for every recipient.');
      },
    },
    {
      name: "incompatible",
      mutate: async (w) => {
        const ids = [w.templates.A!.id, w.templates.B!.id, w.templates.C!.id];
        assert.equal((await saveSetup(w.organization.id, w.campaign.id, { revision: w.revision, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id], templateIds: ids, mappings: firstNameMappings(ids) })).statusCode, 200);
      },
      expect: ["selection_not_runnable", "template_without_sender"],
      check: (r, w) => {
        assert.equal(r.compatibility.valid, false);
        assert.ok(r.compatibility.problems.some((p: { phoneNumberId: number; templateId: number; code: string }) => p.phoneNumberId === w.phones.X!.id && p.templateId === w.templates.C!.id && p.code === "waba_mismatch"));
        assert.ok(r.blockers.some((b: { message: string }) => b.message === "No selected number can send tpl_c."));
      },
    },
    {
      name: "sender",
      mutate: async (w) => { await db.update(phoneNumbersTable).set({ status: "Disconnected" }).where(eq(phoneNumbersTable.id, w.phones.Y!.id)); },
      // The lane cannot send, and the saved selection is no longer runnable.
      expect: ["selection_not_runnable", "sender_unusable"],
      check: (r, w) => {
        assert.equal(r.senders.find((s: { phoneNumberId: number }) => s.phoneNumberId === w.phones.Y!.id).usable, false);
        assert.equal(r.blockers[0].message, "Sender Y cannot send right now.");
      },
    },
    {
      name: "ceiling",
      mutate: async (w) => {
        const saved = await saveDelivery(w.organization.id, w.campaign.id, { revision: w.revision, distributionMode: "equal_numbers", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: w.phones.X!.id, messagesPerSecond: 80 }, { phoneNumberId: w.phones.Y!.id, messagesPerSecond: 20 }] } });
        assert.equal(saved.statusCode, 200);
        await db.update(phoneNumbersTable).set({ tpsLimit: 10 }).where(eq(phoneNumbersTable.id, w.phones.Y!.id));
      },
      expect: ["rate_above_ceiling"],
      check: (r) => {
        assert.equal(r.blockers[0].message, "Sender Y can send at most 10 messages/sec.");
        assert.equal(r.blockers[0].action, "Set its speed to 10 messages/sec or less.");
        assert.deepEqual(r.estimate, { messagesPerSecond: null, durationSeconds: null });
      },
    },
    {
      name: "advanced-missing",
      mutate: async (w) => {
        const saved = await saveDelivery(w.organization.id, w.campaign.id, { revision: w.revision, distributionMode: "equal_numbers", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: w.phones.X!.id, messagesPerSecond: 8 }, { phoneNumberId: w.phones.Y!.id, messagesPerSecond: 2 }] } });
        assert.equal(saved.statusCode, 200);
        // A third number of the same account is added in the Message step afterwards.
        const [extra] = await db.insert(phoneNumbersTable).values({ organizationId: w.organization.id, wabaId: w.phones.X!.wabaId, providerPhoneId: `pp-extra-${w.campaign.id}`, phone: `+17779${w.campaign.id}`, displayName: "Sender W", status: "Connected", setupState: "active", tpsLimit: 40 }).returning();
        const ids = [w.templates.A!.id, w.templates.B!.id];
        assert.equal((await saveSetup(w.organization.id, w.campaign.id, { revision: saved.body.revision, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id, extra!.id], templateIds: ids, mappings: firstNameMappings(ids) })).statusCode, 200);
      },
      expect: ["advanced_rate_missing"],
      check: (r) => assert.equal(r.blockers[0].message, "Set a speed for Sender W."),
    },
    {
      name: "import",
      mutate: async (w) => { await db.insert(contactImportSessionsTable).values({ organizationId: w.organization.id, campaignId: w.campaign.id, idempotencyKey: `imp-${w.campaign.id}`, fileName: "more.csv", status: "Processing" }); },
      expect: ["import_in_progress"],
    },
  ];
  for (const scenario of scenarios) {
    const slug = slugFor(scenario.name);
    const w = await readyWorld(slug);
    try {
      await scenario.mutate(w);
      const report = (await preflight(w.organization.id, w.campaign.id)).body;
      assert.equal(report.ready, false, scenario.name);
      assert.deepEqual([...new Set(codes(report.blockers))], scenario.expect, `${scenario.name}: ${JSON.stringify(report.blockers)}`);
      for (const issue of report.blockers) {
        assert.equal(issue.severity, "blocker");
        assert.ok(issue.message && issue.action, `${scenario.name} has business copy`);
      }
      scenario.check?.(report, w);
      if (scenario.name === "import") await assert.rejects(planCampaign(w.organization.id, w.campaign.id), CampaignNotReadyError, "Plan refuses during an import too");
      else await expectConsistent(w.organization.id, w.campaign.id, report);
    } finally { await deleteOrganization(w.organization.id); }
  }

  // An empty audience.
  const slug = slugFor("empty");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  try {
    const { campaign } = await v2Campaign(w.organization.id, slug, 0);
    const empty = (await preflight(w.organization.id, campaign.id)).body;
    assert.ok(codes(empty.blockers).includes("audience_empty"));
    assert.ok(codes(empty.blockers).includes("no_senders") && codes(empty.blockers).includes("no_templates"));
    assert.equal((await preflight(w.organization.id + 100_000, campaign.id)).statusCode, 404, "another workspace gets 404");
  } finally { await deleteOrganization(w.organization.id); }
});

const base = "/organizations/:organizationId/campaigns/:campaignId";
const upload = findRouteHandler(messageStudioRouter, `${base}/media`, "post");

test("media and credential checks are read-only; preflight creates nothing and calls no provider, however often it is read", async () => {
  const slug = slugFor("media");
  const graph = await startFakeGraph();
  const w = await workspaceWorld(slug, { phones: 2, templates: [{ name: "img_a", body: "Hi {{1}}", components: HEADER_IMAGE("Hi {{1}}") }, { name: "text_b", body: "Text {{1}}" }] });
  const org = w.organization.id;
  try {
    const campaign = await createCampaign(org, slug);
    await seedAudience(org, campaign.id, ["phone", "first_name"], Array.from({ length: 8 }, (_, i) => ({ phone: `+4477336${String(i).padStart(5, "0")}`, first_name: `P${i}` })));
    const uploadRes = fakeResponse();
    await upload(streamRequest(PNG, { params: { organizationId: String(org), campaignId: String(campaign.id) }, headers: { "x-file-name": "banner.png", "content-type": "image/png" }, authUser: {} }), uploadRes);
    const asset = uploadRes.body;
    const [a, b] = w.templates;
    const message = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: w.phones.map((p) => p.id), templateIds: [a!.id, b!.id], mappings: [
      { templateId: a!.id, component: "header", variable: "media", source: "media_asset", sourceValue: String(asset.id), mediaAssetId: asset.id }, ...firstNameMappings([a!.id, b!.id]),
    ] });
    assert.equal(message.statusCode, 200, JSON.stringify(message.body));
    assert.equal((await saveDelivery(org, campaign.id, { revision: message.body.revision, distributionMode: "equal_templates", deliveryMode: "fastest_safe" })).statusCode, 200);

    const snapshot = async () => {
      const count = async (table: typeof campaignPlansTable | typeof campaignAllocationsTable | typeof campaignJobsTable | typeof campaignRoutesTable | typeof campaignAuditTable) =>
        (await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.campaignId, campaign.id)))[0]!.n;
      return {
        plans: await count(campaignPlansTable), allocations: await count(campaignAllocationsTable), jobs: await count(campaignJobsTable),
        routes: JSON.stringify(await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaign.id)).orderBy(campaignRoutesTable.id)),
        audit: await count(campaignAuditTable),
        bindings: (await db.select({ n: sql<number>`count(*)::int` }).from(campaignMediaProviderBindingsTable).where(eq(campaignMediaProviderBindingsTable.organizationId, org)))[0]!.n,
        campaign: JSON.stringify(await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id))),
        setup: JSON.stringify(await db.select().from(campaignMessageSetupsTable).where(eq(campaignMessageSetupsTable.campaignId, campaign.id))),
        connections: (await db.select({ n: sql<number>`count(*)::int` }).from(providerConnectionsTable).where(eq(providerConnectionsTable.organizationId, org)))[0]!.n,
        providerRequests: graph.requests.length,
      };
    };
    const before = await snapshot();
    let report: Record<string, any> = {};
    for (let i = 0; i < 3; i++) report = (await preflight(org, campaign.id)).body;
    assert.deepEqual(await snapshot(), before, "no plan, allocation, job, route change, audit row, provider binding, connection row or provider request");
    assert.equal(report.ready, true, JSON.stringify(report.blockers));
    assert.deepEqual(report.media, [{ templateId: a!.id, mediaAssetId: asset.id, fileName: "banner.png", kind: "image", expectedKind: "image", status: "ready", ok: true, providerPrepared: false }], "not prepared yet is not a blocker (Plan prepares it)");

    // Plan prepares the per-number copies; the report then shows them as prepared, without their ids.
    await planCampaign(org, campaign.id);
    const bindings = await db.select().from(campaignMediaProviderBindingsTable).where(eq(campaignMediaProviderBindingsTable.mediaAssetId, asset.id));
    assert.equal(bindings.length, 2);
    const prepared = (await preflight(org, campaign.id)).body;
    assert.equal(prepared.media[0].providerPrepared, true);
    for (const binding of bindings) assert.ok(!JSON.stringify(prepared).includes(binding.providerMediaId));
    assert.ok(!JSON.stringify(prepared).includes(TOKEN));

    // A file of the wrong kind, then a missing file.
    await db.update(campaignMediaAssetsTable).set({ kind: "video" }).where(eq(campaignMediaAssetsTable.id, asset.id));
    const wrong = (await preflight(org, campaign.id)).body;
    assert.deepEqual([...new Set(codes(wrong.blockers))], ["media_wrong_kind"]);
    assert.equal(wrong.media[0].ok, false);
    await expectConsistent(org, campaign.id, wrong);
    await db.update(campaignMediaAssetsTable).set({ kind: "image", status: "deleted" }).where(eq(campaignMediaAssetsTable.id, asset.id));
    const missing = (await preflight(org, campaign.id)).body;
    assert.deepEqual([...new Set(codes(missing.blockers))], ["media_missing"]);
    await expectConsistent(org, campaign.id, missing);
    await db.update(campaignMediaAssetsTable).set({ status: "ready" }).where(eq(campaignMediaAssetsTable.id, asset.id));

    // The workspace credential is revoked: sending is impossible -> a blocker, never a warning.
    await db.update(whatsappCredentialsTable).set({ status: "revoked" }).where(eq(whatsappCredentialsTable.id, w.credential.id));
    const revoked = (await preflight(org, campaign.id)).body;
    assert.ok(codes(revoked.blockers).includes("credential_not_ready"), JSON.stringify(revoked.blockers));
    assert.equal(revoked.provider.ready, false);
    await expectConsistent(org, campaign.id, revoked);
  } finally {
    await graph.close();
    await deleteOrganization(org);
  }
});
