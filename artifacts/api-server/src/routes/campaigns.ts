import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { campaignRoutesTable, campaignsTable, db } from "@workspace/db";
import {
  CreateCampaignBody,
  CreateCampaignResponse,
  DeleteCampaignParams,
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

    const { schedule, ...bodyRest } = body.data;
    const [campaign] = await db
      .insert(campaignsTable)
      .values({
        ...bodyRest,
        ...(schedule !== undefined ? { scheduleLabel: schedule } : {}),
        organizationId: req.organizationId!,
      })
      .returning();

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
      .select({ status: campaignsTable.status })
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
      res.status(409).json({ error: "Use the campaign actions endpoint (plan/execute/pause/resume/cancel/...) to change status" });
      return;
    }

    const { schedule, ...bodyRest } = body.data;
    const [updated] = await db
      .update(campaignsTable)
      .set({
        ...bodyRest,
        ...(schedule !== undefined ? { scheduleLabel: schedule } : {}),
      })
      .where(
        and(
          eq(campaignsTable.id, params.data.campaignId),
          eq(campaignsTable.organizationId, req.organizationId!),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Campaign not found" });
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
