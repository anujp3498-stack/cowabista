import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Role hierarchy (highest to lowest): owner > admin > manager > agent.
export const ORGANIZATION_ROLES = [
  "owner",
  "admin",
  "manager",
  "agent",
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const organizationMembersTable = pgTable(
  "organization_members",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("organization_members_org_user_idx").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const insertOrganizationMemberSchema = createInsertSchema(
  organizationMembersTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrganizationMember = z.infer<
  typeof insertOrganizationMemberSchema
>;
export type OrganizationMember = typeof organizationMembersTable.$inferSelect;
