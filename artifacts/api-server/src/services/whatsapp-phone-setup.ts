import { and, eq, sql } from "drizzle-orm";
import {
  db,
  phoneNumbersTable,
  wabasTable,
  whatsappCredentialsTable,
  type PhoneNumber,
  type WhatsappCredential,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  CredentialDecryptionError,
  CredentialEncryptionUnavailableError,
  decryptCredential,
} from "./credential-crypto";
import { ManualMetaClient, type FetchLike, type VerificationMethod } from "./whatsapp-manual-client";
import { CREDENTIAL_KIND_MANUAL_TOKEN, CREDENTIAL_PROVIDER, RECONNECT_MESSAGE } from "./whatsapp-manual-connection";
export { RECONNECT_MESSAGE };
import { ProviderRequestError } from "./whatsapp-provider";

// V2-02B guided setup for a manually discovered number:
//
//   discovered → verification_code_sent → registration_required
//              → registered_transport_pending
//
// Two different secrets pass through here and neither is ever persisted,
// logged or echoed: the verification code Meta sends to the phone, and the
// 6-digit two-step PIN the person chooses for /register.
//
// Successful Meta registration does NOT make the number campaign-sendable.
// The engine-facing `status` column is never touched here; binding the
// workspace credential into transport is V2-02C.

export const SETUP_STATES = [
  "unknown",
  "discovered",
  "verification_code_sent",
  "registration_required",
  "registered_transport_pending",
  "active",
  "action_required",
] as const;
export type SetupState = (typeof SETUP_STATES)[number];

// Progress rank. A successful provider response may only move a number
// forward (or re-assert the same step); it can never regress a row that a
// concurrent, faster request already advanced. action_required is a side
// state: any genuine success may leave it.
const RANK: Record<SetupState, number> = {
  unknown: 0,
  action_required: 0,
  discovered: 1,
  verification_code_sent: 2,
  registration_required: 3,
  registered_transport_pending: 4,
  active: 5,
};

export const DEFAULT_VERIFICATION_LOCALE = "en_US";

export type PhoneSetupFailureCode =
  | "phone_not_found"
  | "phone_not_eligible"
  | "credential_inactive"
  | "encryption_unavailable"
  | "invalid_input"
  | "state_conflict"
  | "code_rejected"
  | "registration_rejected"
  | "activation_rejected"
  | "provider_unavailable";

export class PhoneSetupError extends Error {
  constructor(
    readonly code: PhoneSetupFailureCode,
    readonly httpStatus: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PhoneSetupError";
  }
}

function setupStateOf(row: PhoneNumber): SetupState {
  return (SETUP_STATES as readonly string[]).includes(row.setupState) ? (row.setupState as SetupState) : "unknown";
}

export function isProviderVerified(row: PhoneNumber): boolean {
  return row.providerMetadata?.verificationStatus === "VERIFIED";
}

/** Where the guided setup should start for this row. Derived server-side only. */
export function nextSetupStep(row: PhoneNumber): "verify" | "enter_code" | "register" | "done" | "none" {
  const state = setupStateOf(row);
  if (state === "registered_transport_pending" || state === "active") return "done";
  if (state === "registration_required" || isProviderVerified(row)) return "register";
  if (state === "verification_code_sent") return "enter_code";
  if (state === "discovered" || state === "action_required") return "verify";
  return "none";
}

interface SetupContext {
  phone: PhoneNumber;
  credential: WhatsappCredential;
  accessToken: string;
}

// Loads the phone strictly inside the active organization and resolves the
// credential from the phone's own association. The browser never names a
// credential and never resubmits a token.
async function loadContext(organizationId: number, phoneNumberId: number): Promise<SetupContext> {
  const [phone] = await db.select().from(phoneNumbersTable).where(and(
    eq(phoneNumbersTable.id, phoneNumberId),
    eq(phoneNumbersTable.organizationId, organizationId),
  ));
  if (!phone) throw new PhoneSetupError("phone_not_found", 404, "Phone number not found");
  if (phone.isSample) throw new PhoneSetupError("phone_not_eligible", 409, "Sample numbers can't be set up.");
  if (!phone.providerPhoneId) throw new PhoneSetupError("phone_not_eligible", 409, "This number has no WhatsApp phone number ID yet. Connect it manually first.");
  if (!phone.credentialId) throw new PhoneSetupError("credential_inactive", 409, RECONNECT_MESSAGE);

  const [credential] = await db.select().from(whatsappCredentialsTable).where(and(
    eq(whatsappCredentialsTable.id, phone.credentialId),
    eq(whatsappCredentialsTable.organizationId, organizationId),
  ));
  if (
    !credential ||
    credential.status !== "active" ||
    credential.provider !== CREDENTIAL_PROVIDER ||
    credential.kind !== CREDENTIAL_KIND_MANUAL_TOKEN
  ) {
    throw new PhoneSetupError("credential_inactive", 409, RECONNECT_MESSAGE);
  }

  let accessToken: string;
  try {
    accessToken = decryptCredential(
      { ciphertext: credential.tokenCiphertext, iv: credential.tokenIv, authTag: credential.tokenAuthTag, keyVersion: credential.keyVersion },
      { organizationId, kind: credential.kind, provider: credential.provider },
    );
  } catch (error) {
    if (error instanceof CredentialEncryptionUnavailableError) {
      throw new PhoneSetupError("encryption_unavailable", 503, "Manual WhatsApp connection is not configured on this server.");
    }
    if (error instanceof CredentialDecryptionError) {
      throw new PhoneSetupError("credential_inactive", 409, RECONNECT_MESSAGE);
    }
    throw error;
  }
  return { phone, credential, accessToken };
}

function mapProviderError(error: unknown, rejectedCode: "code_rejected" | "registration_rejected" | "activation_rejected", rejectedMessage: string): never {
  if (error instanceof PhoneSetupError) throw error;
  if (error instanceof ProviderRequestError) {
    const status = error.status ?? 0;
    const unreachable = status >= 500 || error.code === "timeout" || error.code === "network" || error.code === "ambiguous_success";
    if (unreachable) {
      throw new PhoneSetupError("provider_unavailable", 502, "WhatsApp (Meta) could not complete this step right now. Try again in a moment.", {
        providerCode: error.code, retryable: error.retryable,
      });
    }
    if (error.code === "190") {
      throw new PhoneSetupError("credential_inactive", 409, RECONNECT_MESSAGE, { providerCode: error.code });
    }
    throw new PhoneSetupError(rejectedCode, 400, rejectedMessage, { providerCode: error.code, providerMessage: error.message });
  }
  throw error;
}

// Short transaction: lock this phone's setup, reload it, and apply `set`
// only if the transition is still valid for the row as it is now.
async function persistTransition(
  organizationId: number,
  phoneNumberId: number,
  target: SetupState,
  build: (current: PhoneNumber) => Partial<typeof phoneNumbersTable.$inferInsert>,
): Promise<{ phone: PhoneNumber; applied: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whatsapp-phone-setup:${organizationId}:${phoneNumberId}`}))`);
    const [current] = await tx.select().from(phoneNumbersTable).where(and(
      eq(phoneNumbersTable.id, phoneNumberId),
      eq(phoneNumbersTable.organizationId, organizationId),
    ));
    if (!current) throw new PhoneSetupError("phone_not_found", 404, "Phone number not found");
    if (RANK[target] < RANK[setupStateOf(current)]) {
      // A faster concurrent request already moved this number further on.
      return { phone: current, applied: false };
    }
    const [updated] = await tx.update(phoneNumbersTable)
      .set({ ...build(current), setupState: target, setupError: null })
      .where(eq(phoneNumbersTable.id, current.id))
      .returning();
    return { phone: updated, applied: true };
  });
}

// Records a redacted, human-readable reason without changing progress
// unless the situation genuinely needs corrective action.
async function recordSetupError(organizationId: number, phoneNumberId: number, message: string, actionRequired: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whatsapp-phone-setup:${organizationId}:${phoneNumberId}`}))`);
    const [current] = await tx.select().from(phoneNumbersTable).where(and(
      eq(phoneNumbersTable.id, phoneNumberId),
      eq(phoneNumbersTable.organizationId, organizationId),
    ));
    if (!current) return;
    await tx.update(phoneNumbersTable).set({
      setupError: message.slice(0, 300),
      ...(actionRequired ? { setupState: "action_required" as const } : {}),
    }).where(eq(phoneNumbersTable.id, current.id));
  });
}

export interface SetupActionInput {
  organizationId: number;
  phoneNumberId: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: Date;
}

export interface SetupActionResult {
  phone: PhoneNumber;
  setupState: SetupState;
  applied: boolean;
}

export async function requestVerificationCode(
  input: SetupActionInput & { method: VerificationMethod; locale?: string },
): Promise<SetupActionResult> {
  const now = input.now ?? new Date();
  if (input.method !== "SMS" && input.method !== "VOICE") {
    throw new PhoneSetupError("invalid_input", 400, "Choose SMS or a voice call.");
  }
  const locale = input.locale?.trim() || DEFAULT_VERIFICATION_LOCALE;
  if (!/^[a-z]{2}_[A-Z]{2}$/.test(locale)) throw new PhoneSetupError("invalid_input", 400, "Unsupported locale.");

  const ctx = await loadContext(input.organizationId, input.phoneNumberId);
  const state = setupStateOf(ctx.phone);
  if (RANK[state] >= RANK.registration_required || isProviderVerified(ctx.phone)) {
    throw new PhoneSetupError("state_conflict", 409, "This number is already verified. Continue with registration.");
  }

  const client = new ManualMetaClient({ accessToken: ctx.accessToken, fetchImpl: input.fetchImpl });
  try {
    await client.requestVerificationCode(ctx.phone.providerPhoneId!, input.method, locale, input.signal);
  } catch (error) {
    const mapped = toSetupError(() => mapProviderError(error, "code_rejected", "Meta could not send a verification code to this number right now."));
    await recordSetupError(input.organizationId, input.phoneNumberId, mapped.message, mapped.code === "credential_inactive");
    logger.info({ organizationId: input.organizationId, phoneNumberId: input.phoneNumberId, action: "request_code", code: mapped.code, providerCode: mapped.details?.providerCode }, "phone setup step refused");
    throw mapped;
  }

  const { phone, applied } = await persistTransition(input.organizationId, input.phoneNumberId, "verification_code_sent", (current) => ({
    providerMetadata: {
      ...current.providerMetadata,
      verificationMethod: input.method,
      verificationRequestedAt: now.toISOString(),
    },
  }));
  return { phone, setupState: setupStateOf(phone), applied };
}

export async function verifyCode(input: SetupActionInput & { code: string }): Promise<SetupActionResult> {
  const now = input.now ?? new Date();
  const code = typeof input.code === "string" ? input.code.trim() : "";
  // Meta documents `code` only as a required numeric string, so the only
  // rules here are non-empty and digits-only. No length is assumed. The
  // value stays a string so leading zeroes survive, and it is never
  // persisted.
  if (!/^\d+$/.test(code)) throw new PhoneSetupError("invalid_input", 400, "Enter the numeric code Meta sent to this phone.");

  const ctx = await loadContext(input.organizationId, input.phoneNumberId);
  if (RANK[setupStateOf(ctx.phone)] >= RANK.registration_required) {
    throw new PhoneSetupError("state_conflict", 409, "This number is already verified. Continue with registration.");
  }

  const client = new ManualMetaClient({ accessToken: ctx.accessToken, fetchImpl: input.fetchImpl });
  try {
    await client.verifyCode(ctx.phone.providerPhoneId!, code, input.signal);
  } catch (error) {
    const mapped = toSetupError(() => mapProviderError(error, "code_rejected", "That verification code was not accepted. Check the code and try again."));
    // Keep the code-entry state so the person can simply retry.
    await recordSetupError(input.organizationId, input.phoneNumberId, mapped.message, mapped.code === "credential_inactive");
    logger.info({ organizationId: input.organizationId, phoneNumberId: input.phoneNumberId, action: "verify_code", code: mapped.code, providerCode: mapped.details?.providerCode }, "phone setup step refused");
    throw mapped;
  }

  const { phone, applied } = await persistTransition(input.organizationId, input.phoneNumberId, "registration_required", (current) => ({
    providerMetadata: {
      ...current.providerMetadata,
      verificationStatus: "VERIFIED",
      verifiedAt: now.toISOString(),
    },
  }));
  return { phone, setupState: setupStateOf(phone), applied };
}

export async function registerPhone(input: SetupActionInput & { pin: string }): Promise<SetupActionResult> {
  const now = input.now ?? new Date();
  const pin = typeof input.pin === "string" ? input.pin : "";
  if (!/^\d{6}$/.test(pin)) throw new PhoneSetupError("invalid_input", 400, "The PIN must be exactly 6 digits.");

  const ctx = await loadContext(input.organizationId, input.phoneNumberId);
  const state = setupStateOf(ctx.phone);
  // Only provider-derived evidence of ownership verification unlocks
  // registration: either our own successful verify_code step or Meta's
  // persisted VERIFIED status from discovery. Never a browser flag.
  const verified = state === "registration_required" || state === "registered_transport_pending" || isProviderVerified(ctx.phone);
  if (!verified) {
    throw new PhoneSetupError("state_conflict", 409, "Verify that you own this number before registering it.");
  }

  const client = new ManualMetaClient({ accessToken: ctx.accessToken, fetchImpl: input.fetchImpl });
  try {
    await client.registerPhone(ctx.phone.providerPhoneId!, pin, input.signal);
  } catch (error) {
    const mapped = toSetupError(() => mapProviderError(error, "registration_rejected", "Meta did not accept the registration. Check the PIN or complete any pending steps in Meta Business Manager, then try again."));
    await recordSetupError(input.organizationId, input.phoneNumberId, mapped.message, mapped.code === "credential_inactive");
    logger.info({ organizationId: input.organizationId, phoneNumberId: input.phoneNumberId, action: "register", code: mapped.code, providerCode: mapped.details?.providerCode }, "phone setup step refused");
    throw mapped;
  }

  // `status` is deliberately not written: a legacy Connected number keeps
  // its connector-backed readiness, and a new manual number stays Pending
  // until V2-02C activates transport for workspace credentials.
  const { phone, applied } = await persistTransition(input.organizationId, input.phoneNumberId, "registered_transport_pending", (current) => ({
    providerMetadata: {
      ...current.providerMetadata,
      verificationStatus: "VERIFIED",
      registrationStatus: "registered",
      registeredAt: now.toISOString(),
    },
  }));
  return { phone, setupState: setupStateOf(phone), applied };
}

/**
 * V2-02C sending activation. The ONLY transition that makes a
 * workspace-credential number campaign-sendable. Validates, server-side,
 * that the number is registered, that its setup credential is active and
 * owns its WABA, that the credential decrypts on this server, and that the
 * credential can still read the exact provider phone (a GET; no message is
 * sent). Then, under the phone setup lock:
 *   sendingCredentialId = credential.id, status = Connected,
 *   setupState = active, setupError = null.
 */
export async function activateSending(input: SetupActionInput): Promise<SetupActionResult> {
  const now = input.now ?? new Date();
  const ctx = await loadContext(input.organizationId, input.phoneNumberId);
  const state = setupStateOf(ctx.phone);
  if (state !== "registered_transport_pending" && state !== "active") {
    throw new PhoneSetupError("state_conflict", 409, "Register this number with Meta before activating sending.");
  }
  if (!ctx.phone.wabaId) {
    throw new PhoneSetupError("phone_not_eligible", 409, "This number has no WhatsApp Business Account. Connect it manually again.");
  }
  const [waba] = await db.select().from(wabasTable).where(and(
    eq(wabasTable.id, ctx.phone.wabaId),
    eq(wabasTable.organizationId, input.organizationId),
  ));
  if (!waba) throw new PhoneSetupError("phone_not_eligible", 409, "This number's WhatsApp Business Account is not in this workspace.");
  if (waba.credentialId !== ctx.credential.id) {
    throw new PhoneSetupError("credential_inactive", 409, "This number's business account is linked to a different credential. Reconnect the number to continue.");
  }

  const client = new ManualMetaClient({ accessToken: ctx.accessToken, fetchImpl: input.fetchImpl });
  try {
    const provider = await client.getPhoneNumber(ctx.phone.providerPhoneId!, input.signal);
    if (provider.id !== ctx.phone.providerPhoneId) {
      throw new PhoneSetupError("activation_rejected", 400, "Meta returned a different phone number for this ID. Reconnect the number.");
    }
  } catch (error) {
    const mapped = toSetupError(() => mapProviderError(error, "activation_rejected", "Meta did not allow access to this number with the connected credential. Check the token's permissions or reconnect the number."));
    await recordSetupError(input.organizationId, input.phoneNumberId, mapped.message, mapped.code === "credential_inactive");
    logger.info({ organizationId: input.organizationId, phoneNumberId: input.phoneNumberId, action: "activate_sending", code: mapped.code, providerCode: mapped.details?.providerCode }, "phone setup step refused");
    throw mapped;
  }

  const { phone, applied } = await persistTransition(input.organizationId, input.phoneNumberId, "active", (current) => ({
    status: "Connected",
    sendingCredentialId: ctx.credential.id,
    providerMetadata: {
      ...current.providerMetadata,
      sendingActivatedAt: now.toISOString(),
    },
  }));
  logger.info({ organizationId: input.organizationId, phoneNumberId: input.phoneNumberId, credentialId: ctx.credential.id, applied }, "workspace sending activated for phone");
  return { phone, setupState: setupStateOf(phone), applied };
}

function toSetupError(thrower: () => never): PhoneSetupError {
  try {
    thrower();
  } catch (error) {
    if (error instanceof PhoneSetupError) return error;
    throw error;
  }
}
