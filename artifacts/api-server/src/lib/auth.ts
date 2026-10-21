import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { db } from "@workspace/db";
import { betterAuthSchema } from "@workspace/db/auth";
import { logger } from "./logger";
import { redactLogText } from "./log-redaction";
import { parseAuthEnv, type AuthEnv } from "./auth-config";
import { ACTIVE_ORG_COOKIE } from "../middlewares/auth";

// Better Auth (email and password, replacing Clerk). Served at /api/auth/* by app.ts; the session it issues is
// resolved for the rest of /api by middlewares/session.ts, and everything after that (local user,
// memberships, roles, the active-organization cookie) is unchanged in middlewares/auth.ts. Nothing else may
// import this module: routers and middlewares/auth.ts stay free of it so route-handler tests need no auth env.
// Importing it validates the environment (lib/auth-config.ts) and throws on a bad setting, so the server
// refuses to start. Creating the instance opens no database connection.

/** Express writes req.ip here (it already honours TRUST_PROXY); a client-sent value is always overwritten. */
export const AUTH_CLIENT_IP_HEADER = "x-wabista-client-ip";
/** `wabista` cookie prefix; `__Secure-` is added when BETTER_AUTH_URL is https. */
export const SESSION_COOKIE_NAMES = ["wabista.session_token", "__Secure-wabista.session_token"] as const;

// Every endpoint this app does not use: no social sign-in, no profile, email, password or session management
// from the browser, no account linking or token endpoints. Parameterised paths (/callback/:id,
// /reset-password/:token) cannot be listed; they are inert without social providers or a reset mailer.
const DISABLED_PATHS = [
  "/sign-in/social", "/update-user", "/change-email", "/change-password", "/delete-user", "/delete-user/callback",
  "/request-password-reset", "/reset-password", "/verify-password", "/verify-email", "/send-verification-email",
  "/update-session", "/list-sessions", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions",
  "/link-social", "/list-accounts", "/unlink-account", "/refresh-token", "/get-access-token", "/account-info", "/error",
];

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;

export function createAuth(config: AuthEnv) {
  const authLog = logger.child({ component: "better-auth" });
  return betterAuth({
    appName: "Wabista Nexus",
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    database: drizzleAdapter(db, { provider: "pg", schema: betterAuthSchema, transaction: true }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
      requireEmailVerification: false,
    },
    // 7-day sessions, extended on use once they are a day old; no cookie cache, so revocation is immediate.
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    trustedOrigins: config.trustedOrigins,
    // Shared across API processes through auth_rate_limits; Better Auth's own rules apply (sign-in and
    // sign-up: 3 per 10 s per client address). Session reads are not counted (polled by the SPA).
    rateLimit: { enabled: true, storage: "database", window: 10, max: 100, customRules: { "/get-session": false, "/ok": false } },
    advanced: {
      cookiePrefix: "wabista",
      useSecureCookies: config.secureCookies,
      // Explicit, so NODE_ENV=test or TEST can never switch the origin and CSRF checks off.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] },
      database: { validateSchema: true },
    },
    disabledPaths: DISABLED_PATHS,
    // An unexpected (non-API) error inside an endpoint is rethrown to Express, whose error handler logs it
    // through the redacting serializers and answers 500. Without this, Better Auth's router prints the raw
    // error with console.error, and a Drizzle error carries the query's bound values (a new session token,
    // a password hash). API errors (400/401/403/422/429) still become their normal responses.
    onAPIError: { throw: true },
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      // Only the message (redacted like any logged error text) and an Error (through the redacting
      // serializers) are kept; other arguments can carry request data and are dropped.
      log: (level, message, ...args) => {
        const err = args.find((arg) => arg instanceof Error);
        authLog[level](err ? { err } : {}, redactLogText(String(message)));
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const name = typeof user.name === "string" ? user.name.trim() : "";
            if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
              throw new APIError("BAD_REQUEST", { code: "INVALID_NAME", message: `Name must be 1 to ${MAX_NAME_LENGTH} characters` });
            }
            if (user.email.length > MAX_EMAIL_LENGTH) throw new APIError("BAD_REQUEST", { code: "INVALID_EMAIL", message: "Invalid email" });
            // A client-supplied image URL is never kept.
            return { data: { ...user, name, image: null } };
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        // Signing out also forgets the active workspace.
        if (ctx.path === "/sign-out") {
          ctx.setCookie(ACTIVE_ORG_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: config.secureCookies });
        }
      }),
    },
  });
}

export const auth = createAuth(parseAuthEnv(process.env));
