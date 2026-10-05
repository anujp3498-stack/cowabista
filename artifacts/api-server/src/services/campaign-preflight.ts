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
import { decidePair, describePhone, loadCompatibilityState, type CompatibilityState, type EligibilityReasonCode } from "./template-eligibility";
import { isDeliveryMode, resolveCampaignDelivery } from "./campaign-delivery";
import type { IssueContext, PreflightIssueCode, PreflightIssueSubject } from "./campaign-preflight-issues";
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

/** A readiness rule violation: the exact legacy string plus its stable catalogue code (V2-06B). */
export type ReadinessIssue = {
  code: PreflightIssueCode;
  /** The exact string GET .../readiness and Plan report (unchanged wording). */
  message: string;
  subject: PreflightIssueSubject;
  /** Labels for the business-facing catalogue copy. */
  context: IssueContext;
};

/** Catalogue code for a V2-04 decision that is not eligible. */
export function compatibilityIssueCode(code: EligibilityReasonCode): PreflightIssueCode {
  switch (code) {
    case "credential_inactive":
    case "credential_unbound":
      return "credential_not_ready";
    case "legacy_waba_not_claimed":
      return "provider_not_ready";
    case "phone_sample":
    case "phone_not_connected":
    case "phone_no_provider_identity":
    case "phone_no_waba":
      return "sender_unusable";
    case "waba_mismatch":
      return "pair_incompatible";
    default:
      return "template_unusable";
  }
}

/**
 * The ONE campaign readiness rule set (V2-06B refactor of the V2-04/05/06A
 * rules, wording unchanged): every Plan/Execute/readiness caller and the
 * structured preflight run exactly this, so a deterministic local rule can
 * never pass in one and fail in the other. Each violation carries a stable
 * catalogue code; validateCampaignReady maps them back to the legacy strings.
 */
export async function collectReadinessIssues(organizationId: number, campaignId: number, preloaded?: ReadinessContext): Promise<{ issues: ReadinessIssue[]; context: ReadinessContext }> {
  const issues: ReadinessIssue[] = [];
  const context = preloaded ?? await loadReadinessContext(organizationId, campaignId);
  const { routes, selectedTemplateIds, state, distributionMode, deliveryMode } = context;
  const phoneLabel = (id: number) => { const phone = state.phones.get(id); return phone ? phone.displayName || phone.phone : undefined; };
  const templateLabel = (id: number) => state.templates.get(id)?.name;
  const add = (code: PreflightIssueCode, message: string, subject: PreflightIssueSubject = {}, extra: IssueContext = {}) => {
    issues.push({
      code, message, subject,
      context: { phone: subject.phoneNumberId === undefined ? undefined : phoneLabel(subject.phoneNumberId), template: subject.templateId === undefined ? undefined : templateLabel(subject.templateId), column: subject.column, ...extra },
    });
  };
  const v2 = distributionMode !== null;
  // V2-06B: with a delivery mode, a route's own configured rate is not what
  // runs (planning freezes the resolved rate), so the route-rate rules give
  // way to the delivery resolution below.
  const resolvedDelivery = deliveryMode !== null;
  if (v2 && distributionMode !== "equal_numbers" && distributionMode !== "equal_templates") add("distribution_invalid", `Unsupported distribution mode ${distributionMode}`);
  const selectedForLane = new Set(selectedTemplateIds);
  if (!routes.length) add("no_senders", "Add at least one sending route");
  for (const route of routes) {
    const subject = { routeId: route.id, phoneNumberId: route.phoneNumberId };
    const phone = state.phones.get(route.phoneNumberId);
    if (!phone) { add("sender_unusable", `Route ${route.id} needs a tenant-owned phone number`, subject); continue; }
    if (route.routeWabaId !== null && route.routeWabaId !== phone.wabaId) {
      add("sender_configuration_stale", `Route ${route.id} was configured for a different WhatsApp Business Account than its phone now belongs to; recreate the route`, subject);
    }
    if (!resolvedDelivery) {
      if (!Number.isInteger(phone.tpsLimit) || phone.tpsLimit < 1) {
        add("sender_rate_unavailable", `Route ${route.id} phone has no valid provider-approved TPS limit`, subject);
      }
      if (!Number.isInteger(route.configuredTps) || route.configuredTps < 1) {
        add("rate_invalid", `Route ${route.id} TPS must be a positive integer`, subject);
      } else if (phone.tpsLimit >= 1 && route.configuredTps > phone.tpsLimit) {
        add("rate_above_ceiling", `Route ${route.id} TPS exceeds its phone provider cap of ${phone.tpsLimit}`, subject, { max: phone.tpsLimit });
      }
    }
    if (v2) {
      // Allocator v2 lane: the number must be able to send at least one
      // selected template (the V2-04 decision); its default template is only
      // a fallback and must be one of those.
      const laneTemplates = [...selectedForLane].filter((templateId) => decidePair(state, route.phoneNumberId, templateId).eligible);
      if (!laneTemplates.length) {
        const reasons = [...new Set([...selectedForLane].map((templateId) => decidePair(state, route.phoneNumberId, templateId).message))];
        const phoneVerdict = describePhone(state, route.phoneNumberId);
        add(phoneVerdict.ok ? "sender_without_template" : compatibilityIssueCode(phoneVerdict.code), `Route ${route.id}: the number cannot send any selected template${reasons.length ? ` (${reasons.join("; ")})` : ""}`, subject);
      } else if (route.templateId === null || !laneTemplates.includes(route.templateId)) {
        add("sender_configuration_stale", `Route ${route.id}: its default template is not one the number can send; save the message setup again`, subject);
      }
      continue;
    }
    if (route.templateId === null || !state.templates.has(route.templateId)) { add("template_unusable", `Route ${route.id} needs a tenant-owned template`, subject); continue; }
    const decision = decidePair(state, route.phoneNumberId, route.templateId);
    if (!decision.eligible) add(compatibilityIssueCode(decision.code), `Route ${route.id}: ${decision.message} (${decision.code})`, { ...subject, templateId: route.templateId });
  }
  if (v2) {
    // One sender lane per number, each marked as a shared-budget lane.
    const phones = new Set<number>();
    for (const route of routes) {
      const subject = { routeId: route.id, phoneNumberId: route.phoneNumberId };
      if (!route.sharedPhoneBudget) add("sender_configuration_stale", `Route ${route.id} is not a sender lane for the chosen distribution; save the message setup again`, subject);
      if (phones.has(route.phoneNumberId)) add("sender_configuration_stale", `Number ${route.phoneNumberId} has more than one sender lane; save the message setup again`, subject);
      phones.add(route.phoneNumberId);
    }
  }
  const selectedIds = new Set(selectedTemplateIds);
  if (!v2) {
    for (const route of routes) {
      if (route.templateId && !selectedIds.has(route.templateId)) add("sender_configuration_stale", `Route ${route.id} template ${route.templateId} is not selected`, { routeId: route.id, templateId: route.templateId });
    }
  }
  // Every selected template must have at least one eligible route (the
  // Rocket coverage rule, re-checked here so no sibling path can leave a
  // selected template without a sender). v1: a route assigned to that
  // template; v2: any sender lane whose number can send it.
  for (const templateId of selectedTemplateIds) {
    const covered = routes.some((route) => (v2 || route.templateId === templateId) && decidePair(state, route.phoneNumberId, templateId).eligible);
    if (!covered) add("template_without_sender", `Template ${templateId} has no eligible sending route`, { templateId });
  }
  const templates = selectedIds.size ? await db.select({
    id: templatesTable.id, body: templatesTable.body, components: templatesTable.components,
  }).from(templatesTable).where(and(
    eq(templatesTable.organizationId, organizationId),
    inArray(templatesTable.id, [...selectedIds]),
  )) : [];
  if (templates.length !== selectedIds.size) add("template_unusable", "One or more selected templates no longer belongs to this organization");
  if (!selectedIds.size) add("no_templates", "Select at least one template");
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
        add("mapping_missing", `Template ${descriptor.templateId} is missing mapping ${requirement}`, { templateId: descriptor.templateId });
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
    add("csv_column_missing", column === "some"
      ? `CSV column "${mapping.sourceValue}" required by template ${mapping.templateId} is missing from some uploads of the audience; make the mapping optional with a fallback or re-upload`
      : `CSV column "${mapping.sourceValue}" required by template ${mapping.templateId} is missing from the latest import`, { templateId: mapping.templateId, column: mapping.sourceValue });
  }

  // Per-template media header (V2-05B). An uploaded campaign file must be
  // this campaign's, ready, and of the header's kind; it also needs a
  // transport that can upload it (workspace credential, or the local mock).
  const mediaMappings = mappings.filter((mapping) => mapping.source === "media_asset" && selectedIds.has(mapping.templateId));
  const assets = await loadCampaignMediaAssets(organizationId, campaignId, mediaMappings.map((mapping) => mapping.mediaAssetId ?? Number(mapping.sourceValue)));
  const kindByTemplate = new Map(descriptors.map((descriptor) => [descriptor.templateId, descriptor.headerKind]));
  for (const mapping of mediaMappings) {
    const assetId = mapping.mediaAssetId ?? Number(mapping.sourceValue);
    const asset = assets.get(assetId);
    const kind = kindByTemplate.get(mapping.templateId);
    const subject = { templateId: mapping.templateId, ...(Number.isInteger(assetId) ? { mediaAssetId: assetId } : {}) };
    if (mapping.component !== "header" || mapping.variable !== "media") {
      add("mapping_invalid", `Template ${mapping.templateId} uses an uploaded file outside its media header`, subject);
    } else if (!asset || asset.status !== "ready") {
      add("media_missing", `The header file for template ${mapping.templateId} is no longer available; choose another file`, subject);
    } else if (asset.kind !== kind) {
      add("media_wrong_kind", `Template ${mapping.templateId} needs a ${kind} header but its file ${asset.fileName} is a ${asset.kind}`, subject, { kind: asset.kind, expectedKind: kind });
    } else {
      for (const route of routes) {
        // The routes that can send this template: v1 the route assigned to
        // it; v2 every lane whose number can send it.
        const sends = v2 ? decidePair(state, route.phoneNumberId, mapping.templateId).eligible : route.templateId === mapping.templateId;
        if (!sends) continue;
        if (describePhone(state, route.phoneNumberId).transport === "legacy_connector") {
          add("media_transport_unsupported", `Route ${route.id}: campaign media files need a number connected with its own workspace credential (the shared connector cannot upload them)`, { ...subject, routeId: route.id, phoneNumberId: route.phoneNumberId });
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
    if (!execution.executable) add("selection_not_runnable", `Message setup: ${execution.message}`);
  }

  if (!resolvedDelivery) {
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
        add("rate_above_ceiling", `Phone number ${phoneNumberId} has routes configured for ${total} combined TPS, exceeding its provider limit of ${limit}`, { phoneNumberId }, { max: limit });
      }
    }
  } else {
    // V2-06B delivery: the exact resolution planning freezes (same resolver,
    // same lanes, same settings), so a speed problem blocks both here and Plan.
    if (!isDeliveryMode(deliveryMode)) {
      add("delivery_required", `Unsupported delivery mode ${deliveryMode}`);
    } else if (distributionMode === null) {
      add("distribution_required", "A sending speed applies to a distribution; choose a distribution in the Delivery step");
    } else {
      const resolution = resolveCampaignDelivery(state, [...new Set(routes.map((route) => route.phoneNumberId))], deliveryMode, context.deliverySettings);
      for (const problem of resolution.problems) {
        add(problem.code, problem.detail, problem.phoneNumberId === null ? {} : { phoneNumberId: problem.phoneNumberId }, { max: problem.maxMessagesPerSecond });
      }
    }
  }

  return { issues, context };
}

export async function validateCampaignReady(organizationId: number, campaignId: number): Promise<string[]> {
  const { issues } = await collectReadinessIssues(organizationId, campaignId);
  return [...new Set(issues.map((issue) => issue.message))];
}

/** Phone ids and template ids a campaign currently involves, for its compatibility matrix. */
export async function campaignSelectionIds(organizationId: number, campaignId: number): Promise<{ phoneIds: number[]; templateIds: number[] }> {
  const context = await loadReadinessContext(organizationId, campaignId);
  return {
    phoneIds: [...new Set(context.routes.map((route) => route.phoneNumberId))],
    templateIds: [...new Set([...context.selectedTemplateIds, ...context.routes.flatMap((route) => (route.templateId === null ? [] : [route.templateId]))])],
  };
}

