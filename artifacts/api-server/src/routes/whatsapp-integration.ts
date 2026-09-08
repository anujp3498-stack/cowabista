import { Router, type IRouter } from "express";
import { and, desc, eq, ne, or } from "drizzle-orm";
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
import { db, providerConnectionsTable, wabasTable } from "@workspace/db";
import {
  attachOrgContext,
  requireActiveOrganization,
  requireAuth,
  requireRole,
} from "../middlewares/auth";
import { providerClient, redactProviderText, type ProviderMode } from "../services/whatsapp-provider";
import { getOrCreateProviderConnection, syncWhatsApp } from "../services/whatsapp-sync";

const router: IRouter = Router();
const guards = [requireAuth, attachOrgContext, requireActiveOrganization, requireRole("admin")] as const;

function serialize(connection: typeof providerConnectionsTable.$inferSelect) {
  return {
    organizationId: connection.organizationId,
    mode: connection.mode,
    connectorAccountId: connection.connectorAccountId,
    configuredWabaExternalId: connection.configuredWabaExternalId,
    status: connection.status,
    health: connection.health,
    lastHealthAt: connection.lastHealthAt,
    lastSyncAt: connection.lastSyncAt,
    lastErrorAt: connection.lastErrorAt,
    lastError: connection.lastError,
    webhookVerificationConfigured: Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
    webhookSignatureConfigured: Boolean(process.env.META_APP_SECRET),
    realWorkspaceLimit: "This deployment permits one real WhatsApp workspace because its connector credential is shared.",
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
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
  const configuredWabaExternalId = body.data.configuredWabaExternalId === undefined
    ? connection.configuredWabaExternalId
    : body.data.configuredWabaExternalId?.trim() || null;
  const mode = body.data.mode ?? connection.mode;
  const changesRealClaim = mode === "real" && (
    connection.mode !== "real" || configuredWabaExternalId !== connection.configuredWabaExternalId
  );
  if (changesRealClaim && req.role !== "owner") {
    res.status(403).json({ error: "Only an owner may enable or change the deployment's single real WhatsApp workspace" });
    return;
  }
  let connectorAccountId: string | null = connection.connectorAccountId;
  if (mode === "real") {
    if (!configuredWabaExternalId) {
      res.status(400).json({ error: "A WhatsApp Business Account ID is required for real mode" });
      return;
    }
    try {
      const client = providerClient("real");
      connectorAccountId = await client.identity();
      await Promise.all([
        client.listPhoneNumbers(configuredWabaExternalId),
        client.listTemplates(configuredWabaExternalId),
      ]);
    } catch (error) {
      res.status(400).json({ error: `Unable to verify real WhatsApp access: ${redactProviderText(error instanceof Error ? error.message : error)}` });
      return;
    }
  }
  let updated: typeof providerConnectionsTable.$inferSelect;
  try {
    updated = await db.transaction(async (tx) => {
      if (mode === "real") {
        const [claimed] = await tx.select({ id: providerConnectionsTable.id }).from(providerConnectionsTable).where(and(
          eq(providerConnectionsTable.provider, "whatsapp-business"),
          eq(providerConnectionsTable.mode, "real"),
          ne(providerConnectionsTable.organizationId, params.data.organizationId),
          or(
            eq(providerConnectionsTable.connectorAccountId, connectorAccountId!),
            eq(providerConnectionsTable.configuredWabaExternalId, configuredWabaExternalId!),
          ),
        ));
        if (claimed) throw new Error("This deployment's connector identity or WABA is already claimed by another workspace");
        await tx.insert(wabasTable).values({
          organizationId: params.data.organizationId,
          externalId: configuredWabaExternalId!,
          displayName: configuredWabaExternalId!,
          provider: "whatsapp-business",
          providerStatus: "verified",
        }).onConflictDoNothing();
      }
      const [saved] = await tx.update(providerConnectionsTable).set({
        mode, connectorAccountId: mode === "real" ? connectorAccountId : null,
        configuredWabaExternalId,
        status: configuredWabaExternalId ? "configured" : "unconfigured",
        health: "unknown", lastError: null, lastErrorAt: null,
      }).where(eq(providerConnectionsTable.id, connection.id)).returning();
      return saved;
    });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to claim real WhatsApp workspace" });
    return;
  }
  res.json(UpdateWhatsAppIntegrationResponse.parse(serialize(updated)));
});

router.get("/organizations/:organizationId/whatsapp/health", ...guards, async (req, res): Promise<void> => {
  const params = GetWhatsAppHealthParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const connection = await getOrCreateProviderConnection(params.data.organizationId);
  const checkedAt = new Date();
  if (connection.mode === "real" && !connection.configuredWabaExternalId) {
    res.json(GetWhatsAppHealthResponse.parse({ mode: "real", status: "not_configured", checkedAt, error: "WhatsApp Business Account ID is not configured" }));
    return;
  }
  try {
    await providerClient(connection.mode as ProviderMode).health();
    await db.update(providerConnectionsTable).set({
      status: "healthy", health: "healthy", lastHealthAt: checkedAt, lastError: null, lastErrorAt: null,
    }).where(eq(providerConnectionsTable.id, connection.id));
    res.json(GetWhatsAppHealthResponse.parse({ mode: connection.mode, status: "healthy", checkedAt, error: null }));
  } catch (error) {
    const message = redactProviderText(error instanceof Error ? error.message : error);
    await db.update(providerConnectionsTable).set({
      status: "error", health: "unhealthy", lastHealthAt: checkedAt, lastError: message, lastErrorAt: checkedAt,
    }).where(eq(providerConnectionsTable.id, connection.id));
    res.json(GetWhatsAppHealthResponse.parse({ mode: connection.mode, status: "unhealthy", checkedAt, error: message }));
  }
});

router.post("/organizations/:organizationId/whatsapp/sync", ...guards, async (req, res, next): Promise<void> => {
  const params = SyncWhatsAppResourcesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    res.json(SyncWhatsAppResourcesResponse.parse(await syncWhatsApp(params.data.organizationId)));
  } catch (error) {
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