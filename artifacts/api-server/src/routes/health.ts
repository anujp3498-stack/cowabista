import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { checkDatabaseHealth } from "../lib/database-health";
import { getCampaignRuntimeHeartbeat } from "../services/campaign-runtime";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const status = await checkDatabaseHealth(pool);
  // campaignRuntime is informational only: it must never flip the overall
  // status/HTTP code, since this same path is the production startup
  // health check (see artifact.toml) -- a stale-worker false positive
  // there would block deploys from ever going ready.
  const campaignRuntime = getCampaignRuntimeHeartbeat();
  res.status(status === "ok" ? 200 : 503).json(HealthCheckResponse.parse({ status, campaignRuntime }));
});

export default router;
