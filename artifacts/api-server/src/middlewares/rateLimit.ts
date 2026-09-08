import type { Request } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { getAuth } from "@clerk/express";

// Paths (relative to the /api mount point) that must never be throttled by
// the general limiter:
//   - /healthz: polled frequently by uptime/monitoring and the workflow
//     supervisor; throttling it would turn a healthy server into a false
//     "down" signal.
//   - /webhooks/whatsapp: Meta, not an end user, calls this. It already has
//     its own protection (a verify token on GET, an HMAC signature check on
//     POST), and a large campaign can generate a burst of delivery-status
//     webhooks that has nothing to do with normal per-user request volume --
//     counting it against a shared IP-based bucket would risk dropping real
//     delivery/read/failure events during exactly the high-volume moments
//     this app is built to handle.
const EXEMPT_PATHS = new Set(["/healthz", "/webhooks/whatsapp"]);

// Overridable only for tests, so a regression test can drive the limiter to
// 429 in a handful of requests instead of hundreds; production always gets
// the real 600/min default since this env var is never set outside tests.
const DEFAULT_LIMIT_PER_MINUTE = 600;
const configuredLimit = Number(process.env.API_RATE_LIMIT_MAX_PER_MINUTE);
const limitPerMinute = Number.isFinite(configuredLimit) && configuredLimit > 0
  ? configuredLimit
  : DEFAULT_LIMIT_PER_MINUTE;

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Generous on purpose: the Rocket Engine screen polls a running/paused
  // campaign's monitoring + readiness endpoints every 4-5s, contact import
  // polls every 1.2s while a session is open, and a manager can have
  // several browser tabs open at once. 600/min per key comfortably covers
  // real usage while still bounding a single client's request rate.
  limit: limitPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => EXEMPT_PATHS.has(req.path),
  // Behind Replit's proxy, every unauthenticated caller can otherwise look
  // like the same IP, so prefer the authenticated Clerk user as the bucket
  // key -- one heavy tenant then never throttles another. Only requests
  // Clerk couldn't identify (not yet signed in) fall back to per-IP
  // bucketing, via the IPv6-safe helper so a single client can't dodge the
  // limit by rotating within its own /64.
  keyGenerator: (req: Request): string => {
    const auth = getAuth(req);
    if (auth?.userId) return `user:${auth.userId}`;
    return ipKeyGenerator(req.ip ?? "unknown");
  },
  message: { error: "Too many requests, please slow down and try again shortly." },
});
