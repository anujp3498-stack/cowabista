import { and, eq, inArray } from "drizzle-orm";
import { db, whatsappCredentialsTable } from "@workspace/db";
import { decryptCredential } from "./credential-crypto";
import { CREDENTIAL_KIND_MANUAL_TOKEN, CREDENTIAL_PROVIDER } from "./whatsapp-manual-connection";

// Parent-plane (main API process) resolution of workspace sending
// credentials. Runs set-based at lane setup and at batch preparation --
// never per message -- and is the only place a stored token is decrypted
// for transport. The plaintext leaves this module solely to be handed to
// the owning transport shard through its credential-bind control message.

export type { TransportAuthRef } from "./campaign-transport-shards";

export type ResolvedSendingCredential = {
  organizationId: number;
  credentialId: number;
  credentialRevision: number;
  /** Plaintext token: in-memory only, hand straight to the shard binding. */
  accessToken: string;
};

export type SendingCredentialState = {
  organizationId: number;
  credentialId: number;
  credentialRevision: number;
  active: boolean;
};

/** Non-secret state for a set of credential ids (one query). */
export async function loadSendingCredentialStates(credentialIds: Iterable<number>): Promise<Map<number, SendingCredentialState>> {
  const ids = [...new Set(credentialIds)];
  if (!ids.length) return new Map();
  const rows = await db.select({
    id: whatsappCredentialsTable.id,
    organizationId: whatsappCredentialsTable.organizationId,
    revision: whatsappCredentialsTable.revision,
    status: whatsappCredentialsTable.status,
    kind: whatsappCredentialsTable.kind,
    provider: whatsappCredentialsTable.provider,
  }).from(whatsappCredentialsTable).where(inArray(whatsappCredentialsTable.id, ids));
  return new Map(rows.map((row) => [row.id, {
    organizationId: row.organizationId,
    credentialId: row.id,
    credentialRevision: row.revision,
    active: row.status === "active" && row.kind === CREDENTIAL_KIND_MANUAL_TOKEN && row.provider === CREDENTIAL_PROVIDER,
  }]));
}

export class SendingCredentialUnavailableError extends Error {
  constructor(readonly organizationId: number, readonly credentialId: number, reason: string) {
    super(`Sending credential ${credentialId} for organization ${organizationId} is unavailable: ${reason}`);
    this.name = "SendingCredentialUnavailableError";
  }
}

/**
 * Loads and decrypts one active workspace credential that MUST belong to
 * the given organization. Fails closed on any mismatch, inactive status or
 * decryption problem (including a missing encryption key): a phone whose
 * sendingCredentialId is set must never fall back to the shared connector.
 */
export async function resolveSendingCredential(organizationId: number, credentialId: number): Promise<ResolvedSendingCredential> {
  const [row] = await db.select().from(whatsappCredentialsTable).where(and(
    eq(whatsappCredentialsTable.id, credentialId),
    eq(whatsappCredentialsTable.organizationId, organizationId),
  ));
  if (!row) throw new SendingCredentialUnavailableError(organizationId, credentialId, "not found in this organization");
  if (row.status !== "active") throw new SendingCredentialUnavailableError(organizationId, credentialId, `status is ${row.status}`);
  if (row.kind !== CREDENTIAL_KIND_MANUAL_TOKEN || row.provider !== CREDENTIAL_PROVIDER) {
    throw new SendingCredentialUnavailableError(organizationId, credentialId, "not a workspace WhatsApp token");
  }
  let accessToken: string;
  try {
    accessToken = decryptCredential(
      { ciphertext: row.tokenCiphertext, iv: row.tokenIv, authTag: row.tokenAuthTag, keyVersion: row.keyVersion },
      { organizationId, kind: row.kind, provider: row.provider },
    );
  } catch (error) {
    throw new SendingCredentialUnavailableError(organizationId, credentialId, error instanceof Error ? error.name : "decryption failed");
  }
  return { organizationId, credentialId, credentialRevision: row.revision, accessToken };
}
