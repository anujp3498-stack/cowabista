import type { CampaignDeliveryMode, CampaignDeliverySettings } from "@workspace/db";
import { campaignDeliveryModes } from "@workspace/db";
import { CAMPAIGN_PLATFORM_MAX_TPS } from "./campaign-pacing-coordinator";
import type { CompatibilityState } from "./template-eligibility";

// V2-06B delivery (speed) resolution: the ONE place that turns a campaign's
// delivery mode into a planned rate per sending number. Pure after its
// inputs (no DB, provider, clock or mutable state). Delivery setup, the
// structured preflight and planning all call it, so the speed a user sees,
// the weight allocator v2 uses for equal-by-templates, the rate frozen into
// the plan's sender lane and the rate copied onto every job are one value.
//
// The runtime is unchanged: it already paces each job at its frozen
// `configuredTps` (and never above the phone's provider cap or the platform
// maximum). Balanced's warm-up ramp from the master spec is NOT implemented
// (it would need new hot-path pacing behaviour); Balanced is a constant 60%
// target until that is decided in V2-06C review.

export { campaignDeliveryModes };
export type { CampaignDeliveryMode, CampaignDeliverySettings };

/** Share of the effective ceiling used by Balanced. */
export const BALANCED_SHARE = 0.6;
/** Share of the effective ceiling used by Conservative, and its preferred floor. */
export const CONSERVATIVE_SHARE = 0.25;
export const CONSERVATIVE_FLOOR = 5;

export type DeliveryProblemCode =
  | "advanced_rate_missing"
  | "advanced_rate_invalid"
  | "rate_above_ceiling"
  | "sender_rate_unavailable";

export type DeliveryProblem = {
  code: DeliveryProblemCode;
  phoneNumberId: number | null;
  /** Engineering detail (safe ids/values only). */
  detail: string;
  /** The highest allowed rate when the problem is a ceiling. */
  maxMessagesPerSecond?: number;
};

export type DeliverySenderInput = {
  phoneNumberId: number;
  /** The phone's provider-approved messages per second (phone_numbers.tps_limit). */
  providerApprovedRate: number;
};

export type SenderDeliveryResolution = {
  phoneNumberId: number;
  deliveryMode: CampaignDeliveryMode;
  providerApprovedRate: number;
  platformRate: number;
  /** min(provider-approved rate, platform maximum); null when the provider rate is unusable. */
  effectiveCeiling: number | null;
  /** The rate planning freezes for this sender lane; null when it cannot be resolved. */
  plannedRate: number | null;
  problem: DeliveryProblem | null;
};

export type DeliveryResolution = {
  deliveryMode: CampaignDeliveryMode;
  perSender: SenderDeliveryResolution[];
  /** Sum of planned rates, or null when any sender cannot be resolved. */
  totalMessagesPerSecond: number | null;
  problems: DeliveryProblem[];
};

export function isDeliveryMode(value: unknown): value is CampaignDeliveryMode {
  return typeof value === "string" && (campaignDeliveryModes as readonly string[]).includes(value);
}

const isPositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/** min(provider-approved rate, platform maximum), or null when the provider rate is not a positive integer. */
export function effectiveCeiling(providerApprovedRate: number, platformMax: number = CAMPAIGN_PLATFORM_MAX_TPS): number | null {
  if (!isPositiveInteger(providerApprovedRate)) return null;
  return Math.min(providerApprovedRate, platformMax);
}

/** The planned rate of a non-advanced mode for one effective ceiling (always 1..ceiling). */
export function presetRate(mode: Exclude<CampaignDeliveryMode, "advanced">, ceiling: number): number {
  if (!isPositiveInteger(ceiling)) throw new RangeError("ceiling must be a positive integer");
  switch (mode) {
    case "fastest_safe":
      return ceiling;
    case "balanced":
      return Math.min(ceiling, Math.max(1, Math.floor(ceiling * BALANCED_SHARE)));
    case "conservative":
      return Math.min(ceiling, Math.max(CONSERVATIVE_FLOOR, Math.floor(ceiling * CONSERVATIVE_SHARE)));
  }
}

/**
 * Shape check of stored/submitted settings, independent of senders:
 * `perNumberRates` must be an array of unique phone ids with positive
 * integer rates. Returns the typed settings plus any problems (nothing is
 * dropped or coerced).
 */
export function parseDeliverySettings(raw: unknown): { settings: CampaignDeliverySettings; problems: DeliveryProblem[] } {
  const problems: DeliveryProblem[] = [];
  if (raw === null || raw === undefined) return { settings: {}, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { settings: {}, problems: [{ code: "advanced_rate_invalid", phoneNumberId: null, detail: "delivery settings must be an object" }] };
  }
  const extra = Object.keys(raw).filter((key) => key !== "perNumberRates");
  if (extra.length) problems.push({ code: "advanced_rate_invalid", phoneNumberId: null, detail: `unknown delivery settings: ${extra.join(", ")}` });
  const list = (raw as { perNumberRates?: unknown }).perNumberRates;
  if (list === undefined) return { settings: {}, problems };
  if (!Array.isArray(list)) {
    return { settings: {}, problems: [...problems, { code: "advanced_rate_invalid", phoneNumberId: null, detail: "perNumberRates must be a list" }] };
  }
  const seen = new Set<number>();
  const perNumberRates: Array<{ phoneNumberId: number; messagesPerSecond: number }> = [];
  for (const entry of list) {
    const phoneNumberId = (entry as { phoneNumberId?: unknown })?.phoneNumberId;
    const rate = (entry as { messagesPerSecond?: unknown })?.messagesPerSecond;
    const entryKeys = entry && typeof entry === "object" ? Object.keys(entry).filter((key) => key !== "phoneNumberId" && key !== "messagesPerSecond") : [];
    if (!isPositiveInteger(phoneNumberId)) {
      problems.push({ code: "advanced_rate_invalid", phoneNumberId: null, detail: "each rate needs a number id" });
      continue;
    }
    if (entryKeys.length) problems.push({ code: "advanced_rate_invalid", phoneNumberId, detail: `unknown fields: ${entryKeys.join(", ")}` });
    if (seen.has(phoneNumberId)) {
      problems.push({ code: "advanced_rate_invalid", phoneNumberId, detail: `number ${phoneNumberId} has more than one rate` });
      continue;
    }
    seen.add(phoneNumberId);
    if (!isPositiveInteger(rate)) {
      problems.push({ code: "advanced_rate_invalid", phoneNumberId, detail: `rate for number ${phoneNumberId} must be a whole number of at least 1 (got ${JSON.stringify(rate)})` });
      continue;
    }
    perNumberRates.push({ phoneNumberId, messagesPerSecond: rate });
  }
  return { settings: { perNumberRates }, problems };
}

/**
 * Resolves the planned rate of every selected sender. `advanced` requires
 * exactly one valid rate per selected sender, at most its effective ceiling
 * (never clamped); a rate for a number that is not selected is a problem,
 * never ignored. Other modes ignore saved advanced values entirely.
 */
export function resolveDelivery(input: {
  deliveryMode: CampaignDeliveryMode;
  senders: DeliverySenderInput[];
  settings?: unknown;
  platformMax?: number;
}): DeliveryResolution {
  const platformMax = input.platformMax ?? CAMPAIGN_PLATFORM_MAX_TPS;
  const senders = [...input.senders].sort((a, b) => a.phoneNumberId - b.phoneNumberId);
  const problems: DeliveryProblem[] = [];
  let advanced = new Map<number, number>();
  if (input.deliveryMode === "advanced") {
    const parsed = parseDeliverySettings(input.settings);
    problems.push(...parsed.problems);
    advanced = new Map((parsed.settings.perNumberRates ?? []).map((entry) => [entry.phoneNumberId, entry.messagesPerSecond]));
    const selected = new Set(senders.map((sender) => sender.phoneNumberId));
    for (const phoneNumberId of advanced.keys()) {
      if (!selected.has(phoneNumberId)) problems.push({ code: "advanced_rate_invalid", phoneNumberId, detail: `number ${phoneNumberId} is not a selected sending number` });
    }
  }
  const perSender = senders.map((sender): SenderDeliveryResolution => {
    const ceiling = effectiveCeiling(sender.providerApprovedRate, platformMax);
    const base = { phoneNumberId: sender.phoneNumberId, deliveryMode: input.deliveryMode, providerApprovedRate: sender.providerApprovedRate, platformRate: platformMax, effectiveCeiling: ceiling };
    const fail = (problem: DeliveryProblem): SenderDeliveryResolution => {
      problems.push(problem);
      return { ...base, plannedRate: null, problem };
    };
    if (ceiling === null) return fail({ code: "sender_rate_unavailable", phoneNumberId: sender.phoneNumberId, detail: `number ${sender.phoneNumberId} has no valid provider-approved rate` });
    if (input.deliveryMode !== "advanced") return { ...base, plannedRate: presetRate(input.deliveryMode, ceiling), problem: null };
    const rate = advanced.get(sender.phoneNumberId);
    if (rate === undefined) return fail({ code: "advanced_rate_missing", phoneNumberId: sender.phoneNumberId, detail: `number ${sender.phoneNumberId} has no advanced rate` });
    if (rate > ceiling) {
      return fail({ code: "rate_above_ceiling", phoneNumberId: sender.phoneNumberId, detail: `number ${sender.phoneNumberId}: ${rate} messages/second is above its maximum of ${ceiling}`, maxMessagesPerSecond: ceiling });
    }
    return { ...base, plannedRate: rate, problem: null };
  });
  const complete = perSender.every((sender) => sender.plannedRate !== null);
  return {
    deliveryMode: input.deliveryMode,
    perSender,
    totalMessagesPerSecond: complete && perSender.length ? perSender.reduce((sum, sender) => sum + sender.plannedRate!, 0) : null,
    problems,
  };
}

/** A theoretical sending estimate: ceil(recipients / messages per second). Not a completion guarantee. */
export function estimateDurationSeconds(recipients: number, messagesPerSecond: number | null): number | null {
  if (messagesPerSecond === null || messagesPerSecond < 1) return null;
  return Math.ceil(Math.max(0, recipients) / messagesPerSecond);
}

/**
 * The delivery resolution for the selected senders from already-loaded
 * compatibility state (provider-approved rate = the phone's tps_limit). The
 * one entry point the Delivery step, preflight and planning share.
 */
export function resolveCampaignDelivery(state: Pick<CompatibilityState, "phones">, senderIds: number[], deliveryMode: CampaignDeliveryMode, settings: unknown): DeliveryResolution {
  return resolveDelivery({
    deliveryMode,
    settings,
    senders: senderIds.flatMap((phoneNumberId) => {
      const phone = state.phones.get(phoneNumberId);
      return phone ? [{ phoneNumberId, providerApprovedRate: phone.tpsLimit }] : [];
    }),
  });
}
