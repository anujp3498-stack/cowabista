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
  | "templateDraft"
  | "submission"

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
    discovered: { label: "Setup required", variant: "warning" },
    verification_code_sent: { label: "Code sent", variant: "info" },
    registration_required: { label: "Verified", variant: "info" },
    // Registered with Meta, but Wabista sending activation (V2-02C) has not
    // happened yet. Never labelled Connected.
    registered_transport_pending: { label: "Registered", variant: "info" },
    // Workspace credential activated for campaign transport (V2-02C).
    active: { label: "Active", variant: "success" },
    action_required: { label: "Action required", variant: "destructive" },
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
    "In appeal": { label: "In appeal", variant: "warning" },
    "Pending deletion": { label: "Pending deletion", variant: "destructive" },
    Deleted: { label: "Deleted at Meta", variant: "destructive" },
    "Limit exceeded": { label: "Limit exceeded", variant: "destructive" },
    // Previously synchronised but no longer returned by Meta (V2-03A).
    Removed: { label: "No longer at Meta", variant: "outline" },
    Unknown: { label: "Unknown status", variant: "outline" },
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
  // V2-03B authoring lifecycle of a draft. "submitted" means Meta accepted
  // the creation request; approval is a separate, Meta-owned status shown
  // with the `template` kind next to it.
  templateDraft: {
    draft: { label: "Draft", variant: "outline" },
    submitting: { label: "Submitting to Meta", variant: "info" },
    submitted: { label: "Submitted", variant: "success" },
    failed: { label: "Refused by Meta", variant: "destructive" },
    reconcile_required: { label: "Outcome unknown", variant: "warning" },
  },
  submission: {
    requested: { label: "In progress", variant: "info" },
    succeeded: { label: "Accepted by Meta", variant: "success" },
    failed: { label: "Refused", variant: "destructive" },
    uncertain: { label: "Unconfirmed", variant: "warning" },
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
