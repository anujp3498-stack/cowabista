import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import {
  campaignAllocationsTable,
  campaignContactsTable,
  campaignPlansTable,
  db,
  type CampaignPlan,
} from "@workspace/db";
import { describeTemplate } from "./template-mapping";
import { resolveTemplateVariables, type ResolvableMapping } from "./template-resolution";
import { normalizePhone } from "./contact-processing";

export class PlanPreviewNotFoundError extends Error {}

async function getActivePlan(organizationId: number, campaignId: number): Promise<CampaignPlan | undefined> {
  const [plan] = await db.select().from(campaignPlansTable).where(and(
    eq(campaignPlansTable.organizationId, organizationId),
    eq(campaignPlansTable.campaignId, campaignId),
    eq(campaignPlansTable.status, "Active"),
  ));
  return plan;
}

/**
 * Support/ops summary of the active frozen plan: exactly which phone
 * numbers/routes are wired to which frozen template, at what TPS, and what
 * variable mapping each template will use. Reads only the plan's own
 * frozen snapshot columns -- never the live routes/templates/mappings/
 * phoneNumbers tables -- so this always matches what execution actually
 * resolves and sends, even if those live tables have since been edited
 * (including a phone's own display name or number being changed).
 */
export async function getActivePlanSummary(organizationId: number, campaignId: number) {
  const plan = await getActivePlan(organizationId, campaignId);
  if (!plan) return undefined;

  return {
    planId: plan.id,
    version: plan.version,
    status: plan.status,
    createdAt: plan.createdAt,
    routes: plan.routes.map((route) => ({
      routeId: route.routeId,
      phoneNumberId: route.phoneNumberId,
      phone: route.phone,
      displayName: route.displayName,
      templateId: route.templateId,
      configuredTps: route.configuredTps,
      providerTpsLimit: route.providerTpsLimit,
    })),
    templates: plan.templatesSnapshot.map((template) => {
      const described = describeTemplate(template);
      return {
        id: template.id,
        name: template.name,
        language: template.language,
        body: template.body,
        headerKind: described.headerKind,
        requiredVariables: described.requiredVariables,
      };
    }),
    mappings: plan.mappingsSnapshot,
  };
}

function renderText(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index) => values[index] ?? match);
}

// Shared by the single-contact preview and the bulk recipient search so both
// can never disagree about what a contact's frozen allocation resolves to --
// this is the same pure resolveTemplateVariables() core the live send path
// uses, just wrapped once for reuse instead of duplicated per caller.
function resolveContactMessage(
  template: CampaignPlan["templatesSnapshot"][number],
  mappingRows: ResolvableMapping[],
  contactData: Record<string, string>,
) {
  let resolvedParameters: Record<string, Record<string, string>> = { header: {}, body: {}, button: {} };
  let resolutionError: string | undefined;
  try {
    resolvedParameters = resolveTemplateVariables(template, mappingRows, contactData);
  } catch (error) {
    resolutionError = error instanceof Error ? error.message : "Resolution failed";
  }

  const header = template.components.find((component) => String(component.type).toUpperCase() === "HEADER");
  const renderedHeader = header && typeof header.text === "string"
    ? renderText(header.text, resolvedParameters.header ?? {})
    : null;

  return {
    resolvedParameters,
    renderedHeader,
    renderedBody: renderText(template.body, resolvedParameters.body ?? {}),
    resolutionError,
  };
}

/**
 * Resolves exactly what message one specific contact under the active
 * frozen plan will receive (or already received, if the campaign has since
 * executed): which route/phone number and frozen template they were
 * deterministically allocated to, and every variable value the frozen
 * mapping snapshot resolves for that contact. Reuses the identical pure
 * resolution core the live send path uses (resolveTemplateVariables), so
 * this can never show a different answer than what dispatch actually did
 * or will do.
 */
export async function previewPlanContact(
  organizationId: number,
  campaignId: number,
  lookup: { contactId: number } | { phone: string },
) {
  const plan = await getActivePlan(organizationId, campaignId);
  if (!plan) throw new PlanPreviewNotFoundError("Campaign has no frozen execution plan; run plan before previewing");

  let contactCondition;
  if ("contactId" in lookup) {
    contactCondition = eq(campaignContactsTable.id, lookup.contactId);
  } else {
    const normalized = normalizePhone(lookup.phone);
    if (!normalized.value) throw new PlanPreviewNotFoundError(normalized.error ?? "Invalid phone number");
    contactCondition = eq(campaignContactsTable.normalizedPhone, normalized.value);
  }

  const [contact] = await db.select().from(campaignContactsTable).where(and(
    eq(campaignContactsTable.organizationId, organizationId),
    eq(campaignContactsTable.campaignId, campaignId),
    contactCondition,
  ));
  if (!contact) throw new PlanPreviewNotFoundError("Contact not found in this campaign");

  const [allocation] = await db.select().from(campaignAllocationsTable).where(and(
    eq(campaignAllocationsTable.organizationId, organizationId),
    eq(campaignAllocationsTable.campaignId, campaignId),
    eq(campaignAllocationsTable.planId, plan.id),
    eq(campaignAllocationsTable.contactId, contact.id),
  ));
  if (!allocation) {
    throw new PlanPreviewNotFoundError(
      "Contact has no allocation under the active plan (invalid/duplicate/suppressed row, or the plan predates this contact)",
    );
  }

  const template = plan.templatesSnapshot.find((candidate) => candidate.id === allocation.templateId);
  if (!template) throw new PlanPreviewNotFoundError("Allocated template is missing from the frozen plan snapshot");
  const route = plan.routes.find((candidate) => candidate.routeId === allocation.routeId);
  const mappingRows: ResolvableMapping[] = plan.mappingsSnapshot.filter(
    (mapping) => mapping.templateId === allocation.templateId,
  );

  const resolved = resolveContactMessage(template, mappingRows, contact.data);

  return {
    contactId: contact.id,
    normalizedPhone: contact.normalizedPhone,
    planId: plan.id,
    planVersion: plan.version,
    routeId: allocation.routeId,
    phoneNumberId: route?.phoneNumberId ?? null,
    phone: route?.phone ?? null,
    phoneDisplayName: route?.displayName ?? null,
    configuredTps: route?.configuredTps ?? null,
    providerTpsLimit: route?.providerTpsLimit ?? null,
    templateId: template.id,
    templateName: template.name,
    templateLanguage: template.language,
    ...resolved,
  };
}

/**
 * Support/ops bulk view: page through (and optionally search) every
 * recipient allocated under the active frozen plan, each with its resolved
 * message -- the same resolution core previewPlanContact uses for a single
 * contact, just applied across a page instead of one lookup at a time.
 */
export async function searchPlanRecipients(
  organizationId: number,
  campaignId: number,
  { search, limit = 25, offset = 0 }: { search?: string; limit?: number; offset?: number },
) {
  const plan = await getActivePlan(organizationId, campaignId);
  if (!plan) throw new PlanPreviewNotFoundError("Campaign has no frozen execution plan; run plan before previewing");

  const searchCondition = search?.trim()
    ? or(
        ilike(campaignContactsTable.normalizedPhone, `%${search.trim()}%`),
        ilike(campaignContactsTable.rawPhone, `%${search.trim()}%`),
        ilike(sql<string>`${campaignContactsTable.data}::text`, `%${search.trim()}%`),
      )
    : undefined;

  const baseCondition = and(
    eq(campaignAllocationsTable.organizationId, organizationId),
    eq(campaignAllocationsTable.campaignId, campaignId),
    eq(campaignAllocationsTable.planId, plan.id),
    searchCondition,
  );

  const [totalRow] = await db.select({ total: count() })
    .from(campaignAllocationsTable)
    .innerJoin(campaignContactsTable, eq(campaignContactsTable.id, campaignAllocationsTable.contactId))
    .where(baseCondition);

  const rows = await db.select({
    contactId: campaignContactsTable.id,
    normalizedPhone: campaignContactsTable.normalizedPhone,
    data: campaignContactsTable.data,
    routeId: campaignAllocationsTable.routeId,
    templateId: campaignAllocationsTable.templateId,
    phoneNumberId: campaignAllocationsTable.phoneNumberId,
  })
    .from(campaignAllocationsTable)
    .innerJoin(campaignContactsTable, eq(campaignContactsTable.id, campaignAllocationsTable.contactId))
    .where(baseCondition)
    .orderBy(asc(campaignContactsTable.id))
    .limit(limit)
    .offset(offset);

  const recipients = rows.map((row) => {
    const frozenRoute = row.routeId != null ? plan.routes.find((candidate) => candidate.routeId === row.routeId) : undefined;
    const phone = frozenRoute?.phone ?? null;
    const template = plan.templatesSnapshot.find((candidate) => candidate.id === row.templateId);
    if (!template) {
      return {
        contactId: row.contactId,
        normalizedPhone: row.normalizedPhone,
        routeId: row.routeId,
        phoneNumberId: row.phoneNumberId,
        phone,
        templateId: row.templateId,
        templateName: "(missing from frozen snapshot)",
        resolvedParameters: { header: {}, body: {}, button: {} },
        renderedHeader: null,
        renderedBody: "",
        resolutionError: "Allocated template is missing from the frozen plan snapshot",
      };
    }
    const mappingRows: ResolvableMapping[] = plan.mappingsSnapshot.filter(
      (mapping) => mapping.templateId === row.templateId,
    );
    const resolved = resolveContactMessage(template, mappingRows, row.data);
    return {
      contactId: row.contactId,
      normalizedPhone: row.normalizedPhone,
      routeId: row.routeId,
      phoneNumberId: row.phoneNumberId,
      phone,
      templateId: template.id,
      templateName: template.name,
      ...resolved,
    };
  });

  return {
    planId: plan.id,
    planVersion: plan.version,
    total: totalRow?.total ?? 0,
    limit,
    offset,
    recipients,
  };
}
