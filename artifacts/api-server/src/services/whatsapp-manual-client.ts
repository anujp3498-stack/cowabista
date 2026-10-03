import { classifyProviderError, ProviderRequestError, redactProviderText, type MetaPhoneNumber } from "./whatsapp-provider";

// Direct Meta Graph API client backed by a workspace-supplied access token.
//
// This is deliberately separate from RealWhatsAppProviderClient (which goes
// through the shared Replit connector) and is NOT used by the sending
// transport yet -- V2-02A only uses it to validate a token and discover the
// WABA + phone numbers it can see. Binding it into campaign sending is the
// V2-02C design in docs/IMPLEMENTATION_PLAN.md.
//
// Security properties:
//  - the token travels only in the Authorization header, never in the URL
//    or query string, so it cannot land in proxy/access logs;
//  - every request has a timeout and honours an external AbortSignal;
//  - error text from Meta is passed through redactProviderText and the token
//    is additionally scrubbed by value before any error leaves this module.

// Same Graph version the legacy connector client uses. Upgrading the Graph
// API version is explicitly out of scope for this milestone.
export const MANUAL_GRAPH_API_VERSION = "v23.0";
export const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const PHONE_NUMBER_FIELDS = "id,display_phone_number,verified_name,quality_rating,code_verification_status";

export interface MetaIdentity {
  id: string;
  name?: string;
}

export interface MetaWaba {
  id: string;
  name?: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ManualMetaClientOptions {
  accessToken: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export class ManualMetaClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ManualMetaClientOptions) {
    if (!options.accessToken || typeof options.accessToken !== "string") {
      throw new ProviderRequestError("Access token is required", false, "missing_token", 400);
    }
    this.token = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private scrub(text: string): string {
    // Belt and braces: even if Meta echoed the token back inside a message,
    // it never leaves this class.
    return redactProviderText(text).split(this.token).join("[REDACTED]");
  }

  private async get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const url = new URL(`${this.baseUrl}/${MANUAL_GRAPH_API_VERSION}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ProviderRequestError("WhatsApp provider request timed out", true, "timeout", 504);
        }
        throw new ProviderRequestError(this.scrub(error instanceof Error ? error.message : "Network error"), true, "network");
      }
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const classified = classifyProviderError(response.status, payload);
        throw new ProviderRequestError(this.scrub(classified.message), classified.retryable, classified.code, classified.status);
      }
      return payload as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Who the token belongs to (system user / app). Proves the token is live. */
  async identity(signal?: AbortSignal): Promise<MetaIdentity> {
    const me = await this.get<{ id?: string; name?: string }>("me", { fields: "id,name" }, signal);
    if (!me?.id) throw new ProviderRequestError("Token identity response had no id", false, "bad_identity", 502);
    return { id: String(me.id), name: me.name ? String(me.name) : undefined };
  }

  /** Reads one WABA. Fails with Meta's own error if the token cannot see it. */
  async getWaba(wabaId: string, signal?: AbortSignal): Promise<MetaWaba> {
    const waba = await this.get<{ id?: string; name?: string }>(encodeURIComponent(wabaId), { fields: "id,name" }, signal);
    if (!waba?.id) throw new ProviderRequestError("WABA response had no id", false, "bad_waba", 502);
    return { id: String(waba.id), name: waba.name ? String(waba.name) : undefined };
  }

  /** Phone numbers under a WABA, following Graph pagination. */
  async listPhoneNumbers(wabaId: string, signal?: AbortSignal): Promise<MetaPhoneNumber[]> {
    const out: MetaPhoneNumber[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const params: Record<string, string> = { fields: PHONE_NUMBER_FIELDS, limit: "100" };
      if (after) params.after = after;
      const body = await this.get<{ data?: MetaPhoneNumber[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        `${encodeURIComponent(wabaId)}/phone_numbers`,
        params,
        signal,
      );
      out.push(...(body?.data ?? []));
      if (!body?.paging?.next || !body.paging.cursors?.after) break;
      after = body.paging.cursors.after;
    }
    return out;
  }
}
