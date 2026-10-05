import { and, eq, inArray } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
  db,
  templatesTable,
} from "@workspace/db";
import { describeTemplate } from "./template-mapping";
import { decidePair, describePhone, loadCompatibilityState, type CompatibilityState } from "./template-eligibility";
import { campaignsTable, type CampaignDistributionMode } from "@workspace/db";
import { campaignMessageSetupsTable } from "@workspace/db";
import { loadCampaignMediaAssets } from "./campaign-media-assets";
import { activeAudienceColumns, executionFor } from "./message-studio";

// Campaign readiness (question D of the compatibility model): the campaign's
// own selection/mapping/TPS/import rules, on top of the shared sender-
// template decision (questions A-C in template-eligibility.ts). Every
// Plan/Execute/readiness caller runs exactly this.

export type ReadinessContext = {
  routes: Array<{ id: number; phoneNumberId: number; templateId: number | null; configuredTps: number; routeWabaId: number | null; sharedPhoneBudget: boolean }>;
  /** null = allocator v1; a mode = allocator v2 (V2-06A). */
  distributionMode: CampaignDistributionMode | null;
  /** V2-06B: null = each route's configured rate is frozen (pre-V2-06B); a mode = resolved per sender at planning. */
  deliveryMode: string | null;
  deliverySettings: unknown;
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
    sharedPhoneBudget: campaignRoutesTable.sharedPhoneBudget,
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
  const [campaign] = await db.select({ distributionMode: campaignsTable.distributionMode, deliveryMode: campaignsTable.deliveryMode, deliverySettings: campaignsTable.deliverySettings }).from(campaignsTable)
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.organizationId, organizationId)));
  const distributionMode = (campaign?.distributionMode ?? null) as CampaignDistributionMode | null;
  return { routes, selectedTemplateIds, state, distributionMode, deliveryMode: campaign?.deliveryMode ?? null, deliverySettings: campaign?.deliverySettings ?? null };
}

export async function validateCampaignReady(organizationId: number, campaignId: number): Promise<string[]> {
  const errors: string[] = [];
  const context = await loadReadinessContext(organizationId, campaignId);
  const { routes, selectedTemplateIds, state, distributionMode } = context;
  const v2 = distributionMode !== null;
  if (v2 && distributionMode !== "equal_numbers" && distributionMode !== "equal_templates") errors.push(`Unsupported distribution mode ${distributionMode}`);
  const selectedForLane = new Set(selectedTemplateIds);
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
    if (v2) {
      // Allocator v2 lane: the number must be able to send at least one
      // selected template (the V2-04 decision); its default template is only
      // a fallback and must be one of those.
      const laneTemplates = [...selectedForLane].filter((templateId) => decidePair(state, route.phoneNumberId, templateId).eligible);
      if (!laneTemplates.length) {
        const reasons = [...new Set([...selectedForLane].map((templateId) => decidePair(state, route.phoneNumberId, templateId).message))];
        errors.push(`Route ${route.id}: the number cannot send any selected template${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
      } else if (route.templateId === null || !laneTemplates.includes(route.templateId)) {
        errors.push(`Route ${route.id}: its default template is not one the number can send; save the message setup again`);
      }
      continue;
    }
    if (route.templateId === null || !state.templates.has(route.templateId)) { errors.push(`Route ${route.id} needs a tenant-owned template`); continue; }
    const decision = decidePair(state, route.phoneNumberId, route.templateId);
    if (!decision.eligible) errors.push(`Route ${route.id}: ${decision.message} (${decision.code})`);
  }
  if (v2) {
    // One sender lane per number, each marked as a shared-budget lane.
    const phones = new Set<number>();
    for (const route of routes) {
      if (!route.sharedPhoneBudget) errors.push(`Route ${route.id} is not a sender lane for the chosen distribution; save the message setup again`);
      if (phones.has(route.phoneNumberId)) errors.push(`Number ${route.phoneNumberId} has more than one sender lane; save the message setup again`);
      phones.add(route.phoneNumberId);
    }
  }
  const selectedIds = new Set(selectedTemplateIds);
  if (!v2) {
    for (const route of routes) {
      if (route.templateId && !selectedIds.has(route.templateId)) errors.push(`Route ${route.id} template ${route.templateId} is not selected`);
    }
  }
  // Every selected template must have at least one eligible route (the
  // Rocket coverage rule, re-checked here so no sibling path can leave a
  // selected template without a sender). v1: a route assigned to that
  // template; v2: any sender lane whose number can send it.
  for (const templateId of selectedTemplateIds) {
    const covered = routes.some((route) => (v2 || route.templateId === templateId) && decidePair(state, route.phoneNumberId, templateId).eligible);
    if (!covered) errors.push(`Template ${templateId} has no eligible sending route`);
  }
  const templates = selectedIds.size ? await db.select({
    id: templatesTable.id, body: templatesTable.body, components: templatesTable.components,
  }).from(templatesTable).where(and(
    eq(templatesTable.organizationId, organizationId),
    inArray(templatesTable.id, [...selectedIds]),
  )) : [];
  if (templates.length !== selectedIds.size) errors.push("One or more selected templates no longer belongs to this organization");
  if (!selectedIds.size) errors.push("Select at least one template");
  const descriptors = templates.map(describeTemplate);
  // V2-05B: templates with different header kinds may be combined; each
  // template's media header is validated on its own (below), replacing the
  // old "one header kind per campaign" rule.
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
  // Columns of the ACTIVE audience generation (V2-05A/B), never a replaced
  // one. A required CSV mapping needs a column every completed upload of
  // that audience has; a column only some uploads have would leave rows
  // without a value, so only an optional mapping with a fallback may use it.
  const audience = await activeAudienceColumns(db, organizationId, campaignId);
  const availability = new Map(audience.columns.map((column) => [column.name, column.availability]));
  for (const mapping of mappings) {
    if (mapping.source !== "csv" || !selectedIds.has(mapping.templateId)) continue;
    const column = availability.get(mapping.sourceValue);
    if (column === "all") continue;
    if (mapping.optional && (mapping.fallbackValue ?? "").trim()) continue;
    errors.push(column === "some"
      ? `CSV column "${mapping.sourceValue}" required by template ${mapping.templateId} is missing from some uploads of the audience; make the mapping optional with a fallback or re-upload`
      : `CSV column "${mapping.sourceValue}" required by template ${mapping.templateId} is missing from the latest import`);
  }

  // Per-template media header (V2-05B). An uploaded campaign file must be
  // this campaign's, ready, and of the header's kind; it also needs a
  // transport that can upload it (workspace credential, or the local mock).
  const mediaMappings = mappings.filter((mapping) => mapping.source === "media_asset" && selectedIds.has(mapping.templateId));
  const assets = await loadCampaignMediaAssets(organizationId, campaignId, mediaMappings.map((mapping) => mapping.mediaAssetId ?? Number(mapping.sourceValue)));
  const kindByTemplate = new Map(descriptors.map((descriptor) => [descriptor.templateId, descriptor.headerKind]));
  for (const mapping of mediaMappings) {
    const asset = assets.get(mapping.mediaAssetId ?? Number(mapping.sourceValue));
    const kind = kindByTemplate.get(mapping.templateId);
    if (mapping.component !== "header" || mapping.variable !== "media") {
      errors.push(`Template ${mapping.templateId} uses an uploaded file outside its media header`);
    } else if (!asset || asset.status !== "ready") {
      errors.push(`The header file for template ${mapping.templateId} is no longer available; choose another file`);
    } else if (asset.kind !== kind) {
      errors.push(`Template ${mapping.templateId} needs a ${kind} header but its file ${asset.fileName} is a ${asset.kind}`);
    } else {
      for (const route of routes) {
        // The routes that can send this template: v1 the route assigned to
        // it; v2 every lane whose number can send it.
        const sends = v2 ? decidePair(state, route.phoneNumberId, mapping.templateId).eligible : route.templateId === mapping.templateId;
        if (!sends) continue;
        if (describePhone(state, route.phoneNumberId).transport === "legacy_connector") {
          errors.push(`Route ${route.id}: campaign media files need a number connected with its own workspace credential (the shared connector cannot upload them)`);
        }
      }
    }
  }

  // Message Studio selection (V2-05B): when a selection was saved that the
  // current engine (allocator v1: one template per number) cannot run, no
  // routes were written; say why instead of only "add a route".
  const [setup] = await db.select({ senders: campaignMessageSetupsTable.senderPhoneNumberIds }).from(campaignMessageSetupsTable).where(and(
    eq(campaignMessageSetupsTable.organizationId, organizationId),
    eq(campaignMessageSetupsTable.campaignId, campaignId),
  ));
  if (setup && setup.senders.length && selectedTemplateIds.length) {
    const setupState = await loadCompatibilityState(organizationId, { phoneIds: setup.senders, templateIds: selectedTemplateIds });
    const execution = executionFor(setupState, setup.senders, selectedTemplateIds, distributionMode);
    if (!execution.executable) errors.push(`Message setup: ${execution.message}`);
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

