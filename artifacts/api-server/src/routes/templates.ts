import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, type SQL } from "drizzle-orm";
import { campaignAllocationsTable, db, templatesTable, wabasTable } from "@workspace/db";
import {
  CreateTemplateBody,
  CreateTemplateResponse,
  DeleteTemplateParams,
  ListTemplatesQueryParams,
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

// Public shape of a template row: provider-derived facts plus the WABA it
// belongs to. Nothing secret lives on a template row, but the raw metadata
// is reduced to the few fields the UI needs.
export function serializeTemplate(
  row: typeof templatesTable.$inferSelect,
  waba?: { externalId: string; displayName: string } | null,
) {
  const metadata = row.metadata ?? {};
  return {
    ...row,
    wabaExternalId: waba?.externalId ?? null,
    wabaDisplayName: waba?.displayName ?? null,
    source: typeof metadata.source === "string" ? metadata.source : (metadata.provider === "whatsapp-business" ? "legacy_connector" : null),
    providerStatus: typeof metadata.providerStatus === "string" ? metadata.providerStatus : null,
    providerMissing: metadata.providerMissing === true,
  };
}

router.get(
  "/templates",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const query = ListTemplatesQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const filters: SQL[] = [eq(templatesTable.organizationId, req.organizationId!)];
    if (query.data.search?.trim()) filters.push(ilike(templatesTable.name, `%${query.data.search.trim().replace(/[%_\\]/g, "\\$&")}%`));
    if (query.data.status) filters.push(eq(templatesTable.status, query.data.status));
    if (query.data.language) filters.push(eq(templatesTable.language, query.data.language));
    if (query.data.category) filters.push(eq(templatesTable.category, query.data.category));
    if (query.data.wabaId !== undefined) filters.push(eq(templatesTable.wabaId, query.data.wabaId));
    if (query.data.includeSample === false) filters.push(eq(templatesTable.isSample, false));
    const rows = await db
      .select({ template: templatesTable, waba: { externalId: wabasTable.externalId, displayName: wabasTable.displayName } })
      .from(templatesTable)
      .leftJoin(wabasTable, and(eq(wabasTable.id, templatesTable.wabaId), eq(wabasTable.organizationId, templatesTable.organizationId)))
      .where(and(...filters))
      .orderBy(desc(templatesTable.createdAt));
    res.json(ListTemplatesResponse.parse(rows.map(({ template, waba }) => serializeTemplate(template, waba))));
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

    res.status(201).json(CreateTemplateResponse.parse(serializeTemplate(template)));
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

    res.json(UpdateTemplateResponse.parse(serializeTemplate(updated)));
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
