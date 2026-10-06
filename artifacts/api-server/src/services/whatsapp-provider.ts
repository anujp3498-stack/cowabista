import { createHash } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";

export type ProviderMode = "mock" | "real";

export interface MetaPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  // Meta's own provider-approved throughput tier for this number: "STANDARD"
  // (80 messages/sec, the default for every number) or "HIGH" (1,000
  // messages/sec, automatically granted by Meta once a number meets their
  // eligibility criteria). This is the only trustworthy source for "what
  // throughput has the provider actually approved" -- see
  // https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput
  throughput?: { level?: string };
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  category?: string;
  status?: string;
  components?: Record<string, unknown>[];
}

type MetaPage<T> = { data?: T[]; paging?: { next?: string; cursors?: { after?: string } } };

/** Shape every template row must have before it is trusted (shared by the connector and workspace-credential clients). */
export function isMetaTemplateRow(row: unknown): row is MetaTemplate {
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.name !== "string" || !record.name || typeof record.language !== "string" || !record.language) return false;
  if (record.status !== undefined && typeof record.status !== "string") return false;
  if (record.category !== undefined && typeof record.category !== "string") return false;
  if (record.components !== undefined && !Array.isArray(record.components)) return false;
  return true;
}

/** Hard cap on pages per listing; a listing that needs more is refused as incomplete. */
export const MAX_PROVIDER_PAGES = 200;

/**
 * Complete, validated, bounded, fail-closed page walk shared by provider
 * clients. `fetchPage` receives a path (never an absolute URL) and must
 * return the decoded JSON body of one page.
 *
 * Termination follows Meta's own SDK (facebook-python-business-sdk,
 * facebook_business/api.py, Cursor.load_next_page): continuation exists
 * only when `paging.next` is present; `paging.cursors.after` can still be
 * present on the LAST page and does not by itself mean more pages. So:
 *   - `next` omitted, null or "" (after present or not)  -> terminal page;
 *   - `next` a non-empty string                          -> continuation,
 *     which REQUIRES a usable `cursors.after`; the walk continues with
 *     that cursor on the original trusted request path (own fields/limit,
 *     the next URL is never copied into a request or an error message);
 *   - `next` present but not a string                    -> malformed
 *     continuation metadata, refuses the listing.
 * Every page must carry an array `data` whose rows satisfy `isRow` before
 * anything is returned; an empty `data` with a continuation is not
 * terminal. A repeated continuation state refuses the listing. At most
 * MAX_PROVIDER_PAGES pages are fetched: a terminal page exactly at the cap
 * succeeds, a page at the cap that still advertises a continuation fails.
 */
export async function collectValidatedPages<T>(
  fetchPage: (path: string, signal?: AbortSignal) => Promise<unknown>,
  initialPath: string,
  isRow: (row: unknown) => row is T,
  signal?: AbortSignal,
): Promise<T[]> {
  const rows: T[] = [];
  const seenPaths = new Set<string>([initialPath]);
  const incomplete = (reason: string) => new ProviderRequestError(`WhatsApp provider listing is incomplete: ${reason}`, true, "incomplete_listing", 502);
  let path = initialPath;
  for (let page = 1; ; page += 1) {
    if (signal?.aborted) throw signal.reason ?? new ProviderRequestError("Provider request aborted", true, "aborted");
    const body = await fetchPage(path, signal);
    if (!body || typeof body !== "object" || !Array.isArray((body as MetaPage<unknown>).data)) {
      throw new ProviderRequestError("WhatsApp provider returned a listing page without a data array", true, "bad_listing", 502);
    }
    const typed = body as MetaPage<unknown>;
    const paging = typed.paging;
    if (paging !== undefined && (paging === null || typeof paging !== "object")) throw incomplete("paging metadata is malformed");
    for (const row of typed.data!) {
      if (!isRow(row)) throw new ProviderRequestError("WhatsApp provider returned a malformed listing row", true, "bad_listing", 502);
      rows.push(row);
    }
    const next = (paging as MetaPage<unknown>["paging"])?.next;
    if (next === undefined || next === null || next === "") return rows;
    if (typeof next !== "string") throw incomplete("next page link is malformed");
    if (page >= MAX_PROVIDER_PAGES) throw incomplete(`more than ${MAX_PROVIDER_PAGES} pages`);
    const after = (paging as MetaPage<unknown>["paging"])?.cursors?.after;
    if (typeof after !== "string" || !after) throw incomplete("next page has no cursor");
    const separator = initialPath.includes("?") ? "&" : "?";
    const nextPath = `${initialPath}${separator}after=${encodeURIComponent(after)}`;
    if (seenPaths.has(nextPath)) throw incomplete("pagination state repeated");
    seenPaths.add(nextPath);
    path = nextPath;
  }
}

export class ProviderRequestError extends Error {
  readonly providerRetryable = true;
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
export function isRetryableProviderError(error: unknown): error is ProviderRequestError {
  return error instanceof ProviderRequestError && error.providerRetryable && error.retryable;
}

/**
 * A message send whose provider outcome is UNKNOWN: the request may have
 * reached Meta and been accepted (HTTP 5xx, a 2xx without a message id, a
 * connection lost after the request could have been written). Meta
 * documents no idempotency key for POST /{phone-number-id}/messages, so a
 * resend could deliver the message twice. Deliberately NOT a
 * ProviderRequestError: settlement records it as `delivery_unknown` and the
 * job is never re-sent, exactly like a timeout or an in-flight abort.
 */
export class ProviderOutcomeUnknownError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderOutcomeUnknownError";
  }
}

// Failures that happen while ESTABLISHING the connection (DNS, connect,
// TLS certificate verification): the HTTP request cannot have been written
// yet, so the provider never saw it. Anything else (reset, socket closed,
// header/body timeout, unknown) may follow a written request and is
// treated as an unknown outcome.
const PRE_CONNECT_ERROR_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL",
  "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** True only when every underlying cause is a connection-establishment failure. */
export function isPreConnectFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (Array.isArray(errors) && errors.length) return errors.every((inner) => isPreConnectFailure(inner, depth + 1));
  if (typeof code === "string" && PRE_CONNECT_ERROR_CODES.has(code)) return true;
  return cause !== undefined && isPreConnectFailure(cause, depth + 1);
}

export function redactProviderText(value: unknown): string {
  const text = typeof value === "string" ? value : "Provider request failed";
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/access[_ -]?token[\"'=:\s]+[^,\s}\"']+/gi, "access_token=[REDACTED]")
    .slice(0, 500);
}

// Meta's own throttling error codes, distinct from the generic transient
// codes above -- these are what a REAL Cloud API send actually returns when
// a phone number is rate-limited, not something a fixed local TPS cap can
// predict on its own (Meta can lower a number's throughput based on
// quality rating independent of what we have configured). Without these,
// a genuine rate-limit response from Meta was classified as non-retryable
// and the job failed permanently on the very first hit instead of backing
// off and retrying once the window clears.
// - 130429: per-number throughput/rate limit hit -- transient, back off.
// - 131056: per-recipient-pair rate limit hit -- transient, back off.
// 131048 (spam rate limit) is deliberately NOT included: Meta documents it
// as a quality-based sending restriction that does not clear on its own
// when a short backoff window passes, so retrying it would just burn
// through attempts; surfacing it as a permanent failure lets a campaign
// manager see the real reason (this repo's job/provider error-reason
// visibility work) and address number health instead.
const RETRYABLE_PROVIDER_CODES = ["1", "2", "4", "17", "341", "80007", "130429", "131056"];

export function classifyProviderError(status: number, payload: unknown): ProviderRequestError {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  const code = nested.code === undefined ? undefined : String(nested.code);
  const message = redactProviderText(nested.message ?? `WhatsApp provider returned HTTP ${status}`);
  const retryable = status === 408 || status === 429 || status >= 500 || RETRYABLE_PROVIDER_CODES.includes(code ?? "");
  return new ProviderRequestError(message, retryable, code, status);
}

export interface WhatsAppProviderClient {
  identity(signal?: AbortSignal): Promise<string>;
  health(signal?: AbortSignal): Promise<void>;
  listPhoneNumbers(wabaId: string, signal?: AbortSignal): Promise<MetaPhoneNumber[]>;
  listTemplates(wabaId: string, signal?: AbortSignal): Promise<MetaTemplate[]>;
  send(phoneId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

// Test-only hooks for the OS-process-crash-recovery test
// (campaign-worker-os-crash-recovery.test.ts). Both are no-ops unless their
// env var is explicitly set, so normal dev/mock behavior is untouched:
//  - CAMPAIGN_TEST_PROVIDER_DELAY_ONCE_MS: the FIRST send() call in this
//    process blocks for this many ms before "responding", giving a test a
//    wide, reliable window to SIGKILL the process while a real send is
//    genuinely in flight (not merely claimed) -- proving the crash lands
//    exactly where a live provider round-trip could leave delivery unknown.
//  - CAMPAIGN_TEST_PROVIDER_LOG: every send() that actually completes (i.e.
//    was never interrupted by a kill mid-delay) appends one line here. A
//    separate OS process (the test) can read this file to prove the
//    provider was never actually invoked more than once for the same
//    recipient/payload across a crash + restart, which an in-process mock
//    object could never observe once the original process is dead.
let testDelayConsumedOnce = false;
async function applyProviderTestHooks(phoneId: string, payload: Record<string, unknown>): Promise<void> {
  const delayMs = Number(process.env.CAMPAIGN_TEST_PROVIDER_DELAY_ONCE_MS ?? "");
  if (delayMs > 0 && !testDelayConsumedOnce) {
    testDelayConsumedOnce = true;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  const logPath = process.env.CAMPAIGN_TEST_PROVIDER_LOG;
  if (logPath) {
    const { appendFileSync } = await import("node:fs");
    const { threadId } = await import("node:worker_threads");
    appendFileSync(logPath, `${JSON.stringify({ phoneId, payload, at: Date.now(), pid: process.pid, threadId })}\n`);
  }
}

export class MockWhatsAppProviderClient implements WhatsAppProviderClient {
  async identity(): Promise<string> { return "mock-connector"; }
  async health(): Promise<void> {}
  async listPhoneNumbers(wabaId: string): Promise<MetaPhoneNumber[]> {
    return [{
      id: deterministicId("phone", wabaId),
      display_phone_number: "+15550000000",
      verified_name: "Wabista Mock",
      quality_rating: "GREEN",
      code_verification_status: "VERIFIED",
      throughput: { level: "STANDARD" },
    }];
  }
  async listTemplates(wabaId: string): Promise<MetaTemplate[]> {
    return [{
      id: deterministicId("template", wabaId),
      name: "wabista_mock",
      language: "en_US",
      category: "MARKETING",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hello {{1}}" }],
    }];
  }
  async send(phoneId: string, payload: Record<string, unknown>): Promise<string> {
    await applyProviderTestHooks(phoneId, payload);
    return deterministicId("wamid.mock", `${phoneId}:${JSON.stringify(payload)}`);
  }
}

export type ConnectorTransport = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Response>;

export class RealWhatsAppProviderClient implements WhatsAppProviderClient {
  private readonly connectors = new ReplitConnectors();
  private readonly transport: ConnectorTransport;

  /** `transport` is a test seam only: production always goes through the Replit connector proxy (credential source unchanged). */
  constructor(options: { transport?: ConnectorTransport } = {}) {
    this.transport = options.transport ?? ((path, init) => this.connectors.proxy("whatsapp-business", path, init));
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    if (options.signal?.aborted) throw options.signal.reason;
    const request = this.transport(path, {
      method: options.method,
      body: options.body,
      headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    });
    const response = options.signal ? await new Promise<Response>((resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error("Provider request aborted"));
      options.signal!.addEventListener("abort", abort, { once: true });
      request.then(resolve, reject).finally(() => options.signal!.removeEventListener("abort", abort));
    }) : await request;
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) throw classifyProviderError(response.status, payload);
    return payload as T;
  }

  async identity(signal?: AbortSignal): Promise<string> {
    const me = await this.request<{ id?: string }>("/v23.0/me?fields=id", { signal });
    if (!me.id) throw new ProviderRequestError("Connector identity is unavailable", false);
    return me.id;
  }
  async health(signal?: AbortSignal): Promise<void> {
    await this.identity(signal);
  }

  private async pages<T>(initialPath: string, signal?: AbortSignal): Promise<T[]> {
    const rows: T[] = [];
    let path: string | undefined = initialPath;
    while (path) {
      const page: MetaPage<T> = await this.request(path, { signal });
      rows.push(...(page.data ?? []));
      const next = page.paging?.next;
      if (next) {
        const parsed = new URL(next);
        path = `${parsed.pathname}${parsed.search}`;
      } else if (page.paging?.cursors?.after) {
        const separator = initialPath.includes("?") ? "&" : "?";
        path = `${initialPath}${separator}after=${encodeURIComponent(page.paging.cursors.after)}`;
      } else {
        path = undefined;
      }
    }
    return rows;
  }

  listPhoneNumbers(wabaId: string, signal?: AbortSignal): Promise<MetaPhoneNumber[]> {
    return this.pages(`/v23.0/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status&limit=100`, signal);
  }

  /**
   * Template listing through the connector, validated and complete (V2-04
   * correction): the legacy sync marks templates Meta no longer lists as
   * Removed and unsendable, so a malformed or partial listing must fail
   * the whole call rather than read as an empty or shorter snapshot.
   */
  listTemplates(wabaId: string, signal?: AbortSignal): Promise<MetaTemplate[]> {
    return collectValidatedPages(
      (path, pageSignal) => this.request<unknown>(path, { signal: pageSignal }),
      `/v23.0/${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,category,status,components&limit=100`,
      isMetaTemplateRow,
      signal,
    );
  }

  async send(phoneId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    let response: { messages?: { id?: string }[] };
    try {
      response = await this.request<{ messages?: { id?: string }[] }>(
        `/v23.0/${encodeURIComponent(phoneId)}/messages`,
        { method: "POST", body: payload, signal },
      );
    } catch (error) {
      // A 5xx does not prove the message was not accepted: never resend it.
      if (error instanceof ProviderRequestError && (error.status ?? 0) >= 500) {
        throw new ProviderOutcomeUnknownError(`WhatsApp provider outcome unknown (HTTP ${error.status}): ${error.message}`, error.status);
      }
      throw error;
    }
    const id = response.messages?.[0]?.id;
    if (typeof id !== "string" || !id) throw new ProviderOutcomeUnknownError("WhatsApp provider answered without a message identifier; the message may have been accepted");
    return id;
  }
}

export function providerClient(mode: ProviderMode): WhatsAppProviderClient {
  return mode === "real" ? new RealWhatsAppProviderClient() : new MockWhatsAppProviderClient();
}