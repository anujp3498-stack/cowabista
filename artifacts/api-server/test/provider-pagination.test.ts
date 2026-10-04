// Pagination termination (V2-04 close-out). Reference: Meta's own SDK,
// facebook-python-business-sdk facebook_business/api.py,
// Cursor.load_next_page: "'after' will always exist even if no more pages
// are available"; continuation requires paging.next. Exercises the shared
// page walk directly and through both clients (legacy connector transport
// and workspace-credential fetch). Every fake FAILS if a request arrives
// after the terminal page, so an unnecessary request cannot hide behind a
// fake empty response. No database.

import assert from "node:assert/strict";
import { test } from "node:test";
import { collectValidatedPages, isMetaTemplateRow, MAX_PROVIDER_PAGES, ProviderRequestError, RealWhatsAppProviderClient, type ConnectorTransport } from "../src/services/whatsapp-provider";
import { ManualMetaClient, type FetchLike } from "../src/services/whatsapp-manual-client";

const TOKEN = "EAAG-pager-token";
const WABA = "waba-pager";
const row = (id: string) => ({ id, name: `t_${id}`, language: "en_US", category: "MARKETING", status: "APPROVED", components: [{ type: "BODY", text: "Hi" }] });
const NEXT = (after: string) => `https://graph.facebook.com/v23.0/${WABA}/message_templates?access_token=SECRET&after=${after}`;

/** Scripted pages keyed by the `after` cursor the request carries ("" = first page). Requests beyond the script throw. */
function script(pages: Record<string, unknown>) {
  const requests: string[] = [];
  const serve = (path: string): unknown => {
    requests.push(path);
    const after = new URL(`https://x/${path.replace(/^\//, "")}`).searchParams.get("after") ?? "";
    if (!(after in pages)) throw new Error(`UNEXPECTED REQUEST after the terminal page: ${path}`);
    const page = pages[after];
    delete pages[after]; // a second request for the same page is also unexpected
    return page;
  };
  return { requests, serve };
}
const viaHelper = (pages: Record<string, unknown>) => {
  const s = script(pages);
  return { requests: s.requests, run: () => collectValidatedPages(async (path) => s.serve(path), `/v23.0/${WABA}/message_templates?fields=id&limit=100`, isMetaTemplateRow) };
};
const viaLegacy = (pages: Record<string, unknown>) => {
  const s = script(pages);
  const transport: ConnectorTransport = async (path) => new Response(JSON.stringify(s.serve(path)), { status: 200, headers: { "content-type": "application/json" } });
  return { requests: s.requests, run: () => new RealWhatsAppProviderClient({ transport }).listTemplates(WABA) };
};
const viaManual = (pages: Record<string, unknown>) => {
  const s = script(pages);
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!url.includes("SECRET"), "never requests a copied paging URL");
    const parsed = new URL(url);
    return new Response(JSON.stringify(s.serve(`${parsed.pathname}${parsed.search}`)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests: s.requests, run: () => new ManualMetaClient({ accessToken: TOKEN, fetchImpl }).listTemplates(WABA) };
};
const drivers = { helper: viaHelper, legacy: viaLegacy, manual: viaManual } as const;
const many = (count: number, terminalKeepsAfter: boolean, lastAdvertisesNext = false) => {
  const pages: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    const key = i === 0 ? "" : `c${i}`;
    const last = i === count - 1;
    pages[key] = last && !lastAdvertisesNext
      ? { data: [row(`r${i}`)], paging: terminalKeepsAfter ? { cursors: { before: "b", after: `c${i + 1}` } } : { cursors: {} } }
      : { data: [row(`r${i}`)], paging: { cursors: { before: "b", after: `c${i + 1}` }, next: NEXT(`c${i + 1}`) } };
  }
  return pages;
};

for (const [name, drive] of Object.entries(drivers)) {
  test(`${name}: A. one terminal page with a non-empty after cursor and no next -> exactly one request`, async () => {
    const d = drive({ "": { data: [row("a"), row("b")], paging: { cursors: { before: "x", after: "LAST" } } } });
    assert.deepEqual((await d.run()).map((r) => r.id), ["a", "b"]);
    assert.equal(d.requests.length, 1);
  });
  test(`${name}: B. several pages, final page keeps after but omits next -> exactly the required requests, every row once`, async () => {
    const d = drive(many(3, true));
    assert.deepEqual((await d.run()).map((r) => r.id), ["r0", "r1", "r2"]);
    assert.equal(d.requests.length, 3);
    assert.ok(d.requests[1].includes("after=c1") && d.requests[2].includes("after=c2"));
    assert.ok(d.requests.every((p) => !p.includes("SECRET")), "the cursor rides the original request path, never the provider URL");
  });
  test(`${name}: C. empty page with next + valid after -> later pages are still fetched`, async () => {
    const d = drive({ "": { data: [], paging: { cursors: { after: "c1" }, next: NEXT("c1") } }, c1: { data: [row("late")], paging: { cursors: { after: "c2" } } } });
    assert.deepEqual((await d.run()).map((r) => r.id), ["late"]);
    assert.equal(d.requests.length, 2);
  });
  test(`${name}: D. terminal page exactly at the cap (${MAX_PROVIDER_PAGES}) keeping after but no next -> succeeds`, async () => {
    const d = drive(many(MAX_PROVIDER_PAGES, true));
    assert.equal((await d.run()).length, MAX_PROVIDER_PAGES);
    assert.equal(d.requests.length, MAX_PROVIDER_PAGES);
  });
  test(`${name}: E. page ${MAX_PROVIDER_PAGES} with next + valid after -> rejected, more pages remain, no further request`, async () => {
    const pages = many(MAX_PROVIDER_PAGES, true, true);
    pages[`c${MAX_PROVIDER_PAGES}`] = { data: [row("never")], paging: { cursors: {} } };
    const d = drive(pages);
    await assert.rejects(d.run(), (e: ProviderRequestError) => e.code === "incomplete_listing" && new RegExp(`more than ${MAX_PROVIDER_PAGES} pages`).test(e.message));
    assert.equal(d.requests.length, MAX_PROVIDER_PAGES);
  });
  test(`${name}: F. next without a usable after -> rejected without a further request`, async () => {
    for (const cursors of [{}, { after: "" }, { after: 7 }, undefined]) {
      const d = drive({ "": { data: [row("a")], paging: { next: NEXT("c1"), cursors } } });
      await assert.rejects(d.run(), (e: ProviderRequestError) => e.code === "incomplete_listing" && /no cursor/.test(e.message) && !e.message.includes("SECRET"));
      assert.equal(d.requests.length, 1);
    }
  });
  test(`${name}: G. repeated advertised continuation -> rejected`, async () => {
    const d = drive({ "": { data: [row("a")], paging: { cursors: { after: "c1" }, next: NEXT("c1") } }, c1: { data: [row("b")], paging: { cursors: { after: "c1" }, next: NEXT("c1") } } });
    await assert.rejects(d.run(), /pagination state repeated/);
    assert.equal(d.requests.length, 2);
  });
  test(`${name}: malformed continuation metadata is a failure, never a completion`, async () => {
    for (const paging of [{ next: 42, cursors: { after: "c1" } }, { next: { url: "x" }, cursors: { after: "c1" } }, "nope", null]) {
      const d = drive({ "": { data: [row("a")], paging } });
      await assert.rejects(d.run(), (e: ProviderRequestError) => e.code === "incomplete_listing" && /malformed/.test(e.message), JSON.stringify(paging));
      assert.equal(d.requests.length, 1);
    }
    for (const body of [{ data: null, paging: {} }, { paging: {} }, { data: [row("a"), { id: 1 }], paging: {} }]) {
      const d = drive({ "": body });
      await assert.rejects(d.run(), (e: ProviderRequestError) => e.code === "bad_listing");
    }
  });
}
