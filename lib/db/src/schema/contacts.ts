import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  tags: text("tags").array().notNull().default([]),
  status: text("status").notNull().default("Active"),
  source: text("source").notNull().default("Manual"),
  lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
  isSample: boolean("is_sample").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  // Backs the default org-scoped, newest-first contacts list and its
  // offset pagination -- without this the list does a full table scan
  // (filter + sort) per page as an org's address book grows.
  index("contacts_org_created_at_idx").on(table.organizationId, table.createdAt.desc()),
  // Trigram GIN indexes back fast ILIKE '%term%' search across name/phone/
  // email at scale; a plain btree can't accelerate substring matches.
  index("contacts_name_trgm_idx").using("gin", sql`${table.name} gin_trgm_ops`),
  index("contacts_phone_trgm_idx").using("gin", sql`${table.phone} gin_trgm_ops`),
  index("contacts_email_trgm_idx").using("gin", sql`${table.email} gin_trgm_ops`),
]);

export const insertContactSchema = createInsertSchema(contactsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contactsTable.$inferSelect;
