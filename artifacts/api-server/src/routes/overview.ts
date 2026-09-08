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
          eq(campaignsTable.status, "Active"),
        ),
      );

    const [{ connectedNumbers }] = await db
      .select({ connectedNumbers: sql<number>`count(*)::int` })
      .from(phoneNumbersTable)
      .where(
        and(
          eq(phoneNumbersTable.organizationId, organizationId),
          eq(phoneNumbersTable.status, "Connected"),
        ),
      );

    const [totals] = await db
      .select({
        sent: sql<number>`coalesce(sum(${campaignsTable.sent}), 0)::int`,
        delivered: sql<number>`coalesce(sum(${campaignsTable.delivered}), 0)::int`,
      })
      .from(campaignsTable)
      .where(eq(campaignsTable.organizationId, organizationId));

    const [{ tpsOverall }] = await db
      .select({ tpsOverall: sql<number>`coalesce(sum(${campaignRoutesTable.currentTps}), 0)::int` })
      .from(campaignRoutesTable)
      .where(eq(campaignRoutesTable.organizationId, organizationId));

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
