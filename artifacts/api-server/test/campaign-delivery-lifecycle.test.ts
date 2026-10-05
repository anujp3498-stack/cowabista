import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignJobsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  contactImportSessionsTable,
  db,
  phoneNumbersTable,
  pool,
  settlementPool,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { deleteOrganization } from "./message-studio-fixtures";
import { firstNameMappings, loadDelivery, saveDelivery, saveSetup, v2Campaign, v2World } from "./v2-fixtures";

// V2-06B Delivery setup writes: the same lifecycle lock, setup fence
// (assertSetupEditable) and Message Studio revision as every setup change;
// strict server-side rate validation; one sender lane per number after any
// distribution change. Saving never plans, executes or sends.

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); });
after(async () => { delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (name: string) => `v2dlv-${name}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;

async function campaignRow(campaignId: number) {
  const [row] = await db.select({ status: campaignsTable.status, distributionMode: campaignsTable.distributionMode, deliveryMode: campaignsTable.deliveryMode, deliverySettings: campaignsTable.deliverySettings })
    .from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  return row!;
}
async function lanes(campaignId: number) {
  return db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.campaignId, campaignId)).orderBy(asc(campaignRoutesTable.phoneNumberId));
}

/** One account: X (80/s), Y (20/s); templates A, B; a 6-recipient audience; Message setup saved WITHOUT a distribution (v1 cannot run 2 x 2? it can: X->A, Y->B). */
async function world(slug: string) {
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X", tps: 80 }, { key: "Y", tps: 20 }], templates: [{ key: "A", body: "Alpha {{1}}" }, { key: "B", body: "Bravo {{1}}" }] }] });
  const { campaign } = await v2Campaign(w.organization.id, slug, 6);
  const ids = [w.templates.A!.id, w.templates.B!.id];
  const saved = await saveSetup(w.organization.id, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id], templateIds: ids, mappings: firstNameMappings(ids) });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  return { ...w, campaign, revision: saved.body.revision as number };
}

test("Draft save: distribution + speed persist atomically, v1 routes become one lane per number, and nothing is planned or sent", async () => {
  const slug = slugFor("draft");
  const w = await world(slug);
  const org = w.organization.id;
  try {
    const before = await loadDelivery(org, w.campaign.id);
    assert.equal(before.statusCode, 200, JSON.stringify(before.body));
    assert.equal(before.body.revision, w.revision, "the Delivery step reads the shared setup revision");
    assert.equal(before.body.distributionMode, null);
    assert.equal(before.body.deliveryMode, null);
    assert.deepEqual(before.body.senders.map((s: { presetRates: unknown }) => s.presetRates), [
      { fastest_safe: 80, balanced: 48, conservative: 20 }, { fastest_safe: 20, balanced: 12, conservative: 5 },
    ], "server-computed preset rates per number");
    assert.deepEqual(before.body.modeSummaries.map((m: { totalMessagesPerSecond: number }) => m.totalMessagesPerSecond), [100, 60, 25]);
    assert.equal(before.body.recipients, 6);
    assert.deepEqual((await lanes(w.campaign.id)).map((r) => r.sharedPhoneBudget), [false, false], "v1 routes before");

    const saved = await saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "equal_templates", deliveryMode: "balanced" });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.revision, w.revision + 1, "the shared revision is bumped");
    assert.equal(saved.body.totalMessagesPerSecond, 60);
    assert.equal(saved.body.estimatedDurationSeconds, 1);
    assert.deepEqual(saved.body.senders.map((s: { plannedRate: number }) => s.plannedRate), [48, 12]);
    const row = await campaignRow(w.campaign.id);
    assert.deepEqual({ status: row.status, distributionMode: row.distributionMode, deliveryMode: row.deliveryMode }, { status: "Draft", distributionMode: "equal_templates", deliveryMode: "balanced" });
    const after = await lanes(w.campaign.id);
    assert.deepEqual(after.map((r) => [r.phoneNumberId, r.sharedPhoneBudget]), [[w.phones.X!.id, true], [w.phones.Y!.id, true]], "exactly one shared-budget lane per number");

    // Switching distribution keeps the same lanes; switching speed changes no route.
    const switched = await saveDelivery(org, w.campaign.id, { revision: saved.body.revision, distributionMode: "equal_numbers", deliveryMode: "fastest_safe" });
    assert.equal(switched.statusCode, 200);
    assert.deepEqual((await lanes(w.campaign.id)).map((r) => r.id), after.map((r) => r.id));
    assert.deepEqual((await lanes(w.campaign.id)).map((r) => r.configuredTps), after.map((r) => r.configuredTps), "rates are resolved at planning, never written onto routes");

    assert.equal((await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, w.campaign.id))).length, 0, "no plan");
    assert.equal((await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, w.campaign.id))).length, 0, "no job");
    const audit = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, w.campaign.id), eq(campaignAuditTable.action, "delivery_setup_saved")));
    assert.equal(audit.length, 2);
  } finally { await deleteOrganization(org); }
});

test("stale writes are refused both ways: a Message save makes an open Delivery tab stale, and a Delivery save makes an open Message tab stale", async () => {
  const slug = slugFor("stale");
  const w = await world(slug);
  const org = w.organization.id;
  const ids = [w.templates.A!.id, w.templates.B!.id];
  try {
    const deliveryTab = (await loadDelivery(org, w.campaign.id)).body.revision as number;
    // Another tab saves the Message step (e.g. drops sender Y).
    const message = await saveSetup(org, w.campaign.id, { revision: w.revision, senderPhoneNumberIds: [w.phones.X!.id], templateIds: ids, mappings: firstNameMappings(ids) });
    assert.equal(message.statusCode, 200);
    const stale = await saveDelivery(org, w.campaign.id, { revision: deliveryTab, distributionMode: "equal_numbers", deliveryMode: "advanced", deliverySettings: { perNumberRates: [{ phoneNumberId: w.phones.X!.id, messagesPerSecond: 10 }, { phoneNumberId: w.phones.Y!.id, messagesPerSecond: 10 }] } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.code, "stale_revision");
    assert.deepEqual(await campaignRow(w.campaign.id), { status: "Draft", distributionMode: null, deliveryMode: null, deliverySettings: null }, "nothing written");

    // The other direction.
    const fresh = await saveDelivery(org, w.campaign.id, { revision: message.body.revision, distributionMode: "equal_numbers", deliveryMode: "conservative" });
    assert.equal(fresh.statusCode, 200, JSON.stringify(fresh.body));
    const staleMessage = await saveSetup(org, w.campaign.id, { revision: message.body.revision, senderPhoneNumberIds: [w.phones.X!.id, w.phones.Y!.id], templateIds: ids, mappings: firstNameMappings(ids) });
    assert.equal(staleMessage.statusCode, 409);
    assert.equal(staleMessage.body.code, "stale_revision");
    assert.deepEqual((await lanes(w.campaign.id)).map((r) => r.phoneNumberId), [w.phones.X!.id], "the lanes the Delivery save derived are untouched");
  } finally { await deleteOrganization(org); }
});

test("advanced rates are validated server-side with clear errors and never clamped", async () => {
  const slug = slugFor("advanced");
  const w = await world(slug);
  const other = await v2World(`${slug}-o`, { wabas: [{ phones: [{ key: "Q", tps: 50 }], templates: [{ key: "Q", body: "Hey {{1}}" }] }] });
  const org = w.organization.id;
  const X = w.phones.X!.id, Y = w.phones.Y!.id;
  const put = (perNumberRates: unknown, extra: Record<string, unknown> = {}) => saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "equal_numbers", deliveryMode: "advanced", deliverySettings: { perNumberRates, ...extra } });
  try {
    const cases: Array<[string, unknown, Record<string, unknown>?]> = [
      ["zero", [{ phoneNumberId: X, messagesPerSecond: 0 }, { phoneNumberId: Y, messagesPerSecond: 5 }]],
      ["negative", [{ phoneNumberId: X, messagesPerSecond: -5 }, { phoneNumberId: Y, messagesPerSecond: 5 }]],
      ["fractional", [{ phoneNumberId: X, messagesPerSecond: 2.5 }, { phoneNumberId: Y, messagesPerSecond: 5 }]],
      ["duplicate", [{ phoneNumberId: X, messagesPerSecond: 5 }, { phoneNumberId: X, messagesPerSecond: 6 }, { phoneNumberId: Y, messagesPerSecond: 5 }]],
      ["missing selected", [{ phoneNumberId: X, messagesPerSecond: 5 }]],
      ["foreign workspace number", [{ phoneNumberId: X, messagesPerSecond: 5 }, { phoneNumberId: Y, messagesPerSecond: 5 }, { phoneNumberId: other.phones.Q!.id, messagesPerSecond: 5 }]],
      ["above ceiling", [{ phoneNumberId: X, messagesPerSecond: 200 }, { phoneNumberId: Y, messagesPerSecond: 5 }]],
      ["unknown field", [{ phoneNumberId: X, messagesPerSecond: 5 }, { phoneNumberId: Y, messagesPerSecond: 5 }], { burst: 3 }],
    ];
    for (const [label, rates, extra] of cases) {
      const res = await put(rates, extra);
      assert.equal(res.statusCode, 400, `${label}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "delivery_invalid", label);
      assert.ok(res.body.details?.length, `${label} explains what is wrong`);
    }
    const above = await put([{ phoneNumberId: X, messagesPerSecond: 200 }, { phoneNumberId: Y, messagesPerSecond: 5 }]);
    assert.ok(above.body.details.some((d: string) => /at most 80 messages\/sec/.test(d) && /80 messages\/sec or less/.test(d)), JSON.stringify(above.body.details));
    assert.deepEqual(await campaignRow(w.campaign.id), { status: "Draft", distributionMode: null, deliveryMode: null, deliverySettings: null }, "nothing written by any refused save");
    const unsupported = await saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "smart_capacity", deliveryMode: "balanced" });
    assert.equal(unsupported.statusCode, 400);
    const noSpeed = await saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "equal_numbers", deliveryMode: "turbo" });
    assert.equal(noSpeed.statusCode, 400);

    const ok = await put([{ phoneNumberId: Y, messagesPerSecond: 20 }, { phoneNumberId: X, messagesPerSecond: 80 }]);
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.senders.map((s: { plannedRate: number; advancedRate: number }) => [s.plannedRate, s.advancedRate]), [[80, 80], [20, 20]], "the exact maximum is allowed");
    // Changing to a preset keeps the advanced values (unused) when none are sent.
    const preset = await saveDelivery(org, w.campaign.id, { revision: ok.body.revision, distributionMode: "equal_numbers", deliveryMode: "fastest_safe" });
    assert.equal(preset.statusCode, 200);
    assert.equal((await campaignRow(w.campaign.id)).deliverySettings?.perNumberRates?.length, 2);
  } finally {
    await deleteOrganization(org);
    await deleteOrganization(other.organization.id);
  }
});

test("lifecycle: Ready supersedes its plan and returns to Draft; history, imports, Scheduled/Running/Paused/terminal refuse; another workspace gets 404", async () => {
  const slug = slugFor("life");
  const w = await world(slug);
  const other = await v2World(`${slug}-o`, { wabas: [{ phones: [{ key: "Q" }], templates: [{ key: "Q", body: "Hey {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const first = await saveDelivery(org, w.campaign.id, { revision: w.revision, distributionMode: "equal_numbers", deliveryMode: "balanced" });
    assert.equal(first.statusCode, 200);
    const { plan } = await planCampaign(org, w.campaign.id);
    assert.equal((await campaignRow(w.campaign.id)).status, "Ready");
    const reopened = await saveDelivery(org, w.campaign.id, { revision: first.body.revision, distributionMode: "equal_numbers", deliveryMode: "conservative" });
    assert.equal(reopened.statusCode, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.status, "Draft");
    const [old] = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.id, plan.id));
    assert.equal(old!.status, "Superseded");
    assert.equal(old!.deliveryMode, "balanced", "the frozen plan keeps its own speed");

    const [importing] = await db.insert(contactImportSessionsTable).values({ organizationId: org, campaignId: w.campaign.id, idempotencyKey: `${slug}-imp`, fileName: "more.csv", status: "Processing" }).returning();
    const duringImport = await saveDelivery(org, w.campaign.id, { revision: reopened.body.revision, distributionMode: "equal_numbers", deliveryMode: "fastest_safe" });
    assert.equal(duringImport.statusCode, 409);
    assert.equal(duringImport.body.code, "import_in_progress");
    await db.delete(contactImportSessionsTable).where(eq(contactImportSessionsTable.id, importing!.id));

    const foreign = await saveDelivery(other.organization.id, w.campaign.id, { revision: reopened.body.revision, distributionMode: "equal_numbers", deliveryMode: "fastest_safe" });
    assert.equal(foreign.statusCode, 404);
    assert.equal((await loadDelivery(other.organization.id, w.campaign.id)).statusCode, 404);

    await planCampaign(org, w.campaign.id);
    await executeCampaignPlan(org, w.campaign.id);
    for (const status of ["Running", "Paused", "Scheduled", "Completed", "Ready"]) {
      await db.update(campaignsTable).set({ status }).where(eq(campaignsTable.id, w.campaign.id));
      const view = (await loadDelivery(org, w.campaign.id)).body;
      assert.equal(view.editable, false, status);
      assert.ok(view.editBlockedReason, status);
      const refused = await saveDelivery(org, w.campaign.id, { revision: view.revision, distributionMode: "equal_templates", deliveryMode: "fastest_safe" });
      assert.equal(refused.statusCode, 409, status);
      assert.equal(refused.body.code, status === "Ready" ? "execution_history" : "setup_locked", status);
      assert.deepEqual(await campaignRow(w.campaign.id), { status, distributionMode: "equal_numbers", deliveryMode: "conservative", deliverySettings: {} }, `${status}: never reset or changed`);
    }
  } finally {
    await deleteOrganization(org);
    await deleteOrganization(other.organization.id);
  }
});

test("a Message step without numbers or templates cannot take delivery settings; a number removed from the workspace is reported", async () => {
  const slug = slugFor("incomplete");
  const w = await v2World(slug, { wabas: [{ phones: [{ key: "X" }], templates: [{ key: "A", body: "Alpha {{1}}" }] }] });
  const org = w.organization.id;
  try {
    const { campaign } = await v2Campaign(org, slug, 3);
    const empty = await saveDelivery(org, campaign.id, { revision: 0, distributionMode: "equal_numbers", deliveryMode: "balanced" });
    assert.equal(empty.statusCode, 409);
    assert.equal(empty.body.code, "message_setup_incomplete");
    assert.equal((await loadDelivery(org, campaign.id)).body.revision, 0, "the refused save left no trace");
    const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [w.phones.X!.id], templateIds: [w.templates.A!.id], mappings: firstNameMappings([w.templates.A!.id]) });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    const elsewhere = await v2World(`${slug}-x`, { wabas: [{ phones: [], templates: [] }] });
    try {
      await db.update(phoneNumbersTable).set({ organizationId: elsewhere.organization.id }).where(eq(phoneNumbersTable.id, w.phones.X!.id));
      const moved = await saveDelivery(org, campaign.id, { revision: saved.body.revision, distributionMode: "equal_numbers", deliveryMode: "balanced" });
      assert.equal(moved.statusCode, 409);
      assert.equal(moved.body.code, "message_setup_incomplete");
    } finally { await deleteOrganization(elsewhere.organization.id); }
  } finally { await deleteOrganization(org); }
});
