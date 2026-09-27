import type { CampaignStatus } from "@workspace/api-client-react"
import { statusVariant, type StatusVariant } from "@/lib/status"

// Plan/execute gating rules used by every screen that lets a manager act on
// a campaign's lifecycle. Keep these in sync with the backend's own gating
// in campaign-engine.ts -- the server is authoritative and will 409 with
// readiness details if the UI ever falls out of sync.
//
// The badge variant now comes from the shared status foundation in
// `lib/status.ts` (single source of label + colour for every state).
export function campaignStatusVariant(status: CampaignStatus): StatusVariant {
  return statusVariant("campaign", status)
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
