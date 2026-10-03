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

export type VerificationMethod = "SMS" | "VOICE";

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

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${MANUAL_GRAPH_API_VERSION}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Response;
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
        if (body) headers["Content-Type"] = "application/json";
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
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

  private get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, params, undefined, signal);
  }

  // Management-only POST. Bodies here carry a verification code or a
  // registration PIN for exactly one request; they are never logged and
  // never stored. There is deliberately no message-sending method on this
  // class: campaign transport binding is V2-02C.
  private post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.request<T>("POST", path, {}, body, signal);
  }

  // Meta answers management POSTs with {"success": true}. Anything else is
  // treated as failure so local state is never advanced on an ambiguous
  // response.
  private static assertSuccess(payload: unknown, action: string): void {
    const ok = payload && typeof payload === "object" && (payload as { success?: unknown }).success === true;
    if (!ok) {
      throw new ProviderRequestError(`WhatsApp provider did not confirm ${action}`, false, "ambiguous_success", 502);
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

  /** One phone number by provider id, same field list as discovery. */
  async getPhoneNumber(phoneNumberId: string, signal?: AbortSignal): Promise<MetaPhoneNumber> {
    const phone = await this.get<MetaPhoneNumber>(encodeURIComponent(phoneNumberId), { fields: PHONE_NUMBER_FIELDS }, signal);
    if (!phone?.id) throw new ProviderRequestError("Phone number response had no id", false, "bad_phone", 502);
    return phone;
  }

  /** Ask Meta to send an ownership verification code by SMS or voice call. */
  async requestVerificationCode(phoneNumberId: string, method: VerificationMethod, locale: string, signal?: AbortSignal): Promise<void> {
    const payload = await this.post<unknown>(`${encodeURIComponent(phoneNumberId)}/request_code`, { code_method: method, locale }, signal);
    ManualMetaClient.assertSuccess(payload, "sending the verification code");
  }

  /** Submit the code the person received. `code` stays a string: leading zeroes matter. */
  async verifyCode(phoneNumberId: string, code: string, signal?: AbortSignal): Promise<void> {
    const payload = await this.post<unknown>(`${encodeURIComponent(phoneNumberId)}/verify_code`, { code }, signal);
    ManualMetaClient.assertSuccess(payload, "the verification code");
  }

  /** Register the number for Cloud API with the person's 6-digit two-step PIN. */
  async registerPhone(phoneNumberId: string, pin: string, signal?: AbortSignal): Promise<void> {
    const payload = await this.post<unknown>(`${encodeURIComponent(phoneNumberId)}/register`, { messaging_product: "whatsapp", pin }, signal);
    ManualMetaClient.assertSuccess(payload, "registration");
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
