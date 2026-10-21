import app from "./app";
import { logger } from "./lib/logger";
import { installCrashHandlers } from "./lib/process-crash-handlers";
import { startCampaignRuntime, stopCampaignRuntime } from "./services/campaign-runtime";
import { createStartupOrchestrator, registerStartupOrchestrator } from "./services/startup";
import { backfillTemplateEligibility } from "./services/template-eligibility";
import { describeCampaignMediaStorage } from "./services/campaign-media-storage";
import { pool, settlementPool } from "@workspace/db";

// PORT is optional (default 8080); deploy/systemd sets it explicitly per cell.
const rawPort = process.env["PORT"] || "8080";

const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Campaign media storage (CAMPAIGN_MEDIA_STORAGE=local|s3): a malformed or half-configured setting stops the
// server here, like PORT and CORS_ALLOWED_ORIGINS. The description carries no credentials.
const mediaStorage = describeCampaignMediaStorage();

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
  if (mediaStorage.kind === "none" && process.env.NODE_ENV === "production") {
    logger.warn({ campaignMediaStorage: mediaStorage }, "No campaign media storage configured: media uploads answer 503");
  } else {
    logger.info({ campaignMediaStorage: mediaStorage }, "Campaign media storage");
  }
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
