import { classifyProviderError, ProviderRequestError, redactProviderText, type MetaPhoneNumber, type MetaTemplate } from "./whatsapp-provider";

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
export const MAX_TEMPLATE_PAGES = 200;

function isMetaTemplateRow(row: unknown): row is MetaTemplate {
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.name !== "string" || !record.name || typeof record.language !== "string" || !record.language) return false;
  if (record.status !== undefined && typeof record.status !== "string") return false;
  if (record.category !== undefined && typeof record.category !== "string") return false;
  if (record.components !== undefined && !Array.isArray(record.components)) return false;
  return true;
}
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

  /**
   * Every message template under a WABA, following Graph pagination to the
   * last page. Same field list the legacy connector client requests, so the
   * stored component snapshot is identical whichever path synchronised it.
   * A failure on any page rejects the whole listing: callers must never
   * act on a partial set.
   */
  async listTemplates(wabaId: string, signal?: AbortSignal): Promise<MetaTemplate[]> {
    return this.listTemplatesPaged(wabaId, {}, signal);
  }

  /**
   * Complete, bounded, fail-closed listing shared by the full sync and the
   * name-filtered reconciliation lookup: every page is followed, a missing
   * or repeated cursor, the page cap, or a malformed row refuses the whole
   * listing instead of returning a partial one.
   */
  private async listTemplatesPaged(wabaId: string, filter: Record<string, string>, signal?: AbortSignal): Promise<MetaTemplate[]> {
    const out: MetaTemplate[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    const incomplete = (reason: string) =>
      new ProviderRequestError(`WhatsApp provider template listing is incomplete: ${reason}`, true, "incomplete_listing", 502);
    for (let page = 0; page < MAX_TEMPLATE_PAGES; page += 1) {
      const params: Record<string, string> = { ...filter, fields: "id,name,language,category,status,components", limit: "100" };
      if (after) params.after = after;
      const body = await this.get<{ data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown } }>(
        `${encodeURIComponent(wabaId)}/message_templates`,
        params,
        signal,
      );
      if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
        throw new ProviderRequestError("WhatsApp provider returned an unexpected template listing", true, "bad_listing", 502);
      }
      for (const row of body.data) {
        if (!isMetaTemplateRow(row)) {
          throw new ProviderRequestError("WhatsApp provider returned a malformed template row", true, "bad_listing", 502);
        }
        out.push(row);
      }
      const next = body.paging?.next;
      if (next === undefined || next === null || next === "") return out;
      // A next link without a usable cursor, or a cursor we have already
      // followed, can never reach the end of the listing: refuse rather than
      // present a partial set as the complete provider snapshot.
      const cursor = body.paging?.cursors?.after;
      if (typeof cursor !== "string" || cursor.length === 0) throw incomplete("next page has no cursor");
      if (seenCursors.has(cursor) || cursor === after) throw incomplete("pagination cursor repeated");
      seenCursors.add(cursor);
      after = cursor;
    }
    throw incomplete(`more than ${MAX_TEMPLATE_PAGES} pages`);
  }

  // ---- V2-03B template authoring (management only; still no send) ----

  /**
   * Creates a message template. Meta answers `{ id, status, category }` on
   * success; anything else is treated as an unconfirmed outcome so the
   * caller never records a creation it cannot prove. Meta documents no
   * idempotency key for this call, so callers must claim their attempt
   * durably before invoking it.
   */
  async createTemplate(wabaId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ id: string; status?: string; category?: string }> {
    const reply = await this.post<{ id?: unknown; status?: unknown; category?: unknown }>(`${encodeURIComponent(wabaId)}/message_templates`, payload, signal);
    if (!reply || typeof reply !== "object" || typeof reply.id !== "string" || !reply.id) {
      throw new ProviderRequestError("WhatsApp provider did not confirm template creation", true, "ambiguous_success", 502);
    }
    return {
      id: reply.id,
      status: typeof reply.status === "string" ? reply.status : undefined,
      category: typeof reply.category === "string" ? reply.category : undefined,
    };
  }

  /** One template by provider id. */
  async getTemplate(templateId: string, signal?: AbortSignal): Promise<MetaTemplate> {
    const template = await this.get<MetaTemplate>(encodeURIComponent(templateId), { fields: "id,name,language,category,status,components" }, signal);
    if (!template?.id) throw new ProviderRequestError("Template response had no id", false, "bad_template", 502);
    return template;
  }

  /**
   * Templates of a WABA filtered by name (the `name` filter is documented
   * on the message_templates edge; whether Meta treats it as exact or
   * prefix is not verified, so callers compare the name again). Uses the
   * same complete, bounded, fail-closed pagination as the full listing.
   */
  async findTemplatesByName(wabaId: string, name: string, signal?: AbortSignal): Promise<MetaTemplate[]> {
    return this.listTemplatesPaged(wabaId, { name }, signal);
  }

  /**
   * Resumable Upload API, step 1: open an upload session on the Meta app.
   * Parameters go in the query string as documented; the token stays in
   * the header.
   */
  async createUploadSession(appId: string, file: { byteLength: number; contentType: string; fileName: string }, signal?: AbortSignal): Promise<string> {
    const reply = await this.request<{ id?: unknown }>("POST", `${encodeURIComponent(appId)}/uploads`, {
      file_length: String(file.byteLength),
      file_type: file.contentType,
      file_name: file.fileName,
    }, undefined, signal);
    if (!reply || typeof reply.id !== "string" || !reply.id) {
      throw new ProviderRequestError("WhatsApp provider did not open an upload session", true, "bad_upload_session", 502);
    }
    return reply.id;
  }

  /**
   * Resumable Upload API, step 2: send the bytes. This call is documented
   * with `Authorization: OAuth <token>` and a `file_offset` header and a raw
   * binary body; the reply carries the file handle `h` that a template
   * header example references.
   */
  async uploadFile(sessionId: string, bytes: Uint8Array, fileOffset: number, signal?: AbortSignal): Promise<string> {
    const url = `${this.baseUrl}/${MANUAL_GRAPH_API_VERSION}/${encodeURIComponent(sessionId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 60_000));
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `OAuth ${this.token}`, file_offset: String(fileOffset), "Content-Type": "application/octet-stream" },
          body: bytes,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new ProviderRequestError("WhatsApp provider upload timed out", true, "timeout", 504);
        throw new ProviderRequestError(this.scrub(error instanceof Error ? error.message : "Network error"), true, "network");
      }
      let payload: unknown = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        const classified = classifyProviderError(response.status, payload);
        throw new ProviderRequestError(this.scrub(classified.message), classified.retryable, classified.code, classified.status);
      }
      const handle = (payload as { h?: unknown } | null)?.h;
      if (typeof handle !== "string" || !handle) throw new ProviderRequestError("WhatsApp provider returned no upload handle", true, "bad_upload", 502);
      return handle;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
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
