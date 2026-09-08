import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import helmet from "helmet";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiRateLimiter } from "./middlewares/rateLimit";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

// `cors({ origin: true, credentials: true })` reflects whatever Origin
// header the caller sends while also allowing cookies -- that combination
// defeats CORS entirely (any site can make credentialed requests on a
// victim's behalf). Build an explicit allowlist instead: this deployment's
// own Replit domain(s) (REPLIT_DOMAINS covers custom-domain + default
// .replit.dev/.replit.app entries Replit assigns; REPLIT_DEV_DOMAIN covers
// the workspace preview domain), plus an optional operator-supplied
// CORS_ALLOWED_ORIGINS for any additional custom domain. Requests with no
// Origin header (server-to-server calls, curl, the webhook callers) are not
// subject to CORS and are always let through -- the browser is what enforces
// CORS, not this server, so an empty allowlist would only ever block
// legitimate browser callers, never a non-browser one.
const allowedOriginHosts = new Set(
  [
    ...(process.env.REPLIT_DOMAINS?.split(",") ?? []),
    process.env.REPLIT_DEV_DOMAIN,
    ...(process.env.CORS_ALLOWED_ORIGINS?.split(",") ?? []),
  ]
    .map((host) => host?.trim())
    .filter((host): host is string => Boolean(host)),
);

function corsOriginCheck(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) {
    callback(null, true);
    return;
  }
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    callback(null, false);
    return;
  }
  callback(null, allowedOriginHosts.has(host));
}

// Requests arrive through Replit's reverse proxy, so req.ip must be derived
// from the first X-Forwarded-For hop for per-client rate limiting (and any
// future IP-based logic) to see real client IPs instead of the proxy's.
// "1" (not "true") pins trust to exactly one hop, which avoids the
// "trust all hops" foot-gun express-rate-limit warns about.
app.set("trust proxy", 1);

// Security headers on every response. CSP is left off deliberately: this
// server never renders HTML for a browser to execute script in (it's a
// pure JSON API plus a couple of redirect/plain-text webhook endpoints),
// so a CSP tuned for an HTML app would add no protection here and risks
// being wrong for endpoints it was never designed to cover. The rest of
// Helmet's defaults (nosniff, no-sniff frame options, HSTS, referrer
// policy, disabled cross-domain policies, etc.) apply as-is.
app.use(
  helmet({
    contentSecurityPolicy: false,
    // Default is "same-origin", which would block the frontend (a
    // different origin/port) from loading any api-server response as a
    // subresource (e.g. an <img>/<a download> pointing at a future
    // file-serving endpoint). Nothing here needs that lockdown today, and
    // real access control is already enforced by auth + org scoping, not
    // by CORP.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Proxy must be mounted before body parsers — it streams raw bytes.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: corsOriginCheck }));
// Meta signatures cover the exact bytes, so this route must precede JSON parsing.
app.use("/api/webhooks/whatsapp", express.raw({ type: "application/json", limit: "2mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Resolve the publishable key from the incoming request host so the same
// server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Mounted after clerkMiddleware (not before) so the limiter can key
// authenticated requests by Clerk user id instead of just IP.
app.use("/api", apiRateLimiter, router);

// Centralized error handler. Every route so far handles its own expected
// failures inline (validation -> 400, not-found -> 404, etc.), so this is a
// safety net for the unexpected case: a thrown/rejected error that no route
// caught. Express 5 forwards a rejected async handler here automatically,
// so without this, that error would only ever get Express's bare-bones
// default handler -- no org/campaign context, no structured log entry, and
// (depending on NODE_ENV) a stack trace potentially reaching the client.
// Must be the last `app.use` — Express identifies error middleware by its
// 4-argument arity, and only calls it for handlers registered after the
// point an error was raised.
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    // Response already started streaming; Express's own default handler
    // is the only safe option left (it just closes the connection).
    next(err);
    return;
  }
  req.log.error(
    {
      err,
      organizationId: req.organizationId,
      method: req.method,
      path: req.path,
    },
    "Unhandled request error",
  );
  res.status(500).json({ error: "Internal server error" });
});

export default app;
