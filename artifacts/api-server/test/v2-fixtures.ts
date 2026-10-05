// Shared fixtures for the V2-06A allocator-v2 DB suites (not a suite).
// Local/mock provider context (no credential, mock connection): sends go
// to MockWhatsAppProviderClient; nothing leaves the process.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  db,
  phoneNumbersTable,
  providerConnectionsTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import messageStudioRouter from "../src/routes/message-studio";
import campaignDeliveryRouter from "../src/routes/campaign-delivery";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter } from "../src/services/campaign-queue";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { createCampaign, createOrganization, fakeResponse, findRouteHandler, seedAudience } from "./message-studio-fixtures";

const putSetup = findRouteHandler(messageStudioRouter, "/organizations/:organizationId/campaigns/:campaignId/message-setup", "put");
const getDelivery = findRouteHandler(campaignDeliveryRouter, "/organizations/:organizationId/campaigns/:campaignId/delivery-setup", "get");
const putDelivery = findRouteHandler(campaignDeliveryRouter, "/organizations/:organizationId/campaigns/:campaignId/delivery-setup", "put");
const getPreflightRoute = findRouteHandler(campaignDeliveryRouter, "/organizations/:organizationId/campaigns/:campaignId/preflight", "get");

export type WorldSpec = {
  /** Business accounts, each with its numbers and templates (pair compatibility follows V2-04: same WABA). */
  wabas: Array<{ phones: Array<{ key: string; tps?: number }>; templates: Array<{ key: string; body: string; components?: Record<string, unknown>[] }> }>;
};

export async function v2World(slug: string, spec: WorldSpec) {
  const organization = await createOrganization(slug);
  await db.insert(providerConnectionsTable).values({ organizationId: organization.id, provider: "whatsapp-business", mode: "mock", status: "configured" }).onConflictDoNothing();
  const phones: Record<string, typeof phoneNumbersTable.$inferSelect> = {};
  const templates: Record<string, typeof templatesTable.$inferSelect> = {};
  let n = 0;
  for (const [index, wabaSpec] of spec.wabas.entries()) {
    const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `waba-${slug}-${index}`, displayName: `Account ${index + 1}` }).returning();
    for (const phone of wabaSpec.phones) {
      const [row] = await db.insert(phoneNumbersTable).values({
        organizationId: organization.id, wabaId: waba!.id, providerPhoneId: `pp-${slug}-${phone.key}`,
        phone: `+1777${String(organization.id).padStart(5, "0")}${String(++n).padStart(2, "0")}`,
        displayName: `Sender ${phone.key}`, status: "Connected", setupState: "active", tpsLimit: phone.tps ?? 50,
      }).returning();
      phones[phone.key] = row!;
    }
    for (const template of wabaSpec.templates) {
      const [row] = await db.insert(templatesTable).values({
        organizationId: organization.id, wabaId: waba!.id, providerTemplateId: `tpl-${slug}-${template.key}`,
        name: `tpl_${template.key.toLowerCase()}`, status: "Approved", language: "en_US", category: "Marketing",
        body: template.body, components: template.components ?? [{ type: "BODY", text: template.body }],
      }).returning();
      templates[template.key] = row!;
    }
  }
  return { organization, phones, templates };
}

export async function v2Campaign(organizationId: number, slug: string, contacts: number) {
  const campaign = await createCampaign(organizationId, slug);
  // Recipients are unique per campaign: the deterministic mock provider id is
  // a hash of (sender, payload), so two campaigns sending the same payload to
  // the same number would collide on provider_messages' unique provider id.
  const rows = Array.from({ length: contacts }, (_, index) => ({ phone: `+447${String(campaign.id % 100_000).padStart(5, "0")}${String(index).padStart(4, "0")}`, first_name: `N${index}` }));
  const audience = await seedAudience(organizationId, campaign.id, ["phone", "first_name"], rows);
  await db.insert(campaignMetricsTable).values({ organizationId, campaignId: campaign.id, total: contacts, valid: contacts }).onConflictDoNothing();
  return { campaign, contacts: audience.contacts };
}

export async function saveSetup(organizationId: number, campaignId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await putSetup({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body, authUser: {} }, res);
  return res;
}

/** V2-06B: GET/PUT .../delivery-setup and GET .../preflight through the real route handlers. */
export async function loadDelivery(organizationId: number, campaignId: number) {
  const res = fakeResponse();
  await getDelivery({ params: { organizationId: String(organizationId), campaignId: String(campaignId) } }, res);
  return res;
}
export async function saveDelivery(organizationId: number, campaignId: number, body: Record<string, unknown>) {
  const res = fakeResponse();
  await putDelivery({ params: { organizationId: String(organizationId), campaignId: String(campaignId) }, body, authUser: {} }, res);
  return res;
}
export async function preflight(organizationId: number, campaignId: number) {
  const res = fakeResponse();
  await getPreflightRoute({ params: { organizationId: String(organizationId), campaignId: String(campaignId) } }, res);
  return res;
}

/** Body {{1}} <- first_name for every template. */
export function firstNameMappings(templateIds: number[]) {
  return templateIds.map((templateId) => ({ templateId, component: "body", variable: "1", source: "csv", sourceValue: "first_name" }));
}

export function mockProviderId(providerPhoneId: string, payload: Record<string, unknown>): string {
  return `wamid.mock_${createHash("sha256").update(`${providerPhoneId}:${JSON.stringify(payload)}`).digest("hex").slice(0, 20)}`;
}

export function expectedBodyPayload(recipient: string, templateName: string, firstName: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: { name: templateName, language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: firstName }] }] },
  };
}

/** Drives the REAL production worker (claim -> resolve -> prepare -> mock send) until `expected` sends or a deadline. */
export async function drainWithWorker(campaignId: number, expected: number, label: string, timeoutMs = 60_000) {
  const worker = new CampaignWorker(new DatabaseJobQueue(), new WhatsAppTemplateSender(), new RouteTpsLimiter(), `${label}-worker`);
  const deadline = Date.now() + timeoutMs;
  const outcomes: string[] = [];
  for (;;) {
    const [{ sent }] = await db.select({ sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int` }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId));
    if (sent >= expected) return outcomes;
    if (Date.now() > deadline) assert.fail(`${label}: only ${sent}/${expected} sent; outcomes ${outcomes.slice(-20).join(",")}`);
    const outcome = await worker.processOne();
    outcomes.push(outcome);
    if (outcome !== "sent") await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export type ProviderLogEntry = { phoneId: string; payload: { to: string; template: { name: string; components?: unknown[] } }; at: number };

/** Records every completed mock send (phoneId, payload, timestamp) through the existing provider test hook. */
export function providerLog(path: string) {
  if (existsSync(path)) rmSync(path);
  process.env.CAMPAIGN_TEST_PROVIDER_LOG = path;
  return {
    entries: (): ProviderLogEntry[] =>
      existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    stop: () => { delete process.env.CAMPAIGN_TEST_PROVIDER_LOG; if (existsSync(path)) rmSync(path); },
  };
}

export async function contactData(contactIds: number[]) {
  const rows = await db.select().from(campaignContactsTable).where(and(sql`${campaignContactsTable.id} in (${sql.join(contactIds.map((id) => sql`${id}`), sql`, `)})`));
  return new Map(rows.map((row) => [row.id, row]));
}
