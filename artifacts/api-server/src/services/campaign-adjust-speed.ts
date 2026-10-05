import { and, eq, sql } from "drizzle-orm";
import { campaignAuditTable, campaignJobsTable, campaignPlansTable, campaignRoutesTable, campaignsTable, type CampaignDeliverySettings } from "@workspace/db";
import { ALLOCATOR_V2 } from "./allocator-version";
import { isDeliveryMode, parseDeliverySettings, resolveCampaignDelivery } from "./campaign-delivery";
import { deliveryProblemIssue } from "./campaign-delivery-setup";
import { withCampaignLifecycleLock, type FrozenRoute } from "./campaign-planning";
import { MessageStudioError } from "./message-studio-errors";
import { loadCompatibilityState } from "./template-eligibility";

// V2-06C safe speed adjustment: ONLY while the campaign is Paused, under the
// campaign lifecycle lock, in one transaction. The new speed is resolved by
// the same delivery resolver (current provider caps, platform maximum,
// strict advanced validation, never clamped) for the active plan's sender
// lanes, then written to (V2-06C.1) each lane's LIVE route target
// (campaign_routes.configured_tps, the current operational speed that
// monitoring and its ETA read) and to that lane's not-yet-started (Queued)
// jobs. Nothing else changes: the frozen plan (the original launch decision,
// including its launch rates), the allocations (who sends which template to
// whom; equal-by-templates shares are NOT re-weighted), job templates, keys,
// leases, in-flight work, route status/throttle/queue state and the runtime
// pacing code. Resume paces each job at its (new) configuredTps as before.

export async function adjustCampaignSpeed(input: {
  organizationId: number;
  campaignId: number;
  actorUserId?: number;
  deliveryMode: unknown;
  /** undefined = keep the saved settings. */
  deliverySettings?: unknown;
}) {
  if (!isDeliveryMode(input.deliveryMode)) throw new MessageStudioError("delivery_invalid", "Choose fastest safe, balanced, conservative or advanced", 400);
  const deliveryMode = input.deliveryMode;
  return withCampaignLifecycleLock(input.campaignId, (scopedDb) => scopedDb.transaction(async (tx) => {
    const [campaign] = await tx.select().from(campaignsTable).where(and(
      eq(campaignsTable.id, input.campaignId), eq(campaignsTable.organizationId, input.organizationId),
    )).for("update");
    if (!campaign) throw new MessageStudioError("not_found", "Campaign not found", 404);
    if (campaign.status !== "Paused") {
      throw new MessageStudioError("setup_locked", campaign.status === "Running"
        ? "Pause the campaign before changing its speed"
        : `The speed of a ${campaign.status.toLowerCase()} campaign cannot be changed here`, 409);
    }
    const [plan] = await tx.select().from(campaignPlansTable).where(and(
      eq(campaignPlansTable.organizationId, input.organizationId), eq(campaignPlansTable.campaignId, input.campaignId), eq(campaignPlansTable.status, "Active"),
    ));
    if (!plan || plan.allocatorVersion !== ALLOCATOR_V2) {
      throw new MessageStudioError("delivery_invalid", "Only campaigns launched with a distribution can change speed", 409);
    }
    const lanes = plan.routes as FrozenRoute[];
    const phoneIds = [...new Set(lanes.map((lane) => lane.phoneNumberId))];
    const state = await loadCompatibilityState(input.organizationId, { phoneIds, templateIds: [] });

    let settings: CampaignDeliverySettings = parseDeliverySettings(campaign.deliverySettings).settings;
    if (input.deliverySettings !== undefined) {
      const parsed = parseDeliverySettings(input.deliverySettings);
      if (parsed.problems.length) throw new MessageStudioError("delivery_invalid", "Some speeds are not valid", 400, parsed.problems.map((problem) => `${deliveryProblemIssue(problem, state).message} ${problem.detail}`));
      settings = parsed.settings;
    }
    const resolution = resolveCampaignDelivery(state, phoneIds, deliveryMode, settings);
    if (resolution.problems.length || resolution.perSender.length !== phoneIds.length) {
      throw new MessageStudioError("delivery_invalid", "Some speeds are not valid", 400, resolution.problems.map((problem) => {
        const issue = deliveryProblemIssue(problem, state);
        return `${issue.message} ${issue.action}`;
      }));
    }
    const rateByPhone = new Map(resolution.perSender.map((entry) => [entry.phoneNumberId, entry.plannedRate!]));

    let jobsUpdated = 0;
    const changes: Array<{ routeId: number; phoneNumberId: number; from: number; to: number; launchRate: number; jobs: number }> = [];
    for (const lane of lanes) {
      const rate = rateByPhone.get(lane.phoneNumberId)!;
      // The live route of this frozen lane (same organization and campaign):
      // its current target is the operational "from" (the plan keeps only the
      // launch rate). Only configured_tps changes; status, throttle, current
      // TPS and queue depth are preserved. No route is created or deleted.
      const [route] = await tx.select({ id: campaignRoutesTable.id, configuredTps: campaignRoutesTable.configuredTps }).from(campaignRoutesTable).where(and(
        eq(campaignRoutesTable.id, lane.routeId),
        eq(campaignRoutesTable.organizationId, input.organizationId),
        eq(campaignRoutesTable.campaignId, input.campaignId),
      )).for("update");
      if (!route) throw new MessageStudioError("delivery_invalid", `The sending lane of number ${lane.phoneNumberId} no longer exists; the speed cannot be changed`, 409);
      await tx.update(campaignRoutesTable).set({ configuredTps: rate }).where(eq(campaignRoutesTable.id, route.id));
      // Not-yet-started work only: Queued (retries are re-queued as Queued).
      // Processing jobs hold a lease and are never touched.
      const updated = await tx.update(campaignJobsTable).set({ configuredTps: rate }).where(and(
        eq(campaignJobsTable.organizationId, input.organizationId),
        eq(campaignJobsTable.campaignId, input.campaignId),
        eq(campaignJobsTable.routeId, lane.routeId),
        eq(campaignJobsTable.status, "Queued"),
      )).returning({ id: campaignJobsTable.id });
      jobsUpdated += updated.length;
      changes.push({ routeId: lane.routeId, phoneNumberId: lane.phoneNumberId, from: route.configuredTps, to: rate, launchRate: lane.configuredTps, jobs: updated.length });
    }
    await tx.update(campaignsTable).set({ deliveryMode, deliverySettings: settings, updatedAt: sql`now()` }).where(eq(campaignsTable.id, input.campaignId));
    await tx.insert(campaignAuditTable).values({
      organizationId: input.organizationId,
      campaignId: input.campaignId,
      actorUserId: input.actorUserId,
      action: "adjust-speed",
      fromStatus: "Paused",
      toStatus: "Paused",
      metadata: { planId: plan.id, fromDeliveryMode: campaign.deliveryMode, deliveryMode, jobsUpdated, lanes: changes },
    });
    return {
      deliveryMode,
      totalMessagesPerSecond: resolution.totalMessagesPerSecond,
      perSender: resolution.perSender.map((entry) => ({ phoneNumberId: entry.phoneNumberId, effectiveCeiling: entry.effectiveCeiling, plannedRate: entry.plannedRate })),
      jobsUpdated,
    };
  }));
}
