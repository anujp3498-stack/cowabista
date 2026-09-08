import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { campaignsTable, db, organizationsTable, pool } from "@workspace/db";
import campaignsRouter from "../src/routes/campaigns";

// These tests call the plain-CRUD campaign route handlers directly (bypassing
// HTTP/auth middleware, which requires a real Clerk session) to verify that
// lifecycle status can only change through the campaign actions endpoint
// (plan/execute/pause/resume/cancel/...), never through this CRUD surface.
// See campaigns.ts: allowing an arbitrary status here would let a campaign
// skip straight to Running without ever being planned, so its imported
// contacts would never be queued.

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
  res.send = (body?: unknown) => { res.body = body; return res; };
  return res;
}

async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  return organization;
}

test("PATCH /campaigns/:id rejects a direct status change, requiring the actions endpoint", async () => {
  const organization = await createOrganization(`bypass-patch-${Date.now()}`);
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: organization.id,
    name: "bypass-target",
    status: "Draft",
  }).returning();

  const patch = findRouteHandler(campaignsRouter, "/campaigns/:campaignId", "patch");
  const res = fakeResponse();
  await patch(
    { params: { campaignId: String(campaign.id) }, body: { status: "Running" }, organizationId: organization.id },
    res,
    () => {},
  );

  assert.equal(res.statusCode, 409);
  const [after] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id));
  assert.equal(after?.status, "Draft");
});

test("PATCH /campaigns/:id still allows a no-op resubmission of the current status", async () => {
  const organization = await createOrganization(`bypass-noop-${Date.now()}`);
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: organization.id,
    name: "noop-target",
    status: "Draft",
  }).returning();

  const patch = findRouteHandler(campaignsRouter, "/campaigns/:campaignId", "patch");
  const res = fakeResponse();
  await patch(
    { params: { campaignId: String(campaign.id) }, body: { status: "Draft", name: "renamed" }, organizationId: organization.id },
    res,
    () => {},
  );

  assert.equal(res.statusCode, 200);
  const [after] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaign.id));
  assert.equal(after?.status, "Draft");
  assert.equal(after?.name, "renamed");
});

test("POST /campaigns rejects a non-Draft initial status", async () => {
  const organization = await createOrganization(`bypass-post-${Date.now()}`);
  const post = findRouteHandler(campaignsRouter, "/campaigns", "post");
  const res = fakeResponse();
  await post(
    { body: { name: "should-not-exist", status: "Running" }, organizationId: organization.id },
    res,
    () => {},
  );

  assert.equal(res.statusCode, 400);
  const rows = await db.select().from(campaignsTable).where(eq(campaignsTable.organizationId, organization.id));
  assert.equal(rows.length, 0);
});

test.after(async () => {
  await pool.end();
});
