import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { wabasTable } from "./wabas";

// `wabaId`, `components`, and `metadata` are used by the campaign-engine
// template-mapping pipeline (see services/template-mapping.ts). Plain CRUD
// (routes/templates.ts) still exposes and sets them alongside `isSample`.
export const templatesTable = pgTable("templates", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  wabaId: integer("waba_id").references(() => wabasTable.id, {
    onDelete: "set null",
  }),
  providerTemplateId: text("provider_template_id"),
  name: text("name").notNull(),
  category: text("category").notNull().default("Marketing"),
  language: text("language").notNull().default("en_US"),
  status: text("status").notNull().default("Pending"),
  body: text("body").notNull(),
  components: jsonb("components").$type<Record<string, unknown>[]>().notNull().default([]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  isSample: boolean("is_sample").notNull().default(false),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("templates_org_provider_id_uq").on(t.organizationId, t.providerTemplateId),
  index("templates_waba_idx").on(t.wabaId),
]);

export const insertTemplateSchema = createInsertSchema(templatesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTemplate = z.infer<typeof insertTemplateSchema>;
export type Template = typeof templatesTable.$inferSelect;
