import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { checkDatabaseHealth } from "../lib/database-health";
import { getCampaignRuntimeHeartbeat } from "../services/campaign-runtime";
import { getStartupState } from "../services/startup";

const router: IRouter = Router();

// Liveness. campaignRuntime and initialization are informational here:
// they never flip the overall status/HTTP code, so a stale worker or a
// still-running backfill is surfaced for monitoring without failing
// container liveness checks.
router.get("/healthz", async (_req, res) => {
  const status = await checkDatabaseHealth(pool);
  const campaignRuntime = getCampaignRuntimeHeartbeat();
  const initialization = getStartupState();
  res.status(status === "ok" ? 200 : 503).json(HealthCheckResponse.parse({ status, campaignRuntime, initialization: { phase: initialization.phase, error: initialization.error } }));
});

// Readiness for campaign operations (V2-04 acceptance correction): 200
// only once required initialization (the eligibility backfill) completed
// and the campaign runtime was started; 503 while initializing, after a
// failed initialization, and after shutdown. Distinct from liveness above.
router.get("/readyz", async (_req, res) => {
  const database = await checkDatabaseHealth(pool);
  const initialization = getStartupState();
  const ready = database === "ok" && initialization.phase === "ready";
  res.status(ready ? 200 : 503).json(ReadinessCheckResponse.parse({
    status: ready ? "ready" : "not_ready",
    database,
    initialization: { phase: initialization.phase, error: initialization.error, completedAt: initialization.completedAt },
  }));
});

export default router;
