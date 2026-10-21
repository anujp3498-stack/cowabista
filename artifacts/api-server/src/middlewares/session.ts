import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { isAPIError } from "better-auth/api";
import { auth, AUTH_CLIENT_IP_HEADER, SESSION_COOKIE_NAMES } from "../lib/auth";

// The only Better Auth endpoints this app uses (lib/auth-client.ts in the SPA: sign-in, sign-up, sign-out
// and the session read). Everything else under /api/auth answers 404 here, before Better Auth sees it: its
// rate limiter runs before its own routing and would store a row for every unknown path.
const AUTH_ENDPOINTS = new Set([
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-up/email",
  "POST /api/auth/sign-out",
  "GET /api/auth/get-session",
]);

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
  // req.is() is null without a body, false for a body of another type.
  if (req.is(["application/json", "application/x-www-form-urlencoded"]) === false) {
    res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Send the request body as application/json" });
    return;
  }
  next();
}

/** Before the Better Auth handler: its rate limiter and session records read the client address from here. */
export function authClientIp(req: Request, _res: Response, next: NextFunction): void {
  if (req.ip) req.headers[AUTH_CLIENT_IP_HEADER] = req.ip;
  else delete req.headers[AUTH_CLIENT_IP_HEADER];
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
