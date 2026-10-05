// V2-06B preflight issue catalogue: the ONE list of stable issue codes the
// structured preflight, the Delivery step and (V2-06C) Review & Launch show.
// Each code has a fixed severity and business-facing copy; engineering text
// (the exact readiness strings Plan reports) only ever travels as
// `technicalDetail`. Provider error text is never primary copy.

export type PreflightSeverity = "blocker" | "warning";

export const PREFLIGHT_ISSUE_CODES = [
  "audience_empty",
  "import_in_progress",
  "distribution_required",
  "distribution_invalid",
  "delivery_required",
  "no_senders",
  "sender_unusable",
  "credential_not_ready",
  "provider_not_ready",
  "sender_rate_unavailable",
  "sender_without_template",
  "sender_configuration_stale",
  "no_templates",
  "template_unusable",
  "template_without_sender",
  "pair_incompatible",
  "selection_not_runnable",
  "mapping_missing",
  "mapping_invalid",
  "csv_column_missing",
  "media_missing",
  "media_wrong_kind",
  "media_transport_unsupported",
  "advanced_rate_missing",
  "advanced_rate_invalid",
  "rate_above_ceiling",
  "rate_invalid",
  "invalid_rows_skipped",
  "duplicates_skipped",
  "suppressed_skipped",
  "sender_quality_low",
] as const;
export type PreflightIssueCode = (typeof PREFLIGHT_ISSUE_CODES)[number];

export type IssueContext = {
  phone?: string;
  template?: string;
  column?: string;
  kind?: string;
  expectedKind?: string;
  max?: number;
  count?: number;
};

export type PreflightIssueSubject = { phoneNumberId?: number; templateId?: number; mediaAssetId?: number; column?: string; routeId?: number };

export type PreflightIssue = {
  code: PreflightIssueCode;
  severity: PreflightSeverity;
  message: string;
  action: string;
  subject: PreflightIssueSubject;
  technicalDetail: string | null;
};

type Entry = { severity: PreflightSeverity; message: (c: IssueContext) => string; action: (c: IssueContext) => string };

const number = (c: IssueContext) => c.phone ?? "A selected number";
const template = (c: IssueContext) => c.template ?? "A selected template";
const plural = (count: number | undefined, one: string, many: string) => (count === 1 ? one : many);

export const PREFLIGHT_CATALOGUE: Record<PreflightIssueCode, Entry> = {
  audience_empty: { severity: "blocker", message: () => "There are no valid recipients in the audience.", action: () => "Upload an audience with at least one valid phone number." },
  import_in_progress: { severity: "blocker", message: () => "An audience upload is still being processed.", action: () => "Wait for the upload to finish." },
  distribution_required: { severity: "blocker", message: () => "Choose how recipients are shared between your numbers and templates.", action: () => "Choose a distribution in the Delivery step." },
  distribution_invalid: { severity: "blocker", message: () => "The saved distribution is not supported.", action: () => "Choose a distribution in the Delivery step." },
  delivery_required: { severity: "blocker", message: () => "Choose a sending speed.", action: () => "Choose a speed in the Delivery step." },
  no_senders: { severity: "blocker", message: () => "No sending number is selected.", action: () => "Choose at least one number in the Message step." },
  sender_unusable: { severity: "blocker", message: (c) => `${number(c)} cannot send right now.`, action: () => "Reconnect the number in Numbers, or remove it in the Message step." },
  credential_not_ready: { severity: "blocker", message: (c) => `${number(c)}'s WhatsApp connection is not active.`, action: () => "Reconnect the number's WhatsApp account in Numbers." },
  provider_not_ready: { severity: "blocker", message: (c) => `${number(c)} is not covered by this workspace's WhatsApp connection.`, action: () => "Finish connecting WhatsApp for this business account." },
  sender_rate_unavailable: { severity: "blocker", message: (c) => `${number(c)} has no approved sending speed yet.`, action: () => "Sync the number in Numbers, then try again." },
  sender_without_template: { severity: "blocker", message: (c) => `${number(c)} cannot send any of the selected templates.`, action: () => "Select a template this number can send, or remove the number." },
  sender_configuration_stale: { severity: "blocker", message: () => "The sending setup changed since it was saved.", action: () => "Open the Message step and save it again." },
  no_templates: { severity: "blocker", message: () => "No template is selected.", action: () => "Choose at least one template in the Message step." },
  template_unusable: { severity: "blocker", message: (c) => `${template(c)} cannot be sent right now.`, action: () => "Choose a template that is approved at WhatsApp." },
  template_without_sender: { severity: "blocker", message: (c) => `No selected number can send ${c.template ?? "a selected template"}.`, action: () => "Add a number from the same business account, or remove the template." },
  pair_incompatible: { severity: "blocker", message: (c) => `${number(c)} cannot send ${c.template ?? "its template"}.`, action: () => "Choose a number and template from the same business account." },
  selection_not_runnable: { severity: "blocker", message: () => "The selected numbers and templates cannot be combined as saved.", action: () => "Choose a distribution in the Delivery step, or adjust the Message step." },
  mapping_missing: { severity: "blocker", message: (c) => `${template(c)} has a value that is not filled in.`, action: () => "Fill in every variable in the Message step." },
  mapping_invalid: { severity: "blocker", message: (c) => `${template(c)} has a value that cannot be used.`, action: () => "Fix the template's values in the Message step." },
  csv_column_missing: { severity: "blocker", message: (c) => `The column "${c.column ?? ""}" is not available for every recipient.`, action: () => "Re-upload the audience with this column, or make the value optional with a fallback." },
  media_missing: { severity: "blocker", message: (c) => `The header file for ${c.template ?? "a template"} is no longer available.`, action: () => "Choose another file in the Message step." },
  media_wrong_kind: { severity: "blocker", message: (c) => `${template(c)} needs ${c.expectedKind ? `a ${c.expectedKind}` : "another kind of"} header, but its file is ${c.kind ? `a ${c.kind}` : "different"}.`, action: () => "Choose a matching file in the Message step." },
  media_transport_unsupported: { severity: "blocker", message: (c) => `${number(c)} cannot send uploaded files with its current connection.`, action: () => "Connect the number with its own WhatsApp credential, or remove the file." },
  advanced_rate_missing: { severity: "blocker", message: (c) => `Set a speed for ${c.phone ?? "every selected number"}.`, action: () => "Enter a speed for every number in Advanced." },
  advanced_rate_invalid: { severity: "blocker", message: (c) => (c.phone ? `The speed set for ${c.phone} is not valid.` : "A speed setting is not valid."), action: () => "Enter a whole number of messages per second for each selected number." },
  rate_above_ceiling: { severity: "blocker", message: (c) => `${number(c)} can send at most ${c.max ?? "its approved"} messages/sec.`, action: (c) => (c.max ? `Set its speed to ${c.max} messages/sec or less.` : "Lower its speed.") },
  rate_invalid: { severity: "blocker", message: (c) => `The speed of ${c.phone ?? "a number"} is not valid.`, action: () => "Choose a speed in the Delivery step." },
  invalid_rows_skipped: { severity: "warning", message: (c) => `${c.count} ${plural(c.count, "row of the audience is", "rows of the audience are")} invalid and will be skipped.`, action: () => "Review them in the Audience step if needed." },
  duplicates_skipped: { severity: "warning", message: (c) => `${c.count} duplicate ${plural(c.count, "row", "rows")} will be sent only once.`, action: () => "No action needed." },
  suppressed_skipped: { severity: "warning", message: (c) => `${c.count} ${plural(c.count, "recipient has", "recipients have")} opted out and will not receive this campaign.`, action: () => "No action needed." },
  sender_quality_low: { severity: "warning", message: (c) => `${number(c)} has a low quality rating at WhatsApp.`, action: () => "Consider a slower speed or another number." },
};

export function makeIssue(code: PreflightIssueCode, context: IssueContext = {}, subject: PreflightIssueSubject = {}, technicalDetail: string | null = null): PreflightIssue {
  const entry = PREFLIGHT_CATALOGUE[code];
  return { code, severity: entry.severity, message: entry.message(context), action: entry.action(context), subject, technicalDetail };
}
