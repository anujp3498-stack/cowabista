import { Router, type IRouter, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  ConnectManualWhatsAppNumberBody,
  ConnectManualWhatsAppNumberParams,
  ConnectManualWhatsAppNumberResponse,
  ListWhatsAppCredentialsParams,
  ListWhatsAppCredentialsResponse,
  RegisterWhatsAppPhoneBody,
  RegisterWhatsAppPhoneParams,
  RegisterWhatsAppPhoneResponse,
  RequestWhatsAppPhoneVerificationCodeBody,
  RequestWhatsAppPhoneVerificationCodeParams,
  RequestWhatsAppPhoneVerificationCodeResponse,
  RevokeWhatsAppCredentialParams,
  RevokeWhatsAppCredentialResponse,
  VerifyWhatsAppPhoneCodeBody,
  VerifyWhatsAppPhoneCodeParams,
  VerifyWhatsAppPhoneCodeResponse,
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
import {
  PhoneSetupError,
  registerPhone,
  requestVerificationCode,
  verifyCode,
  type SetupActionResult,
} from "../services/whatsapp-phone-setup";

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

// ---- V2-02B guided setup: verification + registration ----------------
//
// Bodies carry a one-time verification code or a 6-digit PIN. They are
// parsed, handed to the service and never logged, persisted or echoed.
// The credential is resolved server-side from the phone row; the browser
// cannot name a credential or resend a token.

const SETUP_MESSAGES = {
  verification_code_sent: "Code sent. Enter the code Meta sent to this phone number.",
  registration_required: "Ownership verified. Set a 6-digit PIN to register the number.",
  registered_transport_pending: "Registered with Meta. Wabista sending activation is the final step.",
} as const;

async function respondSetup(res: Response, result: SetupActionResult, schema: typeof RegisterWhatsAppPhoneResponse): Promise<void> {
  const message = SETUP_MESSAGES[result.setupState as keyof typeof SETUP_MESSAGES] ?? "Setup state updated.";
  res.json(schema.parse({
    setupState: result.setupState,
    message: result.applied ? message : `${message} (This number had already moved on; nothing was changed.)`,
    phoneNumber: await serializePhone(result.phone),
  }));
}

function respondSetupError(res: Response, organizationId: number, phoneNumberId: number, action: string, error: unknown): void {
  if (error instanceof PhoneSetupError) {
    logger.info({ organizationId, phoneNumberId, action, code: error.code, providerCode: error.details?.providerCode }, "phone setup refused");
    res.status(error.httpStatus).json({ error: error.message, code: error.code, details: error.details ?? {} });
    return;
  }
  logger.error({ organizationId, phoneNumberId, action, err: error }, "phone setup failed");
  res.status(500).json({ error: "Could not complete this step right now.", code: "provider_unavailable" });
}

router.post("/organizations/:organizationId/whatsapp/numbers/:phoneNumberId/verification/request", ...guards, async (req, res): Promise<void> => {
  const params = RequestWhatsAppPhoneVerificationCodeParams.safeParse(req.params);
  const body = RequestWhatsAppPhoneVerificationCodeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.success ? body.error?.message : params.error.message, code: "invalid_input" });
    return;
  }
  try {
    const result = await requestVerificationCode({
      organizationId: params.data.organizationId,
      phoneNumberId: params.data.phoneNumberId,
      method: body.data.method,
      locale: body.data.locale,
    });
    await respondSetup(res, result, RequestWhatsAppPhoneVerificationCodeResponse);
  } catch (error) {
    respondSetupError(res, params.data.organizationId, params.data.phoneNumberId, "request_code", error);
  }
});

router.post("/organizations/:organizationId/whatsapp/numbers/:phoneNumberId/verification/verify", ...guards, async (req, res): Promise<void> => {
  const params = VerifyWhatsAppPhoneCodeParams.safeParse(req.params);
  const body = VerifyWhatsAppPhoneCodeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    // Zod's message names the field, never the submitted value.
    res.status(400).json({ error: params.success ? "Enter the numeric code Meta sent to this phone." : params.error.message, code: "invalid_input" });
    return;
  }
  try {
    const result = await verifyCode({
      organizationId: params.data.organizationId,
      phoneNumberId: params.data.phoneNumberId,
      code: body.data.code,
    });
    await respondSetup(res, result, VerifyWhatsAppPhoneCodeResponse);
  } catch (error) {
    respondSetupError(res, params.data.organizationId, params.data.phoneNumberId, "verify_code", error);
  }
});

router.post("/organizations/:organizationId/whatsapp/numbers/:phoneNumberId/register", ...guards, async (req, res): Promise<void> => {
  const params = RegisterWhatsAppPhoneParams.safeParse(req.params);
  const body = RegisterWhatsAppPhoneBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.success ? "The PIN must be exactly 6 digits." : params.error.message, code: "invalid_input" });
    return;
  }
  try {
    const result = await registerPhone({
      organizationId: params.data.organizationId,
      phoneNumberId: params.data.phoneNumberId,
      pin: body.data.pin,
    });
    await respondSetup(res, result, RegisterWhatsAppPhoneResponse);
  } catch (error) {
    respondSetupError(res, params.data.organizationId, params.data.phoneNumberId, "register", error);
  }
});

export default router;
