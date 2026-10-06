import { classifyProviderError, isPreConnectFailure, ProviderOutcomeUnknownError, ProviderRequestError, redactProviderText } from "./whatsapp-provider";

// Worker-safe direct Meta Graph sender for workspace-credential transport.
//
// This module is imported by the transport shard worker, so it must stay
// free of PostgreSQL, Redis, Drizzle and the management client: only the
// shared provider error helpers. The token arrives in memory through the
// shard's credential-bind control message, is sent ONLY in the
// Authorization header, and is scrubbed by value from any error text.

export const DIRECT_GRAPH_API_VERSION = "v23.0";
const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";

export type DirectFetch = (input: string, init: RequestInit) => Promise<Response>;

// Tests point the worker at a local fake Graph server. Never honoured in
// production so a stray variable cannot redirect real sends.
export function directGraphBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CAMPAIGN_TEST_GRAPH_BASE_URL?.trim();
  if (override && env.NODE_ENV !== "production") return override.replace(/\/+$/, "");
  return DEFAULT_GRAPH_BASE_URL;
}

export async function sendDirectWhatsAppMessage(input: {
  accessToken: string;
  providerPhoneId: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  fetchImpl?: DirectFetch;
  baseUrl?: string;
}): Promise<string> {
  const { accessToken } = input;
  const scrub = (text: string) => redactProviderText(text).split(accessToken).join("[REDACTED]");
  const url = `${input.baseUrl ?? directGraphBaseUrl()}/${DIRECT_GRAPH_API_VERSION}/${encodeURIComponent(input.providerPhoneId)}/messages`;
  if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Send aborted");
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input.payload),
      signal: input.signal,
    });
  } catch (error) {
    // An abort (timeout or ownership loss) is NOT a provider error: the
    // request may already have reached Meta, so the caller's existing
    // delivery_unknown handling must apply.
    if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Send aborted");
    if (error instanceof Error && error.name === "AbortError") throw error;
    const detail = error instanceof Error ? error.message : "Network error";
    // Only a failure to ESTABLISH the connection (DNS, connect, TLS
    // certificate) proves the request was never written: retryable. A reset
    // or socket loss may follow a written request, so its outcome is unknown
    // and it is never re-sent (Meta /messages has no idempotency key).
    if (isPreConnectFailure(error)) throw new ProviderRequestError(scrub(detail), true, "network");
    throw new ProviderOutcomeUnknownError(scrub(`Connection to WhatsApp failed after the request may have been sent: ${detail}`));
  }
  const payload = await response.json().catch(() => ({})) as unknown;
  if (response.status >= 500) {
    // A 5xx does not prove Meta did not accept the message; outcome unknown.
    const classified = classifyProviderError(response.status, payload);
    throw new ProviderOutcomeUnknownError(scrub(`WhatsApp provider outcome unknown (HTTP ${response.status}): ${classified.message}`), response.status);
  }
  if (!response.ok) {
    const classified = classifyProviderError(response.status, payload);
    // Code 190 (invalid/expired token) is a credential problem for the
    // control plane to surface; it is permanent here and never a reason to
    // fall back to another transport.
    throw new ProviderRequestError(scrub(classified.message), classified.code === "190" ? false : classified.retryable, classified.code, classified.status);
  }
  const id = (payload as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id;
  // Accepted (2xx) but no usable id, or an unreadable body: the message may
  // have been accepted, so this is an unknown outcome, never a resend.
  if (typeof id !== "string" || !id) throw new ProviderOutcomeUnknownError("WhatsApp provider answered without a message identifier; the message may have been accepted", response.status);
  return id;
}
