// V2-06C Review & Launch model (pure, dependency-free; unit tested with
// node --experimental-strip-types). Readiness is decided ONLY by the
// server's structured preflight: this module groups the server's issues for
// display and builds the launch request. It never re-derives a rule.
import type { CampaignActionInput, PreflightIssue, PreflightReport } from "@workspace/api-client-react"

export type CheckGroupKey = "numbers" | "templates" | "variables" | "media" | "compatibility" | "connection" | "audience" | "setup"

export const CHECK_GROUPS: ReadonlyArray<{ key: CheckGroupKey; title: string; codes: readonly string[] }> = [
  { key: "audience", title: "Audience", codes: ["audience_empty", "import_in_progress"] },
  { key: "numbers", title: "Numbers", codes: ["no_senders", "sender_unusable", "sender_rate_unavailable", "sender_without_template", "sender_configuration_stale", "rate_above_ceiling", "rate_invalid", "advanced_rate_missing", "advanced_rate_invalid"] },
  { key: "templates", title: "Templates", codes: ["no_templates", "template_unusable"] },
  { key: "variables", title: "Variables", codes: ["mapping_missing", "mapping_invalid", "csv_column_missing"] },
  { key: "media", title: "Media", codes: ["media_missing", "media_wrong_kind", "media_transport_unsupported"] },
  { key: "compatibility", title: "Compatibility", codes: ["template_without_sender", "pair_incompatible", "selection_not_runnable"] },
  { key: "connection", title: "WhatsApp connection", codes: ["provider_not_ready", "credential_not_ready"] },
  { key: "setup", title: "Distribution and speed", codes: ["distribution_required", "distribution_invalid", "delivery_required"] },
]

/** The server's blockers grouped for display; unknown codes land in "setup" so nothing is hidden. */
export function groupBlockers(blockers: ReadonlyArray<Pick<PreflightIssue, "code">>): Map<CheckGroupKey, number> {
  const counts = new Map<CheckGroupKey, number>(CHECK_GROUPS.map((group) => [group.key, 0]))
  for (const issue of blockers) {
    const group = CHECK_GROUPS.find((candidate) => candidate.codes.includes(issue.code))?.key ?? "setup"
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  return counts
}

export function blockersIn<T extends Pick<PreflightIssue, "code">>(blockers: ReadonlyArray<T>, key: CheckGroupKey): T[] {
  const group = CHECK_GROUPS.find((candidate) => candidate.key === key)!
  return blockers.filter((issue) => group.codes.includes(issue.code) || (key === "setup" && !CHECK_GROUPS.some((g) => g.codes.includes(issue.code))))
}

/** Launch is allowed only when the server says so and the campaign can still be launched. */
export function canLaunch(report: Pick<PreflightReport, "ready" | "status"> | undefined): boolean {
  return Boolean(report && report.ready && (report.status === "Draft" || report.status === "Ready"))
}

export function doNotContact(recipients: Pick<PreflightReport["recipients"], "suppressed" | "suppressedSinceImport">): number {
  return recipients.suppressed + recipients.suppressedSinceImport
}

/** "~42%" style projection label (always marked approximate). */
export function approxPercent(share: number): string {
  return `~${Math.round(share * 100)}%`
}

export function approxCount(count: number): string {
  return `~${count.toLocaleString("en-US")}`
}

/**
 * The schedule input (`YYYY-MM-DDTHH:mm`, the browser's local time) to an
 * ISO instant; null when empty/invalid or not in the future.
 */
export function scheduledInstant(local: string, now: Date = new Date()): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null
  const when = new Date(local)
  if (Number.isNaN(when.getTime()) || when.getTime() <= now.getTime()) return null
  return when
}

/** The launch request: send now (no time) or schedule (future instant + time zone). */
export function launchBody(intent: "now" | "schedule", local: string, timezone: string | undefined, now: Date = new Date()): CampaignActionInput {
  if (intent === "now") return { action: "launch" }
  const when = scheduledInstant(local, now)
  if (!when) throw new Error("Choose a time in the future")
  return { action: "launch", scheduledAt: when.toISOString(), ...(timezone ? { timezone } : {}) }
}

export function launchOutcomeMessage(outcome: string | undefined): string {
  switch (outcome) {
    case "launched": return "Your campaign is sending."
    case "resumed": return "Sending resumed from where it stopped."
    case "already_running": return "This campaign was already launched and is sending."
    case "scheduled": return "Your campaign is scheduled."
    case "already_scheduled": return "This campaign was already scheduled for that time."
    default: return "Launch requested."
  }
}
