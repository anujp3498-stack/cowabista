import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  campaignContactsTable,
  campaignsTable,
  contactImportSessionsTable,
  db,
  organizationsTable,
  pool,
} from "@workspace/db";
import campaignEngineRouter from "../src/routes/campaign-engine";

// Task #22: managers need to download the EXACT rows a CSV import
// rejected (Invalid phone or Suppressed/opted-out), not just an aggregate
// count. This exercises the real streaming handler end-to-end: it must
// include only Invalid/Suppressed rows (never Valid, never the
// uncounted-content duplicates), preserve the original CSV's own columns
// alongside the import metadata columns, and stay scoped to the right
// organization/campaign/import session.

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
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
  };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.setHeader = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; };
  res.write = (chunk: string) => { res.chunks.push(chunk); return true; };
  res.end = () => { res.ended = true; };
  res.text = () => res.chunks.join("");
  return res;
}

after(async () => {
  await pool.end();
});

async function seedImport(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Draft" }).returning();
  const [session] = await db.insert(contactImportSessionsTable).values({
    organizationId: organization.id,
    campaignId: campaign.id,
    idempotencyKey: `${slug}-import`,
    fileName: `${slug}.csv`,
    status: "Completed",
    columns: ["phone", "name"],
    bytesProcessed: 100,
    rowsProcessed: 4,
    validRows: 1,
    invalidRows: 1,
    duplicateRows: 1,
    suppressedRows: 1,
  }).returning();
  await db.insert(campaignContactsTable).values([
    {
      organizationId: organization.id, campaignId: campaign.id, importSessionId: session.id, rowNumber: 1,
      rawPhone: "+15551110001", normalizedPhone: "+15551110001", status: "Valid",
      idempotencyKey: `${slug}-1`, data: { phone: "+15551110001", name: "Ada" },
    },
    {
      organizationId: organization.id, campaignId: campaign.id, importSessionId: session.id, rowNumber: 2,
      rawPhone: "not-a-phone", status: "Invalid", invalidReason: "Unparseable phone number",
      idempotencyKey: `${slug}-2`, data: { phone: "not-a-phone", name: "Bad Row" },
    },
    {
      organizationId: organization.id, campaignId: campaign.id, importSessionId: session.id, rowNumber: 3,
      rawPhone: "+15551110003", normalizedPhone: "+15551110003", status: "Suppressed", invalidReason: "On suppression list",
      idempotencyKey: `${slug}-3`, data: { phone: "+15551110003", name: "Opted Out" },
    },
  ]).returning();
  return { organization, campaign, session };
}

test("GET .../rejected.csv includes only Invalid/Suppressed rows with original columns and reasons", async () => {
  const slug = `import-dl-${process.pid}-${Date.now()}`;
  const { organization, campaign, session } = await seedImport(slug);
  const handler = findRouteHandler(
    campaignEngineRouter,
    "/organizations/:organizationId/campaigns/:campaignId/imports/:importSessionId/rejected.csv",
    "get",
  );
  const res = fakeResponse();
  await handler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id), importSessionId: String(session.id) } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
  assert.ok(res.ended);

  const lines = res.text().trim().split("\r\n");
  assert.equal(lines[0], "import_row_number,import_status,import_rejection_reason,phone,name");
  assert.equal(lines.length, 3, "header + 2 rejected rows (Valid excluded)");
  assert.ok(lines.some((line: string) => line.includes("Invalid") && line.includes("Unparseable phone number") && line.includes("not-a-phone")));
  assert.ok(lines.some((line: string) => line.includes("Suppressed") && line.includes("On suppression list") && line.includes("+15551110003")));
  assert.ok(!lines.some((line: string) => line.includes("Ada")), "the Valid row must not appear");
});

test("GET .../rejected.csv 404s for an import session from a different organization", async () => {
  const slug = `import-dl-cross-${process.pid}-${Date.now()}`;
  const { session } = await seedImport(slug);
  const [otherOrg] = await db.insert(organizationsTable).values({ name: `${slug}-other`, slug: `${slug}-other` }).returning();
  const [otherCampaign] = await db.insert(campaignsTable).values({ organizationId: otherOrg.id, name: `${slug}-other`, status: "Draft" }).returning();

  const handler = findRouteHandler(
    campaignEngineRouter,
    "/organizations/:organizationId/campaigns/:campaignId/imports/:importSessionId/rejected.csv",
    "get",
  );
  const res = fakeResponse();
  await handler({ params: { organizationId: String(otherOrg.id), campaignId: String(otherCampaign.id), importSessionId: String(session.id) } }, res);

  assert.equal(res.statusCode, 404);
});
