import pino from "pino";

// Structured-log hardening for thrown values.
//
// A database error can carry the values of the failed statement. Drizzle's
// DrizzleQueryError puts every bound parameter into its message ("Failed
// query: <sql>\nparams: <values>"), its stack (same first line) and its
// `params` array, and Postgres puts row values into `detail` ("Failing row
// contains (...)", "Key (col)=(value) ..."). For template media and
// template submission rows those values include the Resumable Upload
// session id (`upload:<opaque>?sig=<opaque>`) and the provider handle, which
// must never reach a log line. Pino's default `err` serializer copies all of
// that verbatim, and values logged as `error` or `reason` bypass it entirely.
//
// serializeLoggedError() is registered for `err`, `error` and `reason` on
// the process logger and as pino-http's `err` serializer, so every thrown
// value goes through the same scrubbing however it is logged. It keeps the
// diagnostics (type, message, stack, query text, error code/status, pg
// code/constraint/table/column) and removes only:
//   - Drizzle bound parameters (message, stack and `params`);
//   - Postgres row values in `detail`;
//   - values under credential / upload-reference keys (tokens, ciphertext,
//     IV, auth tag, session ids, handles, signatures);
//   - secret-shaped text anywhere: bearer/OAuth tokens, access_token=,
//     Meta access tokens, `upload:` session ids, `sig=` values and
//     Resumable Upload handles;
//   - for a request-body parse failure (body-parser / express.json), the
//     raw request text in `body` and the fragment of it V8 quotes in the
//     SyntaxError message and stack (e.g. a verification code or PIN).
// Ordinary identifiers (organization, campaign, draft, WABA, phone ids) are
// left as they are.

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

// Keys whose VALUE is a credential, an encrypted credential, or a provider
// upload reference, wherever they occur inside a logged thrown value.
const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|access_?token|token|secret|client_?secret|password|api_?key|ciphertext|token_?ciphertext|iv|token_?iv|auth_?tag|token_?auth_?tag|session_?id|provider_?session_?id|upload_?session_?id|handle|provider_?handle|header_?handle|sig|signature)$/i;

// Column names in a Postgres "Key (...)=(...)" detail whose values are secret
// (exact names, so ordinary ids such as import_session_id are kept).
const SENSITIVE_COLUMN = /^(session_id|provider_session_id|upload_session_id|handle|provider_handle|header_handle|token|access_token|ciphertext|token_ciphertext|iv|token_iv|auth_tag|token_auth_tag|payload|sig|signature|secret|password)$/i;

// A run of characters that can belong to an opaque token, id or signature.
const OPAQUE_TOKEN = /[^\s"'`,;<>(){}[\]]+/g;
const FAILING_ROW = "Failing row contains (";

// Every rule is linear in the text length: logged text can be large and is
// partly user-influenced, so no rule may backtrack quadratically.
const TEXT_RULES: Array<(text: string) => string> = [
  // Drizzle bound parameters, when the message reaches us flattened (for
  // example copied into a plain object): everything after "\nparams: " up to
  // the first stack frame, the next "caused by:" stack or the end.
  (text) => text.replace(/(\nparams: )(?!\[\d+ params redacted\])[\s\S]*?(?=\n {4}at |\ncaused by: |$)/g, "$1[params redacted]"),
  // Postgres row dump: everything from the first "Failing row contains (" to the last ")".
  (text) => {
    const start = text.indexOf(FAILING_ROW);
    if (start < 0) return text;
    const end = text.lastIndexOf(")");
    const head = text.slice(0, start + FAILING_ROW.length);
    return end >= start + FAILING_ROW.length ? `${head}${REDACTED})${text.slice(end + 1)}` : `${head}${REDACTED}`;
  },
  (text) => text.replace(/\b(Bearer)\s+[^\s"',;]+/gi, "$1 [REDACTED]"),
  (text) => text.replace(/\b(OAuth)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [REDACTED]"),
  (text) => text.replace(/(access[_-]?token["']?\s*[=:]\s*["']?)[^\s"',;&)}\]]+/gi, "$1[REDACTED]"),
  (text) => text.replace(/\bEAA[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]"),
  (text) => text.replace(/\bupload:[^\s"'`,;<>(){}[\]]+/g, "upload:[REDACTED]"),
  (text) => text.replace(/(\b(?:sig|signature)=)[^\s"',;&)}\]]+/gi, "$1[REDACTED]"),
  // Resumable Upload handles ("<n>:<b64>:...:e:<epoch>:..." or "<n>::..."):
  // any opaque token that carries the ":e:<epoch>:" marker after a "<digit>:".
  (text) => text.includes(":e:")
    ? text.replace(OPAQUE_TOKEN, (token) => (/:e:\d+:/.test(token) && /\d::?[^:]/.test(token) ? "[REDACTED_HANDLE]" : token))
    : text,
  // A serialized template payload: the header_handle array up to its "]"
  // (to the end of the text when it was truncated before the "]").
  (text) => {
    const opener = /"header_handle"\s*:\s*\[/g;
    let out = "";
    let last = 0;
    for (let match = opener.exec(text); match; match = opener.exec(text)) {
      const close = text.indexOf("]", opener.lastIndex);
      out += `${text.slice(last, match.index)}${match[0]}"${REDACTED}"]`;
      if (close < 0) return out;
      last = close + 1;
      opener.lastIndex = last;
    }
    return last === 0 ? text : out + text.slice(last);
  },
];

/** Scrubs secret-shaped substrings from free text (messages, stacks, details). */
export function redactLogText(text: string): string {
  return TEXT_RULES.reduce((out, rule) => rule(out), text);
}

function redactPgDetail(detail: string): string {
  const keyed = detail.replace(/^(Key \()([^)]*)(\)=\()([\s\S]*)(\)[^)]*)$/, (whole, open: string, columns: string, eq: string, _values: string, tail: string) =>
    columns.split(",").some((column) => SENSITIVE_COLUMN.test(column.trim().replace(/^"|"$/g, ""))) ? `${open}${columns}${eq}${REDACTED}${tail}` : whole);
  return redactLogText(keyed);
}

type ErrorLike = { message: string; [key: string]: unknown };

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string";
}

/** Output of pino's std err serializer (pino-http hands that to us); the original error is on `raw`. */
function isStdSerialized(value: unknown): value is ErrorLike & { type: string; raw: unknown } {
  return isErrorLike(value) && typeof value.type === "string" && "raw" in value && !Object.prototype.hasOwnProperty.call(value, "raw");
}

/** Drizzle query errors in the cause chain, with the exact message text to replace. */
function drizzleMessages(error: unknown): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const visited = new Set<unknown>();
  let current = error;
  while (isErrorLike(current) && !visited.has(current)) {
    visited.add(current);
    const { query, params } = current as { query?: unknown; params?: unknown };
    if (typeof query === "string" && Array.isArray(params)) {
      found.push([current.message, `Failed query: ${query}\nparams: [${params.length} params redacted]`]);
    }
    current = current.cause;
  }
  return found;
}

const CAUSE_FIELDS = ["code", "constraint", "table", "column", "schema", "severity", "routine"] as const;
const CAUSE_TEXT_FIELDS = ["hint", "where"] as const;

/** Allow-listed diagnostics of a cause (e.g. the pg error under a Drizzle error); its row values are scrubbed. */
function causeSummary(cause: unknown): Record<string, unknown> | undefined {
  if (!isErrorLike(cause)) return undefined;
  const summary: Record<string, unknown> = { type: (cause as { constructor?: { name?: string } }).constructor?.name ?? (cause.name as string | undefined) };
  for (const field of CAUSE_FIELDS) {
    const value = cause[field];
    if (typeof value === "string" || typeof value === "number") summary[field] = value;
  }
  if (typeof cause.detail === "string") summary.detail = redactPgDetail(cause.detail);
  for (const field of CAUSE_TEXT_FIELDS) {
    const value = cause[field];
    if (typeof value === "string") summary[field] = redactLogText(value);
  }
  return summary;
}

function sanitizeField(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === undefined) return undefined;
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (key === "params" && Array.isArray(value)) return `[${value.length} params redacted]`;
  if (key === "detail" && typeof value === "string") return redactPgDetail(value);
  return sanitize(value, depth + 1, seen);
}

// body-parser's own error types for a body it read but could not parse
// (urlencoded failures keep the inner type: too many parameters, too deep).
const BODY_PARSER_TYPES = new Set(["parameters.too.many", "querystring.parse.rangeError"]);

/**
 * A request-body parse failure from body-parser (express.json / urlencoded):
 * it carries the raw request text as its own `body` property and has a
 * body-parser `type` ("entity.parse.failed", "entity.verify.failed",
 * "parameters.too.many", ...) or is a SyntaxError with status 400. Ordinary
 * errors or objects with a `body` are not matched.
 */
function isRequestParseError(error: unknown): error is ErrorLike & { body: unknown } {
  if (!isErrorLike(error) || !Object.prototype.hasOwnProperty.call(error, "body")) return false;
  const { type, status, statusCode } = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  return (typeof type === "string" && (type.startsWith("entity.") || BODY_PARSER_TYPES.has(type)))
    || (error instanceof SyntaxError && (status === 400 || statusCode === 400));
}

/** The parse failure's message without the request text V8 quotes in it; V8's trailing position is kept. */
function requestParseMessage(error: ErrorLike): string {
  const position = / JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(error.message);
  const where = position ? `; at position ${position[1]}${position[2] ? ` (line ${position[2]} column ${position[3]})` : ""}` : "";
  return `Request body could not be parsed (content redacted)${where}`;
}

/**
 * The parse failure's stack, rebuilt as "<type>: <safe message>" plus the
 * trailing run of genuine frame lines. It is never derived by replacing the
 * message: body-parser rebuilds the stack with String.replace, so "$" patterns
 * in V8's message (e.g. an unexpected "$" token) can leave request text in
 * the stack that no longer matches the message. Real frames come last and
 * never contain a double quote; the quoted request fragment always does.
 */
function requestParseStack(type: string, message: string, stack: unknown): string {
  const lines = typeof stack === "string" ? stack.split("\n") : [];
  let first = lines.length;
  while (first > 0 && /^ {4}at [^"]*$/.test(lines[first - 1]!)) first -= 1;
  return [`${type}: ${message}`, ...lines.slice(first)].join("\n");
}

function redactedBody(body: unknown): string {
  const size = typeof body === "string" ? `${body.length} chars` : ArrayBuffer.isView(body) ? `${body.byteLength} bytes` : "value";
  return `[request body redacted: ${size}]`;
}

function sanitizeError(error: ErrorLike, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const raw = isStdSerialized(error) ? error.raw : error;
  const base = (isStdSerialized(error) ? error : pino.stdSerializers.err(error as unknown as Error)) as unknown as Record<string, unknown>;
  const replacements = drizzleMessages(raw);
  const parseError = isRequestParseError(raw);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (parseError && key === "body") { out.body = redactedBody(value); continue; }
    if (parseError && key === "message") { out.message = requestParseMessage(raw); continue; }
    if (parseError && key === "stack") { out.stack = requestParseStack(typeof base.type === "string" ? base.type : "Error", requestParseMessage(raw), value); continue; }
    let field: unknown = value;
    if (typeof value === "string") field = replacements.reduce((text, [from, to]) => text.split(from).join(to), value);
    const safe = sanitizeField(key, field, depth, seen);
    if (safe !== undefined) out[key] = safe;
  }
  const cause = causeSummary((raw as { cause?: unknown } | null)?.cause);
  if (cause && out.cause === undefined) out.cause = cause;
  // pino's `type` is the error class, which hides body-parser's own `type`.
  const parseType = parseError ? raw.type : undefined;
  if (typeof parseType === "string") out.parseType = parseType;
  return out;
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (value === null || typeof value !== "object") return value;
  // `seen` holds the current ancestors only: a real cycle is cut, a value
  // shared by two fields is written twice (as JSON.stringify would).
  if (seen.has(value)) return "[Circular]";
  if (depth > MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (value instanceof Error || isStdSerialized(value)) return sanitizeError(value as ErrorLike, depth, seen);
    if (value instanceof Date) return value;
    if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
    if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1, seen));
    // What JSON.stringify would have written (e.g. a URL's href), scrubbed.
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") return sanitize((value as { toJSON(): unknown }).toJSON(), depth + 1, seen);
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const safe = sanitizeField(key, field, depth, seen);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * An error's own message with Drizzle bound parameters and secret-shaped
 * text removed: what pino writes as `msg` when a call passes no message.
 */
export function scrubbedErrorMessage(error: { message: string }): string {
  if (isRequestParseError(error)) return requestParseMessage(error);
  return redactLogText(drizzleMessages(error).reduce((message, [from, to]) => message.split(from).join(to), error.message));
}

/** Pino serializer for any thrown value: Error instances, pino-serialized errors, plain objects and strings. */
export function serializeLoggedError(value: unknown): unknown {
  return sanitize(value, 0, new WeakSet());
}

/** The keys thrown values are logged under in this codebase. */
export const errorLogSerializers = {
  err: serializeLoggedError,
  error: serializeLoggedError,
  reason: serializeLoggedError,
};
