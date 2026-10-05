import { and, eq, inArray, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignMediaProviderBindingsTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  contactImportSessionsTable,
  db,
  phoneNumbersTable,
  providerConnectionsTable,
  suppressionsTable,
  templatesTable,
} from "@workspace/db";
import { ALLOCATOR_V1, ALLOCATOR_V2 } from "./allocator-version";
import { CAMPAIGN_PLATFORM_MAX_TPS } from "./campaign-pacing-coordinator";
import { estimateDurationSeconds, isDeliveryMode, resolveCampaignDelivery, type DeliveryResolution } from "./campaign-delivery";
import { activeValidRecipients, selectedSenderIds } from "./campaign-delivery-setup";
import { audienceTotals } from "./campaign-import-lifecycle";
import { loadCampaignMediaAssets } from "./campaign-media-assets";
import { collectReadinessIssues, loadReadinessContext } from "./campaign-preflight";
import { makeIssue, type PreflightIssue, type PreflightIssueCode } from "./campaign-preflight-issues";
import { activeAudienceColumns, templateVerdict } from "./message-studio";
import { MessageStudioError } from "./message-studio-errors";
import { describeTemplate } from "./template-mapping";
import { decidePair, describePhone, loadCompatibilityState } from "./template-eligibility";

// V2-06B structured preflight: a READ of the campaign's current
// configuration for the Rocket flow (and, in V2-06C, Review & Launch).
// It never plans, supersedes, allocates, creates jobs, writes routes or
// provider media bindings, uploads media or calls a provider: only stored
// state is read (indexed counts/aggregates, bounded selections).
//
// Blockers are the shared readiness issues Plan enforces
// (collectReadinessIssues: same rules, same resolver) plus the modern
// Rocket requirements Plan does not impose on engineering paths: an
// audience, a distribution and a speed. Hence: ready => Plan's local rules
// pass. Warnings are facts that do not stop sending.

const COMPATIBILITY_CODES = new Set<PreflightIssueCode>(["sender_without_template", "template_without_sender", "pair_incompatible", "selection_not_runnable"]);
const PROVIDER_CODES = new Set<PreflightIssueCode>(["provider_not_ready", "credential_not_ready"]);

function dedupe(issues: PreflightIssue[]): PreflightIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.technicalDetail ?? ""}|${JSON.stringify(issue.subject)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getCampaignPreflight(organizationId: number, campaignId: number) {
  const [campaign] = await db.select({
    id: campaignsTable.id, status: campaignsTable.status, audienceGeneration: campaignsTable.audienceGeneration,
    distributionMode: campaignsTable.distributionMode, deliveryMode: campaignsTable.deliveryMode, deliverySettings: campaignsTable.deliverySettings,
  }).from(campaignsTable).where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.organizationId, organizationId)));
  if (!campaign) throw new MessageStudioError("not_found", "Campaign not found", 404);

  // Shared readiness: exactly the rules Plan enforces.
  const readinessContext = await loadReadinessContext(organizationId, campaignId);
  const { issues: readinessIssues } = await collectReadinessIssues(organizationId, campaignId, readinessContext);
  const blockers: PreflightIssue[] = readinessIssues.map((issue) => makeIssue(issue.code, issue.context, issue.subject, issue.message));

  // ---------------------------------------------------------- recipients
  const totals = await audienceTotals(db, organizationId, campaignId, campaign.audienceGeneration);
  const valid = await activeValidRecipients(db, organizationId, campaignId, campaign.audienceGeneration);
  // Valid rows whose number opted out after import (send preparation skips
  // them): one indexed join count, never a materialised list.
  const [{ suppressedSinceImport }] = await db.select({ suppressedSinceImport: sql<number>`count(*)::int` })
    .from(campaignContactsTable)
    .innerJoin(suppressionsTable, and(eq(suppressionsTable.organizationId, campaignContactsTable.organizationId), eq(suppressionsTable.normalizedPhone, campaignContactsTable.normalizedPhone)))
    .where(and(
      eq(campaignContactsTable.organizationId, organizationId),
      eq(campaignContactsTable.campaignId, campaignId),
      eq(campaignContactsTable.audienceGeneration, campaign.audienceGeneration),
      eq(campaignContactsTable.status, "Valid"),
    ));
  const [activeImport] = await db.select({ id: contactImportSessionsTable.id }).from(contactImportSessionsTable).where(and(
    eq(contactImportSessionsTable.organizationId, organizationId), eq(contactImportSessionsTable.campaignId, campaignId), eq(contactImportSessionsTable.status, "Processing"),
  )).limit(1);

  // Modern Rocket requirements (Plan does not impose them on engineering paths).
  const once = (code: PreflightIssueCode) => { if (!blockers.some((issue) => issue.code === code)) blockers.push(makeIssue(code)); };
  if (activeImport) once("import_in_progress");
  if (valid < 1) once("audience_empty");
  if (!campaign.distributionMode) once("distribution_required");
  if (!campaign.deliveryMode) once("delivery_required");

  // ------------------------------------------------- senders / templates
  const senderIds = await selectedSenderIds(db, organizationId, campaignId);
  const templateIds = readinessContext.selectedTemplateIds;
  const state = await loadCompatibilityState(organizationId, { phoneIds: senderIds, templateIds });
  const phoneRows = senderIds.length ? await db.select({
    id: phoneNumbersTable.id, setupState: phoneNumbersTable.setupState, quality: phoneNumbersTable.quality, lastSyncedAt: phoneNumbersTable.lastSyncedAt,
  }).from(phoneNumbersTable).where(and(eq(phoneNumbersTable.organizationId, organizationId), inArray(phoneNumbersTable.id, senderIds))) : [];
  const phoneRowById = new Map(phoneRows.map((row) => [row.id, row]));

  let resolution: DeliveryResolution | null = null;
  if (isDeliveryMode(campaign.deliveryMode)) {
    resolution = resolveCampaignDelivery(state, senderIds, campaign.deliveryMode, campaign.deliverySettings);
  }
  const resolvedRate = (phoneNumberId: number) => resolution?.perSender.find((entry) => entry.phoneNumberId === phoneNumberId) ?? null;

  const senders = senderIds.flatMap((phoneNumberId) => {
    const phone = state.phones.get(phoneNumberId);
    if (!phone) return [];
    const row = phoneRowById.get(phoneNumberId);
    const verdict = describePhone(state, phoneNumberId);
    const rate = resolvedRate(phoneNumberId);
    return [{
      phoneNumberId,
      phone: phone.phone,
      displayName: phone.displayName,
      status: phone.status,
      setupState: row?.setupState ?? "unknown",
      // The stored quality column defaults to "High"; only a value synced
      // from the provider is reported, otherwise it is unknown.
      quality: row?.lastSyncedAt ? row.quality : null,
      transport: verdict.transport,
      usable: verdict.ok,
      providerApprovedRate: phone.tpsLimit,
      effectiveCeiling: rate?.effectiveCeiling ?? (Number.isInteger(phone.tpsLimit) && phone.tpsLimit >= 1 ? Math.min(phone.tpsLimit, CAMPAIGN_PLATFORM_MAX_TPS) : null),
      plannedRate: rate?.plannedRate ?? null,
      eligibleTemplateIds: templateIds.filter((templateId) => decidePair(state, phoneNumberId, templateId).eligible),
    }];
  });

  const templateRows = templateIds.length ? await db.select({
    id: templatesTable.id, name: templatesTable.name, language: templatesTable.language, status: templatesTable.status, body: templatesTable.body,
    components: templatesTable.components, providerTemplateId: templatesTable.providerTemplateId, isSample: templatesTable.isSample, metadata: templatesTable.metadata,
  }).from(templatesTable).where(and(eq(templatesTable.organizationId, organizationId), inArray(templatesTable.id, templateIds))) : [];
  const mappings = templateIds.length ? await db.select().from(campaignTemplateMappingsTable).where(and(
    eq(campaignTemplateMappingsTable.organizationId, organizationId), eq(campaignTemplateMappingsTable.campaignId, campaignId), inArray(campaignTemplateMappingsTable.templateId, templateIds),
  )) : [];
  const audience = await activeAudienceColumns(db, organizationId, campaignId);
  const availability = new Map(audience.columns.map((column) => [column.name, column.availability]));
  const headerKindById = new Map<number, string>();
  const templates = templateRows.sort((a, b) => a.id - b.id).map((row) => {
    const described = describeTemplate({ id: row.id, body: row.body, components: row.components });
    headerKindById.set(row.id, described.headerKind);
    const mapped = new Set(mappings.filter((mapping) => mapping.templateId === row.id).map((mapping) => `${mapping.component}:${mapping.variable}`));
    return {
      templateId: row.id,
      name: row.name,
      language: row.language,
      status: row.status,
      headerKind: described.headerKind,
      usable: templateVerdict(row).usable,
      eligibleSenderIds: senderIds.filter((phoneNumberId) => decidePair(state, phoneNumberId, row.id).eligible),
      missingVariables: described.requiredVariables.filter((key) => !mapped.has(key)),
      missingColumns: [...new Set(mappings.filter((mapping) => mapping.templateId === row.id && mapping.source === "csv"
        && availability.get(mapping.sourceValue) !== "all" && !(mapping.optional && (mapping.fallbackValue ?? "").trim())).map((mapping) => mapping.sourceValue))],
    };
  });

  // Ineligible selected pairs are information (under allocator v2 a mixed
  // selection is normal); whether the selection can run is decided by the
  // shared blockers.
  const compatibilityProblems = senders.flatMap((sender) => templateIds.flatMap((templateId) => {
    const decision = decidePair(state, sender.phoneNumberId, templateId);
    return decision.eligible ? [] : [{ phoneNumberId: sender.phoneNumberId, templateId, code: decision.code, message: decision.message }];
  }));

  // ---------------------------------------------------------------- media
  // Read-only: asset state and whether a provider copy already exists for
  // every number that may send the template. Never creates a binding (Plan
  // does) and never returns a provider media id.
  const mediaMappings = mappings.filter((mapping) => mapping.source === "media_asset");
  const assetIds = mediaMappings.map((mapping) => mapping.mediaAssetId ?? Number(mapping.sourceValue)).filter((id) => Number.isInteger(id));
  const assets = await loadCampaignMediaAssets(organizationId, campaignId, assetIds);
  const bindings = assetIds.length && senderIds.length ? await db.select({
    mediaAssetId: campaignMediaProviderBindingsTable.mediaAssetId, phoneNumberId: campaignMediaProviderBindingsTable.phoneNumberId, expiresAt: campaignMediaProviderBindingsTable.expiresAt,
  }).from(campaignMediaProviderBindingsTable).where(and(
    eq(campaignMediaProviderBindingsTable.organizationId, organizationId),
    inArray(campaignMediaProviderBindingsTable.mediaAssetId, assetIds),
    inArray(campaignMediaProviderBindingsTable.phoneNumberId, senderIds),
  )) : [];
  const now = Date.now();
  const media = mediaMappings.map((mapping) => {
    const assetId = mapping.mediaAssetId ?? Number(mapping.sourceValue);
    const asset = assets.get(assetId);
    const expectedKind = headerKindById.get(mapping.templateId) ?? "none";
    const sendingNumbers = senderIds.filter((phoneNumberId) => decidePair(state, phoneNumberId, mapping.templateId).eligible);
    return {
      templateId: mapping.templateId,
      mediaAssetId: Number.isInteger(assetId) ? assetId : null,
      fileName: asset?.fileName ?? null,
      kind: asset?.kind ?? null,
      expectedKind,
      status: asset?.status ?? null,
      ok: Boolean(asset && asset.status === "ready" && asset.kind === expectedKind),
      providerPrepared: sendingNumbers.length > 0 && sendingNumbers.every((phoneNumberId) => bindings.some((binding) => binding.mediaAssetId === assetId && binding.phoneNumberId === phoneNumberId && binding.expiresAt.getTime() > now)),
    };
  });

  // ------------------------------------------------------ provider/health
  const [connection] = await db.select({
    mode: providerConnectionsTable.mode, status: providerConnectionsTable.status, health: providerConnectionsTable.health, lastHealthAt: providerConnectionsTable.lastHealthAt,
  }).from(providerConnectionsTable).where(and(eq(providerConnectionsTable.organizationId, organizationId), eq(providerConnectionsTable.provider, "whatsapp-business")));

  // -------------------------------------------------------------- warnings
  const warnings: PreflightIssue[] = [];
  if (totals.invalid > 0) warnings.push(makeIssue("invalid_rows_skipped", { count: totals.invalid }));
  if (totals.duplicates > 0) warnings.push(makeIssue("duplicates_skipped", { count: totals.duplicates }));
  if (totals.suppressed + suppressedSinceImport > 0) warnings.push(makeIssue("suppressed_skipped", { count: totals.suppressed + suppressedSinceImport }));
  for (const sender of senders) {
    if (sender.quality === "Low") warnings.push(makeIssue("sender_quality_low", { phone: sender.displayName || sender.phone }, { phoneNumberId: sender.phoneNumberId }));
  }

  const finalBlockers = dedupe(blockers);
  const messagesPerSecond = resolution && !resolution.problems.length ? resolution.totalMessagesPerSecond : null;
  const allocatorVersion = campaign.distributionMode ? ALLOCATOR_V2 : ALLOCATOR_V1;
  return {
    campaignId,
    status: campaign.status,
    ready: finalBlockers.length === 0,
    evaluatedAt: new Date().toISOString(),
    recipients: {
      audienceGeneration: campaign.audienceGeneration,
      total: totals.rows,
      valid,
      invalid: totals.invalid,
      duplicate: totals.duplicates,
      suppressed: totals.suppressed,
      suppressedSinceImport,
    },
    senders,
    templates,
    distribution: { mode: campaign.distributionMode ?? null, allocatorVersion },
    delivery: {
      mode: isDeliveryMode(campaign.deliveryMode) ? campaign.deliveryMode : null,
      totalMessagesPerSecond: messagesPerSecond,
      perSender: senders.map((sender) => ({ phoneNumberId: sender.phoneNumberId, effectiveCeiling: sender.effectiveCeiling, plannedRate: sender.plannedRate })),
    },
    compatibility: {
      valid: !finalBlockers.some((issue) => COMPATIBILITY_CODES.has(issue.code)),
      problems: compatibilityProblems,
    },
    estimate: { messagesPerSecond, durationSeconds: estimateDurationSeconds(valid, messagesPerSecond) },
    media,
    provider: {
      mode: connection?.mode ?? "mock",
      status: connection?.status ?? null,
      health: connection?.health ?? null,
      ready: !finalBlockers.some((issue) => PROVIDER_CODES.has(issue.code)),
    },
    health: {
      // Webhook receipt time is not tracked per workspace in an indexed form;
      // reported as unknown rather than estimated.
      lastWebhookEventAt: null,
      lastProviderHealthAt: connection?.lastHealthAt ? connection.lastHealthAt.toISOString() : null,
    },
    warnings,
    blockers: finalBlockers,
    technicalDetails: {
      allocatorVersion,
      platformMaxMessagesPerSecond: CAMPAIGN_PLATFORM_MAX_TPS,
      readinessErrors: [...new Set(readinessIssues.map((issue) => issue.message))],
    },
  };
}
