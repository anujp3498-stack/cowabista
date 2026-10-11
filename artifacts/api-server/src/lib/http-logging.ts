import { serializeLoggedError } from "./log-redaction";

// Serializers for pino-http. The request line is reduced to id, method and
// the query-stripped URL (no headers, no body); the response to its status.
// pino-http installs its own `err` serializer on every request logger,
// overriding the process logger's, so the shared scrubbing serializer is
// passed here explicitly. `error` and `reason` are inherited from the
// process logger (lib/logger.ts).
export const httpLogSerializers = {
  req(req: { id?: unknown; method?: string; url?: string }) {
    return {
      id: req.id,
      method: req.method,
      url: req.url?.split("?")[0],
    };
  },
  res(res: { statusCode?: number }) {
    return {
      statusCode: res.statusCode,
    };
  },
  err: serializeLoggedError,
};
