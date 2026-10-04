import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, lt, sql } from "drizzle-orm";
import { campaignRoutesTable, campaignsTable, db } from "@workspace/db";
import {
  CreateCampaignBody,
  CreateCampaignResponse,
  DeleteCampaignParams,
  GetCampaignParams,
  GetCampaignResponse,
  ListCampaignsPageQueryParams,
  ListCampaignsPageResponse,
  ListCampaignsResponse,
  UpdateCampaignBody,
  UpdateCampaignParams,
  UpdateCampaignResponse,
} from "@workspace/api-zod";
import {
  attachOrgContext,
  requireAuth,
  requireRole,
} from "../middlewares/auth";

const router: IRouter = Router();

/**
 * Maps the DB row (which stores the campaign-engine-facing `scheduleLabel`
 * column) to the plain-CRUD API shape, which exposes it as `schedule` and
 * adds the computed route count.
 */
function toApi(campaign: typeof campaignsTable.$inferSelect, routesCount: number) {
  const { scheduleLabel, ...rest } = campaign;
  return { ...rest, schedule: scheduleLabel, routesCount };
}

async function routesCountFor(campaignId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignRoutesTable)
    .where(eq(campaignRoutesTable.campaignId, campaignId));
  return row?.count ?? 0;
}

router.get(
  "/campaigns",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const campaigns = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.organizationId, req.organizationId!))
      .orderBy(desc(campaignsTable.createdAt));

    const counts = await db
      .select({
        campaignId: campaignRoutesTable.campaignId,
        count: sql<number>`count(*)::int`,
      })
      .from(campaignRoutesTable)
      .where(eq(campaignRoutesTable.organizationId, req.organizationId!))
      .groupBy(campaignRoutesTable.campaignId);
    const countsById = new Map(counts.map((c) => [c.campaignId, c.count]));

    res.json(
      ListCampaignsResponse.parse(
        campaigns.map((c) => toApi(c, countsById.get(c.id) ?? 0)),
      ),
    );
  },
);

const CAMPAIGN_PAGE_DEFAULT_LIMIT = 25;
const CAMPAIGN_PAGE_MAX_LIMIT = 100;

/**
 * V2 campaign list: keyset-paginated by id (newest first), server-side name
 * search and status filter, organization-scoped. Keyset (`id < cursor`)
 * keeps every page an index range scan however many campaigns a workspace
 * accumulates, unlike OFFSET which re-reads everything before the page.
 * Route counts are computed only for the ids on the page.
 *
 * Registered before `/campaigns/:campaignId` so "list" is never parsed as
 * a campaign id.
 */
router.get(
  "/campaigns/list",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const query = ListCampaignsPageQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const { cursor, search, status } = query.data;
    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 1)) {
      res.status(400).json({ error: "cursor must be a positive integer" });
      return;
    }
    const requestedLimit = query.data.limit ?? CAMPAIGN_PAGE_DEFAULT_LIMIT;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return;
    }
    const limit = Math.min(requestedLimit, CAMPAIGN_PAGE_MAX_LIMIT);
    const term = search?.trim();

    const conditions = [eq(campaignsTable.organizationId, req.organizationId!)];
    if (cursor !== undefined) conditions.push(lt(campaignsTable.id, cursor));
    if (status) conditions.push(eq(campaignsTable.status, status));
    if (term) conditions.push(ilike(campaignsTable.name, `%${term.replace(/[%_\\]/g, "\\$&")}%`));

    // Fetch one extra row to know whether another page exists without a
    // separate count query.
    const rows = await db
      .select()
      .from(campaignsTable)
      .where(and(...conditions))
      .orderBy(desc(campaignsTable.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const countsById = new Map<number, number>();
    if (page.length) {
      const counts = await db
        .select({
          campaignId: campaignRoutesTable.campaignId,
          count: sql<number>`count(*)::int`,
        })
        .from(campaignRoutesTable)
        .where(
          and(
            eq(campaignRoutesTable.organizationId, req.organizationId!),
            sql`${campaignRoutesTable.campaignId} in (${sql.join(page.map((c) => sql`${c.id}`), sql`, `)})`,
          ),
        )
        .groupBy(campaignRoutesTable.campaignId);
      for (const c of counts) countsById.set(c.campaignId, c.count);
    }

    res.json(
      ListCampaignsPageResponse.parse({
        items: page.map((c) => toApi(c, countsById.get(c.id) ?? 0)),
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
        hasMore,
        limit,
      }),
    );
  },
);

router.get(
  "/campaigns/:campaignId",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const params = GetCampaignParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [campaign] = await db
      .select()
      .from(campaignsTable)
      .where(
        and(
          eq(campaignsTable.id, params.data.campaignId),
          eq(campaignsTable.organizationId, req.organizationId!),
        ),
      );
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    res.json(GetCampaignResponse.parse(toApi(campaign, await routesCountFor(campaign.id))));
  },
);

router.post(
  "/campaigns",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const body = CreateCampaignBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (body.data.status !== undefined && body.data.status !== "Draft") {
      res.status(400).json({ error: "New campaigns must start as Draft; use the campaign actions endpoint (plan/execute/...) to change status" });
      return;
    }

    const { schedule, creationKey, ...bodyRest } = body.data;
    // V2-05A: a client key makes Draft creation replay-safe. The unique
    // index on (organization, creation_key) is the arbiter: a retried or
    // double-clicked create inserts nothing and returns the existing Draft
    // (200), so the Audience page can never fork into two drafts.
    const [campaign] = await db
      .insert(campaignsTable)
      .values({
        ...bodyRest,
        ...(schedule !== undefined ? { scheduleLabel: schedule } : {}),
        ...(creationKey !== undefined ? { creationKey } : {}),
        organizationId: req.organizationId!,
      })
      .onConflictDoNothing({ target: [campaignsTable.organizationId, campaignsTable.creationKey] })
      .returning();
    if (!campaign) {
      const [existing] = await db.select().from(campaignsTable).where(and(
        eq(campaignsTable.organizationId, req.organizationId!),
        eq(campaignsTable.creationKey, creationKey!),
      ));
      if (!existing) {
        res.status(409).json({ error: "Campaign creation conflicted; retry" });
        return;
      }
      res.status(200).json(CreateCampaignResponse.parse(toApi(existing, await routesCountFor(existing.id))));
      return;
    }

    res.status(201).json(CreateCampaignResponse.parse(toApi(campaign, 0)));
  },
);

router.patch(
  "/campaigns/:campaignId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = UpdateCampaignParams.safeParse(req.params);
    const body = UpdateCampaignBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res
        .status(400)
        .json({ error: params.error?.message ?? body.error?.message });
      return;
    }

    const [existing] = await db
      .select({ status: campaignsTable.status, revision: campaignsTable.revision })
      .from(campaignsTable)
      .where(
        and(
          eq(campaignsTable.id, params.data.campaignId),
          eq(campaignsTable.organizationId, req.organizationId!),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    // Lifecycle status must only change through the campaign actions
    // endpoint (plan/execute/pause/resume/cancel/...), which validates
    // readiness and freezes/activates the execution plan. Letting this
    // plain CRUD endpoint set status would let a campaign skip straight to
    // Running without ever being planned, so its imported contacts would
    // never be queued.
    if (body.data.status !== undefined && body.data.status !== existing.status) {
      res.status(409).json({ error: "Use the campaign actions endpoint (plan/execute/pause/resume/cancel/...) to change status", code: "status_locked" });
      return;
    }

    const { schedule, revision, ...bodyRest } = body.data;
    // V2-05A autosave fence: the write only lands if the stored revision is
    // still the one the client based its edit on (checked in the UPDATE's
    // WHERE, so two concurrent saves cannot both win). A stale save gets
    // 409 stale_revision with the current row so the client can rebase.
    const [updated] = await db
      .update(campaignsTable)
      .set({
        ...bodyRest,
        ...(schedule !== undefined ? { scheduleLabel: schedule } : {}),
        revision: sql`${campaignsTable.revision} + 1`,
      })
      .where(
        and(
          eq(campaignsTable.id, params.data.campaignId),
          eq(campaignsTable.organizationId, req.organizationId!),
          ...(revision !== undefined ? [eq(campaignsTable.revision, revision)] : []),
        ),
      )
      .returning();

    if (!updated) {
      const [current] = await db.select().from(campaignsTable).where(and(
        eq(campaignsTable.id, params.data.campaignId),
        eq(campaignsTable.organizationId, req.organizationId!),
      ));
      if (!current) {
        res.status(404).json({ error: "Campaign not found" });
        return;
      }
      res.status(409).json({
        error: `This save was based on revision ${revision} but the campaign is at revision ${current.revision}`,
        code: "stale_revision",
        campaign: toApi(current, await routesCountFor(current.id)),
      });
      return;
    }

    res.json(
      UpdateCampaignResponse.parse(
        toApi(updated, await routesCountFor(updated.id)),
      ),
    );
  },
);

router.delete(
  "/campaigns/:campaignId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = DeleteCampaignParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [deleted] = await db
      .delete(campaignsTable)
      .where(
        and(
          eq(campaignsTable.id, params.data.campaignId),
          eq(campaignsTable.organizationId, req.organizationId!),
        ),
      )
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    res.status(204).send();
  },
);

export default router;
