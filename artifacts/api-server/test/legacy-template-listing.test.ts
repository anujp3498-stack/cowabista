// V2-04 acceptance correction: the legacy (shared connector) template
// listing must be complete and validated BEFORE the sync's transaction
// marks anything Removed or unsendable. Fake connector transport only; the
// credential source (connector proxy) is unchanged in production.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, organizationsTable, providerConnectionsTable, templateEligibilityTable, templatesTable, wabasTable } from "@workspace/db";
import { collectValidatedPages, isMetaTemplateRow, MAX_PROVIDER_PAGES, ProviderRequestError, RealWhatsAppProviderClient, type ConnectorTransport } from "../src/services/whatsapp-provider";
import { syncWhatsApp } from "../src/services/whatsapp-sync";

type Tpl = { id: string; name: string; language: string; category?: string; status?: string; components?: unknown };
const T1: Tpl = { id: "lg-1", name: "legacy_one", language: "en_US", category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: "One" }] };
const T2: Tpl = { id: "lg-2", name: "legacy_two", language: "en_US", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Two" }] };

/** Fake connector: identity + phone list + a scripted template listing. `script(pageIndex)` returns the JSON body (or throws). */
function fakeConnector(options: { wabaId: string; script: (page: number, path: string) => unknown; status?: (page: number) => number; recorded?: string[] }): ConnectorTransport {
  return async (path) => {
    options.recorded?.push(path);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path.startsWith("/v23.0/me")) return json(200, { id: "connector-acct" });
    if (path.includes("/phone_numbers")) return json(200, { data: [], paging: { cursors: {} } });
    if (path.includes("/message_templates")) {
      const after = new URL(`https://x${path}`).searchParams.get("after");
      const page = after ? Number(after.replace("c", "")) : 0;
      const status = options.status?.(page) ?? 200;
      const body = options.script(page, path);
      return json(status, body);
    }
    return json(404, { error: { message: "unknown", code: 100 } });
  };
}
const nextPage = (page: number, wabaId: string) => ({ cursors: { after: `c${page + 1}` }, next: `https://graph.facebook.com/v23.0/${wabaId}/message_templates?access_token=SECRET-TOKEN&after=c${page + 1}` });

async function fixture() {
  const slug = `legacy-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const wabaId = `${slug}-waba`;
  await db.insert(providerConnectionsTable).values({ organizationId: org.id, provider: "whatsapp-business", mode: "real", status: "configured", connectorAccountId: "connector-acct", configuredWabaExternalId: wabaId });
  const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: wabaId, displayName: wabaId }).returning();
  const sync = (transport: ConnectorTransport) => syncWhatsApp(org.id, { client: new RealWhatsAppProviderClient({ transport }) });
  const rows = async () => db.select().from(templatesTable).where(eq(templatesTable.organizationId, org.id)).orderBy(templatesTable.providerTemplateId);
  const evidence = async () => db.select().from(templateEligibilityTable).where(eq(templateEligibilityTable.organizationId, org.id)).orderBy(templateEligibilityTable.templateId);
  const connection = async () => (await db.select().from(providerConnectionsTable).where(eq(providerConnectionsTable.organizationId, org.id)))[0];
  const snapshot = async () => JSON.stringify({ t: (await rows()).map(({ updatedAt: _u, ...r }) => r), e: (await evidence()).map(({ updatedAt: _u, ...r }) => r) });
  return { org, waba, wabaId, sync, rows, evidence, connection, snapshot, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

after(async () => { const { pool } = await import("@workspace/db"); await pool.end(); });

test("7+8. complete valid multi-page listing applies evidence through the legacy path; a complete valid empty listing removes eligibility for templates actually absent; recovery works", async () => {
  const f = await fixture();
  try {
    const recorded: string[] = [];
    await f.sync(fakeConnector({ wabaId: f.wabaId, recorded, script: (page) => (page === 0 ? { data: [T1], paging: nextPage(0, f.wabaId) } : { data: [T2], paging: { cursors: {} } }) }));
    assert.deepEqual((await f.rows()).map((r) => [r.providerTemplateId, r.status]), [["lg-1", "Approved"], ["lg-2", "Approved"]]);
    const evidence = await f.evidence();
    assert.deepEqual(evidence.map((e) => [e.evidenceSource, e.sendable, e.providerMissing]), [["legacy_connector", true, false], ["legacy_connector", true, false]]);
    assert.ok(recorded.some((p) => p.includes("after=c1")), "the next page was followed by its path only");
    assert.ok(!recorded.some((p) => p.includes("SECRET-TOKEN")) || recorded.every((p) => !p.startsWith("https://")), "no absolute paging URL is used as a request target");
    assert.equal((await f.connection()).health, "healthy");

    // Genuine complete empty listing: both templates are absent -> their
    // ELIGIBILITY is removed (evidence unsendable, provider missing). The
    // legacy sync has never rewritten the templates row itself for absent
    // templates (a pre-existing gap recorded in the plan); the shared
    // decision fails closed on the evidence row regardless.
    await f.sync(fakeConnector({ wabaId: f.wabaId, script: () => ({ data: [], paging: { cursors: {} } }) }));
    assert.deepEqual((await f.evidence()).map((e) => [e.sendable, e.providerMissing, e.status]), [[false, true, "Removed"], [false, true, "Removed"]]);
    const { decidePair, loadCompatibilityState } = await import("../src/services/template-eligibility");
    const [phone] = await db.insert((await import("@workspace/db")).phoneNumbersTable).values({ organizationId: f.org.id, wabaId: f.waba.id, phone: "+15550007001", providerPhoneId: `${f.wabaId}-pn`, displayName: "P", status: "Connected", tpsLimit: 80 }).returning();
    const absentState = await loadCompatibilityState(f.org.id, { phoneIds: [phone.id], templateIds: (await f.rows()).map((r) => r.id) });
    for (const row of await f.rows()) assert.equal(decidePair(absentState, phone.id, row.id).code, "evidence_not_sendable", `${row.providerTemplateId} is not sendable after a valid empty listing`);
    // Recovery: Meta lists them again.
    await f.sync(fakeConnector({ wabaId: f.wabaId, script: () => ({ data: [T1, T2], paging: { cursors: {} } }) }));
    assert.deepEqual((await f.evidence()).map((e) => [e.sendable, e.providerMissing]), [[true, false], [true, false]]);
    const backState = await loadCompatibilityState(f.org.id, { phoneIds: [phone.id], templateIds: (await f.rows()).map((r) => r.id) });
    for (const row of await f.rows()) assert.equal(decidePair(backState, phone.id, row.id).code, "eligible", `${row.providerTemplateId} is sendable again`);
  } finally { await f.cleanup(); }
});

test("1-6. missing data, non-array data, malformed row, failed/malformed later page, repeated pagination state and page-cap exhaustion each fail the whole listing: templates, evidence and removal flags unchanged, connection records a safe failure", async () => {
  const f = await fixture();
  try {
    await f.sync(fakeConnector({ wabaId: f.wabaId, script: () => ({ data: [T1, T2], paging: { cursors: {} } }) }));
    const before = await f.snapshot();
    const cases: Array<[string, Parameters<typeof fakeConnector>[0]["script"], ((page: number) => number) | undefined, RegExp]> = [
      ["missing data", () => ({ paging: { cursors: {} } }), undefined, /without a data array/],
      ["non-array data", () => ({ data: { lg: T1 } }), undefined, /without a data array/],
      ["malformed row", () => ({ data: [T1, { id: 7, name: null }], paging: { cursors: {} } }), undefined, /malformed listing row/],
      ["valid first page, failed later page", (page) => (page === 0 ? { data: [T1], paging: nextPage(0, f.wabaId) } : { error: { message: "down", code: 2 } }), (page) => (page === 0 ? 200 : 500), /down|HTTP 500/],
      ["valid first page, malformed later page", (page) => (page === 0 ? { data: [T1], paging: nextPage(0, f.wabaId) } : { data: [{ id: "x" }], paging: { cursors: {} } }), undefined, /malformed listing row/],
      ["repeated cursor", () => ({ data: [T1], paging: { cursors: { after: "c1" }, next: `https://graph.facebook.com/v23.0/${f.wabaId}/message_templates?after=c1` } }), undefined, /pagination state repeated/],
      ["next link without cursor", () => ({ data: [T1], paging: { next: "https://graph.facebook.com/v23.0/x?after=c9", cursors: {} } }), undefined, /no cursor/],
      ["page cap exhausted", (page) => ({ data: [{ ...T1, id: `lg-p${page}` }], paging: { cursors: { after: `c${page + 1}` }, next: `https://graph.facebook.com/v23.0/${f.wabaId}/message_templates?after=c${page + 1}` } }), undefined, new RegExp(`more than ${MAX_PROVIDER_PAGES} pages`)],
    ];
    for (const [label, script, status, pattern] of cases) {
      await assert.rejects(f.sync(fakeConnector({ wabaId: f.wabaId, script, status })), pattern, label);
      assert.equal(await f.snapshot(), before, `${label}: templates and evidence unchanged`);
      const connection = await f.connection();
      assert.equal(connection.health, "unhealthy", label);
      assert.ok(connection.lastError && !connection.lastError.includes("SECRET-TOKEN"), `${label}: no paging URL/token in the recorded error`);
    }
    // Direct client behaviour: cancellation and no URL leakage in errors.
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    await assert.rejects(new RealWhatsAppProviderClient({ transport: fakeConnector({ wabaId: f.wabaId, script: () => ({ data: [] }) }) }).listTemplates(f.wabaId, controller.signal), /cancelled by caller/);
    try {
      await collectValidatedPages(async () => ({ data: [T1], paging: { next: `https://graph.facebook.com/v23.0/x?access_token=SECRET-TOKEN&after=c1`, cursors: { after: "c1" } } }), "/v23.0/x?after=c1", isMetaTemplateRow);
      assert.fail("expected repeated-state refusal");
    } catch (error) {
      assert.ok(error instanceof ProviderRequestError);
      assert.ok(!error.message.includes("SECRET-TOKEN"));
      assert.equal(error.code, "incomplete_listing");
    }
    // After the failures, a valid listing still recovers.
    await f.sync(fakeConnector({ wabaId: f.wabaId, script: () => ({ data: [T1, T2], paging: { cursors: {} } }) }));
    assert.equal((await f.connection()).health, "healthy");
    assert.equal((await db.select().from(templatesTable).where(and(eq(templatesTable.organizationId, f.org.id), eq(templatesTable.status, "Approved")))).length, 2);
  } finally { await f.cleanup(); }
});
