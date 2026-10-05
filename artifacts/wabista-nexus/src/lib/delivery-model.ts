// V2-06B Delivery step model (pure, dependency-free; unit tested with
// node --experimental-strip-types). Every rate shown comes from the server
// (DeliverySetup.presetRates / modeSummaries / effectiveCeiling); this module
// never re-derives a delivery formula. The only arithmetic here is summing
// the advanced rates the user typed (and the matching estimate) while the
// form is unsaved; the server validates every value on save and never clamps.
import type { DeliverySetup, DeliverySetupInput } from "@workspace/api-client-react"

export type DistributionChoice = "equal_numbers" | "equal_templates"
export type SpeedChoice = "fastest_safe" | "balanced" | "conservative" | "advanced"

export type DeliveryDraft = {
  distributionMode: DistributionChoice | null
  deliveryMode: SpeedChoice | null
  /** Advanced rate input per phone number id (raw text as typed). */
  rates: Record<string, string>
}

export const DISTRIBUTION_OPTIONS: ReadonlyArray<{ value: DistributionChoice; title: string; description: string }> = [
  { value: "equal_numbers", title: "Equal by numbers", description: "Each selected number sends an equal share." },
  { value: "equal_templates", title: "Equal by templates", description: "Each selected template gets an equal share, sent only by compatible numbers." },
]

export const SPEED_OPTIONS: ReadonlyArray<{ value: SpeedChoice; title: string; description: string }> = [
  { value: "fastest_safe", title: "Fastest safe", description: "Use the maximum capacity currently allowed on these numbers." },
  { value: "balanced", title: "Balanced", description: "Spread load with emphasis on stability." },
  { value: "conservative", title: "Conservative", description: "Use reduced sending pressure." },
  { value: "advanced", title: "Advanced", description: "Set the speed for each number." },
]

type SetupLike = Pick<DeliverySetup, "distributionMode" | "deliveryMode" | "senders" | "totalMessagesPerSecond" | "modeSummaries" | "recipients" | "revision">

export function deliveryDraftFrom(setup: SetupLike): DeliveryDraft {
  const rates: Record<string, string> = {}
  for (const sender of setup.senders) {
    // Advanced inputs start from the saved advanced rate, else the number's
    // fastest safe rate (its maximum), both server values.
    const start = sender.advancedRate ?? sender.presetRates.fastest_safe
    rates[String(sender.phoneNumberId)] = start === null || start === undefined ? "" : String(start)
  }
  return { distributionMode: (setup.distributionMode ?? null) as DistributionChoice | null, deliveryMode: (setup.deliveryMode ?? null) as SpeedChoice | null, rates }
}

/** Equal when the choices match; advanced rates only matter when Advanced is chosen. */
export function sameDeliveryDraft(a: DeliveryDraft, b: DeliveryDraft): boolean {
  if (a.distributionMode !== b.distributionMode || a.deliveryMode !== b.deliveryMode) return false
  if (a.deliveryMode !== "advanced") return true
  const keys = new Set([...Object.keys(a.rates), ...Object.keys(b.rates)])
  for (const key of keys) if ((a.rates[key] ?? "").trim() !== (b.rates[key] ?? "").trim()) return false
  return true
}

/** Parses a typed rate: a whole number >= 1, else null. */
export function parseRate(value: string | undefined): number | null {
  const text = (value ?? "").trim()
  if (!/^\d+$/.test(text)) return null
  const rate = Number(text)
  return Number.isSafeInteger(rate) && rate >= 1 ? rate : null
}

/** Inline hint for one advanced input (display only; the server decides). */
export function rateHint(value: string | undefined, effectiveCeiling: number | null): string | null {
  const rate = parseRate(value)
  if (rate === null) return "Enter a whole number of messages per second (at least 1)."
  if (effectiveCeiling !== null && rate > effectiveCeiling) return `This number can send at most ${effectiveCeiling} messages/sec.`
  return null
}

/** The save body: advanced rates are sent only for Advanced (other modes keep the saved ones). */
export function deliveryPayload(draft: DeliveryDraft, setup: SetupLike, revision: number): DeliverySetupInput {
  if (!draft.distributionMode || !draft.deliveryMode) throw new Error("Choose a distribution and a speed")
  const body: DeliverySetupInput = { revision, distributionMode: draft.distributionMode, deliveryMode: draft.deliveryMode }
  if (draft.deliveryMode === "advanced") {
    body.deliverySettings = {
      // Sent as typed (any finite number, e.g. 2.5 or 500) so the server
      // reports exactly what is wrong instead of the page silently fixing
      // it; an empty or non-numeric entry is left out (the server then says
      // that number's speed is missing).
      perNumberRates: setup.senders.flatMap((sender) => {
        const raw = (draft.rates[String(sender.phoneNumberId)] ?? "").trim()
        const value = raw === "" ? Number.NaN : Number(raw)
        return Number.isFinite(value) ? [{ phoneNumberId: sender.phoneNumberId, messagesPerSecond: value }] : []
      }),
    }
  }
  return body
}

/** Total planned messages/sec for the draft: server values for presets, the typed sum for Advanced. */
export function plannedTotal(draft: DeliveryDraft, setup: SetupLike, dirty: boolean): number | null {
  if (!draft.deliveryMode) return null
  if (!dirty && draft.deliveryMode === setup.deliveryMode) return setup.totalMessagesPerSecond ?? null
  if (draft.deliveryMode !== "advanced") return setup.modeSummaries.find((summary) => summary.deliveryMode === draft.deliveryMode)?.totalMessagesPerSecond ?? null
  let total = 0
  for (const sender of setup.senders) {
    const rate = parseRate(draft.rates[String(sender.phoneNumberId)])
    if (rate === null || (sender.effectiveCeiling !== null && rate > sender.effectiveCeiling)) return null
    total += rate
  }
  return setup.senders.length ? total : null
}

/** ceil(recipients / messages per second); null when speed is unknown. A theoretical estimate. */
export function estimateSeconds(recipients: number, messagesPerSecond: number | null): number | null {
  if (messagesPerSecond === null || messagesPerSecond < 1) return null
  return Math.ceil(Math.max(0, recipients) / messagesPerSecond)
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—"
  if (seconds < 60) return `about ${seconds} s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `about ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`
}

export function distributionSummary(mode: DistributionChoice | null): string {
  return DISTRIBUTION_OPTIONS.find((option) => option.value === mode)?.description ?? "Not chosen yet."
}
