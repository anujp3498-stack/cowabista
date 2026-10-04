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

// A template row is provider-backed once it carries a provider template id
// or was written by a synchronisation (workspace credential or legacy
// connector). Its name, language, category, status, body and components
// are Meta's; the generic CRUD below may only touch LOCAL rows, and never
// sets status for either kind.
export function isProviderBackedTemplate(row: { providerTemplateId: string | null; metadata: Record<string, unknown> | null }): boolean {
  const source = row.metadata?.source;
  return row.providerTemplateId !== null
    || source === "workspace_credential"
    || source === "legacy_connector"
    || row.metadata?.provider === "whatsapp-business";
}

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

    // Local rows start Pending and are marked as such; only a Meta sync can
    // ever make a template Approved.
    const [template] = await db
      .insert(templatesTable)
      .values({
        name: body.data.name,
        body: body.data.body,
        category: body.data.category ?? "Marketing",
        language: body.data.language ?? "en_US",
        status: "Pending",
        metadata: { source: "local" },
        isSample: false,
        organizationId: req.organizationId!,
      })
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

    const [existing] = await db
      .select()
      .from(templatesTable)
      .where(
        and(
          eq(templatesTable.id, params.data.templateId),
          eq(templatesTable.organizationId, req.organizationId!),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    if (isProviderBackedTemplate(existing)) {
      res.status(409).json({ error: "This template is synchronised from Meta and cannot be edited in Wabista" });
      return;
    }
    // Only the explicitly allowed local fields; status/components/metadata
    // are never settable here.
    const changes: Partial<typeof templatesTable.$inferInsert> = {};
    if (body.data.name !== undefined) changes.name = body.data.name;
    if (body.data.body !== undefined) changes.body = body.data.body;
    if (body.data.category !== undefined) changes.category = body.data.category;
    if (body.data.language !== undefined) changes.language = body.data.language;
    const [updated] = Object.keys(changes).length
      ? await db.update(templatesTable).set(changes).where(eq(templatesTable.id, existing.id)).returning()
      : [existing];

    res.json(UpdateTemplateResponse.parse(serializeTemplate(updated!)));
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
