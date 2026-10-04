import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import {
  db,
  providerConnectionsTable,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { ManualMetaClient, type FetchLike } from "./whatsapp-manual-client";
import { CREDENTIAL_KIND_MANUAL_TOKEN, CREDENTIAL_PROVIDER, RECONNECT_MESSAGE } from "./whatsapp-manual-connection";
import { ProviderRequestError, type MetaTemplate } from "./whatsapp-provider";
import { syncWhatsApp } from "./whatsapp-sync";
import { resolveSendingCredential, SendingCredentialUnavailableError } from "./whatsapp-transport-credentials";

// V2-03A: per-workspace Meta template synchronisation.
//
// A WABA whose `credentialId` points at an active workspace credential is
// synchronised with that credential through the direct management client;
// a WABA without one keeps the legacy shared-connector path (syncWhatsApp).
// Neither path is ever substituted for the other.
//
// Shape of one WABA sync: resolve WABA + credential, decrypt, fetch EVERY
// provider page, and only then open one short transaction under a per-WABA
// advisory lock to upsert what Meta returned and mark what it no longer
// returns. A fetch that fails on any page changes nothing locally.

export const TEMPLATE_STATUS_REMOVED = "Removed";

const KNOWN_STATUS: Record<string, string> = {
  APPROVED: "Approved",
  PENDING: "Pending",
  REJECTED: "Rejected",
  PAUSED: "Paused",
  DISABLED: "Disabled",
  IN_APPEAL: "In appeal",
  PENDING_DELETION: "Pending deletion",
  DELETED: "Deleted",
  LIMIT_EXCEEDED: "Limit exceeded",
};

/** Provider status is authoritative; unknown values are shown honestly, never promoted. */
export function normalizeTemplateStatus(raw: string | undefined): string {
  if (!raw) return "Unknown";
  const upper = raw.toUpperCase();
  if (KNOWN_STATUS[upper]) return KNOWN_STATUS[upper]!;
  const words = upper.toLowerCase().replace(/_/g, " ");
  return words[0]!.toUpperCase() + words.slice(1);
}

export function normalizeTemplateCategory(raw: string | undefined): string {
  const lower = raw?.toLowerCase();
  return lower ? lower[0]!.toUpperCase() + lower.slice(1) : "Marketing";
}

/** Readable body text for lists; `components` stays the authoritative snapshot. */
export function bodyFromComponents(components: Record<string, unknown>[]): string {
  const body = components.find((component) => String(component.type).toUpperCase() === "BODY");
  return typeof body?.text === "string" ? body.text : "";
}

export type TemplateSyncFailureCode =
  | "credential_inactive"
  | "waba_not_found"
  | "provider_unavailable"
  | "provider_rejected"
  | "legacy_sync_failed";

export type WabaTemplateSyncResult = {
  wabaId: number;
  wabaExternalId: string;
  wabaDisplayName: string;
  source: "workspace_credential" | "legacy_connector";
  status: "synced" | "failed";
  templatesSeen: number;
  templatesUpserted: number;
  templatesMarkedRemoved: number;
  error?: { code: TemplateSyncFailureCode; message: string; providerCode?: string; retryable?: boolean };
};

export type WorkspaceTemplateSyncResult = {
  syncedAt: Date;
  wabas: WabaTemplateSyncResult[];
};

function failure(code: TemplateSyncFailureCode, message: string, extra: { providerCode?: string; retryable?: boolean } = {}) {
  return { code, message, ...extra };
}

function mapProviderError(error: unknown): WabaTemplateSyncResult["error"] {
  if (error instanceof SendingCredentialUnavailableError) return failure("credential_inactive", RECONNECT_MESSAGE);
  if (error instanceof ProviderRequestError) {
    const status = error.status ?? 0;
    if (error.code === "190" || status === 401) return failure("credential_inactive", RECONNECT_MESSAGE, { providerCode: error.code });
    if (status >= 500 || error.code === "timeout" || error.code === "network" || error.code === "bad_listing" || error.code === "incomplete_listing") {
      return failure("provider_unavailable", "WhatsApp (Meta) could not be reached to list templates. Try again in a moment.", { providerCode: error.code, retryable: true });
    }
    return failure("provider_rejected", "Meta did not allow this credential to list templates for the business account. Check the token's permissions.", { providerCode: error.code, retryable: false });
  }
  return failure("provider_unavailable", "Template synchronisation failed.", { retryable: true });
}

/**
 * Synchronises one WABA through its own workspace credential. The WABA is
 * loaded by internal id strictly inside the organization; the credential
 * comes only from the WABA's persisted association. Never throws for a
 * provider problem: the outcome is reported per WABA.
 */
export async function syncWabaTemplates(input: {
  organizationId: number;
  wabaId: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: Date;
}): Promise<WabaTemplateSyncResult> {
  const now = input.now ?? new Date();
  const [waba] = await db.select().from(wabasTable).where(and(
    eq(wabasTable.id, input.wabaId),
    eq(wabasTable.organizationId, input.organizationId),
  ));
  const base = {
    wabaId: input.wabaId,
    wabaExternalId: waba?.externalId ?? "",
    wabaDisplayName: waba?.displayName ?? "",
    source: "workspace_credential" as const,
    templatesSeen: 0,
    templatesUpserted: 0,
    templatesMarkedRemoved: 0,
  };
  if (!waba) return { ...base, status: "failed", error: failure("waba_not_found", "WhatsApp Business Account not found in this workspace.") };
  if (!waba.credentialId) return { ...base, status: "failed", error: failure("credential_inactive", RECONNECT_MESSAGE) };

  // 1-3: credential + full provider fetch, outside any transaction.
  let templates: MetaTemplate[];
  let credentialId: number;
  let credentialRevision: number;
  try {
    const credential = await resolveSendingCredential(input.organizationId, waba.credentialId);
    credentialId = credential.credentialId;
    credentialRevision = credential.credentialRevision;
    const client = new ManualMetaClient({ accessToken: credential.accessToken, fetchImpl: input.fetchImpl });
    templates = await client.listTemplates(waba.externalId, input.signal);
  } catch (error) {
    const mapped = mapProviderError(error);
    logger.info({ organizationId: input.organizationId, wabaId: waba.id, code: mapped?.code, providerCode: mapped?.providerCode }, "template sync refused");
    return { ...base, status: "failed", error: mapped };
  }
  const seenIds = [...new Set(templates.map((template) => template.id).filter((id): id is string => typeof id === "string" && id.length > 0))];

  // 4-10: one short transaction under the per-WABA sync lock.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whatsapp-template-sync:${input.organizationId}:${waba.id}`}))`);
    // Revalidate everything the fetch relied on. The provider calls ran
    // outside this transaction, so the credential may have been revoked,
    // replaced (new revision) or re-associated meanwhile: a snapshot fetched
    // with a credential that is no longer the WABA's active one is never
    // committed.
    const [current] = await tx.select({ credentialId: wabasTable.credentialId, organizationId: wabasTable.organizationId }).from(wabasTable).where(eq(wabasTable.id, waba.id));
    if (!current || current.organizationId !== input.organizationId || current.credentialId !== credentialId) {
      throw new SendingCredentialUnavailableError(input.organizationId, credentialId, "WABA credential association changed during sync");
    }
    const [liveCredential] = await tx.select({
      organizationId: whatsappCredentialsTable.organizationId,
      status: whatsappCredentialsTable.status,
      kind: whatsappCredentialsTable.kind,
      provider: whatsappCredentialsTable.provider,
      revision: whatsappCredentialsTable.revision,
    }).from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.id, credentialId));
    if (
      !liveCredential
      || liveCredential.organizationId !== input.organizationId
      || liveCredential.status !== "active"
      || liveCredential.kind !== CREDENTIAL_KIND_MANUAL_TOKEN
      || liveCredential.provider !== CREDENTIAL_PROVIDER
      || liveCredential.revision !== credentialRevision
    ) {
      throw new SendingCredentialUnavailableError(input.organizationId, credentialId, "credential changed during sync");
    }
    let upserted = 0;
    for (const template of templates) {
      if (!template.id) continue;
      const components = Array.isArray(template.components) ? template.components : [];
      const status = normalizeTemplateStatus(template.status);
      const providerMetadata = {
        provider: "whatsapp-business",
        source: "workspace_credential",
        credentialId,
        providerStatus: template.status ?? null,
        providerCategory: template.category ?? null,
        providerMissing: false,
        providerMissingSince: null,
      };
      await tx.insert(templatesTable).values({
        organizationId: input.organizationId,
        wabaId: waba.id,
        providerTemplateId: template.id,
        name: template.name,
        language: template.language,
        category: normalizeTemplateCategory(template.category),
        status,
        body: bodyFromComponents(components),
        components,
        metadata: providerMetadata,
        lastSyncedAt: now,
      }).onConflictDoUpdate({
        target: [templatesTable.organizationId, templatesTable.providerTemplateId],
        set: {
          // A provider template id is unique per organization; the row keeps
          // following the WABA Meta reports it under, never another tenant.
          wabaId: waba.id,
          name: template.name,
          language: template.language,
          category: normalizeTemplateCategory(template.category),
          status,
          body: bodyFromComponents(components),
          components,
          metadata: sql`coalesce(${templatesTable.metadata}, '{}'::jsonb) || ${JSON.stringify(providerMetadata)}::jsonb`,
          lastSyncedAt: now,
          isSample: false,
        },
      });
      upserted += 1;
    }
    // Templates this WABA synchronised before that Meta no longer returns:
    // keep the rows (plans and audit history reference them) but make them
    // honest and unsendable. The pre-removal status is kept in metadata.
    const removed = await tx.update(templatesTable).set({
      status: TEMPLATE_STATUS_REMOVED,
      metadata: sql`coalesce(${templatesTable.metadata}, '{}'::jsonb) || jsonb_build_object(
        'providerMissing', true,
        'providerMissingSince', ${now.toISOString()}::text,
        'statusBeforeRemoval', ${templatesTable.status}
      )`,
      lastSyncedAt: now,
    }).where(and(
      eq(templatesTable.organizationId, input.organizationId),
      eq(templatesTable.wabaId, waba.id),
      eq(templatesTable.isSample, false),
      isNotNull(templatesTable.providerTemplateId),
      sql`${templatesTable.status} <> ${TEMPLATE_STATUS_REMOVED}`,
      ...(seenIds.length ? [notInArray(templatesTable.providerTemplateId, seenIds)] : []),
    )).returning({ id: templatesTable.id });
    await tx.update(wabasTable).set({ lastSyncedAt: now }).where(eq(wabasTable.id, waba.id));
    return { upserted, removed: removed.length };
  }).catch((error: unknown) => ({ error }));
  if ("error" in outcome) {
    const mapped = mapProviderError(outcome.error);
    logger.warn({ organizationId: input.organizationId, wabaId: waba.id, code: mapped?.code }, "template sync could not be committed");
    return { ...base, status: "failed", error: mapped };
  }
  logger.info({ organizationId: input.organizationId, wabaId: waba.id, seen: seenIds.length, upserted: outcome.upserted, removed: outcome.removed }, "templates synchronised with workspace credential");
  return {
    ...base,
    status: "synced",
    templatesSeen: seenIds.length,
    templatesUpserted: outcome.upserted,
    templatesMarkedRemoved: outcome.removed,
  };
}

/** WABAs in the organization that carry a workspace credential association. */
export async function listCredentialWabas(organizationId: number) {
  return db.select({
    id: wabasTable.id,
    externalId: wabasTable.externalId,
    displayName: wabasTable.displayName,
    credentialId: wabasTable.credentialId,
    credentialStatus: whatsappCredentialsTable.status,
  }).from(wabasTable)
    .leftJoin(whatsappCredentialsTable, and(
      eq(whatsappCredentialsTable.id, wabasTable.credentialId),
      eq(whatsappCredentialsTable.organizationId, wabasTable.organizationId),
      eq(whatsappCredentialsTable.kind, CREDENTIAL_KIND_MANUAL_TOKEN),
      eq(whatsappCredentialsTable.provider, CREDENTIAL_PROVIDER),
    ))
    .where(and(eq(wabasTable.organizationId, organizationId), isNotNull(wabasTable.credentialId)))
    .orderBy(wabasTable.id);
}

/**
 * Workspace-level sync: every credential-backed WABA independently, then
 * the legacy connector WABA if the organization has one configured. A
 * failure on one WABA never touches another; the caller gets one result
 * per WABA and no secrets.
 */
export async function syncWorkspaceTemplates(input: {
  organizationId: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: Date;
}): Promise<WorkspaceTemplateSyncResult> {
  const now = input.now ?? new Date();
  const results: WabaTemplateSyncResult[] = [];
  const credentialWabas = await listCredentialWabas(input.organizationId);
  for (const waba of credentialWabas) {
    results.push(await syncWabaTemplates({ organizationId: input.organizationId, wabaId: waba.id, fetchImpl: input.fetchImpl, signal: input.signal, now }));
  }

  // Legacy shared-connector path, only for a WABA that is NOT credential
  // backed. syncWhatsApp keeps its exact existing behaviour.
  const [connection] = await db.select().from(providerConnectionsTable).where(and(
    eq(providerConnectionsTable.organizationId, input.organizationId),
    eq(providerConnectionsTable.provider, "whatsapp-business"),
  ));
  if (connection?.configuredWabaExternalId) {
    const [legacyWaba] = await db.select().from(wabasTable).where(and(
      eq(wabasTable.organizationId, input.organizationId),
      eq(wabasTable.externalId, connection.configuredWabaExternalId),
    ));
    if (!legacyWaba || legacyWaba.credentialId === null) {
      const base = {
        wabaId: legacyWaba?.id ?? 0,
        wabaExternalId: connection.configuredWabaExternalId,
        wabaDisplayName: legacyWaba?.displayName ?? connection.configuredWabaExternalId,
        source: "legacy_connector" as const,
        templatesSeen: 0,
        templatesUpserted: 0,
        templatesMarkedRemoved: 0,
      };
      try {
        const legacy = await syncWhatsApp(input.organizationId);
        const [row] = await db.select({ id: wabasTable.id }).from(wabasTable).where(and(
          eq(wabasTable.organizationId, input.organizationId),
          eq(wabasTable.externalId, connection.configuredWabaExternalId),
        ));
        results.push({ ...base, wabaId: row?.id ?? base.wabaId, status: "synced", templatesSeen: legacy.templates, templatesUpserted: legacy.templates });
      } catch (error) {
        results.push({
          ...base,
          status: "failed",
          error: failure("legacy_sync_failed", error instanceof Error ? error.message.slice(0, 300) : "Legacy connector synchronisation failed"),
        });
      }
    }
  }
  return { syncedAt: now, wabas: results };
}

/** Template ids currently referenced by the given WABA set (helper for callers/tests). */
export async function templatesForWabas(organizationId: number, wabaIds: number[]) {
  if (!wabaIds.length) return [];
  return db.select().from(templatesTable).where(and(eq(templatesTable.organizationId, organizationId), inArray(templatesTable.wabaId, wabaIds)));
}
