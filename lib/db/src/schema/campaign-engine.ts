import {
  boolean,
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
import { campaignsTable } from "./campaigns";
import { campaignRoutesTable } from "./campaign-routes";
import { phoneNumbersTable } from "./phone-numbers";
import { templatesTable } from "./templates";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
};

export const contactImportSessionsTable = pgTable("contact_import_sessions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("Processing"),
  phoneColumn: text("phone_column"),
  defaultCountryCode: text("default_country_code"),
  columns: text("columns").array().notNull().default([]),
  bytesProcessed: integer("bytes_processed").notNull().default(0),
  rowsProcessed: integer("rows_processed").notNull().default(0),
  validRows: integer("valid_rows").notNull().default(0),
  invalidRows: integer("invalid_rows").notNull().default(0),
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  suppressedRows: integer("suppressed_rows").notNull().default(0),
  error: text("error"),
  ...timestamps,
}, (t) => [
  uniqueIndex("contact_import_org_key_uq").on(t.organizationId, t.idempotencyKey),
  index("contact_import_campaign_idx").on(t.campaignId),
]);

export const campaignContactsTable = pgTable("campaign_contacts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  importSessionId: integer("import_session_id").references(() => contactImportSessionsTable.id, { onDelete: "set null" }),
  rowNumber: integer("row_number").notNull(),
  rawPhone: text("raw_phone"),
  normalizedPhone: text("normalized_phone"),
  data: jsonb("data").$type<Record<string, string>>().notNull().default({}),
  status: text("status").notNull(),
  invalidReason: text("invalid_reason"),
  partitionKey: integer("partition_key"),
  routeId: integer("route_id").references(() => campaignRoutesTable.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key").notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex("campaign_contact_idempotency_uq").on(t.campaignId, t.idempotencyKey),
  index("campaign_contact_dispatch_idx").on(t.campaignId, t.status, t.partitionKey),
  // Supports keyset-paginated streaming of one import's rejected (Invalid /
  // Suppressed) rows in rowNumber order without a full-table scan, even when
  // a single import spans millions of contacts (see routes/campaign-engine.ts
  // downloadRejectedImportRows).
  index("campaign_contact_import_session_idx").on(t.importSessionId, t.status, t.rowNumber),
  // Backs contacts/search's keyset pagination (WHERE campaignId = ? AND
  // rowNumber > ? ORDER BY rowNumber) so it stays an index range scan
  // instead of a full-table scan once a campaign holds millions of rows.
  index("campaign_contact_campaign_row_idx").on(t.campaignId, t.rowNumber),
  // Backs the messages/search ILIKE '%term%' filter on recipient phone at
  // scale, the same way job/provider error-reason trigram indexes do.
  index("campaign_contact_phone_trgm_idx").using("gin", sql`${t.normalizedPhone} gin_trgm_ops`),
]);

export const suppressionsTable = pgTable("suppressions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  normalizedPhone: text("normalized_phone").notNull(),
  reason: text("reason").notNull().default("Unsubscribed"),
  ...timestamps,
}, (t) => [uniqueIndex("suppression_org_phone_uq").on(t.organizationId, t.normalizedPhone)]);

export const campaignTemplateMappingsTable = pgTable("campaign_template_mappings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => templatesTable.id, { onDelete: "cascade" }),
  component: text("component").notNull(),
  variable: text("variable").notNull(),
  source: text("source").notNull(),
  sourceValue: text("source_value").notNull(),
  compatible: boolean("compatible").notNull().default(true),
  // When true, a missing/blank CSV value falls back to `fallbackValue`
  // instead of failing the job. Required (non-optional) mappings still fail
  // the job on a missing/blank value, same as before this column existed.
  optional: boolean("optional").notNull().default(false),
  fallbackValue: text("fallback_value"),
  ...timestamps,
}, (t) => [uniqueIndex("campaign_template_mapping_uq").on(t.campaignId, t.templateId, t.component, t.variable)]);

export const campaignTemplateSelectionsTable = pgTable("campaign_template_selections", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => templatesTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("campaign_template_selection_uq").on(t.campaignId, t.templateId)]);

export const campaignJobsTable = pgTable("campaign_jobs", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  routeId: integer("route_id").references(() => campaignRoutesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => campaignContactsTable.id, { onDelete: "cascade" }),
  // Frozen at execute time from the campaign's active plan snapshot (see
  // campaign-planning.ts). Nullable so jobs created directly against the
  // live tables (e.g. fixtures that bypass plan/execute) keep working: the
  // runtime falls back to the live route's value only when these are null.
  // Once set, they take precedence so a live route edit after planning can
  // never change what an already-created job sends or how fast it sends.
  configuredTps: integer("configured_tps"),
  templateId: integer("template_id").references(() => templatesTable.id, { onDelete: "set null" }),
  // The exact plan this job was created from (also frozen at execute time).
  // Template/mapping resolution must resolve against THIS plan, never
  // whichever plan happens to be "Active" right now -- a replan can create
  // a new Active plan while older jobs from a prior plan are still
  // in-flight, and those jobs must keep resolving against the plan that
  // actually produced them.
  planId: integer("plan_id").references(() => campaignPlansTable.id, { onDelete: "set null" }),
  type: text("type").notNull(),
  status: text("status").notNull().default("Queued"),
  idempotencyKey: text("idempotency_key").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  // Database-assigned provider dispatch slot. The distributed scheduler
  // reserves this while claiming so every process observes one per-number
  // timeline instead of releasing a whole second's allowance in a burst.
  scheduledSendAt: timestamp("scheduled_send_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  errorReason: text("error_reason"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => [
  uniqueIndex("campaign_job_idempotency_uq").on(t.organizationId, t.idempotencyKey),
  index("campaign_job_claim_idx").on(t.status, t.availableAt),
  // Delivery-log/monitoring reads filter by campaign or route plus status
  // (messages/search, messages/export.csv, the monitoring aggregate) --
  // without these, those scans are sequential once a campaign has more
  // than a trivial number of jobs.
  index("campaign_job_campaign_status_idx").on(t.campaignId, t.status),
  // Backs messages/search and messages/export.csv when no status filter is
  // given: both filter by campaignId and ORDER BY id DESC, which otherwise
  // falls back to a sequential scan + sort once a campaign has millions of
  // jobs.
  index("campaign_job_campaign_id_idx").on(t.campaignId, t.id),
  index("campaign_job_route_status_idx").on(t.routeId, t.status),
  // Backs DatabaseJobQueue.claim()'s per-route lateral candidate lookup
  // (WHERE route_id = ? AND status = 'Queued' AND available_at <= now()
  // ORDER BY available_at, id LIMIT 10). Partial on status = 'Queued' so
  // the index stays small as jobs move to Processing/Sent/Failed, and
  // covers the exact filter + sort so Postgres never has to materialize
  // and sort the full queued backlog for a route just to find its next
  // handful of candidates -- without this, that per-claim sort scales
  // with total queued depth (proven at 100k-row scale: ~700ms/claim
  // sorting ~85k queued rows) instead of staying flat as the queue grows.
  index("campaign_job_route_queued_available_idx")
    .on(t.routeId, t.availableAt, t.id)
    .where(sql`${t.status} = 'Queued'`),
  // Backs the messages/search ILIKE '%term%' filter on job-level error
  // text at scale, the same way contacts' name/phone/email trigram
  // indexes back free-text contact search.
  index("campaign_job_error_reason_trgm_idx").using("gin", sql`${t.errorReason} gin_trgm_ops`),
]);

export const campaignRateLimitWindowsTable = pgTable("campaign_rate_limit_windows", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  scopeId: integer("scope_id").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  used: integer("used").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("campaign_rate_limit_window_scope_uq").on(
    t.organizationId,
    t.scope,
    t.scopeId,
    t.windowStartedAt,
  ),
  index("campaign_rate_limit_window_expiry_idx").on(t.windowStartedAt),
]);

export const campaignRateLimitSchedulesTable = pgTable("campaign_rate_limit_schedules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  scopeId: integer("scope_id").notNull(),
  nextSlotAt: timestamp("next_slot_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("campaign_rate_limit_schedule_scope_uq").on(
    t.organizationId,
    t.scope,
    t.scopeId,
  ),
  index("campaign_rate_limit_schedule_updated_idx").on(t.updatedAt),
]);

export const campaignAuditTable = pgTable("campaign_audit", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  actorUserId: integer("actor_user_id"),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Support/ops audit views page one campaign's history newest-first.
  index("campaign_audit_campaign_created_idx").on(t.campaignId, t.createdAt),
]);

export const campaignMetricsTable = pgTable("campaign_metrics", {
  campaignId: integer("campaign_id").primaryKey().references(() => campaignsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  total: integer("total").notNull().default(0),
  valid: integer("valid").notNull().default(0),
  invalid: integer("invalid").notNull().default(0),
  deduplicated: integer("deduplicated").notNull().default(0),
  suppressed: integer("suppressed").notNull().default(0),
  queued: integer("queued").notNull().default(0),
  processing: integer("processing").notNull().default(0),
  sent: integer("sent").notNull().default(0),
  delivered: integer("delivered").notNull().default(0),
  read: integer("read").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  retryCount: integer("retry_count").notNull().default(0),
  errorReasons: jsonb("error_reasons").$type<Record<string, number>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

/**
 * Append-only runtime counter deltas keep hot claim/settlement transactions
 * away from the single campaign_metrics and campaigns rows shared by every
 * route. The runtime folds these durable rows into aggregates in bounded
 * batches; a process crash cannot lose a committed transition.
 */
export const campaignMetricDeltasTable = pgTable("campaign_metric_deltas", {
  id: serial("id").primaryKey(),
  // Intentionally no parent FKs: every INSERT into a referencing table takes
  // a KEY SHARE lock on the campaign/organization parent, which would put
  // pause/cancel/settlement parent-row contention back into the claim path.
  // The bounded flusher joins live metrics rows and deletes orphan deltas.
  organizationId: integer("organization_id").notNull(),
  campaignId: integer("campaign_id").notNull(),
  queuedDelta: integer("queued_delta").notNull().default(0),
  processingDelta: integer("processing_delta").notNull().default(0),
  sentDelta: integer("sent_delta").notNull().default(0),
  failedDelta: integer("failed_delta").notNull().default(0),
  retryDelta: integer("retry_delta").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("campaign_metric_delta_campaign_id_idx").on(t.campaignId, t.id),
  index("campaign_metric_delta_created_idx").on(t.createdAt),
]);

// A campaign_plans row is the frozen, tenant-owned execution snapshot
// produced by readiness planning (see services/campaign-planning.ts). It
// captures the exact routes (phone/template/TPS/provider-cap evidence),
// selected templates, and expanded mapping values in effect at plan time,
// so retries, restarts, concurrent workers, and later configuration edits
// cannot change who is sent which template from which number. Only one
// plan per campaign is "Active" at a time; superseded plans are kept for
// audit history. `version` increments on every (re)plan of a campaign.
export const campaignPlanStatuses = ["Active", "Superseded"] as const;

export const campaignPlansTable = pgTable("campaign_plans", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  allocatorVersion: text("allocator_version").notNull(),
  partitionCount: integer("partition_count").notNull(),
  routes: jsonb("routes").$type<{
    routeId: number;
    phoneNumberId: number;
    templateId: number;
    configuredTps: number;
    providerTpsLimit: number;
    // Phone display metadata copied at freeze time so a support/ops preview
    // of what this plan will send never has to join the live phoneNumbers
    // table -- editing a phone's display name/number after planning cannot
    // change what an already-frozen plan preview shows, matching the same
    // guarantee already made for templates/mappings.
    phone: string;
    displayName: string;
  }[]>().notNull().default([]),
  templateIds: jsonb("template_ids").$type<number[]>().notNull().default([]),
  // Frozen content for every selected template (name/language/wabaId, needed
  // to build the provider send payload; body/components, needed to know
  // which variables a template requires and resolve them). Resolution and
  // sending must read this snapshot -- never the live `templates` table --
  // so editing or deleting a template after planning can never change what
  // an already-planned/executing job sends. A live approval-status/ownership
  // check by this same frozen template id is still allowed at send time:
  // that is a provider-side safety gate, not org-editable configuration.
  templatesSnapshot: jsonb("templates_snapshot").$type<{
    id: number;
    name: string;
    language: string;
    wabaId: number | null;
    body: string;
    components: Record<string, unknown>[];
  }[]>().notNull().default([]),
  mappingsSnapshot: jsonb("mappings_snapshot").$type<{
    templateId: number;
    component: string;
    variable: string;
    source: string;
    sourceValue: string;
    optional: boolean;
    fallbackValue: string | null;
  }[]>().notNull().default([]),
  status: text("status").notNull().default("Active"),
  ...timestamps,
}, (t) => [
  uniqueIndex("campaign_plan_version_uq").on(t.campaignId, t.version),
  index("campaign_plan_campaign_status_idx").on(t.campaignId, t.status),
]);

// One row per contact per campaign: the deterministic, persistent outcome
// of allocation against a specific plan's frozen route list. Recomputing a
// plan from the same routes and contacts always reproduces the same
// (partitionKey, routeId, templateId) triple for a given contact.
export const campaignAllocationsTable = pgTable("campaign_allocations", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  planId: integer("plan_id").notNull().references(() => campaignPlansTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => campaignContactsTable.id, { onDelete: "cascade" }),
  partitionKey: integer("partition_key").notNull(),
  routeId: integer("route_id").notNull().references(() => campaignRoutesTable.id, { onDelete: "cascade" }),
  phoneNumberId: integer("phone_number_id").notNull().references(() => phoneNumbersTable.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => templatesTable.id, { onDelete: "cascade" }),
  ...timestamps,
}, (t) => [
  uniqueIndex("campaign_allocation_contact_uq").on(t.campaignId, t.contactId),
  index("campaign_allocation_route_idx").on(t.routeId),
]);

export const insertContactImportSessionSchema = createInsertSchema(contactImportSessionsTable);
export const insertCampaignContactSchema = createInsertSchema(campaignContactsTable);
export const insertCampaignJobSchema = createInsertSchema(campaignJobsTable);
export const insertCampaignPlanSchema = createInsertSchema(campaignPlansTable);
export const insertCampaignAllocationSchema = createInsertSchema(campaignAllocationsTable);
export type ContactImportSession = typeof contactImportSessionsTable.$inferSelect;
export type CampaignContact = typeof campaignContactsTable.$inferSelect;
export type CampaignJob = typeof campaignJobsTable.$inferSelect;
export type InsertCampaignJob = z.infer<typeof insertCampaignJobSchema>;
export type CampaignPlan = typeof campaignPlansTable.$inferSelect;
export type InsertCampaignPlan = z.infer<typeof insertCampaignPlanSchema>;
export type CampaignAllocation = typeof campaignAllocationsTable.$inferSelect;
export type InsertCampaignAllocation = z.infer<typeof insertCampaignAllocationSchema>;