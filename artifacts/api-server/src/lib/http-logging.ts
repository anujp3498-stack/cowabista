import { serializeLoggedError } from "./log-redaction";

// Serializers for pino-http. The request line is reduced to id, method and
// the query-stripped URL (no headers, no body); the response to its status.
// An invitation token in the URL (the public invite preview) is replaced:
// with the invited email it is enough to join the workspace.
// pino-http installs its own `err` serializer on every request logger,
// overriding the process logger's, so the shared scrubbing serializer is
// passed here explicitly. `error` and `reason` are inherited from the
// process logger (lib/logger.ts).

/** A request path safe to log: query dropped, invitation token replaced (Express routing is case-insensitive). */
export function loggablePath(url: string | undefined): string | undefined {
  return url?.split("?")[0]!.replace(/^(\/api\/invite-info\/)[^/]+/i, "$1[REDACTED]");
}

export const httpLogSerializers = {
  req(req: { id?: unknown; method?: string; url?: string }) {
    return {
      id: req.id,
      method: req.method,
      url: loggablePath(req.url),
    };
  },
  res(res: { statusCode?: number }) {
    return {
      statusCode: res.statusCode,
    };
  },
  err: serializeLoggedError,
};
