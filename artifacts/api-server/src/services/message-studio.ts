import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignContactsTable,
  campaignMessageSetupsTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
  db,
  mappingPresetsTable,
  phoneNumbersTable,
  templatesTable,
  wabasTable,
  type CampaignMediaAsset,
} from "@workspace/db";
import { assertSetupEditable, hasExecutionHistory } from "./campaign-import-lifecycle";
import { withCampaignLifecycleLock } from "./campaign-planning";
import { loadCampaignMediaAssets, listCampaignMediaAssets } from "./campaign-media-assets";
import { describeTemplate, requirementLabel, type TemplateMappingInput } from "./template-mapping";
import {
  decidePair,
  describePhone,
  loadCompatibilityState,
  pairSendersToTemplates,
  reasonMessage,
  type CompatibilityState,
  type EligibilityReasonCode,
} from "./template-eligibility";
import { resolveTemplateParameters, type ResolutionIssue, type ResolvableMapping } from "./template-resolution";
import { MessageStudioError } from "./message-studio-errors";

// V2-05B Message Studio service. Everything here is management plane:
// selection, mappings and media references, under the campaign lifecycle
// lock and the existing setup fence (assertSetupEditable). The one
// sender/template decision is V2-04's decidePair; the one execution model
// is allocator v1 (one template per route), which is never reinterpreted:
// routes are written only when v1 can run the selection.

const MAX_CANDIDATES = 200;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MessageMappingInput = TemplateMappingInput;

type TemplateRow = {
  id: number;
  organizationId: number;
  name: string;
  language: string;
  category: string;
  status: string;
  body: string;
  components: Record<string, unknown>[];
  wabaId: number | null;
  providerTemplateId: string | null;
  isSample: boolean;
  metadata: Record<string, unknown> | null;
};

// ------------------------------------------------------------- verdicts

/** Template-level verdict (independent of any number): is this a real, sendable Meta template? */
export function templateVerdict(row: Pick<TemplateRow, "isSample" | "providerTemplateId" | "status" | "metadata"> | undefined): { usable: boolean; code: EligibilityReasonCode | "not_found"; message: string } {
  if (!row) return { usable: false, code: "not_found", message: "Not found in this workspace" };
  if (row.isSample) return { usable: false, code: "template_sample", message: "Sample templates cannot be sent" };
  if (!row.providerTemplateId) return { usable: false, code: "template_not_provider_backed", message: "A local draft, not a template approved at Meta" };
  if (row.metadata?.providerMissing === true || row.status === "Removed") return { usable: false, code: "template_removed", message: "Meta no longer lists this template" };
  if (row.status !== "Approved") return { usable: false, code: "template_not_approved", message: "Not approved at Meta" };
  return { usable: true, code: "eligible", message: "Approved at Meta" };
}

export function requirementsFor(template: Pick<TemplateRow, "id" | "body" | "components">) {
  const described = describeTemplate({ id: template.id, body: template.body, components: template.components });
  return described.requiredVariables.map((key) => {
    const [component, ...rest] = key.split(":");
    return {
      key,
      component: component as "header" | "body" | "button",
      variable: rest.join(":"),
      label: requirementLabel(key, described.headerKind),
      mediaKind: key === "header:media" ? (described.headerKind as "image" | "video" | "document") : null,
    };
  });
}

/**
 * What allocator v1 can run for a selection: every number sends exactly one
 * template, every selected template has a number. Uses the V2-04 pairing
 * (deterministic, request order). A selection v1 cannot run is NOT turned
 * into routes; it is reported so the user can adjust it (or wait for V2-06
 * multi-template sending).
 */
export function executionFor(state: CompatibilityState, senderIds: number[], templateIds: number[]) {
  if (!senderIds.length) return { executable: false, code: "no_senders" as const, message: "Choose at least one sending number.", assignments: [] };
  if (!templateIds.length) return { executable: false, code: "no_templates" as const, message: "Choose at least one template.", assignments: [] };
  const eligible = (phoneId: number, templateId: number) => decidePair(state, phoneId, templateId).eligible;
  const pairing = pairSendersToTemplates(senderIds, templateIds, eligible);
  if (pairing.ok) return { executable: true, code: "ok" as const, message: "Each selected number sends one selected template.", assignments: pairing.assignments };
  const noSender = templateIds.filter((t) => !senderIds.some((p) => eligible(p, t)));
  const noTemplate = senderIds.filter((p) => !templateIds.some((t) => eligible(p, t)));
  if (noSender.length || noTemplate.length) {
    const parts: string[] = [];
    if (noSender.length) parts.push(`${noSender.length} selected template${noSender.length === 1 ? " has" : "s have"} no compatible selected number`);
    if (noTemplate.length) parts.push(`${noTemplate.length} selected number${noTemplate.length === 1 ? " can" : "s can"}not send any selected template`);
    return { executable: false, code: "incompatible" as const, message: `${parts.join("; ")}.`, assignments: [] };
  }
  return {
    executable: false,
    code: "needs_multi_template" as const,
    message: "Every template has a compatible number, but some number would have to send more than one template. Today each number sends one template: add numbers or remove templates. Sending several templates from one number arrives with the next milestone (V2-06).",
    assignments: [],
  };
}

// -------------------------------------------------------- audience schema

/**
 * Columns of the ACTIVE audience generation (V2-05A): the ordered union of
 * the columns of its completed uploads. `all` = every completed upload has
 * the column; `some` = rows from the other uploads have no value for it.
 * Readiness refuses a required CSV mapping to a `some` or absent column
 * (only an optional mapping with a fallback may use it), so a missing value
 * is never fabricated.
 */
export async function activeAudienceColumns(executor: Pick<typeof db, "select">, organizationId: number, campaignId: number) {
  const [campaign] = await executor.select({ audienceGeneration: campaignsTable.audienceGeneration }).from(campaignsTable)
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.organizationId, organizationId)));
  if (!campaign) return { audienceGeneration: 0, columns: [] as Array<{ name: string; availability: "all" | "some" }> };
  const sessions = await executor.select({ columns: contactImportSessionsTable.columns }).from(contactImportSessionsTable).where(and(
    eq(contactImportSessionsTable.organizationId, organizationId),
    eq(contactImportSessionsTable.campaignId, campaignId),
    eq(contactImportSessionsTable.audienceGeneration, campaign.audienceGeneration),
    eq(contactImportSessionsTable.status, "Completed"),
  )).orderBy(asc(contactImportSessionsTable.id));
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const column of new Set(session.columns)) {
      if (!counts.has(column)) order.push(column);
      counts.set(column, (counts.get(column) ?? 0) + 1);
    }
  }
  return {
    audienceGeneration: campaign.audienceGeneration,
    columns: order.map((name) => ({ name, availability: (counts.get(name) === sessions.length ? "all" : "some") as "all" | "some" })),
  };
}

// --------------------------------------------------------------- mappings

/**
 * Shape and reference validation for a set of mappings (save time). Every
 * mapping must target a selected template, a requirement that template
 * actually has (component-scoped key), and a usable source. Media assets
 * must belong to this campaign, be ready and match the header kind. Missing
 * requirements are allowed here (an incomplete draft can be saved);
 * readiness and planning refuse them.
 */
export function validateMappings(
  templates: Map<number, Pick<TemplateRow, "id" | "body" | "components">>,
  selectedTemplateIds: Set<number>,
  mappings: MessageMappingInput[],
  assets: Map<number, CampaignMediaAsset>,
): MessageMappingInput[] {
  const errors: string[] = [];
  const mismatches: string[] = [];
  const seen = new Set<string>();
  const normalized: MessageMappingInput[] = [];
  for (const mapping of mappings) {
    const key = `${mapping.component}:${mapping.variable}`;
    const label = `template ${mapping.templateId} ${key}`;
    const template = templates.get(mapping.templateId);
    if (!template || !selectedTemplateIds.has(mapping.templateId)) {
      errors.push(`A mapping targets a template that is not selected (${label})`);
      continue;
    }
    const descriptor = describeTemplate({ id: template.id, body: template.body, components: template.components });
    if (!descriptor.requiredVariables.includes(key)) {
      errors.push(`Unknown variable ${key} for template ${mapping.templateId}`);
      continue;
    }
    if (seen.has(`${mapping.templateId}:${key}`)) {
      errors.push(`Duplicate mapping for ${label}`);
      continue;
    }
    seen.add(`${mapping.templateId}:${key}`);
    if (!["csv", "static", "media_asset"].includes(mapping.source)) {
      errors.push(`Unsupported source for ${label}`);
      continue;
    }
    if (mapping.source === "media_asset") {
      if (key !== "header:media") {
        errors.push(`Only a media header can use an uploaded file (${label})`);
        continue;
      }
      const assetId = mapping.mediaAssetId ?? Number(mapping.sourceValue);
      const asset = Number.isInteger(assetId) ? assets.get(assetId) : undefined;
      if (!asset || asset.status !== "ready") {
        errors.push(`The file chosen for ${label} is not available in this campaign`);
        continue;
      }
      if (asset.kind !== descriptor.headerKind) {
        mismatches.push(`${asset.fileName} is a ${asset.kind}, but template ${mapping.templateId} needs a ${descriptor.headerKind} header`);
        continue;
      }
      normalized.push({ ...mapping, source: "media_asset", mediaAssetId: asset.id, sourceValue: String(asset.id), optional: false, fallbackValue: null });
      continue;
    }
    if (!mapping.sourceValue.trim()) {
      errors.push(`${mapping.source === "csv" ? "Choose a column" : "Enter a value"} for ${label}`);
      continue;
    }
    if (mapping.sourceValue.length > 1024) {
      errors.push(`The value for ${label} is too long`);
      continue;
    }
    if (mapping.optional && !(mapping.fallbackValue ?? "").trim()) {
      errors.push(`An optional mapping needs a fallback value (${label})`);
      continue;
    }
    normalized.push({ ...mapping, mediaAssetId: null, optional: mapping.optional ?? false, fallbackValue: mapping.optional ? mapping.fallbackValue ?? null : null });
  }
  if (mismatches.length) throw new MessageStudioError("media_kind_mismatch", "A file does not match its template's header type", 400, mismatches);
  if (errors.length) throw new MessageStudioError("invalid_mappings", "Some mappings are invalid", 400, [...new Set(errors)]);
  return normalized;
}

// ------------------------------------------------------- revision / touch

async function lockSetupRow(tx: Tx, organizationId: number, campaignId: number) {
  await tx.insert(campaignMessageSetupsTable).values({ organizationId, campaignId }).onConflictDoNothing({ target: campaignMessageSetupsTable.campaignId });
  const [row] = await tx.select().from(campaignMessageSetupsTable).where(and(
    eq(campaignMessageSetupsTable.campaignId, campaignId),
    eq(campaignMessageSetupsTable.organizationId, organizationId),
  )).for("update");
  if (!row) throw new MessageStudioError("not_found", "Campaign not found", 404);
  return row;
}

/**
 * For the legacy setup writers (route create/update/delete, Rocket setup,
 * template-mappings PUT): bump the Message Studio revision in the same
 * transaction, so a Message Studio tab that read the old state cannot save
 * over it, and keep the sender list in step with the routes they wrote.
 */
export async function touchMessageSetup(
  tx: Tx,
  organizationId: number,
  campaignId: number,
  options: { sendersFromRoutes?: boolean; expectedRevision?: number } = {},
): Promise<number> {
  const row = await lockSetupRow(tx, organizationId, campaignId);
  if (options.expectedRevision !== undefined && options.expectedRevision !== row.revision) {
    throw new MessageStudioError("stale_revision", `This change was based on revision ${options.expectedRevision} but the message setup is at revision ${row.revision}`, 409);
  }
  let senderPhoneNumberIds = row.senderPhoneNumberIds;
  if (options.sendersFromRoutes) {
    const routes = await tx.select({ phoneNumberId: campaignRoutesTable.phoneNumberId }).from(campaignRoutesTable).where(and(
      eq(campaignRoutesTable.organizationId, organizationId),
      eq(campaignRoutesTable.campaignId, campaignId),
    )).orderBy(asc(campaignRoutesTable.id));
    senderPhoneNumberIds = [...new Set(routes.map((route) => route.phoneNumberId))];
  }
  await tx.update(campaignMessageSetupsTable).set({ revision: row.revision + 1, senderPhoneNumberIds }).where(eq(campaignMessageSetupsTable.id, row.id));
  return row.revision + 1;
}

// ------------------------------------------------------------------ load

async function loadTemplateRows(organizationId: number, extraIds: number[]): Promise<{ rows: TemplateRow[]; truncated: boolean }> {
  const columns = {
    id: templatesTable.id, organizationId: templatesTable.organizationId, name: templatesTable.name, language: templatesTable.language,
    category: templatesTable.category, status: templatesTable.status, body: templatesTable.body, components: templatesTable.components,
    wabaId: templatesTable.wabaId, providerTemplateId: templatesTable.providerTemplateId, isSample: templatesTable.isSample, metadata: templatesTable.metadata,
  };
  const candidates = await db.select(columns).from(templatesTable).where(and(
    eq(templatesTable.organizationId, organizationId),
    eq(templatesTable.isSample, false),
    isNotNull(templatesTable.providerTemplateId),
  )).orderBy(asc(templatesTable.name), asc(templatesTable.id)).limit(MAX_CANDIDATES + 1);
  const truncated = candidates.length > MAX_CANDIDATES;
  const rows = candidates.slice(0, MAX_CANDIDATES) as TemplateRow[];
  const missing = extraIds.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length) {
    // Selected templates are always shown (with their verdict), even if they
    // are no longer provider-backed candidates: nothing is silently dropped.
    rows.push(...(await db.select(columns).from(templatesTable).where(and(eq(templatesTable.organizationId, organizationId), inArray(templatesTable.id, missing)))) as TemplateRow[]);
  }
  return { rows, truncated };
}

async function loadSenderIds(organizationId: number, extraIds: number[]): Promise<{ ids: number[]; truncated: boolean }> {
  const rows = await db.select({ id: phoneNumbersTable.id }).from(phoneNumbersTable).where(and(
    eq(phoneNumbersTable.organizationId, organizationId),
    eq(phoneNumbersTable.isSample, false),
  )).orderBy(asc(phoneNumbersTable.id)).limit(MAX_CANDIDATES + 1);
  const ids = rows.slice(0, MAX_CANDIDATES).map((row) => row.id);
  return { ids: [...new Set([...ids, ...extraIds])], truncated: rows.length > MAX_CANDIDATES };
}

export async function loadMessageSetup(organizationId: number, campaignId: number) {
  const [campaign] = await db.select({ id: campaignsTable.id, status: campaignsTable.status }).from(campaignsTable)
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.organizationId, organizationId)));
  if (!campaign) throw new MessageStudioError("not_found", "Campaign not found", 404);
  const [setup] = await db.select().from(campaignMessageSetupsTable).where(and(
    eq(campaignMessageSetupsTable.campaignId, campaignId),
    eq(campaignMessageSetupsTable.organizationId, organizationId),
  ));
  const routes = await db.select({ phoneNumberId: campaignRoutesTable.phoneNumberId }).from(campaignRoutesTable).where(and(
    eq(campaignRoutesTable.organizationId, organizationId), eq(campaignRoutesTable.campaignId, campaignId),
  )).orderBy(asc(campaignRoutesTable.id));
  const selectedSenders = setup ? setup.senderPhoneNumberIds : [...new Set(routes.map((route) => route.phoneNumberId))];
  const selections = await db.select({ templateId: campaignTemplateSelectionsTable.templateId }).from(campaignTemplateSelectionsTable).where(and(
    eq(campaignTemplateSelectionsTable.organizationId, organizationId), eq(campaignTemplateSelectionsTable.campaignId, campaignId),
  )).orderBy(asc(campaignTemplateSelectionsTable.id));
  const selectedTemplates = selections.map((row) => row.templateId);

  const [{ rows: templateRows, truncated: templatesTruncated }, { ids: senderIds, truncated: sendersTruncated }] = await Promise.all([
    loadTemplateRows(organizationId, selectedTemplates),
    loadSenderIds(organizationId, selectedSenders),
  ]);
  const state = await loadCompatibilityState(organizationId, { phoneIds: senderIds, templateIds: templateRows.map((row) => row.id) });
  const wabaIds = [...new Set([...state.phones.values(), ...templateRows].flatMap((row) => (row.wabaId === null ? [] : [row.wabaId])))];
  const wabas = wabaIds.length ? await db.select({ id: wabasTable.id, displayName: wabasTable.displayName, externalId: wabasTable.externalId })
    .from(wabasTable).where(and(eq(wabasTable.organizationId, organizationId), inArray(wabasTable.id, wabaIds))) : [];
  const wabaLabel = (id: number | null) => {
    if (id === null) return null;
    const row = wabas.find((waba) => waba.id === id);
    return row ? row.displayName || row.externalId : null;
  };
  const selectedSenderSet = new Set(selectedSenders);
  const selectedTemplateSet = new Set(selectedTemplates);

  const senders = senderIds.flatMap((phoneNumberId) => {
    const phone = state.phones.get(phoneNumberId);
    if (!phone) return [];
    const verdict = describePhone(state, phoneNumberId);
    return [{
      phoneNumberId,
      phone: phone.phone,
      displayName: phone.displayName,
      status: phone.status,
      wabaId: phone.wabaId,
      wabaLabel: wabaLabel(phone.wabaId),
      tpsLimit: phone.tpsLimit,
      transport: verdict.transport,
      usable: verdict.ok,
      code: verdict.code,
      message: verdict.ok ? "Ready to send" : reasonMessage(verdict.code),
      selected: selectedSenderSet.has(phoneNumberId),
      compatibleTemplateIds: selectedTemplates.filter((templateId) => decidePair(state, phoneNumberId, templateId).eligible),
    }];
  });
  const templates = templateRows.map((row) => {
    const verdict = templateVerdict(row);
    const described = describeTemplate({ id: row.id, body: row.body, components: row.components });
    return {
      templateId: row.id,
      name: row.name,
      language: row.language,
      category: row.category,
      status: row.status,
      wabaId: row.wabaId,
      wabaLabel: wabaLabel(row.wabaId),
      body: row.body,
      components: row.components,
      headerKind: described.headerKind as "none" | "text" | "image" | "video" | "document",
      selected: selectedTemplateSet.has(row.id),
      usable: verdict.usable,
      code: verdict.code,
      message: verdict.message,
      compatibleSenderIds: selectedSenders.filter((phoneId) => decidePair(state, phoneId, row.id).eligible),
      requirements: requirementsFor(row),
    };
  });
  const mappings = await db.select().from(campaignTemplateMappingsTable).where(and(
    eq(campaignTemplateMappingsTable.organizationId, organizationId), eq(campaignTemplateMappingsTable.campaignId, campaignId),
  )).orderBy(asc(campaignTemplateMappingsTable.id));
  const executionHistory = await hasExecutionHistory(db, organizationId, campaignId);
  const [activeImport] = await db.select({ id: contactImportSessionsTable.id }).from(contactImportSessionsTable).where(and(
    eq(contactImportSessionsTable.organizationId, organizationId), eq(contactImportSessionsTable.campaignId, campaignId), eq(contactImportSessionsTable.status, "Processing"),
  )).limit(1);
  const editable = ["Draft", "Ready"].includes(campaign.status) && !executionHistory && !activeImport;
  const audience = await activeAudienceColumns(db, organizationId, campaignId);
  return {
    campaignId,
    revision: setup?.revision ?? 0,
    status: campaign.status,
    editable,
    editBlockedReason: editable ? null : executionHistory
      ? "Messages have already been queued or sent for this campaign, so its message setup can no longer change."
      : activeImport ? "An audience upload is still processing."
        : `The campaign is ${campaign.status.toLowerCase()}; its message setup can only change while it is a draft.`,
    reopenRequired: campaign.status === "Ready" && !executionHistory,
    executionHistory,
    importInProgress: Boolean(activeImport),
    senders,
    sendersTruncated,
    templates,
    templatesTruncated,
    selection: { senderPhoneNumberIds: selectedSenders, templateIds: selectedTemplates },
    mappings: mappings.map((row) => ({
      templateId: row.templateId,
      component: row.component as "header" | "body" | "button",
      variable: row.variable,
      source: row.source as "csv" | "static" | "media_asset",
      sourceValue: row.sourceValue,
      mediaAssetId: row.mediaAssetId,
      optional: row.optional,
      fallbackValue: row.fallbackValue,
    })),
    execution: executionFor(state, selectedSenders.filter((id) => state.phones.has(id)), selectedTemplates),
    audienceGeneration: audience.audienceGeneration,
    audienceColumns: audience.columns,
    mediaAssets: await listCampaignMediaAssets(organizationId, campaignId),
  };
}

// ------------------------------------------------------------------ save

export type SaveMessageSetupInput = {
  organizationId: number;
  campaignId: number;
  actorUserId?: number;
  revision: number;
  senderPhoneNumberIds: number[];
  templateIds: number[];
  mappings: MessageMappingInput[];
};

export async function saveMessageSetup(input: SaveMessageSetupInput) {
  const senderIds = [...new Set(input.senderPhoneNumberIds)];
  const templateIds = [...new Set(input.templateIds)];
  if (senderIds.length !== input.senderPhoneNumberIds.length || templateIds.length !== input.templateIds.length) {
    throw new MessageStudioError("invalid_mappings", "Each number and template can only be selected once", 400);
  }
  await withCampaignLifecycleLock(input.campaignId, (scopedDb) => scopedDb.transaction(async (tx) => {
    // The ONE setup fence (V2-05A): Draft, or Ready without execution
    // history (its plan is superseded and it returns to Draft in THIS
    // transaction); refused after any job, while an import processes, and
    // for every other status (Paused is never reset).
    const editable = await assertSetupEditable(tx, input.organizationId, input.campaignId, input.actorUserId);
    if (!editable.ok) {
      if (editable.message === "Campaign not found") throw new MessageStudioError("not_found", "Campaign not found", 404);
      throw new MessageStudioError(editable.code === "setup_locked" ? "setup_locked" : editable.code as "execution_history" | "import_in_progress", editable.message, 409);
    }
    const setup = await lockSetupRow(tx, input.organizationId, input.campaignId);
    if (setup.revision !== input.revision) {
      throw new MessageStudioError("stale_revision", `This save was based on revision ${input.revision} but the message setup is at revision ${setup.revision}. Reload to see the latest changes.`, 409);
    }

    const state = await loadCompatibilityState(input.organizationId, { phoneIds: senderIds, templateIds });
    const missingSenders = senderIds.filter((id) => !state.phones.has(id));
    if (missingSenders.length) throw new MessageStudioError("not_found", "One or more selected numbers are not in this workspace", 404);
    const unusableSenders = senderIds.map((id) => ({ id, verdict: describePhone(state, id) })).filter(({ verdict }) => !verdict.ok);
    if (unusableSenders.length) {
      throw new MessageStudioError("sender_unusable", "Some selected numbers cannot send", 400, unusableSenders.map(({ id, verdict }) => `${state.phones.get(id)!.phone}: ${reasonMessage(verdict.code)}`));
    }
    const templateRows = templateIds.length ? await tx.select({
      id: templatesTable.id, organizationId: templatesTable.organizationId, name: templatesTable.name, body: templatesTable.body, components: templatesTable.components,
      status: templatesTable.status, providerTemplateId: templatesTable.providerTemplateId, isSample: templatesTable.isSample, metadata: templatesTable.metadata,
    }).from(templatesTable).where(and(eq(templatesTable.organizationId, input.organizationId), inArray(templatesTable.id, templateIds))) : [];
    const templatesById = new Map(templateRows.map((row) => [row.id, row]));
    if (templateIds.some((id) => !templatesById.has(id))) throw new MessageStudioError("not_found", "One or more selected templates are not in this workspace", 404);
    const unusableTemplates = templateRows.map((row) => ({ row, verdict: templateVerdict(row) })).filter(({ verdict }) => !verdict.usable);
    if (unusableTemplates.length) {
      throw new MessageStudioError("template_unusable", "Some selected templates cannot be sent", 400, unusableTemplates.map(({ row, verdict }) => `${row.name}: ${verdict.message}`));
    }
    const assetIds = input.mappings.flatMap((m) => (m.source === "media_asset" ? [m.mediaAssetId ?? Number(m.sourceValue)] : []));
    const assets = await loadCampaignMediaAssets(input.organizationId, input.campaignId, assetIds);
    const mappings = validateMappings(templatesById, new Set(templateIds), input.mappings, assets);

    const execution = executionFor(state, senderIds, templateIds);
    // Routes = the allocator-v1 execution model, derived only when v1 can
    // run the selection. Matching (phone, template) routes are kept; others
    // are removed; TPS of a kept/re-paired phone is preserved, a new phone
    // starts at its provider-approved cap (Delivery settings are V2-06).
    const existingRoutes = await tx.select().from(campaignRoutesTable).where(and(
      eq(campaignRoutesTable.organizationId, input.organizationId), eq(campaignRoutesTable.campaignId, input.campaignId),
    ));
    const wanted = execution.executable ? execution.assignments : [];
    const keep = existingRoutes.filter((route) => wanted.some((a) => a.phoneNumberId === route.phoneNumberId && a.templateId === route.templateId));
    const remove = existingRoutes.filter((route) => !keep.includes(route));
    if (remove.length) await tx.delete(campaignRoutesTable).where(inArray(campaignRoutesTable.id, remove.map((route) => route.id)));
    const toInsert = wanted.filter((a) => !keep.some((route) => route.phoneNumberId === a.phoneNumberId && route.templateId === a.templateId));
    if (toInsert.length) {
      await tx.insert(campaignRoutesTable).values(toInsert.map((assignment) => {
        const phone = state.phones.get(assignment.phoneNumberId)!;
        const previous = existingRoutes.find((route) => route.phoneNumberId === assignment.phoneNumberId);
        return {
          organizationId: input.organizationId,
          campaignId: input.campaignId,
          phoneNumberId: assignment.phoneNumberId,
          templateId: assignment.templateId,
          wabaId: phone.wabaId,
          priority: previous?.priority ?? "Normal",
          configuredTps: Math.min(previous?.configuredTps ?? phone.tpsLimit, phone.tpsLimit),
          currentTps: 0,
          queueDepth: 0,
          status: "Active",
        };
      }));
    }
    await tx.delete(campaignTemplateMappingsTable).where(and(
      eq(campaignTemplateMappingsTable.organizationId, input.organizationId), eq(campaignTemplateMappingsTable.campaignId, input.campaignId),
    ));
    await tx.delete(campaignTemplateSelectionsTable).where(and(
      eq(campaignTemplateSelectionsTable.organizationId, input.organizationId), eq(campaignTemplateSelectionsTable.campaignId, input.campaignId),
    ));
    if (templateIds.length) {
      await tx.insert(campaignTemplateSelectionsTable).values(templateIds.map((templateId) => ({
        organizationId: input.organizationId, campaignId: input.campaignId, templateId,
      })));
    }
    if (mappings.length) {
      await tx.insert(campaignTemplateMappingsTable).values(mappings.map((mapping) => ({
        organizationId: input.organizationId,
        campaignId: input.campaignId,
        templateId: mapping.templateId,
        component: mapping.component,
        variable: mapping.variable,
        source: mapping.source,
        sourceValue: mapping.sourceValue,
        mediaAssetId: mapping.mediaAssetId ?? null,
        optional: mapping.optional ?? false,
        fallbackValue: mapping.fallbackValue ?? null,
      })));
    }
    await tx.update(campaignMessageSetupsTable).set({
      revision: setup.revision + 1,
      senderPhoneNumberIds: senderIds,
      updatedBy: input.actorUserId ?? null,
    }).where(eq(campaignMessageSetupsTable.id, setup.id));
    await tx.insert(campaignAuditTable).values({
      organizationId: input.organizationId,
      campaignId: input.campaignId,
      actorUserId: input.actorUserId,
      action: "message_setup_saved",
      fromStatus: "Draft",
      toStatus: "Draft",
      metadata: { revision: setup.revision + 1, senders: senderIds.length, templates: templateIds.length, mappings: mappings.length, execution: execution.code, routes: wanted.length },
    });
  }));
  return loadMessageSetup(input.organizationId, input.campaignId);
}

// --------------------------------------------------------------- presets

export async function applyMappingPreset(input: {
  organizationId: number; campaignId: number; actorUserId?: number; revision: number; presetId: number; templateIds?: number[]; overwrite?: boolean;
}) {
  const [preset] = await db.select().from(mappingPresetsTable).where(and(
    eq(mappingPresetsTable.id, input.presetId), eq(mappingPresetsTable.organizationId, input.organizationId),
  ));
  if (!preset) throw new MessageStudioError("not_found", "Preset not found in this workspace", 404);
  const current = await loadMessageSetup(input.organizationId, input.campaignId);
  const targets = new Set(input.templateIds?.length ? input.templateIds : current.selection.templateIds);
  const mappings: MessageMappingInput[] = current.mappings.map((m) => ({ ...m }));
  for (const template of current.templates) {
    if (!template.selected || !targets.has(template.templateId)) continue;
    for (const requirement of template.requirements) {
      if (requirement.key === "header:media") continue; // presets never carry media
      const entry = preset.entries.find((e) => e.component === requirement.component && e.variable === requirement.variable);
      if (!entry) continue;
      const index = mappings.findIndex((m) => m.templateId === template.templateId && m.component === requirement.component && m.variable === requirement.variable);
      if (index >= 0 && !input.overwrite) continue;
      // A COPY: the campaign keeps these values; the preset is not referenced.
      const copy: MessageMappingInput = {
        templateId: template.templateId, component: requirement.component, variable: requirement.variable,
        source: entry.source, sourceValue: entry.sourceValue, mediaAssetId: null,
        optional: entry.optional ?? false, fallbackValue: entry.optional ? entry.fallbackValue ?? null : null,
      };
      if (index >= 0) mappings[index] = copy;
      else mappings.push(copy);
    }
  }
  return saveMessageSetup({
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    actorUserId: input.actorUserId,
    revision: input.revision,
    senderPhoneNumberIds: current.selection.senderPhoneNumberIds,
    templateIds: current.selection.templateIds,
    mappings,
  });
}

const PRESET_SLOT = { header: /^\d+$/, body: /^\d+$/, button: /^\d+:\d+$/ } as const;

export function validatePresetInput(input: { name: string; entries: Array<{ component: string; variable: string; source: string; sourceValue: string; optional?: boolean; fallbackValue?: string | null }> }) {
  const name = input.name.trim();
  const errors: string[] = [];
  if (!name || name.length > 80) errors.push("Give the preset a name of at most 80 characters");
  const seen = new Set<string>();
  const entries = input.entries.flatMap((entry) => {
    const slot = PRESET_SLOT[entry.component as keyof typeof PRESET_SLOT];
    const key = `${entry.component}:${entry.variable}`;
    if (!slot || !slot.test(entry.variable)) { errors.push(`Unsupported slot ${key}`); return []; }
    if (seen.has(key)) { errors.push(`Duplicate slot ${key}`); return []; }
    seen.add(key);
    if (!["csv", "static"].includes(entry.source)) { errors.push(`Presets hold CSV columns or fixed text only (${key})`); return []; }
    if (!entry.sourceValue.trim()) { errors.push(`Enter a value for ${key}`); return []; }
    if (entry.optional && !(entry.fallbackValue ?? "").trim()) { errors.push(`An optional slot needs a fallback (${key})`); return []; }
    return [{
      component: entry.component as "header" | "body" | "button",
      variable: entry.variable,
      source: entry.source as "csv" | "static",
      sourceValue: entry.sourceValue,
      optional: entry.optional ?? false,
      fallbackValue: entry.optional ? entry.fallbackValue ?? null : null,
    }];
  });
  if (errors.length) throw new MessageStudioError("invalid_preset", "The preset is invalid", 400, errors);
  return { name, entries };
}

// --------------------------------------------------------------- preview

export async function loadPreviewContact(organizationId: number, campaignId: number, contactId?: number) {
  const generation = sql`(select audience_generation from campaigns where id = ${campaignId} and organization_id = ${organizationId})`;
  const conditions = [
    eq(campaignContactsTable.organizationId, organizationId),
    eq(campaignContactsTable.campaignId, campaignId),
    eq(campaignContactsTable.audienceGeneration, generation),
  ];
  if (contactId !== undefined) conditions.push(eq(campaignContactsTable.id, contactId));
  else conditions.push(eq(campaignContactsTable.status, "Valid"));
  const [contact] = await db.select({
    id: campaignContactsTable.id,
    normalizedPhone: campaignContactsTable.normalizedPhone,
    rowNumber: campaignContactsTable.rowNumber,
    data: campaignContactsTable.data,
    status: campaignContactsTable.status,
  }).from(campaignContactsTable).where(and(...conditions)).orderBy(asc(campaignContactsTable.id)).limit(1);
  if (contactId !== undefined && !contact) throw new MessageStudioError("not_found", "Contact not found in this campaign's audience", 404);
  return contact ?? null;
}

/**
 * Message Studio preview: the SAME resolver send preparation uses
 * (resolveTemplateParameters), for one template and one audience contact,
 * with the saved mappings or the editor's unsaved ones. A media header
 * resolves to the asset (the provider id is a send-time binding and is
 * never exposed). Unresolved slots are listed, never filled in.
 */
export async function previewMessage(input: {
  organizationId: number; campaignId: number; templateId: number; contactId?: number; mappings?: MessageMappingInput[];
}) {
  const [campaign] = await db.select({ id: campaignsTable.id }).from(campaignsTable).where(and(
    eq(campaignsTable.id, input.campaignId), eq(campaignsTable.organizationId, input.organizationId),
  ));
  if (!campaign) throw new MessageStudioError("not_found", "Campaign not found", 404);
  const [template] = await db.select({ id: templatesTable.id, body: templatesTable.body, components: templatesTable.components })
    .from(templatesTable).where(and(eq(templatesTable.id, input.templateId), eq(templatesTable.organizationId, input.organizationId)));
  if (!template) throw new MessageStudioError("not_found", "Template not found in this workspace", 404);
  const contact = await loadPreviewContact(input.organizationId, input.campaignId, input.contactId);
  let mappingRows: ResolvableMapping[];
  if (input.mappings) {
    mappingRows = input.mappings.filter((m) => m.templateId === template.id).map((m) => ({
      component: m.component, variable: m.variable, source: m.source,
      sourceValue: m.source === "media_asset" ? String(m.mediaAssetId ?? m.sourceValue) : m.sourceValue,
      optional: m.optional ?? false, fallbackValue: m.fallbackValue ?? null,
    }));
  } else {
    mappingRows = await db.select().from(campaignTemplateMappingsTable).where(and(
      eq(campaignTemplateMappingsTable.organizationId, input.organizationId),
      eq(campaignTemplateMappingsTable.campaignId, input.campaignId),
      eq(campaignTemplateMappingsTable.templateId, template.id),
    ));
  }
  const { resolved, unresolved } = resolveTemplateParameters(template, mappingRows, contact?.data ?? {});
  const issues: ResolutionIssue[] = [...unresolved];
  let headerMedia: { mediaAssetId: number; fileName: string; kind: string } | null = null;
  if (resolved.headerMedia) {
    const assetId = Number(resolved.headerMedia.assetId);
    const assets = await loadCampaignMediaAssets(input.organizationId, input.campaignId, [assetId]);
    const asset = assets.get(assetId);
    const kind = describeTemplate(template).headerKind;
    if (!asset || asset.status !== "ready" || asset.kind !== kind) issues.push({ key: "header:media", reason: "media_unavailable" });
    else headerMedia = { mediaAssetId: asset.id, fileName: asset.fileName, kind: asset.kind };
  }
  return {
    templateId: template.id,
    contact: contact ? { id: contact.id, normalizedPhone: contact.normalizedPhone, rowNumber: contact.rowNumber } : null,
    resolved: { header: resolved.header, body: resolved.body, button: resolved.button },
    headerMedia,
    unresolved: issues,
  };
}

