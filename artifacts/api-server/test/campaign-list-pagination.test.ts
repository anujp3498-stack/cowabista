import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { campaignsTable, db, organizationsTable } from "@workspace/db";
import campaignsRouter from "../src/routes/campaigns";

// V2-01C: GET /campaigns/list is keyset-paginated (id descending), searches
// by name server-side, filters by status, caps the page size, rejects bad
// cursors and never crosses organizations. GET /campaigns/:campaignId is
// the detail read for the Campaign page.

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

function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

type Page = { items: { id: number; name: string; status: string }[]; nextCursor: number | null; hasMore: boolean; limit: number };

async function listPage(organizationId: number, query: Record<string, string>) {
  const handler = findRouteHandler(campaignsRouter, "/campaigns/list", "get");
  const res = fakeResponse();
  await handler({ organizationId, query }, res);
  return res as { statusCode: number; body: Page & { error?: string } };
}

async function seedOrg(slug: string, count: number) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const statuses = ["Draft", "Running", "Completed"];
  const rows = Array.from({ length: count }, (_, i) => ({
    organizationId: organization.id,
    name: i % 7 === 0 ? `Diwali Teaser ${i}` : `Campaign ${i}`,
    status: statuses[i % statuses.length]!,
  }));
  await db.insert(campaignsTable).values(rows);
  return organization;
}

after(async () => {
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("list pages by keyset with a default limit, no overlap, newest first", async () => {
  const slug = `campaign-list-${process.pid}-${Date.now()}`;
  const organization = await seedOrg(slug, 60);
  try {
    const first = await listPage(organization.id, {});
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.limit, 25);
    assert.equal(first.body.items.length, 25);
    assert.equal(first.body.hasMore, true);
    assert.equal(first.body.nextCursor, first.body.items[24]!.id);
    for (let i = 1; i < first.body.items.length; i += 1) {
      assert.ok(first.body.items[i - 1]!.id > first.body.items[i]!.id, "ordered by id descending");
    }

    const seen = new Set(first.body.items.map((c) => c.id));
    let cursor = first.body.nextCursor;
    let total = first.body.items.length;
    while (cursor !== null) {
      const next = await listPage(organization.id, { cursor: String(cursor) });
      assert.equal(next.statusCode, 200);
      for (const item of next.body.items) {
        assert.ok(!seen.has(item.id), "pages must not overlap");
        seen.add(item.id);
      }
      total += next.body.items.length;
      cursor = next.body.nextCursor;
      if (!next.body.hasMore) assert.equal(next.body.nextCursor, null);
    }
    assert.equal(total, 60, "every campaign is reached exactly once");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("list caps the requested limit and rejects invalid cursors and limits", async () => {
  const slug = `campaign-list-cap-${process.pid}-${Date.now()}`;
  const organization = await seedOrg(slug, 5);
  try {
    const capped = await listPage(organization.id, { limit: "500" });
    assert.equal(capped.statusCode, 200);
    assert.equal(capped.body.limit, 100);

    const badCursor = await listPage(organization.id, { cursor: "abc" });
    assert.equal(badCursor.statusCode, 400);
    const zeroCursor = await listPage(organization.id, { cursor: "0" });
    assert.equal(zeroCursor.statusCode, 400);
    const badLimit = await listPage(organization.id, { limit: "0" });
    assert.equal(badLimit.statusCode, 400);
    const badStatus = await listPage(organization.id, { status: "Active" });
    assert.equal(badStatus.statusCode, 400);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("list searches by name and filters by status server-side", async () => {
  const slug = `campaign-list-search-${process.pid}-${Date.now()}`;
  const organization = await seedOrg(slug, 30);
  try {
    const searched = await listPage(organization.id, { search: "diwali" });
    assert.equal(searched.statusCode, 200);
    assert.equal(searched.body.items.length, 5); // indexes 0,7,14,21,28
    assert.ok(searched.body.items.every((c) => c.name.startsWith("Diwali Teaser")));

    const running = await listPage(organization.id, { status: "Running", limit: "100" });
    assert.equal(running.statusCode, 200);
    assert.equal(running.body.items.length, 10);
    assert.ok(running.body.items.every((c) => c.status === "Running"));

    const both = await listPage(organization.id, { status: "Draft", search: "diwali" });
    assert.ok(both.body.items.every((c) => c.status === "Draft" && c.name.includes("Diwali")));

    const wildcard = await listPage(organization.id, { search: "%" });
    assert.equal(wildcard.body.items.length, 0, "LIKE wildcards are escaped, not interpreted");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("list and get are scoped to the organization", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const orgA = await seedOrg(`campaign-list-a-${stamp}`, 3);
  const orgB = await seedOrg(`campaign-list-b-${stamp}`, 4);
  try {
    const a = await listPage(orgA.id, { limit: "100" });
    const b = await listPage(orgB.id, { limit: "100" });
    assert.equal(a.body.items.length, 3);
    assert.equal(b.body.items.length, 4);
    const aIds = new Set(a.body.items.map((c) => c.id));
    for (const item of b.body.items) assert.ok(!aIds.has(item.id));

    const getHandler = findRouteHandler(campaignsRouter, "/campaigns/:campaignId", "get");
    const own = fakeResponse();
    await getHandler({ organizationId: orgA.id, params: { campaignId: String(a.body.items[0]!.id) } }, own);
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.id, a.body.items[0]!.id);
    assert.equal(typeof own.body.routesCount, "number");

    const foreign = fakeResponse();
    await getHandler({ organizationId: orgA.id, params: { campaignId: String(b.body.items[0]!.id) } }, foreign);
    assert.equal(foreign.statusCode, 404);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.id));
  }
});
