// Structured-log hardening: a thrown database error must never write the
// provider upload session id (with its `sig`), the provider handle, a
// token or credential ciphertext to a log line, whether it is logged as
// `err`, `error` or `reason`, through the process logger or pino-http.
// Every secret below is an obviously fake sentinel; nothing leaves the
// process (the HTTP server is local and the logger writes to memory).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { DrizzleQueryError } from "drizzle-orm";
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { httpLogSerializers } from "../src/lib/http-logging";
import { redactLogText, serializeLoggedError } from "../src/lib/log-redaction";
import { loggerOptions } from "../src/lib/logger";
import { installCrashHandlers } from "../src/lib/process-crash-handlers";

const SESSION_OPAQUE = "FAKESESSIONSENTINEL4f2aOpaque";
const SIG = "FAKESIGSENTINEL9c1eSignature";
const SESSION_ID = `upload:${SESSION_OPAQUE}?sig=${SIG}`;
const HANDLE_SECRET = "FAKEHANDLESENTINEL7b3d";
const HANDLE = `4::aW1hZ2UvcG5n:${HANDLE_SECRET}:e:1700000000:123456:654321:FAKEHANDLESIGSENTINEL2e8f`;
// A handle in a shape no text rule recognises: only structural redaction can remove it.
const OPAQUE_HANDLE = "FAKEOPAQUEHANDLESENTINEL55aa";
const CIPHERTEXT = "FAKECIPHERTEXTSENTINELc0ffee==";
const TOKEN = "EAAFAKETOKENSENTINEL0123456789abcdef";
// Not Meta-shaped: only the Bearer / OAuth / access_token rules can remove these.
const BEARER_TOKEN = "FAKEBEARERSENTINELx9Q2longvalue";
const OAUTH_TOKEN = "FAKEOAUTHSENTINELk3W8longvalue";
const QUERY_TOKEN = "FAKEQUERYTOKENSENTINELp5Z1";
const SECRETS = [SESSION_OPAQUE, SIG, HANDLE_SECRET, "FAKEHANDLESIGSENTINEL2e8f", OPAQUE_HANDLE, CIPHERTEXT, TOKEN, BEARER_TOKEN, OAUTH_TOKEN, QUERY_TOKEN];

const SQL = 'insert into "template_media_uploads" ("organization_id", "waba_id", "provider_session_id", "provider_handle", "created_by") values ($1, $2, $3, $4, $5) returning *';

function pgCause() {
  return Object.assign(new Error('insert or update on table "template_media_uploads" violates foreign key constraint "template_media_uploads_created_by_users_id_fk"'), {
    name: "error", code: "23503", severity: "ERROR", table: "template_media_uploads", constraint: "template_media_uploads_created_by_users_id_fk", schema: "public",
    detail: 'Key (created_by)=(2147480000) is not present in table "users".',
  });
}

/** A real DrizzleQueryError: the secrets are in its message, its stack and its params. */
function drizzleError() {
  const error = new DrizzleQueryError(SQL, [7, 11, SESSION_ID, HANDLE, 2147480000, OPAQUE_HANDLE, CIPHERTEXT], pgCause());
  assert.ok(error.message.includes(SESSION_ID) && error.stack!.includes(SESSION_ID), "fixture: the secrets really are in message and stack");
  return error;
}

function memoryLogger(options = loggerOptions) {
  const lines: string[] = [];
  const logger = pino(options, { write: (chunk: string) => { lines.push(chunk); } });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, any>) };
}

function assertNoSecrets(text: string, label: string) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${label}: leaked ${secret}`);
}

function assertSafeDrizzleDiagnostics(err: Record<string, any>, label: string) {
  assert.match(err.type, /DrizzleQueryError$/, `${label}: type kept (a bundler may prefix the class name)`);
  assert.ok(err.message.startsWith(`Failed query: ${SQL}\nparams: [7 params redacted]`), `${label}: message keeps the SQL text: ${err.message}`);
  assert.match(err.message, /violates foreign key constraint/, `${label}: message keeps the database reason`);
  assert.match(err.stack, /^Error: Failed query: /, `${label}: stack keeps its first line`);
  assert.match(err.stack, /\n {4}at /, `${label}: stack keeps its frames`);
  assert.equal(err.params, "[7 params redacted]", label);
  assert.equal(err.query, SQL, label);
  assert.deepEqual(err.cause, { type: "Error", code: "23503", constraint: "template_media_uploads_created_by_users_id_fk", table: "template_media_uploads", schema: "public", severity: "ERROR", detail: 'Key (created_by)=(2147480000) is not present in table "users".' }, label);
}

test("baseline: without the hardening, pino writes the session id, signature and handle (the confirmed leak)", () => {
  const { logger, lines } = memoryLogger({ level: "info" });
  logger.error({ err: drizzleError() }, "uploading template media failed");
  assert.ok(lines[0]!.includes(SESSION_OPAQUE) && lines[0]!.includes(SIG) && lines[0]!.includes(HANDLE_SECRET));
});

test("a Drizzle error logged as `err`, `error` or `reason` writes no secret and keeps type, SQL text, reason, stack frames and the pg code", () => {
  for (const key of ["err", "error", "reason"] as const) {
    const { logger, lines, parsed } = memoryLogger();
    logger.error({ organizationId: 7, draftId: 11, wabaId: 3, [key]: drizzleError() }, "uploading template media failed");
    assertNoSecrets(lines[0]!, key);
    const [line] = parsed();
    assert.equal(line.organizationId, 7, `${key}: context kept`);
    assert.equal(line.draftId, 11);
    assert.equal(line.wabaId, 3);
    assert.equal(line.msg, "uploading template media failed");
    assert.equal(line.level, 50);
    assertSafeDrizzleDiagnostics(line[key], key);
  }
});

test("an Error passed as the first argument (pino's `err` slot) is scrubbed the same way", () => {
  const { logger, lines, parsed } = memoryLogger();
  logger.error(drizzleError(), "query failed");
  assertNoSecrets(lines[0]!, "first argument");
  assertSafeDrizzleDiagnostics(parsed()[0]!.err, "first argument");
});

test("with no message string pino would copy the raw error message into `msg`: that `msg` is scrubbed too", () => {
  const { logger, lines, parsed } = memoryLogger();
  logger.error(drizzleError());
  logger.error({ err: drizzleError() });
  logger.child({ organizationId: 7 }).error(drizzleError());
  logger.error({ organizationId: 7 }, "ordinary message");
  assert.equal(lines.length, 4);
  lines.forEach((line, index) => assertNoSecrets(line, `no message #${index}`));
  const [direct, keyed, child, ordinary] = parsed();
  for (const line of [direct, keyed, child]) {
    assert.equal(line.msg, `Failed query: ${SQL}\nparams: [7 params redacted]`, "msg is the error's own message, scrubbed");
    assertSafeDrizzleDiagnostics(line.err, "no message");
  }
  assert.equal(child.organizationId, 7);
  assert.equal(ordinary.msg, "ordinary message", "calls with a message are unchanged");
});

test("flattened copies are scrubbed too: {name, message, stack, cause} objects, {name, message} objects and bare message strings", () => {
  const source = drizzleError();
  const { logger, lines, parsed } = memoryLogger();
  logger.error({ error: { name: source.name, message: source.message, stack: source.stack, cause: source.cause } }, "Campaign runtime tick failed");
  logger.error({ error: { name: source.name, message: source.message } }, "could not be bound");
  logger.warn({ err: source.message }, "sync failed");
  logger.error({ reason: source.stack }, "Unhandled promise rejection; shutting down");
  lines.forEach((line, index) => assertNoSecrets(line, `flattened #${index}`));
  const [runtime, reservoir, text, reason] = parsed();
  assert.match(runtime.error.message, /^Failed query: insert into "template_media_uploads" .*\nparams: \[params redacted\]$/s);
  assert.match(runtime.error.stack, /\n {4}at /, "frames kept");
  assert.equal(runtime.error.cause.code, "23503", "a nested pg error keeps its code");
  assert.match(runtime.error.cause.detail, /^Key \(created_by\)=\(2147480000\) is not present in table "users"\.$/, "an id-only key detail is kept");
  assert.match(reservoir.error.message, /\nparams: \[params redacted\]$/);
  assert.match(text.err, /^Failed query: .*\nparams: \[params redacted\]$/s);
  assert.match(reason.reason, /^Error: Failed query: .*\nparams: \[params redacted\]\n {4}at /s);
});

test("credential and upload-reference keys are redacted wherever they occur inside a logged error; ordinary ids are kept", () => {
  const error = Object.assign(new Error("template submission failed"), {
    code: "invalid_draft", httpStatus: 409,
    attempt: {
      id: 41, organizationId: 7, draftId: 11, wabaId: 3, wabaExternalId: "waba-ext-123", credentialId: 5,
      payload: { name: "promo", components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: [OPAQUE_HANDLE] } }] },
    },
    upload: { providerSessionId: SESSION_ID, providerHandle: OPAQUE_HANDLE, provider_handle: OPAQUE_HANDLE },
    credential: { tokenCiphertext: CIPHERTEXT, tokenIv: "FAKEIVSENTINEL", tokenAuthTag: "FAKETAGSENTINEL", token_ciphertext: CIPHERTEXT, accessToken: TOKEN, keyVersion: 1 },
  });
  const { logger, lines, parsed } = memoryLogger();
  logger.error({ organizationId: 7, phoneNumberId: 9, err: error }, "failed");
  assertNoSecrets(lines[0]!, "keys");
  assert.ok(!lines[0]!.includes("FAKEIVSENTINEL") && !lines[0]!.includes("FAKETAGSENTINEL"));
  const { err } = parsed()[0]!;
  assert.equal(err.code, "invalid_draft");
  assert.equal(err.httpStatus, 409);
  assert.deepEqual({ ...err.attempt, payload: undefined }, { id: 41, organizationId: 7, draftId: 11, wabaId: 3, wabaExternalId: "waba-ext-123", credentialId: 5, payload: undefined });
  assert.deepEqual(err.attempt.payload.components[0].example, { header_handle: "[REDACTED]" });
  assert.equal(err.upload.providerSessionId, "[REDACTED]");
  assert.equal(err.credential.keyVersion, 1);
  assert.equal(parsed()[0]!.phoneNumberId, 9);
});

test("secret-shaped text is scrubbed; ordinary text, ids and timestamps are left alone", () => {
  const scrubbed = redactLogText([
    `Authorization: Bearer ${TOKEN}`, `OAuth ${TOKEN}`, `GET /v23.0/me?access_token=${TOKEN}&fields=id`, `token ${TOKEN}`,
    `Authorization: Bearer ${BEARER_TOKEN}`, `Authorization: OAuth ${OAUTH_TOKEN}`, `GET /v23.0/me?fields=id&access_token=${QUERY_TOKEN}`, `{"accessToken":"${QUERY_TOKEN}"}`,
    `step 2 url https://graph.facebook.com/v23.0/${SESSION_ID}`, `retry with sig=${SIG}`, `handle ${HANDLE}`,
    `{"header_handle":["${OPAQUE_HANDLE}"]}`, `Failing row contains (7, 11, ${OPAQUE_HANDLE}, ${CIPHERTEXT}).`,
  ].join("\n"));
  assertNoSecrets(scrubbed, "text");
  const ordinary = 'Invalid OAuth access token (OAuthException, code 190) for WABA 123456789012345 phone 987654321098765 at 2026-10-12T12:30:45.000Z; upload: timeout after 60000 ms; campaign 42 draft 7';
  assert.equal(redactLogText(ordinary), ordinary);
  assert.equal(serializeLoggedError("CSV import failed: missing phone column"), "CSV import failed: missing phone column");
  assert.equal(serializeLoggedError(42), 42);
  assert.equal(serializeLoggedError(null), null);
  const keyed = serializeLoggedError(Object.assign(new Error("dup"), { detail: `Key (provider_handle)=(${OPAQUE_HANDLE}) already exists.` })) as Record<string, string>;
  assert.equal(keyed.detail, "Key (provider_handle)=([REDACTED]) already exists.");
  const ids = serializeLoggedError(Object.assign(new Error("dup"), { detail: "Key (import_session_id, row_number)=(42, 7) already exists." })) as Record<string, string>;
  assert.equal(ids.detail, "Key (import_session_id, row_number)=(42, 7) already exists.", "ordinary ids in a key detail are kept");
});

test("non-secret structure is kept: shared references are written twice, toJSON is honoured, real cycles are cut", () => {
  const shared = { campaignId: 42 };
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;
  const out = serializeLoggedError(Object.assign(new Error("dependency failed"), {
    first: shared, second: shared, url: new URL(`https://storage.example.test/bucket/object?X-Goog-Signature=${SIG}`), cyclic,
  })) as Record<string, any>;
  assert.deepEqual(out.first, { campaignId: 42 });
  assert.deepEqual(out.second, { campaignId: 42 }, "a shared, non-circular value is not written as [Circular]");
  assert.equal(out.url, "https://storage.example.test/bucket/object?X-Goog-Signature=[REDACTED]", "URL keeps its href (toJSON), with the signature scrubbed");
  assert.deepEqual(out.cyclic, { name: "loop", self: "[Circular]" });
});

test("text scrubbing stays linear on large hostile input (a quadratic rule could stall the event loop while logging)", () => {
  const inputs = ["1:".repeat(100_000), "1:e:1:".repeat(40_000), "Failing row contains (".repeat(20_000), '"header_handle":['.repeat(20_000), "upload:".repeat(60_000), `x\nparams: ${"a,".repeat(500_000)}`];
  const started = performance.now();
  for (const input of inputs) redactLogText(input);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3000, `took ${Math.round(elapsed)} ms`);
  assertNoSecrets(redactLogText(`{"header_handle":["${OPAQUE_HANDLE}`), "truncated header_handle");
});

test("pino-http: req.log scrubs `err`, `error`, `reason` and the no-message form, the completion line too (res.err), and the request stays query-stripped with no headers", async () => {
  const { logger, lines, parsed } = memoryLogger();
  const httpLogger = pinoHttp({ logger, serializers: httpLogSerializers });
  const server: Server = createServer((req, res) => {
    httpLogger(req, res);
    req.log.error({ err: drizzleError(), organizationId: 7 }, "Unhandled request error");
    req.log.error({ error: drizzleError() }, "error key");
    req.log.error({ reason: drizzleError() }, "reason key");
    req.log.error(drizzleError());
    (res as unknown as { err: unknown }).err = drizzleError();
    res.statusCode = 500;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/x?access_token=${TOKEN}&sig=${SIG}`, { headers: { Authorization: `Bearer ${TOKEN}`, Cookie: `session=${CIPHERTEXT}` } });
    assert.equal(response.status, 500);
    await response.text();
    for (let i = 0; i < 50 && lines.length < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  assert.equal(lines.length, 5, lines.join(""));
  lines.forEach((line, index) => assertNoSecrets(line, `pino-http #${index}`));
  const [errLine, errorLine, reasonLine, noMessage, completion] = parsed();
  assertSafeDrizzleDiagnostics(errLine.err, "req.log err");
  assert.equal(errLine.organizationId, 7);
  assertSafeDrizzleDiagnostics(errorLine.error, "req.log error");
  assertSafeDrizzleDiagnostics(reasonLine.reason, "req.log reason");
  assertSafeDrizzleDiagnostics(noMessage.err, "req.log with no message");
  assert.equal(noMessage.msg, `Failed query: ${SQL}\nparams: [7 params redacted]`);
  for (const line of parsed()) {
    assert.deepEqual(Object.keys(line.req).sort(), ["id", "method", "url"], "request: id, method, url only (no headers)");
    assert.equal(line.req.url, "/api/x", "query-stripped URL");
  }
  assert.equal(completion.res.statusCode, 500);
  assert.equal(completion.msg, "request errored", "pino-http's completion line is unchanged");
  assertSafeDrizzleDiagnostics(completion.err, "completion line (res.err)");
});

test("the header redact paths are still in force", () => {
  const { logger, lines } = memoryLogger();
  logger.info({ req: { headers: { authorization: `Bearer ${TOKEN}`, cookie: `session=${CIPHERTEXT}` } }, res: { headers: { "set-cookie": `session=${CIPHERTEXT}` } } }, "headers");
  assertNoSecrets(lines[0]!, "headers");
  assert.match(lines[0]!, /"authorization":"\[Redacted\]"/);
});

test("crash handlers through the real logger configuration: `reason` and `error` are scrubbed", () => {
  const { logger, lines, parsed } = memoryLogger();
  const target = new EventEmitter();
  const crashes: string[] = [];
  installCrashHandlers(target as unknown as NodeJS.Process, { logger, onCrash: (signal) => crashes.push(signal) });
  target.emit("unhandledRejection", drizzleError());
  target.emit("uncaughtException", drizzleError());
  assert.deepEqual(crashes, ["unhandledRejection", "uncaughtException"]);
  lines.forEach((line, index) => assertNoSecrets(line, `crash #${index}`));
  const [rejection, exception] = parsed();
  assertSafeDrizzleDiagnostics(rejection.reason, "unhandledRejection");
  assertSafeDrizzleDiagnostics(exception.error, "uncaughtException");
});

// ------------------------------------------------ malformed request bodies
// body-parser attaches the raw request text to a JSON parse failure as
// `body`, and V8 quotes a fragment of it in the SyntaxError message (and so
// the stack). Fake sentinels only; the app is local.

const VERIFY_CODE = "FAKE_VERIFY_CODE_SENTINEL";
const REGISTRATION_PIN = "FAKE_REGISTRATION_PIN_SENTINEL";
// Any fragment V8 may quote from the bodies below contains one of these.
const BODY_FRAGMENTS = ["FAKE_", "VERIFY_CODE", "REGISTRATION_PIN", "_SENTINEL", "SENTINEL"];
const MALFORMED_BODIES = [
  `{"code": ${VERIFY_CODE}, "pin": "${REGISTRATION_PIN}"`,
  `{"pin":"${REGISTRATION_PIN}","code":${VERIFY_CODE}}`,
  `{"pin":"${REGISTRATION_PIN}","code":"${VERIFY_CODE}"}x`,
  // An unexpected "$" token: body-parser rebuilds the stack with String.replace,
  // so V8's "'$'" expands and the stack no longer contains the message.
  `{"code":$${VERIFY_CODE}}`,
  // Strict mode (a top-level string) with "$$" in the quoted fragment.
  `"${REGISTRATION_PIN}$$"`,
];

test("a malformed JSON body (real express.json) logged as `err`, `error`, `reason` or with no message never writes the raw body or the fragment V8 quotes; type, status, parse type, position, stack frames and request context remain", async () => {
  const { logger, lines, parsed } = memoryLogger();
  const app = express();
  app.use(express.json());
  app.post("/verification/verify", (_req, res) => { res.json({ ok: true }); });
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, method: req.method, path: req.path }, "Unhandled request error");
    logger.error({ error: err }, "error key");
    logger.error({ reason: err }, "reason key");
    logger.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    for (const body of MALFORMED_BODIES) {
      const response = await fetch(`http://127.0.0.1:${port}/verification/verify`, { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Internal server error" });
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  assert.equal(lines.length, MALFORMED_BODIES.length * 4);
  for (const line of lines) for (const fragment of BODY_FRAGMENTS) assert.ok(!line.includes(fragment), `leaked "${fragment}": ${line}`);
  const entries = parsed();
  for (let i = 0; i < MALFORMED_BODIES.length; i += 1) {
    const [withContext, errorKey, reasonKey, noMessage] = entries.slice(i * 4, i * 4 + 4);
    assert.equal(withContext.method, "POST", "request context kept");
    assert.equal(withContext.path, "/verification/verify");
    for (const [entry, key] of [[withContext, "err"], [errorKey, "error"], [reasonKey, "reason"], [noMessage, "err"]] as const) {
      const err = entry[key];
      assert.equal(err.type, "SyntaxError", key);
      assert.equal(err.parseType, "entity.parse.failed", key);
      assert.equal(err.status, 400);
      assert.equal(err.statusCode, 400);
      assert.equal(err.body, `[request body redacted: ${MALFORMED_BODIES[i]!.length} chars]`, "raw body replaced by a marker");
      assert.match(err.message, /^Request body could not be parsed \(content redacted\)/);
      assert.match(err.stack, /^SyntaxError: Request body could not be parsed \(content redacted\)/);
      assert.match(err.stack, /\n {4}at /, "stack frames kept");
    }
    assert.equal(noMessage.msg, noMessage.err.message, "the no-message form gets the scrubbed message as msg");
  }
  assert.match(entries[8]!.err.message, /; at position \d+ \(line 1 column \d+\)$/, "the parse position is kept when V8 reports one");
});

test("an ordinary error or object with a `body` field is not treated as a request-body parse failure", () => {
  const provider = serializeLoggedError(Object.assign(new Error("upstream answered 500"), { status: 500, body: { campaignId: 42, note: "kept" } })) as Record<string, any>;
  assert.deepEqual(provider.body, { campaignId: 42, note: "kept" });
  assert.equal(provider.message, "upstream answered 500");
  assert.equal(provider.parseType, undefined);
  assert.deepEqual(serializeLoggedError({ body: "kept text", campaignId: 42 }), { body: "kept text", campaignId: 42 });
  const syntax = serializeLoggedError(Object.assign(new SyntaxError("Unexpected token in template"), { body: "kept" })) as Record<string, any>;
  assert.equal(syntax.body, "kept", "a SyntaxError without status 400 or a body-parser type is left alone");
  assert.equal(syntax.message, "Unexpected token in template");
});

test("urlencoded parse failures (too many parameters, too deep) carry the raw form body too: redacted the same way", async () => {
  const { logger, lines, parsed } = memoryLogger();
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.post("/verification/verify", (_req, res) => { res.json({ ok: true }); });
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, method: req.method, path: req.path }, "Unhandled request error");
    res.status(500).json({ error: "Internal server error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const bodies = [
    `code=${VERIFY_CODE}&pin=${REGISTRATION_PIN}&${Array.from({ length: 1001 }, (_, i) => `p${i}=1`).join("&")}`,
    `pin=${REGISTRATION_PIN}&a${"[x]".repeat(40)}=1`,
  ];
  try {
    const { port } = server.address() as AddressInfo;
    for (const body of bodies) {
      const response = await fetch(`http://127.0.0.1:${port}/verification/verify`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      assert.equal(response.status, 500);
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  assert.equal(lines.length, 2);
  for (const line of lines) for (const fragment of BODY_FRAGMENTS) assert.ok(!line.includes(fragment), `leaked "${fragment}": ${line}`);
  const [tooMany, tooDeep] = parsed();
  assert.equal(tooMany.err.parseType, "parameters.too.many");
  assert.equal(tooMany.err.status, 413);
  assert.equal(tooDeep.err.parseType, "querystring.parse.rangeError");
  assert.equal(tooDeep.err.status, 400);
  for (const [entry, body] of [[tooMany, bodies[0]], [tooDeep, bodies[1]]] as const) {
    assert.equal(entry.err.body, `[request body redacted: ${body!.length} chars]`);
    assert.match(entry.err.message, /^Request body could not be parsed \(content redacted\)$/);
    assert.match(entry.err.stack, /\n {4}at /);
    assert.equal(entry.path, "/verification/verify");
  }
});

test("only V8's own trailing position is kept: position-like text inside the quoted fragment is not copied", () => {
  const error = Object.assign(new SyntaxError(`Unexpected token 'x', "at position 739104 ${VERIFY_CODE}"... is not valid JSON`), {
    expose: true, statusCode: 400, status: 400, body: `["at position 739104 ${VERIFY_CODE}" x]`, type: "entity.parse.failed",
  });
  const out = serializeLoggedError(error) as Record<string, string>;
  assert.equal(out.message, "Request body could not be parsed (content redacted)");
  assert.ok(!JSON.stringify(out).includes("739104") && !JSON.stringify(out).includes("FAKE_"), JSON.stringify(out));
  const positioned = serializeLoggedError(Object.assign(new SyntaxError("Unexpected non-whitespace character after JSON at position 40 (line 1 column 41)"), { status: 400, body: "{}x", type: "entity.parse.failed" })) as Record<string, string>;
  assert.equal(positioned.message, "Request body could not be parsed (content redacted); at position 40 (line 1 column 41)");
});

test("the request log never records an invitation token from the public invite preview URL", () => {
  const token = "3f2a9c1e-7b44-4d0e-9a51-2c6f0e8b7d10";
  assert.deepEqual(httpLogSerializers.req({ id: 1, method: "GET", url: `/api/invite-info/${token}?x=1` }), { id: 1, method: "GET", url: "/api/invite-info/[REDACTED]" });
  assert.equal(httpLogSerializers.req({ method: "GET", url: "/api/invitations" }).url, "/api/invitations");
});
