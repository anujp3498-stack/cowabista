import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { campaignsTable } from "./campaigns";
import { phoneNumbersTable } from "./phone-numbers";
import { usersTable } from "./users";

// V2-05B Message Studio (all additive).

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
};

/**
 * The Message Studio's own record of a campaign's message setup: which
 * sending numbers the user selected (templates stay in
 * campaign_template_selections, mappings in campaign_template_mappings) and
 * the optimistic revision every Message Studio write must present. Routes
 * remain the allocator-v1 execution model and are DERIVED from this
 * selection only when v1 can execute it (one template per sender); a
 * selection v1 cannot run is saved without routes and reported by
 * readiness, never turned into misleading routes. Legacy route/setup
 * writers bump the revision and keep the sender list in step.
 */
export const campaignMessageSetupsTable = pgTable("campaign_message_setups", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
  senderPhoneNumberIds: integer("sender_phone_number_ids").array().notNull().default(sql`'{}'::integer[]`),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => [uniqueIndex("campaign_message_setup_campaign_uq").on(t.campaignId)]);

export const campaignMediaKinds = ["image", "video", "document"] as const;

/**
 * Campaign delivery media (not Template Studio authoring media: those are
 * provider upload handles for a template's example, in
 * template_media_uploads). Bytes live in object storage under
 * `storageKey`; this row never holds a token, a provider handle or a
 * provider media id. One asset can be referenced by several templates'
 * header mappings. Deleting is a soft state change so frozen plans and
 * audit keep a stable reference.
 */
export const campaignMediaAssetsTable = pgTable("campaign_media_assets", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  byteLength: integer("byte_length").notNull(),
  kind: text("kind").notNull(),
  storageKey: text("storage_key").notNull(),
  sha256: text("sha256").notNull(),
  status: text("status").notNull().default("ready"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => [
  index("campaign_media_asset_campaign_idx").on(t.organizationId, t.campaignId, t.status),
  uniqueIndex("campaign_media_asset_storage_key_uq").on(t.storageKey),
]);

/**
 * Server-side cache of the provider media id an asset was uploaded as, per
 * SENDING NUMBER (Meta's media endpoint is /{phone-number-id}/media; ids
 * are not assumed to work across numbers or business accounts). Written by
 * plan-time preparation and test send only; read by send preparation.
 * Never returned to the browser. `credentialRevision` and `sha256` pin the
 * binding to the credential and the exact bytes it was made with.
 */
export const campaignMediaProviderBindingsTable = pgTable("campaign_media_provider_bindings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  mediaAssetId: integer("media_asset_id").notNull().references(() => campaignMediaAssetsTable.id, { onDelete: "cascade" }),
  phoneNumberId: integer("phone_number_id").notNull().references(() => phoneNumbersTable.id, { onDelete: "cascade" }),
  wabaId: integer("waba_id"),
  transport: text("transport").notNull(),
  providerMediaId: text("provider_media_id").notNull(),
  credentialId: integer("credential_id"),
  credentialRevision: integer("credential_revision"),
  sha256: text("sha256").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
}, (t) => [uniqueIndex("campaign_media_binding_asset_phone_uq").on(t.mediaAssetId, t.phoneNumberId)]);

export type MappingPresetEntry = {
  component: "header" | "body" | "button";
  variable: string;
  source: "csv" | "static";
  sourceValue: string;
  optional?: boolean;
  fallbackValue?: string | null;
};

/**
 * Workspace mapping presets: an authoring shortcut only. Applying a preset
 * COPIES matching entries into a campaign's mappings; the campaign never
 * references the preset afterwards, so editing or deleting a preset never
 * changes a configured campaign. Entries are semantic (slot -> CSV column
 * or static text); no media, ids or secrets.
 */
export const mappingPresetsTable = pgTable("mapping_presets", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  entries: jsonb("entries").$type<MappingPresetEntry[]>().notNull().default([]),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => [uniqueIndex("mapping_preset_org_name_uq").on(t.organizationId, t.name)]);

export type CampaignMessageSetup = typeof campaignMessageSetupsTable.$inferSelect;
export type CampaignMediaAsset = typeof campaignMediaAssetsTable.$inferSelect;
export type CampaignMediaProviderBinding = typeof campaignMediaProviderBindingsTable.$inferSelect;
export type MappingPreset = typeof mappingPresetsTable.$inferSelect;
