import type { TemplateDraft } from "@workspace/api-client-react"

// Template submission: what a non-2xx answer to "Submit to Meta" means.
//
// The submit endpoint answers a settled attempt with the UPDATED draft even
// when the attempt did not succeed: 409 + the draft in state `failed` (Meta
// refused it) and 502 + the draft in state `reconcile_required` (Meta did not
// confirm the outcome). The API client throws on any non-2xx but keeps the
// parsed body in `error.data`, so the editor must recognise that body as a
// draft (and adopt it) instead of treating it as a TemplateDraftError, which
// left only "HTTP 409 Conflict" / "HTTP 502 Bad Gateway" on screen.
// TemplateDraftError bodies ({ error, code, ... }) are not drafts and keep
// their existing handling.

export type SubmitBanner = { title: string; description?: string; variant: "default" | "destructive" }

const DRAFT_STATES: readonly string[] = ["draft", "submitting", "submitted", "failed", "reconcile_required"] satisfies readonly TemplateDraft["state"][]

/** True for a TemplateDraft body; false for a TemplateDraftError ({ code }) or anything else. */
export function isTemplateDraftBody(value: unknown): value is TemplateDraft {
  if (!value || typeof value !== "object" || "code" in value) return false
  const draft = value as Record<string, unknown>
  return typeof draft.id === "number" && typeof draft.revision === "number" && typeof draft.name === "string"
    && typeof draft.state === "string" && DRAFT_STATES.includes(draft.state)
    && typeof draft.content === "object" && draft.content !== null
}

/** The fresh draft a failed submit answered with, or null when the body is not a draft. */
export function submitFailureDraft(error: unknown): TemplateDraft | null {
  const data = (error as { data?: unknown } | null)?.data
  return isTemplateDraftBody(data) ? data : null
}

// lastError is Wabista's own wording of the outcome (it may say Meta never answered), so it is labelled neutrally.
function withLastError(text: string, lastError: string | null): string {
  const reason = lastError?.trim()
  return reason ? `${text} Details: ${reason}` : text
}

/** What to tell the user about the draft the server returned for an unsuccessful submit. */
export function submitOutcomeBanner(draft: TemplateDraft): SubmitBanner {
  const lastError = draft.lastError?.trim() || null
  switch (draft.state) {
    case "failed":
      // A failed attempt is not always Meta's refusal (e.g. the credential was
      // found inactive before any request): the stored reason says which.
      return lastError
        ? { title: "The template was not submitted", description: lastError, variant: "destructive" }
        : { title: "Meta did not accept the template", description: "Meta refused the submission. Review the draft, then submit it again.", variant: "destructive" }
    case "reconcile_required":
      return {
        title: "Meta did not confirm the submission",
        description: withLastError("Meta did not confirm whether the template was created, so it is not resubmitted automatically. The draft stays locked until Meta confirms the outcome; check it from the Drafts list.", lastError),
        variant: "destructive",
      }
    case "submitting":
      return {
        title: "Submission already in progress",
        description: "This draft is already being submitted to Meta. Wait for Meta's answer; it cannot be submitted again meanwhile.",
        variant: "default",
      }
    case "submitted":
      return { title: "Already submitted to Meta", description: "Its status is shown as Meta reports it.", variant: "default" }
    default:
      return { title: "Couldn't submit the draft", description: lastError ?? "Review the draft and try again.", variant: "destructive" }
  }
}
