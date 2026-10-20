/**
 * Environment-driven HTTP settings for app.ts, parsed once at startup. Both parsers throw on a malformed
 * value so a misconfigured server refuses to start instead of silently opening or closing access.
 */

/**
 * CORS_ALLOWED_ORIGINS: comma-separated FULL origins (scheme://host[:port]), for example
 * "https://app.example.com,http://localhost:24902". Each entry must be an http(s) origin with no path, query,
 * fragment, credentials or "*" wildcard; bare host names are rejected. Empty or unset means no cross-origin browser caller
 * is allowed, which is the normal case: the SPA and the API share one origin (a reverse proxy in production,
 * the Vite /api proxy in development), and same-origin requests need no CORS entry.
 */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS entry "${entry}" is not a full origin (expected e.g. https://app.example.com)`);
    }
    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    // "*" is not a wildcard here (it would silently never match), so it is malformed like any other host error.
    if (!isHttp || url.username || url.password || /[?#*]/.test(entry) || url.pathname !== "/") {
      throw new Error(`CORS_ALLOWED_ORIGINS entry "${entry}" is not a full origin (expected e.g. https://app.example.com)`);
    }
    origins.add(url.origin);
  }
  return origins;
}

/** True when the request's Origin header exactly matches (scheme, host and port) an allowed origin. */
export function isAllowedOrigin(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

/**
 * TRUST_PROXY: number of reverse-proxy hops in front of this process (default 1: one TLS-terminating proxy
 * such as nginx, or the Vite dev proxy). Express derives req.ip from X-Forwarded-For using this count, and
 * the rate limiter keys anonymous callers by req.ip. Set 0 when clients connect to the process directly;
 * otherwise a client could spoof X-Forwarded-For.
 */
export function parseTrustProxy(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return 1;
  if (!/^\d+$/.test(value)) {
    throw new Error(`TRUST_PROXY must be a non-negative integer hop count (got "${value}")`);
  }
  return Number(value);
}
