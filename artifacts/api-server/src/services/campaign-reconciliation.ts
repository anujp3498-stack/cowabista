import { and, eq, sql } from "drizzle-orm";
import { campaignAuditTable, campaignJobsTable, campaignMetricsTable, campaignRoutesTable, campaignsTable, db } from "@workspace/db";

function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code
    ?? (error as { code?: unknown })?.code;
  return code === "40P01" || code === "40001";
}

export async function reconcileCampaignJobs(campaignId: number): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.transaction(async (tx) => {
        const [campaign] = await tx.select({
          id: campaignsTable.id,
          organizationId: campaignsTable.organizationId,
        }).from(campaignsTable).where(eq(campaignsTable.id, campaignId)).for("update");
        if (!campaign) return;
        // Reconciliation shares the parent locks used by workers before it
        // rewrites derived metrics, preventing parent-vs-metrics lock inversion.
        await tx.select({ id: campaignRoutesTable.id }).from(campaignRoutesTable)
          .where(eq(campaignRoutesTable.campaignId, campaignId)).orderBy(campaignRoutesTable.id).for("update");
        const [counts] = await tx.select({
          queued: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Queued')::int`,
          processing: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Processing')::int`,
          sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int`,
          failed: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Failed')::int`,
          retryCount: sql<number>`coalesce(sum(greatest(${campaignJobsTable.attempts} - 1, 0)), 0)::int`,
        }).from(campaignJobsTable).where(and(
          eq(campaignJobsTable.organizationId, campaign.organizationId),
          eq(campaignJobsTable.campaignId, campaignId),
        ));
        if (!counts) return;
        const reasons = await tx.select({
          reason: campaignJobsTable.errorReason,
          count: sql<number>`count(*)::int`,
        }).from(campaignJobsTable).where(and(
          eq(campaignJobsTable.organizationId, campaign.organizationId),
          eq(campaignJobsTable.campaignId, campaignId),
        )).groupBy(campaignJobsTable.errorReason);
        const errorReasons = Object.fromEntries(reasons.filter((row) => row.reason).map((row) => [row.reason!, row.count]));
        await tx.update(campaignMetricsTable).set({ ...counts, errorReasons })
          .where(eq(campaignMetricsTable.campaignId, campaignId));
        await tx.update(campaignsTable).set({ sent: counts.sent, failed: counts.failed })
          .where(eq(campaignsTable.id, campaignId));
        const depths = await tx.select({
          id: campaignRoutesTable.id,
          depth: sql<number>`count(${campaignJobsTable.id}) filter (where ${campaignJobsTable.status} in ('Queued', 'Processing'))::int`,
        }).from(campaignRoutesTable).leftJoin(campaignJobsTable, and(
          eq(campaignJobsTable.routeId, campaignRoutesTable.id),
          eq(campaignJobsTable.campaignId, campaignRoutesTable.campaignId),
          eq(campaignJobsTable.organizationId, campaignRoutesTable.organizationId),
        ))
          .where(eq(campaignRoutesTable.campaignId, campaignId)).groupBy(campaignRoutesTable.id);
        for (const route of depths) {
          await tx.update(campaignRoutesTable).set({ queueDepth: route.depth }).where(eq(campaignRoutesTable.id, route.id));
        }
        await tx.insert(campaignAuditTable).values({
          organizationId: campaign.organizationId,
          campaignId,
          action: "reconciled",
          metadata: {
            queued: counts.queued,
            processing: counts.processing,
            sent: counts.sent,
            failed: counts.failed,
          },
        });
      });
      return;
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * attempt * 20));
    }
  }
}