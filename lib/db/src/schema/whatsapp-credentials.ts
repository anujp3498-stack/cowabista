import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

// Per-workspace WhatsApp credentials supplied by a person (a Meta system-user
// or permanent access token). The token is stored ONLY as AES-256-GCM
// ciphertext; the plaintext never touches this table, logs, API responses
// or the browser after the connect request completes.
//
//   tokenCiphertext / tokenIv / tokenAuthTag  -- base64 AES-256-GCM output
//   keyVersion                               -- which server key encrypted it
//   tokenFingerprint                         -- sha256 prefix of the token,
//                                               non-secret, lets a workspace
//                                               re-use a row for the same
//                                               token without decrypting it
//
// Rows are scoped to one organization; the AAD used during encryption binds
// the ciphertext to that organization so a row copied into another
// workspace cannot be decrypted there.
export const whatsappCredentialStatuses = ["active", "invalid", "revoked"] as const;
export type WhatsappCredentialStatus = (typeof whatsappCredentialStatuses)[number];

export const whatsappCredentialsTable = pgTable("whatsapp_credentials", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("whatsapp-business"),
  kind: text("kind").notNull().default("manual_token"),
  status: text("status").notNull().default("active"),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenIv: text("token_iv").notNull(),
  tokenAuthTag: text("token_auth_tag").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  tokenFingerprint: text("token_fingerprint").notNull(),
  // Bumped whenever the secret material changes. Transport bindings and
  // prepared send contexts carry (credentialId, revision) so a shard can
  // refuse to send with a binding that predates a re-encryption.
  revision: integer("revision").notNull().default(1),
  providerIdentity: text("provider_identity"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [
  index("whatsapp_credentials_org_idx").on(t.organizationId),
  index("whatsapp_credentials_org_fingerprint_idx").on(t.organizationId, t.tokenFingerprint),
]);

export const insertWhatsappCredentialSchema = createInsertSchema(whatsappCredentialsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWhatsappCredential = z.infer<typeof insertWhatsappCredentialSchema>;
export type WhatsappCredential = typeof whatsappCredentialsTable.$inferSelect;
