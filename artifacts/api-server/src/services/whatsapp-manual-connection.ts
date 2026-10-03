import { and, eq, ne, sql } from "drizzle-orm";
import {
  db,
  phoneNumbersTable,
  wabasTable,
  whatsappCredentialsTable,
  type PhoneNumber,
  type Waba,
  type WhatsappCredential,
} from "@workspace/db";
import { normalizePhone } from "./contact-processing";
import {
  credentialFingerprint,
  CredentialEncryptionUnavailableError,
  encryptCredential,
  isCredentialEncryptionConfigured,
} from "./credential-crypto";
import { ManualMetaClient, type FetchLike } from "./whatsapp-manual-client";
import { ProviderRequestError, type MetaPhoneNumber } from "./whatsapp-provider";

// V2-02A manual number discovery.
//
// A person pastes a Meta access token and their phone number (and, when the
// token cannot enumerate it, the WABA id). We prove the token is live, prove
// it can see that WABA, prove the phone number is in that WABA, make sure
// no other workspace already claims the number or WABA, and only THEN
// persist -- credential, WABA and phone -- in a single transaction.
//
// The discovered phone is persisted with the legacy `status = "Pending"`
// and the new `setupState = "discovered"`: it is explicitly NOT sendable.
// Verification / registration (V2-02B) and transport binding (V2-02C) come
// later and nothing here pretends otherwise.

export const CREDENTIAL_KIND_MANUAL_TOKEN = "manual_token";
export const CREDENTIAL_PROVIDER = "whatsapp-business";
export const SETUP_STATE_DISCOVERED = "discovered";

export type ManualConnectFailureCode =
  | "encryption_unavailable"
  | "invalid_phone"
  | "token_rejected"
  | "waba_denied"
  | "phone_not_found"
  | "number_claimed"
  | "waba_claimed"
  | "provider_unavailable";

export class ManualConnectError extends Error {
  constructor(
    readonly code: ManualConnectFailureCode,
    readonly httpStatus: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ManualConnectError";
  }
}

export interface ManualConnectInput {
  organizationId: number;
  phoneNumber: string;
  accessToken: string;
  wabaId?: string | null;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: Date;
}

export type ManualConnectResult =
  | { outcome: "waba_id_required"; providerIdentity: string }
  | {
      outcome: "connected";
      credential: WhatsappCredential;
      waba: Waba;
      phoneNumber: PhoneNumber;
      providerIdentity: string;
    };

// Phone input is lenient about formatting ("+1 (555) 000-0001", "15550000001")
// but must resolve to one E.164 value. A number typed without "+" is treated
// as already carrying its country code, which is how Meta displays numbers.
export function normalizeManualPhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ManualConnectError("invalid_phone", 400, "Enter the phone number you want to connect.");
  const candidate = /^[+0]/.test(trimmed.replace(/[^\d+]/g, "")) ? trimmed : `+${trimmed}`;
  const normalized = normalizePhone(candidate);
  if (!normalized.value) {
    throw new ManualConnectError("invalid_phone", 400, "Enter the full phone number with its country code, for example +15550000001.");
  }
  return normalized.value;
}

function normalizeMetaPhone(display: string | undefined): string | null {
  if (!display) return null;
  const digits = display.replace(/[^\d+]/g, "");
  const normalized = normalizePhone(digits.startsWith("+") ? digits : `+${digits}`);
  return normalized.value ?? null;
}

function qualityFor(rating?: string): string {
  return rating === "RED" ? "Low" : rating === "YELLOW" ? "Medium" : "High";
}

function mapProviderError(error: unknown, stage: "token" | "waba" | "phones"): never {
  if (error instanceof ManualConnectError) throw error;
  if (error instanceof ProviderRequestError) {
    const status = error.status ?? 0;
    const unreachable = status >= 500 || error.code === "timeout" || error.code === "network";
    const denied = !unreachable && (status === 400 || status === 401 || status === 403 || status === 404 || error.code === "190" || error.code === "100");
    if (stage === "token" && denied) {
      throw new ManualConnectError("token_rejected", 400, "Meta did not accept this access token. Check that it is a valid, unexpired token.", { providerCode: error.code });
    }
    if (denied) {
      throw new ManualConnectError("waba_denied", 400, "This token can't access that WhatsApp Business Account. Check the WABA ID and the token's permissions.", { providerCode: error.code });
    }
    throw new ManualConnectError("provider_unavailable", 502, "WhatsApp (Meta) could not be reached right now. Try again in a moment.", { providerCode: error.code, retryable: error.retryable });
  }
  throw error;
}

export async function connectManualNumber(input: ManualConnectInput): Promise<ManualConnectResult> {
  const now = input.now ?? new Date();
  const { organizationId } = input;

  // 1. Fail closed before any network call if the server can't encrypt.
  if (!isCredentialEncryptionConfigured()) {
    throw new ManualConnectError("encryption_unavailable", 503, "Manual WhatsApp connection is not configured on this server.");
  }
  const accessToken = input.accessToken?.trim() ?? "";
  if (!accessToken) throw new ManualConnectError("token_rejected", 400, "Paste the access token from Meta.");
  const phone = normalizeManualPhone(input.phoneNumber);
  const wabaExternalId = input.wabaId?.trim() || null;

  const client = new ManualMetaClient({ accessToken, fetchImpl: input.fetchImpl });

  // 2. Prove the token is live.
  let providerIdentity: string;
  try {
    const identity = await client.identity(input.signal);
    providerIdentity = identity.id;
  } catch (error) {
    mapProviderError(error, "token");
  }

  // 3. Without a WABA id we cannot enumerate numbers for an arbitrary token
  //    (the /me edges differ per token type), so ask for it explicitly.
  //    This is a structured, expected outcome -- not an error.
  if (!wabaExternalId) return { outcome: "waba_id_required", providerIdentity };

  // 4. Prove the token can read that WABA, then find the phone inside it.
  let waba: { id: string; name?: string };
  let phones: MetaPhoneNumber[];
  try {
    waba = await client.getWaba(wabaExternalId, input.signal);
    phones = await client.listPhoneNumbers(waba.id, input.signal);
  } catch (error) {
    mapProviderError(error, "waba");
  }
  const match = phones.find((candidate) => normalizeMetaPhone(candidate.display_phone_number) === phone);
  if (!match) {
    throw new ManualConnectError("phone_not_found", 404, "That phone number isn't in this WhatsApp Business Account. Check the number or the WABA ID.", {
      discoveredCount: phones.length,
    });
  }

  // 5. Encrypt (org-bound) before entering the transaction so no key or
  //    crypto failure can happen while locks are held.
  let encrypted;
  try {
    encrypted = encryptCredential(accessToken, { organizationId, kind: CREDENTIAL_KIND_MANUAL_TOKEN, provider: CREDENTIAL_PROVIDER });
  } catch (error) {
    if (error instanceof CredentialEncryptionUnavailableError) {
      throw new ManualConnectError("encryption_unavailable", 503, "Manual WhatsApp connection is not configured on this server.");
    }
    throw error;
  }
  const fingerprint = credentialFingerprint(accessToken);

  // 6. One transaction. Every Meta call is already finished, so no network
  //    time is spent holding locks. Transaction-scoped advisory locks on the
  //    discovered assets serialize competing claims across workspaces (the
  //    DB unique indexes are organization-scoped, so they cannot do this on
  //    their own) and the credential lock serializes identical submissions
  //    inside one workspace. Keys contain only provider IDs and the
  //    non-secret fingerprint, never the token. A hashtext collision merely
  //    serializes unrelated work.
  const lockKeys = [
    `whatsapp-claim:waba:${waba.id}`,
    `whatsapp-claim:phone:${match.id}`,
    `whatsapp-credential:${organizationId}:${fingerprint}`,
  ].sort();

  return db.transaction(async (tx) => {
    for (const key of lockKeys) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    }

    // Authoritative cross-tenant checks, performed only after the locks are
    // held. Error text never names the other workspace.
    const [phoneClaim] = await tx.select({ id: phoneNumbersTable.id }).from(phoneNumbersTable).where(and(
      eq(phoneNumbersTable.providerPhoneId, match.id),
      ne(phoneNumbersTable.organizationId, organizationId),
    )).limit(1);
    if (phoneClaim) {
      throw new ManualConnectError("number_claimed", 409, "This WhatsApp number is already connected to another workspace.");
    }
    const [wabaClaim] = await tx.select({ id: wabasTable.id }).from(wabasTable).where(and(
      eq(wabasTable.externalId, waba.id),
      ne(wabasTable.organizationId, organizationId),
    )).limit(1);
    if (wabaClaim) {
      throw new ManualConnectError("waba_claimed", 409, "This WhatsApp Business Account is already connected to another workspace.");
    }

    const [existingCredential] = await tx.select().from(whatsappCredentialsTable).where(and(
      eq(whatsappCredentialsTable.organizationId, organizationId),
      eq(whatsappCredentialsTable.kind, CREDENTIAL_KIND_MANUAL_TOKEN),
      eq(whatsappCredentialsTable.tokenFingerprint, fingerprint),
      eq(whatsappCredentialsTable.status, "active"),
    )).limit(1);

    let credential: WhatsappCredential;
    if (existingCredential) {
      // Same token re-submitted: refresh validation metadata only; the
      // ciphertext on disk is already this token under this org's AAD.
      const [updated] = await tx.update(whatsappCredentialsTable).set({
        providerIdentity,
        lastValidatedAt: now,
        lastError: null,
      }).where(eq(whatsappCredentialsTable.id, existingCredential.id)).returning();
      credential = updated;
    } else {
      const [created] = await tx.insert(whatsappCredentialsTable).values({
        organizationId,
        provider: CREDENTIAL_PROVIDER,
        kind: CREDENTIAL_KIND_MANUAL_TOKEN,
        status: "active",
        tokenCiphertext: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenAuthTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        tokenFingerprint: fingerprint,
        providerIdentity,
        lastValidatedAt: now,
      }).returning();
      credential = created;
    }

    const wabaDisplayName = waba.name?.trim() || waba.id;
    const [wabaRow] = await tx.insert(wabasTable).values({
      organizationId,
      externalId: waba.id,
      displayName: wabaDisplayName,
      provider: CREDENTIAL_PROVIDER,
      providerStatus: "discovered",
      credentialId: credential.id,
      lastSyncedAt: now,
    }).onConflictDoUpdate({
      target: [wabasTable.organizationId, wabasTable.externalId],
      set: { displayName: wabaDisplayName, credentialId: credential.id, lastSyncedAt: now },
    }).returning();

    const providerMetadata = {
      qualityRating: match.quality_rating,
      verificationStatus: match.code_verification_status,
      source: "manual",
      // Throughput is deliberately NOT requested in this milestone, so no
      // approvedTpsLimit is written: the TPS gate in routes/phone-numbers.ts
      // keeps the conservative default for manually discovered numbers.
    };
    const displayName = match.verified_name?.trim() || phone;
    const [phoneRow] = await tx.insert(phoneNumbersTable).values({
      organizationId,
      wabaId: wabaRow.id,
      providerPhoneId: match.id,
      phone,
      displayName,
      provider: "Cloud API",
      quality: qualityFor(match.quality_rating),
      // Never "Connected" from discovery alone: the engine treats Connected
      // as sendable and this number has not been verified or registered.
      status: "Pending",
      setupState: SETUP_STATE_DISCOVERED,
      setupError: null,
      credentialId: credential.id,
      providerMetadata,
      lastSyncedAt: now,
    }).onConflictDoUpdate({
      target: [phoneNumbersTable.organizationId, phoneNumbersTable.providerPhoneId],
      set: {
        wabaId: wabaRow.id,
        phone,
        displayName,
        quality: qualityFor(match.quality_rating),
        setupState: SETUP_STATE_DISCOVERED,
        setupError: null,
        credentialId: credential.id,
        providerMetadata,
        lastSyncedAt: now,
        // `status` and `tpsLimit` are intentionally left untouched on
        // re-discovery so a number the legacy sync already marked Connected
        // is not demoted, and an operator-approved TPS cap is not reset.
      },
    }).returning();

    return { outcome: "connected" as const, credential, waba: wabaRow, phoneNumber: phoneRow, providerIdentity };
  });
}

export async function listCredentials(organizationId: number): Promise<WhatsappCredential[]> {
  return db.select().from(whatsappCredentialsTable)
    .where(eq(whatsappCredentialsTable.organizationId, organizationId))
    .orderBy(whatsappCredentialsTable.id);
}

export async function revokeCredential(organizationId: number, credentialId: number): Promise<WhatsappCredential | null> {
  const [updated] = await db.update(whatsappCredentialsTable).set({ status: "revoked" }).where(and(
    eq(whatsappCredentialsTable.organizationId, organizationId),
    eq(whatsappCredentialsTable.id, credentialId),
  )).returning();
  return updated ?? null;
}

// The only shape a credential ever leaves the server in. No ciphertext, no
// IV, no tag, no token.
export function serializeCredential(row: WhatsappCredential) {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    status: row.status,
    fingerprint: row.tokenFingerprint.slice(0, 8),
    providerIdentity: row.providerIdentity,
    lastValidatedAt: row.lastValidatedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}
