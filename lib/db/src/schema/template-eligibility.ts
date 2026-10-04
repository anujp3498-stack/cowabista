import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { templatesTable } from "./templates";
import { wabasTable } from "./wabas";
import { whatsappCredentialsTable } from "./whatsapp-credentials";

// V2-04 sender-template compatibility: PROVIDER EVIDENCE per template.
//
// One row per provider-backed template (never per phone x template pair):
// a phone's compatibility is derived at read time from its WABA and live
// state, so the table stays O(templates) and nothing here can keep a
// revoked credential or a disconnected phone sendable. The row records
// what the provider said about the template, when, through which path and
// (for workspace credentials) under which credential and sync generation.
//
// Written only by a sync whose snapshot was APPLIED (same transaction as
// the templates upsert, after generation ordering and credential/WABA
// revalidation under the row locks) or by the idempotent backfill from
// already-synced rows. Local, sample and draft rows never get a row: the
// model cannot promote them. `sendable` is the provider-side verdict
// (Approved, present at Meta); the live decision additionally re-checks
// the templates row, the phone, the WABA association and the credential.
export const templateEligibilitySources = ["workspace_credential", "legacy_connector", "backfill"] as const;
export type TemplateEligibilitySource = (typeof templateEligibilitySources)[number];

export const templateEligibilityTable = pgTable("template_eligibility", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => templatesTable.id, { onDelete: "cascade" }),
  wabaId: integer("waba_id").notNull().references(() => wabasTable.id, { onDelete: "cascade" }),
  providerTemplateId: text("provider_template_id").notNull(),
  /** Raw provider status at verification (e.g. APPROVED, PAUSED); null when Meta no longer lists it. */
  providerStatus: text("provider_status"),
  /** Normalised status as stored on the templates row at the same instant. */
  status: text("status").notNull(),
  providerMissing: boolean("provider_missing").notNull().default(false),
  /** Provider-side verdict: present at Meta and Approved. Never a live-state verdict. */
  sendable: boolean("sendable").notNull().default(false),
  evidenceSource: text("evidence_source").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  syncGeneration: integer("sync_generation"),
  credentialId: integer("credential_id").references(() => whatsappCredentialsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("template_eligibility_org_template_uq").on(t.organizationId, t.templateId),
  index("template_eligibility_org_waba_idx").on(t.organizationId, t.wabaId, t.sendable),
]);

export type TemplateEligibility = typeof templateEligibilityTable.$inferSelect;
