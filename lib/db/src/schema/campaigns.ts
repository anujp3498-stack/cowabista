import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const campaignStatuses = [
  "Draft",
  "Ready",
  "Scheduled",
  "Running",
  "Paused",
  "Completed",
  "Cancelled",
  "Failed",
] as const;

// `scheduleLabel` and the campaign-engine-only lifecycle fields (priority,
// scheduledAt/startedAt/completedAt, killSwitch) are used by the Rocket
// Engine dispatch pipeline (see routes/campaign-engine.ts). Plain CRUD
// (routes/campaigns.ts) exposes `scheduleLabel` to the API as `schedule` and
// deliberately omits the lifecycle-only fields from its input schema.
export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("Draft"),
  audienceSize: integer("audience_size").notNull().default(0),
  sent: integer("sent").notNull().default(0),
  delivered: integer("delivered").notNull().default(0),
  read: integer("read").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  scheduleLabel: text("schedule_label").notNull().default("Unscheduled"),
  priority: text("priority").notNull().default("Normal"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  killSwitch: boolean("kill_switch").notNull().default(false),
  isSample: boolean("is_sample").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
