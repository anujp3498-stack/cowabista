import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV, credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import type { FetchLike } from "../src/services/whatsapp-manual-client";
import { connectManualNumber, revokeCredential } from "../src/services/whatsapp-manual-connection";
import {
  normalizeTemplateStatus,
  syncWabaTemplates,
  syncWorkspaceTemplates,
} from "../src/services/whatsapp-template-sync";
import whatsappManualRouter from "../src/routes/whatsapp-manual";

// V2-03A: per-workspace Meta template synchronisation against a fake Graph
// API. Nothing leaves the process; no template is ever created or changed
// at Meta.

const KEY = randomBytes(32).toString("base64");
const TOKEN = `EAAG-tpl-${randomBytes(20).toString("hex")}`;
const OTHER_TOKEN = `EAAG-tpl-other-${randomBytes(20).toString("hex")}`;

type MetaTpl = { id: string; name: string; language: string; category: string; status: string; components: Record<string, unknown>[] };
type Recorded = { url: string; method: string; auth?: string };

const PROMO: MetaTpl = {
  id: "tpl-1", name: "promo_sept_img", language: "en_US", category: "MARKETING", status: "APPROVED",
  components: [
    { type: "HEADER", format: "IMAGE", example: { header_handle: ["h"] } },
    { type: "BODY", text: "Hi {{1}}, your order {{2}} is ready.", example: { body_text: [["Alice", "ORD-1"]] } },
    { type: "FOOTER", text: "Reply STOP to opt out" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://example.test/{{1}}" }, { type: "QUICK_REPLY", text: "Stop" }] },
  ],
};
const PENDING: MetaTpl = { id: "tpl-2", name: "order_update_v2", language: "hi", category: "UTILITY", status: "PENDING", components: [{ type: "BODY", text: "Update {{1}}" }] };
const REJECTED: MetaTpl = { id: "tpl-3", name: "festive_video", language: "en_US", category: "MARKETING", status: "REJECTED", components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Festive!" }] };
const WEIRD: MetaTpl = { id: "tpl-4", name: "appeal_me", language: "en_GB", category: "AUTHENTICATION", status: "IN_APPEAL", components: [{ type: "BODY", text: "Code {{1}}" }] };

function fakeMeta(options: {
  pages?: MetaTpl[][];
  recorded?: Recorded[];
  token?: string;
  failPage?: number;
  failStatus?: number;
  failCode?: number;
  malformedPage?: number;
  gate?: Promise<void>;
  onArrive?: () => void;
  wabaId?: string;
}): FetchLike {
  const pages = options.pages ?? [[PROMO, PENDING, REJECTED, WEIRD]];
  return async (url, init) => {
    const headers = init.headers as Record<string, string>;
    options.recorded?.push({ url, method: init.method ?? "GET", auth: headers?.Authorization });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (headers?.Authorization !== `Bearer ${options.token ?? TOKEN}`) return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("/message_templates")) return json(404, { error: { message: "Unknown edge", code: 100 } });
    if (options.wabaId && !parsed.pathname.includes(`/${options.wabaId}/`)) return json(403, { error: { message: "Unsupported get request", code: 100 } });
    const after = parsed.searchParams.get("after");
    const index = after ? Number(after.replace("cursor-", "")) : 0;
    if (options.gate) { options.onArrive?.(); await options.gate; }
    if (options.failPage === index) return json(options.failStatus ?? 500, { error: { message: "Service temporarily unavailable", code: options.failCode ?? 2 } });
    if (options.malformedPage === index) return json(200, { nope: true });
    const data = pages[index] ?? [];
    const hasNext = index < pages.length - 1;
    return json(200, { data, paging: hasNext ? { cursors: { after: `cursor-${index + 1}` }, next: `${parsed.origin}${parsed.pathname}?after=cursor-${index + 1}` } : { cursors: {} } });
  };
}

async function fixture(options: { credentialStatus?: string; token?: string; externalId?: string } = {}) {
  const slug = `tpl-sync-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const token = options.token ?? TOKEN;
  const enc = encryptCredential(token, { organizationId: org.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: org.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(token), status: options.credentialStatus ?? "active",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: org.id, externalId: options.externalId ?? `waba-${slug}`, displayName: "Acme WABA", credentialId: credential.id }).returning();
  return { org, credential, waba, slug, cleanup: () => db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)) };
}

async function rows(organizationId: number) {
  return db.select().from(templatesTable).where(eq(templatesTable.organizationId, organizationId)).orderBy(templatesTable.providerTemplateId);
}

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = KEY; });
after(async () => {
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("status normalisation keeps provider fidelity and never promotes an unknown value", () => {
  assert.equal(normalizeTemplateStatus("APPROVED"), "Approved");
  assert.equal(normalizeTemplateStatus("pending"), "Pending");
  assert.equal(normalizeTemplateStatus("REJECTED"), "Rejected");
  assert.equal(normalizeTemplateStatus("PAUSED"), "Paused");
  assert.equal(normalizeTemplateStatus("DISABLED"), "Disabled");
  assert.equal(normalizeTemplateStatus("IN_APPEAL"), "In appeal");
  assert.equal(normalizeTemplateStatus("SOME_NEW_STATE"), "Some new state");
  assert.equal(normalizeTemplateStatus(undefined), "Unknown");
});

test("syncs every page with the workspace credential: bearer header only, faithful components, honest statuses, WABA ownership, idempotent", async () => {
  const f = await fixture();
  const recorded: Recorded[] = [];
  try {
    const first = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING], [REJECTED], [WEIRD]], recorded, wabaId: f.waba.externalId }) });
    assert.equal(first.status, "synced", JSON.stringify(first.error));
    assert.equal(first.templatesSeen, 4);
    assert.equal(first.templatesUpserted, 4);
    assert.equal(first.templatesMarkedRemoved, 0);
    assert.equal(recorded.length, 3, "all three pages were fetched");
    for (const call of recorded) {
      assert.equal(call.method, "GET");
      assert.equal(call.auth, `Bearer ${TOKEN}`);
      assert.ok(!call.url.includes(TOKEN));
      assert.ok(call.url.startsWith(`https://graph.facebook.com/v23.0/${f.waba.externalId}/message_templates?`));
      assert.ok(call.url.includes("fields=id%2Cname%2Clanguage%2Ccategory%2Cstatus%2Ccomponents"));
    }
    assert.ok(!JSON.stringify(first).includes(TOKEN));

    const stored = await rows(f.org.id);
    assert.equal(stored.length, 4);
    const byId = new Map(stored.map((row) => [row.providerTemplateId, row]));
    const promo = byId.get("tpl-1")!;
    assert.equal(promo.wabaId, f.waba.id);
    assert.equal(promo.organizationId, f.org.id);
    assert.equal(promo.status, "Approved");
    assert.equal(promo.category, "Marketing");
    assert.equal(promo.language, "en_US");
    assert.equal(promo.body, "Hi {{1}}, your order {{2}} is ready.");
    assert.deepEqual(promo.components, PROMO.components, "components are stored exactly as Meta returned them");
    assert.equal(promo.metadata.source, "workspace_credential");
    assert.equal(promo.metadata.providerStatus, "APPROVED");
    assert.equal(promo.metadata.providerMissing, false);
    assert.equal(promo.isSample, false);
    assert.ok(promo.lastSyncedAt);
    assert.equal(byId.get("tpl-2")!.status, "Pending");
    assert.equal(byId.get("tpl-2")!.category, "Utility");
    assert.equal(byId.get("tpl-2")!.language, "hi");
    assert.equal(byId.get("tpl-3")!.status, "Rejected");
    assert.deepEqual(byId.get("tpl-3")!.components, REJECTED.components);
    assert.equal(byId.get("tpl-4")!.status, "In appeal");
    assert.equal(byId.get("tpl-4")!.category, "Authentication");
    assert.ok(!JSON.stringify(stored).includes(TOKEN));

    // Second sync: same rows, no duplicates, Meta's new status wins.
    const again = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[{ ...PROMO, status: "PAUSED" }, PENDING, REJECTED, WEIRD]] }) });
    assert.equal(again.status, "synced");
    const second = await rows(f.org.id);
    assert.equal(second.length, 4);
    assert.equal(second.find((row) => row.providerTemplateId === "tpl-1")!.id, promo.id);
    assert.equal(second.find((row) => row.providerTemplateId === "tpl-1")!.status, "Paused");
    assert.ok(((await db.select().from(wabasTable).where(eq(wabasTable.id, f.waba.id)))[0]!.lastSyncedAt?.getTime() ?? 0) > 0, "WABA lastSyncedAt is updated");
  } finally { await f.cleanup(); }
});

test("a template Meta no longer returns is marked Removed with its history kept; it comes back when Meta returns it again", async () => {
  const f = await fixture();
  try {
    await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]] }) });
    const result = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PENDING]] }) });
    assert.equal(result.status, "synced");
    assert.equal(result.templatesMarkedRemoved, 1);
    const stored = await rows(f.org.id);
    assert.equal(stored.length, 2, "nothing is deleted");
    const removed = stored.find((row) => row.providerTemplateId === "tpl-1")!;
    assert.equal(removed.status, "Removed");
    assert.equal(removed.metadata.providerMissing, true);
    assert.equal(removed.metadata.statusBeforeRemoval, "Approved");
    assert.ok(removed.metadata.providerMissingSince);
    assert.deepEqual(removed.components, PROMO.components, "the frozen snapshot is still there for campaign history");
    // Not sendable any more (sender requires status Approved).
    assert.notEqual(removed.status, "Approved");
    // Reappears: status restored from Meta, flags cleared.
    const back = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]] }) });
    assert.equal(back.templatesMarkedRemoved, 0);
    const restored = (await rows(f.org.id)).find((row) => row.providerTemplateId === "tpl-1")!;
    assert.equal(restored.status, "Approved");
    assert.equal(restored.metadata.providerMissing, false);
    assert.equal(restored.id, removed.id);
    // Sample rows and locally created rows are never marked removed.
    await db.insert(templatesTable).values([
      { organizationId: f.org.id, wabaId: f.waba.id, name: "sample", body: "sample", status: "Approved", isSample: true, providerTemplateId: "sample-1" },
      { organizationId: f.org.id, wabaId: f.waba.id, name: "local", body: "local", status: "Pending" },
    ]);
    const third = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]] }) });
    assert.equal(third.templatesMarkedRemoved, 0);
  } finally { await f.cleanup(); }
});

test("failures change nothing locally: revoked credential (no request), code 190, 5xx, a failing later page, a malformed page", async () => {
  const f = await fixture();
  try {
    await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING, REJECTED]] }) });
    const snapshot = JSON.stringify((await rows(f.org.id)).map(({ updatedAt: _u, ...row }) => row));

    const expectUnchanged = async (label: string, fetchImpl: FetchLike, code: string, retryable?: boolean) => {
      const recorded: Recorded[] = [];
      const wrapped: FetchLike = (url, init) => { recorded.push({ url, method: init.method ?? "GET" }); return fetchImpl(url, init); };
      const result = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: wrapped });
      assert.equal(result.status, "failed", label);
      assert.equal(result.error?.code, code, `${label}: ${JSON.stringify(result.error)}`);
      if (retryable !== undefined) assert.equal(result.error?.retryable, retryable, label);
      assert.ok(!JSON.stringify(result).includes(TOKEN), label);
      assert.equal(JSON.stringify((await rows(f.org.id)).map(({ updatedAt: _u, ...row }) => row)), snapshot, `${label}: local templates unchanged`);
      return recorded;
    };

    await db.update(whatsappCredentialsTable).set({ status: "revoked" }).where(eq(whatsappCredentialsTable.id, f.credential.id));
    const revokedCalls = await expectUnchanged("revoked credential", fakeMeta({}), "credential_inactive");
    assert.equal(revokedCalls.length, 0, "no Meta request for a revoked credential");
    await db.update(whatsappCredentialsTable).set({ status: "active" }).where(eq(whatsappCredentialsTable.id, f.credential.id));

    await expectUnchanged("code 190", fakeMeta({ token: OTHER_TOKEN }), "credential_inactive");
    await expectUnchanged("5xx", fakeMeta({ failPage: 0, failStatus: 503 }), "provider_unavailable", true);
    await expectUnchanged("second page fails", fakeMeta({ pages: [[PROMO], [PENDING], [REJECTED]], failPage: 1, failStatus: 500 }), "provider_unavailable", true);
    await expectUnchanged("malformed page", fakeMeta({ pages: [[PROMO], [PENDING]], malformedPage: 1 }), "provider_unavailable", true);
    await expectUnchanged("forbidden", fakeMeta({ failPage: 0, failStatus: 403, failCode: 100 }), "provider_rejected", false);
  } finally { await f.cleanup(); }
});

test("a foreign WABA is unreachable through the organization, and a WABA without a credential is not synced with a token", async () => {
  const a = await fixture();
  const b = await fixture({ token: OTHER_TOKEN });
  try {
    const recorded: Recorded[] = [];
    const result = await syncWabaTemplates({ organizationId: a.org.id, wabaId: b.waba.id, fetchImpl: fakeMeta({ recorded, token: OTHER_TOKEN }) });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "waba_not_found");
    assert.equal(recorded.length, 0);
    assert.equal((await rows(b.org.id)).length, 0);

    const [legacy] = await db.insert(wabasTable).values({ organizationId: a.org.id, externalId: `legacy-${a.slug}`, displayName: "Legacy", credentialId: null }).returning();
    const noCredential = await syncWabaTemplates({ organizationId: a.org.id, wabaId: legacy.id, fetchImpl: fakeMeta({ recorded }) });
    assert.equal(noCredential.status, "failed");
    assert.equal(noCredential.error?.code, "credential_inactive");
    assert.equal(recorded.length, 0, "a legacy WABA is never sent through a workspace token");
  } finally { await a.cleanup(); await b.cleanup(); }
});

test("two concurrent syncs of one WABA serialise under the WABA lock: no duplicates, consistent final state", async () => {
  const f = await fixture();
  try {
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onArrive = () => { arrivals += 1; if (arrivals === 2) release(); };
    const [first, second] = await Promise.all([
      syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]], gate, onArrive }) }),
      syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]], gate, onArrive }) }),
    ]);
    assert.equal(first.status, "synced");
    assert.equal(second.status, "synced");
    const stored = await rows(f.org.id);
    assert.equal(stored.length, 2);
    assert.deepEqual(stored.map((row) => row.providerTemplateId), ["tpl-1", "tpl-2"]);
    assert.equal(stored.filter((row) => row.status === "Removed").length, 0);
  } finally { await f.cleanup(); }
});

test("workspace sync handles WABAs independently: A commits, B fails safely with its previous state intact", async () => {
  const f = await fixture();
  try {
    const [wabaB] = await db.insert(wabasTable).values({ organizationId: f.org.id, externalId: `waba-b-${f.slug}`, displayName: "Beta WABA", credentialId: f.credential.id }).returning();
    // B had templates from an earlier sync.
    await syncWabaTemplates({ organizationId: f.org.id, wabaId: wabaB.id, fetchImpl: fakeMeta({ pages: [[{ ...PENDING, id: "b-1", name: "beta_one" }]] }) });
    const bBefore = JSON.stringify((await db.select().from(templatesTable).where(eq(templatesTable.wabaId, wabaB.id))).map(({ updatedAt: _u, ...row }) => row));

    const perWaba: FetchLike = (url, init) => {
      const path = new URL(url).pathname;
      if (path.includes(`/${wabaB.externalId}/`)) return fakeMeta({ failPage: 0, failStatus: 500 })(url, init);
      return fakeMeta({ pages: [[PROMO, PENDING]] })(url, init);
    };
    const result = await syncWorkspaceTemplates({ organizationId: f.org.id, fetchImpl: perWaba });
    assert.equal(result.wabas.length, 2);
    const a = result.wabas.find((row) => row.wabaId === f.waba.id)!;
    const b = result.wabas.find((row) => row.wabaId === wabaB.id)!;
    assert.equal(a.status, "synced");
    assert.equal(a.templatesUpserted, 2);
    assert.equal(b.status, "failed");
    assert.equal(b.error?.code, "provider_unavailable");
    assert.equal(b.wabaDisplayName, "Beta WABA");
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.equal(JSON.stringify((await db.select().from(templatesTable).where(eq(templatesTable.wabaId, wabaB.id))).map(({ updatedAt: _u, ...row }) => row)), bBefore);
    assert.equal((await db.select().from(templatesTable).where(and(eq(templatesTable.wabaId, f.waba.id)))).length, 2);
  } finally { await f.cleanup(); }
});

test("a legacy organization with no credential WABAs and no connector configuration gets an empty, harmless result", async () => {
  const slug = `tpl-legacy-${process.pid}-${Date.now()}`;
  const [org] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  try {
    await db.insert(wabasTable).values({ organizationId: org.id, externalId: `legacy-${slug}`, displayName: "Legacy", credentialId: null });
    const recorded: Recorded[] = [];
    const result = await syncWorkspaceTemplates({ organizationId: org.id, fetchImpl: fakeMeta({ recorded }) });
    assert.deepEqual(result.wabas, []);
    assert.equal(recorded.length, 0);
  } finally { await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id)); }
});

test("route: owner/admin guard chain on the sync endpoint", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (whatsappManualRouter as any).stack.find((l: any) => l.route?.path === "/organizations/:organizationId/whatsapp/templates/sync");
  assert.ok(layer, "route registered");
  const names = layer.route.stack.map((s: { name: string }) => s.name);
  assert.deepEqual(names.slice(0, 3), ["requireAuth", "attachOrgContext", "requireActiveOrganization"]);
  assert.equal(layer.route.stack.length, 5);
  const { requireRole } = await import("../src/middlewares/auth");
  for (const role of ["manager", "agent"]) {
    let passed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = { statusCode: 200 };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = () => res;
    requireRole("admin")({ role } as never, res, () => { passed = true; });
    assert.equal(passed, false, `${role} cannot trigger a credential-backed sync`);
  }
});

test("UI static assertions: Template Center is provider-backed, read-only, sample-free, and hides IDs under Technical details", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = resolve(process.cwd(), "../wabista-nexus/src");
  const page = readFileSync(resolve(root, "pages/templates.tsx"), "utf8");
  const preview = readFileSync(resolve(root, "components/templates/template-preview-dialog.tsx"), "utf8");
  const rocket = readFileSync(resolve(root, "pages/rocket-campaigns.tsx"), "utf8");

  assert.match(page, /filter\(\(row\) => !row\.isSample\)/, "sample rows are never listed as real templates");
  assert.match(page, /data-testid="button-sync-templates"/);
  assert.match(page, /canSync = role === "owner" \|\| role === "admin"/, "sync is offered to owner/admin only");
  assert.match(page, /disabled=\{!canSync \|\| sync\.isPending\}/);
  assert.doesNotMatch(page, /useCreateTemplate|useUpdateTemplate|useDeleteTemplate|select-template-status|SelectItem value="Approved"/, "status and content are read-only");
  assert.doesNotMatch(page, /accessToken|input-connect-token|WABA ID|input-pn-waba/, "no token or WABA id entry on the template page");
  assert.match(page, /Create template \(coming soon\)/);
  assert.match(page, /EmptyState[\s\S]*ErrorState|ErrorState[\s\S]*EmptyState/);
  assert.match(page, /TableRowsSkeleton/);
  assert.match(preview, /TechnicalDetails/);
  assert.match(preview, /Provider template ID/);
  assert.doesNotMatch(page, /providerTemplateId/, "provider ids are not a list column");
  assert.match(preview, /data-testid="preview-body"/);
  assert.match(preview, /preview-button-/);
  assert.match(preview, /preview-media-header/);
  assert.match(rocket, /template\.status === "Approved" && !template\.isSample/);
});

// ---- V2-03A hardening -------------------------------------------------

test("pagination fails closed: page cap, next without cursor, repeated cursor and malformed rows never commit or cause removals", async () => {
  const f = await fixture();
  try {
    await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]] }) });
    const snapshot = JSON.stringify((await rows(f.org.id)).map(({ updatedAt: _u, ...row }) => row));
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const ok = (data: unknown[], paging: unknown) => json(200, { data, paging });
    const cases: Array<{ label: string; fetchImpl: FetchLike; maxRequests?: number }> = [
      {
        label: "next link without a cursor",
        fetchImpl: async () => ok([PROMO], { next: "https://graph.facebook.com/next", cursors: {} }),
      },
      {
        label: "cursor repeats",
        fetchImpl: async () => ok([PROMO], { next: "https://graph.facebook.com/next", cursors: { after: "same" } }),
        maxRequests: 2,
      },
      {
        label: "endless pages past the cap",
        fetchImpl: async (url) => {
          const after = new URL(url).searchParams.get("after") ?? "0";
          return ok([{ ...PROMO, id: `tpl-${after}` }], { next: "https://graph.facebook.com/next", cursors: { after: String(Number(after) + 1) } });
        },
      },
      { label: "malformed row (no id)", fetchImpl: async () => ok([{ name: "x", language: "en_US" }], {}) },
      { label: "malformed row (components not an array)", fetchImpl: async () => ok([{ ...PROMO, components: "BODY" }], {}) },
      { label: "data not an array", fetchImpl: async () => ok(undefined as unknown as unknown[], {}) },
    ];
    for (const item of cases) {
      let requests = 0;
      const counted: FetchLike = (url, init) => { requests += 1; return item.fetchImpl(url, init); };
      const result = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: counted });
      assert.equal(result.status, "failed", item.label);
      assert.equal(result.error?.code, "provider_unavailable", `${item.label}: ${JSON.stringify(result.error)}`);
      assert.equal(result.templatesMarkedRemoved, 0, item.label);
      if (item.maxRequests) assert.ok(requests <= item.maxRequests, `${item.label}: stopped after ${requests} requests`);
      assert.ok(!JSON.stringify(result).includes(TOKEN), item.label);
      assert.equal(JSON.stringify((await rows(f.org.id)).map(({ updatedAt: _u, ...row }) => row)), snapshot, `${item.label}: local templates and removal flags unchanged`);
    }
    const stored = await rows(f.org.id);
    assert.equal(stored.length, 2);
    assert.ok(stored.every((row) => row.status !== "Removed" && row.metadata.providerMissing === false));
  } finally { await f.cleanup(); }
});

test("a credential revoked, re-encrypted (revision bumped) or swapped on the WABA during the provider fetch never commits the fetched snapshot", async () => {
  const f = await fixture();
  try {
    await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]] }) });
    const snapshot = JSON.stringify((await rows(f.org.id)).map(({ updatedAt: _u, ...row }) => row));

    const during = async (label: string, mutate: () => Promise<void>, restore: () => Promise<void>) => {
      let arrive!: () => void;
      const arrived = new Promise<void>((resolve) => { arrive = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      // The fake provider answers with a listing that would mark tpl-2
      // removed and change tpl-1: none of it may land.
      const pending = syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[{ ...PROMO, status: "REJECTED" }]], gate, onArrive: arrive }) });
      await arrived; // the credential was already decrypted and the fetch is in flight
      await mutate();
      release();
      const result = await pending;
      assert.equal(result.status, "failed", label);
      assert.equal(result.error?.code, "credential_inactive", `${label}: ${JSON.stringify(result.error)}`);
      assert.ok(!JSON.stringify(result).includes(TOKEN), label);
      assert.equal(JSON.stringify((await rows(f.org.id)).map(({ updatedAt: _u, ...row }) => row)), snapshot, `${label}: nothing committed`);
      await restore();
    };

    await during(
      "revoked during fetch",
      async () => { await db.update(whatsappCredentialsTable).set({ status: "revoked" }).where(eq(whatsappCredentialsTable.id, f.credential.id)); },
      async () => { await db.update(whatsappCredentialsTable).set({ status: "active" }).where(eq(whatsappCredentialsTable.id, f.credential.id)); },
    );
    await during(
      "revision bumped during fetch",
      async () => { await db.update(whatsappCredentialsTable).set({ revision: 2 }).where(eq(whatsappCredentialsTable.id, f.credential.id)); },
      async () => { await db.update(whatsappCredentialsTable).set({ revision: 1 }).where(eq(whatsappCredentialsTable.id, f.credential.id)); },
    );
    const encB = encryptCredential(OTHER_TOKEN, { organizationId: f.org.id, kind: "manual_token", provider: "whatsapp-business" });
    const [replacement] = await db.insert(whatsappCredentialsTable).values({
      organizationId: f.org.id, tokenCiphertext: encB.ciphertext, tokenIv: encB.iv, tokenAuthTag: encB.authTag, keyVersion: encB.keyVersion,
      tokenFingerprint: credentialFingerprint(OTHER_TOKEN), status: "active",
    }).returning();
    await during(
      "WABA re-associated to another credential during fetch",
      async () => { await db.update(wabasTable).set({ credentialId: replacement.id }).where(eq(wabasTable.id, f.waba.id)); },
      async () => { await db.update(wabasTable).set({ credentialId: f.credential.id }).where(eq(wabasTable.id, f.waba.id)); },
    );
    // Sanity: with everything restored the same listing commits normally.
    const after = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[{ ...PROMO, status: "REJECTED" }]] }) });
    assert.equal(after.status, "synced");
    assert.equal(after.templatesMarkedRemoved, 1);
  } finally { await f.cleanup(); }
});

// ---- V2-03A.2: ordering and lock protocol -----------------------------

/** Deterministic: resolves once a backend is waiting on a row lock in the given table. */
async function untilLockWait(table: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query ilike ${`%${table}%`}
    `);
    if (Number(waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`no backend waited on a ${table} lock`);
}

function gated(pages: MetaTpl[][]) {
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { fetchImpl: fakeMeta({ pages, gate, onArrive: arrive }), arrived, release };
}

test("ordering A: an older Approved listing that finishes after a newer Paused sync is superseded and never applied", async () => {
  const f = await fixture();
  try {
    const older = gated([[PROMO]]);
    const olderSync = syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: older.fetchImpl });
    await older.arrived; // generation reserved, provider fetch in flight
    const newer = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[{ ...PROMO, status: "PAUSED" }]] }) });
    assert.equal(newer.status, "synced");
    assert.equal(newer.generation, 2);
    older.release();
    const result = await olderSync;
    assert.equal(result.status, "superseded");
    assert.equal(result.generation, 1);
    assert.equal(result.templatesUpserted, 0);
    assert.equal(result.templatesMarkedRemoved, 0);
    const [row] = await rows(f.org.id);
    assert.equal(row.status, "Paused", "the newer applied snapshot stands");
    const [waba] = await db.select().from(wabasTable).where(eq(wabasTable.id, f.waba.id));
    assert.equal(waba.templateSyncAppliedGeneration, 2);
    assert.equal(waba.templateSyncGeneration, 2);
  } finally { await f.cleanup(); }
});

test("ordering B: an older listing cannot mark Removed a template a newer listing introduced", async () => {
  const f = await fixture();
  try {
    const older = gated([[PROMO]]);
    const olderSync = syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: older.fetchImpl });
    await older.arrived;
    const newer = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]] }) });
    assert.equal(newer.status, "synced");
    older.release();
    assert.equal((await olderSync).status, "superseded");
    const stored = await rows(f.org.id);
    assert.equal(stored.length, 2);
    assert.equal(stored.find((row) => row.providerTemplateId === "tpl-2")!.status, "Pending", "tpl-2 was not falsely removed");
  } finally { await f.cleanup(); }
});

test("ordering C: an older listing cannot restore a template a newer committed listing removed", async () => {
  const f = await fixture();
  try {
    await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]] }) });
    const older = gated([[PROMO, PENDING]]);
    const olderSync = syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: older.fetchImpl });
    await older.arrived;
    const newer = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO]] }) });
    assert.equal(newer.templatesMarkedRemoved, 1);
    older.release();
    assert.equal((await olderSync).status, "superseded");
    const removed = (await rows(f.org.id)).find((row) => row.providerTemplateId === "tpl-2")!;
    assert.equal(removed.status, "Removed");
    assert.equal(removed.metadata.providerMissing, true);
  } finally { await f.cleanup(); }
});

test("ordering D/E: repeated syncs stay idempotent and advance the generation; a failed newer listing leaves data unchanged and lets an older valid snapshot apply", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      const result = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO, PENDING]] }) });
      assert.equal(result.status, "synced");
      assert.equal(result.generation, i + 1);
    }
    assert.equal((await rows(f.org.id)).length, 2);
    const older = gated([[PROMO, PENDING, REJECTED]]);
    const olderSync = syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: older.fetchImpl });
    await older.arrived;
    const failed = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ failPage: 0, failStatus: 503 }) });
    assert.equal(failed.status, "failed");
    assert.equal(failed.generation, 5);
    assert.equal((await rows(f.org.id)).length, 2, "a failed listing changes nothing");
    older.release();
    const result = await olderSync;
    assert.equal(result.status, "synced", "the newer request failed, so the older valid snapshot still applies");
    assert.equal(result.generation, 4);
    assert.equal((await rows(f.org.id)).length, 3);
    const [waba] = await db.select().from(wabasTable).where(eq(wabasTable.id, f.waba.id));
    assert.equal(waba.templateSyncAppliedGeneration, 4);
  } finally { await f.cleanup(); }
});

test("ordering F: independent WABAs neither block nor supersede one another", async () => {
  const f = await fixture();
  try {
    const [wabaB] = await db.insert(wabasTable).values({ organizationId: f.org.id, externalId: `waba-b-${f.slug}`, displayName: "Beta", credentialId: f.credential.id }).returning();
    const heldA = gated([[PROMO]]);
    const syncA = syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: heldA.fetchImpl });
    await heldA.arrived;
    // B completes fully while A is still fetching.
    const b = await syncWabaTemplates({ organizationId: f.org.id, wabaId: wabaB.id, fetchImpl: fakeMeta({ pages: [[{ ...PENDING, id: "b-1", name: "beta" }]] }) });
    assert.equal(b.status, "synced");
    assert.equal(b.generation, 1);
    heldA.release();
    const a = await syncA;
    assert.equal(a.status, "synced", "B's generation never supersedes A");
    assert.equal(a.generation, 1);
    const stored = await rows(f.org.id);
    assert.equal(stored.filter((row) => row.wabaId === f.waba.id).length, 1);
    assert.equal(stored.filter((row) => row.wabaId === wabaB.id).length, 1);
  } finally { await f.cleanup(); }
});

test("lock D: revocation started after the sync revalidated under its row locks waits for the commit, then applies; the stale-sync interleaving is impossible", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  let sync: Promise<unknown> = Promise.resolve();
  try {
    await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO]] }) });
    let arrive!: () => void;
    const arrived = new Promise<void>((resolve) => { arrive = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = syncWabaTemplates({
      organizationId: f.org.id, wabaId: f.waba.id,
      fetchImpl: fakeMeta({ pages: [[{ ...PROMO, status: "PAUSED" }]] }),
      hooks: { beforeApply: async () => { arrive(); await gate; } },
    });
    sync = started;
    await arrived; // credential validated FOR SHARE, WABA locked FOR UPDATE, no template written yet
    const revoke = revokeCredential(f.org.id, f.credential.id); // real lifecycle writer
    await untilLockWait("whatsapp_credentials"); // it is blocked on the credential row, not committed
    assert.equal((await db.select().from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.id, f.credential.id)))[0]!.status, "active");
    release!();
    const result = await started;
    assert.equal(result.status, "synced");
    const revoked = await revoke;
    assert.equal(revoked?.credential.status, "revoked");
    assert.equal((await rows(f.org.id))[0]!.status, "Paused", "the validated sync committed first, then revocation took effect");
    // After the revocation nothing can sync with this credential any more.
    const later = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO]] }) });
    assert.equal(later.status, "failed");
    assert.equal(later.error?.code, "credential_inactive");
    assert.equal((await rows(f.org.id))[0]!.status, "Paused");
  } finally {
    release?.();
    await sync.catch(() => undefined);
    await f.cleanup();
  }
});

test("lock E: a re-association through the real connect path waits on the WABA row until the validated sync commits", async () => {
  const f = await fixture({ externalId: "100200300400500" });
  let release: (() => void) | undefined;
  let sync: Promise<unknown> = Promise.resolve();
  try {
    let arrive!: () => void;
    const arrived = new Promise<void>((resolve) => { arrive = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = syncWabaTemplates({
      organizationId: f.org.id, wabaId: f.waba.id,
      fetchImpl: fakeMeta({ pages: [[PROMO]] }),
      hooks: { beforeApply: async () => { arrive(); await gate; } },
    });
    sync = started;
    await arrived;
    // Re-connect the WABA's number with a DIFFERENT token: a new credential
    // row and a WABA re-association, through the production connect path.
    const discovery: FetchLike = async (url, init) => {
      const headers = init.headers as Record<string, string>;
      const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (headers?.Authorization !== `Bearer ${OTHER_TOKEN}`) return json(401, { error: { message: "Invalid OAuth access token", code: 190 } });
      const path = new URL(url).pathname;
      if (path.endsWith("/me")) return json(200, { id: "sys-user-2" });
      if (path.endsWith("/100200300400500")) return json(200, { id: "100200300400500", name: "Acme WABA" });
      if (path.endsWith("/phone_numbers")) return json(200, { data: [{ id: "111222333444555", display_phone_number: "+1 555-000-0001", verified_name: "Acme", quality_rating: "GREEN", code_verification_status: "VERIFIED" }], paging: { cursors: {} } });
      return json(404, { error: { message: "Unknown edge", code: 100 } });
    };
    const reconnect = connectManualNumber({ organizationId: f.org.id, phoneNumber: "+15550000001", accessToken: OTHER_TOKEN, wabaId: "100200300400500", fetchImpl: discovery });
    await untilLockWait("wabas");
    assert.equal((await db.select().from(wabasTable).where(eq(wabasTable.id, f.waba.id)))[0]!.credentialId, f.credential.id, "not re-associated yet");
    release!();
    const result = await started;
    assert.equal(result.status, "synced");
    const connected = await reconnect;
    assert.equal(connected.outcome, "connected");
    if (connected.outcome !== "connected") return;
    assert.notEqual(connected.credential.id, f.credential.id);
    assert.equal((await db.select().from(wabasTable).where(eq(wabasTable.id, f.waba.id)))[0]!.credentialId, connected.credential.id);
    assert.equal((await rows(f.org.id))[0]!.metadata.credentialId, f.credential.id, "the committed snapshot records the credential it was validated with");
    // The next sync uses the new association.
    const next = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO]], token: OTHER_TOKEN }) });
    assert.equal(next.status, "synced");
  } finally {
    release?.();
    await sync.catch(() => undefined);
    await f.cleanup();
  }
});

test("lock F: a sync that fails after taking its locks releases them; revocation and a later valid sync proceed", async () => {
  const f = await fixture();
  try {
    const failed = await syncWabaTemplates({
      organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO]] }),
      hooks: { beforeApply: async () => { throw new Error("injected apply failure"); } },
    });
    assert.equal(failed.status, "failed");
    assert.equal((await rows(f.org.id)).length, 0);
    const ok = await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO]] }) });
    assert.equal(ok.status, "synced");
    const revoked = await revokeCredential(f.org.id, f.credential.id);
    assert.equal(revoked?.credential.status, "revoked");
  } finally { await f.cleanup(); }
});

test("legacy connector sync refuses a WABA that is connected with a workspace credential", async () => {
  const { syncWhatsApp, getOrCreateProviderConnection } = await import("../src/services/whatsapp-sync");
  const { providerConnectionsTable } = await import("@workspace/db");
  const f = await fixture();
  try {
    const connection = await getOrCreateProviderConnection(f.org.id);
    await db.update(providerConnectionsTable).set({ configuredWabaExternalId: f.waba.externalId }).where(eq(providerConnectionsTable.id, connection.id));
    await syncWabaTemplates({ organizationId: f.org.id, wabaId: f.waba.id, fetchImpl: fakeMeta({ pages: [[PROMO]] }) });
    const before = JSON.stringify((await rows(f.org.id)).map(({ updatedAt: _u, ...row }) => row));
    await assert.rejects(syncWhatsApp(f.org.id), /workspace credential/);
    assert.equal(JSON.stringify((await rows(f.org.id)).map(({ updatedAt: _u, ...row }) => row)), before, "legacy sync wrote nothing for the credential WABA");
    assert.equal((await db.select().from(wabasTable).where(eq(wabasTable.id, f.waba.id)))[0]!.credentialId, f.credential.id);
  } finally { await f.cleanup(); }
});
