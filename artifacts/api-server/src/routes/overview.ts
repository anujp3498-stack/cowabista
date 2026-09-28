import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignsTable,
  db,
  phoneNumbersTable,
} from "@workspace/db";
import { GetOverviewStatsResponse } from "@workspace/api-zod";
import { attachOrgContext, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Workspace summary for Home. Every figure here must be honest:
// - "active" campaigns are the ones actually in the engine's Running state;
// - rows flagged `isSample` (legacy demo seeding) never count, so a workspace
//   that still carries old sample records shows only its real activity;
// - `tpsOverall` sums the stored `campaign_routes.currentTps`, which is a
//   configured/stored value rather than a measured live rate. It is kept in
//   the response for API compatibility only; Home does not present it as
//   live throughput.
router.get(
  "/overview/stats",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const organizationId = req.organizationId!;

    const [{ activeCampaigns }] = await db
      .select({ activeCampaigns: sql<number>`count(*)::int` })
      .from(campaignsTable)
      .where(
        and(
          eq(campaignsTable.organizationId, organizationId),
          eq(campaignsTable.status, "Running"),
          eq(campaignsTable.isSample, false),
        ),
      );

    const [{ connectedNumbers }] = await db
      .select({ connectedNumbers: sql<number>`count(*)::int` })
      .from(phoneNumbersTable)
      .where(
        and(
          eq(phoneNumbersTable.organizationId, organizationId),
          eq(phoneNumbersTable.status, "Connected"),
          eq(phoneNumbersTable.isSample, false),
        ),
      );

    const [totals] = await db
      .select({
        sent: sql<number>`coalesce(sum(${campaignsTable.sent}), 0)::int`,
        delivered: sql<number>`coalesce(sum(${campaignsTable.delivered}), 0)::int`,
      })
      .from(campaignsTable)
      .where(
        and(
          eq(campaignsTable.organizationId, organizationId),
          eq(campaignsTable.isSample, false),
        ),
      );

    const [{ tpsOverall }] = await db
      .select({ tpsOverall: sql<number>`coalesce(sum(${campaignRoutesTable.currentTps}), 0)::int` })
      .from(campaignRoutesTable)
      .where(
        and(
          eq(campaignRoutesTable.organizationId, organizationId),
          eq(campaignRoutesTable.isSample, false),
        ),
      );

    const deliveryRate =
      totals.sent > 0
        ? Math.round((totals.delivered / totals.sent) * 1000) / 10
        : 0;

    res.json(
      GetOverviewStatsResponse.parse({
        activeCampaigns,
        connectedNumbers,
        messagesSent: totals.sent,
        deliveryRate,
        tpsOverall,
      }),
    );
  },
);

export default router;
