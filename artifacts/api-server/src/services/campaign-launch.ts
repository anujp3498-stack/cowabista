import { and, eq } from "drizzle-orm";
import { campaignAuditTable, campaignPlansTable, campaignsTable, type Campaign } from "@workspace/db";
import { hasExecutionHistory } from "./campaign-import-lifecycle";
import { executeCampaignPlanLocked, planCampaignLocked, withCampaignLifecycleLock } from "./campaign-planning";
import { getCampaignPreflight } from "./campaign-preflight-report";
import type { PreflightIssue } from "./campaign-preflight-issues";

// V2-06C product Launch: the one business action that turns a configured
// campaign into a Running (send now) or Scheduled campaign. It orchestrates
// the proven engine; it does not change what Plan or Execute do:
//
//   - ONE campaign lifecycle lock for the whole operation. planCampaignLocked
//     and executeCampaignPlanLocked run on the lock's own connection, so no
//     setup writer can interleave between freezing the plan and creating its
//     jobs, and no second (nested) acquisition of the session lock happens.
//   - Stricter than the engineering `plan` action: the modern structured
//     preflight must have no blocker (audience, distribution, speed,
//     compatibility, mappings, media, provider/credential, rates).
//   - Idempotent: a retry of a launch that already started never freezes a
//     second plan. If jobs exist (execution began, e.g. a failure after some
//     pages), the SAME active plan is resumed by the idempotent execute; the
//     job key stays send:<contact key>.
//   - Scheduled launch freezes the plan, moves Ready -> Scheduled and stores
//     the time; the existing runtime executes the frozen plan when due (no
//     second scheduler, no early jobs).

export type LaunchOutcome = "launched" | "resumed" | "already_running" | "scheduled" | "already_scheduled";

export class LaunchBlockedError extends Error {
  constructor(readonly blockers: PreflightIssue[]) {
    super("The campaign is not ready to launch");
    this.name = "LaunchBlockedError";
  }
}

export type LaunchConflictCode = "not_found" | "launch_not_allowed" | "already_scheduled" | "already_running" | "invalid_schedule";

export class LaunchConflictError extends Error {
  constructor(readonly code: LaunchConflictCode, message: string, readonly status: number = 409) {
    super(message);
    this.name = "LaunchConflictError";
  }
}

export type LaunchInput = {
  organizationId: number;
  campaignId: number;
  actorUserId?: number;
  /** Absent = send now; a future time = schedule. */
  scheduledAt?: Date;
  /** IANA time zone the user scheduled in (display metadata only). */
  timezone?: string;
  now?: Date;
};

export type LaunchResult = { outcome: LaunchOutcome; planId: number | null; queuedNew: number; campaign: Campaign };

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export async function launchCampaign(input: LaunchInput): Promise<LaunchResult> {
  const now = input.now ?? new Date();
  const schedule = input.scheduledAt !== undefined;
  // The future-time rule is checked under the lock, AFTER recognising a
  // retry of an already-scheduled launch (whose time may have passed).
  if (input.timezone !== undefined && !validTimeZone(input.timezone)) {
    throw new LaunchConflictError("invalid_schedule", "The time zone is not recognised", 400);
  }

  return withCampaignLifecycleLock(input.campaignId, async (scopedDb) => {
    const [campaign] = await scopedDb.select().from(campaignsTable).where(and(
      eq(campaignsTable.id, input.campaignId),
      eq(campaignsTable.organizationId, input.organizationId),
    ));
    if (!campaign) throw new LaunchConflictError("not_found", "Campaign not found", 404);
    const activePlan = async () => (await scopedDb.select({ id: campaignPlansTable.id }).from(campaignPlansTable).where(and(
      eq(campaignPlansTable.organizationId, input.organizationId),
      eq(campaignPlansTable.campaignId, input.campaignId),
      eq(campaignPlansTable.status, "Active"),
    )))[0] ?? null;
    const audit = (action: string, fromStatus: string, toStatus: string, metadata: Record<string, unknown>) => scopedDb.insert(campaignAuditTable).values({
      organizationId: input.organizationId, campaignId: input.campaignId, actorUserId: input.actorUserId, action, fromStatus, toStatus, metadata,
    });

    // ---- already launched: idempotent retries -------------------------
    if (campaign.status === "Running") {
      if (schedule) throw new LaunchConflictError("already_running", "This campaign is already sending");
      // Same operation retried (double click, lost response): finish any
      // missing jobs of the SAME plan (idempotent) and report success.
      const result = await executeCampaignPlanLocked(scopedDb, input.organizationId, input.campaignId);
      return { outcome: "already_running", planId: result.plan.id, queuedNew: result.queuedNew, campaign: result.campaign };
    }
    if (campaign.status === "Scheduled") {
      const sameTime = schedule && campaign.scheduledAt !== null && campaign.scheduledAt.getTime() === input.scheduledAt!.getTime();
      if (sameTime) {
        const plan = await activePlan();
        return { outcome: "already_scheduled", planId: plan?.id ?? null, queuedNew: 0, campaign };
      }
      throw new LaunchConflictError("already_scheduled", `This campaign is already scheduled for ${campaign.scheduledAt?.toISOString() ?? "later"}; cancel it to change the time`);
    }
    if (campaign.status !== "Draft" && campaign.status !== "Ready") {
      throw new LaunchConflictError("launch_not_allowed", `A ${campaign.status.toLowerCase()} campaign cannot be launched`);
    }

    // ---- execution already began (e.g. a failure after some pages) ------
    if (await hasExecutionHistory(scopedDb, input.organizationId, input.campaignId)) {
      const plan = await activePlan();
      if (schedule || campaign.status !== "Ready" || !plan) {
        throw new LaunchConflictError("launch_not_allowed", "Sending already started for this campaign; it can only be resumed by sending now");
      }
      // Resume the SAME active plan: never freeze a second plan over jobs
      // that already carry this plan's decisions and idempotency keys.
      const result = await executeCampaignPlanLocked(scopedDb, input.organizationId, input.campaignId);
      await audit("launch", campaign.status, result.campaign.status, { intent: "send_now", outcome: "resumed", planId: result.plan.id, queuedNew: result.queuedNew });
      return { outcome: "resumed", planId: result.plan.id, queuedNew: result.queuedNew, campaign: result.campaign };
    }

    if (schedule && (Number.isNaN(input.scheduledAt!.getTime()) || input.scheduledAt!.getTime() <= now.getTime())) {
      throw new LaunchConflictError("invalid_schedule", "Choose a time in the future", 400);
    }

    // ---- first launch: modern readiness, then plan (+ execute) ----------
    const report = await getCampaignPreflight(input.organizationId, input.campaignId);
    if (!report.ready) throw new LaunchBlockedError(report.blockers);
    const { plan } = await planCampaignLocked(scopedDb, input.organizationId, input.campaignId);

    if (!schedule) {
      const result = await executeCampaignPlanLocked(scopedDb, input.organizationId, input.campaignId);
      await audit("launch", campaign.status, result.campaign.status, { intent: "send_now", outcome: "launched", planId: plan.id, queuedNew: result.queuedNew });
      return { outcome: "launched", planId: plan.id, queuedNew: result.queuedNew, campaign: result.campaign };
    }

    // Scheduled: the frozen plan waits; the runtime executes it when due.
    const [scheduled] = await scopedDb.update(campaignsTable).set({
      status: "Scheduled",
      scheduledAt: input.scheduledAt!,
      scheduleLabel: input.scheduledAt!.toISOString(),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    }).where(and(eq(campaignsTable.id, input.campaignId), eq(campaignsTable.status, "Ready"))).returning();
    if (!scheduled) throw new LaunchConflictError("launch_not_allowed", "The campaign changed while it was being scheduled");
    await audit("launch", "Ready", "Scheduled", { intent: "schedule", outcome: "scheduled", planId: plan.id, scheduledAt: input.scheduledAt!.toISOString(), timezone: input.timezone ?? null });
    return { outcome: "scheduled", planId: plan.id, queuedNew: 0, campaign: scheduled };
  });
}
