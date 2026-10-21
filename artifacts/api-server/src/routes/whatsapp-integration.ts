import { Router, type IRouter } from "express";
import { and, count, desc, eq } from "drizzle-orm";
import {
  GetWhatsAppHealthParams,
  GetWhatsAppHealthResponse,
  GetWhatsAppIntegrationParams,
  GetWhatsAppIntegrationResponse,
  ListWhatsAppWabasParams,
  ListWhatsAppWabasResponse,
  SyncWhatsAppResourcesParams,
  SyncWhatsAppResourcesResponse,
  UpdateWhatsAppIntegrationBody,
  UpdateWhatsAppIntegrationParams,
  UpdateWhatsAppIntegrationResponse,
} from "@workspace/api-zod";
import { db, providerConnectionsTable, wabasTable, whatsappCredentialsTable } from "@workspace/db";
import {
  attachOrgContext,
  requireActiveOrganization,
  requireAuth,
  requireRole,
} from "../middlewares/auth";
import { NO_SENDING_CREDENTIAL_CODE, ProviderRequestError, redactProviderText } from "../services/whatsapp-provider";
import { getOrCreateProviderConnection, syncWhatsApp } from "../services/whatsapp-sync";

// Workspace-level WhatsApp settings. Since R-D1 there is no shared connector: the setting only chooses between
// "mock" (the deterministic test provider for numbers without a credential) and "real" (live: every sending
// number uses its own encrypted workspace credential from Numbers; a number without one cannot send). Nothing
// here calls Meta.

const router: IRouter = Router();
const guards = [requireAuth, attachOrgContext, requireActiveOrganization, requireRole("admin")] as const;

/** Only the exact stored value "mock" is mock; anything else (including an unknown value) is reported as live. */
function publicMode(mode: string): "mock" | "real" {
  return mode === "mock" ? "mock" : "real";
}

function serialize(connection: typeof providerConnectionsTable.$inferSelect) {
  return {
    organizationId: connection.organizationId,
    mode: publicMode(connection.mode),
    // Deprecated (R-D1): the shared connector identity no longer exists.
    connectorAccountId: null,
    configuredWabaExternalId: connection.configuredWabaExternalId,
    status: connection.status,
    health: connection.health,
    lastHealthAt: connection.lastHealthAt,
    lastSyncAt: connection.lastSyncAt,
    lastErrorAt: connection.lastErrorAt,
    lastError: connection.lastError,
    webhookVerificationConfigured: Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
    webhookSignatureConfigured: Boolean(process.env.META_APP_SECRET),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

async function activeCredentialCount(organizationId: number): Promise<number> {
  const [row] = await db.select({ value: count() }).from(whatsappCredentialsTable).where(and(
    eq(whatsappCredentialsTable.organizationId, organizationId),
    eq(whatsappCredentialsTable.status, "active"),
  ));
  return Number(row?.value ?? 0);
}

router.get("/organizations/:organizationId/whatsapp/integration", ...guards, async (req, res): Promise<void> => {
  const params = GetWhatsAppIntegrationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const connection = await getOrCreateProviderConnection(params.data.organizationId);
  res.json(GetWhatsAppIntegrationResponse.parse(serialize(connection)));
});

router.patch("/organizations/:organizationId/whatsapp/integration", ...guards, async (req, res): Promise<void> => {
  const params = UpdateWhatsAppIntegrationParams.safeParse(req.params);
  const body = UpdateWhatsAppIntegrationBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.success ? body.error?.message : params.error.message });
    return;
  }
  const connection = await getOrCreateProviderConnection(params.data.organizationId);
  const currentMode = publicMode(connection.mode);
  const mode = body.data.mode ?? currentMode;
  // Switching between test and live sending (either direction) is an owner decision: leaving live mode
  // re-enables mock "success" for numbers without a credential.
  if (mode !== currentMode && req.role !== "owner") {
    res.status(403).json({ error: "Only an owner may switch this workspace between test (mock) and live sending" });
    return;
  }
  const requestedWaba = body.data.configuredWabaExternalId === undefined ? undefined : body.data.configuredWabaExternalId?.trim() || null;
  if (mode === "real" && requestedWaba) {
    res.status(400).json({ error: "Live workspaces connect each business account with its own credential in Numbers; the WABA ID setting is only for mock synchronisation." });
    return;
  }
  // Live mode keeps no workspace-level WABA: saving clears the setting left over from the retired connector.
  const configuredWabaExternalId = mode === "real" ? null : requestedWaba === undefined ? connection.configuredWabaExternalId : requestedWaba;
  let updated: typeof providerConnectionsTable.$inferSelect;
  try {
    [updated] = await db.update(providerConnectionsTable).set({
      mode,
      connectorAccountId: null,
      configuredWabaExternalId,
      status: mode === "real" || configuredWabaExternalId ? "configured" : "unconfigured",
      health: "unknown",
      lastError: null,
      lastErrorAt: null,
    // Compare-and-set on the mode this request decided from: a concurrent switch (owner-only) is never
    // undone by a stale write that only meant to change the WABA setting.
    }).where(and(eq(providerConnectionsTable.id, connection.id), eq(providerConnectionsTable.mode, connection.mode))).returning();
  } catch (error) {
    req.log.warn({ err: redactProviderText(error instanceof Error ? error.message : error) }, "WhatsApp integration update failed");
    res.status(409).json({ error: "Unable to save the WhatsApp integration settings" });
    return;
  }
  if (!updated) {
    res.status(409).json({ error: "The WhatsApp settings changed while saving. Reload and try again." });
    return;
  }
  res.json(UpdateWhatsAppIntegrationResponse.parse(serialize(updated)));
});

router.get("/organizations/:organizationId/whatsapp/health", ...guards, async (req, res): Promise<void> => {
  const params = GetWhatsAppHealthParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const connection = await getOrCreateProviderConnection(params.data.organizationId);
  const checkedAt = new Date();
  const mode = publicMode(connection.mode);
  // No provider call: mock is always available; live depends on the workspace's own active credentials
  // (each is validated against Meta when it is connected or re-validated in Numbers).
  const healthy = mode === "mock" || (await activeCredentialCount(params.data.organizationId)) > 0;
  const error = healthy ? null : "No active workspace WhatsApp credential. Connect a number in Numbers to send.";
  await db.update(providerConnectionsTable).set({
    health: healthy ? "healthy" : "unhealthy", lastHealthAt: checkedAt, lastError: error, lastErrorAt: healthy ? null : checkedAt,
  }).where(eq(providerConnectionsTable.id, connection.id));
  res.json(GetWhatsAppHealthResponse.parse({ mode, status: healthy ? "healthy" : "not_configured", checkedAt, error }));
});

router.post("/organizations/:organizationId/whatsapp/sync", ...guards, async (req, res, next): Promise<void> => {
  const params = SyncWhatsAppResourcesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    res.json(SyncWhatsAppResourcesResponse.parse(await syncWhatsApp(params.data.organizationId)));
  } catch (error) {
    if (error instanceof ProviderRequestError && error.code === NO_SENDING_CREDENTIAL_CODE) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    req.log.warn({ err: redactProviderText(error instanceof Error ? error.message : error) }, "WhatsApp sync failed");
    next(error);
  }
});

router.get("/organizations/:organizationId/whatsapp/wabas", ...guards, async (req, res): Promise<void> => {
  const params = ListWhatsAppWabasParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const rows = await db.select().from(wabasTable)
    .where(eq(wabasTable.organizationId, params.data.organizationId))
    .orderBy(desc(wabasTable.updatedAt));
  res.json(ListWhatsAppWabasResponse.parse(rows));
});

export default router;