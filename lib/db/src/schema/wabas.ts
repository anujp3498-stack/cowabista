import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

// WhatsApp Business Accounts. Phone numbers belong to a WABA. Rows are
// get-or-created from the external WABA id typed into the phone number form
// -- there is no standalone WABA management UI in this milestone.
export const wabasTable = pgTable("wabas", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  displayName: text("display_name").notNull(),
  provider: text("provider").notNull().default("whatsapp-business"),
  providerStatus: text("provider_status"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("wabas_org_external_uq").on(t.organizationId, t.externalId),
  index("wabas_org_idx").on(t.organizationId),
]);

export const insertWabaSchema = createInsertSchema(wabasTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWaba = z.infer<typeof insertWabaSchema>;
export type Waba = typeof wabasTable.$inferSelect;
