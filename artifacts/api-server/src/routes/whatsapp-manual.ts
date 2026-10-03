import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  ConnectManualWhatsAppNumberBody,
  ConnectManualWhatsAppNumberParams,
  ConnectManualWhatsAppNumberResponse,
  ListWhatsAppCredentialsParams,
  ListWhatsAppCredentialsResponse,
  RevokeWhatsAppCredentialParams,
  RevokeWhatsAppCredentialResponse,
} from "@workspace/api-zod";
import { db, wabasTable, type PhoneNumber } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  attachOrgContext,
  requireActiveOrganization,
  requireAuth,
  requireRole,
} from "../middlewares/auth";
import {
  connectManualNumber,
  listCredentials,
  ManualConnectError,
  revokeCredential,
  serializeCredential,
} from "../services/whatsapp-manual-connection";

// V2-02A: per-workspace manual WhatsApp connection. Owner/admin only, same
// guard chain as the legacy integration route. The request body carries a
// bearer token; it is read once, handed to the service and never logged,
// echoed or stored outside the encrypted credential row.

const router: IRouter = Router();
const guards = [requireAuth, attachOrgContext, requireActiveOrganization, requireRole("admin")] as const;

async function serializePhone(row: PhoneNumber) {
  let wabaExternalId: string | null = null;
  let wabaDisplayName: string | null = null;
  if (row.wabaId) {
    const [waba] = await db.select().from(wabasTable).where(eq(wabasTable.id, row.wabaId));
    wabaExternalId = waba?.externalId ?? null;
    wabaDisplayName = waba?.displayName ?? null;
  }
  return { ...row, wabaExternalId, wabaDisplayName };
}

router.post("/organizations/:organizationId/whatsapp/manual/connect", ...guards, async (req, res): Promise<void> => {
  const params = ConnectManualWhatsAppNumberParams.safeParse(req.params);
  const body = ConnectManualWhatsAppNumberBody.safeParse(req.body);
  if (!params.success || !body.success) {
    // Zod's error text names the field, never its value, so it is safe here.
    res.status(400).json({ error: params.success ? body.error?.message : params.error.message, code: "invalid_phone" });
    return;
  }
  try {
    const result = await connectManualNumber({
      organizationId: params.data.organizationId,
      phoneNumber: body.data.phoneNumber,
      accessToken: body.data.accessToken,
      wabaId: body.data.wabaId ?? null,
    });
    if (result.outcome === "waba_id_required") {
      res.json(ConnectManualWhatsAppNumberResponse.parse({
        outcome: "waba_id_required",
        message: "The token is valid. Enter the WhatsApp Business Account ID that owns this number so we can find it.",
      }));
      return;
    }
    res.json(ConnectManualWhatsAppNumberResponse.parse({
      outcome: "connected",
      message: "WhatsApp number discovered. It still needs verification before it can send.",
      phoneNumber: await serializePhone(result.phoneNumber),
      waba: result.waba,
      credential: serializeCredential(result.credential),
    }));
  } catch (error) {
    if (error instanceof ManualConnectError) {
      logger.info(
        { organizationId: params.data.organizationId, code: error.code, details: error.details },
        "manual WhatsApp connect refused",
      );
      res.status(error.httpStatus).json({ error: error.message, code: error.code, details: error.details ?? {} });
      return;
    }
    logger.error({ organizationId: params.data.organizationId, err: error }, "manual WhatsApp connect failed");
    res.status(500).json({ error: "Could not connect the number right now.", code: "provider_unavailable" });
  }
});

router.get("/organizations/:organizationId/whatsapp/credentials", ...guards, async (req, res): Promise<void> => {
  const params = ListWhatsAppCredentialsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const rows = await listCredentials(params.data.organizationId);
  res.json(ListWhatsAppCredentialsResponse.parse(rows.map(serializeCredential)));
});

router.delete("/organizations/:organizationId/whatsapp/credentials/:credentialId", ...guards, async (req, res): Promise<void> => {
  const params = RevokeWhatsAppCredentialParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const revoked = await revokeCredential(params.data.organizationId, params.data.credentialId);
  if (!revoked) { res.status(404).json({ error: "Credential not found" }); return; }
  res.json(RevokeWhatsAppCredentialResponse.parse(serializeCredential(revoked)));
});

export default router;
