// Presentation-only status foundation.
//
// The backend enums are the source of truth and are NOT changed here. This
// module maps each raw value to a business-readable label and one of the
// Badge variants so every page shows the same wording and colour for the
// same state. Unknown values fall back to the raw text so nothing is hidden.
//
// Add new kinds/values here as later V2 milestones introduce them.

export type StatusVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info"

export type StatusKind =
  | "campaign"
  | "phoneNumber"
  | "phoneSetup"
  | "phoneQuality"
  | "template"
  | "contact"
  | "route"
  | "message"
  | "import"
  | "invitation"

export type StatusPresentation = {
  label: string
  variant: StatusVariant
}

const TABLES: Record<StatusKind, Record<string, StatusPresentation>> = {
  campaign: {
    Draft: { label: "Draft", variant: "outline" },
    Ready: { label: "Ready to launch", variant: "info" },
    Scheduled: { label: "Scheduled", variant: "info" },
    Running: { label: "Sending", variant: "success" },
    Paused: { label: "Paused", variant: "warning" },
    Completed: { label: "Completed", variant: "secondary" },
    Cancelled: { label: "Stopped", variant: "destructive" },
    Failed: { label: "Failed", variant: "destructive" },
  },
  phoneNumber: {
    Connected: { label: "Connected", variant: "success" },
    Pending: { label: "Setup incomplete", variant: "warning" },
    Flagged: { label: "Needs attention", variant: "destructive" },
  },
  // V2 onboarding progress for a number, separate from the engine-facing
  // `status`. "discovered" means found under the workspace's own credential
  // but not yet verified or registered for sending.
  phoneSetup: {
    unknown: { label: "Not set up", variant: "outline" },
    discovered: { label: "Discovered", variant: "info" },
  },
  phoneQuality: {
    High: { label: "Quality high", variant: "success" },
    Medium: { label: "Quality medium", variant: "warning" },
    Low: { label: "Quality low", variant: "destructive" },
  },
  template: {
    Approved: { label: "Approved", variant: "success" },
    Pending: { label: "Pending review", variant: "info" },
    Rejected: { label: "Rejected", variant: "destructive" },
    Paused: { label: "Paused by Meta", variant: "warning" },
    Disabled: { label: "Disabled", variant: "destructive" },
  },
  contact: {
    Active: { label: "Active", variant: "success" },
    Inactive: { label: "Inactive", variant: "secondary" },
    Unsubscribed: { label: "Unsubscribed", variant: "destructive" },
  },
  route: {
    Active: { label: "Sending", variant: "success" },
    Throttled: { label: "Rate-limited", variant: "warning" },
    Paused: { label: "Paused", variant: "warning" },
    Error: { label: "Problem", variant: "destructive" },
  },
  message: {
    Queued: { label: "Waiting", variant: "secondary" },
    Processing: { label: "Sending", variant: "info" },
    Throttled: { label: "Rate-limited", variant: "warning" },
    Sent: { label: "Sent", variant: "success" },
    Failed: { label: "Failed", variant: "destructive" },
    Cancelled: { label: "Cancelled", variant: "outline" },
  },
  import: {
    Processing: { label: "Importing", variant: "info" },
    Completed: { label: "Completed", variant: "success" },
    Failed: { label: "Failed", variant: "destructive" },
  },
  invitation: {
    Pending: { label: "Invited", variant: "info" },
    Accepted: { label: "Accepted", variant: "success" },
    Revoked: { label: "Revoked", variant: "outline" },
  },
}

export function statusPresentation(kind: StatusKind, value: string | null | undefined): StatusPresentation {
  if (!value) return { label: "Unknown", variant: "outline" }
  return TABLES[kind][value] ?? { label: value, variant: "outline" }
}

export function statusLabel(kind: StatusKind, value: string | null | undefined): string {
  return statusPresentation(kind, value).label
}

export function statusVariant(kind: StatusKind, value: string | null | undefined): StatusVariant {
  return statusPresentation(kind, value).variant
}
