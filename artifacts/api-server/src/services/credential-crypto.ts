import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

// AES-256-GCM envelope for per-workspace WhatsApp tokens.
//
// Rules this module enforces (see docs/MASTER_SPEC.md, "Credentials"):
//  - the key comes ONLY from WHATSAPP_CREDENTIAL_ENCRYPTION_KEY (32 bytes,
//    base64 or hex). There is no default key, no derived fallback and no
//    per-process random key: a missing or malformed key fails closed with
//    CredentialEncryptionUnavailableError so a misconfigured server can
//    never silently write ciphertext nobody can read back.
//  - every encryption uses a fresh random 96-bit IV and stores the auth tag.
//  - the ciphertext is bound to the owning organization through AAD, so a
//    row copied into another workspace fails authentication on decrypt.
//  - keyVersion is persisted next to the ciphertext so a future key rotation
//    can keep decrypting old rows while new rows use the new key.
//  - the plaintext is never logged, never included in an error message and
//    never returned from any API response.

export const CREDENTIAL_ENCRYPTION_KEY_ENV = "WHATSAPP_CREDENTIAL_ENCRYPTION_KEY";
export const CURRENT_CREDENTIAL_KEY_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class CredentialEncryptionUnavailableError extends Error {
  constructor(message = `${CREDENTIAL_ENCRYPTION_KEY_ENV} is not configured`) {
    super(message);
    this.name = "CredentialEncryptionUnavailableError";
  }
}

export class CredentialDecryptionError extends Error {
  constructor(message = "Stored credential could not be decrypted") {
    super(message);
    this.name = "CredentialDecryptionError";
  }
}

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export interface CredentialScope {
  organizationId: number;
  kind: string;
  provider?: string;
}

function parseKey(raw: string | undefined): Buffer {
  const value = raw?.trim() ?? "";
  if (!value) throw new CredentialEncryptionUnavailableError();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else {
    const decoded = Buffer.from(value, "base64");
    // Buffer.from(…, "base64") silently ignores junk, so re-encode and compare
    // lengths to make sure we were actually handed base64 of 32 bytes.
    if (decoded.length === KEY_BYTES && decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")) {
      key = decoded;
    }
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new CredentialEncryptionUnavailableError(
      `${CREDENTIAL_ENCRYPTION_KEY_ENV} must be 32 bytes encoded as base64 or hex`,
    );
  }
  return key;
}

// Read lazily on every call rather than at import time so the server can
// boot without the key (legacy connector flows still work) and so tests can
// set/unset the variable per case. Only version 1 exists today; a rotation
// would add WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_V2 here and bump CURRENT.
function keyForVersion(version: number, env: NodeJS.ProcessEnv): Buffer {
  if (version !== 1) throw new CredentialDecryptionError(`Unsupported credential key version ${version}`);
  return parseKey(env[CREDENTIAL_ENCRYPTION_KEY_ENV]);
}

export function isCredentialEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    parseKey(env[CREDENTIAL_ENCRYPTION_KEY_ENV]);
    return true;
  } catch {
    return false;
  }
}

function aadFor(scope: CredentialScope): Buffer {
  return Buffer.from(`${scope.provider ?? "whatsapp-business"}:${scope.organizationId}:${scope.kind}`, "utf8");
}

export function encryptCredential(
  plaintext: string,
  scope: CredentialScope,
  env: NodeJS.ProcessEnv = process.env,
): EncryptedCredential {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Cannot encrypt an empty credential");
  }
  const keyVersion = CURRENT_CREDENTIAL_KEY_VERSION;
  const key = keyForVersion(keyVersion, env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadFor(scope));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

export function decryptCredential(
  encrypted: EncryptedCredential,
  scope: CredentialScope,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = keyForVersion(encrypted.keyVersion, env);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAAD(aadFor(scope));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Never surface the underlying crypto error: it can describe tag/length
    // details that are useless to a caller and noisy in logs.
    throw new CredentialDecryptionError();
  }
}

// Non-secret identifier for "is this the same token?" comparisons. A 16-byte
// sha256 prefix cannot be reversed into the token and is only ever compared
// within one workspace.
export function credentialFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, 32);
}

export function fingerprintsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
