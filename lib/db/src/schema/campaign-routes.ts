import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { campaignsTable } from "./campaigns";
import { organizationsTable } from "./organizations";
import { phoneNumbersTable } from "./phone-numbers";
import { templatesTable } from "./templates";

// A campaign route assigns one sending channel (phone number + template) to
// a campaign. Shown in the Rocket Engine page's route cards. `configuredTps`
// is enforced live by the queue claim logic (see services/campaign-queue.ts)
// and is frozen into a campaign_plans row's `routes` snapshot once a
// campaign is planned (see services/campaign-planning.ts), so allocation
// evidence survives later edits to this table.
export const campaignRoutesTable = pgTable("campaign_routes", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id")
    .notNull()
    .references(() => campaignsTable.id, { onDelete: "cascade" }),
  phoneNumberId: integer("phone_number_id")
    .notNull()
    .references(() => phoneNumbersTable.id, { onDelete: "cascade" }),
  templateId: integer("template_id").references(() => templatesTable.id, {
    onDelete: "set null",
  }),
  priority: text("priority").notNull().default("Normal"),
  configuredTps: integer("configured_tps").notNull().default(50),
  currentTps: integer("current_tps").notNull().default(0),
  queueDepth: integer("queue_depth").notNull().default(0),
  status: text("status").notNull().default("Active"),
  // Set only when a claim's rate reservation fails and cleared only on
  // reactivation (see services/campaign-queue.ts and campaign-runtime.ts).
  // Deliberately NOT derived from `updatedAt`: that column is touched by
  // unrelated writes (queueDepth decrements, currentTps resets), and using
  // it as the "has a full second passed since throttling" signal previously
  // caused throttled routes to never reactivate, since routine maintenance
  // writes kept refreshing updatedAt to "now" forever.
  throttledAt: timestamp("throttled_at", { withTimezone: true }),
  isSample: boolean("is_sample").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertCampaignRouteSchema = createInsertSchema(
  campaignRoutesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCampaignRoute = z.infer<typeof insertCampaignRouteSchema>;
export type CampaignRoute = typeof campaignRoutesTable.$inferSelect;
