import {
  boolean,
  jsonb,
  integer,
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { wabasTable } from "./wabas";

export const phoneNumbersTable = pgTable("phone_numbers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  wabaId: integer("waba_id").references(() => wabasTable.id, {
    onDelete: "set null",
  }),
  phone: text("phone").notNull(),
  providerPhoneId: text("provider_phone_id"),
  displayName: text("display_name").notNull(),
  provider: text("provider").notNull().default("Cloud API"),
  quality: text("quality").notNull().default("High"),
  status: text("status").notNull().default("Pending"),
  tpsLimit: integer("tps_limit").notNull().default(50),
  isSample: boolean("is_sample").notNull().default(false),
  providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>().notNull().default({}),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("phone_numbers_org_provider_id_uq").on(t.organizationId, t.providerPhoneId),
  index("phone_numbers_waba_idx").on(t.wabaId),
]);

export const insertPhoneNumberSchema = createInsertSchema(
  phoneNumbersTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPhoneNumber = z.infer<typeof insertPhoneNumberSchema>;
export type PhoneNumber = typeof phoneNumbersTable.$inferSelect;
