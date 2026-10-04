import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import templatesRouter from "../src/routes/templates";

// V2-03A hardening: approval status always comes from Meta. The generic
// template CRUD can neither set it nor rewrite a synchronised template's
// provider fields; only local rows are editable, and only their local fields.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handler(path: string, method: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (templatesRouter as any).stack) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler for ${method} ${path}`);
}
function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.send = () => res;
  return res;
}

after(async () => {
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("POST /templates ignores any status the caller sends: a local template is always Pending and marked local", async () => {
  const slug = `tpl-route-create-${process.pid}-${Date.now()}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  try {
    const res = fakeResponse();
    await handler("/templates", "post")({ organizationId: org.id, role: "manager", body: { name: "local_one", body: "Hi {{1}}", status: "Approved", providerTemplateId: "forged", isSample: false, metadata: { source: "workspace_credential" } } }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, "Pending");
    assert.equal(res.body.providerTemplateId, null);
    assert.equal(res.body.source, "local");
    const [row] = await db.select().from(templatesTable).where(eq(templatesTable.id, res.body.id));
    assert.equal(row.status, "Pending");
    assert.equal(row.providerTemplateId, null);
    assert.deepEqual(row.metadata, { source: "local" });
  } finally { await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)); }
});

test("PATCH /templates/:id cannot approve, and cannot touch a synchronised template's provider fields; local fields on a local row still work", async () => {
  const slug = `tpl-route-patch-${process.pid}-${Date.now()}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  try {
    const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `w-${slug}`, displayName: "W" }).returning();
    const components = [{ type: "BODY", text: "Synced {{1}}" }];
    const [synced] = await db.insert(templatesTable).values({
      organizationId: org.id, wabaId: waba.id, providerTemplateId: `p-${slug}`, name: "synced_tpl", body: "Synced {{1}}", status: "Pending",
      language: "en_US", category: "Marketing", components, metadata: { source: "workspace_credential", providerStatus: "PENDING" },
    }).returning();
    const [legacy] = await db.insert(templatesTable).values({
      organizationId: org.id, wabaId: waba.id, providerTemplateId: null, name: "legacy_synced", body: "L", status: "Rejected", metadata: { provider: "whatsapp-business" },
    }).returning();
    const [local] = await db.insert(templatesTable).values({ organizationId: org.id, name: "local_tpl", body: "Local {{1}}", status: "Pending", metadata: { source: "local" } }).returning();
    const patch = handler("/templates/:templateId", "patch");

    // Status is not part of the contract: it is dropped even on a local row.
    let res = fakeResponse();
    await patch({ organizationId: org.id, role: "manager", params: { templateId: String(local.id) }, body: { status: "Approved" } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "Pending");
    assert.equal((await db.select().from(templatesTable).where(eq(templatesTable.id, local.id)))[0]!.status, "Pending");

    // Local fields on a local row are fine.
    res = fakeResponse();
    await patch({ organizationId: org.id, role: "manager", params: { templateId: String(local.id) }, body: { name: "local_renamed", body: "Local {{1}} {{2}}", language: "hi", category: "Utility" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.name, "local_renamed");
    assert.equal(res.body.language, "hi");

    // A synchronised row (provider id) and a legacy-synced row (metadata only) are read-only.
    for (const row of [synced, legacy]) {
      res = fakeResponse();
      await patch({ organizationId: org.id, role: "owner", params: { templateId: String(row.id) }, body: { name: "renamed", body: "changed", status: "Approved", language: "fr", category: "Utility" } }, res);
      assert.equal(res.statusCode, 409, JSON.stringify(res.body));
      const [after] = await db.select().from(templatesTable).where(eq(templatesTable.id, row.id));
      assert.equal(after.name, row.name);
      assert.equal(after.body, row.body);
      assert.equal(after.status, row.status);
      assert.equal(after.language, row.language);
      assert.deepEqual(after.components, row.components, "the provider components snapshot is untouched");
      assert.deepEqual(after.metadata, row.metadata);
    }
  } finally { await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)); }
});

test("cross-tenant: another workspace's synced template is not found, and no response carries provider secrets", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const [a] = await db.insert(organizationsTable).values({ name: `tpl-a-${stamp}`, slug: `tpl-a-${stamp}` }).returning();
  const [b] = await db.insert(organizationsTable).values({ name: `tpl-b-${stamp}`, slug: `tpl-b-${stamp}` }).returning();
  try {
    const [foreign] = await db.insert(templatesTable).values({ organizationId: b.id, providerTemplateId: `p-${stamp}`, name: "b_tpl", body: "B", status: "Approved", metadata: { source: "workspace_credential", credentialId: 123 } }).returning();
    const res = fakeResponse();
    await handler("/templates/:templateId", "patch")({ organizationId: a.id, role: "owner", params: { templateId: String(foreign.id) }, body: { name: "stolen" } }, res);
    assert.equal(res.statusCode, 404);
    const list = fakeResponse();
    await handler("/templates", "get")({ organizationId: a.id, query: {} }, list);
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.some((row: { id: number }) => row.id === foreign.id), "org A never sees org B's template");
    const listB = fakeResponse();
    await handler("/templates", "get")({ organizationId: b.id, query: {} }, listB);
    const text = JSON.stringify(listB.body);
    assert.ok(!/tokenCiphertext|accessToken|tokenIv|tokenAuthTag/.test(text));
    assert.equal(listB.body[0].source, "workspace_credential");
    assert.equal((await db.select().from(templatesTable).where(eq(templatesTable.id, foreign.id)))[0]!.name, "b_tpl");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, a.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, b.id));
  }
});

// ---- V2-03A.2: deletion and atomic PATCH -------------------------------

async function lockWaitOn(table: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike ${`%${table}%`}
    `);
    if (Number(waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`no backend waited on a ${table} lock`);
}

test("DELETE: synced and legacy-synced templates answer 409 and lose nothing; cross-tenant answers 404", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const [org] = await db.insert(organizationsTable).values({ name: `del-a-${stamp}`, slug: `del-a-${stamp}` }).returning();
  const [other] = await db.insert(organizationsTable).values({ name: `del-b-${stamp}`, slug: `del-b-${stamp}` }).returning();
  try {
    const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `w-${stamp}`, displayName: "W" }).returning();
    const [synced] = await db.insert(templatesTable).values({ organizationId: org.id, wabaId: waba.id, providerTemplateId: `p-${stamp}`, name: "synced", body: "S", status: "Approved", metadata: { source: "workspace_credential" } }).returning();
    const [legacy] = await db.insert(templatesTable).values({ organizationId: org.id, wabaId: waba.id, name: "legacy", body: "L", status: "Approved", metadata: { provider: "whatsapp-business" } }).returning();
    const [campaign] = await db.insert(campaignsTable).values({ organizationId: org.id, name: "c", status: "Draft" }).returning();
    await db.insert(campaignTemplateSelectionsTable).values({ organizationId: org.id, campaignId: campaign.id, templateId: synced.id });
    const del = handler("/templates/:templateId", "delete");
    for (const row of [synced, legacy]) {
      const res = fakeResponse();
      await del({ organizationId: org.id, role: "owner", params: { templateId: String(row.id) } }, res);
      assert.equal(res.statusCode, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, "provider_backed");
      assert.ok((await db.select().from(templatesTable).where(eq(templatesTable.id, row.id))).length === 1);
    }
    assert.equal((await db.select().from(campaignTemplateSelectionsTable).where(eq(campaignTemplateSelectionsTable.campaignId, campaign.id))).length, 1, "the selection survived");
    const foreign = fakeResponse();
    await del({ organizationId: other.id, role: "owner", params: { templateId: String(synced.id) } }, foreign);
    assert.equal(foreign.statusCode, 404);
    assert.equal((await db.select().from(templatesTable).where(eq(templatesTable.id, synced.id))).length, 1);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, other.id));
  }
});

test("DELETE: a referenced local template (selection, mapping or route) answers 409 with the reference counts; an unreferenced local one is deleted", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const [org] = await db.insert(organizationsTable).values({ name: `del-ref-${stamp}`, slug: `del-ref-${stamp}` }).returning();
  try {
    const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: `w-${stamp}`, displayName: "W" }).returning();
    const [phone] = await db.insert(phoneNumbersTable).values({ organizationId: org.id, wabaId: waba.id, phone: "+15550001111", displayName: "P", status: "Connected" }).returning();
    const [local] = await db.insert(templatesTable).values({ organizationId: org.id, name: "local", body: "Hi {{1}}", status: "Pending", metadata: { source: "local" } }).returning();
    const [campaign] = await db.insert(campaignsTable).values({ organizationId: org.id, name: "c", status: "Draft" }).returning();
    await db.insert(campaignTemplateSelectionsTable).values({ organizationId: org.id, campaignId: campaign.id, templateId: local.id });
    await db.insert(campaignTemplateMappingsTable).values({ organizationId: org.id, campaignId: campaign.id, templateId: local.id, component: "body", variable: "1", source: "static", sourceValue: "x" });
    const [route] = await db.insert(campaignRoutesTable).values({ organizationId: org.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: local.id, configuredTps: 1 }).returning();
    const del = handler("/templates/:templateId", "delete");
    const res = fakeResponse();
    await del({ organizationId: org.id, role: "owner", params: { templateId: String(local.id) } }, res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "referenced");
    assert.deepEqual(res.body.references, { selections: 1, mappings: 1, routes: 1, jobs: 0, allocations: 0 });
    assert.equal((await db.select().from(campaignTemplateSelectionsTable).where(eq(campaignTemplateSelectionsTable.campaignId, campaign.id))).length, 1);
    assert.equal((await db.select().from(campaignTemplateMappingsTable).where(eq(campaignTemplateMappingsTable.campaignId, campaign.id))).length, 1);
    assert.equal((await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.id, route.id)))[0]!.templateId, local.id);

    const [unused] = await db.insert(templatesTable).values({ organizationId: org.id, name: "unused", body: "U", status: "Pending", metadata: { source: "local" } }).returning();
    const ok = fakeResponse();
    await del({ organizationId: org.id, role: "owner", params: { templateId: String(unused.id) } }, ok);
    assert.equal(ok.statusCode, 204);
    assert.equal((await db.select().from(templatesTable).where(eq(templatesTable.id, unused.id))).length, 0);
  } finally { await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)); }
});

test("DELETE vs concurrent reference insert: the delete waits on the row lock and then refuses, so no configuration is lost", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const [org] = await db.insert(organizationsTable).values({ name: `del-race-${stamp}`, slug: `del-race-${stamp}` }).returning();
  try {
    const [local] = await db.insert(templatesTable).values({ organizationId: org.id, name: "racing", body: "R", status: "Pending", metadata: { source: "local" } }).returning();
    const [campaign] = await db.insert(campaignsTable).values({ organizationId: org.id, name: "c", status: "Draft" }).returning();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inserted!: () => void;
    const insertedAt = new Promise<void>((resolve) => { inserted = resolve; });
    // An open transaction that has inserted a reference (holding KEY SHARE
    // on the template row) but not yet committed.
    const referencing = db.transaction(async (tx) => {
      await tx.insert(campaignTemplateSelectionsTable).values({ organizationId: org.id, campaignId: campaign.id, templateId: local.id });
      inserted();
      await gate;
    });
    await insertedAt;
    const res = fakeResponse();
    const deletion = handler("/templates/:templateId", "delete")({ organizationId: org.id, role: "owner", params: { templateId: String(local.id) } }, res);
    await lockWaitOn("templates"); // the delete is blocked on FOR UPDATE, it did not slip past the check
    release();
    await referencing;
    await deletion;
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "referenced");
    assert.equal(res.body.references.selections, 1);
    assert.equal((await db.select().from(templatesTable).where(eq(templatesTable.id, local.id))).length, 1);
    assert.equal((await db.select().from(campaignTemplateSelectionsTable).where(eq(campaignTemplateSelectionsTable.campaignId, campaign.id))).length, 1);
  } finally { await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)); }
});

test("PATCH vs concurrent delete and local-to-provider transition: controlled 404/409, never a 500, provider fields never written", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const [org] = await db.insert(organizationsTable).values({ name: `patch-race-${stamp}`, slug: `patch-race-${stamp}` }).returning();
  try {
    const patch = handler("/templates/:templateId", "patch");
    // Concurrent delete: the delete holds the row lock first; PATCH waits, then finds nothing.
    const [doomed] = await db.insert(templatesTable).values({ organizationId: org.id, name: "doomed", body: "D", status: "Pending", metadata: { source: "local" } }).returning();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockedAt = new Promise<void>((resolve) => { locked = resolve; });
    const deleting = db.transaction(async (tx) => {
      await tx.delete(templatesTable).where(and(eq(templatesTable.id, doomed.id), eq(templatesTable.organizationId, org.id)));
      locked();
      await gate;
    });
    await lockedAt;
    const res = fakeResponse();
    const patching = patch({ organizationId: org.id, role: "manager", params: { templateId: String(doomed.id) }, body: { name: "renamed" } }, res);
    await lockWaitOn("templates");
    release();
    await deleting;
    await patching;
    assert.equal(res.statusCode, 404, JSON.stringify(res.body));

    // Local-to-provider transition: a sync claims the row (adds a provider
    // id) while a PATCH waits; the PATCH then sees a provider-backed row.
    const [turning] = await db.insert(templatesTable).values({ organizationId: org.id, name: "turning", body: "T", status: "Pending", metadata: { source: "local" } }).returning();
    let release2!: () => void;
    const gate2 = new Promise<void>((resolve) => { release2 = resolve; });
    let locked2!: () => void;
    const lockedAt2 = new Promise<void>((resolve) => { locked2 = resolve; });
    const claiming = db.transaction(async (tx) => {
      await tx.update(templatesTable).set({ providerTemplateId: `p-${stamp}`, status: "Approved", metadata: { source: "workspace_credential" } }).where(and(eq(templatesTable.id, turning.id), eq(templatesTable.organizationId, org.id)));
      locked2();
      await gate2;
    });
    await lockedAt2;
    const res2 = fakeResponse();
    const patching2 = patch({ organizationId: org.id, role: "manager", params: { templateId: String(turning.id) }, body: { name: "edited", body: "changed", status: "Rejected" } }, res2);
    await lockWaitOn("templates");
    release2();
    await claiming;
    await patching2;
    assert.equal(res2.statusCode, 409, JSON.stringify(res2.body));
    const [after] = await db.select().from(templatesTable).where(eq(templatesTable.id, turning.id));
    assert.equal(after.name, "turning");
    assert.equal(after.body, "T");
    assert.equal(after.status, "Approved");
    assert.equal(after.providerTemplateId, `p-${stamp}`);
  } finally { await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)); }
});
