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

// This suite exercises HTTP headers/rate limiting, not Clerk authentication.
// Supply syntactically valid, non-production test credentials before app.ts
// is dynamically imported so Clerk middleware can process anonymous requests.
process.env.CLERK_SECRET_KEY = "sk_test_wabista_http_hardening_only";
process.env.CLERK_PUBLISHABLE_KEY = "pk_test_Y2xlcmsudGVzdCQ=";

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

before(async () => {
  const { default: app } = await import("../src/app");
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
