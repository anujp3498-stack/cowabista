// R-D1 (R1b): the Replit shared WhatsApp connector is retired. Real sending works only through a number's
// own encrypted workspace credential; a number without one can send only in a workspace whose stored mode is
// exactly "mock". Everything else fails closed with credential_required before any provider request, and there
// is no fallback. Uses a disposable database and the fake Graph server only; no live Meta call is possible.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignJobsTable,
  db,
  pool,
  providerConnectionsTable,
  providerMessagesTable,
  settlementPool,
  whatsappCredentialsTable,
} from "@workspace/db";
import whatsappIntegrationRouter from "../src/routes/whatsapp-integration";
import messageStudioRouter from "../src/routes/message-studio";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { NO_SENDING_CREDENTIAL_CODE, ProviderRequestError } from "../src/services/whatsapp-provider";
import { syncWhatsApp } from "../src/services/whatsapp-sync";
import { syncWorkspaceTemplates } from "../src/services/whatsapp-template-sync";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { createCampaign, deleteOrganization, fakeResponse, findRouteHandler, mockWorld, seedAudience, startFakeGraph, useLocalMediaStore, workspaceWorld } from "./message-studio-fixtures";
import { firstNameMappings, saveSetup } from "./v2-fixtures";
import { setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";

before(() => { process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64"); useLocalMediaStore(); });
after(async () => { setCampaignMediaStoreForTests(undefined); delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV]; await Promise.all([pool.end(), settlementPool.end()]); });

const slugFor = (label: string) => `retired-${label}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
const integration = "/organizations/:organizationId/whatsapp/integration";
const getIntegration = findRouteHandler(whatsappIntegrationRouter, integration, "get");
const patchIntegration = findRouteHandler(whatsappIntegrationRouter, integration, "patch");
const getHealth = findRouteHandler(whatsappIntegrationRouter, "/organizations/:organizationId/whatsapp/health", "get");
const postSync = findRouteHandler(whatsappIntegrationRouter, "/organizations/:organizationId/whatsapp/sync", "post");
const testSendRoute = findRouteHandler(messageStudioRouter, "/organizations/:organizationId/campaigns/:campaignId/message-setup/test-send", "post");
const log = { warn() {}, info() {}, error() {} };

async function call(handler: (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown, req: Record<string, unknown>) {
  const res = fakeResponse();
  let forwarded: unknown;
  await handler({ log, authUser: {}, ...req }, res, (error?: unknown) => { forwarded = error; });
  if (forwarded) throw forwarded;
  return res;
}

const isCredentialRequired = (error: unknown) => error instanceof ProviderRequestError && error.code === NO_SENDING_CREDENTIAL_CODE && error.retryable === false;
const setMode = (organizationId: number, mode: string, configuredWabaExternalId: string | null = null) =>
  db.update(providerConnectionsTable).set({ mode, configuredWabaExternalId }).where(eq(providerConnectionsTable.organizationId, organizationId));

/** A mock workspace with one planned and executed job (the shape a pre-R1b "real" workspace had at cutover). */
async function executedMockCampaign(label: string) {
  const slug = slugFor(label);
  const world = await mockWorld(slug, { phones: 1, templates: [{ name: "hello", body: "Hello {{1}}" }] });
  const org = world.organization.id;
  const campaign = await createCampaign(org, slug);
  const { contacts } = await seedAudience(org, campaign.id, ["phone", "first_name"], [{ phone: `+4477331${String(org % 100000).padStart(5, "0")}`, first_name: "Ann" }]);
  const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [world.templates[0]!.id], mappings: firstNameMappings([world.templates[0]!.id]), distributionMode: "equal_numbers" });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  await planCampaign(org, campaign.id);
  await executeCampaignPlan(org, campaign.id);
  const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
  assert.equal(jobs.length, 1);
  return { world, org, campaign, contact: contacts[0]!, jobs };
}

test("send preparation: a live workspace number without a credential fails the batch closed (credential_required) before any request; the same number in a mock workspace prepares and mock-sends", async () => {
  const f = await executedMockCampaign("prepare");
  const graph = await startFakeGraph();
  const sender = new WhatsAppTemplateSender();
  try {
    for (const mode of ["real", "bogus"]) {
      await setMode(f.org, mode);
      await assert.rejects(sender.prepareBatch(f.jobs), isCredentialRequired, mode);
      assert.equal((await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, f.jobs[0]!.id))).length, 0, `${mode}: no durable intent`);
    }
    await setMode(f.org, "mock");
    const contexts = await sender.prepareBatch(f.jobs);
    const context = contexts.get(f.jobs[0]!.id) as { connection: { mode: string } };
    assert.ok(context && !(context instanceof Error), "mock workspace prepares");
    const payload = sender.serializePreparedTransport(f.jobs[0]!, context);
    assert.equal(payload?.kind, "whatsapp");
    assert.equal(payload && "mode" in payload ? payload.mode : undefined, "mock");
    const sent = await sender.sendPreparedTransport(f.jobs[0]!, { signal: new AbortController().signal }, context);
    assert.match(sent.providerMessageId, /^wamid\.mock_/);

    // A prepared context or broker envelope that carries a live mode and no workspace credential (what a
    // pre-R1b connector job looks like) is refused at both boundaries. A context prepared while the workspace
    // was still in mock keeps its frozen mock mode and finishes as a mock send; nothing reaches a provider.
    const stale = { ...context, connection: { ...context.connection, mode: "real" } };
    assert.throws(() => sender.serializePreparedTransport(f.jobs[0]!, stale), isCredentialRequired);
    await assert.rejects(sender.sendPreparedTransport(f.jobs[0]!, { signal: new AbortController().signal }, stale), isCredentialRequired);
    assert.equal(graph.requests.length, 0, "the fake Graph server saw nothing");
  } finally {
    await graph.close();
    await deleteOrganization(f.org);
  }
});

test("test send: a live workspace number without a credential is refused with 409, audited as refused, and never reaches a provider", async () => {
  const f = await executedMockCampaign("test-send");
  const graph = await startFakeGraph();
  try {
    await setMode(f.org, "real");
    const res = fakeResponse();
    await testSendRoute({ params: { organizationId: String(f.org), campaignId: String(f.campaign.id) }, body: { phoneNumberId: f.world.phones[0]!.id, templateId: f.world.templates[0]!.id, contactId: f.contact.id }, authUser: { id: undefined }, log }, res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "credential_inactive");
    assert.match(res.body.error ?? res.body.message, /no workspace sending credential/);
    const audits = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, f.campaign.id), eq(campaignAuditTable.action, "test_send_requested")));
    assert.equal(audits.length, 1);
    assert.equal((audits[0]!.metadata as Record<string, unknown>).result, "refused");
    assert.equal(graph.requests.length, 0);
  } finally {
    await graph.close();
    await deleteOrganization(f.org);
  }
});

test("sync: the workspace-level sync is mock-only; a live workspace gets credential_required (route 409) and nothing is written; the Templates sync reports the stale connector WABA as one clear failure", async () => {
  const slug = slugFor("sync");
  const world = await mockWorld(slug, { phones: 1, templates: [{ name: "hello", body: "Hello" }] });
  const org = world.organization.id;
  try {
    await setMode(org, "real", world.waba.externalId);
    const [beforeRow] = await db.select().from(providerConnectionsTable).where(eq(providerConnectionsTable.organizationId, org));
    await assert.rejects(syncWhatsApp(org), isCredentialRequired);
    const res = await call(postSync, { params: { organizationId: String(org) } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, NO_SENDING_CREDENTIAL_CODE);
    const [afterRow] = await db.select().from(providerConnectionsTable).where(eq(providerConnectionsTable.organizationId, org));
    assert.deepEqual(afterRow, beforeRow, "no status, health or error write");

    const templates = await syncWorkspaceTemplates({ organizationId: org });
    assert.equal(templates.wabas.length, 1);
    assert.equal(templates.wabas[0]!.status, "failed");
    assert.equal(templates.wabas[0]!.error?.code, "legacy_sync_failed");
    assert.match(templates.wabas[0]!.error?.message ?? "", /shared connector was retired/);

    await setMode(org, "mock", world.waba.externalId);
    const mockSync = await syncWhatsApp(org);
    assert.equal(mockSync.wabas, 1, "mock sync still works");
  } finally {
    await deleteOrganization(org);
  }
});

test("integration settings: no provider call, owner-only mode switches in both directions, live mode keeps no WABA, several workspaces can be live, health counts active credentials", async () => {
  const a = await mockWorld(slugFor("int-a"), { phones: 1, templates: [] });
  const b = await workspaceWorld(slugFor("int-b"), { phones: 1, templates: [] });
  const graph = await startFakeGraph();
  try {
    const params = (organizationId: number) => ({ organizationId: String(organizationId) });
    await setMode(a.organization.id, "mock", "test-waba");
    // Admin may edit the mock test WABA but not switch modes.
    let res = await call(patchIntegration, { params: params(a.organization.id), body: { configuredWabaExternalId: "test-waba-2" }, role: "admin" });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.configuredWabaExternalId, "test-waba-2");
    res = await call(patchIntegration, { params: params(a.organization.id), body: { mode: "real" }, role: "admin" });
    assert.equal(res.statusCode, 403);
    // A WABA id is refused for live mode.
    res = await call(patchIntegration, { params: params(a.organization.id), body: { mode: "real", configuredWabaExternalId: "102345678901234" }, role: "owner" });
    assert.equal(res.statusCode, 400);
    // Owner goes live: the old workspace WABA is cleared, the connector identity is always null.
    res = await call(patchIntegration, { params: params(a.organization.id), body: { mode: "real" }, role: "owner" });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.mode, "real");
    assert.equal(res.body.connectorAccountId, null);
    assert.equal(res.body.configuredWabaExternalId, null);
    assert.equal("realWorkspaceLimit" in res.body, false);
    // Leaving live mode is an owner decision too.
    res = await call(patchIntegration, { params: params(a.organization.id), body: { mode: "mock" }, role: "admin" });
    assert.equal(res.statusCode, 403);
    // A second workspace can be live at the same time (no single shared credential any more).
    res = await call(patchIntegration, { params: params(b.organization.id), body: { mode: "real" }, role: "owner" });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    // Health: live without an active credential is not_configured; with one it is healthy; mock is healthy.
    res = await call(getHealth, { params: params(a.organization.id) });
    assert.equal(res.body.status, "not_configured");
    res = await call(getHealth, { params: params(b.organization.id) });
    assert.equal(res.body.status, "healthy");
    await db.update(whatsappCredentialsTable).set({ status: "revoked" }).where(eq(whatsappCredentialsTable.id, b.credential.id));
    res = await call(getHealth, { params: params(b.organization.id) });
    assert.equal(res.body.status, "not_configured");

    // An unknown stored mode is reported as live, never as mock.
    await setMode(a.organization.id, "bogus");
    res = await call(getIntegration, { params: params(a.organization.id) });
    assert.equal(res.body.mode, "real");
    assert.equal(graph.requests.length, 0, "no provider call from any settings route");
  } finally {
    await graph.close();
    await deleteOrganization(a.organization.id);
    await deleteOrganization(b.organization.id);
  }
});

test("the Replit connector SDK is gone from every source file and manifest", () => {
  const repoRoot = path.resolve(process.cwd(), "..", "..");
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".test-dist" || name === "generated") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.(ts|tsx|mjs|js|json)$/.test(name) && /@replit\/connectors-sdk|ReplitConnectors/.test(readFileSync(full, "utf8"))) offenders.push(path.relative(repoRoot, full));
    }
  };
  for (const dir of ["artifacts/api-server/src", "artifacts/wabista-nexus/src", "lib"]) visit(path.join(repoRoot, dir));
  for (const manifest of ["package.json", "artifacts/api-server/package.json", "artifacts/wabista-nexus/package.json", "pnpm-lock.yaml"]) {
    if (/@replit\/connectors-sdk/.test(readFileSync(path.join(repoRoot, manifest), "utf8"))) offenders.push(manifest);
  }
  assert.deepEqual(offenders, []);
});
