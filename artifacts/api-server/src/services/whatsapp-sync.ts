import { and, eq } from "drizzle-orm";
import {
  db,
  phoneNumbersTable,
  providerConnectionsTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { providerClient, type ProviderMode } from "./whatsapp-provider";

export async function getOrCreateProviderConnection(organizationId: number) {
  const [existing] = await db.select().from(providerConnectionsTable).where(and(
    eq(providerConnectionsTable.organizationId, organizationId),
    eq(providerConnectionsTable.provider, "whatsapp-business"),
  ));
  if (existing) return existing;
  const [created] = await db.insert(providerConnectionsTable).values({
    organizationId,
    provider: "whatsapp-business",
    mode: "mock",
    status: "configured",
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [raced] = await db.select().from(providerConnectionsTable).where(and(
    eq(providerConnectionsTable.organizationId, organizationId),
    eq(providerConnectionsTable.provider, "whatsapp-business"),
  ));
  if (!raced) throw new Error("Unable to initialize provider connection");
  return raced;
}

function bodyFromComponents(components: Record<string, unknown>[]): string {
  const body = components.find((component) => String(component.type).toUpperCase() === "BODY");
  return typeof body?.text === "string" ? body.text : "";
}

function category(value?: string): string {
  const lower = value?.toLowerCase();
  return lower ? lower[0]!.toUpperCase() + lower.slice(1) : "Marketing";
}

function templateStatus(value?: string): string {
  const lower = value?.toLowerCase();
  return lower ? lower[0]!.toUpperCase() + lower.slice(1) : "Pending";
}

// Meta's own provider-approved throughput tiers (messages/sec), per
// https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput:
// every number starts at STANDARD (80 mps) and Meta automatically upgrades
// eligible numbers to HIGH (1,000 mps) -- there is no higher tier and no
// operator action that raises it beyond what Meta reports here. This is the
// only value phone-numbers.ts's tpsLimit gate may trust as "provider-approved".
const THROUGHPUT_TPS_LIMITS: Record<string, number> = {
  STANDARD: 80,
  HIGH: 1000,
};
const DEFAULT_THROUGHPUT_LEVEL = "STANDARD";

export function approvedTpsLimitFor(level?: string): number {
  return THROUGHPUT_TPS_LIMITS[level ?? DEFAULT_THROUGHPUT_LEVEL]
    ?? THROUGHPUT_TPS_LIMITS[DEFAULT_THROUGHPUT_LEVEL]!;
}

export async function syncWhatsApp(organizationId: number) {
  const connection = await getOrCreateProviderConnection(organizationId);
  const externalId = connection.configuredWabaExternalId;
  if (!externalId) throw new Error("A WhatsApp Business Account ID must be configured before sync");
  const now = new Date();
  await db.update(providerConnectionsTable).set({ status: "syncing", lastError: null }).where(eq(providerConnectionsTable.id, connection.id));
  try {
    const client = providerClient(connection.mode as ProviderMode);
    const connectorAccountId = await client.identity();
    if (connection.mode === "real" && connection.connectorAccountId !== connectorAccountId) {
      throw new Error("Real WhatsApp connector identity is not verified for this workspace");
    }
    if (connection.mode === "real") {
      const [claimed] = await db.select({ id: wabasTable.id }).from(wabasTable).where(and(
        eq(wabasTable.organizationId, organizationId),
        eq(wabasTable.externalId, externalId),
      ));
      if (!claimed) throw new Error("Real WhatsApp Business Account is not claimed by this workspace");
    }
    const [phones, templates] = await Promise.all([
      client.listPhoneNumbers(externalId),
      client.listTemplates(externalId),
    ]);
    await db.transaction(async (tx) => {
      const [waba] = await tx.insert(wabasTable).values({
        organizationId,
        externalId,
        displayName: externalId,
        provider: "whatsapp-business",
        providerStatus: "connected",
        lastSyncedAt: now,
      }).onConflictDoUpdate({
        target: [wabasTable.organizationId, wabasTable.externalId],
        set: { providerStatus: "connected", lastSyncedAt: now },
      }).returning();
      for (const phone of phones) {
        const providerMetadata = {
          qualityRating: phone.quality_rating,
          verificationStatus: phone.code_verification_status,
          throughputLevel: phone.throughput?.level ?? DEFAULT_THROUGHPUT_LEVEL,
          // The tpsLimit gate in routes/phone-numbers.ts only ever trusts this
          // field to allow an operator-configured tpsLimit above the
          // conservative unverified default -- it must always be re-derived
          // from what Meta reports here, never carried over untouched or
          // widened by anything else.
          approvedTpsLimit: approvedTpsLimitFor(phone.throughput?.level),
        };
        await tx.insert(phoneNumbersTable).values({
          organizationId,
          wabaId: waba.id,
          providerPhoneId: phone.id,
          phone: phone.display_phone_number,
          displayName: phone.verified_name ?? phone.display_phone_number,
          provider: "Cloud API",
          quality: phone.quality_rating === "RED" ? "Low" : phone.quality_rating === "YELLOW" ? "Medium" : "High",
          status: phone.code_verification_status === "VERIFIED" ? "Connected" : "Pending",
          providerMetadata,
          lastSyncedAt: now,
        }).onConflictDoUpdate({
          target: [phoneNumbersTable.organizationId, phoneNumbersTable.providerPhoneId],
          set: {
            wabaId: waba.id,
            phone: phone.display_phone_number,
            displayName: phone.verified_name ?? phone.display_phone_number,
            quality: phone.quality_rating === "RED" ? "Low" : phone.quality_rating === "YELLOW" ? "Medium" : "High",
            status: phone.code_verification_status === "VERIFIED" ? "Connected" : "Pending",
            // Previously omitted here, so a re-sync never refreshed
            // providerMetadata on an existing number -- an upgrade from
            // STANDARD to HIGH throughput (or any quality change) would
            // silently never reach the row a second time.
            providerMetadata,
            lastSyncedAt: now,
          },
        });
      }
      for (const template of templates) {
        const components = template.components ?? [];
        await tx.insert(templatesTable).values({
          organizationId,
          wabaId: waba.id,
          providerTemplateId: template.id,
          name: template.name,
          language: template.language,
          category: category(template.category),
          status: templateStatus(template.status),
          body: bodyFromComponents(components),
          components,
          metadata: { provider: "whatsapp-business" },
          lastSyncedAt: now,
        }).onConflictDoUpdate({
          target: [templatesTable.organizationId, templatesTable.providerTemplateId],
          set: {
            wabaId: waba.id,
            name: template.name,
            language: template.language,
            category: category(template.category),
            status: templateStatus(template.status),
            body: bodyFromComponents(components),
            components,
            lastSyncedAt: now,
          },
        });
      }
      await tx.update(providerConnectionsTable).set({
        status: "healthy", health: "healthy", lastHealthAt: now, lastSyncAt: now,
        lastError: null, lastErrorAt: null,
      }).where(eq(providerConnectionsTable.id, connection.id));
    });
    return { wabas: 1, phoneNumbers: phones.length, templates: templates.length, syncedAt: now };
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp synchronization failed";
    await db.update(providerConnectionsTable).set({
      status: "error", health: "unhealthy", lastError: message.slice(0, 500), lastErrorAt: now,
    }).where(eq(providerConnectionsTable.id, connection.id));
    throw error;
  }
}