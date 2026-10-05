import { and, asc, eq, sql } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignContactsTable,
  campaignMessageSetupsTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateSelectionsTable,
  db,
  type CampaignDeliveryMode,
  type CampaignDeliverySettings,
  type CampaignDistributionMode,
} from "@workspace/db";
import { assertSetupEditable } from "./campaign-import-lifecycle";
import { withCampaignLifecycleLock } from "./campaign-planning";
import { CAMPAIGN_PLATFORM_MAX_TPS } from "./campaign-pacing-coordinator";
import {
  estimateDurationSeconds,
  isDeliveryMode,
  parseDeliverySettings,
  presetRate,
  resolveDelivery,
  effectiveCeiling,
  type DeliveryProblem,
  type DeliveryResolution,
} from "./campaign-delivery";
import { makeIssue, type PreflightIssue } from "./campaign-preflight-issues";
import { describePhone, loadCompatibilityState, type CompatibilityState } from "./template-eligibility";
import { deriveSetupRoutes, executionFor, lockSetupRow, setupEditability } from "./message-studio";
import { MessageStudioError } from "./message-studio-errors";

// V2-06B Delivery step: distribution (allocator-v2 mode) and speed (delivery
// mode + advanced per-number rates). Management plane only: it never plans,
// executes or sends. Writes go through the same lifecycle lock, setup fence
// (assertSetupEditable) and Message Studio revision as every other setup
// change, because the distribution decides the sender-lane topology that
// Message Studio also writes (one revision for one coupled setup). Rates are
// never stored on routes: planning resolves them with the same resolver.

const DISTRIBUTION_MODES: readonly CampaignDistributionMode[] = ["equal_numbers", "equal_templates"];
const PRESET_MODES = ["fastest_safe", "balanced", "conservative"] as const;

/** Selected senders of the Message step (the routes' numbers for campaigns set up before Message Studio). */
export async function selectedSenderIds(executor: Pick<typeof db, "select">, organizationId: number, campaignId: number): Promise<number[]> {
  const [setup] = await executor.select({ senders: campaignMessageSetupsTable.senderPhoneNumberIds }).from(campaignMessageSetupsTable).where(and(
    eq(campaignMessageSetupsTable.organizationId, organizationId), eq(campaignMessageSetupsTable.campaignId, campaignId),
  ));
  if (setup) return [...setup.senders];
  const routes = await executor.select({ phoneNumberId: campaignRoutesTable.phoneNumberId }).from(campaignRoutesTable).where(and(
    eq(campaignRoutesTable.organizationId, organizationId), eq(campaignRoutesTable.campaignId, campaignId),
  )).orderBy(asc(campaignRoutesTable.id));
  return [...new Set(routes.map((route) => route.phoneNumberId))];
}

/** Valid recipients of the ACTIVE audience generation (indexed count; what Plan allocates). */
export async function activeValidRecipients(executor: Pick<typeof db, "select">, organizationId: number, campaignId: number, audienceGeneration: number): Promise<number> {
  const [row] = await executor.select({ count: sql<number>`count(*)::int` }).from(campaignContactsTable).where(and(
    eq(campaignContactsTable.organizationId, organizationId),
    eq(campaignContactsTable.campaignId, campaignId),
    eq(campaignContactsTable.audienceGeneration, audienceGeneration),
    eq(campaignContactsTable.status, "Valid"),
  ));
  return row?.count ?? 0;
}

/** The delivery resolution for the selected senders, from already-loaded compatibility state. */
export function resolveCampaignDelivery(state: CompatibilityState, senderIds: number[], deliveryMode: CampaignDeliveryMode, settings: unknown): DeliveryResolution {
  return resolveDelivery({
    deliveryMode,
    settings,
    senders: senderIds.flatMap((phoneNumberId) => {
      const phone = state.phones.get(phoneNumberId);
      return phone ? [{ phoneNumberId, providerApprovedRate: phone.tpsLimit }] : [];
    }),
  });
}

/** Business-facing issue for a delivery problem (catalogue code = problem code). */
export function deliveryProblemIssue(problem: DeliveryProblem, state: CompatibilityState): PreflightIssue {
  const phone = problem.phoneNumberId === null ? undefined : state.phones.get(problem.phoneNumberId);
  const label = phone ? phone.displayName || phone.phone : undefined;
  return makeIssue(problem.code, { phone: label, max: problem.maxMessagesPerSecond }, problem.phoneNumberId === null ? {} : { phoneNumberId: problem.phoneNumberId }, problem.detail);
}

export async function loadDeliverySetup(organizationId: number, campaignId: number) {
  const [campaign] = await db.select({
    id: campaignsTable.id, status: campaignsTable.status, audienceGeneration: campaignsTable.audienceGeneration,
    distributionMode: campaignsTable.distributionMode, deliveryMode: campaignsTable.deliveryMode, deliverySettings: campaignsTable.deliverySettings,
  }).from(campaignsTable).where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.organizationId, organizationId)));
  if (!campaign) throw new MessageStudioError("not_found", "Campaign not found", 404);
  const [setup] = await db.select({ revision: campaignMessageSetupsTable.revision }).from(campaignMessageSetupsTable).where(and(
    eq(campaignMessageSetupsTable.organizationId, organizationId), eq(campaignMessageSetupsTable.campaignId, campaignId),
  ));
  const senderIds = await selectedSenderIds(db, organizationId, campaignId);
  const [{ templateCount }] = await db.select({ templateCount: sql<number>`count(*)::int` }).from(campaignTemplateSelectionsTable).where(and(
    eq(campaignTemplateSelectionsTable.organizationId, organizationId), eq(campaignTemplateSelectionsTable.campaignId, campaignId),
  ));
  const state = await loadCompatibilityState(organizationId, { phoneIds: senderIds, templateIds: [] });
  const recipients = await activeValidRecipients(db, organizationId, campaignId, campaign.audienceGeneration);
  const { editable, editBlockedReason } = await setupEditability(organizationId, campaignId, campaign.status);
  const deliveryMode = isDeliveryMode(campaign.deliveryMode) ? campaign.deliveryMode : null;
  const parsedSettings = parseDeliverySettings(campaign.deliverySettings);
  const advancedRates = new Map((parsedSettings.settings.perNumberRates ?? []).map((entry) => [entry.phoneNumberId, entry.messagesPerSecond]));
  const resolution = deliveryMode ? resolveCampaignDelivery(state, senderIds, deliveryMode, campaign.deliverySettings) : null;
  const presetSummaries = PRESET_MODES.map((mode) => {
    const preset = resolveCampaignDelivery(state, senderIds, mode, undefined);
    return { deliveryMode: mode, totalMessagesPerSecond: preset.totalMessagesPerSecond, estimatedDurationSeconds: estimateDurationSeconds(recipients, preset.totalMessagesPerSecond) };
  });
  const senders = senderIds.flatMap((phoneNumberId) => {
    const phone = state.phones.get(phoneNumberId);
    if (!phone) return [];
    const ceiling = effectiveCeiling(phone.tpsLimit);
    return [{
      phoneNumberId,
      phone: phone.phone,
      displayName: phone.displayName,
      usable: describePhone(state, phoneNumberId).ok,
      providerApprovedRate: phone.tpsLimit,
      platformRate: CAMPAIGN_PLATFORM_MAX_TPS,
      effectiveCeiling: ceiling,
      plannedRate: resolution?.perSender.find((entry) => entry.phoneNumberId === phoneNumberId)?.plannedRate ?? null,
      advancedRate: advancedRates.get(phoneNumberId) ?? null,
      presetRates: {
        fastest_safe: ceiling === null ? null : presetRate("fastest_safe", ceiling),
        balanced: ceiling === null ? null : presetRate("balanced", ceiling),
        conservative: ceiling === null ? null : presetRate("conservative", ceiling),
      },
    }];
  });
  const totalMessagesPerSecond = resolution?.totalMessagesPerSecond ?? null;
  return {
    campaignId,
    revision: setup?.revision ?? 0,
    status: campaign.status,
    editable,
    editBlockedReason,
    distributionMode: (DISTRIBUTION_MODES as readonly string[]).includes(campaign.distributionMode ?? "") ? campaign.distributionMode as CampaignDistributionMode : null,
    deliveryMode,
    deliverySettings: { perNumberRates: parsedSettings.settings.perNumberRates ?? [] },
    senders,
    templateCount,
    totalMessagesPerSecond,
    recipients,
    estimatedDurationSeconds: estimateDurationSeconds(recipients, totalMessagesPerSecond),
    platformMaxMessagesPerSecond: CAMPAIGN_PLATFORM_MAX_TPS,
    modeSummaries: presetSummaries,
    problems: resolution ? resolution.problems.map((problem) => deliveryProblemIssue(problem, state)) : [],
  };
}

export type SaveDeliverySetupInput = {
  organizationId: number;
  campaignId: number;
  actorUserId?: number;
  revision: number;
  distributionMode: unknown;
  deliveryMode: unknown;
  /** undefined = keep the saved settings. */
  deliverySettings?: unknown;
};

export async function saveDeliverySetup(input: SaveDeliverySetupInput) {
  if (typeof input.distributionMode !== "string" || !(DISTRIBUTION_MODES as readonly string[]).includes(input.distributionMode)) {
    throw new MessageStudioError("distribution_invalid", "Choose equal by numbers or equal by templates", 400);
  }
  if (!isDeliveryMode(input.deliveryMode)) throw new MessageStudioError("delivery_invalid", "Choose fastest safe, balanced, conservative or advanced", 400);
  const distributionMode = input.distributionMode as CampaignDistributionMode;
  const deliveryMode = input.deliveryMode;
  await withCampaignLifecycleLock(input.campaignId, (scopedDb) => scopedDb.transaction(async (tx) => {
    // The ONE setup fence: Draft, or Ready without execution history (its
    // plan is superseded and it returns to Draft in THIS transaction).
    const editable = await assertSetupEditable(tx, input.organizationId, input.campaignId, input.actorUserId);
    if (!editable.ok) {
      if (editable.message === "Campaign not found") throw new MessageStudioError("not_found", "Campaign not found", 404);
      throw new MessageStudioError(editable.code === "setup_locked" ? "setup_locked" : editable.code as "execution_history" | "import_in_progress", editable.message, 409);
    }
    const setup = await lockSetupRow(tx, input.organizationId, input.campaignId);
    if (setup.revision !== input.revision) {
      throw new MessageStudioError("stale_revision", `This save was based on revision ${input.revision} but the campaign setup is at revision ${setup.revision}. Reload to see the latest changes.`, 409);
    }
    const senderIds = await selectedSenderIds(tx, input.organizationId, input.campaignId);
    const selections = await tx.select({ templateId: campaignTemplateSelectionsTable.templateId }).from(campaignTemplateSelectionsTable).where(and(
      eq(campaignTemplateSelectionsTable.organizationId, input.organizationId), eq(campaignTemplateSelectionsTable.campaignId, input.campaignId),
    )).orderBy(asc(campaignTemplateSelectionsTable.id));
    const templateIds = selections.map((row) => row.templateId);
    if (!senderIds.length || !templateIds.length) {
      throw new MessageStudioError("message_setup_incomplete", "Choose numbers and templates in the Message step first", 409);
    }
    const state = await loadCompatibilityState(input.organizationId, { phoneIds: senderIds, templateIds });
    if (senderIds.some((id) => !state.phones.has(id))) {
      throw new MessageStudioError("message_setup_incomplete", "A selected number is no longer in this workspace; update the Message step first", 409);
    }

    const [current] = await tx.select({ deliverySettings: campaignsTable.deliverySettings }).from(campaignsTable)
      .where(and(eq(campaignsTable.id, input.campaignId), eq(campaignsTable.organizationId, input.organizationId)));
    let settings: CampaignDeliverySettings = parseDeliverySettings(current?.deliverySettings).settings;
    if (input.deliverySettings !== undefined) {
      const parsed = parseDeliverySettings(input.deliverySettings);
      if (parsed.problems.length) {
        throw new MessageStudioError("delivery_invalid", "Some speeds are not valid", 400, parsed.problems.map((problem) => deliveryProblemIssue(problem, state).message + " " + problem.detail));
      }
      settings = parsed.settings;
    }
    if (deliveryMode === "advanced") {
      // Server-side validation; never a silent clamp: every selected number
      // needs one whole rate at most its effective ceiling, and no rate may
      // name a number that is not selected (another workspace's number can
      // never be selected).
      const resolution = resolveCampaignDelivery(state, senderIds, deliveryMode, settings);
      if (resolution.problems.length) {
        throw new MessageStudioError("delivery_invalid", "Some speeds are not valid", 400, resolution.problems.map((problem) => {
          const issue = deliveryProblemIssue(problem, state);
          return `${issue.message} ${issue.action}`;
        }));
      }
    }

    await tx.update(campaignsTable).set({ distributionMode, deliveryMode, deliverySettings: settings })
      .where(and(eq(campaignsTable.id, input.campaignId), eq(campaignsTable.organizationId, input.organizationId)));
    // The distribution decides the route topology: re-derive with the ONE
    // shared derivation (exactly one shared-budget lane per selected number).
    const execution = executionFor(state, senderIds, templateIds, distributionMode);
    const routeCount = await deriveSetupRoutes(tx, { organizationId: input.organizationId, campaignId: input.campaignId, state, senderIds, templateIds, distributionMode, execution });
    await tx.update(campaignMessageSetupsTable).set({ revision: setup.revision + 1, updatedBy: input.actorUserId ?? null }).where(eq(campaignMessageSetupsTable.id, setup.id));
    await tx.insert(campaignAuditTable).values({
      organizationId: input.organizationId,
      campaignId: input.campaignId,
      actorUserId: input.actorUserId,
      action: "delivery_setup_saved",
      fromStatus: "Draft",
      toStatus: "Draft",
      metadata: { revision: setup.revision + 1, distributionMode, deliveryMode, routes: routeCount, advancedRates: settings.perNumberRates?.length ?? 0 },
    });
  }));
  return loadDeliverySetup(input.organizationId, input.campaignId);
}
