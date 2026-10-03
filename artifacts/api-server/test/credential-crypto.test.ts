import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  CREDENTIAL_ENCRYPTION_KEY_ENV,
  CredentialDecryptionError,
  CredentialEncryptionUnavailableError,
  credentialFingerprint,
  decryptCredential,
  encryptCredential,
  isCredentialEncryptionConfigured,
} from "../src/services/credential-crypto";

// V2-02A: tokens are only ever stored as AES-256-GCM ciphertext bound to
// the owning organization, and a server without the key fails closed.

const key = randomBytes(32);
const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : { [CREDENTIAL_ENCRYPTION_KEY_ENV]: value });
const scope = { organizationId: 42, kind: "manual_token" };
const token = "EAAG-example-token-value-" + randomBytes(16).toString("hex");

test("round-trips a token with a base64 key and never stores the plaintext", () => {
  const enc = encryptCredential(token, scope, env(key.toString("base64")));
  assert.equal(enc.keyVersion, 1);
  assert.notEqual(enc.ciphertext, token);
  assert.ok(!Buffer.from(enc.ciphertext, "base64").toString("utf8").includes(token));
  assert.equal(Buffer.from(enc.iv, "base64").length, 12);
  assert.equal(Buffer.from(enc.authTag, "base64").length, 16);
  assert.equal(decryptCredential(enc, scope, env(key.toString("base64"))), token);
});

test("accepts a 64-char hex key as well", () => {
  const hexEnv = env(key.toString("hex"));
  const enc = encryptCredential(token, scope, hexEnv);
  assert.equal(decryptCredential(enc, scope, hexEnv), token);
});

test("uses a fresh random IV for every encryption", () => {
  const e = env(key.toString("base64"));
  const a = encryptCredential(token, scope, e);
  const b = encryptCredential(token, scope, e);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("ciphertext is bound to the organization through AAD", () => {
  const e = env(key.toString("base64"));
  const enc = encryptCredential(token, scope, e);
  assert.throws(() => decryptCredential(enc, { ...scope, organizationId: 43 }, e), CredentialDecryptionError);
  assert.throws(() => decryptCredential(enc, { ...scope, kind: "other" }, e), CredentialDecryptionError);
});

test("tampered ciphertext or auth tag fails closed", () => {
  const e = env(key.toString("base64"));
  const enc = encryptCredential(token, scope, e);
  const flipped = Buffer.from(enc.ciphertext, "base64");
  flipped[0] = flipped[0]! ^ 0xff;
  assert.throws(() => decryptCredential({ ...enc, ciphertext: flipped.toString("base64") }, scope, e), CredentialDecryptionError);
  assert.throws(() => decryptCredential({ ...enc, authTag: randomBytes(16).toString("base64") }, scope, e), CredentialDecryptionError);
  assert.throws(() => decryptCredential({ ...enc, keyVersion: 2 }, scope, e), CredentialDecryptionError);
});

test("missing, short or malformed keys are refused -- no default and no fallback", () => {
  assert.equal(isCredentialEncryptionConfigured(env()), false);
  assert.throws(() => encryptCredential(token, scope, env()), CredentialEncryptionUnavailableError);
  assert.throws(() => encryptCredential(token, scope, env("")), CredentialEncryptionUnavailableError);
  assert.throws(() => encryptCredential(token, scope, env("short")), CredentialEncryptionUnavailableError);
  assert.throws(() => encryptCredential(token, scope, env(randomBytes(16).toString("base64"))), CredentialEncryptionUnavailableError);
  assert.throws(() => encryptCredential(token, scope, env("not*valid*base64*at*all*not*valid*base64*at*")), CredentialEncryptionUnavailableError);
  // A valid key can't read rows written under a different key.
  const enc = encryptCredential(token, scope, env(key.toString("base64")));
  assert.throws(() => decryptCredential(enc, scope, env(randomBytes(32).toString("base64"))), CredentialDecryptionError);
  assert.equal(isCredentialEncryptionConfigured(env(key.toString("base64"))), true);
});

test("fingerprint is stable, short and does not contain the token", () => {
  const fp = credentialFingerprint(token);
  assert.equal(fp, credentialFingerprint(token));
  assert.equal(fp.length, 32);
  assert.ok(!token.includes(fp) && !fp.includes(token.slice(0, 8)));
  assert.notEqual(fp, credentialFingerprint(`${token}x`));
});

test("empty plaintext is refused", () => {
  assert.throws(() => encryptCredential("", scope, env(key.toString("base64"))));
});
