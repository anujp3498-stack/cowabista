import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { campaignJobsTable } from "./campaign-engine";

export const providerConnectionsTable = pgTable("provider_connections", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("whatsapp-business"),
  mode: text("mode").notNull().default("mock"),
  connectorAccountId: text("connector_account_id"),
  configuredWabaExternalId: text("configured_waba_external_id"),
  status: text("status").notNull().default("unconfigured"),
  health: text("health").notNull().default("unknown"),
  lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("provider_connections_org_provider_uq").on(t.organizationId, t.provider),
  uniqueIndex("provider_connections_real_account_uq").on(t.provider, t.connectorAccountId).where(sql`${t.mode} = 'real'`),
  uniqueIndex("provider_connections_real_waba_uq").on(t.provider, t.configuredWabaExternalId).where(sql`${t.mode} = 'real'`),
]);

export const providerMessagesTable = pgTable("provider_messages", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignJobId: integer("campaign_job_id").notNull()
    .references(() => campaignJobsTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("whatsapp-business"),
  providerMessageId: text("provider_message_id"),
  requestKey: text("request_key").notNull(),
  status: text("status").notNull().default("pending"),
  errorReason: text("error_reason"),
  recipientExternalId: text("recipient_external_id"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  lastStatusAt: timestamp("last_status_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("provider_messages_provider_id_uq").on(t.provider, t.providerMessageId),
  uniqueIndex("provider_messages_org_job_uq").on(t.organizationId, t.campaignJobId),
  uniqueIndex("provider_messages_request_key_uq").on(t.provider, t.requestKey),
  index("provider_messages_job_idx").on(t.campaignJobId),
  // Backs the messages/search ILIKE '%term%' filter on provider-level error
  // text at scale (see campaign_job_error_reason_trgm_idx for the job-level
  // counterpart).
  index("provider_messages_error_reason_trgm_idx").using("gin", sql`${t.errorReason} gin_trgm_ops`),
]);

export const providerEventsTable = pgTable("provider_events", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  providerMessageDbId: integer("provider_message_id")
    .references(() => providerMessagesTable.id, { onDelete: "set null" }),
  campaignJobId: integer("campaign_job_id")
    .references(() => campaignJobsTable.id, { onDelete: "set null" }),
  provider: text("provider").notNull().default("whatsapp-business"),
  providerEventId: text("provider_event_id").notNull(),
  providerMessageId: text("provider_message_external_id").notNull(),
  eventType: text("event_type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  errorCode: text("error_code"),
  errorReason: text("error_reason"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("provider_events_provider_event_uq").on(t.provider, t.providerEventId),
  index("provider_events_message_idx").on(t.provider, t.providerMessageId),
]);

export const insertProviderConnectionSchema = createInsertSchema(providerConnectionsTable);
export const insertProviderMessageSchema = createInsertSchema(providerMessagesTable);
export const insertProviderEventSchema = createInsertSchema(providerEventsTable);
export type ProviderConnection = typeof providerConnectionsTable.$inferSelect;
export type ProviderMessage = typeof providerMessagesTable.$inferSelect;
export type ProviderEvent = typeof providerEventsTable.$inferSelect;
export type InsertProviderConnection = z.infer<typeof insertProviderConnectionSchema>;