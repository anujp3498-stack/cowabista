// Stable, user-facing Message Studio errors. `code` is part of the API
// contract (MessageStudioError in openapi.yaml); `message` never carries a
// token, provider handle or provider media id.
export type MessageStudioErrorCode =
  | "stale_revision" | "setup_locked" | "execution_history" | "import_in_progress" | "not_found"
  | "sender_unusable" | "template_unusable" | "invalid_mappings" | "media_kind_mismatch" | "media_unavailable"
  | "media_storage_unavailable" | "media_invalid" | "media_in_use" | "media_unsupported_transport" | "media_preparation_failed"
  | "delivery_invalid" | "distribution_invalid" | "message_setup_incomplete" | "preview_unavailable"
  | "not_selected" | "incompatible" | "credential_inactive" | "recipient_invalid" | "recipient_suppressed"
  | "mapping_unresolved" | "provider_rejected" | "provider_unavailable" | "delivery_unknown" | "name_conflict" | "invalid_preset";

export class MessageStudioError extends Error {
  constructor(
    readonly code: MessageStudioErrorCode,
    message: string,
    readonly status: number,
    readonly details?: string[],
  ) {
    super(message);
    this.name = "MessageStudioError";
  }

  toBody() {
    return { error: this.message, code: this.code, ...(this.details?.length ? { details: this.details } : {}) };
  }
}
