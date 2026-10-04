import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";
import { wabasTable } from "./wabas";
import { templatesTable } from "./templates";
import { whatsappCredentialsTable } from "./whatsapp-credentials";

// V2-03B template authoring (management plane only).
//
// A draft is authored in Wabista and is NEVER a provider template: it lives
// in its own table, carries its own lifecycle state, and only an explicit
// submission creates a template at Meta. Meta's approval status is read
// back from the provider (sync or a status refresh) and is never written
// from local state. No secret (token, ciphertext, credential material) is
// stored on any of these rows.
//
// Draft lifecycle (`state`):
//   draft              editable
//   submitting         an attempt is in progress (content frozen)
//   submitted          Meta accepted the creation; providerTemplateId set;
//                      approval comes from Meta (providerStatus)
//   failed             Meta definitively refused; editable again, history kept
//   reconcile_required the outcome of an attempt is unknown (timeout, crash,
//                      malformed reply); must be reconciled before editing
export const templateDraftStates = ["draft", "submitting", "submitted", "failed", "reconcile_required"] as const;
export type TemplateDraftState = (typeof templateDraftStates)[number];

// Authored content. Variables are scoped by component and button index:
// header {{1}}, body {{1}} and a URL button's {{1}} are different inputs
// with their own examples.
export type TemplateDraftContent = {
  header: { kind: "none" | "text"; text?: string; example?: string }
    | { kind: "image" | "video" | "document"; mediaUploadId?: number | null };
  body: { text: string; examples: string[] };
  footer: { text: string } | null;
  buttons: Array<
    | { type: "quick_reply"; text: string }
    | { type: "url"; text: string; url: string; example?: string }
    | { type: "phone"; text: string; phoneNumber: string }
  >;
};

export const templateDraftsTable = pgTable("template_drafts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  wabaId: integer("waba_id").references(() => wabasTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  language: text("language").notNull().default("en_US"),
  category: text("category").notNull().default("MARKETING"),
  content: jsonb("content").$type<TemplateDraftContent>().notNull(),
  // Optimistic concurrency: every write requires the caller's expected
  // revision and bumps it; a stale edit is refused with a conflict.
  revision: integer("revision").notNull().default(1),
  state: text("state").notNull().default("draft"),
  // Set from a confirmed provider reply only.
  providerTemplateId: text("provider_template_id"),
  providerStatus: text("provider_status"),
  providerStatusCheckedAt: timestamp("provider_status_checked_at", { withTimezone: true }),
  templateId: integer("template_id").references(() => templatesTable.id, { onDelete: "set null" }),
  lastError: text("last_error"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("template_drafts_org_idx").on(t.organizationId, t.id),
  // One draft per name+language per business account inside a workspace
  // (Meta keys templates the same way). Drafts without a WABA may coexist.
  uniqueIndex("template_drafts_waba_name_lang_uq").on(t.organizationId, t.wabaId, t.name, t.language),
]);

// Submission attempts are the durable record of every outbound creation
// request: claimed and committed BEFORE the provider call, so an
// interrupted request or a crash leaves an attempt to reconcile instead of
// a silent duplicate. The partial unique index enforces at most ONE active
// attempt per draft in the database, not in process memory.
//   requested  claimed, provider request about to be / being made
//   succeeded  provider confirmed creation (providerTemplateId)
//   failed     provider definitively refused, or the person discarded an
//              unconfirmed attempt
//   uncertain  the request may have reached Meta; outcome unknown
export const templateSubmissionStates = ["requested", "succeeded", "failed", "uncertain"] as const;
export type TemplateSubmissionState = (typeof templateSubmissionStates)[number];

export const templateSubmissionAttemptsTable = pgTable("template_submission_attempts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  draftId: integer("draft_id").notNull().references(() => templateDraftsTable.id, { onDelete: "cascade" }),
  draftRevision: integer("draft_revision").notNull(),
  wabaId: integer("waba_id").notNull().references(() => wabasTable.id, { onDelete: "cascade" }),
  wabaExternalId: text("waba_external_id").notNull(),
  credentialId: integer("credential_id").references(() => whatsappCredentialsTable.id, { onDelete: "set null" }),
  /** Immutable provider request body (no secrets; media referenced by provider handle). */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  state: text("state").notNull().default("requested"),
  providerTemplateId: text("provider_template_id"),
  providerStatus: text("provider_status"),
  providerCategory: text("provider_category"),
  error: text("error"),
  errorCode: text("error_code"),
  reconcileNote: text("reconcile_note"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("template_submission_attempts_draft_idx").on(t.draftId, t.id),
  uniqueIndex("template_submission_attempts_active_uq").on(t.draftId).where(sql`${t.state} in ('requested', 'uncertain')`),
]);

// Media examples uploaded through Meta's Resumable Upload API for template
// headers. The provider handle is kept server-side and referenced by id
// from a draft; it is not a campaign message media id and is never
// interchangeable with one.
export const templateMediaUploadStates = ["ready", "failed"] as const;

export const templateMediaUploadsTable = pgTable("template_media_uploads", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  wabaId: integer("waba_id").notNull().references(() => wabasTable.id, { onDelete: "cascade" }),
  credentialId: integer("credential_id").references(() => whatsappCredentialsTable.id, { onDelete: "set null" }),
  appId: text("app_id").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  byteLength: integer("byte_length").notNull(),
  kind: text("kind").notNull(), // image | video | document
  providerSessionId: text("provider_session_id"),
  providerHandle: text("provider_handle"),
  state: text("state").notNull().default("ready"),
  error: text("error"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("template_media_uploads_org_idx").on(t.organizationId, t.id),
]);

export const insertTemplateDraftSchema = createInsertSchema(templateDraftsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTemplateDraft = z.infer<typeof insertTemplateDraftSchema>;
export type TemplateDraft = typeof templateDraftsTable.$inferSelect;
export type TemplateSubmissionAttempt = typeof templateSubmissionAttemptsTable.$inferSelect;
export type TemplateMediaUpload = typeof templateMediaUploadsTable.$inferSelect;
