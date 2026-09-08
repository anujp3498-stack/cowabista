import type { Logger } from "pino";

/**
 * Installs handlers for the two process-level failure modes Node does not
 * route through any of our own try/catch: a rejected promise nobody awaited
 * or attached a .catch to, and a synchronous throw that escaped every call
 * frame. Left unhandled, Node's default behavior is to kill the process
 * immediately -- no structured log line, and none of our own shutdown work
 * runs (in particular, the campaign runtime never gets told to stop, so any
 * lease it currently holds is abandoned instead of released and the
 * in-flight job has to wait out the full lease timeout instead of being
 * picked up right away).
 *
 * Takes an injectable `target` (instead of importing the global `process`
 * directly) and an `onCrash` callback (instead of calling `process.exit`
 * itself) purely so this can be unit tested in-process: a test can pass a
 * fake event target and assert exactly what would have run, without ending
 * the test process or spawning a subprocess.
 */
export function installCrashHandlers(
  target: Pick<NodeJS.Process, "on">,
  options: { logger: Pick<Logger, "error">; onCrash: (signal: string) => void },
): void {
  target.on("unhandledRejection", (reason) => {
    options.logger.error({ reason }, "Unhandled promise rejection; shutting down");
    options.onCrash("unhandledRejection");
  });
  target.on("uncaughtException", (error) => {
    options.logger.error({ error }, "Uncaught exception; shutting down");
    options.onCrash("uncaughtException");
  });
}
