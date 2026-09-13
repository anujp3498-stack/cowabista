import { and, eq, sql } from "drizzle-orm";
import { campaignAuditTable, campaignJobsTable, campaignMetricsTable, campaignRoutesTable, campaignsTable, db } from "@workspace/db";

type Counts = { queued: number; processing: number; sent: number; failed: number; retryCount: number };

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
        // The authoritative recount, the removal of this campaign's pending
        // metric deltas, and the counter rewrite are ONE statement, so all
        // three see the same snapshot. Every delta row is written in the same
        // transaction as the job transition it describes, so a delta visible
        // here describes a transition the recount already includes and must
        // not be applied again afterwards, while a transition that commits
        // after this snapshot leaves its delta in place to be folded on top.
        // Settlement writers wait on the campaign lock above; the claim path
        // does not take it (it only shares the phone row), which is exactly
        // why the recount and the delete cannot be two statements.
        // `counts` reads `consumed`, so the delete runs to completion before
        // the counters are rewritten: delta rows first, then the metrics row,
        // the same order the delta flush takes, so the two cannot deadlock.
        const recount = await tx.execute<Counts & { consumedDeltas: number }>(sql`
          with consumed as (
            delete from campaign_metric_deltas
            where campaign_id = ${campaignId} and organization_id = ${campaign.organizationId}
            returning 1
          ),
          counts as (
            select
              count(*) filter (where status = 'Queued')::int as queued,
              count(*) filter (where status = 'Processing')::int as processing,
              count(*) filter (where status = 'Sent')::int as sent,
              count(*) filter (where status = 'Failed')::int as failed,
              coalesce(sum(greatest(attempts - 1, 0)), 0)::int as retry_count,
              (select count(*) from consumed)::int as consumed_deltas
            from campaign_jobs
            where organization_id = ${campaign.organizationId} and campaign_id = ${campaignId}
          ),
          rewritten as (
            update campaign_metrics as metrics
            set queued = counts.queued,
                processing = counts.processing,
                sent = counts.sent,
                failed = counts.failed,
                retry_count = counts.retry_count
            from counts
            where metrics.campaign_id = ${campaignId} and metrics.organization_id = ${campaign.organizationId}
            returning 1
          )
          select counts.queued, counts.processing, counts.sent, counts.failed, counts.retry_count as "retryCount",
                 counts.consumed_deltas as "consumedDeltas", (select count(*) from rewritten) as rewritten
          from counts
        `);
        const counts = recount.rows[0];
        if (!counts) return;
        const reasons = await tx.select({
          reason: campaignJobsTable.errorReason,
          count: sql<number>`count(*)::int`,
        }).from(campaignJobsTable).where(and(
          eq(campaignJobsTable.organizationId, campaign.organizationId),
          eq(campaignJobsTable.campaignId, campaignId),
        )).groupBy(campaignJobsTable.errorReason);
        const errorReasons = Object.fromEntries(reasons.filter((row) => row.reason).map((row) => [row.reason!, row.count]));
        await tx.update(campaignMetricsTable).set({ errorReasons })
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
            consumedDeltas: counts.consumedDeltas,
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