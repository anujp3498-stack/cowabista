import type { TemplateSubmissionAttempt } from "@workspace/db";
import type { DraftFieldError } from "./template-authoring";

// Error type shared by the draft, media and submission services. Carries
// the public error code and HTTP status; never a secret.

function serializeAttempt(attempt: TemplateSubmissionAttempt) {
  return {
    id: attempt.id,
    draftRevision: attempt.draftRevision,
    state: attempt.state,
    providerTemplateId: attempt.providerTemplateId ?? null,
    providerStatus: attempt.providerStatus ?? null,
    error: attempt.error ?? null,
    errorCode: attempt.errorCode ?? null,
    reconcileNote: attempt.reconcileNote ?? null,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt ?? null,
  };
}
export { serializeAttempt };

export type TemplateDraftErrorCode =
  | "invalid_draft" | "not_found" | "stale_revision" | "not_editable" | "name_conflict"
  | "attempt_in_progress" | "reconcile_required" | "waba_not_eligible" | "credential_inactive"
  | "provider_rejected" | "provider_unavailable" | "not_submitted"
  | "media_not_configured" | "media_invalid" | "media_unavailable";

export class TemplateDraftError extends Error {
  constructor(
    readonly code: TemplateDraftErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly fields: DraftFieldError[] = [],
    readonly attempt: TemplateSubmissionAttempt | null = null,
  ) {
    super(message);
    this.name = "TemplateDraftError";
  }
  toBody() {
    return {
      error: this.message,
      code: this.code,
      ...(this.fields.length ? { fields: this.fields } : {}),
      ...(this.attempt ? { attempt: serializeAttempt(this.attempt) } : {}),
    };
  }
}

