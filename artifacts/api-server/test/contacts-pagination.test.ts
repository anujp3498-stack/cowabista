import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { contactsTable, db, organizationsTable } from "@workspace/db";
import contactsRouter from "../src/routes/contacts";

// Task #23: the contacts list must stay fast as an organization's address
// book grows, so it's server-paginated (limit/offset) with a total count,
// and search runs server-side against trigram-indexed columns instead of
// shipping the whole table to the browser for client-side filtering.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRouteHandler(router: any, path: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler registered for ${method.toUpperCase()} ${path}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

async function seedContacts(slug: string, count: number) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const rows = Array.from({ length: count }, (_, i) => ({
    organizationId: organization.id,
    name: `Contact ${i}`,
    phone: `+1555000${String(i).padStart(4, "0")}`,
    email: `contact${i}@example.com`,
  }));
  await db.insert(contactsTable).values(rows);
  return organization;
}

after(async () => {
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("listContacts paginates with a stable total and never returns more than `limit` rows", async () => {
  const slug = `contacts-page-${process.pid}-${Date.now()}`;
  const organization = await seedContacts(slug, 30);
  try {
    const handler = findRouteHandler(contactsRouter, "/contacts", "get");
    const page1Res = fakeResponse();
    await handler({ organizationId: organization.id, query: { limit: "10", offset: "0" } }, page1Res);
    assert.equal(page1Res.body.total, 30);
    assert.equal(page1Res.body.contacts.length, 10);

    const page2Res = fakeResponse();
    await handler({ organizationId: organization.id, query: { limit: "10", offset: "10" } }, page2Res);
    assert.equal(page2Res.body.total, 30);
    assert.equal(page2Res.body.contacts.length, 10);

    const page1Ids = new Set(page1Res.body.contacts.map((c: { id: number }) => c.id));
    const page2Ids = new Set(page2Res.body.contacts.map((c: { id: number }) => c.id));
    for (const id of page2Ids) assert.ok(!page1Ids.has(id), "pages must not overlap");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("listContacts search matches name, phone, or email and is scoped to the organization", async () => {
  const slugA = `contacts-search-a-${process.pid}-${Date.now()}`;
  const slugB = `contacts-search-b-${process.pid}-${Date.now()}`;
  const orgA = await seedContacts(slugA, 3);
  const orgB = await seedContacts(slugB, 3);
  try {
    // Give one contact in org A a distinctive name that doesn't collide with org B's rows.
    await db.insert(contactsTable).values({
      organizationId: orgA.id, name: "Zzyzx Unique Name", phone: "+15559991234", email: "zzyzx@example.com",
    });
    const handler = findRouteHandler(contactsRouter, "/contacts", "get");
    const res = fakeResponse();
    await handler({ organizationId: orgA.id, query: { search: "zzyzx" } }, res);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.contacts[0].name, "Zzyzx Unique Name");

    // Same search term against org B must find nothing -- proves the search
    // predicate is ANDed with the org scope, not a global scan.
    const crossOrgRes = fakeResponse();
    await handler({ organizationId: orgB.id, query: { search: "zzyzx" } }, crossOrgRes);
    assert.equal(crossOrgRes.body.total, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.id));
  }
});

test("listContacts clamps limit to a sane maximum", async () => {
  const slug = `contacts-limit-clamp-${process.pid}-${Date.now()}`;
  const organization = await seedContacts(slug, 5);
  try {
    const handler = findRouteHandler(contactsRouter, "/contacts", "get");
    const res = fakeResponse();
    await handler({ organizationId: organization.id, query: { limit: "99999" } }, res);
    assert.equal(res.body.limit, 100);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});
