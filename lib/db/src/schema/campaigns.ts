import { boolean, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/** Allocator-v2 distribution modes (stable machine values, V2-06). */
export const campaignDistributionModes = ["equal_numbers", "equal_templates"] as const;
export type CampaignDistributionMode = (typeof campaignDistributionModes)[number];

/** Delivery (speed) modes (stable machine values, V2-06B). */
export const campaignDeliveryModes = ["fastest_safe", "balanced", "conservative", "advanced"] as const;
export type CampaignDeliveryMode = (typeof campaignDeliveryModes)[number];

/**
 * `campaigns.delivery_settings` (V2-06B). Only the `advanced` mode reads
 * `perNumberRates`; other modes keep any saved values for convenience but
 * never consume them.
 */
export type CampaignDeliverySettings = {
  perNumberRates?: Array<{ phoneNumberId: number; messagesPerSecond: number }>;
};

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
  // V2-05A Rocket Audience (additive).
  // `creationKey`: the client-chosen key a Draft was created with, so a
  // retried/double-clicked "New campaign" replays the same Draft instead of
  // creating a second one. Unique per organization; null for campaigns
  // created without one (legacy clients, fixtures).
  creationKey: text("creation_key"),
  // `revision`: monotonically increasing on every metadata write through
  // the campaign CRUD endpoint. An autosave sends the revision it was based
  // on; a lower revision than the stored one is a stale response and is
  // refused (409 stale_revision) instead of overwriting newer edits.
  revision: integer("revision").notNull().default(0),
  // `audienceGeneration`: the generation of campaign_contacts rows that is
  // the campaign's current audience. Append imports write into this
  // generation; a replace import stages generation+1 and activates it
  // atomically on completion (prior audience stays usable until then).
  // Planning, readiness, search and counts only read the active generation.
  audienceGeneration: integer("audience_generation").notNull().default(0),
  // V2-06 (additive). `distributionMode` selects the allocator: null (every
  // campaign created before V2-06, and any campaign never configured for a
  // distribution) keeps the historical allocator v1 exactly; "equal_numbers"
  // or "equal_templates" plans with allocator v2. There is deliberately NO
  // default, so no existing campaign silently changes allocator.
  distributionMode: text("distribution_mode"),
  // V2-06B delivery (speed) mode, `campaignDeliveryModes` or null. null keeps
  // the pre-V2-06B semantics (each route's configured rate is frozen); a
  // mode is resolved per sender at planning (services/campaign-delivery.ts).
  deliveryMode: text("delivery_mode"),
  deliverySettings: jsonb("delivery_settings").$type<CampaignDeliverySettings>(),
  timezone: text("timezone"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("campaign_org_creation_key_uq").on(t.organizationId, t.creationKey),
]);

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
