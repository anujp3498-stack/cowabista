import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, organizationsTable, templatesTable, wabasTable } from "@workspace/db";
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
