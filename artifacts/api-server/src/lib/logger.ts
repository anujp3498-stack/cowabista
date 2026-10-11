import pino, { type LoggerOptions } from "pino";
import { errorLogSerializers, scrubbedErrorMessage } from "./log-redaction";

const isProduction = process.env.NODE_ENV === "production";

// Shared by the process logger and by tests that need this exact
// configuration with an in-memory destination.
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  // Thrown values logged as `err`, `error` or `reason` are scrubbed of
  // provider secrets (upload session ids and signatures, handles, tokens,
  // credential ciphertext, Drizzle bound parameters) before they are written.
  serializers: errorLogSerializers,
  hooks: {
    // With no message string (`logger.error(err)`, `logger.error({ err })`)
    // pino writes the raw error message as `msg`, past the serializers; pass
    // the scrubbed message instead. Child loggers (pino-http) inherit this.
    logMethod(args, method) {
      const [first] = args;
      if (args.length === 1 && typeof first === "object" && first !== null) {
        const error = first instanceof Error ? first : (first as { err?: unknown }).err;
        if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
          return method.call(this, first, scrubbedErrorMessage(error as { message: string }));
        }
      }
      return method.apply(this, args);
    },
  },
};

export const logger = pino({
  ...loggerOptions,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
