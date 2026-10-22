import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { isAPIError } from "better-auth/api";
import { auth, AUTH_BASE_URL, AUTH_CLIENT_IP_HEADER, AUTH_PUBLIC_SIGN_UP, SESSION_COOKIE_NAMES } from "../lib/auth";

// The only Better Auth endpoints this app uses (lib/auth-client.ts in the SPA: sign-in, sign-out, the session
// read, change-password, and sign-up only while public sign-up is open, never in production). Everything else
// under /api/auth answers 404 here, before Better Auth sees it: its rate limiter runs before its own routing
// and would store a row for every unknown path.
const AUTH_ENDPOINTS = new Set([
  "POST /api/auth/sign-in/email",
  ...(AUTH_PUBLIC_SIGN_UP ? ["POST /api/auth/sign-up/email"] : []),
  "POST /api/auth/sign-out",
  "GET /api/auth/get-session",
  "POST /api/auth/change-password",
]);

/** GET /api/auth-policy: what the signed-out SPA may offer (no sign-up link or form while sign-up is closed). */
export function authPolicy(_req: Request, res: Response): void {
  res.set("Cache-Control", "no-store").json({ publicSignUp: AUTH_PUBLIC_SIGN_UP });
}

/**
 * Before the Better Auth handler: only the endpoints above, and only request bodies the API's own parsers
 * consumed (JSON or form, bounded at 100 kb). Better Auth reads any other body itself, unbounded, and treats
 * every content type that merely starts like JSON (application/jsonx, application/vnd.x+json) as JSON.
 */
export function authRequestGuard(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_ENDPOINTS.has(`${req.method} ${req.path}`)) {
    res.status(404).json({ code: "NOT_FOUND", message: "Not found" });
    return;
  }
  // req.is() is null without a body, false for a body of another type; an empty body (Content-Length: 0,
  // e.g. a bare POST sign-out) is no body (Better Auth does not read one either).
  const emptyBody = req.headers["content-length"] === "0" && req.headers["transfer-encoding"] === undefined;
  if (!emptyBody && req.is(["application/json", "application/x-www-form-urlencoded"]) === false) {
    res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Send the request body as application/json" });
    return;
  }
  next();
}

/**
 * Immediately before the Better Auth handler. Its rate limiter and session records read the client address
 * from AUTH_CLIENT_IP_HEADER (Express req.ip, which honours TRUST_PROXY). Better Auth routes on a URL that
 * better-call builds from the Host and X-Forwarded-Proto headers plus req.url; a crafted Host (backslashes,
 * "?") would change the path it acts on after authRequestGuard checked req.path. The public origin is fixed
 * (BETTER_AUTH_URL), so both headers are pinned to it.
 */
export function authClientIp(req: Request, _res: Response, next: NextFunction): void {
  if (req.ip) req.headers[AUTH_CLIENT_IP_HEADER] = req.ip;
  else delete req.headers[AUTH_CLIENT_IP_HEADER];
  req.headers.host = AUTH_BASE_URL.host;
  req.headers["x-forwarded-proto"] = AUTH_BASE_URL.protocol.replace(/:$/, "");
  delete (req.headers as Record<string, unknown>)[":authority"];
  next();
}

/**
 * Resolves the Better Auth session cookie for every /api request (never rejects by itself; requireAuth does).
 * A session older than a day is extended and its new cookie forwarded; an expired or unknown one is cleared.
 * The session token itself is never copied onto the request. A database failure is an error (500), never a
 * silent sign-out.
 */
export async function resolveAuthSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  req.authSession = null;
  if (!SESSION_COOKIE_NAMES.some((name) => req.cookies?.[name])) {
    next();
    return;
  }
  try {
    const { headers, response } = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), returnHeaders: true });
    for (const cookie of headers.getSetCookie()) res.append("Set-Cookie", cookie);
    req.authSession = response
      ? {
        user: { id: response.user.id, email: response.user.email, name: response.user.name, emailVerified: response.user.emailVerified },
        session: { id: response.session.id, expiresAt: response.session.expiresAt },
      }
      : null;
    next();
  } catch (error) {
    if (isAPIError(error) && error.statusCode === 401) {
      next();
      return;
    }
    next(error);
  }
}
