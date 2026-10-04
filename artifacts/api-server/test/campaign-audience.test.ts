import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignAuditTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportOccurrencesTable,
  contactImportSessionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  settlementPool,
  suppressionsTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import campaignEngineRouter from "../src/routes/campaign-engine";
import campaignsRouter from "../src/routes/campaigns";
import campaignRoutesRouter from "../src/routes/campaign-routes";
import { planCampaign } from "../src/services/campaign-planning";
import { initializeContactImport, reopenCampaign } from "../src/services/campaign-import-lifecycle";
import { parseCsv, stableContactKey } from "../src/services/contact-processing";

// V2-05A Rocket Audience: sniff, replay-safe Draft creation, stale-autosave
// fence, duplicate preservation, append/replace with staged activation and
// generation fences, reopen (Ready -> Draft), execution-history rejection,
// setup edits after import, id-keyset pagination and tenant isolation.

after(async () => {
  await Promise.all([pool.end(), settlementPool.end()]);
});

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
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, chunks: [] as string[], ended: false, destroyed: false };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.setHeader = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; };
  res.write = (chunk: string) => { res.chunks.push(chunk); return true; };
  res.once = () => res;
  res.end = () => { res.ended = true; };
  res.text = () => res.chunks.join("");
  return res;
}

const noopLog = { warn() {}, info() {}, error() {}, debug() {} };

function bodyRequest(body: Buffer | Buffer[], extra: Record<string, unknown>) {
  const chunks = Array.isArray(body) ? body : [body];
  const req = Readable.from(chunks) as Readable & Record<string, unknown>;
  Object.assign(req, { log: noopLog, authUser: { id: 1 }, ...extra });
  return req;
}

const ORG_ID = { organizationId: 0 };

async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  ORG_ID.organizationId = organization.id;
  return organization;
}

async function createCampaign(organizationId: number, name: string, status = "Draft") {
  const [campaign] = await db.insert(campaignsTable).values({ organizationId, name, status }).returning();
  return campaign;
}

const importHandler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/imports", "post");
const sniffHandler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/imports/sniff", "post");
const audienceHandler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/audience", "get");
const duplicatesHandler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/imports/:importSessionId/duplicates.csv", "get");
const rejectedHandler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/imports/:importSessionId/rejected.csv", "get");
const searchHandler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/contacts/search", "post");
const actionsHandler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/actions", "post");
const createCampaignHandler = findRouteHandler(campaignsRouter, "/campaigns", "post");
const patchCampaignHandler = findRouteHandler(campaignsRouter, "/campaigns/:campaignId", "patch");
const createRouteHandler = findRouteHandler(campaignRoutesRouter, "/campaign-routes", "post");

async function runImport(
  organizationId: number,
  campaignId: number,
  csv: string | Buffer | Buffer[],
  options: { key: string; phoneColumn?: string; countryCode?: string; operation?: "append" | "replace"; fileName?: string },
) {
  const headers: Record<string, string> = {
    "idempotency-key": options.key,
    "x-file-name": options.fileName ?? "contacts.csv",
    "x-phone-column": options.phoneColumn ?? "phone",
  };
  if (options.countryCode) headers["x-default-country-code"] = options.countryCode;
  if (options.operation) headers["x-import-operation"] = options.operation;
  const body = typeof csv === "string" ? Buffer.from(csv) : csv;
  const req = bodyRequest(body, { params: { organizationId: String(organizationId), campaignId: String(campaignId) }, headers });
  const res = fakeResponse();
  await importHandler(req, res);
  return res;
}

async function runSniff(organizationId: number, campaignId: number, csv: string | Buffer | Buffer[]) {
  const body = typeof csv === "string" ? Buffer.from(csv) : csv;
  const req = bodyRequest(body, { params: { organizationId: String(organizationId), campaignId: String(campaignId) }, headers: {} });
  req.resume = () => req;
  const res = fakeResponse();
  await sniffHandler(req, res);
  return res;
}

async function audience(organizationId: number, campaignId: number) {
  const res = fakeResponse();
  await audienceHandler({ params: { organizationId: String(organizationId), campaignId: String(campaignId) } }, res);
  return res;
}

async function contactsOf(campaignId: number) {
  return db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaignId)).orderBy(campaignContactsTable.id);
}

async function campaignRow(campaignId: number) {
  const [row] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  return row!;
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

test("parseCsv reassembles a UTF-8 character split across chunks, drops the BOM and keeps quoted content", async () => {
  const text = "﻿phone,name,notes\r\n+15550000001,\"Zoë, \"\"the\"\" first\nline\",plain\r\n+15550000002,Ünal,\"a,b\"\n";
  const full = Buffer.from(text, "utf8");
  const cut = full.indexOf(Buffer.from("ë", "utf8")) + 1; // inside the 2-byte ë
  const rows: string[][] = [];
  async function* chunks() { yield full.subarray(0, cut); yield full.subarray(cut); }
  for await (const row of parseCsv(chunks())) rows.push(row);
  assert.deepEqual(rows[0], ["phone", "name", "notes"]);
  assert.deepEqual(rows[1], ["+15550000001", 'Zoë, "the" first\nline', "plain"]);
  assert.deepEqual(rows[2], ["+15550000002", "Ünal", "a,b"]);
  assert.equal(rows.length, 3);
});

/* ------------------------------------------------------------------ */
/* Sniff                                                               */
/* ------------------------------------------------------------------ */

test("sniff returns ordered disambiguated headers, a bounded sample, a single phone suggestion and a country-code decision", async () => {
  const slug = `sniff-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const campaign = await createCampaign(organization.id, slug);
    const csv = "﻿Phone,Name,,Name,\"Note, quoted\"\r\n+15550000001,Ada,x,dup,\"line\nbreak\"\r\n0044 7700 900123,\"Bob \"\"B\"\"\",y,dup2,z\r\n";
    const res = await runSniff(organization.id, campaign.id, csv);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.columns, ["Phone", "Name", "column_3", "Name_2", "Note, quoted"]);
    assert.equal(res.body.headerWarnings.length, 2);
    assert.deepEqual(res.body.sample[0], ["+15550000001", "Ada", "x", "dup", "line\nbreak"]);
    assert.deepEqual(res.body.sample[1], ["0044 7700 900123", 'Bob "B"', "y", "dup2", "z"]);
    assert.equal(res.body.sampleRows, 2);
    assert.equal(res.body.truncated, false);
    assert.equal(res.body.phoneColumnSuggestion, "Phone");
    assert.equal(res.body.countryCode.decision, "not_needed");

    const national = await runSniff(organization.id, campaign.id, "phone,name\n7700900123,Ada\n+15550000002,Bo\n");
    assert.equal(national.body.countryCode.decision, "required");
    assert.equal(national.body.countryCode.nationalSampleCount, 1);
    assert.equal(national.body.countryCode.internationalSampleCount, 1);

    // Two phone-looking headers: no suggestion, the user chooses.
    const ambiguous = await runSniff(organization.id, campaign.id, "mobile,phone\n+15550000001,+15550000002\n");
    assert.equal(ambiguous.body.phoneColumnSuggestion, null);
    assert.equal(ambiguous.body.countryCode.decision, "unknown");

    const empty = await runSniff(organization.id, campaign.id, "");
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.body.code, "empty_csv");

    const invalid = await runSniff(organization.id, campaign.id, "phone,name\n+1555,\"unterminated\n");
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, "invalid_csv");

    // Bounded: a body larger than the cap is reported truncated, even if the
    // cut lands inside a quoted field, and only a bounded sample comes back.
    const big = Buffer.from(`phone,name\n${Array.from({ length: 20_000 }, (_, i) => `+1555${String(i).padStart(7, "0")},"Name ${i}, long"`).join("\n")}\n`);
    assert.ok(big.length > 256 * 1024);
    const truncated = await runSniff(organization.id, campaign.id, [big.subarray(0, 100_000), big.subarray(100_000)]);
    assert.equal(truncated.statusCode, 200, JSON.stringify(truncated.body));
    assert.equal(truncated.body.truncated, true);
    assert.ok(truncated.body.sample.length <= 20);
    assert.ok(truncated.body.sampleRows <= 200);
    assert.ok(truncated.body.bytesInspected <= 256 * 1024);

    const other = await createOrganization(`${slug}-other`);
    const foreign = await runSniff(other.id, campaign.id, "phone\n+15550000001\n");
    assert.equal(foreign.statusCode, 404);
    await db.delete(organizationsTable).where(eq(organizationsTable.id, other.id));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

/* ------------------------------------------------------------------ */
/* Draft creation + autosave                                           */
/* ------------------------------------------------------------------ */

test("creating a Draft with the same creationKey replays the same campaign; a stale revision cannot overwrite a newer edit", async () => {
  const slug = `draft-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const key = `${slug}-create-key`;
    const create = async () => {
      const res = fakeResponse();
      await createCampaignHandler({ organizationId: organization.id, body: { name: "Untitled campaign", creationKey: key } }, res);
      return res;
    };
    const [a, b] = await Promise.all([create(), create()]);
    const created = [a, b].filter((r) => r.statusCode === 201);
    const replayed = [a, b].filter((r) => r.statusCode === 200);
    assert.equal(created.length, 1);
    assert.equal(replayed.length, 1);
    assert.equal(created[0]!.body.id, replayed[0]!.body.id);
    const third = await create();
    assert.equal(third.statusCode, 200);
    assert.equal(third.body.id, created[0]!.body.id);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(campaignsTable).where(eq(campaignsTable.organizationId, organization.id));
    assert.equal(count, 1);

    const id = created[0]!.body.id as number;
    assert.equal(created[0]!.body.revision, 0);
    const patch = async (body: Record<string, unknown>) => {
      const res = fakeResponse();
      await patchCampaignHandler({ organizationId: organization.id, params: { campaignId: String(id) }, body }, res);
      return res;
    };
    const first = await patch({ name: "Spring launch", revision: 0 });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.revision, 1);
    const stale = await patch({ name: "Spr", revision: 0 });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.code, "stale_revision");
    assert.equal(stale.body.campaign.name, "Spring launch");
    assert.equal(stale.body.campaign.revision, 1);
    const fresh = await patch({ name: "Spring launch v2", revision: 1 });
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.body.revision, 2);
    // Legacy clients that send no revision keep working (last write wins).
    const legacy = await patch({ name: "Legacy edit" });
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.body.revision, 3);
    const status = await patch({ status: "Running" });
    assert.equal(status.statusCode, 409);
    assert.equal(status.body.code, "status_locked");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

/* ------------------------------------------------------------------ */
/* Import: duplicates, replay, append, counts, downloads               */
/* ------------------------------------------------------------------ */

test("import preserves duplicate occurrences without duplicate contacts, replays safely, appends across sessions and downloads with original columns", async () => {
  const slug = `dup-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const campaign = await createCampaign(organization.id, slug);
    await db.insert(suppressionsTable).values({ organizationId: organization.id, normalizedPhone: "+15550000009", reason: "STOP" });
    // Row 2 Valid, 3 duplicate (same number, different formatting), 4 Invalid,
    // 5 Suppressed, 6 duplicate of the suppressed row, 7 Valid, 8 duplicate of 7.
    const csv = [
      "phone,name,note",
      "+15550000001,Ada,first",
      "(555) 000-0001,Ada again,\"dup, quoted\"",
      "not-a-phone,Broken,bad",
      "+15550000009,Stop,stopped",
      "+1 555 000 0009,Stop again,stopped-dup",
      "+15550000002,Bob,second",
      "+15550000002,Bob again,dup2",
      "",
    ].join("\r\n");
    const first = await runImport(organization.id, campaign.id, csv, { key: `${slug}-one`, countryCode: "1" });
    assert.equal(first.statusCode, 202, JSON.stringify(first.body));
    assert.equal(first.body.status, "Completed");
    assert.equal(first.body.validRows, 2);
    assert.equal(first.body.invalidRows, 1);
    assert.equal(first.body.suppressedRows, 1);
    assert.equal(first.body.duplicateRows, 3);
    assert.equal(first.body.operation, "append");
    assert.equal(first.body.audienceGeneration, 0);

    const contacts = await contactsOf(campaign.id);
    assert.equal(contacts.length, 4, "one canonical row per key: 2 valid, 1 invalid, 1 suppressed");
    const canonical = contacts.find((c) => c.normalizedPhone === "+15550000001")!;
    assert.equal(canonical.rowNumber, 2);
    assert.equal(canonical.idempotencyKey, stableContactKey(campaign.id, "+15550000001"));
    assert.deepEqual(canonical.data, { phone: "+15550000001", name: "Ada", note: "first" });

    const occurrences = await db.select().from(contactImportOccurrencesTable).where(eq(contactImportOccurrencesTable.campaignId, campaign.id)).orderBy(contactImportOccurrencesTable.rowNumber);
    assert.deepEqual(occurrences.map((o) => [o.rowNumber, o.classification, o.canonicalRowNumber, o.canonicalStatus]), [
      [3, "duplicate_in_import", 2, "Valid"],
      [6, "duplicate_in_import", 5, "Suppressed"],
      [8, "duplicate_in_import", 7, "Valid"],
    ]);
    assert.deepEqual(occurrences[0]!.data, { phone: "(555) 000-0001", name: "Ada again", note: "dup, quoted" });
    assert.equal(occurrences[0]!.canonicalContactId, canonical.id);

    // Replay of the same upload (same key, same config): nothing changes.
    const replay = await runImport(organization.id, campaign.id, csv, { key: `${slug}-one`, countryCode: "1" });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.body.id, first.body.id);
    assert.equal(replay.body.duplicateRows, 3);
    assert.equal((await contactsOf(campaign.id)).length, 4);
    assert.equal((await db.select().from(contactImportOccurrencesTable).where(eq(contactImportOccurrencesTable.campaignId, campaign.id))).length, 3);

    // Same key, different configuration: refused, nothing written.
    const mismatch = await runImport(organization.id, campaign.id, csv, { key: `${slug}-one`, countryCode: "44" });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.body.code, "idempotency_mismatch");

    // Append: dedups against the existing audience, keeps the first session.
    const second = await runImport(organization.id, campaign.id, "phone,name\n+15550000001,Ada (again)\n+15550000003,Cy\n+15550000003,Cy dup\n", { key: `${slug}-two` });
    assert.equal(second.statusCode, 202, JSON.stringify(second.body));
    assert.equal(second.body.validRows, 1);
    assert.equal(second.body.duplicateRows, 2);
    const secondOccurrences = await db.select().from(contactImportOccurrencesTable).where(eq(contactImportOccurrencesTable.importSessionId, second.body.id)).orderBy(contactImportOccurrencesTable.rowNumber);
    assert.deepEqual(secondOccurrences.map((o) => [o.rowNumber, o.classification, o.canonicalImportSessionId]), [
      [2, "duplicate_of_existing", first.body.id],
      [4, "duplicate_in_import", second.body.id],
    ]);
    assert.equal((await contactsOf(campaign.id)).length, 5);

    const summary = await audience(organization.id, campaign.id);
    assert.equal(summary.statusCode, 200);
    assert.deepEqual(summary.body.totals, { rows: 10, valid: 3, invalid: 1, duplicates: 5, suppressed: 1, sessions: 2 });
    assert.equal(summary.body.editable, true);
    assert.equal(summary.body.sessions.length, 2);
    const after = await campaignRow(campaign.id);
    assert.equal(after.audienceSize, 3);
    assert.equal(after.status, "Draft");
    const [metrics] = await db.select().from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaign.id));
    assert.equal(metrics!.valid, 3);
    assert.equal(metrics!.deduplicated, 5);
    assert.equal(metrics!.total, 10);

    // Importing never creates jobs.
    const [{ jobs }] = await db.select({ jobs: sql<number>`count(*)::int` }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
    assert.equal(jobs, 0);

    // Downloads.
    const dupRes = fakeResponse();
    await duplicatesHandler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id), importSessionId: String(first.body.id) } }, dupRes);
    assert.equal(dupRes.statusCode, 200);
    const dupLines = dupRes.text().trim().split("\r\n");
    assert.equal(dupLines[0], "import_row_number,duplicate_of,canonical_import_session_id,canonical_row_number,canonical_status,phone,name,note");
    assert.equal(dupLines.length, 4);
    assert.equal(dupLines[1], `3,duplicate_in_import,${first.body.id},2,Valid,(555) 000-0001,Ada again,"dup, quoted"`);
    const rejRes = fakeResponse();
    await rejectedHandler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id), importSessionId: String(first.body.id) } }, rejRes);
    const rejLines = rejRes.text().trim().split("\r\n");
    assert.equal(rejLines.length, 3, "header + invalid + suppressed; duplicates are not rejected rows");
    assert.ok(rejLines.some((l: string) => l.startsWith("4,Invalid,")));
    assert.ok(rejLines.some((l: string) => l.startsWith("5,Suppressed,")));

    // Tenant isolation on downloads.
    const other = await createOrganization(`${slug}-other`);
    const foreignDup = fakeResponse();
    await duplicatesHandler({ params: { organizationId: String(other.id), campaignId: String(campaign.id), importSessionId: String(first.body.id) } }, foreignDup);
    assert.equal(foreignDup.statusCode, 404);
    const foreignAudience = await audience(other.id, campaign.id);
    assert.equal(foreignAudience.statusCode, 404);
    await db.delete(organizationsTable).where(eq(organizationsTable.id, other.id));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("import disambiguates duplicate/empty headers, keeps every column, and refuses a missing phone column", async () => {
  const slug = `headers-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const campaign = await createCampaign(organization.id, slug);
    const res = await runImport(organization.id, campaign.id, "﻿phone,name,,name\n+15550000001,A,x,B\n", { key: `${slug}-one` });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body.columns, ["phone", "name", "column_3", "name_2"]);
    const [contact] = await contactsOf(campaign.id);
    assert.deepEqual(contact!.data, { phone: "+15550000001", name: "A", column_3: "x", name_2: "B" });

    const missing = await runImport(organization.id, campaign.id, "mobile\n+15550000002\n", { key: `${slug}-two` });
    assert.equal(missing.statusCode, 400);
    const [failed] = await db.select().from(contactImportSessionsTable).where(eq(contactImportSessionsTable.idempotencyKey, `${slug}-two`));
    assert.equal(failed!.status, "Failed");

    const invalid = await runImport(organization.id, campaign.id, "phone\n\"+15550000003\n", { key: `${slug}-three` });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, "invalid_csv");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

/* ------------------------------------------------------------------ */
/* Replace: staged activation, failure keeps previous, fences          */
/* ------------------------------------------------------------------ */

test("replace stages a new generation and activates atomically; a failed replace leaves the previous audience usable; stale appends are fenced", async () => {
  const slug = `replace-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const campaign = await createCampaign(organization.id, slug);
    const first = await runImport(organization.id, campaign.id, "phone,name\n+15550000001,Ada\n+15550000002,Bob\n", { key: `${slug}-one` });
    assert.equal(first.statusCode, 202);
    assert.equal((await campaignRow(campaign.id)).audienceSize, 2);

    // A replace whose body is invalid fails: the previous audience is intact.
    const failed = await runImport(organization.id, campaign.id, "phone,name\n+15550000005,\"broken\n", { key: `${slug}-bad`, operation: "replace" });
    assert.equal(failed.statusCode, 400);
    const afterFailed = await campaignRow(campaign.id);
    assert.equal(afterFailed.audienceGeneration, 0);
    assert.equal(afterFailed.audienceSize, 2);
    const summaryAfterFailed = await audience(organization.id, campaign.id);
    assert.deepEqual(summaryAfterFailed.body.totals, { rows: 2, valid: 2, invalid: 0, duplicates: 0, suppressed: 0, sessions: 1 });
    assert.equal(summaryAfterFailed.body.editable, true);

    // Successful replace: same phone as before is allowed (new generation),
    // activation flips the campaign's generation, counts are for the new one.
    const replaced = await runImport(organization.id, campaign.id, "phone,name\n+15550000002,Bob 2\n+15550000003,Cy\n+15550000003,Cy dup\n", { key: `${slug}-replace`, operation: "replace" });
    assert.equal(replaced.statusCode, 202, JSON.stringify(replaced.body));
    assert.equal(replaced.body.operation, "replace");
    assert.ok(replaced.body.activatedAt);
    const afterReplace = await campaignRow(campaign.id);
    assert.equal(afterReplace.audienceGeneration, replaced.body.audienceGeneration);
    assert.ok(afterReplace.audienceGeneration > 1, "the failed staged generation is never reused");
    assert.equal(afterReplace.audienceSize, 2);
    const summary = await audience(organization.id, campaign.id);
    assert.deepEqual(summary.body.totals, { rows: 3, valid: 2, invalid: 0, duplicates: 1, suppressed: 0, sessions: 1 });
    // History preserved: previous generation rows still exist, not deleted.
    const all = await contactsOf(campaign.id);
    assert.equal(all.filter((c) => c.audienceGeneration === 0).length, 2);
    assert.equal(all.filter((c) => c.audienceGeneration === afterReplace.audienceGeneration).length, 2);
    assert.equal(all.filter((c) => c.normalizedPhone === "+15550000002").length, 2, "same key in two generations, canonical key unchanged");
    assert.ok(all.every((c) => c.normalizedPhone !== "+15550000002" || c.idempotencyKey === stableContactKey(campaign.id, "+15550000002")));

    // Search lists only the active generation, keyset by id.
    const searchRes = fakeResponse();
    await searchHandler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { limit: 1 } }, searchRes);
    assert.equal(searchRes.body.items.length, 1);
    assert.equal(searchRes.body.items[0].name ?? searchRes.body.items[0].data.name, "Bob 2");
    const nextRes = fakeResponse();
    await searchHandler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { limit: 1, after: searchRes.body.nextCursor } }, nextRes);
    assert.equal(nextRes.body.items[0].data.name, "Cy");
    assert.equal(nextRes.body.items[0].id > searchRes.body.items[0].id, true);

    // A session from the superseded generation cannot resume (fenced).
    await db.update(contactImportSessionsTable).set({ status: "Failed" }).where(eq(contactImportSessionsTable.id, first.body.id));
    const stale = await runImport(organization.id, campaign.id, "phone,name\n+15550000001,Ada\n", { key: `${slug}-one` });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.code, "fenced");

    // Only one import can process at a time.
    const init = await initializeContactImport({ organizationId: organization.id, campaignId: campaign.id, idempotencyKey: `${slug}-blocking`, fileName: "x.csv", phoneColumn: "phone" });
    assert.ok(init.ok);
    const concurrent = await runImport(organization.id, campaign.id, "phone\n+15550000004\n", { key: `${slug}-concurrent` });
    assert.equal(concurrent.statusCode, 409);
    assert.equal(concurrent.body.code, "import_in_progress");
    assert.equal((await audience(organization.id, campaign.id)).body.importInProgress, true);
    await db.update(contactImportSessionsTable).set({ status: "Failed" }).where(eq(contactImportSessionsTable.idempotencyKey, `${slug}-blocking`));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("a batch that lost its generation fence mid-stream is refused and the session fails without touching the new audience", async () => {
  const slug = `fence-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const campaign = await createCampaign(organization.id, slug);
    // Start an append in generation 0, then (between chunks) activate a
    // replace generation underneath it. Its next batch must be fenced.
    let flipped = false;
    const chunkA = Buffer.from(`phone,name\n${Array.from({ length: 600 }, (_, i) => `+1555${String(i + 1).padStart(7, "0")},A${i}`).join("\n")}\n`);
    const chunkB = Buffer.from(`${Array.from({ length: 10 }, (_, i) => `+1556${String(i + 1).padStart(7, "0")},B${i}`).join("\n")}\n`);
    async function* body() {
      yield chunkA;
      // The first batch (500 rows) flushed during chunkA; now simulate a
      // concurrent replace activating before the next batch commits.
      if (!flipped) {
        flipped = true;
        await db.update(campaignsTable).set({ audienceGeneration: 5 }).where(eq(campaignsTable.id, campaign.id));
      }
      yield chunkB;
    }
    // A plain async iterable (not Readable.from, which reads ahead and would
    // run the flip before the first batch is flushed).
    const req: Record<string | symbol, unknown> = { [Symbol.asyncIterator]: body };
    Object.assign(req, {
      log: noopLog,
      authUser: { id: 1 },
      params: { organizationId: String(organization.id), campaignId: String(campaign.id) },
      headers: { "idempotency-key": `${slug}-append`, "x-file-name": "a.csv", "x-phone-column": "phone" },
    });
    const res = fakeResponse();
    await importHandler(req, res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "fenced");
    const [session] = await db.select().from(contactImportSessionsTable).where(eq(contactImportSessionsTable.idempotencyKey, `${slug}-append`));
    assert.equal(session!.status, "Failed");
    const rows = await contactsOf(campaign.id);
    assert.equal(rows.length, 500, "only the batch committed before the flip landed");
    assert.ok(rows.every((r) => r.audienceGeneration === 0));
    assert.equal((await campaignRow(campaign.id)).audienceSize, 0, "a fenced upload never completes");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

/* ------------------------------------------------------------------ */
/* Lifecycle: reopen, execution history, setup after import            */
/* ------------------------------------------------------------------ */

async function plannableCampaign(organization: { id: number }, slug: string) {
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba!.id, phone: `+1555${String(organization.id).padStart(4, "0")}123`, displayName: slug, status: "Connected", tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba!.id, name: `${slug}-tpl`, status: "Approved", body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const campaign = await createCampaign(organization.id, slug);
  await db.insert(campaignRoutesTable).values({ organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone!.id, templateId: template!.id, configuredTps: 5 });
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization.id, campaignId: campaign.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({ organizationId: organization.id, campaignId: campaign.id, templateId: template!.id, component: "body", variable: "1", source: "csv", sourceValue: "name" });
  return { campaign, phone: phone!, template: template! };
}

test("Ready without execution history: import requires reopen; reopen supersedes the plan; after execution the audience is frozen (including Paused)", async () => {
  const slug = `reopen-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const { campaign, phone, template } = await plannableCampaign(organization, slug);
    const first = await runImport(organization.id, campaign.id, "phone,name\n+15550000001,Ada\n+15550000002,Bob\n", { key: `${slug}-one` });
    assert.equal(first.statusCode, 202, JSON.stringify(first.body));
    const planned = await planCampaign(organization.id, campaign.id);
    assert.equal(planned.allocated, 2);
    assert.equal((await campaignRow(campaign.id)).status, "Ready");

    const blocked = await runImport(organization.id, campaign.id, "phone,name\n+15550000003,Cy\n", { key: `${slug}-two` });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.code, "reopen_required");
    const summary = await audience(organization.id, campaign.id);
    assert.equal(summary.body.reopenRequired, true);
    assert.equal(summary.body.editable, false);

    // Reopen through the actions endpoint.
    const reopenRes = fakeResponse();
    await actionsHandler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { action: "reopen" }, authUser: { id: 7 } }, reopenRes);
    assert.equal(reopenRes.statusCode, 200, JSON.stringify(reopenRes.body));
    assert.equal(reopenRes.body.status, "Draft");
    const plans = await db.select().from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaign.id));
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.status, "Superseded", "the stale plan is invalidated, not deleted");
    const allocations = await db.select().from(campaignAllocationsTable).where(eq(campaignAllocationsTable.campaignId, campaign.id));
    assert.equal(allocations.length, 2, "allocation history preserved");
    const audit = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, campaign.id), eq(campaignAuditTable.action, "reopen")));
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actorUserId, 7);
    // Idempotent on Draft.
    const again = await reopenCampaign(organization.id, campaign.id);
    assert.equal(again.changed, false);

    const appended = await runImport(organization.id, campaign.id, "phone,name\n+15550000003,Cy\n", { key: `${slug}-two` });
    assert.equal(appended.statusCode, 202, JSON.stringify(appended.body));
    const replanned = await planCampaign(organization.id, campaign.id);
    assert.equal(replanned.plan.version, 2);
    assert.equal(replanned.allocated, 3);

    // Setup edits after import, while Ready: allowed, plan superseded, back to Draft.
    const routeRes = fakeResponse();
    await createRouteHandler({
      organizationId: organization.id, role: "admin", authUser: { id: 7 },
      body: { campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 3 },
    }, routeRes);
    assert.equal(routeRes.statusCode, 201, JSON.stringify(routeRes.body));
    assert.equal((await campaignRow(campaign.id)).status, "Draft");
    const [activeAfterSetup] = await db.select().from(campaignPlansTable).where(and(eq(campaignPlansTable.campaignId, campaign.id), eq(campaignPlansTable.status, "Active")));
    assert.equal(activeAfterSetup, undefined, "a setup change invalidates the stale plan");
    assert.equal((await contactsOf(campaign.id)).length, 3, "imported recipients untouched by setup edits");
    await db.delete(campaignRoutesTable).where(eq(campaignRoutesTable.id, routeRes.body.id));

    // Execute (creates jobs): the audience and setup are frozen from here on.
    await planCampaign(organization.id, campaign.id);
    await db.update(campaignsTable).set({ status: "Running" }).where(eq(campaignsTable.id, campaign.id));
    await db.insert(campaignJobsTable).values({
      organizationId: organization.id, campaignId: campaign.id, type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-job`, status: "Sent",
    });
    for (const status of ["Running", "Paused", "Completed"]) {
      await db.update(campaignsTable).set({ status }).where(eq(campaignsTable.id, campaign.id));
      const refused = await runImport(organization.id, campaign.id, "phone,name\n+15550000004,Dee\n", { key: `${slug}-${status}`, operation: "replace" });
      assert.equal(refused.statusCode, 409, status);
      assert.equal(refused.body.code, "not_draft", status);
      assert.equal((await campaignRow(campaign.id)).status, status, "never reset to Draft");
    }
    await db.update(campaignsTable).set({ status: "Ready" }).where(eq(campaignsTable.id, campaign.id));
    const readyWithHistory = await runImport(organization.id, campaign.id, "phone,name\n+15550000004,Dee\n", { key: `${slug}-ready-history` });
    assert.equal(readyWithHistory.body.code, "execution_history");
    const reopenRefused = fakeResponse();
    await actionsHandler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { action: "reopen" } }, reopenRefused);
    assert.equal(reopenRefused.statusCode, 409);
    assert.equal(reopenRefused.body.code, "execution_history");
    assert.equal((await campaignRow(campaign.id)).status, "Ready");
    const routeRefused = fakeResponse();
    await createRouteHandler({
      organizationId: organization.id, role: "admin", authUser: { id: 7 },
      body: { campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 3 },
    }, routeRefused);
    assert.equal(routeRefused.statusCode, 409);
    assert.equal(routeRefused.body.code, "execution_history");
    // Even a Draft with jobs (defensive) is frozen.
    await db.update(campaignsTable).set({ status: "Draft" }).where(eq(campaignsTable.id, campaign.id));
    const draftWithHistory = await runImport(organization.id, campaign.id, "phone,name\n+15550000004,Dee\n", { key: `${slug}-draft-history` });
    assert.equal(draftWithHistory.body.code, "execution_history");
    assert.equal((await audience(organization.id, campaign.id)).body.executionHistory, true);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("import and plan cannot interleave: whichever wins, the other is refused and the Ready campaign has every Valid contact allocated", async () => {
  const slug = `race-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const { campaign } = await plannableCampaign(organization, slug);
    const seed = await runImport(organization.id, campaign.id, "phone,name\n+15550000001,Ada\n", { key: `${slug}-seed` });
    assert.equal(seed.statusCode, 202);
    const csv = `phone,name\n${Array.from({ length: 1500 }, (_, i) => `+1555${String(i + 10).padStart(7, "0")},N${i}`).join("\n")}\n`;
    const [importRes, planOutcome] = await Promise.all([
      runImport(organization.id, campaign.id, csv, { key: `${slug}-big` }),
      planCampaign(organization.id, campaign.id).then(() => "planned" as const, (error: Error) => error.message),
    ]);
    const final = await campaignRow(campaign.id);
    if (importRes.statusCode === 202) {
      // Import won the lock: plan must have refused (import processing) or
      // run after completion (then every Valid contact is allocated).
      if (planOutcome === "planned") {
        const [{ allocated }] = await db.select({ allocated: sql<number>`count(*)::int` }).from(campaignAllocationsTable).where(eq(campaignAllocationsTable.campaignId, campaign.id));
        assert.equal(allocated, 1501);
        assert.equal(final.status, "Ready");
      } else {
        assert.match(planOutcome, /import is still processing/);
        assert.equal(final.status, "Draft");
      }
    } else {
      assert.equal(importRes.statusCode, 409, JSON.stringify(importRes.body));
      assert.equal(importRes.body.code, "reopen_required");
      assert.equal(planOutcome, "planned");
      assert.equal(final.status, "Ready");
    }
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("contacts/search pages a multi-session audience by id without repeating or skipping rows", async () => {
  const slug = `page-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const campaign = await createCampaign(organization.id, slug);
    for (let s = 0; s < 3; s++) {
      const csv = `phone\n${Array.from({ length: 7 }, (_, i) => `+1555${String(s * 100 + i + 1).padStart(7, "0")}`).join("\n")}\n`;
      const res = await runImport(organization.id, campaign.id, csv, { key: `${slug}-${s}` });
      assert.equal(res.statusCode, 202);
    }
    const seen: number[] = [];
    let after: number | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const res = fakeResponse();
      await searchHandler({ params: { organizationId: String(organization.id), campaignId: String(campaign.id) }, body: { after, limit: 5 } }, res);
      seen.push(...res.body.items.map((row: { id: number }) => row.id));
      if (res.body.nextCursor === null) break;
      after = res.body.nextCursor;
    }
    assert.equal(seen.length, 21);
    assert.equal(new Set(seen).size, 21);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("duplicates across batch boundaries are classified, and resuming an interrupted upload never double-counts or duplicates audit rows", async () => {
  const slug = `resume-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const campaign = await createCampaign(organization.id, slug);
    // 1,200 data rows; row 900 repeats row 10's number (different batch).
    const lines = Array.from({ length: 1200 }, (_, i) => `+1555${String(i + 1).padStart(7, "0")},N${i}`);
    lines[898] = `+1555${String(9).padStart(7, "0")},repeat-of-row-10`;
    const full = Buffer.from(`phone,name\n${lines.join("\n")}\n`);
    const cut = full.indexOf(Buffer.from(`N700\n`)) + 5;
    const headers = { "idempotency-key": `${slug}-key`, "x-file-name": "big.csv", "x-phone-column": "phone" };
    const params = { organizationId: String(organization.id), campaignId: String(campaign.id) };

    async function* interrupted() {
      yield full.subarray(0, cut);
      throw new Error("client disconnected");
    }
    const first = fakeResponse();
    await importHandler(Object.assign({ [Symbol.asyncIterator]: interrupted }, { log: noopLog, authUser: { id: 1 }, params, headers }), first);
    assert.equal(first.statusCode, 400);
    const [interruptedSession] = await db.select().from(contactImportSessionsTable).where(eq(contactImportSessionsTable.idempotencyKey, `${slug}-key`));
    assert.equal(interruptedSession!.status, "Failed");
    assert.equal(interruptedSession!.rowsProcessed, 501, "only the flushed batch is recorded");
    const summary = await audience(organization.id, campaign.id);
    assert.equal(summary.body.totals.sessions, 0, "an interrupted upload is not part of the audience");

    async function* whole() { yield full; }
    const resumed = fakeResponse();
    await importHandler(Object.assign({ [Symbol.asyncIterator]: whole }, { log: noopLog, authUser: { id: 1 }, params, headers }), resumed);
    assert.equal(resumed.statusCode, 202, JSON.stringify(resumed.body));
    assert.equal(resumed.body.id, interruptedSession!.id);
    assert.equal(resumed.body.validRows, 1199);
    assert.equal(resumed.body.duplicateRows, 1);
    const contacts = await contactsOf(campaign.id);
    assert.equal(contacts.length, 1199);
    const occurrences = await db.select().from(contactImportOccurrencesTable).where(eq(contactImportOccurrencesTable.importSessionId, resumed.body.id));
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0]!.rowNumber, 900);
    assert.equal(occurrences[0]!.canonicalRowNumber, 10);
    assert.equal(occurrences[0]!.classification, "duplicate_in_import");

    // A second replay of the completed key changes nothing.
    const replay = fakeResponse();
    await importHandler(Object.assign({ [Symbol.asyncIterator]: whole }, { log: noopLog, authUser: { id: 1 }, params, headers }), replay);
    assert.equal(replay.statusCode, 202);
    assert.equal((await contactsOf(campaign.id)).length, 1199);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("cancelling the campaign during a replace fences the upload and leaves the previous audience in place", async () => {
  const slug = `cancel-replace-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const campaign = await createCampaign(organization.id, slug);
    const seed = await runImport(organization.id, campaign.id, "phone\n+15550000001\n+15550000002\n", { key: `${slug}-seed` });
    assert.equal(seed.statusCode, 202);
    const chunkA = Buffer.from(`phone\n${Array.from({ length: 600 }, (_, i) => `+1557${String(i + 1).padStart(7, "0")}`).join("\n")}\n`);
    const chunkB = Buffer.from("+15580000001\n");
    const params = { organizationId: String(organization.id), campaignId: String(campaign.id) };
    async function* body() {
      yield chunkA;
      const cancel = fakeResponse();
      await actionsHandler({ params, body: { action: "cancel" }, authUser: { id: 1 } }, cancel);
      assert.equal(cancel.statusCode, 200, JSON.stringify(cancel.body));
      yield chunkB;
    }
    const res = fakeResponse();
    await importHandler(Object.assign({ [Symbol.asyncIterator]: body }, {
      log: noopLog, authUser: { id: 1 }, params,
      headers: { "idempotency-key": `${slug}-replace`, "x-file-name": "r.csv", "x-phone-column": "phone", "x-import-operation": "replace" },
    }), res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    const row = await campaignRow(campaign.id);
    assert.equal(row.status, "Cancelled");
    assert.equal(row.audienceGeneration, 0, "the staged generation never activated");
    assert.equal(row.audienceSize, 2);
    const [session] = await db.select().from(contactImportSessionsTable).where(eq(contactImportSessionsTable.idempotencyKey, `${slug}-replace`));
    assert.equal(session!.status, "Failed");
    assert.equal(session!.activatedAt, null);
    const summary = await audience(organization.id, campaign.id);
    assert.deepEqual(summary.body.totals, { rows: 2, valid: 2, invalid: 0, duplicates: 0, suppressed: 0, sessions: 1 });
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("audience mutations require a campaign-management role; reads require membership only", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guards = (router: any, path: string, method: string): string[] => {
    for (const layer of router.stack) {
      if (layer.route?.path === path && layer.route.methods[method]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return layer.route.stack.slice(0, -1).map((entry: any) => entry.name);
      }
    }
    throw new Error(`missing ${path}`);
  };
  const base = "/organizations/:organizationId/campaigns/:campaignId";
  const mutations: [string, string][] = [[`${base}/imports`, "post"], [`${base}/actions`, "post"]];
  for (const [path, method] of mutations) {
    const names = guards(campaignEngineRouter, path, method);
    assert.equal(names.length, 4, `${method} ${path}: requireAuth, attachOrgContext, requireActiveOrganization, requireRole`);
  }
  for (const path of [`${base}/imports/sniff`, `${base}/audience`, `${base}/imports/:importSessionId/duplicates.csv`]) {
    const names = guards(campaignEngineRouter, path, path.endsWith("sniff") ? "post" : "get");
    assert.equal(names.length, 3, `${path}: membership only (no role gate)`);
  }
  assert.equal(guards(campaignsRouter, "/campaigns", "post").length, 3, "create: auth + org + role");
  assert.equal(guards(campaignsRouter, "/campaigns/:campaignId", "patch").length, 3, "patch: auth + org + role");
});
