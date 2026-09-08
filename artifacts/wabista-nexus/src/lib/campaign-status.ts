import type { CampaignStatus } from "@workspace/api-client-react"

// Shared status→badge-variant mapping and plan/execute gating rules, used by
// every screen that lets a manager act on a campaign's lifecycle (Campaigns
// page, Rocket Engine screen). Keep these in sync with the backend's own
// gating in campaign-engine.ts -- the server is authoritative and will 409
// with readiness details if the UI ever falls out of sync, but duplicating
// the same rule in two places (UI polish only) is a common source of drift.
export function campaignStatusVariant(status: CampaignStatus): string {
  switch (status) {
    case "Running":
      return "success"
    case "Completed":
      return "secondary"
    case "Draft":
      return "outline"
    case "Ready":
      return "default"
    case "Scheduled":
      return "info"
    case "Paused":
      return "warning"
    case "Cancelled":
    case "Failed":
      return "destructive"
    default:
      return "default"
  }
}

export function canPlanCampaign(status: CampaignStatus): boolean {
  return status === "Draft" || status === "Ready"
}

export function canExecuteCampaign(status: CampaignStatus): boolean {
  return status === "Ready" || status === "Scheduled"
}

export function canPauseCampaign(status: CampaignStatus): boolean {
  return status === "Running"
}

export function canResumeCampaign(status: CampaignStatus): boolean {
  return status === "Paused"
}

export function canCancelCampaign(status: CampaignStatus): boolean {
  return status === "Draft" || status === "Ready" || status === "Scheduled" || status === "Running" || status === "Paused"
}
