import app from "./app";
import { logger } from "./lib/logger";
import { installCrashHandlers } from "./lib/process-crash-handlers";
import { startCampaignRuntime, stopCampaignRuntime } from "./services/campaign-runtime";
import { createStartupOrchestrator, registerStartupOrchestrator } from "./services/startup";
import { backfillTemplateEligibility } from "./services/template-eligibility";
import { pool, settlementPool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Startup sequencing (see services/startup.ts): the listener comes up for
// liveness, required initialization (the idempotent eligibility backfill,
// which never overwrites sync-written evidence) runs to completion, and
// only a successful initialization starts campaign work consumption.
// /readyz reports ready only after that. A failed initialization exits
// the process cleanly with a non-zero code instead of consuming work.
const startup = createStartupOrchestrator({
  initialize: () => backfillTemplateEligibility(),
  startRuntime: () => startCampaignRuntime(),
  stopRuntime: () => stopCampaignRuntime(),
  logger,
  onInitializationFailed: () => void shutdown("initialization-failed", 1),
});
registerStartupOrchestrator(startup);

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void startup.start();
});

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down API server");
  // Waits for an in-flight initialization to settle and guarantees no
  // late runtime start; stops the runtime if it was started.
  await startup.shutdown();
  server.close(async (error) => {
    if (error) {
      logger.error({ error }, "Error closing API server");
      process.exit(1);
      return;
    }
    try {
      // Closes every pooled connection cleanly instead of leaving them for
      // Postgres to notice and reap on its own timeout -- matters for fast,
      // clean restarts/redeploys where a new process's pool starts fresh
      // moments later against the same database.
      await Promise.all([pool.end(), settlementPool.end()]);
    } catch (poolError) {
      logger.error({ error: poolError }, "Error closing database pool during shutdown");
    }
    process.exit(exitCode);
  });
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
installCrashHandlers(process, { logger, onCrash: (signal) => void shutdown(signal) });
