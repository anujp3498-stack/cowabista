import { and, desc, eq, inArray } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
  db,
  templatesTable,
} from "@workspace/db";
import { describeTemplate } from "./template-mapping";
import { decidePair, loadCompatibilityState, type CompatibilityState } from "./template-eligibility";

// Campaign readiness (question D of the compatibility model): the campaign's
// own selection/mapping/TPS/import rules, on top of the shared sender-
// template decision (questions A-C in template-eligibility.ts). Every
// Plan/Execute/readiness caller runs exactly this.

export type ReadinessContext = {
  routes: Array<{ id: number; phoneNumberId: number; templateId: number | null; configuredTps: number; routeWabaId: number | null }>;
  selectedTemplateIds: number[];
  state: CompatibilityState;
};

/** Loads the routes, selections and the shared compatibility state for a campaign (batched; no provider calls). */
export async function loadReadinessContext(organizationId: number, campaignId: number): Promise<ReadinessContext> {
  const routes = await db.select({
    id: campaignRoutesTable.id,
    phoneNumberId: campaignRoutesTable.phoneNumberId,
    templateId: campaignRoutesTable.templateId,
    configuredTps: campaignRoutesTable.configuredTps,
    routeWabaId: campaignRoutesTable.wabaId,
  }).from(campaignRoutesTable)
    .where(and(eq(campaignRoutesTable.organizationId, organizationId), eq(campaignRoutesTable.campaignId, campaignId)))
    .orderBy(campaignRoutesTable.id);
  const selections = await db.select({ templateId: campaignTemplateSelectionsTable.templateId })
    .from(campaignTemplateSelectionsTable).where(and(
      eq(campaignTemplateSelectionsTable.organizationId, organizationId),
      eq(campaignTemplateSelectionsTable.campaignId, campaignId),
    ));
  const selectedTemplateIds = [...new Set(selections.map((row) => row.templateId))];
  const state = await loadCompatibilityState(organizationId, {
    phoneIds: routes.map((route) => route.phoneNumberId),
    templateIds: [...new Set([...selectedTemplateIds, ...routes.flatMap((route) => (route.templateId === null ? [] : [route.templateId]))])],
  });
  return { routes, selectedTemplateIds, state };
}

export async function validateCampaignReady(organizationId: number, campaignId: number): Promise<string[]> {
  const errors: string[] = [];
  const context = await loadReadinessContext(organizationId, campaignId);
  const { routes, selectedTemplateIds, state } = context;
  if (!routes.length) errors.push("Add at least one sending route");
  for (const route of routes) {
    const phone = state.phones.get(route.phoneNumberId);
    if (!phone) { errors.push(`Route ${route.id} needs a tenant-owned phone number`); continue; }
    if (route.routeWabaId !== null && route.routeWabaId !== phone.wabaId) {
      errors.push(`Route ${route.id} was configured for a different WhatsApp Business Account than its phone now belongs to; recreate the route`);
    }
    if (!Number.isInteger(phone.tpsLimit) || phone.tpsLimit < 1) {
      errors.push(`Route ${route.id} phone has no valid provider-approved TPS limit`);
    }
    if (!Number.isInteger(route.configuredTps) || route.configuredTps < 1) {
      errors.push(`Route ${route.id} TPS must be a positive integer`);
    } else if (phone.tpsLimit >= 1 && route.configuredTps > phone.tpsLimit) {
      errors.push(`Route ${route.id} TPS exceeds its phone provider cap of ${phone.tpsLimit}`);
    }
    if (route.templateId === null || !state.templates.has(route.templateId)) { errors.push(`Route ${route.id} needs a tenant-owned template`); continue; }
    const decision = decidePair(state, route.phoneNumberId, route.templateId);
    if (!decision.eligible) errors.push(`Route ${route.id}: ${decision.message} (${decision.code})`);
  }
  const selectedIds = new Set(selectedTemplateIds);
  for (const route of routes) {
    if (route.templateId && !selectedIds.has(route.templateId)) errors.push(`Route ${route.id} template ${route.templateId} is not selected`);
  }
  // Every selected template must have at least one eligible route (the
  // Rocket coverage rule, re-checked here so no sibling path can leave a
  // selected template without a sender).
  for (const templateId of selectedTemplateIds) {
    const covered = routes.some((route) => route.templateId === templateId && decidePair(state, route.phoneNumberId, templateId).eligible);
    if (!covered) errors.push(`Template ${templateId} has no eligible sending route`);
  }
  const templates = selectedIds.size ? await db.select({
    id: templatesTable.id, body: templatesTable.body, components: templatesTable.components,
  }).from(templatesTable).where(and(
    eq(templatesTable.organizationId, organizationId),
    inArray(templatesTable.id, [...selectedIds]),
  )) : [];
  if (templates.length !== selectedIds.size) errors.push("One or more selected templates no longer belongs to this organization");
  const descriptors = templates.map(describeTemplate);
  const headerKinds = new Set(descriptors.map((item) => item.headerKind).filter((kind) => kind !== "none"));
  if (headerKinds.size > 1) errors.push(`Selected templates have incompatible header kinds: ${[...headerKinds].join(", ")}`);
  const mappings = await db.select().from(campaignTemplateMappingsTable).where(and(
    eq(campaignTemplateMappingsTable.organizationId, organizationId),
    eq(campaignTemplateMappingsTable.campaignId, campaignId),
  ));
  const mappingKeys = new Set(mappings.map((row) => `${row.templateId}:${row.component}:${row.variable}`));
  for (const descriptor of descriptors) {
    for (const requirement of descriptor.requiredVariables) {
      const [component, ...variable] = requirement.split(":");
      if (!mappingKeys.has(`${descriptor.templateId}:${component}:${variable.join(":")}`)) {
        errors.push(`Template ${descriptor.templateId} is missing mapping ${requirement}`);
      }
    }
  }
  const [latestImport] = await db.select({ columns: contactImportSessionsTable.columns })
    .from(contactImportSessionsTable).where(and(
      eq(contactImportSessionsTable.organizationId, organizationId),
      eq(contactImportSessionsTable.campaignId, campaignId),
      eq(contactImportSessionsTable.status, "Completed"),
    )).orderBy(desc(contactImportSessionsTable.updatedAt)).limit(1);
  const columns = new Set(latestImport?.columns ?? []);
  for (const mapping of mappings) {
    if (mapping.source !== "csv" || columns.has(mapping.sourceValue)) continue;
    // An optional mapping with a fallback can tolerate a missing CSV column
    // (every row falls back); a required mapping cannot.
    if (mapping.optional && (mapping.fallbackValue ?? "").trim()) continue;
    errors.push(`CSV column "${mapping.sourceValue}" required by template ${mapping.templateId} is missing from the latest import`);
  }

  // Sending/TPS enforcement caps each route individually above, but multiple
  // routes can share one phone number. Reject campaigns whose routes would
  // together demand more throughput than that phone's provider-approved
  // cap instead of letting the runtime silently divide the cap between them.
  const phoneTpsTotals = new Map<number, { total: number; limit: number }>();
  for (const route of routes) {
    const phone = state.phones.get(route.phoneNumberId);
    if (!phone || !Number.isInteger(route.configuredTps) || route.configuredTps < 1) continue;
    const entry = phoneTpsTotals.get(route.phoneNumberId) ?? { total: 0, limit: phone.tpsLimit ?? 0 };
    entry.total += route.configuredTps;
    phoneTpsTotals.set(route.phoneNumberId, entry);
  }
  for (const [phoneNumberId, { total, limit }] of phoneTpsTotals) {
    if (Number.isInteger(limit) && limit >= 1 && total > limit) {
      errors.push(`Phone number ${phoneNumberId} has routes configured for ${total} combined TPS, exceeding its provider limit of ${limit}`);
    }
  }

  return [...new Set(errors)];
}

/** Phone ids and template ids a campaign currently involves, for its compatibility matrix. */
export async function campaignSelectionIds(organizationId: number, campaignId: number): Promise<{ phoneIds: number[]; templateIds: number[] }> {
  const context = await loadReadinessContext(organizationId, campaignId);
  return {
    phoneIds: [...new Set(context.routes.map((route) => route.phoneNumberId))],
    templateIds: [...new Set([...context.selectedTemplateIds, ...context.routes.flatMap((route) => (route.templateId === null ? [] : [route.templateId]))])],
  };
}

