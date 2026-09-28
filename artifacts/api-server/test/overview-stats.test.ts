import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignsTable,
  contactsTable,
  db,
  organizationMembersTable,
  organizationsTable,
  phoneNumbersTable,
  templatesTable,
  usersTable,
  wabasTable,
} from "@workspace/db";
import overviewRouter from "../src/routes/overview";
import { provisionPersonalOrganization } from "../src/lib/orgProvisioning";

// V2-01B: Home must be honest. The overview endpoint counts campaigns in the
// engine's real "Running" state (the old query looked for a status that does
// not exist), never counts rows flagged isSample, and stays scoped to the
// active organization. New personal workspaces are created empty.

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

async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  return organization;
}

async function overviewFor(organizationId: number) {
  const handler = findRouteHandler(overviewRouter, "/overview/stats", "get");
  const res = fakeResponse();
  await handler({ organizationId }, res);
  assert.equal(res.statusCode, 200);
  return res.body as {
    activeCampaigns: number;
    connectedNumbers: number;
    messagesSent: number;
    deliveryRate: number;
    tpsOverall: number;
  };
}

after(async () => {
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("overview counts Running campaigns and excludes sample rows from every figure", async () => {
  const slug = `overview-honest-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const [waba] = await db.insert(wabasTable).values({
      organizationId: organization.id, externalId: `waba-${slug}`, displayName: "Real WABA",
    }).returning();
    const [realPhone, samplePhone] = await db.insert(phoneNumbersTable).values([
      { organizationId: organization.id, wabaId: waba.id, phone: "+15550000001", displayName: "Real", status: "Connected", tpsLimit: 50 },
      { organizationId: organization.id, wabaId: waba.id, phone: "+15550000002", displayName: "Sample", status: "Connected", tpsLimit: 80, isSample: true },
    ]).returning();
    const [template] = await db.insert(templatesTable).values({
      organizationId: organization.id, name: "t", body: "Hi {{1}}", status: "Approved",
    }).returning();
    const [running, sampleRunning, draft] = await db.insert(campaignsTable).values([
      { organizationId: organization.id, name: "Real running", status: "Running", audienceSize: 100, sent: 40, delivered: 30 },
      { organizationId: organization.id, name: "Sample running", status: "Running", audienceSize: 120, sent: 96, delivered: 90, isSample: true },
      { organizationId: organization.id, name: "Real draft", status: "Draft", sent: 10, delivered: 10 },
    ]).returning();
    await db.insert(campaignRoutesTable).values([
      { organizationId: organization.id, campaignId: running.id, phoneNumberId: realPhone.id, templateId: template.id, configuredTps: 10, currentTps: 7 },
      { organizationId: organization.id, campaignId: sampleRunning.id, phoneNumberId: samplePhone.id, templateId: template.id, configuredTps: 60, currentTps: 42, isSample: true },
    ]);
    assert.ok(draft.id);

    const stats = await overviewFor(organization.id);
    assert.equal(stats.activeCampaigns, 1, "only the real Running campaign counts");
    assert.equal(stats.connectedNumbers, 1, "sample connected number is excluded");
    assert.equal(stats.messagesSent, 50, "sent totals exclude the sample campaign");
    assert.equal(stats.deliveryRate, 80, "delivery rate uses real rows only (40/50)");
    assert.equal(stats.tpsOverall, 7, "route aggregate excludes the sample route");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("overview stats are scoped to the requested organization", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const orgA = await createOrganization(`overview-scope-a-${stamp}`);
  const orgB = await createOrganization(`overview-scope-b-${stamp}`);
  try {
    await db.insert(campaignsTable).values([
      { organizationId: orgA.id, name: "A running", status: "Running", sent: 5, delivered: 5 },
      { organizationId: orgB.id, name: "B running 1", status: "Running", sent: 1, delivered: 0 },
      { organizationId: orgB.id, name: "B running 2", status: "Running", sent: 1, delivered: 1 },
    ]);
    const a = await overviewFor(orgA.id);
    const b = await overviewFor(orgB.id);
    assert.equal(a.activeCampaigns, 1);
    assert.equal(a.messagesSent, 5);
    assert.equal(b.activeCampaigns, 2);
    assert.equal(b.messagesSent, 2);
    assert.equal(b.deliveryRate, 50);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB.id));
  }
});

test("a new personal workspace is created with an owner membership and no sample records", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const [user] = await db.insert(usersTable).values({
    clerkId: `user_overview_${stamp}`, email: `overview-${stamp}@example.com`, name: "Fresh User",
  }).returning();
  let organizationId: number | undefined;
  try {
    const provisioned = await provisionPersonalOrganization(user);
    organizationId = provisioned.organizationId;

    const members = await db.select().from(organizationMembersTable)
      .where(eq(organizationMembersTable.organizationId, organizationId));
    assert.equal(members.length, 1);
    assert.equal(members[0].userId, user.id);
    assert.equal(members[0].role, "owner");

    const counts = await Promise.all([
      db.select().from(wabasTable).where(eq(wabasTable.organizationId, organizationId)),
      db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, organizationId)),
      db.select().from(contactsTable).where(eq(contactsTable.organizationId, organizationId)),
      db.select().from(templatesTable).where(eq(templatesTable.organizationId, organizationId)),
      db.select().from(campaignsTable).where(eq(campaignsTable.organizationId, organizationId)),
      db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.organizationId, organizationId)),
    ]);
    for (const rows of counts) assert.equal(rows.length, 0, "new workspaces must be empty");

    const stats = await overviewFor(organizationId);
    assert.deepEqual(stats, { activeCampaigns: 0, connectedNumbers: 0, messagesSent: 0, deliveryRate: 0, tpsOverall: 0 });
  } finally {
    if (organizationId) await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(usersTable).where(eq(usersTable.id, user.id));
  }
});
