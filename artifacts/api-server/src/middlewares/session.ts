import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { isAPIError } from "better-auth/api";
import { auth, AUTH_CLIENT_IP_HEADER, SESSION_COOKIE_NAMES } from "../lib/auth";

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
