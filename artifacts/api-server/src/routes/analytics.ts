import { Router, type IRouter } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  campaignJobsTable,
  campaignRoutesTable,
  db,
  phoneNumbersTable,
  providerEventsTable,
  providerMessagesTable,
} from "@workspace/db";
import {
  GetAnalyticsSummaryResponse,
  GetDeliveryTrendsQueryParams,
  GetDeliveryTrendsResponse,
  GetRouteHealthResponse,
} from "@workspace/api-zod";
import { attachOrgContext, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

const DEFAULT_TREND_DAYS = 30;
const MAX_TREND_DAYS = 90;

router.get(
  "/analytics/summary",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const organizationId = req.organizationId!;

    const [counts] = await db
      .select({
        totalSent: sql<number>`count(*)::int`,
        delivered: sql<number>`count(*) filter (where ${providerMessagesTable.status} in ('delivered', 'read'))::int`,
        read: sql<number>`count(*) filter (where ${providerMessagesTable.status} = 'read')::int`,
        failed: sql<number>`count(*) filter (where ${providerMessagesTable.status} = 'failed')::int`,
      })
      .from(providerMessagesTable)
      .where(eq(providerMessagesTable.organizationId, organizationId));

    const [{ activeRoutes }] = await db
      .select({ activeRoutes: sql<number>`count(*)::int` })
      .from(campaignRoutesTable)
      .where(
        and(
          eq(campaignRoutesTable.organizationId, organizationId),
          eq(campaignRoutesTable.status, "Active"),
        ),
      );

    const totalSent = counts?.totalSent ?? 0;
    const rate = (count: number) =>
      totalSent > 0 ? Math.round((count / totalSent) * 1000) / 10 : 0;

    res.json(
      GetAnalyticsSummaryResponse.parse({
        totalSent,
        deliveryRate: rate(counts?.delivered ?? 0),
        readRate: rate(counts?.read ?? 0),
        failureRate: rate(counts?.failed ?? 0),
        activeRoutes,
      }),
    );
  },
);

router.get(
  "/analytics/delivery-trends",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const query = GetDeliveryTrendsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const organizationId = req.organizationId!;
    const days = Math.min(Math.max(query.data.days ?? DEFAULT_TREND_DAYS, 1), MAX_TREND_DAYS);
    const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
    since.setUTCHours(0, 0, 0, 0);

    const sentRows = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${providerMessagesTable.acceptedAt}), 'YYYY-MM-DD')`,
        sent: sql<number>`count(*)::int`,
      })
      .from(providerMessagesTable)
      .where(
        and(
          eq(providerMessagesTable.organizationId, organizationId),
          gte(providerMessagesTable.acceptedAt, since),
        ),
      )
      .groupBy(sql`date_trunc('day', ${providerMessagesTable.acceptedAt})`);

    const eventRows = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${providerEventsTable.occurredAt}), 'YYYY-MM-DD')`,
        eventType: providerEventsTable.eventType,
        count: sql<number>`count(*)::int`,
      })
      .from(providerEventsTable)
      .where(
        and(
          eq(providerEventsTable.organizationId, organizationId),
          gte(providerEventsTable.occurredAt, since),
        ),
      )
      .groupBy(sql`date_trunc('day', ${providerEventsTable.occurredAt})`, providerEventsTable.eventType);

    const byDate = new Map<string, { sent: number; delivered: number; read: number; failed: number }>();
    for (const row of sentRows) {
      const bucket = byDate.get(row.date) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
      bucket.sent += row.sent;
      byDate.set(row.date, bucket);
    }
    for (const row of eventRows) {
      if (!["delivered", "read", "failed"].includes(row.eventType)) continue;
      const bucket = byDate.get(row.date) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
      bucket[row.eventType as "delivered" | "read" | "failed"] += row.count;
      byDate.set(row.date, bucket);
    }

    const result: { date: string; sent: number; delivered: number; read: number; failed: number }[] = [];
    for (let i = 0; i < days; i++) {
      const day = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
      const key = day.toISOString().slice(0, 10);
      const bucket = byDate.get(key) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
      result.push({ date: key, ...bucket });
    }

    res.json(GetDeliveryTrendsResponse.parse({ days: result }));
  },
);

router.get(
  "/analytics/route-health",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const organizationId = req.organizationId!;

    const routes = await db
      .select({
        phoneNumberId: phoneNumbersTable.id,
        displayName: phoneNumbersTable.displayName,
        phone: phoneNumbersTable.phone,
        sent: sql<number>`count(${providerMessagesTable.id})::int`,
        delivered: sql<number>`count(*) filter (where ${providerMessagesTable.status} in ('delivered', 'read'))::int`,
        failed: sql<number>`count(*) filter (where ${providerMessagesTable.status} = 'failed')::int`,
      })
      .from(phoneNumbersTable)
      .innerJoin(
        campaignRoutesTable,
        and(
          eq(campaignRoutesTable.phoneNumberId, phoneNumbersTable.id),
          eq(campaignRoutesTable.organizationId, phoneNumbersTable.organizationId),
        ),
      )
      .innerJoin(
        campaignJobsTable,
        and(
          eq(campaignJobsTable.routeId, campaignRoutesTable.id),
          eq(campaignJobsTable.organizationId, campaignRoutesTable.organizationId),
        ),
      )
      .innerJoin(
        providerMessagesTable,
        and(
          eq(providerMessagesTable.campaignJobId, campaignJobsTable.id),
          eq(providerMessagesTable.organizationId, campaignJobsTable.organizationId),
        ),
      )
      .where(eq(phoneNumbersTable.organizationId, organizationId))
      .groupBy(phoneNumbersTable.id);

    const errorReasonRows = await db
      .select({
        phoneNumberId: phoneNumbersTable.id,
        reason: sql<string>`coalesce(${providerMessagesTable.errorReason}, 'Unknown error')`,
        count: sql<number>`count(*)::int`,
      })
      .from(phoneNumbersTable)
      .innerJoin(
        campaignRoutesTable,
        and(
          eq(campaignRoutesTable.phoneNumberId, phoneNumbersTable.id),
          eq(campaignRoutesTable.organizationId, phoneNumbersTable.organizationId),
        ),
      )
      .innerJoin(
        campaignJobsTable,
        and(
          eq(campaignJobsTable.routeId, campaignRoutesTable.id),
          eq(campaignJobsTable.organizationId, campaignRoutesTable.organizationId),
        ),
      )
      .innerJoin(
        providerMessagesTable,
        and(
          eq(providerMessagesTable.campaignJobId, campaignJobsTable.id),
          eq(providerMessagesTable.organizationId, campaignJobsTable.organizationId),
          eq(providerMessagesTable.status, "failed"),
        ),
      )
      .where(eq(phoneNumbersTable.organizationId, organizationId))
      .groupBy(phoneNumbersTable.id, providerMessagesTable.errorReason);

    const reasonsByPhone = new Map<number, { reason: string; count: number }[]>();
    for (const row of errorReasonRows) {
      const list = reasonsByPhone.get(row.phoneNumberId) ?? [];
      list.push({ reason: row.reason, count: row.count });
      reasonsByPhone.set(row.phoneNumberId, list);
    }

    const result = routes.map((route) => ({
      phoneNumberId: route.phoneNumberId,
      displayName: route.displayName,
      phone: route.phone,
      sent: route.sent,
      delivered: route.delivered,
      failed: route.failed,
      failureRate: route.sent > 0 ? Math.round((route.failed / route.sent) * 1000) / 10 : 0,
      topErrorReasons: (reasonsByPhone.get(route.phoneNumberId) ?? [])
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    }));

    res.json(GetRouteHealthResponse.parse({ routes: result }));
  },
);

export default router;
