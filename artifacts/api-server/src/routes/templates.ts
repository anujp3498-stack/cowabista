import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { campaignAllocationsTable, db, templatesTable } from "@workspace/db";
import {
  CreateTemplateBody,
  CreateTemplateResponse,
  DeleteTemplateParams,
  ListTemplatesResponse,
  UpdateTemplateBody,
  UpdateTemplateParams,
  UpdateTemplateResponse,
} from "@workspace/api-zod";
import {
  attachOrgContext,
  requireAuth,
  requireRole,
} from "../middlewares/auth";

const router: IRouter = Router();

router.get(
  "/templates",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const templates = await db
      .select()
      .from(templatesTable)
      .where(eq(templatesTable.organizationId, req.organizationId!))
      .orderBy(desc(templatesTable.createdAt));
    res.json(ListTemplatesResponse.parse(templates));
  },
);

router.post(
  "/templates",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const body = CreateTemplateBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const [template] = await db
      .insert(templatesTable)
      .values({ ...body.data, organizationId: req.organizationId! })
      .returning();

    res.status(201).json(CreateTemplateResponse.parse(template));
  },
);

router.patch(
  "/templates/:templateId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = UpdateTemplateParams.safeParse(req.params);
    const body = UpdateTemplateBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res
        .status(400)
        .json({ error: params.error?.message ?? body.error?.message });
      return;
    }

    const [updated] = await db
      .update(templatesTable)
      .set(body.data)
      .where(
        and(
          eq(templatesTable.id, params.data.templateId),
          eq(templatesTable.organizationId, req.organizationId!),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.json(UpdateTemplateResponse.parse(updated));
  },
);

router.delete(
  "/templates/:templateId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = DeleteTemplateParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    // A campaign_allocations row is a permanent, tenant-owned audit record
    // of which template a contact was actually assigned to by a frozen plan
    // (see campaignAllocationsTable comment). Its FK to templates cascades
    // on delete, so deleting a still-referenced template would silently
    // erase that audit history and desync allocation/job counters. Fence
    // deletion instead, mirroring the lifecycle-bypass pattern used for
    // campaign status changes.
    const [referenced] = await db.select({ id: campaignAllocationsTable.id }).from(campaignAllocationsTable).where(and(
      eq(campaignAllocationsTable.organizationId, req.organizationId!),
      eq(campaignAllocationsTable.templateId, params.data.templateId),
    )).limit(1);
    if (referenced) {
      res.status(409).json({ error: "Template has been allocated by a campaign plan and cannot be deleted" });
      return;
    }

    const [deleted] = await db
      .delete(templatesTable)
      .where(
        and(
          eq(templatesTable.id, params.data.templateId),
          eq(templatesTable.organizationId, req.organizationId!),
        ),
      )
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.status(204).send();
  },
);

export default router;
