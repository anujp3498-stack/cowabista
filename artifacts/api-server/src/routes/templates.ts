import { Router, type IRouter } from "express";
import { and, count, desc, eq, ilike, type SQL } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignJobsTable,
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  db,
  templatesTable,
  wabasTable,
} from "@workspace/db";
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

    // One transaction: the row is locked FOR UPDATE while it is classified
    // and written, so a concurrent delete or a concurrent sync that turns it
    // provider-backed cannot interleave. Every predicate carries the
    // organization.
    const outcome = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(templatesTable)
        .where(and(
          eq(templatesTable.id, params.data.templateId),
          eq(templatesTable.organizationId, req.organizationId!),
        ))
        .for("update");
      if (!existing) return { kind: "missing" as const };
      if (isProviderBackedTemplate(existing)) return { kind: "provider" as const };
      // Only the explicitly allowed local fields; status/components/metadata
      // and provider identity are never settable here.
      const changes: Partial<typeof templatesTable.$inferInsert> = {};
      if (body.data.name !== undefined) changes.name = body.data.name;
      if (body.data.body !== undefined) changes.body = body.data.body;
      if (body.data.category !== undefined) changes.category = body.data.category;
      if (body.data.language !== undefined) changes.language = body.data.language;
      if (!Object.keys(changes).length) return { kind: "ok" as const, row: existing };
      const [updated] = await tx
        .update(templatesTable)
        .set(changes)
        .where(and(
          eq(templatesTable.id, existing.id),
          eq(templatesTable.organizationId, req.organizationId!),
        ))
        .returning();
      return updated ? { kind: "ok" as const, row: updated } : { kind: "missing" as const };
    });
    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    if (outcome.kind === "provider") {
      res.status(409).json({ error: "This template is synchronised from Meta and cannot be edited in Wabista", code: "provider_backed" });
      return;
    }
    res.json(UpdateTemplateResponse.parse(serializeTemplate(outcome.row)));
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

    // Generic deletion is only for LOCAL templates nothing refers to.
    //  - A provider-backed row is Meta's: deleting it would cascade away
    //    campaign selections and variable mappings and null out route and
    //    job references, none of which a later re-sync restores. 409.
    //  - A referenced local row keeps the same configuration and the
    //    permanent allocation history alive. 409.
    // The row is locked FOR UPDATE for the whole check-and-delete: a
    // concurrent insert of any child row (selection, mapping, route, job,
    // allocation) takes a KEY SHARE lock on this template and therefore
    // either commits before the check sees it or waits and then fails its
    // foreign key against the deleted row. A foreign tenant's id is
    // indistinguishable from a missing one: 404.
    const outcome = await db.transaction(async (tx) => {
      const organizationId = req.organizationId!;
      const [existing] = await tx
        .select()
        .from(templatesTable)
        .where(and(eq(templatesTable.id, params.data.templateId), eq(templatesTable.organizationId, organizationId)))
        .for("update");
      if (!existing) return { kind: "missing" as const };
      if (isProviderBackedTemplate(existing)) return { kind: "provider" as const };
      const countOf = async (table: typeof campaignTemplateSelectionsTable | typeof campaignTemplateMappingsTable | typeof campaignRoutesTable | typeof campaignJobsTable | typeof campaignAllocationsTable) => {
        const [row] = await tx.select({ value: count() }).from(table).where(and(
          eq(table.templateId, existing.id),
          eq(table.organizationId, organizationId),
        ));
        return Number(row?.value ?? 0);
      };
      const references = {
        selections: await countOf(campaignTemplateSelectionsTable),
        mappings: await countOf(campaignTemplateMappingsTable),
        routes: await countOf(campaignRoutesTable),
        jobs: await countOf(campaignJobsTable),
        allocations: await countOf(campaignAllocationsTable),
      };
      if (Object.values(references).some((value) => value > 0)) return { kind: "referenced" as const, references };
      const [deleted] = await tx
        .delete(templatesTable)
        .where(and(eq(templatesTable.id, existing.id), eq(templatesTable.organizationId, organizationId)))
        .returning({ id: templatesTable.id });
      return deleted ? { kind: "deleted" as const } : { kind: "missing" as const };
    });

    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    if (outcome.kind === "provider") {
      res.status(409).json({ error: "This template is synchronised from Meta and cannot be deleted in Wabista", code: "provider_backed" });
      return;
    }
    if (outcome.kind === "referenced") {
      res.status(409).json({
        error: "Template is used by a campaign (selection, mapping, route, job or allocation) and cannot be deleted",
        code: "referenced",
        references: outcome.references,
      });
      return;
    }
    res.status(204).send();
  },
);

export default router;
