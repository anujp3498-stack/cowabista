import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignsTable,
  db,
  organizationsTable,
  pool,
} from "@workspace/db";
import campaignEngineRouter from "../src/routes/campaign-engine";

// POST .../campaigns/:id/contacts/search is keyset (rowNumber) paginated, not
// offset/count(*), because a campaign's imported rows can reach the 10-20M
// contact scale this engine targets -- an unbounded response or an
// offset-based scan would not stay usable at that size. This exercises the
// real handler: cursor paging never drops or repeats a row, `limit` is
// clamped, and results stay scoped to one organization.

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

async function seedCampaignWithContacts(slug: string, count: number) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Draft" }).returning();
  const rows = Array.from({ length: count }, (_, i) => ({
    organizationId: organization.id,
    campaignId: campaign.id,
    rowNumber: i + 1,
    rawPhone: `+1555${String(i).padStart(7, "0")}`,
    normalizedPhone: `+1555${String(i).padStart(7, "0")}`,
    status: "Valid" as const,
    idempotencyKey: `${slug}-c${i}`,
  }));
  await db.insert(campaignContactsTable).values(rows);
  return { organization, campaign };
}

after(async () => {
  await pool.end();
});

test("POST .../contacts/search pages through every row via the cursor with no gaps, drops, or repeats", async () => {
  const slug = `contacts-search-${process.pid}-${Date.now()}`;
  const { organization, campaign } = await seedCampaignWithContacts(slug, 23);
  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/contacts/search", "post");
    const seen: number[] = [];
    let after: number | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const res = fakeResponse();
      await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { after, limit: 10 } }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      seen.push(...res.body.items.map((row: { rowNumber: number }) => row.rowNumber));
      if (res.body.nextCursor === null) break;
      after = res.body.nextCursor;
    }
    assert.deepEqual(seen, Array.from({ length: 23 }, (_, i) => i + 1));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("POST .../contacts/search clamps limit to 2000 and never returns another organization's rows", async () => {
  const slugA = `contacts-search-isoA-${process.pid}-${Date.now()}`;
  const slugB = `contacts-search-isoB-${process.pid}-${Date.now()}`;
  const orgA = await seedCampaignWithContacts(slugA, 3);
  const orgB = await seedCampaignWithContacts(slugB, 3);
  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/contacts/search", "post");

    const overLimitRes = fakeResponse();
    await handler({ params: { organizationId: String(orgA.organization.id), campaignId: String(orgA.campaign.id) }, body: { limit: 99999 } }, overLimitRes);
    assert.equal(overLimitRes.statusCode, 200);
    assert.equal(overLimitRes.body.items.length, 3);
    assert.equal(overLimitRes.body.nextCursor, null);

    const crossOrgRes = fakeResponse();
    await handler({ params: { organizationId: String(orgA.organization.id), campaignId: String(orgA.campaign.id) }, body: {} }, crossOrgRes);
    assert.equal(crossOrgRes.body.items.length, 3);
    for (const row of crossOrgRes.body.items) assert.equal(row.organizationId, orgA.organization.id);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.organization.id));
  }
});
