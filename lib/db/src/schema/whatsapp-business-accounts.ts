import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const wabaStatuses = ["Connected", "Pending", "Disconnected"] as const;

// A WhatsApp Business Account record. No real Meta credentials are stored or
// used yet -- externalWabaId is a free-text placeholder the user can fill in
// for their own reference ahead of a future real Meta integration.
export const wabasTable = pgTable("whatsapp_business_accounts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  externalWabaId: text("external_waba_id"),
  status: text("status").notNull().default("Pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertWabaSchema = createInsertSchema(wabasTable).omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWaba = z.infer<typeof insertWabaSchema>;
export type Waba = typeof wabasTable.$inferSelect;
