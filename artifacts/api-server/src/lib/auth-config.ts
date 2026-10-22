import { parseAllowedOrigins, parseFullOrigin } from "./http-config";

// Better Auth settings, parsed strictly at startup (pure; no Better Auth import, so it is testable without a
// database). Better Auth itself is lenient here: outside production it silently uses a public default secret,
// a versioned BETTER_AUTH_SECRETS overrides an explicit secret, BETTER_AUTH_TRUSTED_ORIGINS bypasses the
// strict origin rule below, and a truthy BETTER_AUTH_TELEMETRY turns telemetry on whatever the options say.
// So this refuses all of that in EVERY environment. Error messages name the variable, never a secret value.
// Public self sign-up (AUTH_PUBLIC_SIGN_UP) is closed unless explicitly "open", and can never be opened in
// production (decision U2, Option 2a): accounts are created by an operator (src/auth-admin.ts).

export type AuthEnv = {
  secret: string;
  /** The public origin of the app (the browser's origin): cookies, origin checks and redirects use it. */
  baseURL: string;
  secureCookies: boolean;
  trustedOrigins: string[];
  /** Whether anyone may create an account at POST /api/auth/sign-up/email. */
  publicSignUp: boolean;
};

/** Better Auth's built-in fallback secret (public); refused explicitly. */
const BETTER_AUTH_DEFAULT_SECRET = "better-auth-secret-12345678901234567890";
const MIN_SECRET_LENGTH = 32;
const MIN_SECRET_ENTROPY_BITS = 120;

/** Better Auth's own estimate (length x log2(distinct characters)), computed without overflowing. */
function estimatedEntropyBits(value: string): number {
  const distinct = new Set(value).size;
  return distinct <= 1 ? 0 : value.length * Math.log2(distinct);
}

export function parseAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv {
  if (env.BETTER_AUTH_SECRETS !== undefined && env.BETTER_AUTH_SECRETS !== "") {
    throw new Error("BETTER_AUTH_SECRETS is not supported (it would override BETTER_AUTH_SECRET); unset it");
  }
  if (env.BETTER_AUTH_TRUSTED_ORIGINS !== undefined && env.BETTER_AUTH_TRUSTED_ORIGINS !== "") {
    throw new Error("BETTER_AUTH_TRUSTED_ORIGINS is not supported; trusted origins are BETTER_AUTH_URL plus CORS_ALLOWED_ORIGINS");
  }
  // Better Auth reads these as "on" unless exactly "", "0" or "false" (any case), without trimming.
  for (const name of ["BETTER_AUTH_TELEMETRY", "BETTER_AUTH_TELEMETRY_DEBUG"]) {
    const raw = env[name];
    if (raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false") {
      throw new Error(`${name} must be unset (telemetry stays off)`);
    }
  }
  if (env.BETTER_AUTH_TELEMETRY_ENDPOINT !== undefined && env.BETTER_AUTH_TELEMETRY_ENDPOINT !== "") {
    throw new Error("BETTER_AUTH_TELEMETRY_ENDPOINT must be unset (telemetry stays off)");
  }

  const secret = env.BETTER_AUTH_SECRET;
  if (secret === undefined || secret.trim() === "") {
    throw new Error("BETTER_AUTH_SECRET is required: at least 32 random bytes, e.g. `openssl rand -base64 32`");
  }
  if (secret !== secret.trim()) throw new Error("BETTER_AUTH_SECRET must not start or end with whitespace");
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET is too short: use at least ${MIN_SECRET_LENGTH} characters of random data (openssl rand -base64 32)`);
  }
  if (secret === BETTER_AUTH_DEFAULT_SECRET || /CHANGE_ME/i.test(secret)) {
    throw new Error("BETTER_AUTH_SECRET is a placeholder; generate one with `openssl rand -base64 32`");
  }
  if (estimatedEntropyBits(secret) < MIN_SECRET_ENTROPY_BITS) {
    throw new Error("BETTER_AUTH_SECRET looks low-entropy; generate one with `openssl rand -base64 32`");
  }

  const rawUrl = env.BETTER_AUTH_URL?.trim();
  if (!rawUrl) throw new Error("BETTER_AUTH_URL is required: the app's public origin, e.g. https://app.example.com");
  const baseURL = parseFullOrigin(rawUrl, "BETTER_AUTH_URL");
  if (env.NODE_ENV === "production" && !baseURL.startsWith("https://")) {
    throw new Error("BETTER_AUTH_URL must be https in production");
  }
  const trustedOrigins = [baseURL, ...[...parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS)].filter((origin) => origin !== baseURL)];
  return { secret, baseURL, secureCookies: baseURL.startsWith("https://"), trustedOrigins, publicSignUp: parsePublicSignUp(env) };
}

/** Unset or empty means closed; only the exact values "closed" and "open" are accepted. */
function parsePublicSignUp(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AUTH_PUBLIC_SIGN_UP;
  if (raw === undefined || raw === "" || raw === "closed") return false;
  if (raw !== "open") throw new Error('AUTH_PUBLIC_SIGN_UP must be "closed" or "open" (unset means closed)');
  if (env.NODE_ENV === "production") {
    throw new Error("AUTH_PUBLIC_SIGN_UP=open is not allowed in production: accounts are created by an operator (auth-admin)");
  }
  return true;
}
