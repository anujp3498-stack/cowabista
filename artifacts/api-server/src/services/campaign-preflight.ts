import { and, desc, eq, inArray } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
  db,
  phoneNumbersTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { describeTemplate } from "./template-mapping";

export async function validateCampaignReady(organizationId: number, campaignId: number): Promise<string[]> {
  const errors: string[] = [];
  const routes = await db.select({
    id: campaignRoutesTable.id,
    phoneNumberId: campaignRoutesTable.phoneNumberId,
    phoneOrg: phoneNumbersTable.organizationId,
    phoneWabaId: phoneNumbersTable.wabaId,
    wabaOrg: wabasTable.organizationId,
    templateId: campaignRoutesTable.templateId,
    templateOrg: templatesTable.organizationId,
    templateWabaId: templatesTable.wabaId,
    configuredTps: campaignRoutesTable.configuredTps,
    providerTpsLimit: phoneNumbersTable.tpsLimit,
    phoneStatus: phoneNumbersTable.status,
  }).from(campaignRoutesTable)
    .leftJoin(phoneNumbersTable, and(eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId), eq(phoneNumbersTable.organizationId, organizationId)))
    .leftJoin(wabasTable, and(eq(wabasTable.id, phoneNumbersTable.wabaId), eq(wabasTable.organizationId, organizationId)))
    .leftJoin(templatesTable, and(eq(templatesTable.id, campaignRoutesTable.templateId), eq(templatesTable.organizationId, organizationId)))
    .where(and(eq(campaignRoutesTable.organizationId, organizationId), eq(campaignRoutesTable.campaignId, campaignId)));
  if (!routes.length) errors.push("Add at least one sending route");
  for (const route of routes) {
    if (!route.phoneNumberId || !route.phoneOrg) errors.push(`Route ${route.id} needs a tenant-owned phone number`);
    if (!route.phoneWabaId || !route.wabaOrg) errors.push(`Route ${route.id} phone needs a tenant-owned WABA`);
    if (route.phoneStatus !== "Connected") errors.push(`Route ${route.id} phone must be provider-verified and connected`);
    if (!Number.isInteger(route.providerTpsLimit) || (route.providerTpsLimit ?? 0) < 1) {
      errors.push(`Route ${route.id} phone has no valid provider-approved TPS limit`);
    }
    if (!Number.isInteger(route.configuredTps) || route.configuredTps < 1) {
      errors.push(`Route ${route.id} TPS must be a positive integer`);
    } else if (route.providerTpsLimit && route.configuredTps > route.providerTpsLimit) {
      errors.push(`Route ${route.id} TPS exceeds its phone provider cap of ${route.providerTpsLimit}`);
    }
    if (!route.templateId || !route.templateOrg) errors.push(`Route ${route.id} needs a tenant-owned template`);
    if (route.templateWabaId !== null && route.phoneWabaId && route.templateWabaId !== route.phoneWabaId) {
      errors.push(`Route ${route.id} template WABA does not match its phone number WABA`);
    }
  }
  const selections = await db.select({ templateId: campaignTemplateSelectionsTable.templateId })
    .from(campaignTemplateSelectionsTable).where(and(
      eq(campaignTemplateSelectionsTable.organizationId, organizationId),
      eq(campaignTemplateSelectionsTable.campaignId, campaignId),
    ));
  const selectedIds = new Set(selections.map((row) => row.templateId));
  for (const route of routes) {
    if (route.templateId && !selectedIds.has(route.templateId)) errors.push(`Route ${route.id} template ${route.templateId} is not selected`);
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
    if (!route.phoneNumberId || !Number.isInteger(route.configuredTps) || route.configuredTps < 1) continue;
    const entry = phoneTpsTotals.get(route.phoneNumberId) ?? { total: 0, limit: route.providerTpsLimit ?? 0 };
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