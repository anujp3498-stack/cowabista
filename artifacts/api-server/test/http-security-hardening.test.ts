// Production-hardening roadmap requirement: the HTTP layer itself needs
// baseline security headers and a request-rate ceiling, without breaking
// existing API behavior, health checks, or WhatsApp webhooks (which can
// legitimately burst far above normal per-user request volume once a
// campaign is large).
//
// The rate limit is driven down via API_RATE_LIMIT_MAX_PER_MINUTE (read by
// src/middlewares/rateLimit.ts only when set) so this test can trip it in a
// handful of requests instead of the real 600/min default -- production
// never sets that env var, so it always gets the real limit.
process.env.API_RATE_LIMIT_MAX_PER_MINUTE = "20";

// This suite exercises HTTP headers/rate limiting, not authentication.
// app.ts refuses to load without Better Auth settings, so give it a random
// throwaway secret before it is dynamically imported.
process.env.BETTER_AUTH_SECRET = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64");
process.env.BETTER_AUTH_URL = "http://localhost:24902";

// Keep this regression independent from operator webhook credentials.
// Reaching the GET handler in this state deterministically returns 503.
delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
delete process.env.META_APP_SECRET;

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pool, settlementPool } from "@workspace/db";

let baseUrl: string;
let server: Server | undefined;
let app: Awaited<typeof import("../src/app")>["default"];

before(async () => {
  ({ default: app } = await import("../src/app"));
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await Promise.all([
    pool.end(),
    settlementPool.end(),
  ]);
});

test("every response carries Helmet's baseline security headers, and no CSP tuned for an HTML app that doesn't exist here", async () => {
  const res = await fetch(`${baseUrl}/api/healthz`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("x-frame-options"), "X-Frame-Options must be set");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(res.headers.get("content-security-policy"), null);
});

test("a client that exceeds the per-minute request cap gets 429s, with rate-limit headers, until the identical exempt paths are still untouched", async () => {
  const probePath = `${baseUrl}/api/__rate-limit-hardening-probe`;
  const results: number[] = [];
  for (let i = 0; i < 25; i++) {
    const res = await fetch(probePath);
    results.push(res.status);
    if (i === 0) {
      assert.ok(res.headers.get("ratelimit-limit"), "standard RateLimit-* headers must be present");
    }
  }
  // First 20 (the configured test limit) reach the router and 404 (no such
  // route); anything past that must be rejected by the limiter itself.
  const allowed = results.filter((s) => s === 404).length;
  const limited = results.filter((s) => s === 429).length;
  assert.equal(allowed, 20, `expected exactly 20 requests to reach the router, got ${allowed} (statuses: ${results.join(",")})`);
  assert.equal(limited, 5, `expected the remaining 5 requests to be rate-limited, got ${limited} (statuses: ${results.join(",")})`);

  // The same client is now well past its cap -- healthz must still work
  // every time, because monitoring/uptime checks must never be able to
  // trip the general limiter.
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${baseUrl}/api/healthz`);
    assert.notEqual(res.status, 429, "GET /api/healthz must never be rate-limited");
  }
});

test("the WhatsApp webhook path is exempt from the general rate limiter even after the same client is already capped", async () => {
  // The previous test already pushed this client's bucket past its cap.
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${baseUrl}/api/webhooks/whatsapp`);
    assert.equal(
      res.status,
      503,
      "unconfigured WhatsApp webhook must reach its handler (503), never the general limiter (429)",
    );
  }
});

test("the app's own pino-http request logger scrubs provider secrets from `err`, `error` and `reason` (wiring in app.ts)", async () => {
  const { default: pino } = await import("pino");
  const { DrizzleQueryError } = await import("drizzle-orm");
  const { logger } = await import("../src/lib/logger");
  // pino-http exposes the request logger it built (with app.ts's serializers) on the middleware.
  const layer = (app.router as unknown as { stack: Array<{ handle?: { logger?: { error?: unknown } } }> }).stack
    .find((candidate) => typeof candidate.handle?.logger?.error === "function");
  assert.ok(layer, "pino-http is mounted on the app");
  const requestLogger = layer.handle!.logger as { error(obj: object, msg?: string): void };
  const secrets = ["FAKEAPPSESSIONSENTINEL", "FAKEAPPSIGSENTINEL", "FAKEAPPHANDLESENTINEL"];
  const error = () => new DrizzleQueryError('insert into "template_media_uploads" ("provider_session_id", "provider_handle") values ($1, $2)', [
    "upload:FAKEAPPSESSIONSENTINEL?sig=FAKEAPPSIGSENTINEL", "4::aW1hZ2UvcG5n:FAKEAPPHANDLESENTINEL:e:1700000000:1:2:x",
  ], undefined);
  const target = logger as unknown as Record<symbol, unknown>;
  const original = target[pino.symbols.streamSym];
  const lines: string[] = [];
  target[pino.symbols.streamSym] = { write: (chunk: string) => { lines.push(chunk); } };
  try {
    requestLogger.error({ err: error() }, "Unhandled request error");
    requestLogger.error({ error: error() }, "error key");
    requestLogger.error({ reason: error() }, "reason key");
  } finally { target[pino.symbols.streamSym] = original; }
  assert.equal(lines.length, 3);
  for (const line of lines) for (const secret of secrets) assert.ok(!line.includes(secret), `app request log leaked ${secret}: ${line}`);
  const [errLine, errorLine, reasonLine] = lines.map((line) => JSON.parse(line) as Record<string, { type: string; params: string }>);
  for (const [entry, key] of [[errLine, "err"], [errorLine, "error"], [reasonLine, "reason"]] as const) {
    assert.match(entry[key]!.type, /DrizzleQueryError$/, key);
    assert.equal(entry[key]!.params, "[2 params redacted]", key);
  }
});

test("malformed JSON through the real app: the raw body (fake verification code / PIN) never reaches a log line; diagnostics remain and the response contract is unchanged", async () => {
  const { default: pino } = await import("pino");
  const { logger } = await import("../src/lib/logger");
  // The second body's "$" token makes body-parser's String.replace rebuild a stack that no longer contains the message.
  const requests = [
    { route: "/api/organizations/1/whatsapp/numbers/1/verification/verify", body: '{"code": FAKE_VERIFY_CODE_SENTINEL, "pin": "FAKE_REGISTRATION_PIN_SENTINEL"' },
    { route: "/api/organizations/1/whatsapp/numbers/1/register", body: '{"pin":$FAKE_REGISTRATION_PIN_SENTINEL}' },
  ];
  const fragments = ["FAKE_", "VERIFY_CODE", "REGISTRATION_PIN", "SENTINEL"];
  const target = logger as unknown as Record<symbol, unknown>;
  const original = target[pino.symbols.streamSym];
  const lines: string[] = [];
  target[pino.symbols.streamSym] = { write: (chunk: string) => { lines.push(chunk); } };
  const responses: Array<{ status: number; body: unknown }> = [];
  try {
    for (const { route, body } of requests) {
      const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      responses.push({ status: response.status, body: await response.json() });
    }
    for (let i = 0; i < 50 && lines.length < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally { target[pino.symbols.streamSym] = original; }
  // The existing contract for an unparseable body: the central error handler's generic 500.
  assert.deepEqual(responses, [{ status: 500, body: { error: "Internal server error" } }, { status: 500, body: { error: "Internal server error" } }]);
  for (const line of lines) for (const fragment of fragments) assert.ok(!line.includes(fragment), `app log leaked "${fragment}": ${line}`);
  const entries = lines.map((line) => JSON.parse(line) as Record<string, any>);
  const failures = entries.filter((entry) => entry.msg === "Unhandled request error");
  assert.equal(failures.length, 2, lines.join(""));
  for (const [index, failure] of failures.entries()) {
    assert.equal(failure.method, "POST");
    assert.match(failure.path, /^\/api\/organizations\/1\/whatsapp\/numbers\/1\/(verification\/verify|register)$/, "method/path context kept");
    assert.match(failure.req.url, /^\/api\/organizations\/1\/whatsapp\/numbers\/1\//);
    assert.equal(failure.err.type, "SyntaxError");
    assert.equal(failure.err.parseType, "entity.parse.failed");
    assert.equal(failure.err.status, 400);
    assert.equal(failure.err.body, `[request body redacted: ${requests[index]!.body.length} chars]`);
    assert.match(failure.err.message, /^Request body could not be parsed \(content redacted\)/);
    assert.match(failure.err.stack, /\n {4}at /);
  }
  assert.equal(entries.filter((entry) => entry.res?.statusCode === 500).length, 2, "pino-http completion lines unchanged");
});
